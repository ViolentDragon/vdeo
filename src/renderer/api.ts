import { version } from '../../package.json';
import { IPC, type Rpc } from '../shared/ipc-contract';
import { BROWSER_SOURCE_PATH, isBrowserSourceChannel } from '../shared/browser';
import { DEFAULT_PLAYER_CONFIG, type AppSettings } from '../shared/types';

export const isBrowserPreview = import.meta.env.MODE === 'browser';

function createBrowserApi(): Window['nebula'] {
  const session = document.querySelector<HTMLMetaElement>('meta[name="nebula-browser-session"]')?.content;
  const settings: AppSettings = {
    mpvPath: null,
    player: DEFAULT_PLAYER_CONFIG,
    theme: 'dark',
    ignorePatterns: [],
    videoExtensions: [],
    hardwareDecode: true,
    cacheDir: '',
  };
  const unavailable = '此操作请在星云影库桌面版完成。';
  const responses: Record<string, unknown> = {
    [IPC.appInfo]: { version },
    [IPC.settingsGet]: settings,
    [IPC.libraryContinue]: [],
    [IPC.mpvLocate]: { mpvPath: null, message: unavailable },
    [IPC.playersDetect]: {
      mpv: { path: null, source: 'none', message: unavailable },
      external: [],
      player: settings.player,
    },
  };

  return {
    channel: IPC,
    async invoke<T>(channel: string, payload?: unknown): Promise<T> {
      if (isBrowserSourceChannel(channel)) {
        if (!session) return { ok: false, error: '请重新双击 start-browser.cmd，从新打开的页面进入。' } as T;
        try {
          const response = await fetch(BROWSER_SOURCE_PATH, {
            method: 'POST',
            mode: 'same-origin',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
            body: JSON.stringify({ channel, payload }),
          });
          return await response.json() as T;
        } catch {
          return { ok: false, error: '无法连接本机服务，请重新运行浏览器启动脚本。' } as T;
        }
      }
      const result: Rpc<unknown> = Object.hasOwn(responses, channel)
        ? { ok: true, data: responses[channel] }
        : { ok: false, error: unavailable };
      return result as T;
    },
    on: () => () => {},
  };
}

export const api = isBrowserPreview ? createBrowserApi() : window.nebula;
