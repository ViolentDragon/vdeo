import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_PLAYER_CONFIG,
  SECTION_LABEL,
  SOURCE_KIND_LABEL,
  type AppSettings,
  type BrowseResult,
  type ExternalPlayerInfo,
  type LibrarySection,
  type MediaItem,
  type PlayerConfig,
  type PlayerEngine,
  type PlayerState,
  type ScanProgress,
  type SeriesSummary,
  type SourceConfig,
  type SourceKind,
  type StorageSource,
  type UpdateInfo,
} from '../shared/types';
import { ALIST_BRIDGE_STEPS, CLOUD_DRIVES } from '../shared/drives';
import { IPC, type Rpc } from '../shared/ipc-contract';

const api = window.nebula;

async function call<T>(channel: string, payload?: unknown): Promise<T> {
  const res = await api.invoke<Rpc<T>>(channel, payload);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

type NavKey = LibrarySection | 'all' | 'continue' | 'sources' | 'settings';

const NAV: Array<{ key: NavKey; label: string; icon: string }> = [
  { key: 'all', label: '全部媒体', icon: '▦' },
  { key: 'movie', label: '电影', icon: '🎬' },
  { key: 'tv', label: '电视剧', icon: '📺' },
  { key: 'anime', label: '动漫', icon: '🌸' },
  { key: 'music', label: '音乐', icon: '🎵' },
  { key: 'photo', label: '照片', icon: '🖼' },
  { key: 'continue', label: '继续观看', icon: '⏱' },
];

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
  const title = item ? ('title' in item ? item.title : '') : '';
  const poster = item?.poster ?? null;
  const initial = (title || '?').trim().slice(0, 2);
  return (
    <div className={`poster ${big ? 'poster--big' : ''}`}>
      {poster ? <img src={poster} alt={title} loading="lazy" /> : <span className="poster__initial">{initial}</span>}
      <div className="poster__shine" />
    </div>
  );
}

export default function App() {
  const [nav, setNav] = useState<NavKey>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'added' | 'title' | 'year' | 'rating'>('added');
  const [items, setItems] = useState<MediaItem[]>([]);
  const [series, setSeries] = useState<SeriesSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [sources, setSources] = useState<StorageSource[]>([]);
  const [continueList, setContinueList] = useState<Array<{ item: MediaItem; record: { position: number; duration: number } }>>([]);
  const [detail, setDetail] = useState<{ summary: SeriesSummary; items: MediaItem[] } | null>(null);
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [scan, setScan] = useState<ScanProgress | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [addKind, setAddKind] = useState<SourceKind | null>(null);
  const [browseSourceId, setBrowseSourceId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  const group: 'item' | 'series' =
    nav === 'tv' || nav === 'anime' ? 'series' : 'item';

  const loadCounts = useCallback(async () => {
    try {
      const rows = await call<Array<{ section: LibrarySection; count: number }>>(IPC.librarySections);
      const map: Record<string, number> = {};
      let sum = 0;
      for (const r of rows) {
        map[r.section] = r.count;
        sum += r.count;
      }
      map['all'] = sum;
      setCounts(map);
    } catch {
      /* 计数失败不阻断浏览 */
    }
  }, []);

  const loadSources = useCallback(async () => {
    try {
      setSources(await call<StorageSource[]>(IPC.sourcesList));
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    }
  }, [notify]);

  const loadLibrary = useCallback(async () => {
    if (nav === 'sources' || nav === 'settings' || nav === 'continue') return;
    setLoading(true);
    try {
      const query: Record<string, unknown> = {
        sort,
        order: 'desc',
        limit: group === 'series' ? 500 : 300,
        group,
      };
      if (nav !== 'all') query['section'] = nav;
      if (search.trim()) query['search'] = search.trim();
      const res = await call<BrowseResult>(IPC.libraryBrowse, query);
      setItems(res.items);
      setSeries(res.series);
      setTotal(res.total);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [nav, sort, group, search, notify]);

  const loadContinue = useCallback(async () => {
    try {
      const rows = await call<Array<{ item: MediaItem; record: { position: number; duration: number } }>>(
        IPC.libraryContinue,
        { limit: 24 },
      );
      setContinueList(rows);
    } catch {
      setContinueList([]);
    }
  }, []);

  useEffect(() => {
    void loadSources();
    void loadCounts();
    void call<AppSettings>(IPC.settingsGet).then(setSettings).catch(() => undefined);
    void call<{ mpvPath: string | null }>(IPC.mpvLocate).catch(() => undefined);
  }, [loadSources, loadCounts]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    if (nav === 'continue') void loadContinue();
  }, [nav, loadContinue]);

  useEffect(() => {
    const off1 = api.on<ScanProgress>(IPC.evScan, (p) => {
      setScan(p);
      if (p.phase === 'done') {
        notify(`扫描完成：发现 ${p.found} 个媒体文件`);
        void loadCounts();
        void loadLibrary();
      } else if (p.phase === 'error') {
        notify(`扫描失败：${p.message ?? '未知错误'}`);
      }
    });
    const off2 = api.on<PlayerState>(IPC.evPlayer, (s) => setPlayer(s));
    const off3 = api.on<{ reason: string }>(IPC.evLibrary, () => {
      void loadCounts();
    });
    return () => {
      off1();
      off2();
      off3();
    };
  }, [notify, loadCounts, loadLibrary]);

  const play = useCallback(
    async (itemId: string) => {
      setBusy(itemId);
      try {
        const res = await call<{ mode: string; message: string }>(IPC.playItem, { itemId });
        notify(res.message);
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [notify],
  );

  const playerCmd = useCallback(async (command: string, value?: number | string) => {
    try {
      await call(IPC.playCommand, { command, value });
    } catch {
      /* 控制条失败不打扰用户 */
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (!player || player.status === 'idle') return;
      if (e.code === 'Space') {
        e.preventDefault();
        void playerCmd('toggle-pause');
      } else if (e.code === 'ArrowRight') {
        void playerCmd('seek-relative', 10);
      } else if (e.code === 'ArrowLeft') {
        void playerCmd('seek-relative', -10);
      } else if (e.code === 'KeyF') {
        void playerCmd('fullscreen');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [player, playerCmd]);

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
        await loadCounts();
        await loadLibrary();
        await loadSources();
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err));
      }
    },
    [notify, loadCounts, loadLibrary, loadSources],
  );

  const openSeries = useCallback(async (key: string) => {
    try {
      const res = await call<{ summary: SeriesSummary; items: MediaItem[] } | null>(IPC.librarySeries, { key });
      setDetail(res);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    }
  }, [notify]);

  const updateSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      try {
        const next = await call<AppSettings>(IPC.settingsUpdate, patch);
        setSettings(next);
        notify('设置已保存');
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err));
      }
    },
    [notify],
  );

  const navLabel = useMemo(() => {
    if (nav === 'sources') return '存储源';
    if (nav === 'settings') return '设置';
    if (nav === 'continue') return '继续观看';
    if (nav === 'all') return '全部媒体';
    return SECTION_LABEL[nav];
  }, [nav]);

  const visibleSeries = nav === 'all' ? [] : series;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand__mark">✦</span>
          <div>
            <div className="brand__name">Nebula</div>
            <div className="brand__sub">星云影库</div>
          </div>
        </div>

        <nav className="nav">
          {NAV.map((n) => (
            <button
              key={n.key}
              className={`nav__item ${nav === n.key ? 'is-active' : ''}`}
              onClick={() => {
                setNav(n.key);
                setDetail(null);
              }}
            >
              <span className="nav__icon">{n.icon}</span>
              <span className="nav__label">{n.label}</span>
              {counts[n.key] !== undefined && n.key !== 'continue' ? (
                <span className="nav__count">{counts[n.key]}</span>
              ) : null}
            </button>
          ))}
        </nav>

        <div className="sidebar__section">
          <div className="sidebar__title">存储源</div>
          {sources.length === 0 ? (
            <div className="sidebar__hint">尚未添加任何源</div>
          ) : (
            sources.map((s) => (
              <button
                key={s.id}
                className="source-row"
                title={`${SOURCE_KIND_LABEL[s.kind]} · ${s.lastScanCount} 项`}
                onClick={() => setNav('sources')}
              >
                <span className={`dot ${s.enabled ? 'dot--on' : 'dot--off'}`} />
                <span className="source-row__name">{s.name}</span>
              </button>
            ))
          )}
          <button className="btn btn--ghost btn--full" onClick={() => setAddKind('local')}>
            + 添加存储源
          </button>
        </div>

        <div className="sidebar__footer">
          <button className={`nav__item ${nav === 'settings' ? 'is-active' : ''}`} onClick={() => setNav('settings')}>
            <span className="nav__icon">⚙</span>
            <span className="nav__label">设置</span>
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar__title">{navLabel}</div>
          <div className="topbar__spacer" />
          <input
            className="search"
            placeholder="搜索片名…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {nav !== 'sources' && nav !== 'settings' && nav !== 'continue' ? (
            <select className="select" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
              <option value="added">最近添加</option>
              <option value="title">按标题</option>
              <option value="year">按年份</option>
              <option value="rating">按评分</option>
            </select>
          ) : null}
          <button className="btn btn--primary" onClick={() => void startScan()} disabled={sources.length === 0}>
            扫描全部
          </button>
        </header>

        {scan && scan.phase !== 'done' && scan.phase !== 'cancelled' ? (
          <div className="scanbar">
            <span className="spinner" />
            <span>
              {scan.sourceName} · {scan.phase} · 已遍历 {scan.scanned} · 命中 {scan.found}
            </span>
            <span className="scanbar__path">{scan.currentPath ?? ''}</span>
            <button className="btn btn--ghost btn--sm" onClick={() => void call(IPC.scanCancel, { sourceId: scan.sourceId })}>
              取消
            </button>
          </div>
        ) : null}

        {nav === 'settings' ? (
          <SettingsPanel settings={settings} onSave={updateSettings} sources={sources} onOpenAddSource={(k) => setAddKind(k)} />
        ) : nav === 'sources' ? (
          <SourcesPanel
            sources={sources}
            onAdd={() => setAddKind('local')}
            onRemove={async (id) => {
              await call(IPC.sourcesRemove, { id });
              await loadSources();
              await loadCounts();
              notify('已移除存储源');
            }}
            onTest={async (id) => {
              try {
                const res = await call<{ ok: boolean; message: string }>(IPC.sourcesTest, { id });
                notify(res.ok ? `连接正常：${res.message}` : `连接失败：${res.message}`);
              } catch (err) {
                notify(err instanceof Error ? err.message : String(err));
              }
            }}
            onScan={(id) => void startScan(id)}
            onBrowse={(id) => setBrowseSourceId(id)}
          />
        ) : nav === 'continue' ? (
          <section className="grid">
            {continueList.length === 0 ? (
              <Empty text="还没有观看记录。播放任意影片后，进度会记录在这里。" />
            ) : (
              continueList.map(({ item, record }) => (
                <article key={item.id} className="card" onClick={() => void play(item.id)}>
                  <Poster item={item} />
                  <div className="card__body">
                    <div className="card__title">{item.seriesTitle ?? item.title}</div>
                    <div className="card__meta">
                      {epLabel(item)} · 看到 {fmtTime(record.position)}
                      {record.duration > 0 ? ` / ${fmtTime(record.duration)}` : ''}
                    </div>
                    <div className="progress">
                      <div
                        className="progress__bar"
                        style={{ width: `${record.duration > 0 ? Math.min(100, (record.position / record.duration) * 100) : 0}%` }}
                      />
                    </div>
                  </div>
                </article>
              ))
            )}
          </section>
        ) : detail ? (
          <SeriesDetail
            data={detail}
            onBack={() => setDetail(null)}
            onPlay={(id) => void play(id)}
            busy={busy}
          />
        ) : (
          <>
            {loading ? <div className="loading">加载中…</div> : null}
            {group === 'series' ? (
              visibleSeries.length === 0 && !loading ? (
                <Empty text="这个分区还没有内容。添加存储源并扫描后，剧集会按剧名聚合显示。" />
              ) : (
                <section className="grid">
                  {visibleSeries.map((s) => (
                    <article key={s.key} className="card" onClick={() => void openSeries(s.key)}>
                      <Poster item={s} />
                      <div className="card__body">
                        <div className="card__title">{s.title}</div>
                        <div className="card__meta">
                          {s.year ? `${s.year} · ` : ''}
                          {s.episodeCount} 集 / {s.seasonCount} 季
                        </div>
                      </div>
                    </article>
                  ))}
                </section>
              )
            ) : items.length === 0 && !loading ? (
              <Empty
                text={
                  sources.length === 0
                    ? '还没有存储源。点左侧「+ 添加存储源」，可以挂本地目录或 WebDAV（Alist/OpenList 可聚合百度、阿里、夸克等网盘）。'
                    : '这个分区还没有内容，试试扫描存储源。'
                }
              />
            ) : (
              <section className="grid">
                {items.map((it) => (
                  <article key={it.id} className="card" onClick={() => void play(it.id)}>
                    <Poster item={it} />
                    <div className="card__body">
                      <div className="card__title">{it.seriesTitle ?? it.title}</div>
                      <div className="card__meta">
                        {[epLabel(it), it.resolution, it.quality].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    {busy === it.id ? <div className="card__busy">…</div> : null}
                  </article>
                ))}
              </section>
            )}
            <div className="result-count">共 {total} 项</div>
          </>
        )}
      </main>

      {player && player.status !== 'idle' ? (
        <div className="player">
          <div className="player__info">
            <div className="player__title">{player.title ?? '未知'}</div>
            <div className="player__sub">
              {player.status === 'error' ? (player.error ?? '播放错误') : `${player.status}${player.mpvPath ? '' : ' · 无 mpv'}`}
            </div>
          </div>
          <div className="player__timeline">
            <span className="player__time">{fmtTime(player.position)}</span>
            <input
              className="slider"
              type="range"
              min={0}
              max={Math.max(1, player.duration)}
              value={Math.min(player.position, player.duration || 0)}
              onChange={(e) => void playerCmd('seek', Number(e.target.value))}
            />
            <span className="player__time">{fmtTime(player.duration)}</span>
          </div>
          <div className="player__controls">
            <button className="btn btn--icon" onClick={() => void playerCmd('seek-relative', -10)} title="后退 10s">
              ⏪
            </button>
            <button className="btn btn--icon btn--play" onClick={() => void playerCmd('toggle-pause')} title="播放/暂停">
              {player.status === 'paused' ? '▶' : '⏸'}
            </button>
            <button className="btn btn--icon" onClick={() => void playerCmd('seek-relative', 10)} title="前进 10s">
              ⏩
            </button>
            <button className="btn btn--icon" onClick={() => void playerCmd('mute')} title="静音">
              {player.muted ? '🔇' : '🔊'}
            </button>
            <input
              className="slider slider--vol"
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
            <button className="btn btn--icon" onClick={() => void playerCmd('fullscreen')} title="全屏">
              ⛶
            </button>
            <button className="btn btn--icon" onClick={() => void call(IPC.playStop)} title="停止">
              ✕
            </button>
          </div>
        </div>
      ) : null}

      {browseSourceId ? (
        <BrowseDialog sourceId={browseSourceId} onClose={() => setBrowseSourceId(null)} />
      ) : null}

      {addKind ? (
        <AddSourceDialog
          initialKind={addKind}
          onClose={() => setAddKind(null)}
          onCreated={async () => {
            setAddKind(null);
            await loadSources();
            notify('存储源已添加，可以开始扫描了');
          }}
        />
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="empty">
      <div className="empty__mark">✦</div>
      <p>{text}</p>
    </div>
  );
}

function SeriesDetail({
  data,
  onBack,
  onPlay,
  busy,
}: {
  data: { summary: SeriesSummary; items: MediaItem[] };
  onBack: () => void;
  onPlay: (id: string) => void;
  busy: string | null;
}) {
  const seasons = useMemo(() => {
    const map = new Map<number, MediaItem[]>();
    for (const it of data.items) {
      const s = it.season ?? 0;
      const arr = map.get(s) ?? [];
      arr.push(it);
      map.set(s, arr);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [data.items]);

  return (
    <section className="detail">
      <button className="btn btn--ghost btn--sm" onClick={onBack}>
        ← 返回
      </button>
      <div className="detail__head">
        <Poster item={data.summary} big />
        <div>
          <h2 className="detail__title">{data.summary.title}</h2>
          <div className="detail__meta">
            {data.summary.year ? `${data.summary.year} · ` : ''}
            {data.summary.episodeCount} 集 · {data.summary.seasonCount} 季
          </div>
        </div>
      </div>
      {seasons.map(([season, list]) => (
        <div key={season} className="season">
          <div className="season__title">{season === 0 ? '未标注季' : `第 ${season} 季`}</div>
          <div className="episodes">
            {list.map((it) => (
              <button key={it.id} className="episode" onClick={() => onPlay(it.id)} disabled={busy === it.id}>
                <span className="episode__num">{it.episode !== null ? `E${String(it.episode).padStart(2, '0')}` : '—'}</span>
                <span className="episode__name">{it.title}</span>
                <span className="episode__tag">{[it.resolution, it.quality].filter(Boolean).join(' ')}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function SourcesPanel({
  sources,
  onAdd,
  onRemove,
  onTest,
  onScan,
  onBrowse,
}: {
  sources: StorageSource[];
  onAdd: () => void;
  onRemove: (id: string) => Promise<void>;
  onTest: (id: string) => Promise<void>;
  onScan: (id: string) => void;
  onBrowse: (id: string) => void;
}) {
  return (
    <section className="panel">
      <div className="panel__head">
        <h2>存储源</h2>
        <button className="btn btn--primary" onClick={onAdd}>
          + 添加
        </button>
      </div>
      {sources.length === 0 ? (
        <Empty text="还没有存储源。支持本地目录与 WebDAV。" />
      ) : (
        <div className="source-list">
          {sources.map((s) => (
            <div key={s.id} className="source-card">
              <div className="source-card__main">
                <div className="source-card__name">
                  <span className={`dot ${s.enabled ? 'dot--on' : 'dot--off'}`} />
                  {s.name}
                  <span className="badge">{SOURCE_KIND_LABEL[s.kind]}</span>
                </div>
                <div className="source-card__meta">
                  {s.config.kind === 'local'
                    ? s.config.roots.join('  ·  ')
                    : s.config.kind === 'webdav'
                      ? `${s.config.url} · ${s.config.root || '/'}`
                      : ''}
                </div>
                <div className="source-card__meta">
                  {s.lastScanAt ? `上次扫描：${new Date(s.lastScanAt).toLocaleString()} · ${s.lastScanCount} 项` : '尚未扫描'}
                  {s.lastError ? ` · 上次错误：${s.lastError}` : ''}
                </div>
              </div>
              <div className="source-card__actions">
                <button className="btn btn--ghost btn--sm" onClick={() => void onTest(s.id)}>
                  测试连接
                </button>
                <button className="btn btn--primary btn--sm" onClick={() => onScan(s.id)}>
                  扫描
                </button>
                <button className="btn btn--ghost btn--sm" onClick={() => onBrowse(s.id)}>
                  浏览
                </button>
                <button
                  className="btn btn--danger btn--sm"
                  onClick={() => {
                    if (confirm(`移除「${s.name}」？该源的媒体条目也会一并移除。`)) void onRemove(s.id);
                  }}
                >
                  移除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
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

function SettingsPanel({
  settings,
  onSave,
  sources,
  onOpenAddSource,
}: {
  settings: AppSettings | null;
  onSave: (patch: Partial<AppSettings>) => Promise<void>;
  sources: StorageSource[];
  onOpenAddSource: (kind: 'local' | 'webdav' | 'aliyun') => void;
}) {
  const [mpvPath, setMpvPath] = useState(settings?.mpvPath ?? '');
  const [hwdec, setHwdec] = useState(settings?.hardwareDecode ?? true);
  const [player, setPlayer] = useState<PlayerConfig>(settings?.player ?? DEFAULT_PLAYER_CONFIG);
  const [detected, setDetected] = useState<PlayerDetectResult | null>(null);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [version, setVersion] = useState<string>('');
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

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
    await onSave({ mpvPath: mpvPath.trim() ? mpvPath.trim() : null, hardwareDecode: hwdec, player });
    if (alsoTest) {
      try {
        const r = await call<{ ok: boolean; message: string }>(IPC.playersTest);
        setTestMsg({ ok: r.ok, text: r.message });
      } catch (err) {
        setTestMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  const currentExternal = detected?.external.find((d) => d.id === player.externalId);

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>网盘连接</h2>
        <span className="drive-count">
          {sources.length > 0 ? `已连接 ${sources.length} 个源` : '未连接'}
        </span>
      </div>
      <p className="panel__lede">
        阿里云盘可直接扫码授权。其余网盘建议经 Alist / OpenList 转成 WebDAV 后接入——这是目前唯一稳定、不依赖私有接口的方式。
      </p>
      <div className="drive-grid">
        {CLOUD_DRIVES.map((d) => {
          const connected =
            (d.id === 'aliyun' && sources.some((s) => s.kind === 'aliyun')) ||
            (d.status === 'bridge' &&
              sources.some((s) => s.kind === 'webdav' && s.name.includes(d.name.replace('网盘', ''))));
          const badge = connected ? '已连接' : d.status === 'ready' ? '可接入' : '经 Alist';
          return (
            <button
              key={d.id}
              className={`drive-card ${connected ? 'is-connected' : ''}`}
              onClick={() => {
                if (d.targetKind) onOpenAddSource(d.targetKind);
              }}
              title={d.guide}
            >
              <span className="drive-card__mark" style={{ background: d.color }}>
                {d.mark}
              </span>
              <span className="drive-card__name">{d.name}</span>
              <span className="drive-card__auth">{d.authLabel}</span>
              <span className={`drive-card__badge ${connected ? 'is-on' : ''}`}>{badge}</span>
            </button>
          );
        })}
      </div>

      <div className="panel__note">
        <h3>其余网盘的接入步骤</h3>
        <ol className="steps">
          {ALIST_BRIDGE_STEPS.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </div>

      <div className="panel__head">
        <h2>播放</h2>
      </div>

      <div className="field">
        <label>播放方式</label>
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
      </div>

      <div className="field">
        <label>内置 mpv</label>
        <div className="status-line">
          {detected?.mpv.path ? (
            <span className="status status--ok">✓ {detected.mpv.message}</span>
          ) : (
            <span className="status status--warn">! {detected?.mpv.message ?? '检测中…'}</span>
          )}
        </div>
        <input
          className="input"
          placeholder="留空则自动探测（内置 → PATH → 常见安装位置）"
          value={mpvPath}
          onChange={(e) => setMpvPath(e.target.value)}
        />
        <small>打包版已内置 mpv，通常不需要填写。填写后优先于内置版本。</small>
      </div>

      <div className="field">
        <label>mpv 附加参数</label>
        <input
          className="input"
          placeholder="例：--profile=low-latency --hwdec=auto"
          value={player.builtinArgs}
          onChange={(e) => setPlayer((p) => ({ ...p, builtinArgs: e.target.value }))}
        />
        <small>空格分隔，支持引号。修改后下次播放生效。</small>
      </div>

      <div className="field">
        <label>外部播放器</label>
        <select
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
              placeholder="播放器可执行文件完整路径"
              value={player.externalPath}
              onChange={(e) => setPlayer((p) => ({ ...p, externalPath: e.target.value }))}
            />
            <button
              className="btn btn--ghost"
              onClick={async () => {
                try {
                  const picked = await call<string | null>(IPC.pickExecutable);
                  if (picked) setPlayer((p) => ({ ...p, externalPath: picked }));
                } catch {
                  /* 用户取消 */
                }
              }}
            >
              浏览…
            </button>
          </div>
        ) : null}
      </div>

      <div className="field">
        <label>参数模板</label>
        <input
          className="input"
          placeholder='"{url}"'
          value={player.externalArgs}
          onChange={(e) => setPlayer((p) => ({ ...p, externalArgs: e.target.value }))}
        />
        <small>
          占位符：{'>{url}<'} 视频地址、{'>{title}<'} 标题、{'>{start}<'} 续播起点秒数。带空格的路径用引号包住。
        </small>
      </div>

      <div className="field field--row">
        <label>硬件解码（内置 mpv）</label>
        <input type="checkbox" checked={hwdec} onChange={(e) => setHwdec(e.target.checked)} />
      </div>

      <div className="row">
        <button className="btn btn--primary" onClick={() => void save(false)}>
          保存设置
        </button>
        <button className="btn btn--ghost" onClick={() => void save(true)}>
          保存并测试
        </button>
        <button className="btn btn--ghost" onClick={() => void detect()}>
          重新检测
        </button>
      </div>

      {testMsg ? (
        <div className={testMsg.ok ? 'status status--ok' : 'error'} style={{ marginTop: 12 }}>
          {testMsg.text}
        </div>
      ) : null}

      <div className="panel__note">
        <h3>关于播放器</h3>
        <p>
          内置 mpv 随安装包分发（<code>resources/mpv/mpv.exe</code>），不需要单独安装。外部播放器会自动探测 PotPlayer、VLC、
          MPC-HC、MPC-BE 与系统 mpv 的常见安装位置；没装就明确报错，不会静默换成别的播放器。
        </p>
        <p>音频与图片始终交给外部程序打开，不走 mpv 的播放流程。</p>
      </div>

      <div className="panel__head">
        <h2>关于与更新</h2>
        <span className="drive-count">v{version || '—'}</span>
      </div>
      <div className="row">
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
      {update ? (
        <div style={{ marginTop: 10 }}>
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

      <div className="panel__note">
        <h3>关于网盘接入</h3>
        <p>
          内置 WebDAV 客户端。<strong>Alist / OpenList</strong> 可以把百度网盘、阿里云盘、夸克、115、OneDrive、Google Drive
          统一挂成 WebDAV，因此在「添加存储源 → WebDAV」里填入 Alist 的地址与账号，即可一次性接入这些网盘。
        </p>
        <p>阿里云盘 / 百度网盘的官方 API 直连需要 OAuth 应用审核，当前版本尚未内置，会给出明确提示而不是假装支持。</p>
      </div>
    </section>
  );
}

const SOURCE_TABS: SourceKind[] = ['local', 'webdav', 'aliyun'];

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
 * 目录为空时直接提示「可能是 drive_id 指向了另一个盘」。
 */
function BrowseDialog({ sourceId, onClose }: { sourceId: string; onClose: () => void }) {
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [stack, setStack] = useState<Array<{ id: string; name: string }>>([{ id: '', name: '根目录' }]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async (parentId: string) => {
    setLoading(true);
    setErr(null);
    try {
      const r = await call<{ parent: string; entries: BrowseEntry[] }>(IPC.browseList, { sourceId, parentId });
      setEntries(r.entries);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId]);

  const dirs = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir);

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__panel" onClick={(e) => e.stopPropagation()}>
        <h2>浏览网盘</h2>

        <div className="browse-crumb">
          {stack.map((seg, i) => (
            <span key={`${seg.id}-${i}`}>
              {i > 0 ? <span className="browse-crumb__sep">/</span> : null}
              <button
                onClick={() => {
                  setStack((s) => s.slice(0, i + 1));
                  void load(i === 0 ? '' : seg.id);
                }}
              >
                {seg.name}
              </button>
            </span>
          ))}
        </div>

        {loading ? <div className="status">加载中…</div> : null}
        {err ? <div className="error">{err}</div> : null}

        {!loading && !err && entries.length === 0 ? (
          <div className="status status--warn">
            这个目录没有内容。若你确定网盘里有文件，说明 API 拿到的 drive_id 指向了另一个盘——
            在「添加存储源 → 阿里云盘」里填写网页版 F12 中看到的 drive_id 后重建源。
          </div>
        ) : null}

        <ul className="browse-list">
          {dirs.map((d) => (
            <li key={d.path}>
              <button
                className="browse-row browse-row--dir"
                onClick={() => {
                  setStack((s) => [...s, { id: d.path, name: d.name }]);
                  void load(d.path);
                }}
              >
                <span className="browse-row__name">📁 {d.name}</span>
              </button>
            </li>
          ))}
          {files.map((f) => (
            <li key={f.path}>
              <div className="browse-row">
                <span className="browse-row__name">🎬 {f.name}</span>
                <span className="browse-row__meta">{fmtSize(f.size)}</span>
              </div>
            </li>
          ))}
        </ul>

        <div className="modal__actions">
          <span className="status">
            {entries.length} 项（{dirs.length} 文件夹 / {files.length} 文件）
          </span>
          <button className="btn btn--ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function AddSourceDialog({
  onClose,
  onCreated,
  initialKind = 'local',
}: {
  onClose: () => void;
  onCreated: () => Promise<void>;
  initialKind?: SourceKind;
}) {
  const [kind, setKind] = useState<SourceKind>(initialKind);
  const [name, setName] = useState('');
  const [roots, setRoots] = useState<string[]>([]);
  const [url, setUrl] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [root, setRoot] = useState('/');
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [qr, setQr] = useState<{ sessionId: string; dataUrl: string } | null>(null);
  const [qrStatus, setQrStatus] = useState('');
  const [qrBusy, setQrBusy] = useState(false);
  const [driveIdOverride, setDriveIdOverride] = useState('');
  const nameRef = useRef(name);
  const driveIdRef = useRef(driveIdOverride);
  useEffect(() => {
    nameRef.current = name;
  }, [name]);
  useEffect(() => {
    driveIdRef.current = driveIdOverride;
  }, [driveIdOverride]);

  const addLocal = async () => {
    try {
      const picked = await call<string[]>(IPC.pickDirectory);
      if (picked.length > 0) setRoots((prev) => [...new Set([...prev, ...picked])]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const startQr = async () => {
    setQrBusy(true);
    setErr(null);
    setQr(null);
    setQrStatus('正在生成二维码…');
    try {
      const r = await call<{ sessionId: string; qrDataUrl: string }>(IPC.aliyunQrStart);
      setQr({ sessionId: r.sessionId, dataUrl: r.qrDataUrl });
      setQrStatus('等待扫码…');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setQrStatus('');
    } finally {
      setQrBusy(false);
    }
  };

  // 轮询扫码状态：确认后主进程已经建好源，这里只需刷新列表并关窗
  useEffect(() => {
    if (!qr) return;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      try {
        const r = await call<{ status: string }>(IPC.aliyunQrPoll, {
          sessionId: qr.sessionId,
          name: nameRef.current.trim() || undefined,
          driveId: driveIdRef.current.trim() || undefined,
        });
        if (stopped) return;
        if (r.status === 'NEW') setQrStatus('等待扫码…');
        else if (r.status === 'SCANNED') setQrStatus('已扫码，请在手机上确认登录');
        else if (r.status === 'EXPIRED') {
          setQrStatus('二维码已过期，请点「重新生成二维码」');
          if (timer) clearInterval(timer);
        } else if (r.status === 'CONFIRMED') {
          setQrStatus('授权成功，正在挂载…');
          if (timer) clearInterval(timer);
          await onCreated();
        }
      } catch (e) {
        if (!stopped) setQrStatus(e instanceof Error ? e.message : String(e));
      }
    };

    timer = setInterval(() => void tick(), 2000);
    void tick();
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, [qr, onCreated]);

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
        config = { kind: 'webdav', url: url.trim(), username: user, password: pass, root: root.trim() || '/' };
      } else {
        throw new Error('阿里云盘走扫码授权，不需要手动提交');
      }
      await call(IPC.sourcesCreate, {
        kind,
        name: name.trim() || (kind === 'local' ? '本地目录' : 'WebDAV'),
        config,
      });
      await onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__panel" onClick={(e) => e.stopPropagation()}>
        <h2>添加存储源</h2>
        <div className="tabs">
          {SOURCE_TABS.map((k) => (
            <button
              key={k}
              className={`tab ${kind === k ? 'is-active' : ''}`}
              onClick={() => {
                setKind(k);
                setErr(null);
              }}
            >
              {SOURCE_KIND_LABEL[k]}
            </button>
          ))}
        </div>

        <div className="field">
          <label>名称</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例：我的电影盘" />
        </div>

        {kind === 'local' ? (
          <>
            <div className="field">
              <label>目录</label>
              <button className="btn btn--ghost" onClick={() => void addLocal()}>
                选择目录…
              </button>
              <ul className="pick-list">
                {roots.map((r) => (
                  <li key={r}>
                    <span>{r}</span>
                    <button className="btn btn--sm btn--ghost" onClick={() => setRoots(roots.filter((x) => x !== r))}>
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
              <label>WebDAV 地址</label>
              <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/dav" />
            </div>
            <div className="field">
              <label>起始路径</label>
              <input className="input" value={root} onChange={(e) => setRoot(e.target.value)} placeholder="/" />
            </div>
            <div className="field">
              <label>用户名</label>
              <input className="input" value={user} onChange={(e) => setUser(e.target.value)} />
            </div>
            <div className="field">
              <label>密码</label>
              <input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
              <small>密码用系统级加密（Windows DPAPI）保存，不落明文。</small>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label>资源库 drive_id（通常留空）</label>
              <input
                className="input"
                value={driveIdOverride}
                onChange={(e) => setDriveIdOverride(e.target.value)}
                placeholder="仅在扫描结果为 0 项时才需要填写"
              />
              <small>
                阿里云盘 API 只返回备份盘 id，与网页版实际使用的「资源库」可能不同。若扫描后显示 0
                项：打开网页版按 F12 → Network，任一请求里的 <code>drive_id</code> 就是要填的值。
              </small>
            </div>
            <div className="field">
              <label>扫码授权</label>
              <small>用<strong>阿里云盘 App</strong>扫描下方二维码，在手机上点确认，即可自动挂载到本应用。</small>
              {qr ? (
                <div className="qr-wrap">
                  <img className="qr" src={qr.dataUrl} alt="阿里云盘登录二维码" />
                </div>
              ) : null}
              <div className="qr-status">{qrStatus}</div>
              <button className="btn btn--ghost" onClick={() => void startQr()} disabled={qrBusy}>
                {qrBusy ? '生成中…' : qr ? '重新生成二维码' : '生成二维码'}
              </button>
              <small>
                授权后的 access_token 与 refresh_token 都用系统级加密保存，只在本地用于调用阿里云盘接口。
                若扫码后提示无法解析 token，说明官方接口结构已变，可改用 WebDAV（Alist）方式挂载。
              </small>
            </div>
          </>
        )}

        {err ? <div className="error">{err}</div> : null}

        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={onClose}>
            {kind === 'aliyun' ? '关闭' : '取消'}
          </button>
          {kind === 'aliyun' ? null : (
            <button className="btn btn--primary" onClick={() => void submit()} disabled={submitting}>
              {submitting ? '添加中…' : '添加'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
