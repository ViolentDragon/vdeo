import { setTimeout as delay } from 'node:timers/promises';

const API_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';
const SEARCH_LANGUAGES = ['zh-CN', 'en-US'];
const REQUEST_INTERVAL_MS = 60;
const RATE_LIMIT_INTERVAL_MS = 150;
const DEFAULT_RETRY_AFTER_MS = 2_000;
const MAX_RETRY_AFTER_MS = 30_000;
export const TMDB_CREDENTIAL_KEY = 'tmdbCredential';
export type TmdbFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface TmdbWork {
  workKey: string;
  kind: 'movie' | 'tv';
  title: string;
  year: number | null;
}

export interface TmdbMetadata {
  id: number;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  overview: string | null;
  rating: number | null;
}

interface SearchResult {
  id: number;
  title?: string;
  original_title?: string;
  name?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  vote_count?: number;
}

function titleKey(value: string | undefined): string {
  return (typeof value === 'string' ? value : '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
}

function yearOf(result: SearchResult, kind: TmdbWork['kind']): number | null {
  const date = kind === 'movie' ? result.release_date : result.first_air_date;
  return typeof date === 'string' && /^\d{4}-/.test(date) ? Number(date.slice(0, 4)) : null;
}

function imageUrl(path: string | null | undefined, size: 'w500' | 'w1280'): string | null {
  return typeof path === 'string' && /^\/[a-z0-9_-]+\.(?:jpe?g|png|webp)$/i.test(path)
    ? IMAGE_BASE + '/' + size + path
    : null;
}

export function normalizeTmdbCredential(value: string): string {
  const token = value.trim().replace(/^Bearer\s+/i, '');
  if (!/^(?:[a-f0-9]{32}|[\w-]+\.[\w-]+\.[\w-]+)$/i.test(token) || token.length > 4096) {
    throw new Error('请输入 TMDB 的 API 读取访问令牌或 v3 API Key。');
  }
  return token;
}

function retryAfterMs(value: string | null): number {
  if (!value) return DEFAULT_RETRY_AFTER_MS;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? DEFAULT_RETRY_AFTER_MS : Math.max(0, date - Date.now());
}

export function createTmdbClient(credential: string, fetcher: TmdbFetch = fetch) {
  const apiKey = /^[a-f0-9]{32}$/i.test(credential);
  let interval = REQUEST_INTERVAL_MS;
  let nextRequestAt = 0;

  async function request(path: string, params: URLSearchParams, signal?: AbortSignal, retryRateLimit = false): Promise<unknown> {
    if (apiKey) params.set('api_key', credential);
    const url = API_BASE + path + '?' + params.toString();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (!apiKey) headers.Authorization = 'Bearer ' + credential;

    for (let attempt = 0; ; attempt += 1) {
      let wait = nextRequestAt - performance.now();
      while (wait > 0) {
        await delay(Math.ceil(wait), undefined, { signal });
        wait = nextRequestAt - performance.now();
      }
      signal?.throwIfAborted();
      nextRequestAt = performance.now() + interval;

      const timeout = AbortSignal.timeout(12_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const response = await fetcher(url, { headers, signal: requestSignal, redirect: 'error' });
        if (response.status === 429) {
          const waitMs = retryAfterMs(response.headers.get('Retry-After'));
          void response.body?.cancel().catch(() => undefined);
          if (!retryRateLimit || attempt > 0 || waitMs > MAX_RETRY_AFTER_MS) {
            throw new Error('TMDB 请求过于频繁，请稍后重试。');
          }
          interval = RATE_LIMIT_INTERVAL_MS;
          nextRequestAt = Math.max(nextRequestAt, performance.now() + Math.max(waitMs, interval));
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          throw new Error('TMDB 拒绝了此凭据，请检查 API Key 或读取访问令牌。');
        }
        if (!response.ok) throw new Error('TMDB 请求失败（HTTP ' + response.status + '）。');
        return await response.json();
      } catch (err) {
        signal?.throwIfAborted();
        if (timeout.aborted) throw new Error('连接 TMDB 超时，请稍后重试。');
        if (err instanceof Error && err.message.startsWith('TMDB ')) throw err;
        throw new Error('无法读取 TMDB 的响应，请检查网络连接后重试。');
      }
    }
  }

  return {
    async test() {
      const data = await request('/configuration', new URLSearchParams()) as { images?: unknown } | null;
      if (!data?.images) throw new Error('TMDB 返回了无效的配置。');
    },

    async find(work: TmdbWork, signal?: AbortSignal): Promise<TmdbMetadata | null> {
      const key = titleKey(work.title);
      if (!key) return null;
      const params = new URLSearchParams({ query: work.title, include_adult: 'false' });
      if (work.year !== null) params.set(work.kind === 'movie' ? 'primary_release_year' : 'first_air_date_year', String(work.year));
      let match: SearchResult | undefined;
      for (const language of SEARCH_LANGUAGES) {
        params.set('language', language);
        const response = await request('/search/' + work.kind, params, signal, true) as { results?: SearchResult[] } | null;
        if (!Array.isArray(response?.results)) throw new Error('TMDB 返回了无效的搜索结果。');

        const matches = new Map<number, SearchResult>();
        for (const result of response.results) {
          if (!Number.isSafeInteger(result?.id) || result.id <= 0) continue;
          const titles = work.kind === 'movie' ? [result.title, result.original_title] : [result.name, result.original_name];
          if (titles.some((title) => titleKey(title) === key) &&
              (work.year === null || yearOf(result, work.kind) === work.year)) {
            matches.set(result.id, result);
          }
        }
        if (matches.size > 1) return null;
        match = matches.values().next().value;
        if (match) break;
      }
      if (!match) return null;
      return {
        id: match.id,
        year: yearOf(match, work.kind),
        poster: imageUrl(match.poster_path, 'w500'),
        backdrop: imageUrl(match.backdrop_path, 'w1280'),
        overview: typeof match.overview === 'string' ? match.overview.trim() || null : null,
        rating: (match.vote_count ?? 0) > 0 && typeof match.vote_average === 'number' &&
          match.vote_average >= 0 && match.vote_average <= 10 ? match.vote_average : null,
      };
    },
  };
}
