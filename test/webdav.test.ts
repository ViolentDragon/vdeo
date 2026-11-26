import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePropfindXml, WebdavProvider } from '../src/main/sources/webdav';

const SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/%E7%94%B5%E5%BD%B1/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/%E7%94%B5%E5%BD%B1/The.Matrix.1999.1080p.mkv</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype/>
        <D:getcontentlength>1468006400</D:getcontentlength>
        <D:getlastmodified>Wed, 21 Oct 2026 07:28:00 GMT</D:getlastmodified>
      </D:prop>
    </D:propstat>
  </D:response>
</D:multistatus>`;

test('WebDAV PROPFIND 响应解析：目录、文件、中文百分号编码', () => {
  const rows = parsePropfindXml(SAMPLE);
  assert.equal(rows.length, 3);

  const dir = rows[1]!;
  assert.equal(dir.isDir, true);
  assert.equal(decodeURIComponent(dir.href), '/dav/电影/');

  const file = rows[2]!;
  assert.equal(file.isDir, false);
  assert.equal(file.size, 1468006400);
  assert.ok(file.mtime > 0, 'Last-Modified 应解析成时间戳');
  assert.equal(decodeURIComponent(file.href), '/dav/电影/The.Matrix.1999.1080p.mkv');
});

test('命名空间前缀大小写不同也能解析（部分服务端返回小写 d:）', () => {
  const lower = `<d:multistatus xmlns:d="DAV:">
    <d:response>
      <d:href>/a.mkv</d:href>
      <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>12</d:getcontentlength></d:prop></d:propstat>
    </d:response>
  </d:multistatus>`;
  const rows = parsePropfindXml(lower);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.size, 12);
  assert.equal(rows[0]?.isDir, false);
});

test('空响应不抛异常', () => {
  assert.deepEqual(parsePropfindXml(''), []);
  assert.deepEqual(parsePropfindXml('<D:multistatus xmlns:D="DAV:"/>'), []);
});

test('WebDAV 挂载可验证连接、递归浏览和解析播放地址', async ({ mock }) => {
  const mountUrl = 'https://example.test/dav/%E7%94%B5%E5%BD%B1';
  const auth = `Basic ${Buffer.from('user:secret').toString('base64')}`;
  const listing = (hrefs: string[]) => new Response(
    `<d:multistatus xmlns:d="DAV:">${hrefs.map((href) => `
      <d:response><d:href>${href}</d:href>${href.endsWith('/') ? '<d:collection/>' : ''}</d:response>
    `).join('')}</d:multistatus>`,
    { status: 207 },
  );
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(init.method, 'PROPFIND');
    assert.equal(new Headers(init.headers).get('Authorization'), auth);
    if (url === mountUrl) {
      return listing(['/dav/电影/', '/dav/电影/剧集/', 'https://example.test/dav/电影/剧集/', '/dav-other/电影/']);
    }
    if (url === `${mountUrl}/%E5%89%A7%E9%9B%86`) return listing(['./', '第%201%20集.mkv']);
    assert.equal(url, 'https://example.test/dav/invalid');
    return new Response('<!doctype html><title>Login</title>');
  });
  const config = {
    kind: 'webdav' as const,
    driveBrand: 'pan123' as const,
    url: 'https://example.test/dav',
    username: 'user',
    password: 'secret',
    root: '/电影/',
  };
  const provider = new WebdavProvider(config);
  assert.equal((await provider.test()).entryCount, 1);
  const folders = await provider.list(config.root);
  assert.deepEqual(folders.map(({ path, isDir }) => [path, isDir]), [['/电影/剧集', true]]);
  const [file] = await provider.list(folders[0]!.path);
  assert.equal(file?.path, '/电影/剧集/第 1 集.mkv');
  assert.deepEqual(await provider.resolvePlayUrl(file!.path), {
    url: `${mountUrl}/%E5%89%A7%E9%9B%86/%E7%AC%AC%201%20%E9%9B%86.mkv`,
    headers: { Authorization: auth },
  });
  const wrongAddress = await new WebdavProvider({ ...config, root: '/invalid' }).test();
  assert.equal(wrongAddress.ok, false);
  assert.match(wrongAddress.message, /未返回 WebDAV 目录/);
});
