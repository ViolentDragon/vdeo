import { createHash } from 'node:crypto';

/** 稳定条目 id：同一 source 下同一路径恒定 */
export function itemId(sourceId: string, path: string): string {
  return createHash('sha1').update(`${sourceId}:${path}`).digest('hex').slice(0, 16);
}

export function sourceId(): string {
  return `src_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 剧集聚合键：标题 + 年份（小写、去标点） */
export function seriesKey(title: string, year: number | null): string {
  const norm = title
    .toLowerCase()
    .replace(/[\s\-_.:：·,，、'"!！?？()（）\[\]【】]+/g, '')
    .replace(/[^\p{Letter}\p{Number}]/gu, '');
  return `${norm}#${year ?? 'unknown'}`;
}
