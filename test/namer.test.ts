import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMediaFile } from '../src/main/scan/namer';

test('标准电影命名：点分隔 + 年份 + 技术标签', () => {
  const r = parseMediaFile({
    fullPath: 'D:/Movies/The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv',
    fileName: 'The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv',
  });
  assert.equal(r.section, 'movie');
  assert.equal(r.title, 'The Matrix');
  assert.equal(r.year, 1999);
  assert.equal(r.resolution, '1080p');
  assert.equal(r.quality, 'BluRay');
  assert.equal(r.videoCodec, 'H.264');
  assert.equal(r.releaseGroup, 'GROUP');
  assert.equal(r.season, null);
  assert.equal(r.episode, null);
});

test('标准剧集命名：S01E03 + WEB-DL', () => {
  const r = parseMediaFile({
    fullPath: 'D:/TV/Westworld.S01E03.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv',
    fileName: 'Westworld.S01E03.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv',
  });
  assert.equal(r.section, 'tv');
  assert.equal(r.seriesTitle, 'Westworld');
  assert.equal(r.season, 1);
  assert.equal(r.episode, 3);
  assert.equal(r.resolution, '1080p');
  assert.equal(r.quality, 'WEB-DL');
});

test('多集合并：S01E02E03 与 S01E02-E04', () => {
  const a = parseMediaFile({ fullPath: 'x/Show.S01E02E03.1080p.mkv', fileName: 'Show.S01E02E03.1080p.mkv' });
  assert.equal(a.season, 1);
  assert.equal(a.episode, 2);
  assert.equal(a.episodeEnd, 3);

  const b = parseMediaFile({ fullPath: 'x/Show.S01E02-E04.mkv', fileName: 'Show.S01E02-E04.mkv' });
  assert.equal(b.episode, 2);
  assert.equal(b.episodeEnd, 4);
});

test('动漫字幕组命名：方括号前缀 + 空格横线集号', () => {
  const r = parseMediaFile({
    fullPath: 'D:/Anime/[Nekomoe kissaten] Sousou no Frieren - 12 [1080p].mkv',
    fileName: '[Nekomoe kissaten] Sousou no Frieren - 12 [1080p].mkv',
  });
  assert.equal(r.section, 'anime');
  assert.equal(r.episode, 12);
  assert.ok(r.title.includes('Sousou no Frieren'), `title=${r.title}`);
});

test('目录提供季、文件名只给集号', () => {
  const r = parseMediaFile({
    fullPath: 'D:/TV/西部世界/Season 2/04.mkv',
    fileName: '04.mkv',
  });
  assert.equal(r.section, 'tv');
  assert.equal(r.season, 2);
  assert.equal(r.episode, 4);
  assert.equal(r.title, '西部世界');
  assert.equal(r.seriesTitle, '西部世界');
});

test('中文剧集命名：第N集', () => {
  const r = parseMediaFile({
    fullPath: 'D:/剧集/长安十二时辰/长安十二时辰.2019.第12集.mp4',
    fileName: '长安十二时辰.2019.第12集.mp4',
  });
  assert.equal(r.section, 'tv');
  assert.equal(r.year, 2019);
  assert.equal(r.episode, 12);
  assert.ok(r.seriesTitle !== null && r.seriesTitle.includes('长安十二时辰'), `seriesTitle=${r.seriesTitle}`);
});

test('1x05 季集写法', () => {
  const r = parseMediaFile({ fullPath: 'D:/TV/Show Name/1x05.mkv', fileName: '1x05.mkv' });
  assert.equal(r.section, 'tv');
  assert.equal(r.season, 1);
  assert.equal(r.episode, 5);
});

test('4K REMUX 电影保留分辨率与质量', () => {
  const r = parseMediaFile({
    fullPath: 'D:/Movies/Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.HDR.mkv',
    fileName: 'Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.HDR.mkv',
  });
  assert.equal(r.section, 'movie');
  assert.equal(r.title, 'Dune Part Two');
  assert.equal(r.year, 2024);
  assert.equal(r.resolution, '2160p');
  assert.equal(r.quality, 'REMUX');
});

test('括号年份与方括号标签', () => {
  const r = parseMediaFile({
    fullPath: 'D:/Movies/Interstellar (2014) [1080p] [BluRay].mkv',
    fileName: 'Interstellar (2014) [1080p] [BluRay].mkv',
  });
  assert.equal(r.title, 'Interstellar');
  assert.equal(r.year, 2014);
  assert.equal(r.resolution, '1080p');
  assert.equal(r.quality, 'BluRay');
});

test('无年份纯标题：电影且置信度偏低', () => {
  const r = parseMediaFile({ fullPath: 'D:/Movies/Some Movie.mkv', fileName: 'Some Movie.mkv' });
  assert.equal(r.section, 'movie');
  assert.equal(r.title, 'Some Movie');
  assert.equal(r.year, null);
  assert.ok(r.confidence < 0.8, `confidence=${r.confidence}`);
});

test('同一部剧的聚合键与季集号无关', () => {
  const a = parseMediaFile({ fullPath: 'x/Breaking.Bad.S01E01.mkv', fileName: 'Breaking.Bad.S01E01.mkv' });
  const b = parseMediaFile({ fullPath: 'x/Breaking.Bad.S03E07.1080p.mkv', fileName: 'Breaking.Bad.S03E07.1080p.mkv' });
  assert.equal(a.seriesKey, b.seriesKey);
  assert.notEqual(a.seriesKey, null);
});

test('明确标注首播年份的目录可区分同名翻拍', () => {
  const a = parseMediaFile({ fullPath: '剧集/同名剧 (2000)/Season 1/01.mp4', fileName: '01.mp4' });
  const b = parseMediaFile({ fullPath: '剧集/同名剧 (2020)/Season 1/01.mp4', fileName: '01.mp4' });
  assert.equal(a.title, b.title);
  assert.notEqual(a.seriesKey, b.seriesKey);
});

test('x264 / h264 / avc 归一化为同一编码标识，便于筛选', () => {
  const r1 = parseMediaFile({ fullPath: 'a/x264.mkv', fileName: 'Movie.2020.x264.mkv' });
  const r2 = parseMediaFile({ fullPath: 'a/h264.mkv', fileName: 'Movie.2020.H.264.mkv' });
  const r3 = parseMediaFile({ fullPath: 'a/avc.mkv', fileName: 'Movie.2020.AVC.mkv' });
  assert.equal(r1.videoCodec, 'H.264');
  assert.equal(r2.videoCodec, 'H.264');
  assert.equal(r3.videoCodec, 'H.264');
});

test('e01 小写与 EP 前缀', () => {
  const a = parseMediaFile({ fullPath: 'x/show.e01.mkv', fileName: 'show.e01.mkv' });
  assert.equal(a.episode, 1);
  const b = parseMediaFile({ fullPath: 'x/Show.EP07.mkv', fileName: 'Show.EP07.mkv' });
  assert.equal(b.episode, 7);
});
