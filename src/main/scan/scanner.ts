import { parseMediaFile, seriesFolderTitle, VIDEO_EXTS, AUDIO_EXTS, IMAGE_EXTS, SUBTITLE_EXTS } from './namer';
import type { RemoteEntry, StorageProvider } from '../sources/types';
import type { Repository } from '../db/index';
import { itemId, seriesKey } from '../db/ids';
import { sourceScanRoots } from './scope';
import type { LibrarySection, MediaItem, ScanProgress, ScanSummary, StorageSource } from '../../shared/types';

const SYSTEM_DIRS =
  /^(\$RECYCLE\.BIN|System Volume Information|@eaDir|#recycle|\.Trash|\.git|node_modules|__MACOSX)$/i;

/** 防御：单源扫描条目上限，避免误挂根目录把整盘扫进来 */
const DEFAULT_MAX_ENTRIES = 400_000;
const DEFAULT_MAX_DEPTH = 12;
const CONCURRENCY = 4;
const POSTER_FORMATS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);
const POSTER_NAMES = ['poster', '宣传海报', '劇集海報', '剧集海报', '海报', '海報', '剧卡', '劇卡', 'cover', '封面', 'folder'];
type ArtworkFolder = { name: string; images: RemoteEntry[] };

export interface ScanOptions {
  source: StorageSource;
  provider: StorageProvider;
  repo: Repository;
  ignorePatterns: string[];
  maxEntries?: number;
  maxDepth?: number;
  onProgress?: (p: ScanProgress) => void;
  onItemBatch?: (batch: MediaItem[]) => void;
  signal?: AbortSignal;
}

function extOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : '';
}

function classify(ext: string): LibrarySection | null {
  if (VIDEO_EXTS.has(ext)) return 'movie'; // 具体分区由解析器决定
  if (AUDIO_EXTS.has(ext)) return 'music';
  if (IMAGE_EXTS.has(ext)) return 'photo';
  return null;
}

function ignored(name: string, patterns: string[]): boolean {
  if (SYSTEM_DIRS.test(name)) return true;
  return patterns.some((p) => p && name.toLowerCase().includes(p.toLowerCase()));
}

function findPoster(sourceId: string, title: string, folders: ArtworkFolder[]): string | null {
  const key = seriesKey(title, null);
  const named = new Set([key, ...POSTER_NAMES.map((name) => seriesKey(`${title} ${name}`, null))]);
  for (const folder of folders) {
    const hits = new Map(folder.images.map((image) => [
      seriesKey(seriesFolderTitle(image.name.slice(0, image.name.lastIndexOf('.'))), null), image.path,
    ]));
    const explicit = [...named].map((name) => hits.get(name)).find(Boolean);
    if (explicit) return itemId(sourceId, explicit);
    const folderTitle = seriesFolderTitle(folder.name);
    if (!folder.name || (folderTitle && seriesKey(folderTitle, null) !== key)) continue;
    const generic = POSTER_NAMES.map((name) => hits.get(seriesKey(name, null))).find(Boolean);
    if (generic) return itemId(sourceId, generic);
  }
  return null;
}

function makeItem(
  sourceId: string,
  entry: RemoteEntry,
  displayPath: string,
  artwork: ArtworkFolder[],
  alternateTitle: string | null,
  now: number,
): MediaItem | null {
  const ext = extOf(entry.name);
  const section = classify(ext);
  if (!section) return null;

  if (section === 'movie') {
    const parsed = parseMediaFile({ fullPath: displayPath, fileName: entry.name });
    return {
      id: itemId(sourceId, entry.path),
      sourceId,
      path: entry.path,
      name: entry.name,
      ext,
      size: entry.size,
      mtime: entry.mtime,
      section: parsed.section,
      title: parsed.title,
      searchAlias: parsed.section === 'movie' && !/\p{Script=Han}/u.test(parsed.title) ? alternateTitle : null,
      year: parsed.year,
      season: parsed.season,
      episode: parsed.episode,
      episodeEnd: parsed.episodeEnd,
      seriesKey: parsed.seriesKey,
      seriesTitle: parsed.seriesTitle,
      genres: parsed.genres,
      resolution: parsed.resolution,
      quality: parsed.quality,
      videoCodec: parsed.videoCodec,
      audioCodec: parsed.audioCodec,
      releaseGroup: parsed.releaseGroup,
      confidence: parsed.confidence,
      poster: null,
      posterItemId: findPoster(sourceId, parsed.seriesTitle ?? parsed.title, artwork),
      backdrop: null,
      overview: null,
      rating: null,
      durationSec: null,
      width: null,
      height: null,
      addedAt: now,
      updatedAt: now,
      missing: false,
    };
  }

  const baseName = entry.name.slice(0, entry.name.lastIndexOf('.')) || entry.name;
  return {
    id: itemId(sourceId, entry.path),
    sourceId,
    path: entry.path,
    name: entry.name,
    ext,
    size: entry.size,
    mtime: entry.mtime,
    section,
    title: baseName,
    year: null,
    season: null,
    episode: null,
    episodeEnd: null,
    seriesKey: null,
    seriesTitle: null,
    resolution: null,
    quality: null,
    videoCodec: null,
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
  };
}

/**
 * 逐层 BFS 扫描。每个目录一次 list()，把子目录排进队列；
 * 每攒够一批文件就 UPSERT，避免几万条目全堆在内存里。
 */
export async function scanSource(opts: ScanOptions): Promise<ScanSummary> {
  const { source, provider, repo, ignorePatterns, signal } = opts;
  const startedAt = Date.now();
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;

  const roots = sourceScanRoots(source);

  const progress: ScanProgress = {
    sourceId: source.id,
    sourceName: source.name,
    phase: 'connecting',
    scanned: 0,
    found: 0,
    currentPath: null,
    startedAt,
    finishedAt: null,
    message: null,
  };
  const emit = (patch: Partial<ScanProgress> = {}) => {
    Object.assign(progress, patch);
    opts.onProgress?.({ ...progress });
  };

  const check = () => {
    if (signal?.aborted) {
      const err = new Error('cancelled');
      err.name = 'AbortError';
      throw err;
    }
  };

  emit({ phase: 'listing' });
  // 阿里云盘的目录读取可能在扫描中途失败，完整遍历后再标记消失的媒体。
  const preserveOnFailure = source.config.kind === 'aliyun' || source.config.scanScope?.mode === 'custom';
  const seenItemIds = preserveOnFailure ? new Set<string>() : null;
  if (!seenItemIds) repo.beginScan(source.id);

  const queue = roots.map((root) => ({ ...root, depth: 0, artwork: [] as ArtworkFolder[] }));
  const scheduled = new Set(roots.map((root) => root.path));
  const batch: MediaItem[] = [];
  const now = Date.now();
  let found = 0;
  let scanned = 0;
  let added = 0;
  let updated = 0;
  let error: string | null = null;
  let listingError: string | null = null;

  const flush = () => {
    if (batch.length === 0) return;
    const res = repo.upsertItems(batch);
    added += res.added;
    updated += res.updated;
    opts.onItemBatch?.(batch);
    batch.length = 0;
  };

  try {
    while (queue.length > 0) {
      check();
      const chunk = queue.splice(0, CONCURRENCY);
      const listings = await Promise.all(
        chunk.map(async (dir) => {
          try {
            return { dir, entries: await provider.list(dir.path) };
          } catch (err) {
            // 单个子目录失败不应中断整源扫描；记录下来继续
            const message = `跳过 ${dir.path}：${err instanceof Error ? err.message : String(err)}`;
            listingError ??= message;
            emit({ message });
            return { dir, entries: [] as RemoteEntry[] };
          }
        }),
      );
      check();

      for (const { dir, entries } of listings) {
        emit({ currentPath: dir.path });
        const images = entries.filter((entry) => !entry.isDir && POSTER_FORMATS.has(extOf(entry.name)) && !ignored(entry.name, ignorePatterns));
        const folderName = dir.displayPath.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
        const artwork = images.length ? [...dir.artwork, { name: folderName, images }] : dir.artwork;
        const alternateTitle = /\p{Script=Han}/u.test(folderName)
          && !/^(?:电影|影片|资源|合集|视频|蓝光|原盘)$/u.test(folderName)
          && entries.filter((entry) => !entry.isDir && VIDEO_EXTS.has(extOf(entry.name))).length === 1
          ? seriesFolderTitle(folderName) || null : null;
        for (const entry of entries) {
          scanned += 1;
          if (scanned > maxEntries) {
            emit({ message: `已达条目上限 ${maxEntries}，停止扫描` });
            throw new Error(`条目数超过上限 ${maxEntries}`);
          }
          const name = entry.name || entry.path.split('/').pop() || '';
          if (ignored(name, ignorePatterns)) continue;
          const displayPath = `${dir.displayPath}/${name}`;

          if (entry.isDir) {
            if (dir.depth < maxDepth && !scheduled.has(entry.path)) {
              scheduled.add(entry.path);
              queue.push({ path: entry.path, depth: dir.depth + 1, displayPath, artwork });
            }
            continue;
          }

          const ext = extOf(name);
          if (SUBTITLE_EXTS.has(ext)) continue;

          const item = makeItem(source.id, entry, displayPath, artwork, alternateTitle, now);
          if (item) {
            found += 1;
            seenItemIds?.add(item.id);
            batch.push(item);
            if (batch.length >= 200) {
              emit({ phase: 'saving', found, scanned });
              flush();
            }
          }
        }
        if (scanned % 50 === 0) emit({ found, scanned });
      }
      emit({ found, scanned });
    }

    emit({ phase: 'saving', found, scanned });
    if (seenItemIds && listingError) throw new Error(listingError);
    flush();
    if (seenItemIds) repo.finishScan(source.id, seenItemIds);
    emit({ phase: 'done', finishedAt: Date.now(), found, scanned, message: null });
  } catch (err) {
    flush();
    const cancelled = err instanceof Error && err.name === 'AbortError';
    error = cancelled ? null : err instanceof Error ? err.message : String(err);
    emit({
      phase: cancelled ? 'cancelled' : 'error',
      finishedAt: Date.now(),
      found,
      scanned,
      message: error,
    });
  }

  return {
    sourceId: source.id,
    scanned,
    found,
    added,
    updated,
    removed: 0,
    durationMs: Date.now() - startedAt,
    error,
  };
}
