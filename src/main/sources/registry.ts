import type { SourceKind } from '../../shared/types';
import type { StorageProvider } from './types';
import { LocalProvider } from './local';
import { WebdavProvider } from './webdav';
import { decryptSecret } from './secrets';
import { ProviderError } from './types';

export function createProvider(source: { kind: SourceKind; config: unknown }): StorageProvider {
  const cfg = source.config as Record<string, unknown>;
  switch (source.kind) {
    case 'local':
      return new LocalProvider((cfg['roots'] as string[] | undefined) ?? []);
    case 'webdav':
      return new WebdavProvider({
        kind: 'webdav',
        url: String(cfg['url'] ?? ''),
        username: String(cfg['username'] ?? ''),
        password: decryptSecret(String(cfg['password'] ?? '')),
        root: String(cfg['root'] ?? '/'),
      });
    case 'aliyun':
      throw new ProviderError(
        '阿里云盘直连尚未接入。推荐用 Alist / OpenList 把阿里云盘挂成 WebDAV，再在本应用添加 WebDAV 源——' +
          '这样百度网盘、夸克、115、OneDrive、Google Drive 也能一并接入。',
      );
    case 'baidu':
      throw new ProviderError(
        '百度网盘直连尚未接入。推荐用 Alist / OpenList 把百度网盘挂成 WebDAV，再在本应用添加 WebDAV 源。' +
          '（官方开放平台需要审核应用，暂未内置 OAuth 流程。）',
      );
    default:
      throw new ProviderError(`不支持的源类型：${String(source.kind)}`);
  }
}
