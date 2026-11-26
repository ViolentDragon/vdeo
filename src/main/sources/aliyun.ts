import type { AliyunSourceConfig } from '../../shared/types';
import type { ProviderTestResult, RemoteEntry, ResolvedMedia, StorageProvider } from './types';
import { ProviderError } from './types';
import { getDriveInfo, refreshToken, type AliyunToken } from './aliyun-auth';

/**
 * 阿里云盘 provider。
 *
 * 路径语义：内部 path 就是阿里云盘的 file_id（根为 'root'）。
 * 云盘是 id 树而不是路径树，用 id 做路径可以让 scanner 的递归天然工作；
 * 代价是「同目录字幕自动发现」拿不到父目录，本期对 aliyun 不做字幕自动匹配。
 */

const OPENAPI = 'https://openapi.alipan.com';
const PAGE_LIMIT = 200;
const MAX_PAGES = 60;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function gb(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 GB';
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
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
    if (this.token.expiresAt === 0) return;
    if (Date.now() < this.token.expiresAt - 60_000) return;
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
    let res: Response;
    try {
      res = await fetch(OPENAPI + path, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token.accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': UA,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      throw new ProviderError(`请求阿里云盘失败：${err instanceof Error ? err.message : String(err)}`);
    }

    if (res.status === 401 && allowRetry) {
      await this.doRefresh();
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
      const drive = await getDriveInfo(this.token.accessToken);
      return {
        ok: true,
        message: `${drive.driveName}：已用 ${gb(drive.usedSize)} / ${gb(drive.totalSize)}`,
      };
    } catch (err) {
      // token 过期时再试一次刷新
      try {
        await this.doRefresh();
        const drive = await getDriveInfo(this.token.accessToken);
        return { ok: true, message: `${drive.driveName}：已用 ${gb(drive.usedSize)} / ${gb(drive.totalSize)}` };
      } catch {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  async list(dirPath: string): Promise<RemoteEntry[]> {
    const parentId = !dirPath || dirPath === '/' ? (this.config.root || 'root') : dirPath;
    const out: RemoteEntry[] = [];
    let marker = '';

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body: Record<string, unknown> = {
        drive_id: this.config.driveId,
        parent_file_id: parentId,
        limit: PAGE_LIMIT,
        order_by: 'name',
        order_direction: 'ASC',
        fields: 'id,name,type,size,updated_at,parent_file_id,category,file_extension',
      };
      if (marker) body['marker'] = marker;

      const res = await this.api<{
        items?: Array<Record<string, unknown>>;
        next_marker?: string;
      }>('/adrive/v1.0/openFile/list', body);

      for (const it of res.items ?? []) {
        const fileId = String(it['file_id'] ?? it['id'] ?? '');
        const name = String(it['name'] ?? '');
        if (!fileId || !name) continue;
        const type = String(it['type'] ?? 'file');
        const size = Number(it['size'] ?? 0);
        const updated = it['updated_at'];
        const mtime = typeof updated === 'string' ? Date.parse(updated) : 0;
        out.push({
          path: fileId,
          name,
          isDir: type === 'folder',
          size: Number.isFinite(size) ? size : 0,
          mtime: Number.isFinite(mtime) ? mtime : 0,
        });
      }

      marker = res.next_marker ?? '';
      if (!marker) break;
    }

    return out;
  }

  async resolvePlayUrl(path: string): Promise<ResolvedMedia> {
    const fileId = path;
    const headers: Record<string, string> = {
      Referer: 'https://www.aliyundrive.com/',
      'User-Agent': UA,
      Authorization: `Bearer ${this.token.accessToken}`,
    };

    // 1) 优先直链（需要该账号/token 具备下载权限，失败就换转码）
    try {
      const dl = await this.api<{ url?: string }>('/adrive/v1.0/openFile/getDownloadUrl', {
        drive_id: this.config.driveId,
        file_id: fileId,
        expire_sec: 14400,
      });
      if (dl.url) return { url: dl.url, headers };
    } catch {
      /* 落到转码分支 */
    }

    // 2) 转码播放列表（m3u8，mpv 原生支持 HLS）
    const info = await this.api<{
      video_preview_play_info?: {
        live_transcoding_task_list?: Array<{ template_id?: string; url?: string }>;
      };
    }>('/adrive/v1.0/openFile/getVideoPreviewPlayInfo', {
      drive_id: this.config.driveId,
      file_id: fileId,
      category: 'live_transcoding',
      template_id: '',
    });

    const tasks = info.video_preview_play_info?.live_transcoding_task_list ?? [];
    const pick = tasks.find((t) => t.template_id === 'FHD') ?? tasks.find((t) => Boolean(t.url)) ?? tasks[0];
    if (pick?.url) return { url: pick.url, headers };

    throw new ProviderError(
      '阿里云盘没有返回可播放地址：可能是文件夹、该账号无下载权限，或视频转码尚未就绪',
    );
  }
}
