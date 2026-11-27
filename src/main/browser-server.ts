import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { BROWSER_SOURCE_PATH, isBrowserSourceChannel, type BrowserSourceChannel } from '../shared/browser';
import { IPC } from '../shared/ipc-contract';
import { GENRES, SECTION_LABEL, type BrowseQuery, type Genre, type LibrarySection, type MediaItem, type ScanScope, type StorageSource } from '../shared/types';
import type { Repository } from './db';
import { log } from './logger';
import { listSourceDirectory, validateScanScope } from './scan/scope';
import { createAliyunQrLogin } from './sources/aliyun-qr';
import { createProvider } from './sources/registry';

const HOST = '127.0.0.1';
const MAX_BODY = 512 * 1024;
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function publicSource(source: StorageSource): StorageSource {
  if (source.config.kind !== 'aliyun') throw new Error('存储源类型不受支持');
  return { ...source, config: { ...source.config, accessToken: '', refreshToken: '' } };
}

function publicMedia(item: MediaItem): MediaItem {
  return { ...item, path: '' };
}

function libraryQuery(payload: Record<string, unknown>): BrowseQuery {
  const { section, search, sort, order, limit, offset, genre, group } = payload;
  return {
    section: typeof section === 'string' && Object.hasOwn(SECTION_LABEL, section) ? section as LibrarySection : undefined,
    search: typeof search === 'string' ? search.slice(0, 256) : undefined,
    sort: sort === 'title' || sort === 'year' || sort === 'rating' ? sort : 'added',
    order: order === 'asc' ? 'asc' : 'desc',
    limit: typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 36,
    offset: typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
    genre: genre === 'untagged' || GENRES.includes(genre as Genre) ? genre as BrowseQuery['genre'] : undefined,
    group: group === 'catalog' || group === 'series' ? group : 'item',
  };
}

function respond(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

class BrowserInputError extends Error {}

async function readCall(req: IncomingMessage): Promise<{ channel: BrowserSourceChannel; payload: Record<string, unknown> }> {
  if (Number(req.headers['content-length']) > MAX_BODY) throw new BrowserInputError('请求内容过长');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of req) {
    const chunk = value as Buffer;
    size += chunk.length;
    if (size > MAX_BODY) throw new BrowserInputError('请求内容过长');
    chunks.push(chunk);
  }
  let call: { channel?: unknown; payload?: unknown } | null;
  try {
    call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof call;
  } catch {
    throw new BrowserInputError('请求格式无效');
  }
  if (!isBrowserSourceChannel(call?.channel)) throw new BrowserInputError('该操作在桌面版提供');
  const payload = call.payload;
  if (payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload))) {
    throw new BrowserInputError('请求参数无效');
  }
  return { channel: call.channel, payload: (payload ?? {}) as Record<string, unknown> };
}

export async function startBrowserServer(repo: Repository, rendererDir: string, encrypt: (secret: string) => string) {
  const login = createAliyunQrLogin(repo, encrypt);
  const launchPath = `/launch/${randomBytes(32).toString('hex')}`;
  const browserSession = randomBytes(32).toString('hex');
  const requireAliyun = (id: unknown) => {
    const source = typeof id === 'string' ? repo.getSource(id) : null;
    if (source?.config.kind !== 'aliyun') throw new BrowserInputError('阿里云盘存储源不存在');
    return source;
  };

  async function runCall(channel: BrowserSourceChannel, payload: Record<string, unknown>) {
    switch (channel) {
      case IPC.aliyunQrStart:
        return login.start();
      case IPC.aliyunQrPoll: {
        if (typeof payload['sessionId'] !== 'string') throw new BrowserInputError('二维码会话无效');
        const name = typeof payload['name'] === 'string' ? payload['name'] : undefined;
        const result = await login.poll({ sessionId: payload['sessionId'], name });
        return result.status === 'CONFIRMED' ? { status: result.status, source: publicSource(result.source) } : result;
      }
      case IPC.sourcesList:
        return repo.listSources().filter((source) => source.config.kind === 'aliyun').map(publicSource);
      case IPC.libraryBrowse: {
        const result = repo.browse(libraryQuery(payload));
        return {
          ...result,
          items: result.items.map(publicMedia),
          entries: result.entries?.map((entry) => entry.kind === 'item' ? { ...entry, item: publicMedia(entry.item) } : entry),
        };
      }
      case IPC.librarySeries: {
        if (typeof payload['key'] !== 'string') throw new BrowserInputError('剧集标识无效');
        const result = repo.getSeries(payload['key']);
        return result ? { ...result, items: result.items.map(publicMedia) } : null;
      }
    }

    const source = requireAliyun(channel === IPC.sourcesTest ? payload['id'] : payload['sourceId']);
    const provider = createProvider(source, {
      onAliyunTokenRefreshed: (id, token) => {
        const current = requireAliyun(id);
        if (current.config.kind !== 'aliyun') return;
        current.config = { ...current.config, accessToken: encrypt(token.accessToken),
          refreshToken: encrypt(token.refreshToken), expiresAt: token.expiresAt };
        repo.updateSource(current);
      },
    });
    if (channel === IPC.sourcesTest) {
      const result = await provider.test();
      return result.ok ? result : { ok: false, message: '无法访问阿里云盘，请检查连接或重新授权。' };
    }
    if (channel === IPC.browseList) {
      const parent = typeof payload['parentId'] === 'string' ? payload['parentId'] : undefined;
      return listSourceDirectory(source, provider, parent);
    }
    const scope = await validateScanScope(source, provider, payload['scope'] as ScanScope);
    const current = requireAliyun(source.id);
    if (JSON.stringify(current.config.scanScope) !== JSON.stringify(source.config.scanScope)) {
      throw new BrowserInputError('扫描范围已更改，请重新打开设置');
    }
    current.config = { ...current.config, scanScope: scope };
    repo.updateSource(current);
    return publicSource(current);
  }

  let origin = '';
  let connected = false;
  let launchReported = false;
  let rejectionReported = false;
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (`http://${req.headers.host}` !== origin) {
      respond(res, 403, { ok: false, error: '请使用启动窗口中的本机链接' });
      return;
    }
    if (req.url === BROWSER_SOURCE_PATH && req.method === 'POST') {
      const requestOrigin = req.headers.origin;
      const fetchSite = req.headers['sec-fetch-site'];
      const localOrigin = requestOrigin === origin || requestOrigin === undefined || requestOrigin === 'null';
      // The browser supplies Fetch Metadata. A valid page token is still required.
      const localRequest = fetchSite === 'same-origin' || (fetchSite === undefined && localOrigin);
      const hasSession = req.headers.authorization === `Bearer ${browserSession}`;
      if (!localRequest || !hasSession || req.headers['content-type'] !== 'application/json') {
        if (!rejectionReported) {
          rejectionReported = true;
          log('浏览器请求未通过本机校验', { localOrigin, localRequest, hasSession });
        }
        respond(res, 403, { ok: false, error: '本机启动授权已失效，请重新运行 start-browser.cmd。' });
        return;
      }
      try {
        const { channel, payload } = await readCall(req);
        const data = await runCall(channel, payload);
        if (!connected) {
          connected = true;
          log('浏览器本机连接已建立。');
        }
        respond(res, 200, { ok: true, data });
      } catch (error) {
        const message = error instanceof BrowserInputError ? error.message : '本机操作失败，请重试。';
        respond(res, 200, { ok: false, error: message });
      }
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    const urlPath = req.url?.split('?')[0] ?? '';
    const launched = urlPath === launchPath;
    const file = launched || urlPath === '/' ? 'index.html' : urlPath.slice(1);
    const contentType = MIME_TYPES[extname(file)];
    if (!contentType || (file !== 'index.html' && !/^assets\/[\w.-]+\.[a-z]+$/.test(file))) {
      res.writeHead(404).end();
      return;
    }
    try {
      const content = await readFile(join(rendererDir, file));
      // The launch address remains valid on reload, including on browsers with cookies disabled.
      if (launched && !launchReported) {
        launchReported = true;
        log('浏览器已载入本机启动页面。');
      }
      const page = launched ? content.toString('utf8').replace('<head>',
        `<head><base href="/"><meta name="nebula-browser-session" content="${browserSession}">`) : content;
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' }).end(page);
    } catch {
      res.writeHead(404).end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('无法读取浏览器服务地址'));
        return;
      }
      origin = `http://${HOST}:${address.port}`;
      resolve();
    });
  });
  return { server, url: origin + launchPath };
}
