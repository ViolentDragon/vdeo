/** IPC 通道契约 — preload 与主进程共用，避免字符串各写一遍 */

export const IPC = {
  appInfo: 'app:info',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  mpvLocate: 'mpv:locate',
  pickDirectory: 'app:pick-directory',
  pickExecutable: 'app:pick-executable',

  playersDetect: 'players:detect',
  playersTest: 'players:test',

  aliyunQrStart: 'aliyun:qr-start',
  aliyunQrPoll: 'aliyun:qr-poll',

  sourcesList: 'sources:list',
  sourcesCreate: 'sources:create',
  sourcesUpdate: 'sources:update',
  sourcesRemove: 'sources:remove',
  sourcesTest: 'sources:test',

  scanStart: 'scan:start',
  scanCancel: 'scan:cancel',

  libraryBrowse: 'library:browse',
  librarySeries: 'library:series',
  librarySections: 'library:sections',
  libraryContinue: 'library:continue',
  libraryItem: 'library:item',

  playItem: 'play:item',
  playCommand: 'play:command',
  playStop: 'play:stop',

  evScan: 'ev:scan',
  evPlayer: 'ev:player',
  evLibrary: 'ev:library',
} as const;

export type Rpc<T> = { ok: true; data: T } | { ok: false; error: string };
