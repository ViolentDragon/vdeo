import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-contract';

type Unsubscribe = () => void;

const api = {
  channel: IPC,
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T> {
    return ipcRenderer.invoke(channel, payload) as Promise<T>;
  },
  on<T = unknown>(channel: string, listener: (data: T) => void): Unsubscribe {
    const handler = (_event: unknown, data: T) => listener(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld('nebula', api);

export type NebulaApi = typeof api;
