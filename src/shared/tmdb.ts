export const TMDB_SITE = 'https://www.themoviedb.org/';
export const TMDB_API_SETTINGS = 'https://www.themoviedb.org/settings/api';

export interface TmdbSyncStatus {
  phase: 'idle' | 'running' | 'done' | 'cancelled' | 'error';
  total: number;
  matched: number;
  unmatched: number;
  error: string | null;
}

export interface TmdbStatus {
  configured: boolean;
  sync: TmdbSyncStatus;
}
