import type { SourceKind } from '../../shared/types';

export interface RemoteEntry {
  /** provider 内部完整路径 */
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  /** 毫秒时间戳，未知时 0 */
  mtime: number;
}

export interface ResolvedMedia {
  url: string;
  headers: Record<string, string>;
}

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  /** 顺带探测到的目录数量，便于用户确认挂对了位置 */
  entryCount?: number;
}

export interface StorageProvider {
  readonly kind: SourceKind;
  test(): Promise<ProviderTestResult>;
  list(dirPath: string): Promise<RemoteEntry[]>;
  /** 交给 mpv / 外部播放器的地址；某些网盘需要附带请求头 */
  resolvePlayUrl(path: string): Promise<ResolvedMedia>;
  /** 读取小文本（.nfo 等），不支持时返回 null */
  readText?(path: string, maxBytes?: number): Promise<string | null>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** 把远端路径切成逐级目录，用于父目录推导 */
export function parentOf(p: string): string | null {
  const normalized = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return null;
  return normalized.slice(0, idx);
}

export function joinPath(base: string, name: string): string {
  const b = base.replace(/\/+$/, '');
  return b ? `${b}/${name}` : `/${name}`;
}

export function baseName(p: string): string {
  const normalized = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}
