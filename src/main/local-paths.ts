import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { LocalPathListing, LocalPathMode } from '../shared/ipc-contract';

const windows = process.platform === 'win32';
const byName = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

async function listVolumes(): Promise<LocalPathListing> {
  const roots = windows
    ? Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ', (letter) => `${letter}:\\`)
    : ['/'];
  const volumes = await Promise.all(roots.map(async (path) => {
    const info = await stat(path).catch(() => null);
    return info?.isDirectory() ? { name: path, path, directory: true } : null;
  }));
  return { path: '', parent: '', entries: volumes.filter((volume) => volume !== null) };
}

export async function listLocalPaths(home: string, mode: LocalPathMode, requested?: string): Promise<LocalPathListing> {
  if (mode !== 'directory' && mode !== 'executable') throw new Error('无效的文件选择类型');
  if (requested === '') return listVolumes();
  const location = requested ?? home;
  if (!isAbsolute(location) || (windows && /^[\\/]{2}[.?][\\/]/.test(location))) {
    throw new Error('请输入完整的本地路径');
  }
  const path = resolve(location);
  const parent = dirname(path);
  const children = await readdir(path, { withFileTypes: true });
  const listed = await Promise.all(children.map(async (entry) => {
    const entryPath = join(path, entry.name);
    const info = entry.isSymbolicLink() ? await stat(entryPath).catch(() => null) : entry;
    if (!info) return null;
    const directory = info.isDirectory();
    if (!directory) {
      if (mode !== 'executable' || !info.isFile()) return null;
      const executable = windows ? /\.exe$/i.test(entry.name)
        : await access(entryPath, constants.X_OK).then(() => true, () => false);
      if (!executable) return null;
    }
    return { name: entry.name, path: entryPath, directory };
  }));
  const entries = listed.filter((entry) => entry !== null)
    .sort((a, b) => Number(b.directory) - Number(a.directory) || byName.compare(a.name, b.name));
  return { path, parent: path === parent ? '' : parent, entries };
}
