import { openDatabase, type SqliteHandle, type SqlValue } from './sqlite';
import { DDL_V1, DDL_V2, DDL_V3, SCHEMA_VERSION } from './schema';
import type {
  AppSettings,
  BrowseQuery,
  BrowseResult,
  CatalogEntry,
  Genre,
  LibrarySection,
  MediaItem,
  PlaybackRecord,
  SeriesSummary,
  SourceConfig,
  SourceKind,
  StorageSource,
} from '../../shared/types';
import { GENRES } from '../../shared/types';

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : v === null || v === undefined ? null : String(v));
const mustStr = (v: unknown, fallback = ''): string => str(v) ?? fallback;
const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const mustNum = (v: unknown, fallback = 0): number => num(v) ?? fallback;
const bool = (v: unknown): boolean => mustNum(v) === 1;
const EPISODE_KEY = 'COALESCE(season, 1), COALESCE(episode, -1), COALESCE(episode_end, episode, -1)';
const FILE_PREFERENCE = `CASE resolution WHEN '2160p' THEN 4 WHEN '1080p' THEN 3 WHEN '720p' THEN 2 ELSE 1 END DESC,
                         size DESC, id`;
const FIRST_EPISODE_ORDER = 'CASE WHEN season = 0 THEN 1 ELSE 0 END, COALESCE(season, 1), episode IS NULL, episode, episode_end, id';
const WORK_KEY = `CASE
  WHEN series_key IS NOT NULL THEN 'series:' || series_key
  WHEN section = 'movie' THEN 'movie:' || lower(replace(replace(trim(title), ' ', ''), '·', '')) || '#' || COALESCE(year, '')
  ELSE id END`;

function readGenres(value: unknown): Genre[] {
  const entries: unknown = JSON.parse(mustStr(value, '[]'));
  return Array.isArray(entries) ? GENRES.filter((genre) => entries.includes(genre)) : [];
}

function rowToItem(row: Row): MediaItem {
  return {
    id: mustStr(row['id']),
    sourceId: mustStr(row['source_id']),
    path: mustStr(row['path']),
    name: mustStr(row['name']),
    ext: mustStr(row['ext']),
    size: mustNum(row['size']),
    mtime: mustNum(row['mtime']),
    section: (mustStr(row['section'], 'other') as LibrarySection) || 'other',
    title: mustStr(row['title']),
    year: num(row['year']),
    season: num(row['season']),
    episode: num(row['episode']),
    episodeEnd: num(row['episode_end']),
    seriesKey: str(row['series_key']),
    seriesTitle: str(row['series_title']),
    genres: readGenres(row['genres']),
    resolution: str(row['resolution']),
    quality: str(row['quality']),
    videoCodec: str(row['video_codec']),
    audioCodec: str(row['audio_codec']),
    releaseGroup: str(row['release_group']),
    confidence: mustNum(row['confidence']),
    poster: str(row['poster']),
    posterItemId: str(row['poster_item_id']),
    backdrop: str(row['backdrop']),
    overview: str(row['overview']),
    rating: num(row['rating']),
    durationSec: num(row['duration_sec']),
    width: num(row['width']),
    height: num(row['height']),
    addedAt: mustNum(row['added_at']),
    updatedAt: mustNum(row['updated_at']),
    missing: bool(row['missing']),
  };
}

function rowToSource(row: Row): StorageSource {
  let config: SourceConfig;
  try {
    config = JSON.parse(mustStr(row['config'], '{}')) as SourceConfig;
  } catch {
    config = { kind: 'local', roots: [] };
  }
  return {
    id: mustStr(row['id']),
    kind: (mustStr(row['kind'], 'local') as SourceKind) || 'local',
    name: mustStr(row['name']),
    config,
    enabled: bool(row['enabled']),
    lastScanAt: num(row['last_scan_at']),
    lastScanCount: mustNum(row['last_scan_count']),
    lastError: str(row['last_error']),
    createdAt: mustNum(row['created_at']),
  };
}

const ITEM_COLUMNS = [
  'id',
  'source_id',
  'path',
  'name',
  'ext',
  'size',
  'mtime',
  'section',
  'title',
  'year',
  'season',
  'episode',
  'episode_end',
  'series_key',
  'series_title',
  'genres',
  'resolution',
  'quality',
  'video_codec',
  'audio_codec',
  'release_group',
  'confidence',
  'poster',
  'poster_item_id',
  'backdrop',
  'overview',
  'rating',
  'duration_sec',
  'width',
  'height',
  'added_at',
  'updated_at',
  'missing',
] as const;

function itemValues(it: MediaItem): SqlValue[] {
  return [
    it.id,
    it.sourceId,
    it.path,
    it.name,
    it.ext,
    it.size,
    it.mtime,
    it.section,
    it.title,
    it.year,
    it.season,
    it.episode,
    it.episodeEnd,
    it.seriesKey,
    it.seriesTitle,
    JSON.stringify(it.genres ?? []),
    it.resolution,
    it.quality,
    it.videoCodec,
    it.audioCodec,
    it.releaseGroup,
    it.confidence,
    it.poster,
    it.posterItemId ?? null,
    it.backdrop,
    it.overview,
    it.rating,
    it.durationSec,
    it.width,
    it.height,
    it.addedAt,
    it.updatedAt,
    it.missing ? 1 : 0,
  ];
}

/**
 * 元数据字段（poster/overview/rating/duration/宽高）在重扫时不由扫描器覆盖，
 * 否则每次扫描都会清空已抓取的封面。
 */
const UPSERT_ITEM_SQL = `
INSERT INTO items (${ITEM_COLUMNS.join(', ')})
VALUES (${ITEM_COLUMNS.map(() => '?').join(', ')})
ON CONFLICT(source_id, path) DO UPDATE SET
  name = excluded.name,
  ext = excluded.ext,
  size = excluded.size,
  mtime = excluded.mtime,
  section = excluded.section,
  title = excluded.title,
  year = excluded.year,
  season = excluded.season,
  episode = excluded.episode,
  episode_end = excluded.episode_end,
  series_key = excluded.series_key,
  series_title = excluded.series_title,
  genres = excluded.genres,
  resolution = excluded.resolution,
  quality = excluded.quality,
  video_codec = excluded.video_codec,
  audio_codec = excluded.audio_codec,
  release_group = excluded.release_group,
  confidence = excluded.confidence,
  poster = COALESCE(items.poster, excluded.poster),
  poster_item_id = excluded.poster_item_id,
  backdrop = COALESCE(items.backdrop, excluded.backdrop),
  overview = COALESCE(items.overview, excluded.overview),
  rating = COALESCE(items.rating, excluded.rating),
  duration_sec = COALESCE(items.duration_sec, excluded.duration_sec),
  width = COALESCE(items.width, excluded.width),
  height = COALESCE(items.height, excluded.height),
  missing = 0,
  updated_at = excluded.updated_at
`;

export interface Repository {
  readonly db: SqliteHandle;
  close(): void;

  listSources(): StorageSource[];
  getSource(id: string): StorageSource | null;
  insertSource(source: StorageSource): void;
  updateSource(source: StorageSource): void;
  deleteSource(id: string): void;
  clearSourceItems(sourceId: string): void;

  beginScan(sourceId: string): void;
  finishScan(sourceId: string, seenItemIds: ReadonlySet<string>): void;
  upsertItems(items: MediaItem[]): { added: number; updated: number };
  getItem(id: string): MediaItem | null;
  getItemsByIds(ids: string[]): MediaItem[];
  browse(query: BrowseQuery): BrowseResult;
  getSeries(key: string): { summary: SeriesSummary; items: MediaItem[] } | null;
  updateWorkGenres(workKey: string, genres: Genre[] | null): void;
  sectionCounts(): Array<{ section: LibrarySection; count: number }>;
  countItems(): number;
  updateItemMeta(id: string, meta: Partial<Pick<MediaItem, 'poster' | 'backdrop' | 'overview' | 'rating' | 'durationSec' | 'width' | 'height' | 'year' | 'title'>>): void;

  savePlayback(record: PlaybackRecord): void;
  getPlayback(itemId: string): PlaybackRecord | null;
  clearPlayback(itemId: string): void;
  continueWatching(limit: number): Array<{ item: MediaItem; record: PlaybackRecord }>;

  getAllSettings(): Partial<AppSettings>;
  setSetting(key: string, value: unknown): void;
}

export function createRepository(file: string): Repository {
  const db = openDatabase(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');

  const version = mustNum(db.prepare('PRAGMA user_version').get()?.['user_version'], 0);
  if (version < SCHEMA_VERSION) {
    db.exec('BEGIN');
    try {
      if (version < 1) db.exec(DDL_V1);
      if (version < 2) db.exec(DDL_V2);
      if (version < 3) db.exec(DDL_V3);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const upsertStmt = db.prepare(UPSERT_ITEM_SQL);

  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* rollback on closed tx */
      }
      throw err;
    }
  };

  const repo: Repository = {
    db,
    close: () => db.close(),

    listSources() {
      return db.prepare('SELECT * FROM sources ORDER BY created_at ASC').all().map(rowToSource);
    },
    getSource(id) {
      const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
      return row ? rowToSource(row) : null;
    },
    insertSource(source) {
      db.prepare(
        `INSERT INTO sources (id, kind, name, config, enabled, last_scan_at, last_scan_count, last_error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        source.id,
        source.kind,
        source.name,
        JSON.stringify(source.config),
        source.enabled ? 1 : 0,
        source.lastScanAt,
        source.lastScanCount,
        source.lastError,
        source.createdAt,
      );
    },
    updateSource(source) {
      db.prepare(
        `UPDATE sources SET kind = ?, name = ?, config = ?, enabled = ?, last_scan_at = ?, last_scan_count = ?, last_error = ? WHERE id = ?`,
      ).run(
        source.kind,
        source.name,
        JSON.stringify(source.config),
        source.enabled ? 1 : 0,
        source.lastScanAt,
        source.lastScanCount,
        source.lastError,
        source.id,
      );
    },
    deleteSource(id) {
      tx(() => {
        db.prepare('DELETE FROM items WHERE source_id = ?').run(id);
        db.prepare('DELETE FROM sources WHERE id = ?').run(id);
      });
    },
    clearSourceItems(sourceId) {
      db.prepare('DELETE FROM items WHERE source_id = ?').run(sourceId);
    },

    beginScan(sourceId) {
      db.prepare('UPDATE items SET missing = 1 WHERE source_id = ?').run(sourceId);
    },

    finishScan(sourceId, seenItemIds) {
      db.prepare(
        `UPDATE items SET missing = 1
         WHERE source_id = ? AND missing = 0 AND id NOT IN (SELECT value FROM json_each(?))`,
      ).run(sourceId, JSON.stringify([...seenItemIds]));
    },

    upsertItems(items) {
      if (items.length === 0) return { added: 0, updated: 0 };
      const existing = new Set<string>();
      const chunkSize = 400;
      const ids = items.map((i) => i.id);
      for (let i = 0; i < ids.length; i += chunkSize) {
        const slice = ids.slice(i, i + chunkSize);
        const placeholders = slice.map(() => '?').join(', ');
        const rows = db
          .prepare(`SELECT id FROM items WHERE id IN (${placeholders})`)
          .all(...(slice as SqlValue[]));
        for (const r of rows) existing.add(mustStr(r['id']));
      }
      let added = 0;
      let updated = 0;
      tx(() => {
        for (const it of items) {
          upsertStmt.run(...itemValues(it));
          if (existing.has(it.id)) updated += 1;
          else added += 1;
        }
      });
      return { added, updated };
    },

    getItem(id) {
      const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
      return row ? rowToItem(row) : null;
    },

    getItemsByIds(ids) {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => '?').join(', ');
      return db
        .prepare(`SELECT * FROM items WHERE id IN (${placeholders})`)
        .all(...(ids as SqlValue[]))
        .map(rowToItem);
    },

    browse(query) {
      const group = query.group ?? 'item';
      const scope = ['missing = 0'];
      const scopeParams: SqlValue[] = [];
      if (query.section) {
        scope.push('section = ?');
        scopeParams.push(query.section);
      }
      if (query.sourceId) {
        scope.push('source_id = ?');
        scopeParams.push(query.sourceId);
      }
      if (group === 'series') scope.push('series_key IS NOT NULL');
      // 首页的片库独立于音乐和照片分区。
      if (group === 'catalog' && !query.section) scope.push("section IN ('movie', 'tv', 'anime')");

      const filters: string[] = [];
      const filterParams: SqlValue[] = [];
      if (query.search?.trim()) {
        const like = `%${query.search.trim().replace(/[\\%_]/g, '\\$&')}%`;
        filters.push("(title LIKE ? ESCAPE '\\' OR series_title LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')");
        filterParams.push(like, like, like);
      }
      const genreColumn = group === 'item' ? 'genres' : 'effective_genres';
      if (query.genre === 'untagged') {
        filters.push(`json_array_length(${genreColumn}) = 0`);
      } else if (query.genre) {
        filters.push(`EXISTS (SELECT 1 FROM json_each(${genreColumn}) WHERE value = ?)`);
        filterParams.push(query.genre);
      }
      const orderCol = {
        added: 'added_at',
        title: 'title',
        year: 'year',
        rating: 'rating',
        episode: 'episode',
      }[query.sort ?? 'added'];
      const order = query.order === 'asc' ? 'ASC' : 'DESC';
      const limit = query.limit ?? 200;
      const offset = query.offset ?? 0;
      const params = [...scopeParams, ...filterParams];
      if (group !== 'item') {
        const matchingFilter = query.genre === 'untagged'
          ? [...filters.slice(0, -1), 'work_key NOT IN (SELECT work_key FROM scoped WHERE json_array_length(effective_genres) > 0)']
          : filters;
        const cte = `WITH candidates AS (
          SELECT *, ${WORK_KEY} AS work_key FROM items WHERE ${scope.join(' AND ')}
        ), scoped AS (
          SELECT candidates.*, COALESCE(work_genres.genres, candidates.genres) AS effective_genres
          FROM candidates LEFT JOIN work_genres USING (work_key)
        ), matches AS (
          SELECT DISTINCT work_key FROM scoped ${matchingFilter.length ? `WHERE ${matchingFilter.join(' AND ')}` : ''}
        )`;
        const total = mustNum(db.prepare(`${cte} SELECT COUNT(*) AS c FROM matches`).get(...params)?.['c']);
        const rows = db.prepare(`${cte}, ranked AS (
          SELECT scoped.*, ROW_NUMBER() OVER (
            PARTITION BY work_key, ${EPISODE_KEY} ORDER BY ${FILE_PREFERENCE}
          ) AS preference
          FROM scoped JOIN matches USING (work_key)
        ), preferred AS (
          SELECT ranked.*, ROW_NUMBER() OVER (PARTITION BY work_key ORDER BY ${FIRST_EPISODE_ORDER}) AS cover_rank
          FROM ranked WHERE preference = 1
        ), cards AS (
          SELECT work_key, MAX(series_key) AS sk, MAX(CASE WHEN cover_rank = 1 THEN id END) AS artwork_id,
                 COALESCE(MAX(series_title), MAX(title)) AS title,
                 MIN(year) AS year, MAX(section) AS section,
                 GROUP_CONCAT(DISTINCT source_id) AS source_ids,
                 COUNT(*) AS episode_count, COUNT(DISTINCT COALESCE(season, 1)) AS season_count,
                 GROUP_CONCAT(DISTINCT COALESCE(season, 1)) AS seasons,
                 MAX(added_at) AS added_at, MAX(rating) AS rating, MIN(episode) AS episode,
                 MAX(poster) AS poster
          FROM preferred GROUP BY work_key
          ORDER BY ${orderCol} ${order}, title ASC, work_key ASC LIMIT ? OFFSET ?
        ) SELECT cards.*,
          (SELECT MAX(i.episode) FROM items i JOIN playback p ON p.item_id = i.id
           WHERE i.series_key = cards.sk AND i.missing = 0 AND p.finished = 0) AS last_watched_episode,
          (SELECT s.poster_item_id FROM scoped s
           WHERE s.work_key = cards.work_key AND s.poster_item_id IS NOT NULL
           ORDER BY CASE WHEN s.id = cards.artwork_id THEN 0 ELSE 1 END, s.poster_item_id LIMIT 1) AS poster_item_id,
          (SELECT json_group_array(DISTINCT value) FROM scoped JOIN json_each(scoped.effective_genres)
           WHERE scoped.work_key = cards.work_key) AS genres
        FROM cards ORDER BY ${orderCol} ${order}, title ASC, work_key ASC`).all(...params, limit, offset);

        const itemById = new Map(repo.getItemsByIds(rows.filter((row) => row['sk'] === null).map((row) => mustStr(row['artwork_id'])))
          .map((item) => [item.id, item]));
        const entries: CatalogEntry[] = [];
        const series: SeriesSummary[] = [];
        const items: MediaItem[] = [];
        for (const row of rows) {
          if (row['sk'] !== null) {
            const summary = rowToSeries(row);
            series.push(summary);
            entries.push({ kind: 'series', series: summary, workKey: mustStr(row['work_key']) });
          } else {
            const item = itemById.get(mustStr(row['artwork_id']));
            if (!item) continue;
            item.genres = readGenres(row['genres']);
            item.posterItemId = str(row['poster_item_id']);
            items.push(item);
            entries.push({ kind: 'item', item, workKey: mustStr(row['work_key']) });
          }
        }
        return { total, entries, series, items };
      }

      const whereSql = [...scope, ...filters].join(' AND ');
      const total = mustNum(db.prepare(`SELECT COUNT(*) AS c FROM items WHERE ${whereSql}`).get(...params)?.['c']);
      const items = db
        .prepare(
          `SELECT * FROM items WHERE ${whereSql} ORDER BY ${orderCol} ${order}, title ASC LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset)
        .map(rowToItem);
      return { total, items, series: [] };
    },

    getSeries(key) {
      const rows = db
        .prepare(
          `WITH ranked AS (
             SELECT items.*, ROW_NUMBER() OVER (PARTITION BY ${EPISODE_KEY} ORDER BY ${FILE_PREFERENCE}) AS preference
             FROM items WHERE series_key = ? AND missing = 0
           ) SELECT * FROM ranked WHERE preference = 1 ORDER BY ${FIRST_EPISODE_ORDER}`,
        )
        .all(key)
        .map(rowToItem);
      if (rows.length === 0) return null;
      const first = rows[0]!;
      const seasons = [...new Set(rows.map((r) => r.season ?? 1))].sort((a, b) => a - b);
      const info = db.prepare(`SELECT MIN(year) AS year, MAX(poster) AS poster, MAX(added_at) AS added_at,
                               GROUP_CONCAT(DISTINCT source_id) AS source_ids
                               FROM items WHERE series_key = ? AND missing = 0`).get(key);
      const posterItemId = db.prepare(`SELECT poster_item_id FROM items
        WHERE series_key = ? AND missing = 0 AND poster_item_id IS NOT NULL
        ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, poster_item_id LIMIT 1`).get(key, first.id);
      const genres = db.prepare(`SELECT DISTINCT value FROM items JOIN json_each(items.genres)
                                 WHERE series_key = ? AND missing = 0`).all(key).map((row) => row['value']);
      const override = db.prepare('SELECT genres FROM work_genres WHERE work_key = ?').get(`series:${key}`);
      const summary: SeriesSummary = {
        key,
        title: first.seriesTitle ?? first.title,
        year: num(info?.['year']),
        section: first.section,
        sourceIds: mustStr(info?.['source_ids']).split(',').filter(Boolean),
        episodeCount: rows.length,
        seasonCount: seasons.length,
        seasons,
        poster: str(info?.['poster']),
        posterItemId: str(posterItemId?.['poster_item_id']),
        artworkId: first.id,
        genres: override ? readGenres(override['genres']) : GENRES.filter((genre) => genres.includes(genre)),
        latestAddedAt: mustNum(info?.['added_at']),
        lastWatchedEpisode: null,
      };
      return { summary, items: rows };
    },

    updateWorkGenres(workKey, genres) {
      if (!db.prepare(`SELECT 1 FROM items WHERE missing = 0 AND ${WORK_KEY} = ? LIMIT 1`).get(workKey)) {
        throw new Error('作品已移除或尚未入库');
      }
      if (genres === null) {
        db.prepare('DELETE FROM work_genres WHERE work_key = ?').run(workKey);
      } else {
        db.prepare(`INSERT INTO work_genres (work_key, genres) VALUES (?, ?)
                    ON CONFLICT (work_key) DO UPDATE SET genres = excluded.genres`)
          .run(workKey, JSON.stringify(GENRES.filter((genre) => genres.includes(genre))));
      }
    },

    sectionCounts() {
      return db
        .prepare('SELECT section, COUNT(*) AS c FROM items WHERE missing = 0 GROUP BY section')
        .all()
        .map((r) => ({ section: mustStr(r['section'], 'other') as LibrarySection, count: mustNum(r['c']) }));
    },

    countItems() {
      return mustNum(db.prepare('SELECT COUNT(*) AS c FROM items WHERE missing = 0').get()?.['c']);
    },

    updateItemMeta(id, meta) {
      const sets: string[] = [];
      const params: SqlValue[] = [];
      const push = (col: string, value: SqlValue) => {
        sets.push(`${col} = ?`);
        params.push(value);
      };
      if (meta.poster !== undefined) push('poster', meta.poster);
      if (meta.backdrop !== undefined) push('backdrop', meta.backdrop);
      if (meta.overview !== undefined) push('overview', meta.overview);
      if (meta.rating !== undefined) push('rating', meta.rating);
      if (meta.durationSec !== undefined) push('duration_sec', meta.durationSec);
      if (meta.width !== undefined) push('width', meta.width);
      if (meta.height !== undefined) push('height', meta.height);
      if (meta.year !== undefined) push('year', meta.year);
      if (meta.title !== undefined) push('title', meta.title);
      if (sets.length === 0) return;
      push('updated_at', Date.now());
      params.push(id);
      db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    },

    savePlayback(record) {
      db.prepare(
        `INSERT INTO playback (item_id, series_key, position, duration, finished, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET position = excluded.position, duration = excluded.duration,
           finished = excluded.finished, updated_at = excluded.updated_at, series_key = excluded.series_key`,
      ).run(
        record.itemId,
        record.seriesKey,
        record.position,
        record.duration,
        record.finished ? 1 : 0,
        record.updatedAt,
      );
    },

    getPlayback(itemId) {
      const row = db.prepare('SELECT * FROM playback WHERE item_id = ?').get(itemId);
      if (!row) return null;
      return {
        itemId: mustStr(row['item_id']),
        seriesKey: str(row['series_key']),
        position: mustNum(row['position']),
        duration: mustNum(row['duration']),
        finished: bool(row['finished']),
        updatedAt: mustNum(row['updated_at']),
      };
    },

    clearPlayback(itemId) {
      db.prepare('DELETE FROM playback WHERE item_id = ?').run(itemId);
    },

    continueWatching(limit) {
      const rows = db
        .prepare(
          `SELECT * FROM (
             SELECT p.*, ROW_NUMBER() OVER (PARTITION BY COALESCE(i.series_key, i.id) ORDER BY p.updated_at DESC) AS preference
             FROM playback p JOIN items i ON i.id = p.item_id
             WHERE p.finished = 0 AND p.position > 20 AND i.missing = 0
           ) WHERE preference = 1 ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(limit);
      const out: Array<{ item: MediaItem; record: PlaybackRecord }> = [];
      for (const row of rows) {
        const item = repo.getItem(mustStr(row['item_id']));
        if (!item) continue;
        out.push({
          item,
          record: {
            itemId: item.id,
            seriesKey: str(row['series_key']),
            position: mustNum(row['position']),
            duration: mustNum(row['duration']),
            finished: bool(row['finished']),
            updatedAt: mustNum(row['updated_at']),
          },
        });
      }
      return out;
    },

    getAllSettings() {
      const out: Record<string, unknown> = {};
      for (const row of db.prepare('SELECT key, value FROM settings').all()) {
        try {
          out[mustStr(row['key'])] = JSON.parse(mustStr(row['value'], 'null'));
        } catch {
          /* ignore corrupt row */
        }
      }
      return out as Partial<AppSettings>;
    },

    setSetting(key, value) {
      db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(key, JSON.stringify(value ?? null));
    },
  };

  return repo;
}

function rowToSeries(row: Row): SeriesSummary {
  const seasonsRaw = str(row['seasons']) ?? '';
  const seasons = seasonsRaw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  return {
    key: mustStr(row['sk']),
    title: mustStr(row['title']),
    year: num(row['year']),
    section: (mustStr(row['section'], 'tv') as LibrarySection) || 'tv',
    sourceIds: (str(row['source_ids']) ?? '').split(',').filter(Boolean),
    episodeCount: mustNum(row['episode_count']),
    seasonCount: mustNum(row['season_count']),
    seasons,
    poster: str(row['poster']),
    posterItemId: str(row['poster_item_id']),
    artworkId: mustStr(row['artwork_id']),
    genres: readGenres(row['genres']),
    latestAddedAt: mustNum(row['added_at']),
    lastWatchedEpisode: num(row['last_watched_episode']),
  };
}
