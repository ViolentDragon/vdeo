import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MpvController } from '../src/main/player/mpv';

/**
 * 真实 mpv 集成测试：不 mock IPC、不 mock 进程。
 * 用 vendor/mpv 里的 mpv.exe 静默解码（--vo=null），验证
 * 启动 → loadfile → 属性回传 → seek → 暂停 → 结束 的完整链路。
 *
 * 没有 vendor/mpv 时 skip（先跑 npm run vendor:mpv）。
 */

const MPV = join(process.cwd(), 'vendor', 'mpv', 'mpv.exe');
const SAMPLES = [
  'C:\\Windows\\SystemApps\\Microsoft.Windows.CloudExperienceHost_cw5n1h2txyewy\\media\\oobe-intro.mp4',
  'C:\\Windows\\WinSxS\\amd64_microsoft-windows-c..st.appxmain.desktop_31bf3856ad364e35_10.0.26100.1591_none_24d501a973fa7371\\oobe-intro.mp4',
];

function findSample(): string | null {
  return SAMPLES.find((p) => existsSync(p)) ?? null;
}

async function waitFor<T>(fn: () => T | null, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== null && v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 120));
  }
}

test('真实 mpv：启动 → 加载 → 时长 → seek → 暂停 → 结束', async (t) => {
  if (!existsSync(MPV)) {
    t.skip(`缺少 ${MPV}，先执行 npm run vendor:mpv`);
    return;
  }
  const sample = findSample();
  if (!sample) {
    t.skip('系统里找不到可用的测试视频');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'nebula-mpv-'));
  const video = join(dir, 'sample.mp4');
  copyFileSync(sample, video);

  const seen: Array<{ status: string; position: number }> = [];
  const c = new MpvController({
    mpvPath: MPV,
    hardwareDecode: false,
    extraArgs: ['--vo=null', '--audio=no', '--no-osc', '--no-config'],
  });
  c.on('state', (s: { status: string; position: number }) => {
    seen.push({ status: s.status, position: s.position });
  });

  try {
    await c.play({
      itemId: 'test-item',
      url: video,
      headers: {},
      title: 'sample',
      startAt: 0,
      subtitles: [],
    });

    const duration = await waitFor(
      () => (c.getState().duration > 0 ? c.getState().duration : null),
      20000,
      'mpv 报告 duration',
    );
    assert.ok(duration > 0, `duration 应大于 0，实际 ${duration}`);

    // 播放状态应推进到 playing
    await waitFor(
      () => (c.getState().status === 'playing' ? true : null),
      10000,
      '状态变为 playing',
    );

    // position 应随时间增长（证明真的在解码推进，而不是只拿到了元数据）
    const p0 = c.getState().position;
    const advanced = await waitFor(
      () => (c.getState().position > p0 + 0.3 ? c.getState().position : null),
      12000,
      'position 增长',
    );
    assert.ok(advanced > p0, `position 应增长：${p0} → ${advanced}`);

    // seek 到中段
    const mid = Math.max(1, Math.floor(duration / 2));
    await c.seek(mid);
    const afterSeek = await waitFor(
      () => (c.getState().position >= mid - 1 ? c.getState().position : null),
      12000,
      'seek 生效',
    );
    assert.ok(afterSeek >= mid - 1, `seek 到 ${mid} 后位置应接近，实际 ${afterSeek}`);

    // 暂停 → 状态回传
    await c.togglePause();
    await waitFor(() => (c.getState().status === 'paused' ? true : null), 8000, '状态变为 paused');
    const pausedAt = c.getState().position;
    await new Promise((r) => setTimeout(r, 700));
    assert.ok(
      Math.abs(c.getState().position - pausedAt) < 0.6,
      `暂停后位置不应继续推进：${pausedAt} → ${c.getState().position}`,
    );

    // 至少收到过 playing 与 paused 两个状态
    const statuses = new Set(seen.map((s) => s.status));
    assert.ok(statuses.has('playing'), `状态序列应包含 playing，实际 ${[...statuses].join(',')}`);
    assert.ok(statuses.has('paused'), `状态序列应包含 paused，实际 ${[...statuses].join(',')}`);
  } finally {
    await c.stop();
    c.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('真实 mpv：打开不存在的文件应进入 error 而不是挂死', async (t) => {
  if (!existsSync(MPV)) {
    t.skip(`缺少 ${MPV}`);
    return;
  }
  const c = new MpvController({
    mpvPath: MPV,
    hardwareDecode: false,
    extraArgs: ['--vo=null', '--audio=no', '--no-config'],
  });
  try {
    await c.play({
      itemId: 'bad',
      url: join(tmpdir(), 'definitely-not-exists-abc123.mkv'),
      headers: {},
      title: 'bad',
      startAt: 0,
      subtitles: [],
    });
    await waitFor(
      () => (c.getState().status === 'error' ? true : null),
      15000,
      '状态变为 error',
    );
    assert.ok(c.getState().error, 'error 状态下应有错误说明');
  } finally {
    await c.stop();
    c.dispose();
  }
});
