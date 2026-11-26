import type { AliyunSourceConfig } from '../../shared/types';
import type { ProviderTestResult, RemoteEntry, ResolvedMedia, StorageProvider } from './types';
import { ProviderError } from './types';
import { getDriveInfo, refreshToken, type AliyunToken } from './aliyun-auth';
import { log } from '../logger';

/**
 * 阿里云盘 provider。
 *
 * 路径语义：内部 path 就是阿里云盘的 file_id（根为 'root'）。
 * 云盘是 id 树而不是路径树，用 id 做路径可以让 scanner 的递归天然工作；
 * 代价是「同目录字幕自动发现」拿不到父目录，本期对 aliyun 不做字幕自动匹配。
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
      res = await fetch(WEB_API + path, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token.accessToken}`,
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

  /**
   * 该账号下要尝试的 drive_id 列表。
   * 一个阿里云盘账号有多个盘（资源库/默认盘/备份盘），媒体通常在资源库；
   * 只用建源时记下的那一个 id，会出现「登录成功但 list 恒返回 0 项」。
   */
  private driveCandidatesCache: string[] | null = null;

  private async driveCandidates(): Promise<string[]> {
    if (this.driveCandidatesCache) return this.driveCandidatesCache;
    try {
      const info = await getDriveInfo(this.token.accessToken);
      const list = info.allDriveIds.filter(Boolean);
      this.driveCandidatesCache = list.length > 0 ? list : [this.config.driveId];
      if (this.driveCandidatesCache.length > 1) {
        log('[aliyun] 候选盘:', this.driveCandidatesCache.join(','));
      }
    } catch {
      this.driveCandidatesCache = [this.config.driveId];
    }
    return this.driveCandidatesCache;
  }

  async list(dirPath: string): Promise<RemoteEntry[]> {
    const parentId = !dirPath || dirPath === '/' ? (this.config.root || 'root') : dirPath;
    const drives = await this.driveCandidates();

    for (const driveId of drives) {
      const items = await this.listFromDrive(driveId, parentId);
      if (items.length > 0) {
        log(`[aliyun] list drive=${driveId} parent=${parentId} → ${items.length} 项`);
        return items;
      }
      log(`[aliyun] list drive=${driveId} parent=${parentId} → 0 项，试下一个盘`);
    }

    log(`[aliyun] 所有盘在 parent=${parentId} 下均为空（共试 ${drives.length} 个盘）`);
    // 只在根目录探测，避免递归时对每个子目录都跑一遍
    if (parentId === 'root' || parentId === this.config.root) {
      await this.probeMatrix(parentId);
    }
    return [];
  }

  /**
   * 当所有盘都返回 0 项时，跑一次诊断矩阵并写日志。
   *
   * 目的：一次性区分「盘真的空」与「参数组合不对」。之前只知道 'root' 返回空，
   * 没试过 '0'、空串、数字型 drive_id，也没验证过 openapi 域名下的 getDriveInfo
   * 在真实 token 下是什么反应——这些信息缺失导致无法定位。
   */
  private async probeMatrix(parentId: string): Promise<void> {
    const drives = await this.driveCandidates();
    const driveId = drives[0] ?? this.config.driveId;
    if (!driveId) return;

    const variants: Array<{ name: string; body: Record<string, unknown> }> = [
      { name: 'parent=root', body: { drive_id: driveId, parent_file_id: 'root', limit: 20, fields: '*' } },
      { name: "parent='0'", body: { drive_id: driveId, parent_file_id: '0', limit: 20, fields: '*' } },
      { name: "parent=''", body: { drive_id: driveId, parent_file_id: '', limit: 20, fields: '*' } },
      { name: 'drive_id 为数字', body: { drive_id: Number(driveId) || driveId, parent_file_id: 'root', limit: 20, fields: '*' } },
    ];

    for (const v of variants) {
      try {
        const r = await this.api<{ items?: unknown[] }>('/adrive/v3/file/list', v.body);
        log(`[aliyun][探测] ${v.name} → ${r.items?.length ?? 0} 项`);
      } catch (err) {
        log(`[aliyun][探测] ${v.name} 失败:`, err instanceof Error ? err.message.slice(0, 120) : String(err));
      }
    }

    // 对照：开放平台的 getDriveInfo 在真实 token 下的反应
    // （据此判断是否需要 OAuth token，而不是继续猜）
    try {
      const res = await fetch('https://openapi.alipan.com/adrive/v1.0/user/getDriveInfo', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token.accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': UA,
        },
        body: '{}',
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      log(`[aliyun][探测] openapi getDriveInfo → HTTP ${res.status}`, text.slice(0, 160));
    } catch (err) {
      log('[aliyun][探测] openapi getDriveInfo 请求失败:', err instanceof Error ? err.message.slice(0, 120) : String(err));
    }
  }

  private async listFromDrive(driveId: string, parentId: string): Promise<RemoteEntry[]> {
    // v3 是当前 Web 端用的接口；v2 是旧版，参数更宽松。
    // 两者都试一遍，避免某个接口对 parent_file_id 的约定不同导致静默返回空。
    for (const endpoint of ['/adrive/v3/file/list', '/v2/file/list']) {
      try {
        const items = await this.listPage(driveId, parentId, endpoint);
        if (items.length > 0) return items;
        log(`[aliyun] ${endpoint} drive=${driveId} parent=${parentId} → 0 项`);
      } catch (err) {
        log(`[aliyun] ${endpoint} 失败：`, err instanceof Error ? err.message.slice(0, 160) : String(err));
      }
    }
    return [];
  }

  private async listPage(driveId: string, parentId: string, endpoint: string): Promise<RemoteEntry[]> {
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
      const dl = await this.api<{ url?: string }>('/v2/file/get_download_url', {
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
    }>('/v2/file/get_video_preview_play_info', {
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
