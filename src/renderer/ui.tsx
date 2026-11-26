import { useEffect, useRef, type ReactNode } from 'react';
import { IPC, type Rpc } from '../shared/ipc-contract';

export async function call<T>(channel: string, payload?: unknown): Promise<T> {
  const result = await window.nebula.invoke<Rpc<T>>(channel, payload);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

const icons = {
  home: 'M3 10.5 12 3l9 7.5V21H3z M9 21v-7h6v7',
  movie: 'M3 8h18v12H3z M3 8l-1-4 17-2 1 4 M7 3.5l2 3.3m4-4.1 2 3.3',
  tv: 'M3 6h18v13H3z m7-3 2 3 3-3 M8 22h8',
  anime: 'M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z',
  music: 'M9 17V5l12-2v12 M9 9l12-2 M9 17c0 1.7-1.6 3-3.5 3S2 19.1 2 17.5 3.6 15 5.5 15 9 15.5 9 17Zm12-2c0 1.7-1.6 3-3.5 3S14 17.1 14 15.5s1.6-2.5 3.5-2.5 3.5.5 3.5 2Z',
  photo: 'M3 4h18v16H3z M3 17l5-5 4 4 3-3 6 6 M16 8h.01',
  continue: 'M12 8v4l3 2 M3 10a9 9 0 1 1 1.8 7.6 M3 4v6h6',
  sources: 'M3 5h18v6H3z M3 14h18v6H3z M6 8h.01 M6 17h.01 M10 8h7 M10 17h7',
  settings: 'M10 3h4l.7 2.6 2 .9 2.5-1 2 3.5-1.9 1.8v2.4l1.9 1.8-2 3.5-2.5-1-2 .9L14 21h-4l-.7-2.6-2-.9-2.5 1-2-3.5 1.9-1.8v-2.4L2.8 9l2-3.5 2.5 1 2-.9z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  search: 'M15.5 15.5 21 21 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z',
  scan: 'M3 8V4h4m10 0h4v4m0 8v4h-4m-10 0H3v-4 M3 12h18',
  plus: 'M12 5v14M5 12h14',
  forward: 'M4 12h15m-6-6 6 6-6 6',
  back: 'M20 12H5m6-6-6 6 6 6',
  chevron: 'm9 6 6 6-6 6',
  down: 'M12 4v15m-6-6 6 6 6-6',
  folder: 'M3 6h7l2 3h9v11H3z',
  file: 'M5 3h9l5 5v13H5z M14 3v6h5 M8 13h8m-8 4h6',
  disk: 'M3 16 6 5h12l3 11v4H3z M3 16h18 M6 18h.01',
  play: 'm8 5 12 7-12 7z',
  pause: 'M9 5v14m6-14v14',
  rewind: 'M10 6 3 12l7 6z m10 0-7 6 7 6Z',
  skip: 'm4 6 7 6-7 6z m10 0 7 6-7 6z',
  volume: 'M3 9h4l5-4v14l-5-4H3z M16 9a4 4 0 0 1 0 6m3-9a8 8 0 0 1 0 12',
  mute: 'M3 9h4l5-4v14l-5-4H3z m13 1 5 5m0-5-5 5',
  fullscreen: 'M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5',
  close: 'm6 6 12 12M18 6 6 18',
  edit: 'm4 16-1 5 5-1L20 8l-4-4z m10-10 4 4',
  check: 'm5 12 5 5L20 7',
  cloud: 'M7 19a5 5 0 0 1-.7-10A6 6 0 0 1 18 8a5.5 5.5 0 0 1-.5 11z',
  link: 'M10 14l4-4 M8 16l-1 1a3.5 3.5 0 0 1-5-5l5-5a3.5 3.5 0 0 1 5 0 M16 8l1-1a3.5 3.5 0 0 1 5 5l-5 5a3.5 3.5 0 0 1-5 0',
} as const;

export type IconName = keyof typeof icons;

export function Icon({ name }: { name: IconName }) {
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={icons[name]} />
  </svg>;
}

export function PageHeading({ title, description, icon, onBack, backDisabled, action }: {
  title: string;
  description?: string;
  icon?: IconName;
  onBack?: () => void;
  backDisabled?: boolean;
  action?: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (onBack) heading.current?.focus({ preventScroll: true });
    // Focus the heading on entry, while leaving focus alone during form updates.
  }, []);

  return <header className="page-heading">
    {onBack ? <button className="btn back-link" onClick={onBack} disabled={backDisabled}><Icon name="back" /> 返回</button> : null}
    <div className="page-heading__row">
      {icon ? <span className="page-heading__icon"><Icon name={icon} /></span> : null}
      <div className="page-heading__copy">
        <h1 ref={heading} tabIndex={onBack ? -1 : undefined}>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {action}
    </div>
  </header>;
}
