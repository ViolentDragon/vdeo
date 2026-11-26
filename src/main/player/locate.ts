import { accessSync, constants as FS } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

const CANDIDATE_NAMES = ['mpv.exe', 'mpv'];

function isExecutable(p: string): boolean {
  try {
    accessSync(p, FS.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 在 PATH 里找 mpv（不依赖 shell，避免注入与引号问题） */
async function findOnPath(): Promise<string | null> {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFile(cmd, ['mpv'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      resolve(first && isExecutable(first) ? first : null);
    });
  });
}

/** 常见安装位置，覆盖 scoop / choco / 便携版 / 应用自带 */
function candidatePaths(): string[] {
  const out: string[] = [];
  const env = process.env;
  const bases = [env['ProgramFiles'], env['ProgramFiles(x86)'], env['LOCALAPPDATA'], env['APPDATA'], env['USERPROFILE']];
  for (const base of bases) {
    if (!base) continue;
    for (const name of CANDIDATE_NAMES) {
      out.push(join(base, 'mpv', name));
      out.push(join(base, 'Programs', 'mpv', name));
      out.push(join(base, 'scoop', 'apps', 'mpv', 'current', name));
      out.push(join(base, 'chocolatey', 'bin', name));
    }
  }
  if (process.platform !== 'win32') {
    out.push('/usr/bin/mpv', '/usr/local/bin/mpv', '/opt/homebrew/bin/mpv', '/snap/bin/mpv');
  }
  return out;
}

export interface MpvLocation {
  path: string | null;
  source: 'configured' | 'path' | 'candidate' | 'none';
  message: string;
}

export async function locateMpv(configured: string | null): Promise<MpvLocation> {
  if (configured) {
    if (isExecutable(configured)) {
      return { path: configured, source: 'configured', message: '使用设置中指定的 mpv' };
    }
    return {
      path: null,
      source: 'none',
      message: `设置里指定的 mpv 路径不可执行：${configured}`,
    };
  }
  const onPath = await findOnPath();
  if (onPath) return { path: onPath, source: 'path', message: `在 PATH 中找到 mpv：${onPath}` };

  for (const c of candidatePaths()) {
    if (isExecutable(c)) return { path: c, source: 'candidate', message: `在常见安装位置找到 mpv：${c}` };
  }
  return {
    path: null,
    source: 'none',
    message:
      '未找到 mpv。可在设置中指定 mpv.exe 路径，或先安装 mpv（choco install mpv / 从 mpv.io 下载便携版）。' +
      '未找到 mpv 时仍可用外部播放器播放。',
  };
}

/** 外部播放器：未配置时用系统默认打开方式 */
export function resolveExternalCommand(template: string | null): { cmd: string; args: (url: string) => string[] } | null {
  if (!template || !template.trim()) return null;
  const parts = template.trim().split(/\s+/);
  const cmd = parts.shift()!;
  const prefixArgs = parts;
  return { cmd, args: (url: string) => [...prefixArgs, url] };
}
