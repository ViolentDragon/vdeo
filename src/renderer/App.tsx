import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SECTION_LABEL,
  SOURCE_KIND_LABEL,
  type AppSettings,
  type BrowseResult,
  type LibrarySection,
  type MediaItem,
  type PlayerState,
  type ScanProgress,
  type SeriesSummary,
  type SourceConfig,
  type SourceKind,
  type StorageSource,
} from '../shared/types';
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
  const [addOpen, setAddOpen] = useState(false);
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
          <button className="btn btn--ghost btn--full" onClick={() => setAddOpen(true)}>
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
          <SettingsPanel settings={settings} onSave={updateSettings} />
        ) : nav === 'sources' ? (
          <SourcesPanel
            sources={sources}
            onAdd={() => setAddOpen(true)}
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

      {addOpen ? (
        <AddSourceDialog
          onClose={() => setAddOpen(false)}
          onCreated={async () => {
            setAddOpen(false);
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
}: {
  sources: StorageSource[];
  onAdd: () => void;
  onRemove: (id: string) => Promise<void>;
  onTest: (id: string) => Promise<void>;
  onScan: (id: string) => void;
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

function SettingsPanel({
  settings,
  onSave,
}: {
  settings: AppSettings | null;
  onSave: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const [mpv, setMpv] = useState(settings?.mpvPath ?? '');
  const [ext, setExt] = useState(settings?.externalPlayer ?? '');
  const [hwdec, setHwdec] = useState(settings?.hardwareDecode ?? true);

  useEffect(() => {
    setMpv(settings?.mpvPath ?? '');
    setExt(settings?.externalPlayer ?? '');
    setHwdec(settings?.hardwareDecode ?? true);
  }, [settings]);

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>设置</h2>
      </div>
      <div className="field">
        <label>mpv 路径</label>
        <input
          className="input"
          placeholder="留空则自动探测（PATH / 常见安装位置）"
          value={mpv}
          onChange={(e) => setMpv(e.target.value)}
        />
        <small>内嵌播放依赖 mpv。未安装时可用下面的外部播放器。</small>
      </div>
      <div className="field">
        <label>外部播放器命令</label>
        <input
          className="input"
          placeholder="例：C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe 或 vlc"
          value={ext}
          onChange={(e) => setExt(e.target.value)}
        />
        <small>把视频地址作为最后一个参数传入。留空则用系统默认程序打开。</small>
      </div>
      <div className="field field--row">
        <label>硬件解码</label>
        <input type="checkbox" checked={hwdec} onChange={(e) => setHwdec(e.target.checked)} />
      </div>
      <button
        className="btn btn--primary"
        onClick={() =>
          void onSave({
            mpvPath: mpv.trim() ? mpv.trim() : null,
            externalPlayer: ext.trim() ? ext.trim() : null,
            hardwareDecode: hwdec,
          })
        }
      >
        保存设置
      </button>
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

function AddSourceDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const [kind, setKind] = useState<SourceKind>('local');
  const [name, setName] = useState('');
  const [roots, setRoots] = useState<string[]>([]);
  const [url, setUrl] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [root, setRoot] = useState('/');
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const addLocal = async () => {
    try {
      const picked = await call<string[]>(IPC.pickDirectory);
      if (picked.length > 0) setRoots((prev) => [...new Set([...prev, ...picked])]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

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
        throw new Error('该网盘类型暂未接入，请用 Alist/OpenList 转成 WebDAV');
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
          {(['local', 'webdav'] as SourceKind[]).map((k) => (
            <button key={k} className={`tab ${kind === k ? 'is-active' : ''}`} onClick={() => setKind(k)}>
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
        ) : (
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
        )}

        {err ? <div className="error">{err}</div> : null}

        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn--primary" onClick={() => void submit()} disabled={submitting}>
            {submitting ? '添加中…' : '添加'}
          </button>
        </div>
      </div>
    </div>
  );
}
