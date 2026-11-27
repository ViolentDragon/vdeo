import { useEffect, useRef } from 'react';

// Only the hovered element is updated, at most once per rendered frame.
export function usePointerMotion() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const enabled = window.matchMedia('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)');
    let active: HTMLElement | null = null;
    let frame = 0;
    let x = 0;
    let y = 0;

    const reset = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (active) active.removeAttribute('data-tracking');
      active = null;
    };
    const targetOf = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>('[data-motion]') : null;

    const render = () => {
      frame = 0;
      if (!active?.isConnected) return;
      const bounds = (active.parentElement?.classList.contains('catalog-card') ? active.parentElement : active).getBoundingClientRect();
      if (!bounds?.width || !bounds.height) return;
      const px = Math.min(1, Math.max(0, (x - bounds.left) / bounds.width));
      const py = Math.min(1, Math.max(0, (y - bounds.top) / bounds.height));
      active.style.setProperty('--pointer-x', String(px - 0.5));
      active.style.setProperty('--pointer-y', String(py - 0.5));
      active.setAttribute('data-tracking', '');
    };

    const move = (event: PointerEvent) => {
      if (!enabled.matches || event.pointerType !== 'mouse') return;
      const target = targetOf(event.target);
      if (target !== active) {
        reset();
        if (!target || target.matches(':disabled')) return;
        active = target;
      }
      x = event.clientX;
      y = event.clientY;
      if (!frame) frame = requestAnimationFrame(render);
    };

    const leave = (event: PointerEvent) => {
      if (active && targetOf(event.relatedTarget) !== active) reset();
    };

    host.addEventListener('pointermove', move, { passive: true });
    host.addEventListener('pointerout', leave);
    enabled.addEventListener('change', reset);
    return () => {
      reset();
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerout', leave);
      enabled.removeEventListener('change', reset);
    };
  }, []);

  return root;
}
