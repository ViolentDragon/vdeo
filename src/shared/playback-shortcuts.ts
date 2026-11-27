export interface PlaybackShortcut {
  code: string;
  mpv: string;
  command: 'toggle-pause' | 'seek-relative' | 'volume-relative' | 'mute' | 'fullscreen' | 'exit-fullscreen';
  value?: number;
  repeat?: boolean;
}

export const PLAYBACK_SHORTCUTS: readonly PlaybackShortcut[] = [
  { code: 'Space', mpv: 'SPACE', command: 'toggle-pause' },
  { code: 'KeyK', mpv: 'k', command: 'toggle-pause' },
  { code: 'ArrowLeft', mpv: 'LEFT', command: 'seek-relative', value: -10, repeat: true },
  { code: 'ArrowRight', mpv: 'RIGHT', command: 'seek-relative', value: 10, repeat: true },
  { code: 'ArrowUp', mpv: 'UP', command: 'volume-relative', value: 5, repeat: true },
  { code: 'ArrowDown', mpv: 'DOWN', command: 'volume-relative', value: -5, repeat: true },
  { code: 'KeyM', mpv: 'm', command: 'mute' },
  { code: 'KeyF', mpv: 'f', command: 'fullscreen' },
  { code: 'Escape', mpv: 'ESC', command: 'exit-fullscreen' },
];
