import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { initLogger, log } from './logger';
import { IPC, type Rpc } from '../shared/ipc-contract';
import type {
  AppSettings,
  BrowseQuery,
  MediaItem,
  ScanProgress,
  ScanSummary,
  SourceConfig,
  SourceKind,
  StorageSource,
} from '../shared/types';
import { createRepository, type Repository } from './db';
import { sourceId as newSourceId } from './db/ids';
import { createProvider } from './sources/registry';
import { encryptSecret } from './sources/secrets';
import { parentOf, type StorageProvider } from './sources/types';
import { scanSource } from './scan/scanner';
import { AUDIO_EXTS, IMAGE_EXTS, SUBTITLE_EXTS, VIDEO_EXTS } from './scan/namer';
import { locateMpv, resolveExternalCommand } from './player/locate';
import { MpvController } from './player/mpv';

let win: BrowserWindow | null = null;
let repo: Repository;
let settings: AppSettings;
let controller: MpvController | null = null;
let mpvPath: string | null = null;
const scanning = new Map<string, AbortController>();

const DEFAULT_SETTINGS: AppSettings = {
  mpvPath: null,
  externalPlayer: null,
  preferredMode: 'embedded',
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

function loadSettings(): AppSettings {
  const stored = repo.getAllSettings();
  return { ...DEFAULT_SETTINGS, ...stored, cacheDir: stored.cacheDir || join(app.getPath('userData'), 'cache') };
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

/* ----------------------------- 扫描 ----------------------------- */

async function runScan(sourceId: string): Promise<ScanSummary> {
  const source = requireSource(sourceId);
  if (scanning.has(sourceId)) throw new Error('该源正在扫描中');
  const provider = createProvider(source);
  const ac = new AbortController();
  scanning.set(sourceId, ac);

  const onProgress = (p: ScanProgress) => broadcast(IPC.evScan, p);
  try {
    const summary = await scanSource({
      source,
      provider,
      repo,
      ignorePatterns: settings.ignorePatterns,
      onProgress,
      signal: ac.signal,
    });
    const updated: StorageSource = {
      ...source,
      lastScanAt: Date.now(),
      lastScanCount: summary.found,
      lastError: summary.error,
    };
    repo.updateSource(updated);
    broadcast(IPC.evLibrary, { reason: 'scan-done', sourceId, summary });
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

function scheduleSaveProgress(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const st = controller?.getState();
    if (!st || !st.itemId || st.duration <= 0) return;
    const item = repo.getItem(st.itemId);
    if (!item) return;
    const finished = st.status === 'ended' || (st.duration > 0 && st.position / st.duration > 0.95);
    repo.savePlayback({
      itemId: st.itemId,
      seriesKey: item.seriesKey,
      position: st.position,
      duration: st.duration,
      finished,
      updatedAt: Date.now(),
    });
  }, 4000);
}

async function ensureController(): Promise<MpvController> {
  if (controller) return controller;
  if (!mpvPath) throw new Error('未找到 mpv，无法内嵌播放。请在设置中指定 mpv.exe 路径，或改用外部播放器。');
  const c = new MpvController({
    mpvPath,
    hardwareDecode: settings.hardwareDecode,
    wid: null,
  });
  c.on('state', (state: unknown) => {
    broadcast(IPC.evPlayer, state);
    scheduleSaveProgress();
  });
  c.on('finished', () => scheduleSaveProgress());
  controller = c;
  return c;
}

async function handlePlay(itemId: string): Promise<{ mode: 'mpv' | 'external'; message: string }> {
  const item = requireItem(itemId);
  const source = requireSource(item.sourceId);
  const provider = createProvider(source);
  const resolved = await provider.resolvePlayUrl(item.path);
  const record = repo.getPlayback(item.id);
  const startAt = record && !record.finished && record.position > 5 ? record.position : 0;

  if (!isVideo(item)) {
    if (AUDIO_EXTS.has(item.ext) || IMAGE_EXTS.has(item.ext)) {
      const ext = resolveExternalCommand(settings.externalPlayer);
      if (ext) {
        const { spawn } = await import('node:child_process');
        spawn(ext.cmd, ext.args(resolved.url), { detached: true, stdio: 'ignore' }).unref();
        return { mode: 'external', message: '已交给外部播放器' };
      }
      await shell.openPath(resolved.url);
      return { mode: 'external', message: '已用系统默认程序打开' };
    }
    throw new Error(`不支持的媒体类型：.${item.ext}`);
  }

  if (!mpvPath) {
    const ext = resolveExternalCommand(settings.externalPlayer);
    if (ext) {
      const { spawn } = await import('node:child_process');
      spawn(ext.cmd, ext.args(resolved.url), { detached: true, stdio: 'ignore' }).unref();
      return { mode: 'external', message: '未找到 mpv，已交给配置的外部播放器' };
    }
    await shell.openPath(resolved.url);
    return { mode: 'external', message: '未找到 mpv，已用系统默认播放器打开' };
  }

  const c = await ensureController();
  const subtitles = await findSubtitles(provider, item, source.kind);
  await c.play({
    itemId: item.id,
    url: resolved.url,
    headers: resolved.headers,
    title: item.seriesTitle ? `${item.seriesTitle} ${fmtEpisode(item)}`.trim() : item.title,
    startAt,
    subtitles,
  });
  return { mode: 'mpv', message: '使用 mpv 播放' };
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
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0a0d14',
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0a0d14', symbolColor: '#9aa6b8', height: 36 },
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
  win.on('closed', () => {
    log('[window] closed');
    win = null;
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


  const devUrl = process.env['VITE_DEV_SERVER_URL'];
  if (devUrl) {
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
    settings = { ...settings, ...patch };
    for (const [k, v] of Object.entries(patch)) repo.setSetting(k, v);
    if (patch.mpvPath !== undefined || patch.hardwareDecode !== undefined) {
      const located = await locateMpv(settings.mpvPath);
      mpvPath = located.path;
      // mpv 路径或硬解设置变化后旧进程参数已失效，销毁让下次播放按新配置重建
      controller?.dispose();
      controller = null;
    }
    return settings;
  });

  handle(IPC.mpvLocate, async () => {
    const located = await locateMpv(settings.mpvPath);
    mpvPath = located.path;
    return located;
  });

  handle(IPC.pickDirectory, async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'multiSelections'],
      title: '选择媒体目录',
    });
    return res.canceled ? [] : res.filePaths;
  });

  handle(IPC.sourcesList, () => repo.listSources());

  handle(IPC.sourcesCreate, (payload: { kind: SourceKind; name: string; config: SourceConfig }) => {
    const config = { ...payload.config } as SourceConfig;
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
    repo.insertSource(source);
    return source;
  });

  handle(IPC.sourcesUpdate, (payload: { id: string; name?: string; config?: SourceConfig; enabled?: boolean }) => {
    const source = requireSource(payload.id);
    if (payload.config) {
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
    repo.deleteSource(payload.id);
    return { removed: payload.id };
  });

  handle(IPC.sourcesTest, async (payload: { id: string }) => {
    const source = requireSource(payload.id);
    const provider = createProvider(source);
    return provider.test();
  });

  handle(IPC.scanStart, async (payload: { sourceId?: string }) => {
    const targets = payload.sourceId
      ? [payload.sourceId]
      : repo.listSources().filter((s) => s.enabled).map((s) => s.id);
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

  handle(IPC.playItem, (payload: { itemId: string }) => handlePlay(payload.itemId));

  handle(
    IPC.playCommand,
    async (payload: { command: string; value?: number | string }) => {
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
          await controller.toggleFullscreen();
          break;
        default:
          return { handled: false };
      }
      return { handled: true };
    },
  );

  handle(IPC.playStop, async () => {
    await controller?.stop();
    return { stopped: true };
  });
}

/* ----------------------------- 启动 ----------------------------- */

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData');
  mkdirSync(userData, { recursive: true });
  repo = createRepository(join(userData, 'nebula.db'));
  settings = loadSettings();
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
    dialog.showErrorBox('启动失败', err instanceof Error ? err.message : String(err));
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on('window-all-closed', () => {
  log('[app] window-all-closed → 退出');
  controller?.dispose();
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
  controller?.dispose();
  repo?.close();
});
