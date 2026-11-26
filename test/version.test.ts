import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, isNewer, parseVersion } from '../src/shared/version';

test('parseVersion：去掉 v 前缀、拆分数字与预发布标记', () => {
  assert.deepEqual(parseVersion('v0.1.0'), { nums: [0, 1, 0], pre: null });
  assert.deepEqual(parseVersion('1.2.3-beta.1'), { nums: [1, 2, 3], pre: 'beta.1' });
  assert.deepEqual(parseVersion('1.2.3+build7'), { nums: [1, 2, 3], pre: null });
});

test('compareVersions：逐段比较', () => {
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions('0.1.1', '0.1.0'), 1);
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1);
});

test('compareVersions：缺位补 0（1.0 == 1.0.0）', () => {
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('1', '1.0.0'), 0);
});

test('compareVersions：正式版高于同号预发布版', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-beta'), 1);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0-rc'), -1);
});

test('compareVersions：数字段按数值而非字典序比较', () => {
  // 字典序会认为 "0.10.0" < "0.9.0"，这是常见坑
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1);
});

test('isNewer：远端严格更高才算有更新', () => {
  assert.equal(isNewer('0.1.0', '0.2.0'), true);
  assert.equal(isNewer('0.1.0', '0.1.0'), false);
  assert.equal(isNewer('0.1.0', '0.0.9'), false);
  assert.equal(isNewer('0.1.0', 'v0.1.1'), true);
});

test('异常输入不抛错', () => {
  assert.doesNotThrow(() => compareVersions('', '0.1.0'));
  assert.doesNotThrow(() => parseVersion('abc'));
  assert.equal(compareVersions('abc', '0.0.0'), 0, '无法解析的版本视为 0');
});
