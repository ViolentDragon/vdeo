import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../src/main/db';
import { LocalProvider } from '../src/main/sources/local';
import { scanSource } from '../src/main/scan/scanner';
import type { StorageSource } from '../src/shared/types';

function makeSource(root: string): StorageSource {
  return {
    id: 'src_e2e',
    kind: 'local',
    name: '测试目录',
    config: { kind: 'local', roots: [root] },
    enabled: true,
    lastScanAt: null,
    lastScanCount: 0,
    lastError: null,
    createdAt: Date.now(),
  };
}

test('端到端：真实目录 → 扫描 → 入库 → 分区与剧集聚合 → 重扫幂等', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nebula-e2e-'));
  const movieDir = join(root, '电影');
  const seasonDir = join(root, '剧集', '西部世界', 'Season 2');
  mkdirSync(movieDir, { recursive: true });
  mkdirSync(seasonDir, { recursive: true });

  writeFileSync(join(movieDir, 'The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv'), 'x');
  writeFileSync(join(movieDir, 'Dune.Part.Two.2024.2160p.BluRay.REMUX.mkv'), 'x');
  writeFileSync(join(movieDir, 'cover.jpg'), 'x');
  writeFileSync(join(seasonDir, '03.mkv'), 'x');
  writeFileSync(join(seasonDir, '04.mkv'), 'x');
  // 干扰项：应被忽略
  writeFileSync(join(seasonDir, '04.srt'), 'x');

  const dbFile = join(root, 'test.db');
  const repo = createRepository(dbFile);
  const source = makeSource(root);
  repo.insertSource(source);

  try {
    const provider = new LocalProvider([root]);
    const summary = await scanSource({ source, provider, repo, ignorePatterns: [] });

    assert.equal(summary.error, null, `扫描报错：${summary.error}`);
    assert.equal(summary.found, 5, `应识别 5 个媒体文件（2 电影 + 2 剧集 + 1 图片），实际 ${summary.found}`);

    const counts = Object.fromEntries(repo.sectionCounts().map((c) => [c.section, c.count]));
    assert.equal(counts['movie'], 2);
    assert.equal(counts['tv'], 2);
    assert.equal(counts['photo'], 1);

    const movies = repo.browse({ section: 'movie', sort: 'title', order: 'asc' });
    assert.equal(movies.total, 2);
    const titles = movies.items.map((i) => i.title).sort();
    assert.deepEqual(titles, ['Dune Part Two', 'The Matrix']);

    const matrix = movies.items.find((i) => i.title === 'The Matrix');
    assert.ok(matrix, '应找到 The Matrix');
    assert.equal(matrix.year, 1999);
    assert.equal(matrix.resolution, '1080p');
    assert.equal(matrix.quality, 'BluRay');
    assert.equal(matrix.releaseGroup, 'GROUP');

    const seriesView = repo.browse({ section: 'tv', group: 'series' });
    assert.equal(seriesView.series.length, 1, '两集应聚合为一部剧');
    const show = seriesView.series[0]!;
    assert.equal(show.title, '西部世界');
    assert.equal(show.episodeCount, 2);
    assert.deepEqual(show.seasons, [2]);

    // 剧集详情按季排序
    const detail = repo.getSeries(show.key);
    assert.ok(detail);
    assert.deepEqual(
      detail.items.map((i) => i.episode),
      [3, 4],
    );

    // 重扫幂等：条目数不增加，无重复
    const second = await scanSource({ source, provider, repo, ignorePatterns: [] });
    assert.equal(second.error, null);
    assert.equal(repo.countItems(), 5);
    assert.equal(second.added, 0, '重扫不应新增条目');
  } finally {
    repo.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('扫描后消失的文件被标记 missing，不再出现在浏览结果里', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nebula-missing-'));
  const dir = join(root, 'movies');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Alpha.2020.1080p.mkv'), 'x');
  writeFileSync(join(dir, 'Beta.2021.1080p.mkv'), 'x');

  const repo = createRepository(join(root, 'db.sqlite'));
  const source = makeSource(root);
  repo.insertSource(source);
  try {
    const provider = new LocalProvider([root]);
    await scanSource({ source, provider, repo, ignorePatterns: [] });
    assert.equal(repo.countItems(), 2);

    rmSync(join(dir, 'Beta.2021.1080p.mkv'));
    await scanSource({ source, provider, repo, ignorePatterns: [] });

    const after = repo.browse({ section: 'movie' });
    assert.equal(after.total, 1);
    assert.equal(after.items[0]?.title, 'Alpha');
  } finally {
    repo.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('播放进度写入与继续观看查询', () => {
  const root = mkdtempSync(join(tmpdir(), 'nebula-progress-'));
  const repo = createRepository(join(root, 'db.sqlite'));
  try {
    const now = Date.now();
    repo.upsertItems([
      {
        id: 'item_1',
        sourceId: 's1',
        path: '/a/movie.mkv',
        name: 'movie.mkv',
        ext: 'mkv',
        size: 100,
        mtime: now,
        section: 'movie',
        title: 'A Movie',
        year: 2020,
        season: null,
        episode: null,
        episodeEnd: null,
        seriesKey: null,
        seriesTitle: null,
        resolution: '1080p',
        quality: 'WEB-DL',
        videoCodec: 'H.264',
        audioCodec: null,
        releaseGroup: null,
        confidence: 0.9,
        poster: null,
        backdrop: null,
        overview: null,
        rating: null,
        durationSec: null,
        width: null,
        height: null,
        addedAt: now,
        updatedAt: now,
        missing: false,
      },
    ]);
    repo.savePlayback({ itemId: 'item_1', seriesKey: null, position: 120, duration: 6000, finished: false, updatedAt: now });

    const list = repo.continueWatching(10);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.item.title, 'A Movie');
    assert.equal(list[0]?.record.position, 120);

    repo.savePlayback({ itemId: 'item_1', seriesKey: null, position: 6000, duration: 6000, finished: true, updatedAt: now + 1 });
    assert.equal(repo.continueWatching(10).length, 0, '看完了不应出现在继续观看');
  } finally {
    repo.close();
    rmSync(root, { recursive: true, force: true });
  }
});
