import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { locateMpv } from '../src/main/player/locate';

/**
 * 覆盖「内置 mpv」这条分发路径：安装包把 mpv 放在 resources/mpv/ 下，
 * 必须优先于 PATH 与常见安装位置——否则用户机器上的旧版会盖掉随包分发的版本。
 *
 * process.resourcesPath 在 Electron 里由运行时提供，这里用 defineProperty 伪造。
 */

function withResources<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  Object.defineProperty(process, 'resourcesPath', { value: dir, configurable: true, writable: true });
  return fn().finally(() => {
    if (original) Object.defineProperty(process, 'resourcesPath', original);
    else delete (process as unknown as Record<string, unknown>)['resourcesPath'];
  });
}

function makeFakeBundle(): { root: string; mpv: string } {
  const root = mkdtempSync(join(tmpdir(), 'nebula-res-'));
  const mpvDir = join(root, 'mpv');
  mkdirSync(mpvDir, { recursive: true });
  const mpv = join(mpvDir, 'mpv.exe');
  writeFileSync(mpv, '');
  return { root, mpv };
}

test('资源目录里带 mpv 时返回 source=bundled（开箱即用的判定依据）', async () => {
  const { root, mpv } = makeFakeBundle();
  try {
    const r = await withResources(root, () => locateMpv(null));
    assert.equal(r.source, 'bundled', `期望 bundled，实际 ${r.source}：${r.message}`);
    assert.equal(r.path, mpv);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('用户显式配置优先于内置 mpv', async () => {
  const { root } = makeFakeBundle();
  const custom = join(root, 'custom-mpv.exe');
  writeFileSync(custom, '');
  try {
    const r = await withResources(root, () => locateMpv(custom));
    assert.equal(r.source, 'configured');
    assert.equal(r.path, custom);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('资源目录没有 mpv 时不谎报 bundled（回落到 PATH / 常见位置 / none）', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'nebula-empty-'));
  try {
    const r = await withResources(empty, () => locateMpv(null));
    assert.notEqual(r.source, 'bundled');
    assert.ok(['path', 'candidate', 'none'].includes(r.source), `意外来源：${r.source}`);
    if (r.source === 'none') assert.equal(r.path, null);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('配置了不可执行的 mpv 路径时明确报错，而不是悄悄回落到内置', async () => {
  const { root } = makeFakeBundle();
  try {
    const r = await withResources(root, () => locateMpv('C:/definitely/not/here/mpv.exe'));
    assert.equal(r.source, 'none');
    assert.equal(r.path, null);
    assert.match(r.message, /不可执行/);
    assert.equal(existsSync('C:/definitely/not/here/mpv.exe'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
