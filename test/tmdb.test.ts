import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { createRepository } from '../src/main/db';
import { createTmdbClient, normalizeTmdbCredential, TMDB_CREDENTIAL_KEY, type TmdbWork } from '../src/main/metadata/tmdb';
import { TmdbSync } from '../src/main/metadata/sync';
import { scanSource } from '../src/main/scan/scanner';
import type { StorageProvider } from '../src/main/sources/types';
import type { TmdbSyncStatus } from '../src/shared/tmdb';
import type { StorageSource } from '../src/shared/types';

const TOKEN = 'sample.tmdb.token';
const movie = {
  id: 603, title: '黑客帝国', original_title: 'The Matrix', release_date: '1999-03-31',
  poster_path: '/matrix.jpg', backdrop_path: '/matrix-bg.jpg',
  overview: '电影简介', vote_count: 10, vote_average: 8.7,
};
const series = {
  id: 1, name: '星云故事', original_name: 'Nebula Stories', first_air_date: '2018-06-01',
  poster_path: '/stories.jpg', overview: '剧集简介', vote_count: 5, vote_average: 7.5,
};

test('TMDB uses the official auth formats and rejects ambiguous or mismatched titles', async () => {
  const key = '0'.repeat(32);
  const credential = normalizeTmdbCredential('Bearer ' + TOKEN);
  assert.throws(() => normalizeTmdbCredential('invalid'));
  const mock: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/configuration')) {
      assert.equal(url.searchParams.get('api_key'), key);
      assert.equal(new Headers(init?.headers).has('Authorization'), false);
      return Response.json({ images: {} });
    }
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ' + TOKEN);
    assert.equal(url.pathname, '/3/search/movie');
    assert.ok(['zh-CN', 'en-US'].includes(url.searchParams.get('language') ?? ''));
    assert.equal(url.searchParams.get('include_adult'), 'false');
    return Response.json({ results: [movie, { ...movie, id: 604, release_date: '2021-01-01' }] });
  };
  await createTmdbClient(key, mock).test();
  const client = createTmdbClient(credential, mock);
  const work = { workKey: 'movie:thematrix#1999', kind: 'movie' as const, title: 'The.Matrix', year: 1999 };
  assert.equal((await client.find(work))?.poster, 'https://image.tmdb.org/t/p/w500/matrix.jpg');
  assert.equal(await client.find({ ...work, year: null }), null);
  assert.equal(await client.find({ ...work, year: 2003 }), null);
  assert.equal(await client.find({ ...work, title: 'Another movie' }), null);
  const localized = createTmdbClient(credential, async (input) => {
    const english = new URL(input).searchParams.get('language') === 'en-US';
    return Response.json({ results: [{
      ...movie, title: english ? 'Spirited Away' : '千与千寻', original_title: '千と千尋の神隠し', release_date: '2001-07-20',
    }] });
  });
  assert.equal((await localized.find({ ...work, title: 'Spirited Away', year: 2001 }))?.id, movie.id);
  await assert.rejects(createTmdbClient(key, async () => new Response(null, { status: 429 })).test(), /请求过于频繁/);
});

test('scan and TMDB backfill share one record per work and retain metadata across rescans', async () => {
  const repo = createRepository(':memory:');
  const source: StorageSource = {
    id: 'source1', kind: 'local', name: '测试库', config: { kind: 'local', roots: ['/library'] },
    enabled: true, lastScanAt: null, lastScanCount: 0, lastError: null, createdAt: Date.now(),
  };
  const names = ['The.Matrix.1999.1080p.mkv', 'The.Matrix.1999.2160p.mkv',
    '星云故事.S01E01.mkv', '星云故事.S02E01.mkv', '星云故事.poster.jpg', 'track.mp3'];
  const provider: StorageProvider = {
    kind: 'local',
    test: async () => ({ ok: true, message: '' }),
    list: async () => names.map((name) => ({ name, path: '/library/' + name, isDir: false, size: 1, mtime: 1 })),
    resolvePlayUrl: async (path) => ({ url: path, headers: {} }),
  };
  const requests: string[] = [];
  const clientFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    return Response.json({ results: [url.pathname.endsWith('/movie') ? movie : series] });
  };
  const emitter = new EventEmitter();
  const sync = new TmdbSync(repo, () => TOKEN, clientFetch, (status) => {
    if (status.phase !== 'running') emitter.emit('settled', status);
  });
  try {
    repo.insertSource(source);
    repo.setSetting(TMDB_CREDENTIAL_KEY, 'encrypted');
    assert.equal(repo.getSetting(TMDB_CREDENTIAL_KEY), 'encrypted');
    assert.equal(Object.hasOwn(repo.getAllSettings(), TMDB_CREDENTIAL_KEY), false);
    const scan = () => scanSource({ source, provider, repo, ignorePatterns: [] });
    assert.equal((await scan()).found, 6);
    const firstEnd = once(emitter, 'settled');
    sync.enqueue(source.id);
    const [status] = await firstEnd as [TmdbSyncStatus];
    assert.deepEqual(status, { phase: 'done', total: 2, matched: 2, unmatched: 0, error: null });
    assert.deepEqual(requests.sort(), ['/3/search/movie', '/3/search/tv']);
    await scan();
    const catalog = repo.browse({ group: 'catalog', sort: 'rating' });
    assert.equal(catalog.items[0]?.overview, '电影简介');
    assert.equal(catalog.series[0]?.year, 2018);
    assert.equal(catalog.series[0]?.rating, 7.5);
    assert.ok(catalog.series[0]?.posterItemId);
    const seriesKey = catalog.series[0]!.key;
    assert.equal(repo.getSeries(seriesKey)?.summary.overview, '剧集简介');
    assert.equal(repo.getSeries(seriesKey)?.items.length, 2);
    assert.equal(repo.browse({ section: 'movie', sort: 'year' }).items.length, 2);
    const secondEnd = once(emitter, 'settled');
    sync.enqueue();
    assert.equal(((await secondEnd)[0] as TmdbSyncStatus).total, 0);
    assert.equal(requests.length, 2);
  } finally {
    sync.cancel();
    repo.close();
  }
});

test('TMDB search retries once after Retry-After and stops on a longer rate limit', async () => {
  const work: TmdbWork = { workKey: 'matrix', kind: 'movie', title: 'The Matrix', year: 1999 };
  const starts: number[] = [];
  const client = createTmdbClient(TOKEN, async () => {
    starts.push(performance.now());
    if (starts.length === 1) return new Response(null, { status: 429, headers: { 'Retry-After': '1' } });
    return Response.json({ results: [movie] });
  });
  assert.equal((await client.find(work))?.id, movie.id);
  assert.equal(starts.length, 2);
  assert.ok(starts[1]! - starts[0]! >= 1_000);

  let rejected = 0;
  const limited = createTmdbClient(TOKEN, async () => {
    rejected += 1;
    return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });
  });
  await assert.rejects(limited.find(work), /请求过于频繁/);
  assert.equal(rejected, 1);
});

test('TMDB backfill limits concurrency and deduplicates sources queued during a run', { timeout: 5000 }, async () => {
  const works: TmdbWork[] = Array.from({ length: 13 }, (_, index) => ({
    workKey: String(index), title: 'File ' + index, year: 1999, kind: 'movie',
  }));
  const saved: string[] = [];
  const scope: Array<string[] | null> = [];
  const reachedCapacity = new EventEmitter();
  let releaseRequests!: () => void;
  const responseReady = new Promise<void>((resolve) => { releaseRequests = resolve; });
  let inFlight = 0;
  let peak = 0;
  const sync = new TmdbSync({
    listTmdbWorks(sourceIds) {
      scope.push(sourceIds);
      return sourceIds?.includes('second') ? [works[0]!, works[12]!] : works.slice(0, 12);
    },
    saveTmdbMetadata(workKey) { saved.push(workKey); },
  }, () => TOKEN, async (input) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    if (inFlight === 8) reachedCapacity.emit('ready');
    await responseReady;
    inFlight -= 1;
    const title = new URL(input).searchParams.get('query');
    return Response.json({ results: [{ ...movie, title }] });
  }, (status) => {
    if (status.phase !== 'running') reachedCapacity.emit('settled', status);
  });

  try {
    const ready = once(reachedCapacity, 'ready');
    const settled = once(reachedCapacity, 'settled');
    sync.enqueue('first');
    await ready;
    sync.enqueue('second');
    releaseRequests();
    const [status] = await settled as [TmdbSyncStatus];
    assert.deepEqual(status, { phase: 'done', total: 13, matched: 13, unmatched: 0, error: null });
    assert.equal(peak, 8);
    assert.deepEqual(scope, [['first'], ['second']]);
    assert.deepEqual(new Set(saved), new Set(works.map((work) => work.workKey)));
  } finally {
    sync.cancel();
    releaseRequests();
  }
});

test('TMDB cancellation aborts active and paced requests without saving incomplete lookups', { timeout: 5_000 }, async () => {
  const works: TmdbWork[] = Array.from({ length: 16 }, (_, index) => ({
    workKey: String(index), title: 'File ' + index, year: 1999, kind: 'movie',
  }));
  const emitter = new EventEmitter();
  const saved: string[] = [];
  let cancelledFetch = false;
  let requests = 0;
  const sync = new TmdbSync({
    listTmdbWorks: () => works,
    saveTmdbMetadata(workKey) { saved.push(workKey); },
  }, () => TOKEN, async (input, init) => {
    requests += 1;
    const title = new URL(input).searchParams.get('query');
    if (title === 'File 0') return Response.json({ results: [{ ...movie, title }] });
    emitter.emit('pending');
    try {
      await delay(60_000, undefined, { signal: init?.signal ?? undefined });
      return Response.json({ results: [] });
    } finally {
      cancelledFetch = Boolean(init?.signal?.aborted);
    }
  }, (status) => {
    if (status.phase !== 'running') emitter.emit('settled', status);
  });

  try {
    const pending = once(emitter, 'pending');
    const settled = once(emitter, 'settled');
    sync.enqueue();
    await pending;
    sync.cancel();
    const [status] = await settled as [TmdbSyncStatus];
    assert.deepEqual(status, { phase: 'cancelled', total: 16, matched: 1, unmatched: 0, error: null });
    assert.deepEqual(saved, ['0']);
    assert.equal(requests, 2);
    assert.equal(cancelledFetch, true);
  } finally {
    sync.cancel();
  }
});
