import type { WebdavSourceConfig } from '../../shared/types';
import type { ProviderTestResult, RemoteEntry, ResolvedMedia, StorageProvider } from './types';
import { ProviderError } from './types';

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getlastmodified/>
  </d:prop>
</d:propfind>`;

const TIMEOUT_MS = 30_000;

/** 解 XML 实体，够用于 WebDAV 响应 */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function pickTag(block: string, name: string): string | null {
  const re = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${name}>`, 'i');
  const m = block.match(re);
  return m && m[1] !== undefined ? decodeEntities(m[1].trim()) : null;
}

function isCollection(block: string): boolean {
  return /<(?:[A-Za-z0-9_-]+:)?collection\b/i.test(block);
}

interface DavResponse {
  href: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export function parsePropfindXml(xml: string): DavResponse[] {
  const out: DavResponse[] = [];
  const blocks = xml.match(/<(?:[A-Za-z0-9_-]+:)?response\b[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?response>/gi);
  if (!blocks) return out;
  for (const block of blocks) {
    const href = pickTag(block, 'href');
    if (!href) continue;
    const size = Number(pickTag(block, 'getcontentlength') ?? '0');
    const lastMod = pickTag(block, 'getlastmodified');
    const mtime = lastMod ? Date.parse(lastMod) : 0;
    out.push({
      href,
      isDir: isCollection(block),
      size: Number.isFinite(size) ? size : 0,
      mtime: Number.isFinite(mtime) ? mtime : 0,
    });
  }
  return out;
}

export class WebdavProvider implements StorageProvider {
  readonly kind = 'webdav' as const;
  private readonly baseUrl: string;
  private readonly basePath: string;
  private readonly authHeader: string;

  constructor(private readonly config: WebdavSourceConfig) {
    this.baseUrl = config.url.replace(/\/+$/, '');
    try {
      const base = new URL(this.baseUrl);
      if (base.protocol !== 'https:' && base.protocol !== 'http:') {
        throw new Error('unsupported protocol');
      }
      this.basePath = decodeURIComponent(base.pathname).replace(/\/+$/, '');
    } catch {
      throw new ProviderError('请输入以 http:// 或 https:// 开头的有效 WebDAV 地址');
    }
    this.authHeader = `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}`;
  }

  private urlFor(path: string): string {
    const p = path.startsWith('/') ? path : `/${path}`;
    const encoded = p
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    return this.baseUrl + encoded;
  }

  /** 把响应里的 href 归一成"源内绝对路径"（不含 base 的 pathname 前缀） */
  private hrefToPath(href: string, directoryUrl: string): string | null {
    let pathname: string;
    try {
      pathname = new URL(href, directoryUrl).pathname;
    } catch {
      return null;
    }
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // 部分服务直接在文件名中返回未编码的百分号。
    }
    if (this.basePath && pathname !== this.basePath && !pathname.startsWith(`${this.basePath}/`)) return null;
    return pathname.slice(this.basePath.length).replace(/\/+$/, '') || '/';
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const url = this.urlFor(path);
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          Authorization: this.authHeader,
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new ProviderError(
        `请求 ${url} 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError('认证失败（401/403）：请检查用户名与密码，或该服务需要应用专用密码', res.status);
    }
    return res;
  }

  async test(): Promise<ProviderTestResult> {
    try {
      const entries = await this.list(this.config.root || '/');
      return { ok: true, message: `连接成功，根目录 ${entries.length} 项`, entryCount: entries.length };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async list(dirPath: string): Promise<RemoteEntry[]> {
    const target = `/${(dirPath || this.config.root || '/').replace(/^\/+|\/+$/g, '')}`;
    const res = await this.request(target, {
      method: 'PROPFIND',
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
    });
    if (res.status === 404) throw new ProviderError(`路径不存在：${target}`, 404);
    if (res.status !== 207 && res.status !== 200) {
      throw new ProviderError(`PROPFIND 返回 ${res.status} ${res.statusText}（路径：${target}）`, res.status);
    }
    const xml = await res.text();
    if (!/<(?:[\w.-]+:)?multistatus[\s/>]/i.test(xml)) {
      throw new ProviderError('服务器未返回 WebDAV 目录。请检查地址是否指向 WebDAV 服务。');
    }
    const responses = parsePropfindXml(xml);
    const directoryUrl = this.urlFor(target === '/' ? target : `${target}/`);
    const seen = new Set<string>();
    const entries: RemoteEntry[] = [];
    for (const r of responses) {
      const p = this.hrefToPath(r.href, directoryUrl);
      if (!p || p === target || seen.has(p)) continue;
      seen.add(p);
      const name = p.slice(p.lastIndexOf('/') + 1) || p;
      if (!name) continue;
      entries.push({ path: p, name, isDir: r.isDir, size: r.size, mtime: r.mtime });
    }
    return entries;
  }

  async resolvePlayUrl(path: string): Promise<ResolvedMedia> {
    return {
      url: this.urlFor(path),
      headers: { Authorization: this.authHeader },
    };
  }

  async readText(path: string, maxBytes = 256 * 1024): Promise<string | null> {
    try {
      const res = await this.request(path, {
        method: 'GET',
        headers: { Range: `bytes=0-${Math.max(0, maxBytes - 1)}` },
      });
      if (!res.ok && res.status !== 206) return null;
      const text = await res.text();
      return text.slice(0, maxBytes);
    } catch {
      return null;
    }
  }
}
