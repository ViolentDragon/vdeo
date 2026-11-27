import { seriesKey as makeSeriesKey } from '../db/ids';
import type { Genre } from '../../shared/types';

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
  genres: Genre[];
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

const ANIME_PATH_HINTS = /(动漫|动画|番剧|新番|anime|bangumi|cartoon)/i;
const CN_NUMBER = '[0-9〇零一二两兩三四五六七八九十百千]';
const SEASON_MARKER = new RegExp(`(?:第\\s*(${CN_NUMBER}{1,5})\\s*[季部]|(?:^|[\\s._-])(?:season\\s*|s)(\\d{1,2})(?!\\d)|((?:续|續)[集篇]))`, 'i');
const GENRE_RULES: Array<[Genre, RegExp]> = [
  ['剧情', /剧情|劇情|\bdrama\b/i], ['古装', /古装|古裝|宫廷|宮廷|宫斗|宮鬥|权谋|權謀/i],
  ['武侠', /武侠|武俠|江湖|\bwuxia\b/i], ['悬疑', /悬疑|懸疑|推理|惊悚|驚悚|\b(mystery|thriller)\b/i],
  ['犯罪', /犯罪|刑侦|刑偵|警匪|\bcrime\b/i], ['喜剧', /喜剧|喜劇|搞笑|\bcomedy\b/i],
  ['爱情', /爱情|愛情|恋爱|戀愛|言情|\bromance\b/i], ['动作', /动作片|動作片|[/\\\[【（(]动作(?=[/\\\]】）)])|\baction\b/i],
  ['科幻', /科幻|\bsci[- ]?fi\b|science fiction/i], ['奇幻', /奇幻|玄幻|魔幻|仙侠|仙俠|\bfantasy\b/i],
  ['恐怖', /恐怖|\bhorror\b/i], ['战争', /战争|戰爭|抗战|抗戰|\bwar\b/i],
  ['历史', /历史|歷史|史诗|史詩|\bhistorical\b/i], ['动画', ANIME_PATH_HINTS],
  ['纪录片', /纪录片|紀錄片|纪实|紀實|\bdocumentar(?:y|ies)\b/i], ['综艺', /综艺|綜藝|真人秀|\breality show\b/i],
];
const GENERIC_FOLDER = /^(?:tv|series|movies?|films?|videos?|media|剧集|电视剧|電視劇|电视剧资源|电影|電影|视频资源|視頻資源|动漫|动画|番剧|综艺|纪录片|国产剧|国剧|陆剧|港剧|美剧|日剧|韩剧|下载|资源库|合集)$/i;
export const NUMBERED_TITLE_PREFIX = /^[1-9]\d{0,2}(?=[\s._-])/;
const YEAR_PATTERN = /(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/;

function mediaNumber(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  const digits = '零一二三四五六七八九';
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let digit = 0;
  for (const char of text.replace(/[两兩]/g, '二').replace(/〇/g, '零')) {
    const unit = units[char];
    if (unit) {
      total += (digit || 1) * unit;
      digit = 0;
    } else {
      digit = digit * 10 + Math.max(0, digits.indexOf(char));
    }
  }
  return total + digit;
}

function seasonFromTitle(raw: string): { title: string; season: number | null } {
  const match = raw.match(SEASON_MARKER);
  if (!match || match.index === undefined) return { title: cleanTitle(raw), season: null };
  const before = cleanTitle(raw.slice(0, match.index));
  return { title: before, season: match[3] ? 2 : mediaNumber(match[1] ?? match[2] ?? '') };
}

export function seriesFolderTitle(name: string): string {
  return seasonFromTitle(name).title;
}

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
    const parsed = seasonFromTitle(seg);
    season ??= parsed.season;
    const title = parsed.title.replace(/^[\s\-–—]+/, '');
    if (!title || GENERIC_FOLDER.test(title) || /^\d+$/.test(title) || GENRE_RULES.some(([genre]) => genre === title)) continue;
    return { title, season };
  }
  return { title: '', season };
}

type EpisodeHit = {
  season: number | null;
  episode: number;
  episodeEnd: number | null;
  index: number;
  length: number;
};

function findEpisode(text: string, allowAnimeDash: boolean, seasonHint: number | null): EpisodeHit | null {
  // S01E02 / S01E02E03 / S01E02-E04
  const sxxexx = text.match(/s(\d{1,2})[ ._-]*e(\d{1,4})(?!\d)(?:[ ._-]*e(\d{1,4})(?!\d))?/i);
  if (sxxexx?.index !== undefined) {
    const endRaw = sxxexx[3];
    return {
      season: Number(sxxexx[1]),
      episode: Number(sxxexx[2]),
      episodeEnd: endRaw ? Number(endRaw) : null,
      index: sxxexx.index,
      length: sxxexx[0].length,
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
    };
  }

  const cn = text.match(new RegExp(`第\\s*(${CN_NUMBER}{1,5})\\s*[集话話期]`));
  if (cn?.index !== undefined) {
    return {
      season: null,
      episode: mediaNumber(cn[1] ?? ''),
      episodeEnd: null,
      index: cn.index,
      length: cn[0].length,
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
      };
    }
  }

  // 有歧义的前导数字需要集号格式或季目录，例如 3.Idiots 的 3 属于片名。
  const bare = text.match(/^(\d{1,3})(?:v\d)?(?=\s|[._–—-]|$)/);
  const rest = bare ? text.slice(bare[0].length) : '';
  if (bare && (!rest || /^\s*[-–—]\s+/.test(rest) || /^0\d/.test(bare[1]!) || seasonHint !== null)) {
    return {
      season: null,
      episode: Number(bare[1]),
      episodeEnd: null,
      index: 0,
      length: bare[0].length,
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
  const ep = findEpisode(base, animeContext, dirInfo.season);

  const episode = ep?.episode ?? null;
  const episodeEnd = ep?.episodeEnd ?? null;

  const yearSource = ep ? base.slice(0, ep.index) : base;
  const yearMatch = yearSource.match(YEAR_PATTERN) ?? (ep ? base.slice(ep.index + ep.length).match(YEAR_PATTERN) : null);
  let year = yearMatch?.[1] ? Number(yearMatch[1]) : null;

  // 数字开头的发布名以年份分隔片名和后续技术标签。
  let titleSource = yearSource;
  if (!ep && (quality || resolution) && NUMBERED_TITLE_PREFIX.test(base) && yearMatch?.index) {
    titleSource = base.slice(0, yearMatch.index).replace(/[\s([（【]+$/, '');
  }
  if (releaseGroup) {
    const suffix = `-${releaseGroup}`;
    const gi = titleSource.lastIndexOf(suffix);
    if (gi >= 0) titleSource = titleSource.slice(0, gi);
  }

  const isSeries = episode !== null;
  const namedSeason = isSeries ? seasonFromTitle(titleSource) : { title: cleanTitle(titleSource), season: null };
  const season = isSeries ? (ep?.season ?? namedSeason.season ?? dirInfo.season ?? 1) : null;
  let title = namedSeason.title;
  let titleFromDir = false;

  // 「1917」这类片名会被年份规则吃掉：标题为空时视为片名
  if (!ep && year !== null && title.length === 0) {
    title = String(year);
    year = null;
  }

  if (!title || (ep && title.length < 2)) {
    title = dirInfo.title || title || base;
    titleFromDir = title === dirInfo.title && dirInfo.title.length > 0;
  }

  // 文件名本身就是集号（04.mkv / 01.mp4）→ 标题只能来自目录
  if (ep && ep.index <= 1 && dirInfo.title) {
    title = dirInfo.title;
    titleFromDir = true;
  }

  if (title.length < 1) title = base;

  // 目录标明的首播年份可区分同名翻拍。每一季的文件年份不参与聚合。
  const titleKey = makeSeriesKey(title, null);
  const seriesRoot = isSeries ? dirSegments(input.fullPath).slice(0, -1).findLast((dir) => {
    const parsed = seasonFromTitle(dir);
    return parsed.season === null && YEAR_PATTERN.test(dir) && makeSeriesKey(parsed.title, null) === titleKey;
  }) : undefined;
  const rootYear = seriesRoot?.match(YEAR_PATTERN)?.[1];
  if (rootYear) year ??= Number(rootYear);

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
    seriesKey: isSeries ? `${section}:${rootYear ? makeSeriesKey(title, Number(rootYear)) : titleKey}` : null,
    seriesTitle: isSeries ? title : null,
    genres: GENRE_RULES.filter(([, rule]) => rule.test(input.fullPath.normalize('NFKC'))).map(([genre]) => genre),
    resolution,
    quality,
    videoCodec,
    audioCodec,
    releaseGroup,
    confidence: Math.max(0.1, Math.min(0.95, Number(confidence.toFixed(2)))),
  };
}
