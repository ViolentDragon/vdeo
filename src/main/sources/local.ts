import { readdir, stat, readFile, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';
import type { ProviderTestResult, RemoteEntry, ResolvedMedia, StorageProvider } from './types';
import { ProviderError } from './types';

const STAT_CONCURRENCY = 24;

export class LocalProvider implements StorageProvider {
  readonly kind = 'local' as const;

  constructor(private readonly roots: string[]) {}

  async test(): Promise<ProviderTestResult> {
    const results: string[] = [];
    let ok = 0;
    for (const root of this.roots) {
      try {
        await access(root, FS.R_OK);
        const entries = await readdir(root);
        ok += 1;
        results.push(`${root} — 可访问，${entries.length} 项`);
      } catch (err) {
        results.push(`${root} — 不可访问（${err instanceof Error ? err.message : String(err)}）`);
      }
    }
    return { ok: ok === this.roots.length && this.roots.length > 0, message: results.join('\n'), entryCount: ok };
  }

  async list(dirPath: string): Promise<RemoteEntry[]> {
    let dirents;
    try {
      dirents = await readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      throw new ProviderError(
        `无法读取目录 ${dirPath}：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const entries: RemoteEntry[] = [];
    const queue = [...dirents];
    const workers: Promise<void>[] = [];
    const worker = async (): Promise<void> => {
      for (;;) {
        const d = queue.shift();
        if (!d) return;
        const full = join(dirPath, d.name);
        let size = 0;
        let mtime = 0;
        let isDir = d.isDirectory();
        if (d.isSymbolicLink()) {
          try {
            const st = await stat(full);
            isDir = st.isDirectory();
            size = st.size;
            mtime = st.mtimeMs;
          } catch {
            continue;
          }
        } else if (!isDir) {
          try {
            const st = await stat(full);
            size = st.size;
            mtime = st.mtimeMs;
          } catch {
            continue;
          }
        }
        entries.push({ path: normalize(full), name: d.name, isDir, size, mtime: Math.round(mtime) });
      }
    };
    for (let i = 0; i < STAT_CONCURRENCY; i += 1) workers.push(worker());
    await Promise.all(workers);
    return entries;
  }

  async resolvePlayUrl(path: string): Promise<ResolvedMedia> {
    try {
      await access(path, FS.R_OK);
    } catch {
      throw new ProviderError(`文件不可访问：${path}`);
    }
    return { url: path, headers: {} };
  }

  async readText(path: string, maxBytes = 256 * 1024): Promise<string | null> {
    try {
      const buf = await readFile(path);
      return buf.subarray(0, Math.min(buf.length, maxBytes)).toString('utf8');
    } catch {
      return null;
    }
  }

  /** 本地源可以用 dirname/basename，避免跨平台分隔符混用 */
  static dirname(p: string): string {
    return dirname(p);
  }

  static basename(p: string): string {
    return basename(p);
  }
}
