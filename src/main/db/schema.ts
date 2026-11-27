/** SQLite DDL — 迁移通过 PRAGMA user_version 递增执行 */

export const SCHEMA_VERSION = 5;

export const DDL_V1 = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_scan_at INTEGER,
  last_scan_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  section TEXT NOT NULL,
  title TEXT NOT NULL,
  year INTEGER,
  season INTEGER,
  episode INTEGER,
  episode_end INTEGER,
  series_key TEXT,
  series_title TEXT,
  resolution TEXT,
  quality TEXT,
  video_codec TEXT,
  audio_codec TEXT,
  release_group TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  poster TEXT,
  backdrop TEXT,
  overview TEXT,
  rating REAL,
  duration_sec REAL,
  width INTEGER,
  height INTEGER,
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  missing INTEGER NOT NULL DEFAULT 0,
  UNIQUE(source_id, path)
);

CREATE INDEX IF NOT EXISTS idx_items_section ON items(section, missing);
CREATE INDEX IF NOT EXISTS idx_items_source ON items(source_id, missing);
CREATE INDEX IF NOT EXISTS idx_items_series ON items(series_key);
CREATE INDEX IF NOT EXISTS idx_items_updated ON items(updated_at);

CREATE TABLE IF NOT EXISTS playback (
  item_id TEXT PRIMARY KEY,
  series_key TEXT,
  position REAL NOT NULL,
  duration REAL NOT NULL,
  finished INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_playback_updated ON playback(updated_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const DDL_V2 = `
ALTER TABLE items ADD COLUMN genres TEXT NOT NULL DEFAULT '[]';
CREATE TABLE work_genres (
  work_key TEXT PRIMARY KEY,
  genres TEXT NOT NULL
);
`;

export const DDL_V3 = `ALTER TABLE items ADD COLUMN poster_item_id TEXT;`;

export const WORK_KEY = `CASE
  WHEN series_key IS NOT NULL THEN 'series:' || series_key
  WHEN section = 'movie' THEN 'movie:' || lower(replace(replace(trim(title), ' ', ''), '·', '')) || '#' || COALESCE(year, '')
  ELSE id END`;

export const DDL_V4 = `ALTER TABLE items ADD COLUMN search_alias TEXT;`;

export const DDL_V5 = `
CREATE TABLE tmdb_metadata (
  tmdb_work_key TEXT PRIMARY KEY,
  tmdb_id INTEGER,
  tmdb_year INTEGER,
  tmdb_poster TEXT,
  tmdb_backdrop TEXT,
  tmdb_overview TEXT,
  tmdb_rating REAL,
  checked_at INTEGER NOT NULL
);

CREATE VIEW library_items AS
  SELECT items.*, ${WORK_KEY} AS work_key,
         COALESCE(poster, tmdb_poster) AS display_poster,
         COALESCE(backdrop, tmdb_backdrop) AS display_backdrop,
         COALESCE(overview, tmdb_overview) AS display_overview,
         COALESCE(rating, tmdb_rating) AS display_rating,
         CASE WHEN series_key IS NULL THEN COALESCE(year, tmdb_year)
           ELSE COALESCE(tmdb_year, year) END AS display_year
  FROM items LEFT JOIN tmdb_metadata ON tmdb_work_key = (${WORK_KEY});
`;
