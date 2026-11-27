import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  DEFAULT_PLAYER_CONFIG,
  GENRES,
  SECTION_LABEL,
  SOURCE_KIND_LABEL,
  type AppSettings,
  type BrowseResult,
  type CatalogEntry,
  type ExternalPlayerInfo,
  type Genre,
  type LibrarySection,
  type MediaItem,
  type PlayerConfig,
  type PlayerEngine,
  type PlayerState,
  type ScanProgress,
  type SeriesSummary,
  type SourceConfig,
  type StorageSource,
  type UpdateInfo,
} from '../shared/types';
import { CLOUD_DRIVES, type CloudDriveId } from '../shared/drives';
import { IPC } from '../shared/ipc-contract';
import { PLAYBACK_SHORTCUTS } from '../shared/playback-shortcuts';
import { call, Icon, PageHeading, type IconName } from './ui';
import { LocalPathPicker } from './LocalPathPicker';
import { ScanScopePage } from './ScanScopePage';
import { InlineVideo } from './InlineVideo';
import { api, isBrowserPreview } from './api';
import { TmdbAttribution, TmdbSettings } from './TmdbSettings';
import { usePointerMotion } from './motion';

const PAGE_SIZE = 36;
type GenreFilter = Genre | 'untagged' | '';
type GenreEditTarget = { workKey: string; title: string; genres: Genre[] };
type SeriesData = { summary: SeriesSummary; items: MediaItem[] };
type ResumePoint = { item: MediaItem; position: number };
type SeriesPageData = SeriesData & { resume?: ResumePoint };
type WatchSelection = { item: MediaItem; series: SeriesData | null };
type ViewPosition = { top: number; trigger: HTMLElement | null; key?: string };

type NavKey = LibrarySection | 'all' | 'continue' | 'sources' | 'settings';
type AddSourceSelection = 'cloud' | 'local' | 'webdav' | CloudDriveId;
type Subpage =
  | { kind: 'add'; selection: AddSourceSelection }
  | { kind: 'browse'; source: StorageSource }
  | { kind: 'scan-scope'; source: StorageSource }
  | { kind: 'genre'; target: GenreEditTarget }
  | { kind: 'movie'; item: MediaItem };

function sourceDriveId(source: StorageSource): CloudDriveId | undefined {
  if (source.config.kind === 'aliyun') return 'aliyun';
  if (source.config.kind === 'webdav') return source.config.driveBrand;
}

function sourceKindLabel(source: StorageSource): string {
  return CLOUD_DRIVES.find((drive) => drive.id === sourceDriveId(source))?.name ?? SOURCE_KIND_LABEL[source.kind];
}

const NAV: Array<{ key: NavKey; label: string; icon: IconName }> = [
  { key: 'all', label: '影库首页', icon: 'home' },
  { key: 'movie', label: '电影', icon: 'movie' },
  { key: 'tv', label: '电视剧', icon: 'tv' },
  { key: 'anime', label: '动漫', icon: 'anime' },
  { key: 'music', label: '音乐', icon: 'music' },
  { key: 'photo', label: '照片', icon: 'photo' },
  { key: 'continue', label: '继续观看', icon: 'continue' },
];

const MANAGEMENT_NAV = [
  { key: 'sources', label: '存储源', icon: 'sources' },
  { key: 'settings', label: '设置', icon: 'settings' },
] as const;

function RailGroup({ items, current, label, sourceCount, onNavigate }: {
  items: ReadonlyArray<{ key: NavKey; label: string; icon: IconName }>;
  current: NavKey;
  label: string;
  sourceCount?: number;
  onNavigate: (nav: NavKey) => void;
}) {
  const active = items.findIndex(({ key }) => current === key);
  return <nav className="nav" aria-label={label}>
    <div className="nav__items" style={{ '--active-index': Math.max(0, active) } as CSSProperties}>
      <span className="nav__indicator" data-active={active !== -1} aria-hidden="true" />
      {items.map(({ key, label: title, icon }) => <button key={key}
        className={'nav__item' + (current === key ? ' is-active' : '')}
        aria-current={current === key ? 'page' : undefined} title={title} onClick={() => onNavigate(key)}>
        <Icon name={icon} />
        <span className="nav__label">{title}</span>
        {key === 'sources' && sourceCount ? <span className="nav__count">{sourceCount}</span> : null}
      </button>)}
    </div>
  </nav>;
}

const SCAN_STAGE: Record<ScanProgress['phase'], string> = {
  connecting: '正在连接', listing: '正在遍历', parsing: '正在识别媒体',
  saving: '正在写入影库', done: '已完成', error: '失败', cancelled: '已取消',
};

const PLAYER_STATUS: Record<PlayerState['status'], string> = {
  idle: '空闲', resolving: '正在获取播放地址', loading: '正在加载', playing: '正在播放',
  paused: '已暂停', ended: '播放结束', error: '播放错误',
};

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function epLabel(item: MediaItem): string {
  if (item.episode === null) return item.year ? String(item.year) : '';
  const s = item.season !== null ? `S${String(item.season).padStart(2, '0')}` : '';
  const e = `E${String(item.episode).padStart(2, '0')}`;
  return `${s}${e}`;
}

function Poster({ item, big }: { item: MediaItem | SeriesSummary | null; big?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<{ owner: string; posterId: string | null; url: string; poster: boolean } | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [invalidPosterItem, setInvalidPosterItem] = useState<string | null>(null);
  const id = item && ('artworkId' in item ? item.artworkId : item.id);
  const poster = item?.poster !== invalid ? item?.poster : null;
  const posterId = item?.posterItemId !== invalidPosterItem ? item?.posterItemId ?? null : null;
  const title = item?.title ?? '';
  const hue = [...title].reduce((sum, char) => (sum * 11 + (char.codePointAt(0) ?? 0)) % 360, 42);
  useEffect(() => {
    if (!id || (poster && !posterId) || !ref.current) return;
    let live = true;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      observer.disconnect();
      const load = (key: string) => call<string | null>(IPC.libraryArtwork, { id: key }).catch(() => null);
      void (async () => {
        const sidecar = posterId ? await load(posterId) : null;
        if (!live) return;
        const url = sidecar ?? (poster ? null : await load(id));
        if (live && url) setLoaded({ owner: id, posterId, url, poster: Boolean(sidecar) });
      })();
    }, { rootMargin: '120px' });
    observer.observe(ref.current);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [id, poster, posterId]);
  const remote = loaded?.owner === id && loaded.posterId === posterId && loaded.url !== invalid ? loaded : null;
  const src = (remote?.poster ? remote.url : poster) || remote?.url;
  const promotional = Boolean(poster || remote?.poster);
  return (
    <div ref={ref} className={`poster ${big ? 'poster--big' : ''} ${promotional ? 'poster--artwork' : ''}`} style={{ '--poster-hue': hue } as React.CSSProperties} aria-hidden="true">
      {src ? <img src={src} alt="" loading="lazy" onError={() => {
        setInvalid(src);
        if (remote?.poster && posterId) setInvalidPosterItem(posterId);
      }} /> : (
        <span className="poster__initial">{title}</span>
      )}
    </div>
  );
}

export default function App() {
  const appMotion = usePointerMotion();
  const [nav, setNav] = useState<NavKey>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'added' | 'title' | 'year' | 'rating'>('added');
  const [genre, setGenre] = useState<GenreFilter>('');
  const [page, setPage] = useState(0);
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [sources, setSources] = useState<StorageSource[]>([]);
  const [continueList, setContinueList] = useState<Array<{ item: MediaItem; record: { position: number; duration: number } }>>([]);
  const [detail, setDetail] = useState<SeriesPageData | null>(null);
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [watch, setWatch] = useState<WatchSelection | null>(null);
  const [scan, setScan] = useState<ScanProgress | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, notify] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [continueVersion, setContinueVersion] = useState(0);
  const [continueLoading, setContinueLoading] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);
  const [detailPending, setDetailPending] = useState<string | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [playError, setPlayError] = useState<{ item: MediaItem; message: string } | null>(null);
  const [subpage, setSubpage] = useState<Subpage | null>(null);
  const inlineVideo = window.nebula?.inlineVideo === true;
  const watching = watch !== null;
  const watchPlayer = watch && player?.itemId === watch.item.id ? player : null;
  const playbackFullscreen = watchPlayer?.fullscreen === true;
  const playRequest = useRef(0);
  const playActive = useRef(false);
  const watchReturn = useRef<ViewPosition | null>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const subpageReturn = useRef<ViewPosition | null>(null);
  const detailReturn = useRef<ViewPosition | null>(null);
  const libraryRequest = useRef(0);
  const detailRequest = useRef(0);

  const refreshLibrary = useCallback(() => setLibraryVersion((value) => value + 1), []);
  const isCatalog = nav === 'all' || nav === 'movie' || nav === 'tv' || nav === 'anime';
  const hasLibrary = nav !== 'sources' && nav !== 'settings' && nav !== 'continue';
  const catalogTools = hasLibrary && !detail && !subpage && !watching;
  const scanning = scan && !['done', 'cancelled', 'error'].includes(scan.phase);
  const canScan = sources.some((source) => source.enabled && source.config.scanScope?.mode !== 'pending');

  const capturePosition = useCallback((): ViewPosition => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return { top: workspace.current?.scrollTop ?? 0, trigger, key: trigger?.dataset.returnKey };
  }, []);

  const restorePosition = useCallback(({ top, trigger, key }: ViewPosition) => {
    workspace.current?.scrollTo({ top, behavior: 'instant' });
    const target = trigger?.isConnected ? trigger : key
      ? workspace.current?.querySelector<HTMLElement>(`[data-return-key="${CSS.escape(key)}"]`)
      : null;
    target?.focus({ preventScroll: true });
  }, []);

  const openSubpage = (next: Subpage) => {
    if (watch) closeWatch();
    ++detailRequest.current;
    setDetailPending(null);
    subpageReturn.current = capturePosition();
    setSubpage(next);
  };

  const openAddSource = (selection: AddSourceSelection) => openSubpage({ kind: 'add', selection });

  useLayoutEffect(() => {
    if (subpage) workspace.current?.scrollTo({ top: 0, behavior: 'instant' });
    if (!subpage && subpageReturn.current) {
      restorePosition(subpageReturn.current);
      subpageReturn.current = null;
    }
  }, [subpage, restorePosition]);

  useLayoutEffect(() => {
    if (detail && !subpage) workspace.current?.scrollTo({ top: 0, behavior: 'instant' });
    if (!detail && detailReturn.current) {
      restorePosition(detailReturn.current);
      detailReturn.current = null;
    }
  }, [detail, restorePosition]);

  useLayoutEffect(() => {
    if (watching || !watchReturn.current) return;
    restorePosition(watchReturn.current);
    watchReturn.current = null;
  }, [watching, restorePosition]);

  const loadSources = useCallback(async () => {
    try {
      setSources(await call<StorageSource[]>(IPC.sourcesList));
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    }
  }, [notify]);

  const handleSourceCreated = async (origin: Subpage, source: StorageSource) => {
    setSubpage((current) => current === origin ? { kind: 'scan-scope', source } : current);
    await loadSources();
    notify('存储源已连接，请选择扫描范围');
  };

  const loadLibrary = useCallback(async () => {
    if (nav === 'sources' || nav === 'settings' || nav === 'continue') return;
    const request = ++libraryRequest.current;
    setLoading(true);
    setLibraryError(null);
    try {
      const query: Record<string, unknown> = {
        sort,
        order: sort === 'title' ? 'asc' : 'desc',
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        group: isCatalog ? 'catalog' : 'item',
      };
      const keyword = search.trim();
      if (nav !== 'all' && (!isCatalog || !keyword)) query['section'] = nav;
      if (keyword) query['search'] = keyword;
      if (isCatalog && genre) query['genre'] = genre;
      const res = await call<BrowseResult>(IPC.libraryBrowse, query);
      if (request !== libraryRequest.current) return;
      setEntries(res.entries ?? res.items.map((item) => ({ kind: 'item', item })));
      setTotal(res.total);
    } catch (err) {
      if (request === libraryRequest.current) setLibraryError(err instanceof Error ? err.message : String(err));
    } finally {
      if (request === libraryRequest.current) setLoading(false);
    }
  }, [nav, sort, isCatalog, search, genre, page]);

  const loadContinue = useCallback(async () => {
    setContinueLoading(true);
    setContinueError(null);
    try {
      const rows = await call<Array<{ item: MediaItem; record: { position: number; duration: number } }>>(
        IPC.libraryContinue,
        { limit: 24 },
      );
      setContinueList(rows);
    } catch (err) {
      setContinueError(err instanceof Error ? err.message : String(err));
    } finally {
      setContinueLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSources();
    void call<AppSettings>(IPC.settingsGet).then(setSettings).catch((err: Error) => notify(err.message));
    void call<{ mpvPath: string | null }>(IPC.mpvLocate).catch(() => undefined);
    const refreshSources = () => { void loadSources(); };
    window.addEventListener('focus', refreshSources);
    return () => window.removeEventListener('focus', refreshSources);
  }, [loadSources, notify]);

  useEffect(() => {
    if (!hasLibrary) return;
    setLoading(true);
    const timer = setTimeout(() => void loadLibrary(), search.trim() ? 160 : 0);
    return () => {
      clearTimeout(timer);
      ++libraryRequest.current;
    };
  }, [hasLibrary, libraryVersion, loadLibrary, search]);

  useEffect(() => {
    if (nav === 'continue') void loadContinue();
  }, [nav, continueVersion, loadContinue]);

  useEffect(() => {
    const off1 = api.on<ScanProgress>(IPC.evScan, (p) => {
      setScan(p);
      if (p.phase === 'done') {
        notify(`扫描完成：发现 ${p.found} 个媒体文件`);
        refreshLibrary();
      } else if (p.phase === 'error') {
        notify(`扫描失败：${p.message ?? '未知错误'}`);
      }
    });
    const off2 = api.on<PlayerState>(IPC.evPlayer, (s) => {
      if (playActive.current) setPlayer(s);
    });
    const off3 = api.on<{ reason: string }>(IPC.evLibrary, ({ reason }) => {
      refreshLibrary();
      if (reason === 'source-added') void loadSources();
    });
    return () => {
      off1();
      off2();
      off3();
    };
  }, [notify, refreshLibrary, loadSources]);

  const stopPlayback = useCallback(() => {
    if (!playActive.current) return;
    playActive.current = false;
    ++playRequest.current;
    setWatch(null);
    setPlayer(null);
    setBusy(null);
    setPlayError(null);
    void call(IPC.playStop).then(() => setContinueVersion((version) => version + 1))
      .catch((error: Error) => notify(error.message));
  }, [notify]);

  const closeWatch = () => {
    stopPlayback();
    detailReturn.current = null;
    subpageReturn.current = null;
    setDetail(null);
    setSubpage(null);
  };

  const play = useCallback(async (item: MediaItem, series: SeriesData | null = null) => {
    const request = ++playRequest.current;
    playActive.current = true;
    setBusy(item.id);
    setPlayError(null);
    const inApp = inlineVideo && settings?.player.engine !== 'external' &&
      (item.section === 'movie' || item.section === 'tv' || item.section === 'anime');
    if (inApp) {
      watchReturn.current ??= detailReturn.current ?? subpageReturn.current ?? capturePosition();
      setWatch({ item, series });
      if (!series && item.seriesKey) {
        void call<SeriesData | null>(IPC.librarySeries, { key: item.seriesKey }).then((data) => {
          if (data && request === playRequest.current) setWatch({ item, series: data });
        }).catch(() => undefined);
      }
    }
    try {
      const result = await call<{ mode: 'mpv' | 'external' | 'cancelled'; message: string }>(IPC.playItem, { itemId: item.id });
      if (request !== playRequest.current) return;
      if (result.mode === 'external') {
        playActive.current = false;
        watchReturn.current = null;
        setWatch(null);
        setPlayer(null);
        notify(result.message);
      } else if (result.mode === 'mpv' && !inApp) {
        notify(result.message);
      }
    } catch (error) {
      if (request === playRequest.current) {
        setPlayError({ item, message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (request === playRequest.current) setBusy(null);
    }
  }, [capturePosition, inlineVideo, notify, settings?.player.engine]);

  const playerCmd = useCallback(async (command: string, value?: number | string) => {
    try {
      await call(IPC.playCommand, { command, value });
    } catch {
      /* 控制条失败不打扰用户 */
    }
  }, []);

  const canUsePlaybackKeys = player?.status === "playing" || player?.status === "paused";
  const playerFullscreen = player?.fullscreen === true;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      const shortcut = PLAYBACK_SHORTCUTS.find(({ code }) => code === event.code);
      if (!shortcut) return;
      const exitFullscreen = shortcut.command === "exit-fullscreen";
      if (exitFullscreen ? !playerFullscreen : !canUsePlaybackKeys) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!exitFullscreen && (target?.isContentEditable || target?.closest("input, textarea, select"))) return;
      if (event.code === "Space" && target?.closest("button, a, [role=button]")) return;
      event.preventDefault();
      if (!event.repeat || shortcut.repeat) void playerCmd(shortcut.command, shortcut.value);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canUsePlaybackKeys, playerFullscreen, playerCmd]);

  const startScan = useCallback(
    async (sourceId?: string) => {
      try {
        notify(sourceId ? '开始扫描…' : '开始扫描全部启用的源…');
        const summaries = await call<Array<{ found: number; added: number; error: string | null }>>(IPC.scanStart, {
          sourceId,
        });
        for (const s of summaries) {
          if (s.error) notify(`扫描有问题：${s.error}`);
        }
        refreshLibrary();
        await loadSources();
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err));
      }
    },
    [notify, refreshLibrary, loadSources],
  );

  const openSeries = async (key: string, resume?: ResumePoint) => {
    const origin = capturePosition();
    const request = ++detailRequest.current;
    setDetailPending(key);
    try {
      const res = await call<SeriesData | null>(IPC.librarySeries, { key });
      if (request !== detailRequest.current) return;
      if (!res) throw new Error('该剧集已从影库移除');
      detailReturn.current = origin;
      setDetail({ ...res, resume });
    } catch (err) {
      if (request === detailRequest.current) notify(err instanceof Error ? err.message : String(err));
    } finally {
      if (request === detailRequest.current) setDetailPending(null);
    }
  };

  const openItem = (item: MediaItem, position?: number) => {
    if (item.seriesKey) {
      void openSeries(item.seriesKey, position === undefined ? undefined : { item, position });
    } else {
      void play(item);
    }
  };

  const updateSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      setSettings(await call<AppSettings>(IPC.settingsUpdate, patch));
    },
    [],
  );

  const navLabel = useMemo(() => {
    if (nav === 'sources') return '存储源';
    if (nav === 'settings') return '设置';
    if (nav === 'continue') return '继续观看';
    if (nav === 'all') return '影库首页';
    return SECTION_LABEL[nav];
  }, [nav]);

  const changeNav = (next: NavKey) => {
    watchReturn.current = null;
    stopPlayback();
    ++detailRequest.current;
    subpageReturn.current = null;
    detailReturn.current = null;
    setSubpage(null);
    setNav(next);
    setDetail(null);
    setDetailPending(null);
    setPage(0);
    setGenre('');
    setSearch('');
    setPlayError(null);
    if (next !== nav) {
      setEntries([]);
      setTotal(0);
      setLibraryError(null);
      setLoading(true);
    }
    workspace.current?.scrollTo({ top: 0, behavior: 'instant' });
  };

  useEffect(() => {
    if (!catalogTools) return;
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, [catalogTools]);

  return (
    <div ref={appMotion} className={playbackFullscreen ? "app app--playback-fullscreen" : "app"}>
      <div className="window-drag" aria-hidden="true" />
      <aside className="sidebar">
        <div className="brand">
          <span className="brand__mark"><Icon name="anime" /></span>
          <div>
            <div className="brand__name">Nebula</div>
            <div className="brand__sub">{isBrowserPreview ? '浏览器版' : '星云影库'}</div>
          </div>
        </div>

        <RailGroup items={NAV} label="媒体库" current={nav} onNavigate={changeNav} />
        <RailGroup items={MANAGEMENT_NAV} label="管理" current={nav} sourceCount={sources.length} onNavigate={changeNav} />
        <div className="sidebar__footer">
          <button className="btn sidebar__add" title="添加存储源" onClick={() => openAddSource('cloud')}>
            <Icon name="plus" /> <span>添加存储源</span>
          </button>
        </div>
      </aside>

      <main className="main">
        {watch ? <WatchPage selection={watch} player={watchPlayer} opening={busy === watch.item.id}
          error={playError?.item.id === watch.item.id ? playError.message : null}
          onBack={closeWatch} onPlay={(item) => void play(item, watch.series)} onCommand={playerCmd} /> : null}

        <header className="topbar" hidden={watching}>
          <div className="topbar__title">
            <Icon name={NAV.find((entry) => entry.key === nav)?.icon ?? (nav === 'settings' ? 'settings' : 'sources')} />
            <span key={nav} className="topbar__name">{navLabel}</span>
          </div>
          <div className="topbar__spacer" />
          {catalogTools ? <>
            <label className="catalog-search">
              <Icon name="search" />
              <input ref={searchInput} type="search" className="search" aria-label="搜索媒体" placeholder="搜索片名、剧名…" value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }} />
              {!search ? <kbd aria-hidden="true">Ctrl K</kbd> : null}
            </label>
            <select aria-label="作品排序" className="select" value={sort} onChange={(e) => { setSort(e.target.value as typeof sort); setPage(0); }}>
              <option value="added">最近添加</option>
              <option value="title">按标题</option>
              <option value="year">按年份</option>
              <option value="rating">按评分</option>
            </select>
          </> : null}
          {!subpage && !isBrowserPreview ? <button className="btn btn--ghost scan-action" onClick={() => void startScan()} disabled={!canScan || Boolean(scanning)}>
            <Icon name="scan" /> 扫描全部
          </button> : null}
        </header>

        {!watching && scan && scanning ? (
          <div className="scanbar" role="status">
            <span className="spinner" aria-hidden="true" />
            <span>
              {scan.sourceName} · {SCAN_STAGE[scan.phase]} · 已遍历 {scan.scanned} · 发现 {scan.found}
            </span>
            <span className="scanbar__path">{scan.currentPath ?? ''}</span>
            <button className="btn btn--ghost btn--sm" onClick={() => void call(IPC.scanCancel, { sourceId: scan.sourceId })}>
              取消
            </button>
          </div>
        ) : null}

        {playError && !subpage && !watching ? <div className="play-error app-message" role="alert">
          <span>{playError.message}</span>
          <button className="btn btn--ghost btn--sm" onClick={() => void play(playError.item)}>重试播放</button>
          <button className="btn btn--icon" aria-label="关闭播放提示" onClick={() => setPlayError(null)}><Icon name="close" /></button>
        </div> : null}

        <div className="app-status" role="status">
          {notice && !watching ? <div className="app-message">
            <span>{notice}</span>
            <button className="btn btn--icon" aria-label="关闭提示" onClick={() => notify(null)}><Icon name="close" /></button>
          </div> : null}
        </div>

        <div className="workspace-scroll" ref={workspace} hidden={watching}>
          <div className="workspace-page" hidden={Boolean(subpage)}>
        {nav === 'settings' ? (
          <SettingsPanel settings={settings} onSave={updateSettings} sources={sources} onOpenAddSource={openAddSource} />
        ) : nav === 'sources' ? (
          <SourcesPanel
            sources={sources}
            onAdd={() => openAddSource('cloud')}
            onRemove={async (id) => {
              await call(IPC.sourcesRemove, { id });
              await loadSources();
              refreshLibrary();
              notify('已移除存储源');
            }}
            onTest={(id) => call<{ ok: boolean; message: string }>(IPC.sourcesTest, { id })}
            onScan={(id) => void startScan(id)}
            scanning={scan && scanning ? scan.sourceId : null}
            onBrowse={(source) => openSubpage({ kind: 'browse', source })}
            onScope={(source) => openSubpage({ kind: 'scan-scope', source })}
          />
        ) : detail ? (
          <SeriesDetail
            data={detail}
            onBack={() => { stopPlayback(); setDetail(null); setPlayError(null); }}
            onPlay={(item) => void play(item, detail)}
            onEdit={() => openSubpage({ kind: 'genre', target: { workKey: `series:${detail.summary.key}`, title: detail.summary.title, genres: detail.summary.genres } })}
            busy={busy}
          />
        ) : nav === 'continue' ? (
          <section className="continue-view" aria-busy={continueLoading}>
            <PageHeading title="继续观看" icon="continue" description={continueList.length ? `${continueList.length} 项观看记录` : '从上次的播放位置继续'} />
            {continueError ? <div className="play-error" role="alert"><span>{continueError}</span><button className="btn btn--ghost" onClick={() => void loadContinue()}>重试</button></div>
            : continueLoading && !continueList.length ? <LoadingCards />
            : continueList.length === 0 ? (
              <Empty icon="continue" title="还没有观看记录" text="开始播放影片后，观看进度会保存在这里。"
                action={<button className="btn btn--primary" onClick={() => changeNav('all')}>浏览影库 <Icon name="forward" /></button>} />
            ) : (
              <div className="catalog-grid">{continueList.map(({ item, record }) => (
                <button key={item.id} className="card" data-motion="tilt" data-return-key={"continue:" + item.id}
                  disabled={busy === item.id || Boolean(item.seriesKey && detailPending === item.seriesKey)}
                  onClick={() => openItem(item, record.position)}>
                  <div className="catalog-card__image">
                    <Poster item={item} />
                    <span className="card__shine" aria-hidden="true" />
                    <span className="catalog-card__action" aria-hidden="true"><Icon name="play" /></span>
                  </div>
                  <div className="card__body">
                    <div className="card__title">{item.seriesTitle ?? item.title}</div>
                    <div className="card__meta">
                      {epLabel(item) ? `${epLabel(item)} · ` : ''}看到 {fmtTime(record.position)}
                      {record.duration > 0 ? ` / ${fmtTime(record.duration)}` : ''}
                    </div>
                    <div className="progress">
                      <div
                        className="progress__bar"
                        style={{ width: `${record.duration > 0 ? Math.min(100, (record.position / record.duration) * 100) : 0}%` }}
                      />
                    </div>
                  </div>
                </button>
              ))}</div>
            )}
          </section>
        ) : (
          <LibraryView key={nav} home={nav === 'all'} video={isCatalog} label={navLabel} entries={entries} sourceCount={sources.length}
            total={total} loading={loading} error={libraryError} search={search} genre={genre} page={page} busy={busy}
            detailPending={detailPending} onAddSource={() => openAddSource('cloud')} onSources={() => changeNav('sources')}
            onRetry={refreshLibrary} onGenre={(value) => { setGenre(value); setPage(0); }} onClear={() => { setSearch(''); setGenre(''); setPage(0); }}
            onPage={setPage} onOpenSeries={(key) => void openSeries(key)} onOpenItem={openItem}
            onOpenMovie={(item) => openSubpage({ kind: 'movie', item })}
            onEdit={(target) => openSubpage({ kind: 'genre', target })} />
        )}
          </div>
          {subpage?.kind === 'movie' ? <MovieDetail item={subpage.item} busy={busy === subpage.item.id}
            onBack={() => { stopPlayback(); setSubpage(null); }} onPlay={() => void play(subpage.item)}
            error={playError?.item.id === subpage.item.id ? playError.message : null} /> : null}
          {subpage?.kind === 'genre' ? <GenrePage target={subpage.target} onClose={() => setSubpage(null)} onSave={async (genres) => {
            await call(IPC.libraryGenresUpdate, { workKey: subpage.target.workKey, genres });
            if (detail) {
              setDetail((current) => current ? { ...current, summary: { ...current.summary, genres: genres ?? current.summary.genres } } : current);
              if (!genres) {
                const result = await call<SeriesData | null>(IPC.librarySeries, { key: detail.summary.key }).catch(() => null);
                if (result) setDetail((current) => current?.summary.key === result.summary.key ? { ...current, ...result } : current);
              }
            }
            setSubpage((current) => current === subpage ? null : current);
            refreshLibrary();
            notify('题材已更新');
          }} /> : null}
          {subpage?.kind === 'browse' ? <BrowsePage key={subpage.source.id} source={subpage.source} onClose={() => setSubpage(null)}
            onScope={() => setSubpage({ kind: 'scan-scope', source: subpage.source })} /> : null}
          {subpage?.kind === 'scan-scope' ? <ScanScopePage key={subpage.source.id} source={subpage.source}
            allowScan={!isBrowserPreview} onBack={() => setSubpage(null)} onSave={async (scope, scanNow) => {
              const updated = await call<StorageSource>(IPC.sourcesScanScope, { sourceId: subpage.source.id, scope });
              setSubpage((current) => current === subpage ? null : current);
              setNav('sources');
              await loadSources();
              if (scanNow) void startScan(updated.id);
              else notify('扫描范围已保存');
            }} /> : null}
          {subpage?.kind === 'add' ? <AddSourcePage key={subpage.selection} sources={sources} initialSelection={subpage.selection}
            onClose={() => setSubpage(null)} onCreated={(source) => handleSourceCreated(subpage, source)} /> : null}
        </div>

        {!watching && player && player.status !== 'idle' ?
          <PlayerControls player={player} playerCmd={playerCmd} onStop={stopPlayback} /> : null}
      </main>
    </div>
  );
}

function PlayerControls({ player, playerCmd, onStop, media }: {
  player: PlayerState;
  playerCmd: (command: string, value?: number | string) => void;
  onStop: () => void;
  media?: { title: string; episode: string | null };
}) {
  return (
    <section className="player" aria-label="播放控制">
      <div className="player__info">
        <span className="player__mark"><Icon name="movie" /></span>
        <div><div className="player__title" title={player.title ?? undefined}>{player.title ?? '未知'}</div>
          <div className="player__sub">{player.status === 'error' ? (player.error ?? '播放错误') : PLAYER_STATUS[player.status]}</div></div>
        {media ? <div className="player__now-playing">
          <span className="player__now-title" title={media.title}>{media.title}</span>
          {media.episode ? <span className="player__now-episode">{media.episode}</span> : null}
        </div> : null}
      </div>
      <div className="player__timeline">
        <span className="player__time">{fmtTime(player.position)}</span>
        <input
          className="slider"
          aria-label="播放进度"
          type="range"
          min={0}
          max={Math.max(1, player.duration)}
          value={Math.min(player.position, player.duration || 0)}
          onChange={(e) => void playerCmd('seek', Number(e.target.value))}
        />
        <span className="player__time">{fmtTime(player.duration)}</span>
      </div>
      <div className="player__controls">
        <button className="btn btn--icon" onClick={() => void playerCmd('seek-relative', -10)} title="后退 10 秒（←）" aria-keyshortcuts="ArrowLeft">
          <Icon name="rewind" />
        </button>
        <button className="btn btn--icon btn--play" onClick={() => void playerCmd('toggle-pause')} title="播放/暂停（空格 / K）" aria-keyshortcuts="Space K">
          <Icon name={player.status === 'paused' ? 'play' : 'pause'} />
        </button>
        <button className="btn btn--icon" onClick={() => void playerCmd('seek-relative', 10)} title="前进 10 秒（→）" aria-keyshortcuts="ArrowRight">
          <Icon name="skip" />
        </button>
        <button className="btn btn--icon" onClick={() => void playerCmd('mute')} title="静音（M）" aria-keyshortcuts="M">
          <Icon name={player.muted ? 'mute' : 'volume'} />
        </button>
        <input
          className="slider slider--vol"
          aria-label="音量"
          title="音量（↑ / ↓ 或画面上滚动鼠标）"
          aria-keyshortcuts="ArrowUp ArrowDown"
          type="range"
          min={0}
          max={150}
          value={player.volume}
          onChange={(e) => void playerCmd('volume', Number(e.target.value))}
        />
        {player.tracks.some((t) => t.type === 'audio') ? (
          <select
            className="select select--sm"
            value={player.activeAudioId ?? ''}
            onChange={(e) => void playerCmd('audio', Number(e.target.value))}
            title="音轨"
          >
            {player.tracks
              .filter((t) => t.type === 'audio')
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
          </select>
        ) : null}
        {player.tracks.some((t) => t.type === 'sub') ? (
          <select
            className="select select--sm"
            value={player.activeSubId ?? ''}
            onChange={(e) => void playerCmd('subtitle', Number(e.target.value))}
            title="字幕"
          >
            {player.tracks
              .filter((t) => t.type === 'sub')
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
          </select>
        ) : null}
        <select
          className="select select--sm"
          value={player.speed}
          onChange={(e) => void playerCmd('speed', Number(e.target.value))}
          title="倍速"
        >
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => (
            <option key={v} value={v}>
              {v}x
            </option>
          ))}
        </select>
        <button className="btn btn--icon" onClick={() => void playerCmd('fullscreen')}
          aria-label={player.fullscreen ? '退出全屏' : '全屏'}
          title={player.fullscreen ? '退出全屏（F / Esc）' : '全屏（F）'}
          aria-keyshortcuts={player.fullscreen ? 'F Escape' : 'F'}>
          <Icon name="fullscreen" />
        </button>
        <button className="btn btn--icon" onClick={onStop} aria-label="停止播放" title="停止播放">
          <Icon name="close" />
        </button>
      </div>
    </section>
  );
}

function WatchPage({ selection, player, opening, error, onBack, onPlay, onCommand }: {
  selection: WatchSelection;
  player: PlayerState | null;
  opening: boolean;
  error: string | null;
  onBack: () => void;
  onPlay: (item: MediaItem) => void;
  onCommand: (command: string, value?: number | string) => void;
}) {
  const { item, series } = selection;
  const title = series?.summary.title ?? item.seriesTitle ?? item.title;
  const episode = item.episode !== null ? episodeDisplayLabel(item) : null;
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  const playbackError = error ?? (!opening && player?.status === "error" ? player.error ?? "播放失败" : null);
  return (
    <section className="watch-page" aria-labelledby="watch-title">
      <header className="watch-header">
        <button className="btn btn--ghost watch-header__back" onClick={onBack}><Icon name="back" /> 返回影库</button>
        <div className="watch-header__identity">
          <h1 id="watch-title" ref={heading} tabIndex={-1}>{title}</h1>
          {episode || item.year ? <span>{episode ?? item.year}</span> : null}
        </div>
      </header>
      <div className={series ? "watch-layout watch-layout--series" : "watch-layout"}>
        <div className="watch-screen">
          <InlineVideo player={player} opening={opening} error={playbackError} onRetry={() => onPlay(item)} />
          {player && !playbackError ? <PlayerControls player={player} playerCmd={onCommand} onStop={onBack}
            media={player.fullscreen ? { title, episode } : undefined} /> : null}
        </div>
        {series ? <WatchEpisodes key={series.summary.key} series={series} activeItem={item} busy={opening ? item.id : null} onPlay={onPlay} /> : null}
      </div>
    </section>
  );
}

function Empty({ title, text, icon, action }: { title: string; text: string; icon: IconName; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty__mark"><Icon name={icon} /></span>
      <h2>{title}</h2>
      <p>{text}</p>
      {action}
    </div>
  );
}

function LoadingCards({ portrait = false }: { portrait?: boolean }) {
  return <div className="catalog-grid skeleton-grid" data-portrait={portrait} role="status" aria-label="正在加载">
    {Array.from({ length: 6 }, (_, index) => <div key={index} className="skeleton-card" aria-hidden="true"><div /><span /><span /></div>)}
  </div>;
}

function LibraryView({ home, video, label, entries, total, loading, error, search, genre, page, busy, sourceCount, detailPending,
  onRetry, onGenre, onClear, onPage, onOpenSeries, onOpenMovie, onOpenItem, onEdit, onAddSource, onSources }: {
  home: boolean;
  video: boolean;
  label: string;
  entries: CatalogEntry[];
  total: number;
  loading: boolean;
  error: string | null;
  search: string;
  genre: GenreFilter;
  page: number;
  busy: string | null;
  sourceCount: number;
  detailPending: string | null;
  onRetry: () => void;
  onGenre: (value: GenreFilter) => void;
  onClear: () => void;
  onPage: (page: number) => void;
  onOpenSeries: (key: string) => void;
  onOpenMovie: (item: MediaItem) => void;
  onOpenItem: (item: MediaItem) => void;
  onEdit: (target: GenreEditTarget) => void;
  onAddSource: () => void;
  onSources: () => void;
}) {
  const results = useRef<HTMLDivElement>(null);
  const popular: Genre[] = ['剧情', '古装', '悬疑', '喜剧', '爱情', '科幻', '动画'];
  const filtered = Boolean(search.trim() || genre);
  const showHero = home && !filtered && page === 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const goToPage = (value: number) => {
    onPage(value);
    results.current?.scrollIntoView({ block: 'start' });
  };

  return (
    <section className="library-view">
      {showHero ? <div className="library-hero" data-motion="parallax">
        <div className="library-hero__art" aria-hidden="true" />
        <div className="library-hero__content">
          <h1>我的影库</h1>
          <dl className="library-hero__stats">
            <div><dt>部作品</dt><dd>{loading && !total ? '—' : total.toLocaleString('zh-CN')}</dd></div>
            <div><dt>个存储源</dt><dd>{sourceCount.toLocaleString('zh-CN')}</dd></div>
          </dl>
          <div className="library-hero__actions">
            {total > 0
              ? <button className="btn btn--primary" onClick={() => {
                results.current?.focus({ preventScroll: true });
                results.current?.scrollIntoView({ block: 'start' });
              }}>浏览作品 <Icon name="down" /></button>
              : <button className="btn btn--primary" onClick={sourceCount ? onSources : onAddSource}>
                <Icon name={sourceCount ? 'sources' : 'plus'} /> {sourceCount ? '管理存储源' : '添加存储源'}
              </button>}
          </div>
        </div>
      </div> : null}

      {!home || !showHero ? <PageHeading
        title={search.trim() ? '搜索结果' : label}
        icon={search.trim() ? 'search' : NAV.find((entry) => entry.label === label)?.icon}
        description={search.trim() ? `关键词「${search.trim()}」` : undefined}
      /> : null}

      <div className="catalog-results" ref={results} tabIndex={-1} aria-busy={loading}>
        <div className="catalog-heading">
          {showHero ? <h2>全部作品</h2> : null}
          <span>{loading ? '正在加载…' : `${total.toLocaleString('zh-CN')} ${video ? '部作品' : '项'}`}</span>
          {filtered ? <button className="btn btn--ghost btn--sm" onClick={onClear}>清除筛选</button> : null}
        </div>
        {video && (total > 0 || filtered) ? <div className="catalog-filters" role="group" aria-label="题材筛选">
          <div className="catalog-filters__quick">
            <button className="filter-chip" aria-pressed={genre === ''} onClick={() => onGenre('')}>全部题材</button>
            {popular.map((value) => <button key={value} className="filter-chip" aria-pressed={genre === value} onClick={() => onGenre(value)}>{value}</button>)}
          </div>
          <select className="select genre-select" aria-label="更多题材" value={genre && !popular.includes(genre as Genre) ? genre : ''}
            onChange={(e) => onGenre(e.target.value as GenreFilter)}>
            <option value="">更多题材</option>
            {GENRES.filter((value) => !popular.includes(value)).map((value) => <option key={value} value={value}>{value}</option>)}
            <option value="untagged">未标注</option>
          </select>
        </div> : null}

        {error ? <div className="play-error" role="alert"><span>{error}</span><button className="btn btn--ghost btn--sm" onClick={onRetry}>重新加载</button></div>
          : loading && !entries.length ? <LoadingCards portrait={video} />
          : !entries.length ? <Empty icon={filtered ? 'search' : 'movie'}
            title={filtered ? '没有匹配的作品' : '这里还没有媒体'}
            text={filtered ? '试试其他关键词或题材。' : '扫描存储源后，符合条件的媒体会自动出现在这里。'}
            action={showHero || filtered ? undefined :
              <button className="btn btn--ghost" onClick={sourceCount ? onSources : onAddSource}>
                {sourceCount ? '管理存储源' : '添加存储源'} <Icon name="forward" />
              </button>} />
          : <div className="catalog-grid" data-portrait={video} data-loading={loading}>
            {entries.map((entry, index) => {
              const item = entry.kind === 'series' ? entry.series : entry.item;
              const isSeries = entry.kind === 'series';
              const name = isSeries ? entry.series.title : entry.item.seriesTitle ?? entry.item.title;
              const seriesKey = isSeries ? entry.series.key : entry.item.seriesKey;
              const pending = (entry.kind === "item" && busy === entry.item.id) || Boolean(seriesKey && detailPending === seriesKey);
              const meta = isSeries ? [entry.series.year, `${entry.series.seasonCount} 季 · ${entry.series.episodeCount} 集`, ...entry.series.genres.slice(0, 1)]
                : [entry.item.year, entry.item.resolution, ...(entry.item.genres?.slice(0, 1) ?? [])];
              return <div className="catalog-card" key={isSeries ? entry.series.key : entry.item.id}
                style={{ '--card-order': Math.min(9, index) } as CSSProperties}>
                <button className="card" title={name} disabled={pending} data-motion="tilt"
                data-return-key={entry.kind === "series" ? "series:" + entry.series.key : "item:" + entry.item.id}
                onClick={() => isSeries ? onOpenSeries(entry.series.key) : onOpenItem(entry.item)}>
                <div className="catalog-card__image">
                  <Poster item={item} />
                  <span className="card__shine" aria-hidden="true" />
                  <span className="catalog-card__section">{SECTION_LABEL[item.section]}</span>
                  {item.rating !== null ? <span className="catalog-card__rating" title="TMDB 评分">★ {item.rating.toFixed(1)}</span> : null}
                  <span className="catalog-card__action" aria-hidden="true"><Icon name={seriesKey ? 'forward' : 'play'} /></span>
                </div>
                <div className="card__body">
                  <div className="card__title">{name}</div>
                  <div className="card__meta">{pending ? '正在打开…' : meta.filter(Boolean).join(' · ')}</div>
                </div>
                </button>
                {entry.kind === 'item' && entry.item.section === 'movie' && (entry.item.overview || entry.item.rating !== null) ?
                  <button className="catalog-card__edit catalog-card__details" data-return-key={"details:" + entry.item.id} title="影片详情" aria-label={'查看《' + name + '》的详情'}
                    onClick={() => onOpenMovie(entry.item)}><Icon name="info" /></button> : null}
                {video && entry.workKey ? <button className="catalog-card__edit" title="修改题材" aria-label={`修改《${name}》的题材`}
                  onClick={() => onEdit({ workKey: entry.workKey!, title: name, genres: item.genres ?? [] })}><Icon name="edit" /></button> : null}
              </div>;
            })}
          </div>}
        {pages > 1 ? <div className="catalog-pages" aria-label="翻页">
          <button className="btn btn--ghost" disabled={page === 0 || loading} onClick={() => goToPage(page - 1)}>上一页</button>
          <span>{page + 1} / {pages}</span>
          <button className="btn btn--ghost" disabled={page >= pages - 1 || loading} onClick={() => goToPage(page + 1)}>下一页</button>
        </div> : null}
      </div>
    </section>
  );
}

function GenrePage({ target, onSave, onClose }: {
  target: GenreEditTarget;
  onSave: (genres: Genre[] | null) => Promise<void>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(target.genres);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (genres: Genre[] | null) => {
    setSaving(true);
    setError(null);
    try { await onSave(genres); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  };
  return <section className="subpage">
    <PageHeading title="修改题材" description={target.title} icon="edit" onBack={onClose} backDisabled={saving} />
    <div className="surface form-surface">
      <div className="section-heading"><h2>选择题材</h2><span>已选 {selected.length} 项</span></div>
      <div className="catalog-filters__quick" role="group" aria-label="选择题材">
        {GENRES.map((genre) => <button key={genre} className="filter-chip" disabled={saving} aria-pressed={selected.includes(genre)}
          onClick={() => setSelected((choices) => choices.includes(genre) ? choices.filter((choice) => choice !== genre) : [...choices, genre])}>{genre}</button>)}
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="page-actions">
        <button className="btn btn--ghost" disabled={saving} onClick={() => void save(null)}>恢复自动分类</button>
        <button className="btn btn--primary" disabled={saving} onClick={() => void save(selected)}>{saving ? '保存中…' : '保存题材'}</button>
      </div>
    </div>
  </section>;
}

function episodeName(item: MediaItem): string {
  if (item.episode === null) return item.name;
  return item.episodeEnd !== null && item.episodeEnd > item.episode
    ? `第 ${item.episode}–${item.episodeEnd} 集`
    : `第 ${item.episode} 集`;
}

function episodeDisplayLabel(item: MediaItem): string {
  const season = item.season === 0 ? "特别篇" : "第 " + (item.season ?? 1) + " 季";
  return season + " · " + episodeName(item);
}

function MovieDetail({ item, busy, onBack, onPlay, error }: {
  item: MediaItem;
  busy: boolean;
  onBack: () => void;
  onPlay: () => void;
  error: string | null;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus({ preventScroll: true }); }, []);

  return (
    <section className="detail">
      <button className="btn back-link" onClick={onBack}><Icon name="back" /> 返回影库</button>
      <div className="detail__head">
        {item.backdrop ? <img className="detail__backdrop" src={item.backdrop} alt="" /> : null}
        <Poster item={item} big />
        <div className="detail__identity">
          <p className="detail__kind">电影</p>
          <h1 className="detail__title" ref={title} tabIndex={-1}>{item.title}</h1>
          <div className="detail__meta">
            {[item.year, item.rating === null ? null : 'TMDB ' + item.rating.toFixed(1) + '/10', item.resolution].filter(Boolean).join(' · ')}
          </div>
          {item.overview ? <p className="detail__overview">{item.overview}</p> : null}
          {item.genres?.length ? <div className="detail__genres">{item.genres.map((genre) => <span key={genre}>{genre}</span>)}</div> : null}
          <button className="btn btn--primary" disabled={busy} onClick={onPlay}>
            <Icon name="play" /> {busy ? '正在打开…' : '播放'}
          </button>
          {error ? <p className="error" role="alert">{error}</p> : null}
        </div>
      </div>
    </section>
  );
}

function SeriesDetail({
  data,
  onBack,
  onPlay,
  onEdit,
  busy,
}: {
  data: SeriesPageData;
  onBack: () => void;
  onPlay: (item: MediaItem) => void;
  onEdit: () => void;
  busy: string | null;
}) {
  const seasons = useMemo(() => groupSeasons(data.items), [data.items]);
  const { resume } = data;
  const resumeSeason = resume ? resume.item.season ?? 1 : undefined;
  const [selectedSeason, setSelectedSeason] = useState(resumeSeason ?? seasons.find(([season]) => season > 0)?.[0] ?? seasons[0]?.[0] ?? 1);
  const episodes = seasons.find(([season]) => season === selectedSeason)?.[1] ?? [];
  const nextItem = resume?.item ?? episodes[0];
  const backdrop = data.items.find((item) => item.backdrop)?.backdrop;
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus({ preventScroll: true }); }, []);

  return (
    <section className="detail">
      <button className="btn back-link" onClick={onBack}>
        <Icon name="back" /> 返回影库
      </button>
      <div className="detail__head">
        {backdrop ? <img className="detail__backdrop" src={backdrop} alt="" /> : null}
        <Poster item={data.summary} big />
        <div className="detail__identity">
          <p className="detail__kind">{SECTION_LABEL[data.summary.section]}</p>
          <h1 className="detail__title" ref={title} tabIndex={-1}>{data.summary.title}</h1>
          <div className="detail__meta">
            {data.summary.year ? `${data.summary.year} · ` : ''}
            {data.summary.episodeCount} 集 · {data.summary.seasonCount} 季
            {data.summary.rating !== null ? ' · TMDB ' + data.summary.rating.toFixed(1) + '/10' : ''}
          </div>
          {data.summary.overview ? <p className="detail__overview">{data.summary.overview}</p> : null}
          {data.summary.genres.length ? <div className="detail__genres">{data.summary.genres.map((genre) => <span key={genre}>{genre}</span>)}</div> : null}
          <div className="detail__actions">
            {nextItem ? <button className="btn btn--primary" disabled={busy === nextItem.id} onClick={() => onPlay(nextItem)}>
              <Icon name="play" /> {busy === nextItem.id ? "正在打开…" : resume
                ? `续播 ${episodeDisplayLabel(nextItem)}`
                : `播放${episodeName(nextItem)}`}
            </button> : null}
            <button className="btn btn--ghost" onClick={onEdit}><Icon name="edit" /> 修改题材</button>
            {resume ? <span className="detail__progress">看到 {fmtTime(resume.position)}</span> : null}
          </div>
        </div>
      </div>
      <EpisodePicker seasons={seasons} selectedSeason={selectedSeason} onSelectSeason={setSelectedSeason} busy={busy} onPlay={onPlay} />
    </section>
  );
}

function groupSeasons(items: MediaItem[]): Array<[number, MediaItem[]]> {
  const groups = new Map<number, MediaItem[]>();
  for (const item of items) {
    const season = item.season ?? 1;
    const episodes = groups.get(season) ?? [];
    episodes.push(item);
    groups.set(season, episodes);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b);
}

function WatchEpisodes({ series, activeItem, busy, onPlay }: {
  series: SeriesData;
  activeItem: MediaItem;
  busy: string | null;
  onPlay: (item: MediaItem) => void;
}) {
  const seasons = useMemo(() => groupSeasons(series.items), [series.items]);
  const [selectedSeason, setSelectedSeason] = useState(activeItem.season ?? 1);
  const episodes = useRef<HTMLDivElement>(null);
  const selectSeason = (season: number) => {
    setSelectedSeason(season);
    episodes.current?.scrollTo({ top: 0, behavior: 'instant' });
  };
  return <aside className="watch-episodes" aria-label="剧集列表">
    <EpisodePicker seasons={seasons} selectedSeason={selectedSeason} onSelectSeason={selectSeason}
      activeId={activeItem.id} busy={busy} onPlay={onPlay} episodesRef={episodes} />
  </aside>;
}

function EpisodePicker({ seasons, selectedSeason, onSelectSeason, activeId, busy, onPlay, episodesRef }: {
  seasons: Array<[number, MediaItem[]]>;
  selectedSeason: number;
  onSelectSeason: (season: number) => void;
  activeId?: string;
  busy: string | null;
  onPlay: (item: MediaItem) => void;
  episodesRef?: React.Ref<HTMLDivElement>;
}) {
  const episodes = seasons.find(([season]) => season === selectedSeason)?.[1] ?? [];
  return <section className="season">
    <h2 className="season__title">选集</h2>
    <div className="season-tabs" role="group" aria-label="选择季度">
      {seasons.map(([season, list]) => <button key={season} className="filter-chip" aria-pressed={season === selectedSeason}
        onClick={() => onSelectSeason(season)}>{season === 0 ? "特别篇" : "第 " + season + " 季"} <span>{list.length} 集</span></button>)}
    </div>
    <div className="episodes" ref={episodesRef} key={selectedSeason}>
      {episodes.map((item) => <button key={item.id} className="episode" onClick={() => onPlay(item)}
        disabled={busy === item.id} aria-current={activeId === item.id ? "true" : undefined}>
        <span className="episode__play"><Icon name="play" /></span>
        <span className="episode__name">{episodeName(item)}</span>
        <span className="episode__tag">{busy === item.id ? "正在打开…" : [item.resolution, item.quality].filter(Boolean).join(" · ")}</span>
      </button>)}
    </div>
  </section>;
}

function SourcesPanel({ sources, onAdd, onRemove, onTest, onScan, onBrowse, onScope, scanning }: {
  sources: StorageSource[];
  onAdd: () => void;
  onRemove: (id: string) => Promise<void>;
  onTest: (id: string) => Promise<{ ok: boolean; message: string }>;
  onScan: (id: string) => void;
  onBrowse: (source: StorageSource) => void;
  onScope: (source: StorageSource) => void;
  scanning: string | null;
}) {
  return (
    <section className="panel">
      <PageHeading title="存储源" icon="sources" description="管理影库连接，浏览目录和扫描媒体。"
        action={<button className="btn btn--primary" onClick={onAdd}><Icon name="plus" /> 添加存储源</button>} />
      {sources.length === 0 ? (
        <Empty icon="sources" title="还没有存储源" text="添加网盘、本地目录或 WebDAV 后，即可扫描媒体。" />
      ) : (
        <div className="source-list">
          {sources.map((source) => <SourceCard key={source.id} source={source} scanning={scanning === source.id}
            onRemove={() => onRemove(source.id)} onTest={() => onTest(source.id)}
            onScan={() => onScan(source.id)} onBrowse={() => onBrowse(source)} onScope={() => onScope(source)} />)}
        </div>
      )}
    </section>
  );
}

function SourceCard({ source, scanning, onRemove, onTest, onScan, onBrowse, onScope }: {
  source: StorageSource;
  scanning: boolean;
  onRemove: () => Promise<void>;
  onTest: () => Promise<{ ok: boolean; message: string }>;
  onScan: () => void;
  onBrowse: () => void;
  onScope: () => void;
}) {
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [pending, setPending] = useState<'test' | 'remove' | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const confirmation = useRef<HTMLDivElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const { config } = source;
  const scope = config.scanScope;
  const pendingScope = scope?.mode === 'pending';
  const path = config.kind === 'local' ? config.roots.join(' · ')
    : config.kind === 'webdav' ? `${config.url} · ${config.root || '/'}` : '';

  const run = async (action: 'test' | 'remove') => {
    setPending(action);
    setFeedback(null);
    try {
      if (action === 'remove') await onRemove();
      else setFeedback(await onTest());
    } catch (err) {
      setFeedback({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setPending(null);
    }
  };

  useEffect(() => { if (confirmRemoval) confirmation.current?.focus(); }, [confirmRemoval]);

  return <article className="surface source-card">
    <div className="source-card__row">
      <span className="source-card__icon"><Icon name={config.kind === 'local' ? 'disk' : config.kind === 'webdav' && !config.driveBrand ? 'link' : 'cloud'} /></span>
      <div className="source-card__main">
        <div className="source-card__name"><h2>{source.name}</h2><span className="badge">{sourceKindLabel(source)}</span></div>
        {path ? <div className="source-card__meta" title={path}>{path}</div> : null}
        <div className="source-card__meta">
          <span className={`dot ${source.enabled ? 'dot--on' : ''}`} />
          {source.enabled ? '已启用' : '已停用'} · {source.lastScanAt
            ? `${new Date(source.lastScanAt).toLocaleString('zh-CN')} 扫描 · ${source.lastScanCount} 项` : '尚未扫描'}
        </div>
        <div className="source-card__meta">{pendingScope ? '尚未设置扫描范围' : scope?.mode === 'custom'
          ? '扫描 ' + scope.folders.length + ' 个文件夹' : '扫描全部文件夹'}</div>
        {source.lastError ? <p className="source-card__error">{source.lastError}</p> : null}
      </div>
      <div className="source-card__actions">
        <button className="btn btn--ghost btn--sm" disabled={Boolean(pending)} onClick={() => void run('test')}>
          {pending === 'test' ? '测试中…' : '测试连接'}
        </button>
        <button className="btn btn--ghost btn--sm" onClick={onBrowse}><Icon name="folder" /> 浏览</button>
        <button className={'btn btn--sm ' + (pendingScope ? 'btn--primary' : 'btn--ghost')} disabled={scanning || pending === 'remove'} onClick={onScope}>
          <Icon name="edit" /> 扫描范围
        </button>
        {!isBrowserPreview ? <>
          <button className="btn btn--primary btn--sm" disabled={!source.enabled || pendingScope || scanning || pending === 'remove'} onClick={onScan}>
            <Icon name="scan" /> {scanning ? '扫描中…' : '扫描'}
          </button>
          <button ref={removeButton} className="btn btn--quiet-danger btn--sm" aria-expanded={confirmRemoval}
            disabled={Boolean(pending) || scanning} onClick={() => setConfirmRemoval((show) => !show)}>移除</button>
        </> : null}
      </div>
    </div>
    {confirmRemoval ? <div ref={confirmation} tabIndex={-1} className="source-card__confirm">
      <div><strong>移除「{source.name}」？</strong><p>此连接及其影库条目会移除，源中的文件会保留。</p></div>
      <div className="source-card__actions">
        <button className="btn btn--ghost btn--sm" disabled={pending === 'remove'} onClick={() => {
          setConfirmRemoval(false);
          removeButton.current?.focus();
        }}>取消</button>
        <button className="btn btn--danger btn--sm" disabled={Boolean(pending) || scanning} onClick={() => void run('remove')}>
          {pending === 'remove' ? '移除中…' : '确认移除'}
        </button>
      </div>
    </div> : null}
    {feedback ? <p className={feedback.ok ? 'success' : 'error'} role={feedback.ok ? 'status' : 'alert'}>{feedback.message}</p> : null}
  </article>;
}

type PlayerDetectResult = {
  mpv: { path: string | null; source: string; message: string };
  external: ExternalPlayerInfo[];
  player: PlayerConfig;
};

const ENGINE_OPTIONS: Array<{ value: PlayerEngine; label: string; hint: string }> = [
  { value: 'auto', label: '自动', hint: '内置 mpv 优先，不可用时回落外部播放器' },
  { value: 'builtin', label: '仅内置 mpv', hint: '不可用时明确报错，不静默替换' },
  { value: 'external', label: '仅外部播放器', hint: '始终交给外部程序' },
];

function CloudDrivePicker({
  sources,
  onChoose,
}: {
  sources: StorageSource[];
  onChoose: (id: CloudDriveId) => void;
}) {
  const added = sources.map(sourceDriveId).filter((id) => id !== undefined);
  const drives = [...CLOUD_DRIVES].sort((a, b) => Number(b.id === 'aliyun') - Number(a.id === 'aliyun'));
  return (
    <section className="cloud-picker">
      <div className="cloud-picker__head">
        <h2>网盘连接</h2>
        <span className={`drive-count ${added.length ? 'is-on' : 'is-empty'}`}>
          {added.length ? `已添加 ${added.length} 个网盘` : '未添加网盘'}
        </span>
      </div>
      <p className="panel__lede">选择网盘品牌。阿里云盘可直接扫码，其余网盘通过 WebDAV 接入。</p>
      <div className="drive-grid">
        {drives.map((drive) => {
          const isAdded = added.includes(drive.id);
          return (
            <button
              key={drive.id}
              className={`drive-card${isAdded ? ' is-connected' : ''}`}
              onClick={() => onChoose(drive.id)}
            >
              <span className="drive-card__mark" style={{ backgroundColor: drive.color }} aria-hidden="true">
                {drive.mark}
              </span>
              <span className="drive-card__name">{drive.name}</span>
              <span className="drive-card__auth">
                {isAdded ? '已添加' : drive.id === 'aliyun' ? '扫码登录' : 'WebDAV 接入'}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function SettingsPanel({
  settings,
  onSave,
  sources,
  onOpenAddSource,
}: {
  settings: AppSettings | null;
  onSave: (patch: Partial<AppSettings>) => Promise<void>;
  sources: StorageSource[];
  onOpenAddSource: (id: CloudDriveId) => void;
}) {
  const [mpvPath, setMpvPath] = useState(settings?.mpvPath ?? '');
  const [hwdec, setHwdec] = useState(settings?.hardwareDecode ?? true);
  const [player, setPlayer] = useState<PlayerConfig>(settings?.player ?? DEFAULT_PLAYER_CONFIG);
  const [detected, setDetected] = useState<PlayerDetectResult | null>(null);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [version, setVersion] = useState<string>('');
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pickingExecutable, setPickingExecutable] = useState(false);
  const executableTrigger = useRef<HTMLButtonElement>(null);
  const closeExecutablePicker = () => {
    setPickingExecutable(false);
    executableTrigger.current?.focus();
  };

  useEffect(() => {
    void call<{ version: string }>(IPC.appInfo)
      .then((r) => setVersion(r.version))
      .catch(() => undefined);
  }, []);

  const checkUpdate = async () => {
    setCheckingUpdate(true);
    try {
      setUpdate(await call<UpdateInfo>(IPC.updateCheck));
    } catch (err) {
      setUpdate({
        currentVersion: version,
        latestVersion: null,
        hasUpdate: false,
        releaseUrl: null,
        releaseName: null,
        publishedAt: null,
        notes: null,
        assets: [],
        error: err instanceof Error ? err.message : String(err),
        checkedAt: Date.now(),
      });
    } finally {
      setCheckingUpdate(false);
    }
  };

  useEffect(() => {
    setMpvPath(settings?.mpvPath ?? '');
    setHwdec(settings?.hardwareDecode ?? true);
    setPlayer(settings?.player ?? DEFAULT_PLAYER_CONFIG);
  }, [settings]);

  const detect = useCallback(async () => {
    try {
      const r = await call<PlayerDetectResult>(IPC.playersDetect);
      setDetected(r);
    } catch (err) {
      setTestMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void detect();
  }, [detect]);

  const save = async (alsoTest: boolean) => {
    setSaving(true);
    setTestMsg(null);
    try {
      await onSave({ mpvPath: mpvPath.trim() || null, hardwareDecode: hwdec, player });
      if (alsoTest) {
        const r = await call<{ ok: boolean; message: string }>(IPC.playersTest);
        setTestMsg({ ok: r.ok, text: r.message });
      } else setTestMsg({ ok: true, text: '设置已保存' });
    } catch (err) {
      setTestMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  const currentExternal = detected?.external.find((d) => d.id === player.externalId);

  return (
    <section className="panel">
      <PageHeading title="设置" icon="settings" description="配置播放方式、网盘连接、影视元数据和应用更新。" />
      <nav className="settings-nav" aria-label="设置分类">
        <a href="#playback-settings"><Icon name="play" /> 播放设置</a>
        <a href="#cloud-settings"><Icon name="cloud" /> 网盘连接</a>
        {!isBrowserPreview ? <a href="#tmdb-settings"><Icon name="movie" /> 影视元数据</a> : null}
        <a href="#update-settings"><Icon name="scan" /> 关于与更新</a>
      </nav>

      <section className="surface settings-section" id="playback-settings">
      <header className="section-heading"><h2>播放设置</h2></header>
      <fieldset className="settings-fields" disabled={!settings || saving}>
      <fieldset className="field engine-field">
        <legend>播放方式</legend>
        <div className="radio-row">
          {ENGINE_OPTIONS.map((opt) => (
            <label key={opt.value} className={`radio ${player.engine === opt.value ? 'is-active' : ''}`}>
              <input
                type="radio"
                name="player-engine"
                checked={player.engine === opt.value}
                onChange={() => setPlayer((p) => ({ ...p, engine: opt.value }))}
              />
              <span className="radio__label">{opt.label}</span>
              <small className="radio__hint">{opt.hint}</small>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="settings-grid">
      <div className="field">
        <label htmlFor="settings-mpv">内置 mpv</label>
        <div className="status-line">
          {detected?.mpv.path ? (
            <span className="status status--ok">✓ {detected.mpv.message}</span>
          ) : (
            <span className="status status--warn">! {detected?.mpv.message ?? '检测中…'}</span>
          )}
        </div>
        <input
          id="settings-mpv"
          className="input"
          placeholder="留空则自动探测（内置 → PATH → 常见安装位置）"
          value={mpvPath}
          onChange={(e) => setMpvPath(e.target.value)}
        />
        <small>打包版已内置 mpv，通常不需要填写。填写后优先于内置版本。</small>
      </div>

      <div className="field">
        <label htmlFor="settings-mpv-args">mpv 附加参数</label>
        <input
          id="settings-mpv-args"
          className="input"
          placeholder="例：--profile=low-latency --hwdec=auto"
          value={player.builtinArgs}
          onChange={(e) => setPlayer((p) => ({ ...p, builtinArgs: e.target.value }))}
        />
        <small>空格分隔，支持引号。修改后下次播放生效。</small>
      </div>

      <div className="field">
        <label htmlFor="settings-external">外部播放器</label>
        <select
          id="settings-external"
          className="select select--full"
          value={player.externalId}
          onChange={(e) => {
            const id = e.target.value;
            const preset = detected?.external.find((d) => d.id === id);
            setPlayer((p) => ({ ...p, externalId: id, externalArgs: preset?.defaultArgs ?? p.externalArgs }));
          }}
        >
          {(detected?.external ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.system ? '' : d.path ? ' ✓ 已安装' : ' （未检测到）'}
            </option>
          ))}
        </select>
        <div className="status-line">
          {currentExternal && !currentExternal.system ? (
            currentExternal.path ? (
              <span className="status status--ok">✓ {currentExternal.path}</span>
            ) : (
              <span className="status status--warn">! 未检测到，可改用「自定义…」手动指定</span>
            )
          ) : (
            <span className="status">交给系统默认程序打开</span>
          )}
        </div>
        {player.externalId === 'custom' ? (
          <div className="row">
            <input
              className="input"
              aria-label="播放器可执行文件路径"
              placeholder="播放器可执行文件完整路径"
              value={player.externalPath}
              onChange={(e) => setPlayer((p) => ({ ...p, externalPath: e.target.value }))}
            />
            <button ref={executableTrigger} className="btn btn--ghost" aria-expanded={pickingExecutable}
              onClick={() => setPickingExecutable((open) => !open)}>
              <Icon name="folder" /> 浏览
            </button>
          </div>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor="settings-external-args">参数模板</label>
        <input
          id="settings-external-args"
          className="input"
          placeholder='"{url}"'
          value={player.externalArgs}
          onChange={(e) => setPlayer((p) => ({ ...p, externalArgs: e.target.value }))}
        />
        <small>
          占位符 <code>{'{url}'}</code> 视频地址、<code>{'{title}'}</code> 标题、<code>{'{start}'}</code> 续播起点秒数。带空格的路径用引号包住。
        </small>
      </div>

      </div>
      {player.externalId === 'custom' && pickingExecutable ? <LocalPathPicker mode="executable" onClose={closeExecutablePicker}
        onSelect={(path) => {
          setPlayer((current) => ({ ...current, externalPath: path }));
          closeExecutablePicker();
        }} /> : null}
      <label className="toggle">
        <input type="checkbox" checked={hwdec} onChange={(e) => setHwdec(e.target.checked)} />
        <span>硬件解码（内置 mpv）</span>
      </label>

      <div className="page-actions page-actions--start">
        <button className="btn btn--primary" onClick={() => void save(false)}>
          <Icon name="check" /> {saving ? '正在保存…' : '保存设置'}
        </button>
        <button className="btn btn--ghost" onClick={() => void save(true)}>
          保存并测试
        </button>
        <button className="btn btn--ghost" onClick={() => void detect()}>
          重新检测
        </button>
      </div>
      </fieldset>

      {testMsg ? (
        <div className={testMsg.ok ? 'success' : 'error'} role={testMsg.ok ? 'status' : 'alert'}>
          {testMsg.text}
        </div>
      ) : null}

      <details className="settings-help">
        <summary>播放器说明</summary>
        <p>安装包自带 mpv。应用可检测 PotPlayer、VLC、MPC-HC、MPC-BE 和系统 mpv。音频与图片由外部程序打开。</p>
      </details>
      </section>

      <section className="surface settings-section" id="cloud-settings">
        <CloudDrivePicker sources={sources} onChoose={onOpenAddSource} />
      </section>

      {!isBrowserPreview ? <TmdbSettings /> : null}

      <section className="surface settings-section" id="update-settings">
      <div className="section-heading">
        <h2>关于与更新</h2>
        <span className="drive-count">v{version || '—'}</span>
      </div>
      <div className="page-actions page-actions--start">
        <button className="btn btn--primary" onClick={() => void checkUpdate()} disabled={checkingUpdate}>
          {checkingUpdate ? '检查中…' : '检查更新'}
        </button>
        {update?.releaseUrl ? (
          <button
            className="btn btn--ghost"
            onClick={(e) => {
              e.preventDefault();
              void call(IPC.updateOpenRelease, { url: update.releaseUrl });
            }}
          >
            打开发布页
          </button>
        ) : null}
      </div>
      {!isBrowserPreview ? <TmdbAttribution /> : null}
      {update ? (
        <div className="update-result" role="status">
          {update.error ? (
            <div className="error">{update.error}</div>
          ) : update.hasUpdate ? (
            <div className="status status--warn">
              有新版本 <strong>v{update.latestVersion}</strong>（当前 v{update.currentVersion}）
              {update.assets.length > 0
                ? ` · 可下载：${update.assets.map((a) => a.name).join(' / ')}`
                : ''}
            </div>
          ) : (
            <div className="status status--ok">已是最新版本（v{update.latestVersion ?? update.currentVersion}）</div>
          )}
          {update.publishedAt ? (
            <div className="status" style={{ marginTop: 4 }}>
              远端版本发布于 {new Date(update.publishedAt).toLocaleString()}
            </div>
          ) : null}
        </div>
      ) : null}
      </section>

    </section>
  );
}

const SOURCE_TABS = ['cloud', 'local', 'webdav'] as const;

interface BrowseEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

function fmtSize(n: number): string {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 浏览网盘目录。扫码后先看清盘里有什么，再决定扫描——而不是只能盲扫。
 */
function BrowsePage({ source, onClose, onScope }: { source: StorageSource; onClose: () => void; onScope: () => void }) {
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [stack, setStack] = useState<Array<{ id: string; name: string }>>([{ id: '', name: '根目录' }]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const parentId = stack.at(-1)?.id ?? '';

  useEffect(() => {
    let live = true;
    setLoading(true);
    setErr(null);
    void call<{ parent: string; entries: BrowseEntry[] }>(IPC.browseList, { sourceId: source.id, parentId })
      .then((result) => { if (live) setEntries(result.entries); })
      .catch((error: Error) => { if (live) setErr(error.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [source.id, parentId, retry]);

  const dirs = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir);

  return (
    <section className="subpage">
      <PageHeading title="浏览目录" description={source.name} icon="folder" onBack={onClose}
        action={<button className="btn btn--ghost" onClick={onScope}><Icon name="edit" /> 扫描范围</button>} />
      <div className="surface browse-surface" aria-busy={loading}>

        <nav className="browse-crumb" aria-label="目录路径">
          {stack.map((seg, i) => (
            <span key={`${seg.id}-${i}`}>
              {i > 0 ? <Icon name="chevron" /> : null}
              <button
                aria-current={i === stack.length - 1 ? 'location' : undefined}
                onClick={() => setStack((s) => s.slice(0, i + 1))}
              >
                {seg.name}
              </button>
            </span>
          ))}
        </nav>

        {loading ? <p className="status">正在读取目录…</p> : null}
        {err ? <div className="play-error" role="alert"><span>{err}</span>
          <button className="btn btn--ghost btn--sm" onClick={() => setRetry((n) => n + 1)}>重试</button></div> : null}

        {!loading && !err && entries.length === 0 ? (
          <Empty icon="folder" title="目录为空" text="当前目录没有文件或文件夹。" />
        ) : null}

        {!loading && !err && entries.length ? <>
        <div className="browse-columns"><span>名称</span><span>大小</span></div>
        <ul className="browse-list">
          {dirs.map((d) => (
            <li key={d.path}>
              <button
                className="browse-row browse-row--dir"
                onClick={() => setStack((s) => [...s, { id: d.path, name: d.name }])}
              >
                <Icon name="folder" />
                <span className="browse-row__name" title={d.name}>{d.name}</span>
                <Icon name="chevron" />
              </button>
            </li>
          ))}
          {files.map((f) => (
            <li key={f.path}>
              <div className="browse-row">
                <Icon name="file" />
                <span className="browse-row__name" title={f.name}>{f.name}</span>
                <span className="browse-row__meta">{fmtSize(f.size)}</span>
              </div>
            </li>
          ))}
        </ul>

        <p className="browse-total">{dirs.length} 个文件夹 · {files.length} 个文件</p>
        </> : null}
      </div>
    </section>
  );
}

function AddSourcePage({
  sources,
  initialSelection,
  onClose,
  onCreated,
}: {
  sources: StorageSource[];
  initialSelection: AddSourceSelection;
  onClose: () => void;
  onCreated: (source: StorageSource) => Promise<void>;
}) {
  const [selection, setSelection] = useState(initialSelection);
  const [submitting, setSubmitting] = useState(false);
  const activeTab = selection === 'local' || selection === 'webdav' ? selection : 'cloud';
  const heading = CLOUD_DRIVES.find((drive) => drive.id === selection)?.name;

  const close = () => {
    if (!submitting) onClose();
  };

  return (
    <section className="subpage">
      <PageHeading title="添加存储源" icon="sources" description="选择媒体文件所在的位置。" onBack={close} backDisabled={submitting} />
        <div className="source-nav" role="group" aria-label="存储源类型">
          {SOURCE_TABS.map((tab) => (
            <button
              key={tab}
              aria-pressed={activeTab === tab}
              disabled={submitting}
              onClick={() => setSelection(tab)}
            >
              <Icon name={tab === 'cloud' ? 'cloud' : tab === 'local' ? 'disk' : 'link'} />
              {tab === 'cloud' ? '网盘' : SOURCE_KIND_LABEL[tab]}
            </button>
          ))}
        </div>
        {selection === 'cloud' ? (
          <div className="surface form-surface form-surface--wide">
            <CloudDrivePicker sources={sources} onChoose={setSelection} />
          </div>
        ) : (
          <div className="surface form-surface">
            <div className="section-heading">
              <h2>{heading ?? SOURCE_KIND_LABEL[selection === 'local' ? 'local' : 'webdav']}</h2>
              {heading ? <button className="btn btn--ghost btn--sm" disabled={submitting} onClick={() => setSelection('cloud')}>切换网盘</button> : null}
            </div>
            <AddSourceForm
              key={selection}
              selection={selection}
              submitting={submitting}
              setSubmitting={setSubmitting}
              onClose={close}
              onCreated={onCreated}
            />
          </div>
        )}
    </section>
  );
}

function AddSourceForm({
  selection,
  submitting,
  setSubmitting,
  onClose,
  onCreated,
}: {
  selection: Exclude<AddSourceSelection, 'cloud'>;
  submitting: boolean;
  setSubmitting: (submitting: boolean) => void;
  onClose: () => void;
  onCreated: (source: StorageSource) => Promise<void>;
}) {
  const selectedDrive = CLOUD_DRIVES.find((drive) => drive.id === selection);
  const bridge = selectedDrive && 'guideUrl' in selectedDrive ? selectedDrive : undefined;
  const kind = selection === 'local' || selection === 'aliyun' ? selection : 'webdav';
  const [name, setName] = useState('');
  const [roots, setRoots] = useState<string[]>([]);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const directoryTrigger = useRef<HTMLButtonElement>(null);
  const [url, setUrl] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [root, setRoot] = useState(bridge ? '' : '/');
  const [err, setErr] = useState<string | null>(null);

  const [qr, setQr] = useState<{ sessionId: string; dataUrl: string } | null>(null);
  const [qrStatus, setQrStatus] = useState('');
  const [qrError, setQrError] = useState<string | null>(null);
  const [generatingQr, setGeneratingQr] = useState(false);
  const nameRef = useRef(name);
  const createdRef = useRef(onCreated);
  useEffect(() => {
    nameRef.current = name;
    createdRef.current = onCreated;
  }, [name, onCreated]);

  const startQr = useCallback(async () => {
    setGeneratingQr(true);
    setQrError(null);
    setQr(null);
    setQrStatus('正在生成二维码…');
    try {
      const r = await call<{ sessionId: string; qrDataUrl: string }>(IPC.aliyunQrStart);
      setQr({ sessionId: r.sessionId, dataUrl: r.qrDataUrl });
    } catch (e) {
      setQrError(e instanceof Error ? e.message : String(e));
    } finally {
      setGeneratingQr(false);
      setQrStatus('');
    }
  }, []);

  const autoQrDone = useRef(false);
  useEffect(() => {
    if (kind !== 'aliyun' || autoQrDone.current) return;
    autoQrDone.current = true;
    void startQr();
  }, [kind, startQr]);

  // Schedule the next poll only after the previous request has settled.
  useEffect(() => {
    if (!qr) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const r = await call<{ status: string; source?: StorageSource }>(IPC.aliyunQrPoll, {
          sessionId: qr.sessionId,
          name: nameRef.current.trim() || undefined,
        });
        if (stopped) return;
        setQrError(null);
        if (r.status === 'NEW') setQrStatus('');
        else if (r.status === 'SCANNED') setQrStatus('已扫码，请在手机上确认登录');
        else if (r.status === 'EXPIRED') {
          setQr(null);
          setQrStatus('');
          setQrError('二维码已过期');
          return;
        } else if (r.status === 'CONFIRMED') {
          setQrStatus('授权成功，正在挂载…');
          if (!r.source) throw new Error('连接已确认，但没有返回存储源');
          await createdRef.current(r.source);
          return;
        }
      } catch (e) {
        if (!stopped) {
          setQrStatus('');
          setQrError(e instanceof Error ? e.message : String(e));
        }
      }
      if (!stopped) timer = setTimeout(() => void tick(), 2000);
    };

    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [qr]);

  const submit = async () => {
    setSubmitting(true);
    setErr(null);
    try {
      let config: SourceConfig;
      if (kind === 'local') {
        if (roots.length === 0) throw new Error('请先选择至少一个本地目录');
        config = { kind: 'local', roots };
      } else if (kind === 'webdav') {
        if (!url.trim()) throw new Error('请填写 WebDAV 地址');
        const address = URL.parse(url.trim());
        if (!address || !['http:', 'https:'].includes(address.protocol)) throw new Error('请输入以 http:// 或 https:// 开头的 WebDAV 地址');
        const mount = root.trim();
        if (bridge && !mount.startsWith('/')) throw new Error('请填写以 / 开头的网盘挂载路径');
        config = {
          kind: 'webdav',
          url: url.trim(),
          username: user,
          password: pass,
          root: mount || '/',
          ...(bridge ? { driveBrand: bridge.id } : {}),
        };
      } else {
        throw new Error('阿里云盘走扫码授权，不需要手动提交');
      }
      const created = await call<StorageSource>(IPC.sourcesCreate, {
        kind,
        name: name.trim() || bridge?.name || (kind === 'local' ? '本地目录' : 'WebDAV'),
        config,
      });
      await onCreated(created);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="source-form" noValidate onSubmit={(event) => {
      event.preventDefault();
      if (kind !== 'aliyun' && !submitting) void submit();
    }}>
      {bridge ? (
        <div className="source-bridge-note">
          <p>在 OpenList 挂载{bridge.name}，为账号开启 WebDAV 读取权限后，填写下方连接信息。</p>
          <a href={bridge.guideUrl} target="_blank" rel="noreferrer">查看配置指南 ↗</a>
        </div>
      ) : null}
      <fieldset className="source-fields" disabled={submitting}>
      <div className="field">
        <label htmlFor="source-name">名称</label>
        <input
          id="source-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={bridge?.name ?? '例：我的电影盘'}
        />
      </div>

      {kind === 'local' ? (
        <>
          <div className="field">
            <span className="field__label">媒体目录</span>
            <button ref={directoryTrigger} type="button" className="btn btn--ghost field__action" aria-expanded={pickingDirectory}
              onClick={() => setPickingDirectory((open) => !open)}>
              <Icon name="folder" /> 选择目录
            </button>
            {pickingDirectory ? <LocalPathPicker mode="directory" selected={roots}
              onSelect={(path) => {
                setRoots((current) => current.includes(path) ? current : [...current, path]);
                setErr(null);
              }}
              onClose={() => {
                setPickingDirectory(false);
                directoryTrigger.current?.focus();
              }} /> : null}
            <ul className="pick-list">
              {roots.map((r) => (
                <li key={r}>
                  <span title={r}>{r}</span>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setRoots(roots.filter((x) => x !== r))}>
                    移除
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : kind === 'webdav' ? (
        <>
          <div className="field">
            <label htmlFor="source-url">WebDAV 地址</label>
            <input
              id="source-url"
              className="input"
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={bridge ? 'http://127.0.0.1:5244/dav' : 'https://example.com/dav'}
            />
          </div>
          <div className="field">
            <label htmlFor="source-root">{bridge ? '挂载路径' : '起始路径'}</label>
            <input
              id="source-root"
              className="input"
              value={root}
              onChange={(e) => setRoot(e.target.value)}
              placeholder={bridge ? `/${bridge.name}` : '/'}
            />
            {bridge ? <small>填写网盘在 WebDAV 中的路径。如果网盘就是根目录，填写 /。</small> : null}
          </div>
          <div className="field">
            <label htmlFor="source-user">{bridge ? 'WebDAV 用户名' : '用户名'}</label>
            <input id="source-user" className="input" value={user} onChange={(e) => setUser(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="source-password">{bridge ? 'WebDAV 密码' : '密码'}</label>
            <input id="source-password" className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
            <small>密码用系统级加密（Windows DPAPI）保存，不落明文。</small>
          </div>
        </>
      ) : (
        <div className="field">
          {qr ? (
            <div className="qr-wrap">
              <img className="qr" src={qr.dataUrl} alt="阿里云盘登录二维码" />
              <p>打开阿里云盘手机客户端扫码，并在手机上确认授权。</p>
            </div>
          ) : null}
          {qrStatus ? <div className="qr-status" role="status">{qrStatus}</div> : null}
          {qrError ? (
            <>
              <div className="error" role="alert">{qrError}</div>
              <button type="button" className="btn btn--ghost" disabled={generatingQr} onClick={() => void startQr()}>
                重新生成二维码
              </button>
            </>
          ) : null}
        </div>
      )}
      </fieldset>

      {err ? <div className="error" role="alert">{err}</div> : null}

      {kind !== 'aliyun' ? <div className="page-actions">
        <button type="button" className="btn btn--ghost" onClick={onClose} disabled={submitting}>
          取消
        </button>
        <button type="submit" className="btn btn--primary" disabled={submitting}>
          <Icon name="plus" /> {submitting ? (bridge ? '正在验证…' : '添加中…') : (bridge ? '连接并添加' : '添加存储源')}
        </button>
      </div> : null}
    </form>
  );
}
