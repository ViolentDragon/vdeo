import type { ScanFolderRef, ScanScope, StorageSource } from '../../shared/types';
import type { RemoteEntry, StorageProvider } from '../sources/types';

export async function listSourceDirectory(
  source: StorageSource, provider: StorageProvider, parent = '',
): Promise<{ parent: string; entries: RemoteEntry[] }> {
  const config = source.config;
  if (config.kind === 'local' && !parent && config.roots.length !== 1) {
    return {
      parent: '',
      entries: config.roots.map((root) => ({ path: root, name: root, isDir: true, size: 0, mtime: 0 })),
    };
  }
  const path = parent || (config.kind === 'local' ? config.roots[0] ?? '' : config.root || '');
  return { parent: path, entries: await provider.list(path) };
}

export async function validateScanScope(
  source: StorageSource, provider: StorageProvider, scope: ScanScope,
): Promise<ScanScope> {
  if (scope?.mode === 'all') return { mode: 'all' };
  if (scope?.mode !== 'custom' || !Array.isArray(scope.folders) || !scope.folders.length) {
    throw new Error('请至少选择一个要扫描的文件夹');
  }
  if (scope.folders.length > 200) throw new Error('最多选择 200 个扫描文件夹');

  const listings = new Map<string, RemoteEntry[]>();
  const selected = new Map<string, ScanFolderRef[]>();
  for (const requested of scope.folders) {
    if (!Array.isArray(requested) || !requested.length || requested.length > 64) {
      throw new Error('扫描目录路径无效');
    }
    const trail: ScanFolderRef[] = [];
    let parent = '';
    for (const ref of requested) {
      if (typeof ref?.path !== 'string' || !ref.path) throw new Error('扫描目录路径无效');
      let entries = listings.get(parent);
      if (!entries) {
        entries = (await listSourceDirectory(source, provider, parent)).entries;
        listings.set(parent, entries);
      }
      const found = entries.find((entry) => entry.isDir && entry.path === ref.path);
      if (!found) throw new Error('所选文件夹已移除或移动，请刷新目录后重新选择');
      trail.push({ path: found.path, name: found.name });
      parent = found.path;
    }
    selected.set(parent, trail);
  }

  const folders = [...selected.values()].filter((trail) =>
    !trail.slice(0, -1).some((folder) => selected.has(folder.path)));
  if (!folders.length) throw new Error('请至少选择一个要扫描的文件夹');
  return { mode: 'custom', folders };
}

export function sourceScanRoots(source: StorageSource): Array<{ path: string; displayPath: string }> {
  const config = source.config;
  const scope = config.scanScope;
  if (scope?.mode === 'pending') throw new Error('请先设置该存储源的扫描范围');
  if (scope?.mode === 'custom') {
    if (!scope.folders.length) throw new Error('请先设置该存储源的扫描范围');
    return scope.folders.map((trail) => {
      const folder = trail.at(-1);
      if (!folder) throw new Error('扫描目录路径无效');
      return {
        path: folder.path,
        displayPath: config.kind === 'aliyun' ? trail.map((part) => part.name).join('/') : folder.path,
      };
    });
  }
  const roots = config.kind === 'local' ? config.roots : [config.root || '/'];
  return roots.map((path) => ({
    path, displayPath: config.kind === 'local' || config.kind === 'webdav' ? path : '',
  }));
}
