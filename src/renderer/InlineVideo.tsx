import { useLayoutEffect, useRef } from 'react';
import { IPC } from '../shared/ipc-contract';
import type { PlayerState, VideoSurfaceBounds } from '../shared/types';

function setVideoBounds(bounds: VideoSurfaceBounds | null): void {
  void window.nebula.invoke(IPC.playSurface, bounds).catch(() => undefined);
}

export function InlineVideo({ player, opening, error, onRetry }: {
  player: PlayerState | null;
  opening: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const ready = !error && !opening && Boolean(player?.itemId && (player.status === 'playing' || player.status === 'paused'));

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!ready || !element) return;

    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const { x, y, width, height } = element.getBoundingClientRect();
        setVideoBounds(width && height ? { x, y, width, height, scale: window.devicePixelRatio } : null);
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    const header = element.closest('.watch-page')?.querySelector('.watch-header');
    if (header) observer.observe(header);
    window.addEventListener('resize', update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', update);
      setVideoBounds(null);
    };
  }, [ready]);

  return (
    <section className="inline-player" aria-label="视频画面">
      <div className="inline-player__viewport" ref={viewport}>
        {error ? <div className="inline-player__message">
          <p role="alert">{error}</p>
          <button className="btn btn--ghost" onClick={onRetry}>重试播放</button>
        </div> : ready ? null : <div className="inline-player__message" role="status">
          {player?.status === 'ended' && !opening ? '播放已结束' : '正在打开视频…'}
        </div>}
      </div>
    </section>
  );
}
