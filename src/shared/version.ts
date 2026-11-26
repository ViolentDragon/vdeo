/**
 * 版本号比较（主进程与渲染层共用）。
 *
 * 支持：`0.1.0`、`v0.1.0`、`1.2.3-beta.1`、`1.2.3+build`。
 * 规则遵循 semver 的常用子集：
 *   - 逐段比较数字，缺位补 0（1.0 == 1.0.0）
 *   - 正式版 > 同号预发布版（1.0.0 > 1.0.0-beta）
 *   - 预发布版之间按字符串比较（beta < rc）
 */

export interface ParsedVersion {
  nums: number[];
  pre: string | null;
}

export function parseVersion(input: string): ParsedVersion {
  const cleaned = (input ?? '').trim().replace(/^v/i, '').split('+')[0] ?? '';
  const dash = cleaned.indexOf('-');
  const main = dash >= 0 ? cleaned.slice(0, dash) : cleaned;
  const pre = dash >= 0 ? cleaned.slice(dash + 1) : null;
  const nums = main.split('.').map((seg) => {
    const digits = seg.replace(/[^\d].*$/, '');
    const n = Number(digits);
    return Number.isFinite(n) ? n : 0;
  });
  return { nums, pre: pre && pre.length > 0 ? pre : null };
}

/** a > b 返回 1，a < b 返回 -1，相等返回 0 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa.nums[i] ?? 0;
    const y = pb.nums[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

/** 是否有可用更新：远端版本严格高于当前版本 */
export function isNewer(current: string, latest: string): boolean {
  return compareVersions(latest, current) > 0;
}
