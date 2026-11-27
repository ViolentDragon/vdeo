import { app, BrowserWindow, ipcMain, Menu, nativeImage, net, shell } from 'electron';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { initLogger, log } from './logger';
import { IPC, type LocalPathMode, type Rpc } from '../shared/ipc-contract';
import { listLocalPaths } from './local-paths';
import { DEFAULT_PLAYER_CONFIG } from '../shared/types';
import type {
  AliyunSourceConfig,
  AppSettings,
  BrowseQuery,
  Genre,
  MediaItem,
  PlayerState,
  ScanProgress,
  ScanScope,
  ScanSummary,
  SourceConfig,
  SourceKind,
  StorageSource,
  VideoSurfaceBounds,
} from '../shared/types';
import { createRepository, type Repository } from './db';
import { sourceId as newSourceId } from './db/ids';
import { checkForUpdate, UPDATE_REPO } from './updater';
import { createProvider } from './sources/registry';
import { getDriveInfo, refreshToken, type AliyunToken, type DriveInfo } from './sources/aliyun-auth';
import { decryptSecret, encryptSecret } from './sources/secrets';
import { createTmdbClient, normalizeTmdbCredential, TMDB_CREDENTIAL_KEY } from './metadata/tmdb';
import { TmdbSync } from './metadata/sync';
import type { TmdbStatus } from '../shared/tmdb';
import { createAliyunQrLogin } from './sources/aliyun-qr';
import { parentOf, type StorageProvider } from './sources/types';
import { scanSource } from './scan/scanner';
import { listSourceDirectory, validateScanScope } from './scan/scope';
import { AUDIO_EXTS, IMAGE_EXTS, SUBTITLE_EXTS, VIDEO_EXTS } from './scan/namer';
import { locateMpv } from './player/locate';
import { detectExternalPlayers, migrateLegacyCommand, resolveExternalLaunch, splitArgs } from './player/external';
import { MpvController } from './player/mpv';
import type { PlaybackShortcut } from '../shared/playback-shortcuts';
import type { WindowsVideoSurface } from './player/windows-video-surface';
import { captureFirstVisibleFrame } from './player/cover';

let win: BrowserWindow | null = null;
let startupError: string | undefined;
let repo: Repository;
let settings: AppSettings;
let tmdbSync: TmdbSync;
let tmdbCredential = '';
let checkingTmdbCredential = false;
let controller: MpvController | null = null;
let videoSurface: WindowsVideoSurface | null = null;
let videoBounds: VideoSurfaceBounds | null = null;
let playRequest = 0;
let playbackWork = Promise.resolve();

function runPlaybackWork<T>(operation: () => Promise<T>): Promise<T> {
  const result = playbackWork.then(operation);
  playbackWork = result.then(() => undefined, () => undefined);
  return result;
}
let mpvPath: string | null = null;
const scanning = new Map<string, AbortController>();
const aliyunProviders = new Map<string, StorageProvider>();
const artworkCache = new Map<string, { expires: number; result: Promise<string | null> }>();
const POSTER_MIME: Record<string, string> = { jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' };
const POSTER_MAX_BYTES = 5_000_000;
const electronFetch: typeof fetch = (input, init) => net.fetch(input instanceof URL ? input.href : input, init);

const DEFAULT_SETTINGS: AppSettings = {
  mpvPath: null,
  player: { ...DEFAULT_PLAYER_CONFIG },
  theme: 'dark',
  ignorePatterns: ['$RECYCLE.BIN', 'System Volume Information', '@eaDir', '#recycle', '.Trash'],
  videoExtensions: [...VIDEO_EXTS],
  hardwareDecode: true,
  cacheDir: '',
};

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function ok<T>(data: T): Rpc<T> {
  return { ok: true, data };
}

function fail(err: unknown): Rpc<never> {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

function handle<TIn, TOut>(channel: string, fn: (payload: TIn) => Promise<TOut> | TOut): void {
  ipcMain.handle(channel, async (_event, payload: TIn): Promise<Rpc<TOut>> => {
    try {
      return ok(await fn(payload));
    } catch (err) {
      return fail(err);
    }
  });
}

type LegacyPlayerFields = { externalPlayer?: unknown; preferredMode?: unknown };

function loadSettings(): AppSettings {
  const stored = repo.getAllSettings() as Partial<AppSettings> & LegacyPlayerFields;
  const merged: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...stored,
    player: { ...DEFAULT_PLAYER_CONFIG, ...(stored.player ?? {}) },
    cacheDir: stored.cacheDir || join(app.getPath('userData'), 'cache'),
  };

  // 旧版把外部播放器存成一整条命令字符串（externalPlayer），还有一个从未被读取的
  // preferredMode。这里做一次性迁移，避免老用户升级后配置丢失。
  const legacyCommand = typeof stored.externalPlayer === 'string' ? stored.externalPlayer.trim() : '';
  if (!stored.player && (legacyCommand || stored.preferredMode)) {
    const migrated = legacyCommand ? migrateLegacyCommand(legacyCommand) : {};
    merged.player = {
      ...DEFAULT_PLAYER_CONFIG,
      engine: stored.preferredMode === 'external' ? 'external' : 'auto',
      ...migrated,
    };
  }

  const raw = merged as unknown as Record<string, unknown>;
  delete raw['externalPlayer'];
  delete raw['preferredMode'];
  return merged;
}

function requireSource(id: string): StorageSource {
  const s = repo.getSource(id);
  if (!s) throw new Error(`存储源不存在：${id}`);
  return s;
}

function requireItem(id: string): MediaItem {
  const item = repo.getItem(id);
  if (!item) throw new Error(`媒体条目不存在：${id}`);
  return item;
}

function libraryArtwork(id: string): Promise<string | null> {
  const item = requireItem(id);
  if (item.missing) return Promise.resolve(null);
  const key = `${id}:${item.mtime}`;
  const cached = artworkCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.result;
  const result = (async () => {
    const video = isVideo(item);
    if (!video && !IMAGE_EXTS.has(item.ext)) return null;
    const source = requireSource(item.sourceId);
    const provider = providerFor(source);
    const artwork = await provider.getArtwork?.(item.path, video).catch(() => null);
    const image = artwork ? await fetchArtwork(artwork).catch(() => null) : null;
    if (video) {
      if (!item.seriesKey) return image;
      if (image && hasVisibleFrame(image)) return image;
      return mpvPath ? captureFirstVisibleFrame(mpvPath, await provider.resolvePlayUrl(item.path)) : null;
    }
    if (image) return image;
    const type = POSTER_MIME[item.ext];
    if (!type) return null;
    if (source.kind === 'local') {
      if ((await stat(item.path)).size > POSTER_MAX_BYTES) return null;
      return `data:${type};base64,${(await readFile(item.path)).toString('base64')}`;
    }
    if (source.kind === 'webdav') return fetchArtwork(await provider.resolvePlayUrl(item.path), type);
    return null;
  })().catch(() => null);
  if (artworkCache.size >= 80) artworkCache.delete(artworkCache.keys().next().value!);
  artworkCache.set(key, { expires: Date.now() + 5 * 60_000, result });
  return result;
}

function hasVisibleFrame(data: string): boolean {
  const image = nativeImage.createFromDataURL(data);
  if (image.isEmpty()) return false;
  const bitmap = image.resize({ width: 64 }).toBitmap();
  let lit = 0;
  for (let i = 0; i < bitmap.length; i += 4) {
    const luminance = 0.0722 * bitmap[i]! + 0.7152 * bitmap[i + 1]! + 0.2126 * bitmap[i + 2]!;
    if (luminance > 12) lit += 1;
  }
  return lit > bitmap.length / 400;
}

async function fetchArtwork(artwork: { url: string; headers: Record<string, string> }, webdavType?: string): Promise<string | null> {
  const url = new URL(artwork.url);
  if (!webdavType && !/(^|\.)(alipan\.com|aliyundrive\.(com|net)|alicdn\.com|aliyunpds\.com|aliyuncs\.com)$/.test(url.hostname)) return null;
  const response = await fetch(url, { headers: artwork.headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
  const type = webdavType ?? response.headers.get('content-type') ?? '';
  if (!response.ok || !/^image\/(jpeg|png|webp|gif|bmp)$/.test(type) || !response.body) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > (webdavType ? POSTER_MAX_BYTES : 600_000)) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`;
}

/** 统一的 provider 工厂：阿里云盘 token 轮换后必须写回数据库，否则重启即失效 */
function providerFor(source: StorageSource): ReturnType<typeof createProvider> {
  const cached = aliyunProviders.get(source.id);
  if (cached) return cached;
  const provider = createProvider(source, {
    onAliyunTokenRefreshed: (sourceId, token) => {
      if (aliyunProviders.get(sourceId) !== provider) return;
      const s = repo.getSource(sourceId);
      if (!s || s.config.kind !== 'aliyun') return;
      const cfg = s.config as AliyunSourceConfig;
      s.config = {
        ...cfg,
        accessToken: encryptSecret(token.accessToken),
        refreshToken: encryptSecret(token.refreshToken),
        expiresAt: token.expiresAt,
      };
      repo.updateSource(s);
      log('[aliyun] access_token 已刷新并写回');
    },
  });
  if (source.kind === 'aliyun') aliyunProviders.set(source.id, provider);
  return provider;
}

/* ----------------------------- 扫描 ----------------------------- */

async function runScan(sourceId: string): Promise<ScanSummary> {
  const source = requireSource(sourceId);
  if (scanning.has(sourceId)) throw new Error('该源正在扫描中');
  if (source.config.scanScope?.mode === 'pending') throw new Error('请先设置该存储源的扫描范围');
  const provider = providerFor(source);
  const ac = new AbortController();
  scanning.set(sourceId, ac);

  const onProgress = (p: ScanProgress) => broadcast(IPC.evScan, p);
  log('[scan] 开始', source.name, `(${source.kind})`, 'root=', String((source.config as { root?: unknown }).root ?? ''));
  try {
    const summary = await scanSource({
      source,
      provider,
      repo,
      ignorePatterns: settings.ignorePatterns,
      onProgress,
      signal: ac.signal,
    });
    log('[scan] 完成', source.name, 'found=', summary.found, 'added=', summary.added, 'error=', summary.error ?? '无');
    if (summary.found === 0 && !summary.error) {
      log('[scan] 注意：遍历完成但一个媒体文件都没找到——检查网盘目录是否为空、扩展名是否在支持列表内');
    }
    const current = repo.getSource(sourceId);
    if (current) {
      repo.updateSource({
        ...current,
        lastScanAt: Date.now(),
        lastScanCount: summary.found,
        lastError: summary.error,
      });
    }
    broadcast(IPC.evLibrary, { reason: 'scan-done', sourceId, summary });
    if (current && !summary.error && !ac.signal.aborted) tmdbSync.enqueue(sourceId);
    return summary;
  } finally {
    scanning.delete(sourceId);
  }
}

/* ----------------------------- 播放 ----------------------------- */

function isVideo(item: MediaItem): boolean {
  return VIDEO_EXTS.has(item.ext);
}

async function findSubtitles(
  provider: StorageProvider,
  item: MediaItem,
  sourceKind: SourceKind,
): Promise<string[]> {
  const local = sourceKind === 'local';
  const stem = item.name.replace(/\.[^.]+$/, '');
  const wanted = new Set<string>();
  for (const ext of SUBTITLE_EXTS) {
    for (const suffix of ['', '.chs', '.cht', '.zh', '.zh-CN', '.sc', '.tc', '.zh-Hans', '.zh-Hant', '.default', '.简体', '.繁体']) {
      wanted.add(`${stem}${suffix}.${ext}`);
    }
  }
  const dir = local ? dirname(item.path) : parentOf(item.path);
  if (!dir) return [];
  try {
    const entries = await provider.list(dir);
    const hits = entries
      .filter((e) => !e.isDir && wanted.has(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const out: string[] = [];
    for (const hit of hits.slice(0, 6)) {
      try {
        const resolved = await provider.resolvePlayUrl(hit.path);
        // mpv 的 sub-add 不接受自定义请求头，远端字幕只能把 URL 带上（含 basic 凭据的服务需注意）
        out.push(Object.keys(resolved.headers).length === 0 ? resolved.url : resolved.url);
      } catch {
        /* 单条字幕解析失败忽略 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

let saveTimer: NodeJS.Timeout | null = null;

function savePlaybackProgress(): void {
  const state = controller?.getState();
  if (!state?.itemId || state.duration <= 0) return;
  const item = repo.getItem(state.itemId);
  if (!item) return;
  repo.savePlayback({
    itemId: state.itemId,
    seriesKey: item.seriesKey,
    position: state.position,
    finished: state.status === 'ended' || state.position / state.duration > 0.95,
    duration: state.duration,
    updatedAt: Date.now(),
  });
}

function scheduleSaveProgress(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    savePlaybackProgress();
  }, 4000);
}

function syncVideoSurface(state = controller?.getState()): void {
  if (videoBounds && state?.itemId && (state.status === 'playing' || state.status === 'paused')) {
    videoSurface?.show(videoBounds);
  } else {
    videoSurface?.hide();
  }
}

async function runPlayerCommand(payload: { command: string; value?: number | string }): Promise<{ handled: boolean }> {
  if (!controller) return { handled: false };
  switch (payload.command) {
    case 'toggle-pause':
      await controller.togglePause();
      break;
    case 'seek':
      await controller.seek(Number(payload.value ?? 0));
      break;
    case 'seek-relative':
      await controller.seek(Number(payload.value ?? 0), 'relative');
      break;
    case 'volume':
      await controller.setVolume(Number(payload.value ?? 100));
      break;
    case 'volume-relative': {
      const delta = Number(payload.value);
      if (Number.isFinite(delta)) await controller.adjustVolume(delta);
      break;
    }
    case 'mute':
      await controller.toggleMute();
      break;
    case 'speed':
      await controller.setSpeed(Number(payload.value ?? 1));
      break;
    case 'audio':
      await controller.setAudio(Number(payload.value ?? 0));
      break;
    case 'subtitle':
      await controller.setSubtitle(Number(payload.value ?? 0));
      break;
    case 'fullscreen':
    case 'exit-fullscreen': {
      const exit = payload.command === 'exit-fullscreen';
      if (videoSurface && win && controller.getState().itemId) {
        win.setFullScreen(!exit && !win.isFullScreen());
      } else if (!videoSurface && (!exit || controller.getState().fullscreen)) {
        await controller.toggleFullscreen();
      }
      break;
    }
    default:
      return { handled: false };
  }
  return { handled: true };
}

async function ensureController(): Promise<MpvController> {
  if (controller) return controller;
  if (!mpvPath) throw new Error('未找到 mpv，无法内嵌播放。请在设置中指定 mpv.exe 路径，或改用外部播放器。');
  if (process.platform === 'win32' && !videoSurface) {
    const { WindowsVideoSurface } = await import('./player/windows-video-surface');
    if (!win || win.isDestroyed()) throw new Error('播放窗口已关闭');
    if (controller) return controller;
    const surfaceWindow = win;
    videoSurface ??= new WindowsVideoSurface(surfaceWindow.getNativeWindowHandle(), (code) => {
      if (win !== surfaceWindow || !videoBounds || surfaceWindow.isDestroyed()) return;
      if (code === 'click') surfaceWindow.webContents.focus();
      controller?.handleEmbeddedInput(code);
    });
  }
  const c = new MpvController({
    mpvPath,
    hardwareDecode: settings.hardwareDecode,
    wid: videoSurface?.wid,
    extraArgs: splitArgs(settings.player?.builtinArgs ?? ''),
  });
  c.on('state', (state: PlayerState) => {
    if (controller !== c) return;
    syncVideoSurface(state);
    broadcast(IPC.evPlayer, state);
    scheduleSaveProgress();
  });
  c.on('finished', () => scheduleSaveProgress());
  c.on('shortcut', (shortcut: Pick<PlaybackShortcut, 'command' | 'value'>) => {
    if (controller !== c || !videoBounds) return;
    void runPlayerCommand(shortcut);
  });
  controller = c;
  return c;
}

type PlayResult = { mode: 'mpv' | 'external' | 'cancelled'; message: string };
const CANCELLED_PLAY: PlayResult = { mode: 'cancelled', message: '' };

async function playWithBuiltin(
  provider: StorageProvider,
  item: MediaItem,
  sourceKind: SourceKind,
  resolved: { url: string; headers: Record<string, string> },
  startAt: number,
  request: number,
): Promise<PlayResult> {
  const subtitles = await findSubtitles(provider, item, sourceKind);
  return runPlaybackWork(async () => {
    if (request !== playRequest) return CANCELLED_PLAY;
    const current = await ensureController();
    if (request !== playRequest) return CANCELLED_PLAY;
    savePlaybackProgress();
    await current.play({
      itemId: item.id,
      url: resolved.url,
      headers: resolved.headers,
      title: item.seriesTitle ? [item.seriesTitle, fmtEpisode(item)].filter(Boolean).join(' ') : item.title,
      startAt,
      subtitles,
    });
    return request === playRequest ? { mode: 'mpv', message: '使用内置 mpv 播放' } : CANCELLED_PLAY;
  });
}

/** 交给外部播放器；配置为「系统默认程序」时 cmd 为 null */
async function playWithExternal(
  item: MediaItem,
  resolved: { url: string; headers: Record<string, string> },
  startAt: number,
): Promise<string> {
  const plan = resolveExternalLaunch(settings.player, detectExternalPlayers(), {
    url: resolved.url,
    title: item.seriesTitle ?? item.title,
    start: startAt,
  });
  if (!plan.ok) throw new Error(plan.error);
  if (plan.launch.cmd === null) {
    await shell.openPath(resolved.url);
    return '已用系统默认程序打开';
  }
  const { spawn } = await import('node:child_process');
  spawn(plan.launch.cmd, plan.launch.args, { detached: true, stdio: 'ignore' }).unref();
  return `已交给外部播放器：${plan.launch.cmd}`;
}

async function handlePlay(itemId: string): Promise<PlayResult> {
  const request = ++playRequest;
  const item = requireItem(itemId);
  const source = requireSource(item.sourceId);
  const provider = providerFor(source);
  const resolved = await provider.resolvePlayUrl(item.path);
  if (request !== playRequest) return CANCELLED_PLAY;
  const record = repo.getPlayback(item.id);
  const startAt = record && !record.finished && record.position > 5 ? record.position : 0;

  const engine = settings.player?.engine ?? 'auto';

  // 音频/图片不进 mpv 的播放流程，始终交给外部程序
  if (!isVideo(item)) {
    if (AUDIO_EXTS.has(item.ext) || IMAGE_EXTS.has(item.ext)) {
      return { mode: 'external', message: await playWithExternal(item, resolved, startAt) };
    }
    throw new Error(`不支持的媒体类型：.${item.ext}`);
  }

  if (engine === 'builtin') {
    if (!mpvPath) {
      throw new Error(
        '播放方式设为「仅内置 mpv」，但没找到 mpv。请在设置里指定 mpv.exe 路径，或把播放方式改成「外部播放器」/「自动」。',
      );
    }
    return playWithBuiltin(provider, item, source.kind, resolved, startAt, request);
  }

  if (engine === 'external') {
    return { mode: 'external', message: await playWithExternal(item, resolved, startAt) };
  }

  // auto：内置优先，不可用再回落外部
  if (mpvPath) {
    return playWithBuiltin(provider, item, source.kind, resolved, startAt, request);
  }
  return { mode: 'external', message: `未找到 mpv，${await playWithExternal(item, resolved, startAt)}` };
}

function fmtEpisode(item: MediaItem): string {
  if (item.episode === null) return '';
  const s = item.season !== null ? `S${String(item.season).padStart(2, '0')}` : '';
  const e = `E${String(item.episode).padStart(2, '0')}`;
  const end = item.episodeEnd !== null && item.episodeEnd !== item.episode ? `-E${String(item.episodeEnd).padStart(2, '0')}` : '';
  return `${s}${e}${end}`;
}

/* ----------------------------- 窗口 ----------------------------- */

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#090c14',
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#090c14', symbolColor: '#bbcbe3', height: 36 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  win.once('ready-to-show', () => {
    win?.show();
    log('[window] ready-to-show');
  });
  win.on('enter-full-screen', () => controller?.setEmbeddedFullscreen(true));
  win.on('leave-full-screen', () => controller?.setEmbeddedFullscreen(false));
  win.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    videoBounds = null;
    videoSurface?.hide();
  });
  win.webContents.on('render-process-gone', () => {
    videoBounds = null;
    videoSurface?.hide();
  });
  win.on('closed', () => {
    log('[window] closed');
    win = null;
    videoBounds = null;
    videoSurface = null;
    controller?.dispose();
    controller = null;
  });

  // 渲染层错误默认只留在 DevTools 里，打包后等于不可见；接到主进程日志才能诊断白屏
  win.webContents.on('did-finish-load', () => log('[renderer] 页面加载完成'));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] 加载失败 code=${code} ${desc} url=${url}`);
  });
  win.webContents.on('console-message', (...args: unknown[]) => {
    // Electron 45 起为事件对象形式，旧版为 (event, level, message, line, sourceId)
    const first = args[0] as { level?: unknown; message?: unknown; lineNumber?: unknown; sourceId?: unknown } | undefined;
    if (first && typeof first === 'object' && 'message' in first) {
      console.log(`[renderer:${String(first.level)}] ${String(first.message)} (${String(first.sourceId)}:${String(first.lineNumber)})`);
      return;
    }
    console.log(`[renderer] ${args.slice(1).map(String).join(' ')}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    log('[crash] render-process-gone', details.reason, details.exitCode);
  });
  win.webContents.on('preload-error', (_e, path, err) => {
    console.error(`[preload] 加载失败 ${path}: ${err.message}`);
  });

  // 调试能力（已文档化，不属于临时探针）：
  //   NEBULA_CAPTURE=<png路径>            加载后截图
  //   NEBULA_CAPTURE_VIEW=<导航文字>     截图前先切到该页面（如「设置」）
  // 用途：打包后的 GUI 没有 DevTools，这是确认 UI 真实渲染的唯一可靠途径。
  const captureTarget = process.env['NEBULA_CAPTURE'];
  if (captureTarget) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        const view = process.env['NEBULA_CAPTURE_VIEW'];
        // 支持逗号分隔的多步点击：先按文本找可点元素逐个点，再截图。
        // 例：NEBULA_CAPTURE_VIEW="添加存储源,阿里云盘,生成二维码"
        const steps = (view ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const clickStep = async (text: string): Promise<void> => {
          if (!win) return;
          await win.webContents
            .executeJavaScript(
              `(() => {
                const nodes = [...document.querySelectorAll('button, [role="button"], label, .nav__item, .tab')];
                const T = ${JSON.stringify('__TEXT__')};
                // 精确匹配优先：否则「存储源」会被「+ 添加存储源」按钮抢走
                const exact = nodes.find((el) => el.textContent && el.textContent.trim() === T);
                if (exact) { exact.click(); return true; }
                // 其次取最短的包含项（最贴近目标，避免命中包裹性容器）
                const partial = nodes
                  .filter((el) => el.textContent && el.textContent.includes(T))
                  .sort((a, b) => a.textContent.trim().length - b.textContent.trim().length);
                if (partial.length > 0) { partial[0].click(); return true; }
                return false;
              })()`.replace(JSON.stringify('__TEXT__'), JSON.stringify(text)),
            )
            .catch(() => false);
          await new Promise((r) => setTimeout(r, 450));
        };
        const switchView = (async () => {
          for (const text of steps) await clickStep(text);
          return steps.length > 0;
        })();
        void switchView.then(() => {
          // 有些区块在滚动容器底部，截图前先滚到底，否则截不到
          void win?.webContents
            .executeJavaScript(
              `(() => {
                document.querySelectorAll('.panel, .main, main, body').forEach((el) => {
                  if (el && typeof el.scrollTop === 'number') el.scrollTop = el.scrollHeight;
                });
                return true;
              })()`,
            )
            .catch(() => false);
          setTimeout(() => {
            void win?.webContents
              .capturePage()
              .then((img) => {
                writeFileSync(captureTarget, img.toPNG());
                log('[ui] 截图已保存', captureTarget);
              })
              .catch((err: unknown) => log('[ui] 截图失败', err));
          }, 700);
        });
      }, 2200);
    });
  }


  const devUrl = process.env['VITE_DEV_SERVER_URL'];
  if (startupError) {
    if (devUrl) {
      const url = new URL(devUrl);
      url.searchParams.set('startupError', startupError);
      void win.loadURL(url.toString());
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { startupError } });
    }
  } else if (devUrl) {
    void win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ----------------------------- IPC ----------------------------- */

function registerIpc(): void {
  handle(IPC.appInfo, () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    userData: app.getPath('userData'),
    dbPath: join(app.getPath('userData'), 'nebula.db'),
    mpvPath,
  }));

  handle(IPC.settingsGet, () => settings);

  handle(IPC.settingsUpdate, async (patch: Partial<AppSettings>) => {
    if (Object.hasOwn(patch, TMDB_CREDENTIAL_KEY)) throw new Error('请在 TMDB 设置中更新凭据。');
    settings = { ...settings, ...patch };
    for (const [k, v] of Object.entries(patch)) repo.setSetting(k, v);
    if (patch.mpvPath !== undefined || patch.hardwareDecode !== undefined || patch.player !== undefined) {
      const located = await locateMpv(settings.mpvPath);
      mpvPath = located.path;
      // mpv 路径、硬解或内置参数变化后旧进程参数已失效，销毁让下次播放按新配置重建
      if (videoSurface && win?.isFullScreen()) win.setFullScreen(false);
      videoSurface?.hide();
      await controller?.stop();
      controller = null;
    }
    return settings;
  });

  const tmdbStatus = (): TmdbStatus => ({ configured: Boolean(tmdbCredential), sync: tmdbSync.status });
  handle(IPC.tmdbStatus, tmdbStatus);
  handle(IPC.tmdbConfigure, async (payload: { credential: string | null }) => {
    if (checkingTmdbCredential) throw new Error('正在验证 TMDB 凭据，请稍候。');
    if (payload.credential !== null && typeof payload.credential !== 'string') throw new Error('请填写 TMDB 凭据。');
    const credential = payload.credential === null ? '' : normalizeTmdbCredential(payload.credential);
    checkingTmdbCredential = true;
    try {
      if (credential) await createTmdbClient(credential, electronFetch).test();
      repo.setSetting(TMDB_CREDENTIAL_KEY, encryptSecret(credential));
      if (credential !== tmdbCredential) tmdbSync.cancel();
      tmdbCredential = credential;
      return tmdbStatus();
    } finally {
      checkingTmdbCredential = false;
    }
  });
  handle(IPC.tmdbSyncStart, () => {
    if (!tmdbCredential) throw new Error('请先保存 TMDB 凭据。');
    tmdbSync.enqueue();
    return tmdbStatus();
  });
  handle(IPC.tmdbSyncCancel, () => tmdbSync.cancel());

  handle(IPC.mpvLocate, async () => {
    const located = await locateMpv(settings.mpvPath);
    mpvPath = located.path;
    return located;
  });

  handle(IPC.playersDetect, async () => {
    const mpv = await locateMpv(settings.mpvPath);
    mpvPath = mpv.path;
    return { mpv, external: detectExternalPlayers(), player: settings.player };
  });

  // 只做「能否解析到可执行文件」的校验，不真的开播放器：测试按钮不应该弹窗
  handle(IPC.playersTest, async () => {
    const engine = settings.player?.engine ?? 'auto';
    const mpv = await locateMpv(settings.mpvPath);
    mpvPath = mpv.path;
    if (engine === 'builtin' || (engine === 'auto' && mpv.path)) {
      return mpv.path
        ? { ok: true, message: `内置 mpv 可用：${mpv.path}` }
        : { ok: false, message: mpv.message };
    }
    const plan = resolveExternalLaunch(settings.player, detectExternalPlayers(), { url: 'sample.mp4' });
    if (!plan.ok) return { ok: false, message: plan.error };
    return {
      ok: true,
      message: plan.launch.cmd
        ? `外部播放器可用：${plan.launch.cmd}，参数 ${JSON.stringify(plan.launch.args)}`
        : '将交给系统默认程序打开',
    };
  });

  const aliyunQr = createAliyunQrLogin(repo);
  handle(IPC.aliyunQrStart, () => aliyunQr.start());
  handle(IPC.aliyunQrPoll, async (payload: { sessionId: string; name?: string; driveId?: string }) => {
    const result = await aliyunQr.poll(payload);
    if (result.status === 'CONFIRMED') {
      broadcast(IPC.evLibrary, { reason: 'source-added', sourceId: result.source.id });
    }
    return result;
  });

  handle(IPC.updateCheck, async () => checkForUpdate(app.getVersion()));

  handle(IPC.updateOpenRelease, async (payload: { url?: string }) => {
    const url = payload?.url;
    if (!url) throw new Error('没有可打开的发布页地址');
    // 只允许打开本仓库的发布页，避免被拼成任意外链
    if (!url.startsWith(`https://github.com/${UPDATE_REPO}`)) {
      throw new Error(`拒绝打开非本项目地址：${url}`);
    }
    await shell.openExternal(url);
    return { opened: true };
  });

  handle(IPC.localPaths, (payload: { mode: LocalPathMode; path?: string }) =>
    listLocalPaths(app.getPath('home'), payload.mode, payload.path));

  handle(IPC.sourcesList, () => repo.listSources());

  handle(IPC.sourcesCreate, async (payload: { kind: SourceKind; name: string; config: SourceConfig }) => {
    const config: SourceConfig = { ...payload.config, scanScope: { mode: 'pending' } };
    if (config.kind === 'webdav') config.password = encryptSecret(config.password);
    const source: StorageSource = {
      id: newSourceId(),
      kind: payload.kind,
      name: payload.name || payload.kind,
      config,
      enabled: true,
      lastScanAt: null,
      lastScanCount: 0,
      lastError: null,
      createdAt: Date.now(),
    };
    if (config.kind === 'webdav') {
      const result = await providerFor(source).test();
      if (!result.ok) throw new Error(result.message);
    }
    repo.insertSource(source);
    return source;
  });

  handle(IPC.sourcesUpdate, (payload: { id: string; name?: string; config?: SourceConfig; enabled?: boolean }) => {
    const source = requireSource(payload.id);
    if (payload.config) {
      aliyunProviders.delete(source.id);
      const config = { ...payload.config } as SourceConfig;
      // 已加密的密码原样保留，明文才重新加密
      if (config.kind === 'webdav' && !config.password.startsWith('enc:v1:') && !config.password.startsWith('obf:v1:')) {
        config.password = encryptSecret(config.password);
      }
      source.config = config;
    }
    if (payload.name !== undefined) source.name = payload.name;
    if (payload.enabled !== undefined) source.enabled = payload.enabled;
    repo.updateSource(source);
    return source;
  });

  handle(IPC.sourcesRemove, (payload: { id: string }) => {
    aliyunProviders.delete(payload.id);
    repo.deleteSource(payload.id);
    return { removed: payload.id };
  });

  handle(IPC.sourcesTest, async (payload: { id: string }) => {
    const source = requireSource(payload.id);
    const provider = providerFor(source);
    return provider.test();
  });

  handle(IPC.browseList, async (payload: { sourceId: string; parentId?: string }) => {
    const source = requireSource(payload.sourceId);
    return listSourceDirectory(source, providerFor(source), payload.parentId);
  });

  handle(IPC.sourcesScanScope, async (payload: { sourceId: string; scope: ScanScope }) => {
    if (scanning.has(payload.sourceId)) throw new Error('请先结束该源正在进行的扫描');
    const source = requireSource(payload.sourceId);
    const scope = await validateScanScope(source, providerFor(source), payload.scope);
    if (scanning.has(payload.sourceId)) throw new Error('请先结束该源正在进行的扫描');
    const current = requireSource(payload.sourceId);
    const location = (config: SourceConfig) => config.kind === 'local' ? config.roots : config.root;
    if (current.config.kind !== source.config.kind ||
        JSON.stringify(location(current.config)) !== JSON.stringify(location(source.config)) ||
        JSON.stringify(current.config.scanScope) !== JSON.stringify(source.config.scanScope)) {
      throw new Error('扫描范围已更改，请重新打开设置');
    }
    current.config = { ...current.config, scanScope: scope };
    repo.updateSource(current);
    return current;
  });

  handle(IPC.scanStart, async (payload: { sourceId?: string }) => {
    const targets = payload.sourceId
      ? [payload.sourceId]
      : repo.listSources().filter((s) => s.enabled && s.config.scanScope?.mode !== 'pending').map((s) => s.id);
    const summaries: ScanSummary[] = [];
    for (const id of targets) {
      summaries.push(await runScan(id));
    }
    return summaries;
  });

  handle(IPC.scanCancel, (payload: { sourceId: string }) => {
    const ac = scanning.get(payload.sourceId);
    if (!ac) return { cancelled: false };
    ac.abort();
    return { cancelled: true };
  });

  handle(IPC.libraryBrowse, (q: BrowseQuery) => repo.browse(q ?? {}));
  handle(IPC.librarySeries, (payload: { key: string }) => repo.getSeries(payload.key));
  handle(IPC.librarySections, () => repo.sectionCounts());
  handle(IPC.libraryContinue, (payload: { limit?: number }) => repo.continueWatching(payload?.limit ?? 12));
  handle(IPC.libraryItem, (payload: { id: string }) => repo.getItem(payload.id));
  handle(IPC.libraryArtwork, (payload: { id: string }) => libraryArtwork(payload.id));
  handle(IPC.libraryGenresUpdate, (payload: { workKey: string; genres: Genre[] | null }) => {
    if (payload.genres !== null && !Array.isArray(payload.genres)) throw new Error('题材格式无效');
    repo.updateWorkGenres(payload.workKey, payload.genres);
    return { saved: true };
  });

  ipcMain.handle(IPC.playSurface, (event, bounds: VideoSurfaceBounds | null) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return;
    if (bounds !== null && (!bounds || typeof bounds !== 'object' ||
        ![bounds.x, bounds.y, bounds.width, bounds.height, bounds.scale].every(Number.isFinite) ||
        bounds.width <= 0 || bounds.height <= 0 || bounds.scale <= 0)) return;
    videoBounds = bounds;
    syncVideoSurface();
  });

  handle(IPC.playItem, (payload: { itemId: string }) => handlePlay(payload.itemId));

  handle(IPC.playCommand, runPlayerCommand);

  handle(IPC.playStop, async () => {
    ++playRequest;
    videoBounds = null;
    videoSurface?.hide();
    if (videoSurface && win?.isFullScreen()) win.setFullScreen(false);
    await runPlaybackWork(async () => {
      savePlaybackProgress();
      await controller?.stop();
    });
    return { stopped: true };
  });
}

/* ----------------------------- 启动 ----------------------------- */

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData');
  mkdirSync(userData, { recursive: true });
  repo = createRepository(join(userData, 'nebula.db'));
  settings = loadSettings();
  const storedTmdbCredential = repo.getSetting(TMDB_CREDENTIAL_KEY);
  if (typeof storedTmdbCredential === 'string') tmdbCredential = decryptSecret(storedTmdbCredential);
  tmdbSync = new TmdbSync(repo, () => tmdbCredential, electronFetch, (status) => {
    broadcast(IPC.evTmdbSync, status);
    if (status.phase !== 'running' && status.matched > 0) broadcast(IPC.evLibrary, { reason: 'tmdb-sync' });
  });
  mkdirSync(settings.cacheDir, { recursive: true });

  const located = await locateMpv(settings.mpvPath);
  mpvPath = located.path;
  log('[nebula] mpv:', located.message);

  registerIpc();
  createWindow();
  log('[nebula] bootstrap 完成');
}

try {
  const logPath = initLogger(join(app.getPath('userData'), 'logs'));
  log('[boot] 启动', { electron: process.versions.electron, node: process.versions.node, logPath });
} catch (err) {
  console.error('[boot] 日志初始化失败', err);
}

if (!app.requestSingleInstanceLock()) {
  log('[boot] 未获取单实例锁（已有实例在运行），退出');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  Menu.setApplicationMenu(null);

  void app.whenReady().then(bootstrap).catch((err) => {
    log('[nebula] 启动失败', err);
    startupError = err instanceof Error ? err.message : String(err);
    createWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on('window-all-closed', () => {
  log('[app] window-all-closed → 退出');
  if (process.platform !== 'darwin') app.quit();
});

// 关键诊断：GPU / 渲染 / utility 子进程崩溃会让窗口消失，进而连带整个应用退出
app.on('child-process-gone', (_event, details) => {
  log('[crash] child-process-gone', {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: (details as { serviceName?: string }).serviceName ?? null,
  });
});

process.on('uncaughtException', (err) => {
  log('[crash] uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  log('[crash] unhandledRejection', reason);
});

app.on('before-quit', () => {
  tmdbSync?.cancel();
  controller?.dispose();
  repo?.close();
});
