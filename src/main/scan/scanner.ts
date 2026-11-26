import { parseMediaFile, VIDEO_EXTS, AUDIO_EXTS, IMAGE_EXTS, SUBTITLE_EXTS } from './namer';
import type { RemoteEntry, StorageProvider } from '../sources/types';
import type { Repository } from '../db/index';
import { itemId } from '../db/ids';
import type { LibrarySection, MediaItem, ScanProgress, ScanSummary, StorageSource } from '../../shared/types';

const SYSTEM_DIRS =
  /^(\$RECYCLE\.BIN|System Volume Information|@eaDir|#recycle|\.Trash|\.git|node_modules|__MACOSX)$/i;

/** 防御：单源扫描条目上限，避免误挂根目录把整盘扫进来 */
const DEFAULT_MAX_ENTRIES = 400_000;
const DEFAULT_MAX_DEPTH = 12;
const CONCURRENCY = 4;

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

function makeItem(
  sourceId: string,
  entry: RemoteEntry,
  sectionHint: LibrarySection,
  now: number,
): MediaItem | null {
  const ext = extOf(entry.name);
  const section = classify(ext);
  if (!section) return null;

  if (section === 'movie') {
    const parsed = parseMediaFile({ fullPath: entry.path, fileName: entry.name });
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
      year: parsed.year,
      season: parsed.season,
      episode: parsed.episode,
      episodeEnd: parsed.episodeEnd,
      seriesKey: parsed.seriesKey,
      seriesTitle: parsed.seriesTitle,
      resolution: parsed.resolution,
      quality: parsed.quality,
      videoCodec: parsed.videoCodec,
      audioCodec: parsed.audioCodec,
      releaseGroup: parsed.releaseGroup,
      confidence: parsed.confidence,
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

  const roots = source.config.kind === 'local' ? source.config.roots : [source.config.root || '/'];

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
  repo.beginScan(source.id);

  const queue: Array<{ path: string; depth: number }> = roots.map((r) => ({ path: r, depth: 0 }));
  const batch: MediaItem[] = [];
  const now = Date.now();
  let found = 0;
  let scanned = 0;
  let added = 0;
  let updated = 0;
  let error: string | null = null;

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
            emit({
              message: `跳过 ${dir.path}：${err instanceof Error ? err.message : String(err)}`,
            });
            return { dir, entries: [] as RemoteEntry[] };
          }
        }),
      );

      for (const { dir, entries } of listings) {
        emit({ currentPath: dir.path });
        for (const entry of entries) {
          scanned += 1;
          if (scanned > maxEntries) {
            emit({ message: `已达条目上限 ${maxEntries}，停止扫描` });
            throw new Error(`条目数超过上限 ${maxEntries}`);
          }
          const name = entry.name || entry.path.split('/').pop() || '';
          if (ignored(name, ignorePatterns)) continue;

          if (entry.isDir) {
            if (dir.depth + 1 <= maxDepth) queue.push({ path: entry.path, depth: dir.depth + 1 });
            continue;
          }

          const ext = extOf(name);
          if (SUBTITLE_EXTS.has(ext)) continue;

          const item = makeItem(source.id, entry, 'movie', now);
          if (item) {
            found += 1;
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
    flush();
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
