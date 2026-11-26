import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 主进程文件日志。
 * 打包后的 GUI 应用没有控制台，console.* 的输出会丢失——闪退时无任何线索。
 * 这里同时写 stdout（开发模式可见）与 userData/logs/main.log（打包后可见）。
 */

const MAX_BYTES = 2 * 1024 * 1024;
let logFile: string | null = null;

export function initLogger(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'main.log');
  try {
    const st = statSync(file);
    if (st.size > MAX_BYTES) renameSync(file, join(dir, 'main.prev.log'));
  } catch {
    /* 首次运行无文件 */
  }
  logFile = file;
  return file;
}

export function getLogPath(): string | null {
  return logFile;
}

function serialize(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function log(...parts: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${parts.map(serialize).join(' ')}\n`;
  if (logFile) {
    try {
      appendFileSync(logFile, line);
    } catch {
      /* 写日志失败不能影响主流程 */
    }
  }
  try {
    process.stdout.write(line);
  } catch {
    /* 无 stdout 时忽略 */
  }
}
