import { net } from 'electron';
import type { UpdateAsset, UpdateInfo } from '../shared/types';
import { isNewer } from '../shared/version';
import { log } from './logger';

/**
 * 检查 GitHub Release 上的新版本。
 *
 * 用 Electron 的 net.fetch（Chromium 网络栈）而不是全局 fetch：
 * 本机 git 走 OpenSSL 时曾因证书链不一致报 "no alternative certificate subject name"，
 * Chromium 栈与系统证书库一致，能避开这类问题。
 *
 * 采用匿名请求（未认证 60 次/小时），不把任何 token 放进客户端。
 */

export const UPDATE_REPO = 'ViolentDragon/vdeo';
const API_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
const TIMEOUT_MS = 15000;

interface GithubRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  published_at?: string;
  body?: string;
  assets?: Array<{ name?: string; size?: number; browser_download_url?: string }>;
}

function emptyInfo(currentVersion: string, error: string | null): UpdateInfo {
  return {
    currentVersion,
    latestVersion: null,
    hasUpdate: false,
    releaseUrl: null,
    releaseName: null,
    publishedAt: null,
    notes: null,
    assets: [],
    error,
    checkedAt: Date.now(),
  };
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo> {
  try {
    const res = await net.fetch(API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'nebula-media',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.status === 404) return emptyInfo(currentVersion, '仓库中还没有发布任何版本');
    if (res.status === 403) {
      return emptyInfo(currentVersion, 'GitHub 接口限流（未认证请求每小时 60 次），请稍后再试');
    }
    if (!res.ok) return emptyInfo(currentVersion, `查询失败：HTTP ${res.status}`);

    const data = (await res.json()) as GithubRelease;
    const latestVersion = (data.tag_name ?? '').trim().replace(/^v/i, '') || null;
    if (!latestVersion) return emptyInfo(currentVersion, '远端 release 没有 tag，无法比较版本');

    const assets: UpdateAsset[] = (data.assets ?? [])
      .filter((a) => typeof a.name === 'string' && typeof a.browser_download_url === 'string')
      .map((a) => ({
        name: a.name as string,
        size: typeof a.size === 'number' ? a.size : 0,
        downloadUrl: a.browser_download_url as string,
      }));

    const info: UpdateInfo = {
      currentVersion,
      latestVersion,
      hasUpdate: isNewer(currentVersion, latestVersion),
      releaseUrl: data.html_url ?? null,
      releaseName: data.name ?? null,
      publishedAt: data.published_at ?? null,
      notes: data.body ?? null,
      assets,
      error: null,
      checkedAt: Date.now(),
    };
    log(
      '[update] 检查完成:',
      `当前 ${currentVersion}`,
      '远端',
      latestVersion,
      info.hasUpdate ? '→ 有新版本' : '→ 已是最新',
    );
    return info;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('[update] 检查失败:', message);
    return emptyInfo(currentVersion, `网络不可达或超时：${message}`);
  }
}
