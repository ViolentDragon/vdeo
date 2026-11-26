import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { initLogger, log } from './logger';
import { IPC, type Rpc } from '../shared/ipc-contract';
import { DEFAULT_PLAYER_CONFIG } from '../shared/types';
import type {
  AliyunSourceConfig,
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
import { checkForUpdate, UPDATE_REPO } from './updater';
import { createProvider } from './sources/registry';
import { getDriveInfo, listBizExtKeys, pollQrLogin, refreshToken, startQrLogin, type AliyunToken, type DriveInfo, type QrSession } from './sources/aliyun-auth';
import { encryptSecret } from './sources/secrets';
import { parentOf, type StorageProvider } from './sources/types';
import { scanSource } from './scan/scanner';
import { AUDIO_EXTS, IMAGE_EXTS, SUBTITLE_EXTS, VIDEO_EXTS } from './scan/namer';
import { locateMpv } from './player/locate';
import { detectExternalPlayers, migrateLegacyCommand, resolveExternalLaunch, splitArgs } from './player/external';
import { MpvController } from './player/mpv';

let win: BrowserWindow | null = null;
let repo: Repository;
let settings: AppSettings;
let controller: MpvController | null = null;
let mpvPath: string | null = null;
const scanning = new Map<string, AbortController>();
const qrSessions = new Map<string, QrSession>();

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

/** 统一的 provider 工厂：阿里云盘 token 轮换后必须写回数据库，否则重启即失效 */
function providerFor(source: StorageSource): ReturnType<typeof createProvider> {
  return createProvider(source, {
    onAliyunTokenRefreshed: (sourceId, token) => {
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
}

/* ----------------------------- 扫描 ----------------------------- */

async function runScan(sourceId: string): Promise<ScanSummary> {
  const source = requireSource(sourceId);
  if (scanning.has(sourceId)) throw new Error('该源正在扫描中');
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
    extraArgs: splitArgs(settings.player?.builtinArgs ?? ''),
  });
  c.on('state', (state: unknown) => {
    broadcast(IPC.evPlayer, state);
    scheduleSaveProgress();
  });
  c.on('finished', () => scheduleSaveProgress());
  controller = c;
  return c;
}

async function playWithBuiltin(
  provider: StorageProvider,
  item: MediaItem,
  sourceKind: SourceKind,
  resolved: { url: string; headers: Record<string, string> },
  startAt: number,
): Promise<string> {
  const c = await ensureController();
  const subtitles = await findSubtitles(provider, item, sourceKind);
  await c.play({
    itemId: item.id,
    url: resolved.url,
    headers: resolved.headers,
    title: item.seriesTitle ? `${item.seriesTitle} ${fmtEpisode(item)}`.trim() : item.title,
    startAt,
    subtitles,
  });
  return '使用内置 mpv 播放';
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

async function handlePlay(itemId: string): Promise<{ mode: 'mpv' | 'external'; message: string }> {
  const item = requireItem(itemId);
  const source = requireSource(item.sourceId);
  const provider = providerFor(source);
  const resolved = await provider.resolvePlayUrl(item.path);
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
    return { mode: 'mpv', message: await playWithBuiltin(provider, item, source.kind, resolved, startAt) };
  }

  if (engine === 'external') {
    return { mode: 'external', message: await playWithExternal(item, resolved, startAt) };
  }

  // auto：内置优先，不可用再回落外部
  if (mpvPath) {
    return { mode: 'mpv', message: await playWithBuiltin(provider, item, source.kind, resolved, startAt) };
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
                const hit = nodes.find((el) => el.textContent && el.textContent.includes(${JSON.stringify('__TEXT__')}));
                if (hit) { hit.click(); return true; }
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
    if (patch.mpvPath !== undefined || patch.hardwareDecode !== undefined || patch.player !== undefined) {
      const located = await locateMpv(settings.mpvPath);
      mpvPath = located.path;
      // mpv 路径、硬解或内置参数变化后旧进程参数已失效，销毁让下次播放按新配置重建
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

  handle(IPC.aliyunQrStart, async () => {
    // 顺手清理过期会话，避免长期驻留
    for (const [id, s] of qrSessions) {
      if (Date.now() - s.createdAt > 3 * 60_000) qrSessions.delete(id);
    }
    const session = await startQrLogin();
    qrSessions.set(session.id, session);
    log('[aliyun] 已生成扫码会话');
    return { sessionId: session.id, qrDataUrl: session.qrDataUrl, expiresInSec: 180 };
  });

  handle(IPC.aliyunQrPoll, async (payload: { sessionId: string; name?: string; driveId?: string }) => {
    const session = qrSessions.get(payload.sessionId);
    if (!session) {
      log('[aliyun] 轮询时 session 已不存在:', payload.sessionId);
      throw new Error('二维码会话已失效，请重新生成');
    }
    // 轮询本身抛错（网络 / 风控页 / 非 JSON 响应）以前只冒到 UI，日志里看不到。
    // 这里记一笔再抛，否则用户只看到报错、我却无从定位。
    const res = await pollQrLogin(session).catch((pollErr: unknown) => {
      log('[aliyun] 轮询请求失败:', pollErr instanceof Error ? pollErr.message : String(pollErr));
      throw pollErr;
    });
    if (res.status !== 'CONFIRMED') return { status: res.status };
    if (!res.token) {
      throw new Error('已扫码确认，但未能从响应中解析出 token（接口结构可能已变化）');
    }

    // 诊断：只记字段名不记值。真实扫码后拿到的 bizExt 结构可能与预期不同。
    const bizExtRaw = (res.raw as { bizExt?: unknown } | undefined)?.bizExt;
    const rawKeys =
      res.raw && typeof res.raw === 'object' ? Object.keys(res.raw as Record<string, unknown>) : [];
    log('[aliyun] CONFIRMED raw 顶层键:', rawKeys.join(',') || '(空)', '| bizExt 类型:', typeof bizExtRaw);
    log('[aliyun] bizExt 字段名:', listBizExtKeys(bizExtRaw).join(',') || '(空/无法解析)');

    if (!res.token) {
      log('[aliyun] 已确认但未解析出 token，bizExt 字段名见上一行');
      throw new Error('已扫码确认，但未能从响应中解析出 token（接口结构可能已变化）');
    }

    // bizExt 里的 accessToken 很可能只是 passport 会话 token，直接拿来调 openapi 会得到
    // TokenVerifyFailed: invalid access_token（实测）。正确做法是先用 refresh_token
    // 走标准 OAuth 换一次 PDS 的 access_token，再调 getDriveInfo。
    // 分两步、分别记录：此前把 refresh 与 getDriveInfo 放在同一个 try 里，
    // 实际失败在后者，日志却写成「refresh 换取失败」，把排查方向带偏了。
    let token: AliyunToken = res.token;
    try {
      token = await refreshToken(res.token.refreshToken);
      log('[aliyun] refresh_token 换取成功，expiresAt =', token.expiresAt);
    } catch (refreshErr) {
      log('[aliyun] refresh 换取失败，改用 bizExt accessToken：', refreshErr instanceof Error ? refreshErr.message : String(refreshErr));
      token = res.token;
    }

    const drive = await getDriveInfo(token.accessToken).catch((driveErr: unknown) => {
      log('[aliyun] getDriveInfo 失败：', driveErr instanceof Error ? driveErr.message : String(driveErr));
      throw driveErr;
    });
    log('[aliyun] 挂载成功，drive_id =', drive.driveId, '网盘：', drive.driveName);

    const config: AliyunSourceConfig = {
      kind: 'aliyun',
      // 用户在扫码框里手填的 drive_id 优先：API 只返回备份盘 id，
      // 与网页端实际使用的资源库 id 可能不同（实测 2624585230 vs 1304585230）。
      driveId: (payload.driveId ?? '').trim() || drive.driveId,
      refreshToken: encryptSecret(token.refreshToken),
      accessToken: encryptSecret(token.accessToken),
      expiresAt: token.expiresAt,
      userName: token.userName ?? drive.driveName,
      root: 'root',
    };
    const source: StorageSource = {
      id: newSourceId(),
      kind: 'aliyun',
      name: (payload.name ?? '').trim() || drive.driveName || '阿里云盘',
      config,
      enabled: true,
      lastScanAt: null,
      lastScanCount: 0,
      lastError: null,
      createdAt: Date.now(),
    };
    repo.insertSource(source);
    qrSessions.delete(payload.sessionId);
    log('[aliyun] 扫码授权成功，已挂载', source.name, drive.driveId);
    broadcast(IPC.evLibrary, { reason: 'source-added', sourceId: source.id });
    return { status: 'CONFIRMED' as const, source, driveName: drive.driveName };
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

  handle(IPC.pickExecutable, async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      title: '选择播放器可执行文件',
      filters: process.platform === 'win32' ? [{ name: '可执行文件', extensions: ['exe'] }] : [],
    });
    return res.canceled ? null : (res.filePaths[0] ?? null);
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
    const provider = providerFor(source);
    return provider.test();
  });

  /**
   * 浏览网盘目录：让用户在扫描前先看到盘里到底有什么。
   * 之前只有「盲扫」，盘为空还是 id 不对都只能靠日志猜。
   */
  handle(IPC.browseList, async (payload: { sourceId: string; parentId?: string }) => {
    const source = requireSource(payload.sourceId);
    const provider = providerFor(source);
    const parent = payload.parentId ?? '';
    const entries = await provider.list(parent);
    return {
      parent: parent || String((source.config as { root?: unknown }).root ?? ''),
      entries: entries.map((e) => ({
        path: e.path,
        name: e.name,
        isDir: e.isDir,
        size: e.size,
        mtime: e.mtime,
      })),
    };
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
