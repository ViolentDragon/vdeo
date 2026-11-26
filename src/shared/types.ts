/**
 * 领域模型 — 主进程与渲染进程共享。
 * 变更本文件时同步检查 src/main/db 与 src/renderer 的消费方。
 */

/** 媒体库分区（Emby/Jellyfin 式归类结果） */
export type LibrarySection = 'movie' | 'tv' | 'anime' | 'music' | 'photo' | 'other';

export const SECTION_LABEL: Record<LibrarySection, string> = {
  movie: '电影',
  tv: '电视剧',
  anime: '动漫',
  music: '音乐',
  photo: '照片',
  other: '其他',
};

/** 存储源类型 */
export type SourceKind = 'local' | 'webdav' | 'aliyun' | 'baidu';

export const SOURCE_KIND_LABEL: Record<SourceKind, string> = {
  local: '本地磁盘',
  webdav: 'WebDAV',
  aliyun: '阿里云盘',
  baidu: '百度网盘',
};

export interface LocalSourceConfig {
  kind: 'local';
  /** 允许挂载多个根目录 */
  roots: string[];
}

export interface WebdavSourceConfig {
  kind: 'webdav';
  /** 例：https://dav.jianguoyun.com/dav （Alist/OpenList 也以此协议暴露） */
  url: string;
  username: string;
  /** 磁盘上以 enc:v1: 前缀加密存储，读回时明文只在主进程内存中 */
  password: string;
  /** 源内起始路径，默认根 */
  root: string;
}

export interface AliyunSourceConfig {
  kind: 'aliyun';
  driveId: string;
  refreshToken: string;
  root: string;
}

export interface BaiduSourceConfig {
  kind: 'baidu';
  accessToken: string;
  refreshToken: string;
  root: string;
}

export type SourceConfig =
  | LocalSourceConfig
  | WebdavSourceConfig
  | AliyunSourceConfig
  | BaiduSourceConfig;

export interface StorageSource {
  id: string;
  kind: SourceKind;
  name: string;
  config: SourceConfig;
  enabled: boolean;
  lastScanAt: number | null;
  lastScanCount: number;
  lastError: string | null;
  createdAt: number;
}

/** 单个媒体文件（播放单元） */
export interface MediaItem {
  /** 稳定 id：sha1(sourceId + ':' + path) 前 16 位 */
  id: string;
  sourceId: string;
  /** provider 内部路径（本地为绝对路径，webdav 为远端路径） */
  path: string;
  name: string;
  ext: string;
  size: number;
  mtime: number;

  section: LibrarySection;
  /** 清洗后的展示标题 */
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  episodeEnd: number | null;
  /** 剧集聚合键（movie 为 null） */
  seriesKey: string | null;
  seriesTitle: string | null;

  /** 技术标签：2160p / 1080p / WEB-DL / BluRay / HEVC / DDP5.1 … */
  resolution: string | null;
  quality: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  releaseGroup: string | null;

  /** 解析置信度 0..1，低置信度条目在 UI 可提示人工修正 */
  confidence: number;

  /** 元数据与本地缓存的图片路径 */
  poster: string | null;
  backdrop: string | null;
  overview: string | null;
  rating: number | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;

  addedAt: number;
  updatedAt: number;
  /** 最近一次扫描未再发现 */
  missing: boolean;
}

/** 剧集聚合视图（电视剧/动漫分区按剧展示） */
export interface SeriesSummary {
  key: string;
  title: string;
  year: number | null;
  section: LibrarySection;
  sourceIds: string[];
  episodeCount: number;
  seasonCount: number;
  seasons: number[];
  poster: string | null;
  latestAddedAt: number;
  /** 已看到的最新集（用于"继续观看"提示） */
  lastWatchedEpisode: number | null;
}

export type SortField = 'added' | 'title' | 'year' | 'rating' | 'episode';

export interface BrowseQuery {
  section?: LibrarySection;
  sourceId?: string;
  search?: string;
  sort?: SortField;
  order?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
  /** item=按文件；series=按剧集聚合卡片 */
  group?: 'item' | 'series';
  /** 只看最近添加 */
  recentOnly?: boolean;
}

export interface BrowseResult {
  total: number;
  items: MediaItem[];
  series: SeriesSummary[];
}

/* ------------------------------ 播放 ------------------------------ */

export interface PlaybackTarget {
  itemId: string;
  /** 已解析可直接交给播放器的地址（本地路径 / http(s) 直链） */
  url: string;
  /** 某些网盘直链需要附带认证头 */
  headers: Record<string, string>;
  title: string;
  /** 续播起点（秒） */
  startAt: number;
  /** 同目录字幕绝对/远端路径 */
  subtitles: string[];
}

export type PlayerStatus = 'idle' | 'resolving' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export type PlayerMode = 'embedded' | 'external';

export interface PlayerState {
  status: PlayerStatus;
  itemId: string | null;
  title: string | null;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  speed: number;
  pausedForCache: boolean;
  fullscreen: boolean;
  mode: PlayerMode;
  /** mpv 是否可用；不可用时 UI 降级为"仅外部播放器" */
  mpvAvailable: boolean;
  mpvPath: string | null;
  error: string | null;
  tracks: TrackInfo[];
  activeAudioId: number | null;
  activeSubId: number | null;
}

export interface TrackInfo {
  id: number;
  type: 'audio' | 'sub' | 'video';
  title: string;
  lang: string | null;
  selected: boolean;
  external: boolean;
}

/* ------------------------------ 扫描 ------------------------------ */

export type ScanPhase =
  | 'connecting'
  | 'listing'
  | 'parsing'
  | 'saving'
  | 'done'
  | 'error'
  | 'cancelled';

export interface ScanProgress {
  sourceId: string;
  sourceName: string;
  phase: ScanPhase;
  /** 已遍历的远端条目数 */
  scanned: number;
  /** 识别出的媒体文件数 */
  found: number;
  /** 当前处理的路径 */
  currentPath: string | null;
  startedAt: number;
  finishedAt: number | null;
  message: string | null;
}

export interface ScanSummary {
  sourceId: string;
  scanned: number;
  found: number;
  added: number;
  updated: number;
  removed: number;
  durationMs: number;
  error: string | null;
}

/* ------------------------------ 应用设置 ------------------------------ */

export interface AppSettings {
  mpvPath: string | null;
  /** 用于 fallback 的外部播放器命令模板，{url} 占位 */
  externalPlayer: string | null;
  preferredMode: PlayerMode;
  theme: 'dark' | 'dark-blue' | 'midnight';
  /** 扫描时忽略的目录名片段 */
  ignorePatterns: string[];
  /** 视频扩展名白名单 */
  videoExtensions: string[];
  hardwareDecode: boolean;
  cacheDir: string;
}

/* ------------------------------ 播放进度 ------------------------------ */

export interface PlaybackRecord {
  itemId: string;
  seriesKey: string | null;
  position: number;
  duration: number;
  finished: boolean;
  updatedAt: number;
}
