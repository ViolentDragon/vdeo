import { seriesKey as makeSeriesKey } from '../db/ids';

export interface ParseInput {
  /** 完整路径（含目录），用于季号与标题回退 */
  fullPath: string;
  /** 文件名（含扩展名） */
  fileName: string;
}

export interface ParsedMedia {
  section: 'movie' | 'tv' | 'anime';
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  episodeEnd: number | null;
  seriesKey: string | null;
  seriesTitle: string | null;
  resolution: string | null;
  quality: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  releaseGroup: string | null;
  confidence: number;
}

export const VIDEO_EXTS = new Set([
  'mkv', 'mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'ts', 'm2ts', 'mts', 'mpg', 'mpeg',
  'rmvb', 'rm', 'vob', '3gp', 'ogv', 'divx', 'asf', 'iso',
]);

export const AUDIO_EXTS = new Set(['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'ape', 'dsf', 'dff']);

export const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'avif', 'tiff']);

export const SUBTITLE_EXTS = new Set(['srt', 'ass', 'ssa', 'vtt', 'sub', 'idx', 'sup']);

const QUALITY_RULES: Array<[RegExp, string]> = [
  [/\bremux\b/i, 'REMUX'],
  [/\bbdremux\b/i, 'REMUX'],
  [/\bblu-?ray\b/i, 'BluRay'],
  [/\bbdrip\b/i, 'BDRip'],
  [/\bweb-?dl\b/i, 'WEB-DL'],
  [/\bwebrip\b/i, 'WEBRip'],
  [/\bhdtv\b/i, 'HDTV'],
  [/\bdvdrip\b/i, 'DVDRip'],
  [/\bhdcam\b/i, 'CAM'],
  [/\bweb\b/i, 'WEB'],
];

const RESOLUTION_RULES: Array<[RegExp, string]> = [
  [/\b(2160p|4k|uhd)\b/i, '2160p'],
  [/\b1080p\b/i, '1080p'],
  [/\b720p\b/i, '720p'],
  [/\b480p\b/i, '480p'],
];

const VIDEO_CODEC_RULES: Array<[RegExp, string]> = [
  [/\b(x265|h\.?265|hevc)\b/i, 'HEVC'],
  [/\b(x264|h\.?264|avc)\b/i, 'H.264'],
  [/\bav1\b/i, 'AV1'],
  [/\bvp9\b/i, 'VP9'],
  [/\bxvid\b/i, 'XviD'],
  [/\bdivx\b/i, 'DivX'],
];

const AUDIO_CODEC_RULES: Array<[RegExp, string]> = [
  [/\bddp\s?5\.1\b|\bdd\+\s?5\.1\b|\beac3\s?5\.1\b/i, 'DDP5.1'],
  [/\bdd\s?5\.1\b|\bac3\s?5\.1\b/i, 'DD5.1'],
  [/\btruehd\b/i, 'TrueHD'],
  [/\batmos\b/i, 'Atmos'],
  [/\bdts[-:]?hd\b/i, 'DTS-HD'],
  [/\bdts[-:]?x\b/i, 'DTS:X'],
  [/\bdts\b/i, 'DTS'],
  [/\baac\b/i, 'AAC'],
  [/\bflac\b/i, 'FLAC'],
  [/\bopus\b/i, 'Opus'],
];

/** 清洗标题时要一并抹掉的杂项标记 */
const NOISE_RULES: RegExp[] = [
  /\b(19|20)\d{2}\b/,
  /\b(2160p|1080p|720p|480p|4k|uhd)\b/i,
  /\b(remux|blu-?ray|bdrip|bdremux|web-?dl|webrip|hdtv|dvdrip|hdcam|web)\b/i,
  /\b(x265|h\.?265|hevc|x264|h\.?264|avc|av1|vp9|xvid|divx)\b/i,
  /\b(ddp|dd\+|eac3|dd|ac3|truehd|atmos|dts|aac|flac|opus)\s?[0-9.]*\b/i,
  /\b(hdr10\+?|hdr|dolby\s?vision|dovi|dv|10bit|8bit|sdr)\b/i,
  /\b(repack|proper|internal|limited|extended|unrated|remastered|directors?\.?cut|imax)\b/i,
  /\b(60fps|50fps|hq|multi|chs|cht|eng|jpn|kor|双语|中字|简中|繁中|内嵌|外挂)\b/i,
];

const SEASON_DIR_RES = [
  /season\s*(\d{1,2})/i,
  /第\s*(\d{1,2})\s*季/,
  /(?:^|[\\/])s(\d{1,2})(?:[\\/]|$)/i,
];

const ANIME_PATH_HINTS = /(动漫|动画|番剧|新番|anime|bangumi|cartoon)/i;

function stripExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(0, idx) : name;
}

function applyRules(text: string, rules: Array<[RegExp, string]>): { value: string | null; rest: string } {
  let rest = text;
  for (const [re, value] of rules) {
    if (re.test(rest)) return { value, rest };
  }
  return { value: null, rest };
}

function cleanTitle(raw: string): string {
  let t = raw;
  t = t.replace(/\[[^\]]*\]/g, ' ');
  t = t.replace(/[（(][^)）]*[)）]/g, (m) => (/(19|20)\d{2}|1080|720|2160|4k|uhd/i.test(m) ? ' ' : m));
  for (const re of NOISE_RULES) t = t.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), ' ');
  t = t.replace(/[._]+/g, ' ');
  t = t.replace(/[-–—]+\s*$/, ' ');
  t = t.replace(/^[\s\-–—]+/, '');
  t = t.replace(/\s{2,}/g, ' ');
  return t.trim();
}

function dirSegments(fullPath: string): string[] {
  return fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
}

/** 找到父目录里最像剧名的那一层（跳过 Season 目录、纯数字目录） */
function titleFromDirs(fullPath: string): { title: string; season: number | null } {
  const segs = dirSegments(fullPath);
  segs.pop(); // 文件名
  let season: number | null = null;
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    const seg = segs[i]!;
    // 注意：判据必须是「本段是不是季目录」，不能用全局 season 是否已找到——
    // 否则一旦识别到季号，所有上层目录都会被当成季目录跳过，剧名就丢了。
    let isSeasonDir = false;
    for (const re of SEASON_DIR_RES) {
      const m = seg.match(re);
      if (m && m[1]) {
        season = Number(m[1]);
        isSeasonDir = true;
        break;
      }
    }
    if (isSeasonDir) continue;
    if (/^(season|s\d+)$/i.test(seg)) continue;
    if (/^\d+$/.test(seg)) continue;
    return { title: cleanTitle(seg), season };
  }
  return { title: '', season };
}

type EpisodeHit = {
  season: number | null;
  episode: number;
  episodeEnd: number | null;
  index: number;
  length: number;
  major?: boolean;
};

function findEpisode(text: string, allowAnimeDash: boolean): EpisodeHit | null {
  // S01E02 / S01E02E03 / S01E02-E04
  const sxxexx = text.match(/s(\d{1,2})e(\d{1,4})(?:-?e(\d{1,4})|e(\d{1,4}))?/i);
  if (sxxexx?.index !== undefined) {
    const endRaw = sxxexx[3] ?? sxxexx[4] ?? null;
    return {
      season: Number(sxxexx[1]),
      episode: Number(sxxexx[2]),
      episodeEnd: endRaw ? Number(endRaw) : null,
      index: sxxexx.index,
      length: sxxexx[0].length,
      major: true,
    };
  }

  // 1x05
  const nxxnn = text.match(/(?:^|[^\d])(\d{1,2})x(\d{1,3})(?![\d])/i);
  if (nxxnn?.index !== undefined) {
    const offset = nxxnn[0].indexOf(nxxnn[1]!);
    return {
      season: Number(nxxnn[1]),
      episode: Number(nxxnn[2]),
      episodeEnd: null,
      index: nxxnn.index + offset,
      length: nxxnn[0].length - offset,
      major: true,
    };
  }

  // 第12集 / 第十二集（仅阿拉伯数字）
  const cn = text.match(/第\s*(\d{1,4})\s*[集话話期]/);
  if (cn?.index !== undefined) {
    return {
      season: null,
      episode: Number(cn[1]),
      episodeEnd: null,
      index: cn.index,
      length: cn[0].length,
      major: true,
    };
  }

  // EP07 / E07
  const ep = text.match(/(?:^|[^\w])(?:ep|e)[\s._-]?(\d{1,4})(?![\d])/i);
  if (ep?.index !== undefined) {
    const offset = ep[0].search(/[Ee][Pp]?[\s._-]?\d/i);
    return {
      season: null,
      episode: Number(ep[1]),
      episodeEnd: null,
      index: ep.index + Math.max(0, offset),
      length: ep[0].length - Math.max(0, offset),
      major: false,
    };
  }

  // 动漫「 - 12」写法（风险高，仅在动漫语境启用）
  if (allowAnimeDash) {
    const dash = text.match(/[-–]\s*(\d{1,4})(?:v\d)?(?=\s*(?:\[|\(|$))/);
    if (dash?.index !== undefined) {
      return {
        season: null,
        episode: Number(dash[1]),
        episodeEnd: null,
        index: dash.index,
        length: dash[0].length,
        major: false,
      };
    }
  }

  // 纯数字文件名：04.mkv / 第4集 之外的 "04 - 标题"
  const bare = text.match(/^(\d{1,4})(?:v\d)?(?:\s|$)/);
  if (bare?.index !== undefined) {
    return {
      season: null,
      episode: Number(bare[1]),
      episodeEnd: null,
      index: bare.index,
      length: bare[0].length,
      major: false,
    };
  }

  return null;
}

export function parseMediaFile(input: ParseInput): ParsedMedia {
  const fileName = input.fileName || input.fullPath.replace(/\\/g, '/').split('/').pop() || '';
  const base = stripExtension(fileName);

  const isAnimePath = ANIME_PATH_HINTS.test(input.fullPath);
  const bracketPrefix = /^\s*\[[^\]]+\]/.test(base);
  const animeDash = /[-–]\s*\d{1,4}(?:v\d)?\s*(?:\[|\(|$)/.test(base);
  const animeContext = isAnimePath || (bracketPrefix && animeDash);

  const quality = applyRules(base, QUALITY_RULES).value;
  const resolution = applyRules(base, RESOLUTION_RULES).value;
  const videoCodec = applyRules(base, VIDEO_CODEC_RULES).value;
  const audioCodec = applyRules(base, AUDIO_CODEC_RULES).value;

  let releaseGroup: string | null = null;
  const groupBracket = base.match(/^\s*\[([^\]]+)\]/);
  if (groupBracket && animeContext) {
    releaseGroup = groupBracket[1]!.trim();
  } else {
    const groupSuffix = base.match(/-([A-Za-z0-9@_]+)$/);
    if (groupSuffix && !VIDEO_CODEC_RULES.some(([re]) => re.test(groupSuffix[1]!))) {
      releaseGroup = groupSuffix[1]!;
    }
  }

  const dirInfo = titleFromDirs(input.fullPath);
  const ep = findEpisode(base, animeContext);

  let season: number | null = ep?.season ?? null;
  if (season === null && dirInfo.season !== null) season = dirInfo.season;

  let episode: number | null = ep?.episode ?? null;
  let episodeEnd: number | null = ep?.episodeEnd ?? null;

  // 标题：优先取集号标记之前的文本
  let titleSource = ep ? base.slice(0, ep.index) : base;
  if (releaseGroup) {
    const suffix = `-${releaseGroup}`;
    const gi = titleSource.lastIndexOf(suffix);
    if (gi >= 0) titleSource = titleSource.slice(0, gi);
  }

  let title = cleanTitle(titleSource);
  let titleFromDir = false;

  // 年份：在集号之前的部分里找，避免把集号误当年份
  const yearSource = ep ? base.slice(0, ep.index) : base;
  const yearMatch = yearSource.match(/(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/);
  let year = yearMatch?.[1] ? Number(yearMatch[1]) : null;

  // 「1917」这类片名会被年份规则吃掉：标题为空时视为片名
  if (year !== null && title.length === 0) {
    title = String(year);
    year = null;
  }

  if (title.length < 2) {
    title = dirInfo.title || title || base;
    titleFromDir = title === dirInfo.title && dirInfo.title.length > 0;
  }

  // 季集信息来自目录、文件名只给集号时，标题必须是目录名
  if (ep && !ep.major && title.length < 2 && dirInfo.title) {
    title = dirInfo.title;
    titleFromDir = true;
  }
  if (ep && dirInfo.title && title.length < 2) {
    title = dirInfo.title;
    titleFromDir = true;
  }

  // 文件名本身就是集号（04.mkv / 01.mp4）→ 标题只能来自目录
  if (ep && ep.index <= 1 && dirInfo.title) {
    title = dirInfo.title;
    titleFromDir = true;
  }

  if (title.length < 1) title = base;

  const isSeries = episode !== null;
  let section: 'movie' | 'tv' | 'anime';
  if (isSeries) {
    section = animeContext || isAnimePath ? 'anime' : 'tv';
  } else {
    section = 'movie';
  }

  let confidence = 0.45;
  if (year !== null) confidence += 0.15;
  if (isSeries) confidence += 0.2;
  if (resolution || quality) confidence += 0.1;
  if (title.length >= 2) confidence += 0.05;
  if (titleFromDir) confidence -= 0.1;
  if (!ep && !year) confidence -= 0.15;

  return {
    section,
    title,
    year,
    season,
    episode,
    episodeEnd,
    seriesKey: isSeries ? makeSeriesKey(title, year) : null,
    seriesTitle: isSeries ? title : null,
    resolution,
    quality,
    videoCodec,
    audioCodec,
    releaseGroup,
    confidence: Math.max(0.1, Math.min(0.95, Number(confidence.toFixed(2)))),
  };
}
