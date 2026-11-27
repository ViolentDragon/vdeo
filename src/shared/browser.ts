import { IPC } from './ipc-contract';

export const BROWSER_SOURCE_PATH = '/api/storage';
const browserChannels = [IPC.aliyunQrStart, IPC.aliyunQrPoll, IPC.sourcesList, IPC.browseList,
  IPC.sourcesTest, IPC.sourcesScanScope, IPC.libraryBrowse, IPC.librarySeries] as const;
export type BrowserSourceChannel = (typeof browserChannels)[number];

export function isBrowserSourceChannel(channel: unknown): channel is BrowserSourceChannel {
  return browserChannels.some((allowed) => allowed === channel);
}
