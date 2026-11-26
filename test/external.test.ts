import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildArgs,
  detectExternalPlayers,
  migrateLegacyCommand,
  resolveExternalLaunch,
  splitArgs,
  EXTERNAL_PLAYER_PRESETS,
} from '../src/main/player/external';
import { DEFAULT_PLAYER_CONFIG, type ExternalPlayerInfo, type PlayerConfig } from '../src/shared/types';

/* ------------------------------ 命令解析 ------------------------------ */

test('splitArgs：带空格路径必须整体保留（旧实现 split(/\\s+/) 会拆碎）', () => {
  const parts = splitArgs('"C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe" "{url}"');
  assert.deepEqual(parts, ['C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe', '{url}']);
});

test('splitArgs：单引号与无引号裸路径', () => {
  assert.deepEqual(splitArgs(`'C:\\my player\\vlc.exe' --fullscreen`), ['C:\\my player\\vlc.exe', '--fullscreen']);
  assert.deepEqual(splitArgs('C:\\mpv\\mpv.exe'), ['C:\\mpv\\mpv.exe']);
});

test('splitArgs：中文路径与多空格', () => {
  assert.deepEqual(splitArgs('"D:\\影视\\播放器\\程序.exe"   --x'), ['D:\\影视\\播放器\\程序.exe', '--x']);
});

test('splitArgs：空输入返回空数组', () => {
  assert.deepEqual(splitArgs(''), []);
  assert.deepEqual(splitArgs('   '), []);
});

/* ------------------------------ 参数模板 ------------------------------ */

test('buildArgs：带空格的 url 作为一个参数，不手工加引号', () => {
  const args = buildArgs('"{url}"', { url: 'D:\\影片\\My Movie.mkv' });
  assert.deepEqual(args, ['D:\\影片\\My Movie.mkv']);
});

test('buildArgs：多个占位符与自定义前置参数', () => {
  const args = buildArgs('--start={start} --title={title} "{url}"', {
    url: 'D:\\a b.mkv',
    title: '影片 A',
    start: 125.7,
  });
  assert.deepEqual(args, ['--start=125', '--title=影片 A', 'D:\\a b.mkv']);
});

test('buildArgs：缺省 start 为 0，缺省 title 为空串', () => {
  assert.deepEqual(buildArgs('--start={start} --t={title} "{url}"', { url: 'x.mkv' }), ['--start=0', '--t=', 'x.mkv']);
});

/* ------------------------------ 旧配置迁移 ------------------------------ */

test('migrateLegacyCommand：旧的完整命令字符串迁移成 path + 参数模板', () => {
  const m = migrateLegacyCommand('"C:\\Program Files\\VLC\\vlc.exe" --fullscreen');
  assert.equal(m.externalId, 'custom');
  assert.equal(m.externalPath, 'C:\\Program Files\\VLC\\vlc.exe');
  assert.equal(m.externalArgs, '--fullscreen {url}');
});

test('migrateLegacyCommand：只有 exe 无参数时补上 {url}', () => {
  const m = migrateLegacyCommand('C:\\mpv\\mpv.exe');
  assert.equal(m.externalPath, 'C:\\mpv\\mpv.exe');
  assert.equal(m.externalArgs, '"{url}"');
});

test('migrateLegacyCommand：空串退回系统默认', () => {
  const m = migrateLegacyCommand('');
  assert.equal(m.externalId, 'system');
});

/* ------------------------------ 启动解析 ------------------------------ */

const detected: ExternalPlayerInfo[] = [
  { id: 'system', name: '系统默认程序', path: null, defaultArgs: '{url}', system: true },
  { id: 'vlc', name: 'VLC', path: 'C:\\VLC\\vlc.exe', defaultArgs: '"{url}"', system: false },
  { id: 'potplayer', name: 'PotPlayer', path: null, defaultArgs: '"{url}"', system: false },
];

function cfg(patch: Partial<PlayerConfig>): PlayerConfig {
  return { ...DEFAULT_PLAYER_CONFIG, ...patch };
}

test('resolveExternalLaunch：system 交给 shell.openPath（cmd 为 null）', () => {
  const r = resolveExternalLaunch(cfg({ externalId: 'system' }), detected, { url: 'x.mkv' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.launch.cmd, null);
    assert.deepEqual(r.launch.args, []);
  }
});

test('resolveExternalLaunch：预设已安装时给出 cmd 与 args', () => {
  const r = resolveExternalLaunch(cfg({ externalId: 'vlc' }), detected, { url: 'D:\\a b.mkv' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.launch.cmd, 'C:\\VLC\\vlc.exe');
    assert.deepEqual(r.launch.args, ['D:\\a b.mkv']);
  }
});

test('resolveExternalLaunch：预设未安装时明确报错，不静默换成别的', () => {
  const r = resolveExternalLaunch(cfg({ externalId: 'potplayer' }), detected, { url: 'x.mkv' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /未找到 PotPlayer/);
});

test('resolveExternalLaunch：custom 路径不存在时明确报错', () => {
  const r = resolveExternalLaunch(
    cfg({ externalId: 'custom', externalPath: 'C:\\nope\\nope.exe' }),
    detected,
    { url: 'x.mkv' },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /不存在/);
});

test('resolveExternalLaunch：custom 未填路径时提示填写', () => {
  const r = resolveExternalLaunch(cfg({ externalId: 'custom', externalPath: '  ' }), detected, { url: 'x.mkv' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /未填写/);
});

test('resolveExternalLaunch：未知播放器 id 报错', () => {
  const r = resolveExternalLaunch(cfg({ externalId: 'nonsense' }), detected, { url: 'x.mkv' });
  assert.equal(r.ok, false);
});

/* ------------------------------ 预设与探测 ------------------------------ */

test('预设表包含系统默认与常见播放器，id 唯一', () => {
  const ids = EXTERNAL_PLAYER_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'id 不能重复');
  for (const expected of ['system', 'potplayer', 'vlc', 'mpc-hc', 'mpc-be', 'mpv', 'custom']) {
    assert.ok(ids.includes(expected), `缺少预设 ${expected}`);
  }
});

test('detectExternalPlayers 返回每个预设一项，且 system 永远可用', () => {
  const list = detectExternalPlayers();
  assert.equal(list.length, EXTERNAL_PLAYER_PRESETS.length);
  const sys = list.find((d) => d.id === 'system');
  assert.ok(sys);
  assert.equal(sys.system, true);
  assert.equal(sys.path, null);
  // 未安装的预设 path 必须是 null 而不是空串，UI 靠它区分状态
  for (const item of list) {
    assert.ok(item.path === null || typeof item.path === 'string');
  }
});
