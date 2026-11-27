import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BROWSER_SOURCE_PATH } from '../src/shared/browser';
import { IPC, type Rpc } from '../src/shared/ipc-contract';
import type { BrowseResult, MediaItem, StorageSource } from '../src/shared/types';
import { LocalProvider } from '../src/main/sources/local';
import { scanSource } from '../src/main/scan/scanner';
import { startBrowserServer } from '../src/main/browser-server';
import { createRepository } from '../src/main/db';

test('浏览器扫码确认后只保存一次存储源，响应隐藏令牌', async (t) => {
  const request = globalThis.fetch;
  let qrStatus = 'NEW';
  let polls = 0;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1') return request(input, init);
    if (url.pathname.endsWith('/generate.do')) {
      return Response.json({ content: { data: { codeContent: 'https://example.invalid/qr', ck: 'test-ck', t: 1 } } });
    }
    if (url.pathname.endsWith('/query.do')) {
      polls += 1;
      return Response.json({ content: { data: { qrCodeStatus: qrStatus, bizExt: {
        accessToken: 'test-original-access', refreshToken: 'test-original-refresh',
      } } } });
    }
    if (url.pathname === '/v2/account/token') {
      return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 });
    }
    if (url.pathname === '/v2/user/get') {
      return Response.json({ resource_drive_id: 'test-drive', nick_name: '测试账号' });
    }
    if (url.pathname.endsWith('/file/list')) {
      return Response.json({ items: [{ file_id: 'test-folder', name: '测试目录', type: 'folder' }] });
    }
    throw new Error('Unexpected upstream request: ' + url.pathname);
  });

  const repo = createRepository(':memory:');
  t.after(() => repo.close());
  const renderer = mkdtempSync(join(tmpdir(), 'nebula-browser-test-'));
  const index = join(renderer, 'index.html');
  writeFileSync(index, '<!doctype html><html><head></head><body>Preview</body></html>');
  t.after(() => { unlinkSync(index); rmdirSync(renderer); });
  const { server, url } = await startBrowserServer(repo, renderer, (secret) => 'enc:test:' + secret);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { origin, hash } = new URL(url);
  assert.equal(hash, '');
  const launch = await fetch(url, { redirect: 'manual' });
  assert.equal(launch.status, 200);
  assert.equal(launch.headers.get('cache-control'), 'no-store');
  assert.equal(launch.headers.has('set-cookie'), false);
  const page = await launch.text();
  assert.match(page, /<base href="\/">/);
  const session = page.match(/name="nebula-browser-session" content="([a-f0-9]{64})"/)?.[1];
  assert(session);
  assert(!url.includes(session));
  assert.match(await (await fetch(url)).text(), new RegExp(session));
  assert.doesNotMatch(await (await fetch(origin)).text(), /nebula-browser-session/);
  const headers = { Origin: origin, Authorization: 'Bearer ' + session, 'Content-Type': 'application/json' };
  const endpoint = origin + BROWSER_SOURCE_PATH;
  const send = (channel: string, payload?: unknown, requestHeaders: Record<string, string> = headers) => fetch(endpoint, {
    method: 'POST', headers: requestHeaders, body: JSON.stringify({ channel, payload }),
  });
  async function call<T>(channel: string, payload?: unknown): Promise<T> {
    const response = await send(channel, payload);
    const result = await response.json() as Rpc<T>;
    assert(result.ok, result.ok ? undefined : result.error);
    return result.data;
  }
  assert.equal((await send(IPC.aliyunQrStart, undefined, { ...headers, Origin: 'http://example.invalid' })).status, 403);
  assert.equal((await send(IPC.aliyunQrStart, undefined, { ...headers, Authorization: '' })).status, 403);
  assert.equal((await send(IPC.aliyunQrStart, undefined, { ...headers, 'Sec-Fetch-Site': 'same-site' })).status, 403);
  assert.equal((await send(IPC.sourcesList, undefined, {
    ...headers, Origin: 'null', 'Sec-Fetch-Site': 'same-origin',
  })).status, 200);
  assert.equal((await send(IPC.sourcesList, undefined, {
    ...headers, Origin: 'http://example.invalid', 'Sec-Fetch-Site': 'same-origin',
  })).status, 200);
  assert.equal((await send(IPC.sourcesList, undefined, {
    ...headers, Origin: 'http://example.invalid', 'Sec-Fetch-Site': 'same-origin', Authorization: '',
  })).status, 403);
  assert.equal((await send(IPC.sourcesList, undefined, {
    Authorization: headers.Authorization, 'Content-Type': headers['Content-Type'],
  })).status, 200);

  const { sessionId, qrDataUrl } = await call<{ sessionId: string; qrDataUrl: string }>(IPC.aliyunQrStart);
  assert.match(qrDataUrl, /^data:image\/png;base64,/);
  const input = { sessionId, name: ' 浏览器网盘 ' };
  assert.equal((await call<{ status: string }>(IPC.aliyunQrPoll, input)).status, 'NEW');
  qrStatus = 'SCANED';
  assert.equal((await call<{ status: string }>(IPC.aliyunQrPoll, input)).status, 'SCANNED');

  qrStatus = 'CONFIRMED';
  const results = await Promise.all([
    call<{ status: string; source: StorageSource }>(IPC.aliyunQrPoll, input),
    call<{ status: string; source: StorageSource }>(IPC.aliyunQrPoll, input),
  ]);
  assert.equal(results[0].status, 'CONFIRMED');
  assert.equal(results[0].source.id, results[1].source.id);
  const saved = repo.listSources();
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.name, '浏览器网盘');
  assert(saved[0]?.config.kind === 'aliyun');
  assert.equal(saved[0].config.refreshToken, 'enc:test:test-refresh');
  assert.equal(saved[0].config.scanScope?.mode, 'pending');

  const listed = await call<StorageSource[]>(IPC.sourcesList);
  assert.doesNotMatch(JSON.stringify([results, listed]), /test-access|test-refresh|test-ck/);
  const sourceId = listed[0]?.id;
  const directory = await call<{ entries: { name: string }[] }>(IPC.browseList, { sourceId });
  assert.equal(directory.entries[0]?.name, '测试目录');
  await call(IPC.sourcesScanScope, { sourceId, scope: { mode: 'all' } });
  assert.equal(repo.listSources()[0]?.config.scanScope?.mode, 'all');
  assert.equal(polls, 3);

  const files = ['北境之旅.S01E01.mkv', '北境之旅.S01E02.mkv', '3.Idiots.2009.1080p.mkv'];
  for (const file of files) writeFileSync(join(renderer, file), 'x');
  try {
    const local: StorageSource = {
      id: 'browser-local',
      kind: 'local',
      name: '测试影库',
      config: { kind: 'local', roots: [renderer] },
      enabled: true,
      lastScanAt: null,
      lastScanCount: 0,
      lastError: null,
      createdAt: Date.now(),
    };
    repo.insertSource(local);
    assert.equal((await scanSource({ source: local, provider: new LocalProvider([renderer]), repo, ignorePatterns: [] })).found, 3);
    assert.equal((await send(IPC.libraryBrowse, { search: '北境之旅' }, { ...headers, Authorization: '' })).status, 403);
    const result = await call<BrowseResult>(IPC.libraryBrowse, { search: '北境之旅 E02', group: 'item' });
    assert.equal(result.total, 1);
    const show = result.entries?.[0];
    assert.ok(show?.kind === 'series');
    assert.equal(show.series.episodeCount, 2);
    const detail = await call<{ items: MediaItem[] }>(IPC.librarySeries, { key: show.series.key });
    assert.equal(detail.items.length, 2);
    assert.ok(detail.items.every((item) => item.path === ''));
    const films = await call<BrowseResult>(IPC.libraryBrowse, { search: '3 Idiots', section: 'movie' });
    assert.equal(films.items[0]?.title, '3 Idiots');
    assert.equal(films.items[0]?.path, '');
  } finally {
    for (const file of files) unlinkSync(join(renderer, file));
  }
});
