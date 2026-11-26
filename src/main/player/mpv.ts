import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PlaybackTarget, PlayerState, TrackInfo } from '../../shared/types';

export interface MpvOptions {
  mpvPath: string;
  /** 目标窗口句柄（十进制字符串）；给出时用 --wid 嵌入 */
  wid?: string | null;
  hardwareDecode: boolean;
}

const INITIAL_STATE: PlayerState = {
  status: 'idle',
  itemId: null,
  title: null,
  position: 0,
  duration: 0,
  volume: 100,
  muted: false,
  speed: 1,
  pausedForCache: false,
  fullscreen: false,
  mode: 'embedded',
  mpvAvailable: true,
  mpvPath: null,
  error: null,
  tracks: [],
  activeAudioId: null,
  activeSubId: null,
};

const OBSERVED = ['pause', 'time-pos', 'duration', 'volume', 'mute', 'speed', 'track-list', 'fullscreen', 'aid', 'sid'];

export class MpvController extends EventEmitter {
  private state: PlayerState = { ...INITIAL_STATE };
  private proc: ChildProcess | null = null;
  private sock: Socket | null = null;
  private buffer = '';
  private reqId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private pipePath: string;
  private starting: Promise<void> | null = null;
  private stopping = false;
  private pendingSubtitles: string[] = [];
  private lastTarget: PlaybackTarget | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: MpvOptions) {
    super();
    const name = `nebula-mpv-${process.pid}-${randomBytes(4).toString('hex')}`;
    this.pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
    this.state.mpvPath = opts.mpvPath;
  }

  getState(): PlayerState {
    return { ...this.state, tracks: [...this.state.tracks] };
  }

  private patch(p: Partial<PlayerState>): void {
    this.state = { ...this.state, ...p };
    this.emit('state', this.getState());
  }

  private get running(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  async ensureStarted(): Promise<void> {
    if (this.sock) return;
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    const args = [
      `--input-ipc-server=${this.pipePath}`,
      '--idle=yes',
      '--no-terminal',
      '--keep-open=no',
      '--sub-auto=fuzzy',
      '--audio-file-auto=fuzzy',
      '--msg-level=all=warn',
      `--hwdec=${this.opts.hardwareDecode ? 'auto-safe' : 'no'}`,
    ];
    if (this.opts.wid) args.push(`--wid=${this.opts.wid}`);

    this.stopping = false;
    const proc = spawn(this.opts.mpvPath, args, {
      windowsHide: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.proc = proc;

    let stderrTail = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    proc.on('error', (err) => {
      this.patch({ status: 'error', error: `无法启动 mpv：${err.message}` });
    });
    proc.on('exit', (code) => {
      this.proc = null;
      this.sock?.destroy();
      this.sock = null;
      if (!this.stopping) {
        this.patch({
          status: code === 0 ? 'ended' : 'error',
          error: code === 0 ? null : `mpv 退出（code=${code}）${stderrTail ? `：${stderrTail.trim().split('\n').pop()}` : ''}`,
        });
      }
    });

    await this.connectWithRetry(proc, 20);
  }

  private async connectWithRetry(proc: ChildProcess, attempts: number): Promise<void> {
    let lastErr: Error | null = null;
    for (let i = 0; i < attempts; i += 1) {
      if (proc.exitCode !== null) {
        throw new Error(`mpv 提前退出（code=${proc.exitCode}）`);
      }
      try {
        await this.connectOnce();
        await this.attachObservers();
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error(`连接 mpv IPC 失败：${lastErr?.message ?? '未知原因'}`);
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = connect(this.pipePath);
      const onError = (err: Error) => {
        sock.destroy();
        reject(err);
      };
      sock.once('error', onError);
      sock.once('connect', () => {
        sock.off('error', onError);
        sock.on('error', (err) => this.patch({ error: `mpv IPC 错误：${err.message}` }));
        sock.on('data', (chunk: Buffer) => this.onData(chunk));
        sock.on('close', () => {
          if (this.sock === sock) this.sock = null;
        });
        this.sock = sock;
        resolve();
      });
    });
  }

  private async attachObservers(): Promise<void> {
    for (const name of OBSERVED) {
      const id = 2;
      try {
        await this.send([`observe_property`, id + OBSERVED.indexOf(name), name], 3000);
      } catch {
        /* 单个属性观察失败不致命 */
      }
    }
    try {
      await this.send(['set_property', 'keep-open', 'no'], 2000);
    } catch {
      /* ignore */
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx = this.buffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.handleMessage(line);
      idx = this.buffer.indexOf('\n');
    }
  }

  private handleMessage(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const requestId = msg['request_id'];
    if (typeof requestId === 'number') {
      const waiter = this.pending.get(requestId);
      if (waiter) {
        this.pending.delete(requestId);
        const err = msg['error'];
        if (err === 'success' || err === undefined) waiter.resolve(msg['data']);
        else waiter.reject(new Error(String(err)));
      }
      return;
    }
    const event = msg['event'];
    if (typeof event !== 'string') return;

    switch (event) {
      case 'property-change': {
        const name = String(msg['name']);
        const data = msg['data'];
        if (name === 'time-pos' && typeof data === 'number') this.patch({ position: data });
        else if (name === 'duration' && typeof data === 'number') this.patch({ duration: data });
        else if (name === 'pause' && typeof data === 'boolean') {
          if (this.state.status !== 'ended') this.patch({ status: data ? 'paused' : 'playing' });
        } else if (name === 'volume' && typeof data === 'number') this.patch({ volume: data });
        else if (name === 'mute' && typeof data === 'boolean') this.patch({ muted: data });
        else if (name === 'speed' && typeof data === 'number') this.patch({ speed: data });
        else if (name === 'fullscreen' && typeof data === 'boolean') this.patch({ fullscreen: data });
        else if (name === 'track-list' && Array.isArray(data)) this.patch({ tracks: toTracks(data) });
        else if (name === 'aid' && (typeof data === 'number' || data === null)) {
          this.patch({ activeAudioId: typeof data === 'number' ? data : null });
        } else if (name === 'sid' && (typeof data === 'number' || data === null)) {
          this.patch({ activeSubId: typeof data === 'number' ? data : null });
        }
        break;
      }
      case 'file-loaded': {
        this.patch({ status: 'playing', error: null });
        void this.applySubtitles();
        break;
      }
      case 'end-file': {
        const reason = String(msg['reason'] ?? '');
        if (reason === 'eof') {
          this.patch({ status: 'ended', position: this.state.duration });
          this.emit('finished', this.state.itemId);
        } else if (reason === 'error') {
          this.patch({ status: 'error', error: '播放失败（解码或地址不可达）' });
        } else if (reason === 'stop') {
          this.patch({ status: 'idle', itemId: null });
        }
        break;
      }
      case 'idle':
        this.patch({ status: 'idle' });
        break;
      default:
        break;
    }
  }

  private async applySubtitles(): Promise<void> {
    if (this.pendingSubtitles.length === 0) return;
    for (const sub of this.pendingSubtitles.splice(0)) {
      try {
        await this.send(['sub-add', sub, 'select'], 5000);
      } catch {
        /* 字幕加载失败不应影响播放 */
      }
    }
  }

  private send(command: unknown[], timeoutMs = 8000): Promise<unknown> {
    if (!this.sock) return Promise.reject(new Error('mpv IPC 未连接'));
    const id = ++this.reqId;
    const payload = `${JSON.stringify({ command, request_id: id })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mpv 命令超时：${JSON.stringify(command)}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.sock!.write(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  setProperty(name: string, value: unknown): Promise<unknown> {
    return this.send(['set_property', name, value]);
  }

  async play(target: PlaybackTarget): Promise<void> {
    await this.ensureStarted();
    this.lastTarget = target;
    this.patch({ status: 'loading', itemId: target.itemId, title: target.title, error: null, position: target.startAt, duration: 0 });
    const headerField = Object.entries(target.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join(',');
    try {
      await this.setProperty('http-header-fields', headerField);
    } catch {
      /* 无请求头时忽略 */
    }
    this.pendingSubtitles = [...target.subtitles];
    try {
      await this.setProperty('start', target.startAt > 5 ? String(target.startAt) : '0');
      await this.send(['loadfile', target.url, 'replace']);
    } catch (err) {
      this.patch({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  async togglePause(): Promise<void> {
    if (!this.sock) return;
    try {
      const paused = await this.send(['get_property', 'pause']);
      await this.setProperty('pause', !paused);
    } catch {
      /* ignore */
    }
  }

  async seek(seconds: number, mode: 'absolute' | 'relative' = 'absolute'): Promise<void> {
    try {
      await this.send(['seek', seconds, mode]);
    } catch {
      /* ignore */
    }
  }

  async setVolume(v: number): Promise<void> {
    try {
      await this.setProperty('volume', Math.max(0, Math.min(150, v)));
    } catch {
      /* ignore */
    }
  }

  async toggleMute(): Promise<void> {
    try {
      const m = await this.send(['get_property', 'mute']);
      await this.setProperty('mute', !m);
    } catch {
      /* ignore */
    }
  }

  async setSpeed(v: number): Promise<void> {
    try {
      await this.setProperty('speed', v);
    } catch {
      /* ignore */
    }
  }

  async setAudio(id: number): Promise<void> {
    try {
      await this.setProperty('aid', id);
    } catch {
      /* ignore */
    }
  }

  async setSubtitle(id: number): Promise<void> {
    try {
      await this.setProperty('sid', id);
    } catch {
      /* ignore */
    }
  }

  async addSubtitle(path: string): Promise<void> {
    try {
      await this.send(['sub-add', path, 'select']);
    } catch {
      /* ignore */
    }
  }

  async toggleFullscreen(): Promise<void> {
    try {
      const fs = await this.send(['get_property', 'fullscreen']);
      await this.setProperty('fullscreen', !fs);
    } catch {
      /* ignore */
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.pendingSubtitles = [];
    if (this.sock) {
      try {
        await this.send(['quit'], 3000);
      } catch {
        /* ignore */
      }
      this.sock.destroy();
      this.sock = null;
    }
    this.proc?.kill();
    this.proc = null;
    this.patch({ status: 'idle', itemId: null, title: null, position: 0, duration: 0, tracks: [] });
  }

  dispose(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    void this.stop();
  }
}

function toTracks(raw: unknown[]): TrackInfo[] {
  const out: TrackInfo[] = [];
  for (const t of raw) {
    if (typeof t !== 'object' || t === null) continue;
    const rec = t as Record<string, unknown>;
    const type = String(rec['type'] ?? '');
    if (type !== 'audio' && type !== 'sub' && type !== 'video') continue;
    out.push({
      id: Number(rec['id'] ?? 0),
      type,
      title: String(rec['title'] ?? rec['lang'] ?? `#${rec['id']}`),
      lang: rec['lang'] ? String(rec['lang']) : null,
      selected: rec['selected'] === true,
      external: rec['external'] === true,
    });
  }
  return out;
}
