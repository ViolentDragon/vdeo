import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepFindString, listBizExtKeys, parseBizExt } from '../src/main/sources/aliyun-auth';
import { AliyunProvider } from '../src/main/sources/aliyun';
import { createRepository } from '../src/main/db';
import { scanSource } from '../src/main/scan/scanner';
import type { StorageSource } from '../src/shared/types';

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

test('parseBizExt：标准 camelCase 结构', () => {
  const t = parseBizExt(
    b64({ accessToken: 'AT', refreshToken: 'RT', expiresIn: 7200, nickName: '张三', defaultDriveId: 'drv1' }),
  );
  assert.ok(t);
  assert.equal(t.accessToken, 'AT');
  assert.equal(t.refreshToken, 'RT');
  assert.equal(t.userName, '张三');
  assert.equal(t.driveId, 'drv1');
  assert.ok(t.expiresAt > Date.now(), 'expiresIn 应换算成未来的时间戳');
});

test('parseBizExt：snake_case 结构也能认（不同版本字段名不同）', () => {
  const t = parseBizExt(b64({ access_token: 'AT2', refresh_token: 'RT2', expires_in: '3600' }));
  assert.equal(t?.accessToken, 'AT2');
  assert.equal(t?.refreshToken, 'RT2');
  assert.ok((t?.expiresAt ?? 0) > Date.now());
});

test('parseBizExt：嵌套在 pds_login_result 里也能找到', () => {
  const t = parseBizExt(b64({ pds_login_result: { accessToken: 'A', refreshToken: 'R' } }));
  assert.equal(t?.accessToken, 'A');
  assert.equal(t?.refreshToken, 'R');
});

test('parseBizExt：缺 token / 非法输入返回 null 而不是抛异常', () => {
  assert.equal(parseBizExt(null), null);
  assert.equal(parseBizExt(undefined), null);
  assert.equal(parseBizExt('not-base64!!!'), null);
  assert.equal(parseBizExt(b64({ foo: 1 })), null);
  assert.equal(parseBizExt(b64({ accessToken: 'only-access' })), null, '缺 refreshToken 视为无效');
});

test('parseBizExt：expiresIn 缺失时 expiresAt 为 0（未知），不编造过期时间', () => {
  const t = parseBizExt(b64({ accessToken: 'A', refreshToken: 'R' }));
  assert.equal(t?.expiresAt, 0);
});

test('deepFindString：按 keys 顺序优先，未命中返回 null', () => {
  const obj = { a: { nickName: 'nick' }, userName: 'user' };
  assert.equal(deepFindString(obj, ['userName', 'nickName']), 'user');
  assert.equal(deepFindString(obj, ['nickName']), 'nick');
  assert.equal(deepFindString({ a: 1 }, ['x']), null);
  assert.equal(deepFindString('str', ['x']), null);
});

test('deepFindString：深度上限内查找，不无限递归', () => {
  const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: { target: 'deep' } } } } } } } };
  // depth 上限 6，超过则找不到（防止畸形响应把栈打穿）
  assert.equal(deepFindString(deep, ['target']), null);
  assert.equal(deepFindString({ l1: { target: 'shallow' } }, ['target']), 'shallow');
});

test('listBizExtKeys：只输出字段名，不泄漏字段值', () => {
  const payload = {
    pds_login_result: { access_token: 'SECRET_VALUE_SHOULD_NOT_APPEAR', expires_in: 7200 },
    nickName: 'x',
  };
  const keys = listBizExtKeys(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'));
  assert.ok(keys.includes('pds_login_result'), `缺少顶层键：${keys.join(',')}`);
  assert.ok(keys.includes('pds_login_result.access_token'), '缺少嵌套键');
  assert.ok(keys.includes('nickName'));
  assert.equal(
    keys.some((k) => k.includes('SECRET_VALUE')),
    false,
    '诊断日志只应包含键名，绝不能把 token 值写进日志',
  );
});

test('listBizExtKeys：非法输入返回空数组而不抛异常', () => {
  assert.deepEqual(listBizExtKeys(null), []);
  assert.deepEqual(listBizExtKeys('not-base64!!'), []);
});

test('已有阿里云盘源发现资源库，递归扫描和播放使用文件所在的盘', async ({ mock }) => {
  const config = {
    kind: 'aliyun' as const,
    driveId: 'backup',
    root: 'root',
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: 0,
    userName: null,
  };
  const source: StorageSource = {
    id: 'aliyun-test',
    kind: config.kind,
    name: '阿里云盘',
    enabled: true,
    config,
    lastScanAt: null,
    lastScanCount: 0,
    lastError: null,
    createdAt: 0,
  };
  const token = { ...config, userId: null };
  let failResourceFolder = false;
  let emptyResourceFolder = false;
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url === 'https://user.aliyundrive.com/v2/user/get') {
      return Response.json({ resource_drive_id: 'resource', backup_drive_id: 'backup', default_drive_id: 'backup' });
    }
    const body = JSON.parse(String(init.body));
    if (url === 'https://api.aliyundrive.com/v2/file/get_download_url') {
      assert.equal(body.drive_id, 'resource');
      assert.equal(body.file_id, 'movie');
      return Response.json({ url: 'https://example.test/movie.mkv' });
    }
    assert.equal(url, 'https://api.aliyundrive.com/adrive/v3/file/list');
    if (body.parent_file_id === 'root') {
      if (body.drive_id === 'resource') {
        return Response.json({ items: [{ file_id: 'folder', name: '电影', type: 'folder' }] });
      }
      assert.equal(body.drive_id, 'backup');
      return Response.json({ items: [{ file_id: 'cover', name: '封面.jpg', type: 'file' }] });
    }
    assert.equal(body.drive_id, 'resource');
    assert.equal(body.parent_file_id, 'folder');
    if (failResourceFolder) return Response.json({}, { status: 503 });
    if (emptyResourceFolder || body.marker === 'next') return Response.json({ items: [] });
    return Response.json({ items: [{ file_id: 'movie', name: 'Movie.mkv', type: 'file' }], next_marker: 'next' });
  });

  const provider = new AliyunProvider(config, token);
  const root = await provider.list('');
  assert.deepEqual(root.map((entry) => [entry.path, entry.isDir]), [['resource:folder', true], ['cover', false]]);
  const nested = await new AliyunProvider(config, token).list('resource:folder');
  assert.equal(nested[0]?.path, 'resource:movie');
  assert.equal((await provider.resolvePlayUrl('resource:movie')).url, 'https://example.test/movie.mkv');

  const repo = createRepository(':memory:');
  try {
    repo.insertSource(source);
    const scan = () => scanSource({ source, provider, repo, ignorePatterns: [] });
    const summary = await scan();
    assert.equal(summary.error, null);
    assert.equal(summary.found, 2);
    assert.equal(repo.countItems(), 2);
    assert.equal((await scan()).added, 0);

    failResourceFolder = true;
    assert.match((await scan()).error ?? '', /503/);
    assert.equal(repo.countItems(), 2);

    failResourceFolder = false;
    emptyResourceFolder = true;
    assert.equal((await scan()).error, null);
    assert.equal(repo.countItems(), 1);
  } finally {
    repo.close();
  }
});

test('阿里云盘原画或高清地址为空时仍能播放可用转码', async ({ mock }) => {
  const config = { kind: 'aliyun' as const, driveId: 'drive', root: 'root', accessToken: 'a', refreshToken: 'r', expiresAt: 0, userName: null };
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.file_id, 'movie');
    if (url.endsWith('/get_download_url')) return Response.json({ url: '', cdn_url: '' });
    if (body.category === 'live_transcoding') return Response.json({ video_preview_play_info: { live_transcoding_task_list: [{ template_id: 'FHD', status: 'finished', url: '' }] } });
    assert.equal(body.category, 'quick_video');
    return Response.json({ video_preview_play_info: { quick_video_list: [
      { template_id: 'SD', status: 'finished', url: 'https://example.test/sd.m3u8' },
      { template_id: 'HD', status: 'finished', url: 'https://example.test/hd.m3u8' },
      { template_id: 'FHD', status: 'finished', url: 'https://example.test/{segment}' },
    ] } });
  });
  const provider = new AliyunProvider(config, { ...config, userId: null });
  const media = await provider.resolvePlayUrl('movie');
  assert.equal(media.url, 'https://example.test/hd.m3u8');
  assert.equal(media.headers['Authorization'], undefined);
});
