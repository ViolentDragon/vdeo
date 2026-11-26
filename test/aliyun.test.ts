import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepFindString, parseBizExt } from '../src/main/sources/aliyun-auth';

/**
 * 只测纯解析逻辑（不联网）。
 * 扫码接口的可达性用真实探针验证过（generate/query/auth-token/openapi 四个端点均存在），
 * 真实扫码确认那一步需要用户手机，无法自动化。
 */

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
