import type { AliyunSourceConfig } from '../../shared/types';
import type { ProviderTestResult, RemoteEntry, ResolvedMedia, StorageProvider } from './types';
import { ProviderError } from './types';
import { getDriveInfo, refreshToken, type AliyunToken } from './aliyun-auth';
import { log } from '../logger';

/**
 * 阿里云盘 provider。
 *
 * 配置盘继续用 file_id 作为内部路径，保留已入库条目的 ID。
 * 其他盘用 drive_id:file_id，由浏览、扫描和播放共同使用。
 */

/**
 * 用 Web 端 API（api.aliyundrive.com），不用开放平台（openapi.alipan.com）。
 * passport 扫码与 refresh_token 换出来的都是 Web 会话 token，
 * 调开放平台会回 TokenVerifyFailed: invalid access_token（实测日志已确认）。
 */
const WEB_API = 'https://api.aliyundrive.com';
const PAGE_LIMIT = 200;
const MAX_PAGES = 60;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MEDIA_HEADERS = { Referer: 'https://www.aliyundrive.com/', 'User-Agent': UA };
const PREVIEW_QUALITY = ['UHD', 'FHD', 'HD', 'SD', 'LD'];

interface PreviewTask {
  template_id?: string;
  status?: string;
  url?: string;
}

function usableUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('https://') && !/[{}]/.test(value);
}

export class AliyunProvider implements StorageProvider {
  readonly kind = 'aliyun' as const;
  private token: AliyunToken;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly config: AliyunSourceConfig,
    token: AliyunToken,
    private readonly onTokenRefreshed?: (token: AliyunToken) => void,
  ) {
    this.token = token;
  }

  getToken(): AliyunToken {
    return this.token;
  }

  private async ensureFresh(): Promise<void> {
    if (this.token.accessToken && (this.token.expiresAt === 0 || Date.now() < this.token.expiresAt - 60_000)) return;
    await this.doRefresh();
  }

  private doRefresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const next = await refreshToken(this.token.refreshToken);
      this.token = next;
      this.onTokenRefreshed?.(next);
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async api<T>(path: string, body: unknown, allowRetry = true): Promise<T> {
    await this.ensureFresh();
    const accessToken = this.token.accessToken;
    let res: Response;
    try {
      res = await fetch(WEB_API + path, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': UA,
          // Web API 有来源校验：缺 Referer/Origin 时接口会返回空 items 而不是报错，
          // 表现为「登录成功但扫描到 0 个文件」。
          Referer: 'https://www.aliyundrive.com/',
          Origin: 'https://www.aliyundrive.com',
          Accept: 'application/json, text/plain, */*',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      throw new ProviderError(`请求阿里云盘失败：${err instanceof Error ? err.message : String(err)}`);
    }

    if (res.status === 401 && allowRetry) {
      if (this.token.accessToken === accessToken) await this.doRefresh();
      return this.api<T>(path, body, false);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new ProviderError(`阿里云盘接口 ${path} 返回 ${res.status}：${text.slice(0, 200)}`, res.status);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ProviderError(`阿里云盘接口 ${path} 返回了非 JSON 内容`);
    }
  }

  async test(): Promise<ProviderTestResult> {
    try {
      const entries = await this.list('');
      return { ok: true, message: `连接成功，根目录共 ${entries.length} 项`, entryCount: entries.length };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async driveCandidates(): Promise<string[]> {
    await this.ensureFresh();
    const configured = this.config.driveId;
    const accessToken = this.token.accessToken;
    let ids: string[];
    try {
      ids = (await getDriveInfo(accessToken)).allDriveIds;
    } catch (err) {
      if (!(err instanceof ProviderError) || err.status !== 401) {
        if (!configured) throw err;
        return [configured];
      }
      if (this.token.accessToken === accessToken) await this.doRefresh();
      ids = (await getDriveInfo(this.token.accessToken)).allDriveIds;
    }
    return [...new Set([...ids, configured].filter(Boolean))];
  }

  async list(dirPath: string): Promise<RemoteEntry[]> {
    const path = !dirPath || dirPath === '/' ? this.config.root : dirPath;
    if (path && path !== '/' && path !== 'root') {
      const [driveId = '', fileId] = path.split(':', 2);
      return fileId ? this.listFromDrive(driveId, fileId) : this.listFromDrive(this.config.driveId, path);
    }

    const entries: RemoteEntry[] = [];
    let listed = false;
    let missingDriveError: ProviderError | undefined;
    for (const driveId of await this.driveCandidates()) {
      try {
        entries.push(...await this.listFromDrive(driveId, 'root'));
        listed = true;
      } catch (err) {
        if (!(err instanceof ProviderError) || err.status !== 404) throw err;
        missingDriveError = err;
      }
    }
    if (!listed) throw missingDriveError ?? new ProviderError('没有可读取的阿里云盘');
    return entries;
  }

  private async listFromDrive(driveId: string, parentId: string): Promise<RemoteEntry[]> {
    try {
      return await this.listPages(driveId, parentId, '/adrive/v3/file/list');
    } catch (err) {
      if (!(err instanceof ProviderError) || err.status !== 404) throw err;
      log('[aliyun] 使用旧版目录接口重试', err.message);
      return this.listPages(driveId, parentId, '/v2/file/list');
    }
  }

  private async listPages(driveId: string, parentId: string, endpoint: string): Promise<RemoteEntry[]> {
    const out: RemoteEntry[] = [];
    let marker = '';

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body: Record<string, unknown> = {
        drive_id: driveId,
        parent_file_id: parentId,
        limit: PAGE_LIMIT,
        order_by: 'name',
        order_direction: 'ASC',
        // fields 用 '*'：v1.0 那套 "id,name,type,..." 的字段列表在 v3 上可能不认，
        // 实测传它会返回空 items（而不是报错），这是「扫描到 0 个媒体文件」的直接原因。
        fields: '*',
      };
      if (marker) body['marker'] = marker;

      const res = await this.api<{
        items?: Array<Record<string, unknown>>;
        next_marker?: string;
      }>(endpoint, body);

      if (!Array.isArray(res?.items)) throw new ProviderError('阿里云盘目录接口返回了无效的文件列表');

      for (const it of res.items) {
        const fileId = String(it['file_id'] ?? it['id'] ?? '');
        const name = String(it['name'] ?? '');
        if (!fileId || !name) continue;
        const type = String(it['type'] ?? 'file');
        const size = Number(it['size'] ?? 0);
        const updated = it['updated_at'];
        const mtime = typeof updated === 'string' ? Date.parse(updated) : 0;
        out.push({
          path: driveId === this.config.driveId ? fileId : `${driveId}:${fileId}`,
          name,
          isDir: type === 'folder',
          size: Number.isFinite(size) ? size : 0,
          mtime: Number.isFinite(mtime) ? mtime : 0,
        });
      }

      if (!res.next_marker) return out;
      if (res.next_marker === marker) throw new ProviderError('阿里云盘目录分页重复');
      marker = res.next_marker;
    }

    throw new ProviderError('阿里云盘目录超过分页上限');
  }

  private fileRequest(path: string): { drive_id: string; file_id: string } {
    const [first = '', scopedFileId] = path.split(':', 2);
    return { drive_id: scopedFileId ? first : this.config.driveId, file_id: scopedFileId ?? path };
  }

  async getArtwork(path: string, video: boolean): Promise<ResolvedMedia | null> {
    const file = await this.api<{ thumbnail?: string }>('/v2/file/get', {
      ...this.fileRequest(path),
      ...(video ? { video_thumbnail_process: 'video/snapshot,t_0,f_jpg,w_480' }
        : { image_thumbnail_process: 'image/resize,w_480/format,jpg' }),
    });
    return usableUrl(file.thumbnail) ? { url: file.thumbnail, headers: MEDIA_HEADERS } : null;
  }

  async resolvePlayUrl(path: string): Promise<ResolvedMedia> {
    const file = this.fileRequest(path);
    let lastError: Error | null = null;

    try {
      const dl = await this.api<{ url?: string; cdn_url?: string }>('/v2/file/get_download_url', {
        ...file,
        expire_sec: 14400,
      });
      const url = [dl.url, dl.cdn_url].find(usableUrl);
      if (url) return { url, headers: MEDIA_HEADERS };
    } catch (err) {
      if (err instanceof ProviderError && err.status === 401) throw err;
      if (err instanceof Error) lastError = err;
    }

    let preparing = false;
    for (const category of ['live_transcoding', 'quick_video']) {
      try {
        const info = await this.api<{
          code?: string;
          video_preview_play_info?: { live_transcoding_task_list?: PreviewTask[]; quick_video_list?: PreviewTask[] };
        }>('/v2/file/get_video_preview_play_info', { ...file, category });
        const lists = info.video_preview_play_info;
        const tasks = [...(lists?.live_transcoding_task_list ?? []), ...(lists?.quick_video_list ?? [])];
        const ready = tasks.filter((task) => (!task.status || task.status === 'finished') && usableUrl(task.url));
        const best = PREVIEW_QUALITY.map((quality) => ready.find((task) => task.template_id === quality)).find(Boolean) ?? ready[0];
        if (best?.url) return { url: best.url, headers: MEDIA_HEADERS };
        preparing ||= info.code === 'VideoPreviewWaitAndRetry' || tasks.some((task) => task.status === 'running' || task.status === 'pending');
      } catch (err) {
        if (err instanceof ProviderError && err.status === 401) throw err;
        if (err instanceof Error) lastError = err;
      }
    }

    if (preparing) throw new ProviderError('阿里云盘正在转码，请稍后重试这一集');
    if (lastError instanceof ProviderError && lastError.status === 403) {
      throw new ProviderError('阿里云盘拒绝了该文件的播放请求，请在网盘中检查该文件的播放权限', 403);
    }
    if (lastError && !(lastError instanceof ProviderError && lastError.status === 404)) throw lastError;
    throw new ProviderError('阿里云盘暂时没有提供可用的播放地址');
  }
}
