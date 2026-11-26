import { existsSync } from 'node:fs';
import type { ExternalPlayerInfo, PlayerConfig } from '../../shared/types';

/**
 * 外部播放器支持。
 *
 * 两个历史缺陷在这里修掉：
 *  1. 旧实现用 `template.split(/\s+/)` 解析命令——路径带空格（"C:\Program Files\..."）会被拆碎。
 *     现在用引号感知的 splitArgs。
 *  2. 旧实现没有探测，用户得自己抄路径。现在按预设表扫常见安装位置。
 */

export interface ExternalPlayerPreset {
  id: string;
  name: string;
  /** 候选可执行路径，支持 %VAR% 环境变量；空数组表示系统默认打开方式 */
  candidates: string[];
  defaultArgs: string;
  system?: boolean;
}

export const EXTERNAL_PLAYER_PRESETS: ExternalPlayerPreset[] = [
  {
    id: 'system',
    name: '系统默认程序',
    candidates: [],
    defaultArgs: '{url}',
    system: true,
  },
  {
    id: 'potplayer',
    name: 'PotPlayer',
    candidates: [
      '%ProgramFiles%/DAUM/PotPlayer/PotPlayerMini64.exe',
      '%ProgramFiles(x86)%/DAUM/PotPlayer/PotPlayerMini64.exe',
      '%ProgramFiles%/DAUM/PotPlayer/PotPlayerMini.exe',
      '%ProgramFiles(x86)%/DAUM/PotPlayer/PotPlayerMini.exe',
      '%APPDATA%/PotPlayerMini64/PotPlayerMini64.exe',
    ],
    defaultArgs: '"{url}"',
  },
  {
    id: 'vlc',
    name: 'VLC',
    candidates: [
      '%ProgramFiles%/VideoLAN/VLC/vlc.exe',
      '%ProgramFiles(x86)%/VideoLAN/VLC/vlc.exe',
    ],
    defaultArgs: '"{url}"',
  },
  {
    id: 'mpc-hc',
    name: 'MPC-HC',
    candidates: [
      '%ProgramFiles%/MPC-HC/mpc-hc64.exe',
      '%ProgramFiles(x86)%/MPC-HC/mpc-hc.exe',
      '%LOCALAPPDATA%/MPC-HC/mpc-hc64.exe',
    ],
    defaultArgs: '"{url}"',
  },
  {
    id: 'mpc-be',
    name: 'MPC-BE',
    candidates: [
      '%ProgramFiles%/MPC-BE x64/mpc-be64.exe',
      '%ProgramFiles(x86)%/MPC-BE/mpc-be.exe',
    ],
    defaultArgs: '"{url}"',
  },
  {
    id: 'mpv',
    name: 'mpv（独立窗口）',
    candidates: [
      '%ProgramFiles%/mpv/mpv.exe',
      '%LOCALAPPDATA%/Programs/mpv/mpv.exe',
      '%USERPROFILE%/scoop/apps/mpv/current/mpv.exe',
    ],
    defaultArgs: '"{url}"',
  },
  {
    id: 'custom',
    name: '自定义…',
    candidates: [],
    defaultArgs: '"{url}"',
  },
];

/** 展开 %VAR% 形式的环境变量；找不到时保留原样，便于在错误信息里看清是哪一项 */
export function expandEnv(template: string): string {
  return template.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);
}

/**
 * 引号感知的参数拆分。
 * 支持 "C:\Program Files\VLC\vlc.exe" --fullscreen，也支持单引号与无引号裸路径。
 */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || cur.length > 0) {
        out.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started || cur.length > 0) out.push(cur);
  return out;
}

export interface ArgVars {
  url: string;
  title?: string;
  start?: number;
}

/**
 * 参数模板替换。
 * 先按引号规则拆 token，再在 token 内替换占位符——这样带空格的路径作为单个参数传给 spawn，
 * 不需要（也不应该）再手工加引号。
 */
export function buildArgs(template: string, vars: ArgVars): string[] {
  const map: Record<string, string> = {
    url: vars.url,
    title: vars.title ?? '',
    start: vars.start && vars.start > 0 ? String(Math.floor(vars.start)) : '0',
  };
  return splitArgs(template).map((token) =>
    token.replace(/\{(url|title|start)\}/g, (_m, key: string) => map[key] ?? ''),
  );
}

/** 扫描预设表，返回每个播放器的探测结果（未安装的 path 为 null） */
export function detectExternalPlayers(): ExternalPlayerInfo[] {
  return EXTERNAL_PLAYER_PRESETS.map((preset) => {
    if (preset.system) {
      return { id: preset.id, name: preset.name, path: null, defaultArgs: preset.defaultArgs, system: true };
    }
    const hit = preset.candidates.map(expandEnv).find((c) => existsSync(c)) ?? null;
    return { id: preset.id, name: preset.name, path: hit, defaultArgs: preset.defaultArgs, system: false };
  });
}

export interface ExternalLaunch {
  /** null 表示交给系统默认程序打开（shell.openPath） */
  cmd: string | null;
  args: string[];
}

export type LaunchResolution =
  | { ok: true; launch: ExternalLaunch }
  | { ok: false; error: string };

/**
 * 根据配置与探测结果算出实际要执行的命令。
 * 不给默认兜底：播放器没装就明确报错，而不是静默换成别的播放器让用户以为配置生效了。
 */
export function resolveExternalLaunch(
  config: PlayerConfig,
  detected: ExternalPlayerInfo[],
  vars: ArgVars,
): LaunchResolution {
  const id = config.externalId || 'system';

  if (id === 'system') {
    return { ok: true, launch: { cmd: null, args: [] } };
  }

  if (id === 'custom') {
    const path = (config.externalPath ?? '').trim();
    if (!path) return { ok: false, error: '未填写自定义播放器路径' };
    if (!existsSync(path)) return { ok: false, error: `自定义播放器不存在：${path}` };
    const template = config.externalArgs?.trim() || '{url}';
    return { ok: true, launch: { cmd: path, args: buildArgs(template, vars) } };
  }

  const info = detected.find((d) => d.id === id);
  if (!info) return { ok: false, error: `未知的外部播放器：${id}` };
  if (!info.path) {
    return {
      ok: false,
      error: `未找到 ${info.name}。请先安装，或在设置里选择「自定义…」手动指定可执行文件。`,
    };
  }
  const template = config.externalArgs?.trim() || info.defaultArgs;
  return { ok: true, launch: { cmd: info.path, args: buildArgs(template, vars) } };
}

/** 从旧的 "完整命令字符串" 迁移成 { path, argsTemplate } */
export function migrateLegacyCommand(command: string): { externalId: string; externalPath: string; externalArgs: string } {
  const tokens = splitArgs(command);
  if (tokens.length === 0) {
    return { externalId: 'system', externalPath: '', externalArgs: '{url}' };
  }
  const [exe, ...rest] = tokens;
  const argsTemplate = rest.length > 0 ? [...rest, '{url}'].join(' ') : '"{url}"';
  return { externalId: 'custom', externalPath: exe ?? '', externalArgs: argsTemplate };
}
