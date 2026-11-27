/** IPC 通道契约 — preload 与主进程共用，避免字符串各写一遍 */

export const IPC = {
  appInfo: 'app:info',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  tmdbStatus: 'tmdb:status',
  tmdbConfigure: 'tmdb:configure',
  tmdbSyncStart: 'tmdb:sync-start',
  tmdbSyncCancel: 'tmdb:sync-cancel',
  mpvLocate: 'mpv:locate',
  localPaths: 'app:local-paths',

  playersDetect: 'players:detect',
  playersTest: 'players:test',

  aliyunQrStart: 'aliyun:qr-start',
  aliyunQrPoll: 'aliyun:qr-poll',

  browseList: 'browse:list',

  updateCheck: 'update:check',
  updateOpenRelease: 'update:open-release',

  sourcesList: 'sources:list',
  sourcesCreate: 'sources:create',
  sourcesUpdate: 'sources:update',
  sourcesScanScope: 'sources:scan-scope',
  sourcesRemove: 'sources:remove',
  sourcesTest: 'sources:test',

  scanStart: 'scan:start',
  scanCancel: 'scan:cancel',

  libraryBrowse: 'library:browse',
  librarySeries: 'library:series',
  librarySections: 'library:sections',
  libraryContinue: 'library:continue',
  libraryItem: 'library:item',
  libraryArtwork: 'library:artwork',
  libraryGenresUpdate: 'library:genres-update',

  playItem: 'play:item',
  playCommand: 'play:command',
  playStop: 'play:stop',
  playSurface: 'play:surface',

  evScan: 'ev:scan',
  evPlayer: 'ev:player',
  evLibrary: 'ev:library',
  evTmdbSync: 'ev:tmdb-sync',
} as const;

export type Rpc<T> = { ok: true; data: T } | { ok: false; error: string };

export type LocalPathMode = 'directory' | 'executable';
export interface LocalPathListing {
  path: string;
  parent: string;
  entries: Array<{ name: string; path: string; directory: boolean }>;
}
