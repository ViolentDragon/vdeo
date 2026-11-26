import type { AliyunSourceConfig, SourceKind } from '../../shared/types';
import type { StorageProvider } from './types';
import { LocalProvider } from './local';
import { WebdavProvider } from './webdav';
import { AliyunProvider } from './aliyun';
import { decryptSecret } from './secrets';
import { ProviderError } from './types';
import type { AliyunToken } from './aliyun-auth';

export interface ProviderHooks {
  /** 阿里云盘 access_token 轮换后回写持久化，否则下次启动仍用旧 token */
  onAliyunTokenRefreshed?: (sourceId: string, token: AliyunToken) => void;
}

export function createProvider(
  source: { id?: string; kind: SourceKind; config: unknown },
  hooks: ProviderHooks = {},
): StorageProvider {
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

    case 'aliyun': {
      const aliyunCfg = cfg as unknown as AliyunSourceConfig;
      const refreshTokenValue = decryptSecret(String(aliyunCfg.refreshToken ?? ''));
      if (!refreshTokenValue) {
        throw new ProviderError('阿里云盘源的 refresh_token 为空或无法解密，请重新扫码授权');
      }
      const token: AliyunToken = {
        accessToken: decryptSecret(String(aliyunCfg.accessToken ?? '')),
        refreshToken: refreshTokenValue,
        expiresAt: Number(aliyunCfg.expiresAt ?? 0),
        userName: aliyunCfg.userName ?? null,
        userId: null,
        driveId: aliyunCfg.driveId ?? null,
      };
      const sourceId = source.id ?? '';
      return new AliyunProvider(aliyunCfg, token, (next) => {
        hooks.onAliyunTokenRefreshed?.(sourceId, next);
      });
    }

    case 'baidu':
      throw new ProviderError(
        '百度网盘直连尚未接入。推荐用 Alist / OpenList 把百度网盘挂成 WebDAV，再在本应用添加 WebDAV 源。' +
          '（官方开放平台需要审核应用，暂未内置 OAuth 流程。）',
      );

    default:
      throw new ProviderError(`不支持的源类型：${String(source.kind)}`);
  }
}
