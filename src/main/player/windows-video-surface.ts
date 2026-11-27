import { load, pointer, proto, register, struct, unregister } from 'koffi';
import type { VideoSurfaceBounds } from '../../shared/types';

const user32 = load('user32.dll');
const controls = load('comctl32.dll');
const subclassProc = proto('intptr_t __stdcall NebulaSurfaceProc(uintptr_t, uint32_t, uintptr_t, intptr_t, uintptr_t, uintptr_t)');
const setWindowSubclass = controls.func('int __stdcall SetWindowSubclass(uintptr_t, NebulaSurfaceProc *, uintptr_t, uintptr_t)');
const removeWindowSubclass = controls.func('int __stdcall RemoveWindowSubclass(uintptr_t, NebulaSurfaceProc *, uintptr_t)');
const defSubclassProc = controls.func('intptr_t __stdcall DefSubclassProc(uintptr_t, uint32_t, uintptr_t, intptr_t)');
struct('NebulaClientRect', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const createWindow = user32.func('uintptr_t __stdcall CreateWindowExW(uint32_t, str16, str16, uint32_t, int, int, int, int, uintptr_t, uintptr_t, uintptr_t, uintptr_t)');
const getClientRect = user32.func('int __stdcall GetClientRect(uintptr_t, _Out_ NebulaClientRect *)');
const setWindowPos = user32.func('int __stdcall SetWindowPos(uintptr_t, uintptr_t, int, int, int, int, uint32_t)');
const showWindow = user32.func('int __stdcall ShowWindow(uintptr_t, int)');

const WS_CHILD = 0x40000000;
const WS_CLIPCHILDREN = 0x02000000;
const SS_BLACKRECT = 0x00000004;
const SS_NOTIFY = 0x00000100;
const WM_NCDESTROY = 0x0082;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_LBUTTONDBLCLK = 0x0203;
const WM_MOUSEWHEEL = 0x020a;

type SurfaceInput = 'click' | 'ArrowUp' | 'ArrowDown';
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;

export class WindowsVideoSurface {
  readonly wid: string;
  private readonly parent: bigint;
  private readonly hwnd: number | bigint;
  private geometry: string | null = null;

  constructor(nativeHandle: Buffer, onInput: (code: SurfaceInput) => void) {
    this.parent = nativeHandle.readBigUInt64LE();
    // mpv reparents its own video window to this child and resizes to fill it.
    this.hwnd = createWindow(0, 'Static', '', WS_CHILD | WS_CLIPCHILDREN | SS_BLACKRECT | SS_NOTIFY,
      0, 0, 1, 1, this.parent, 0, 0, 0);
    if (!this.hwnd) throw new Error('无法创建页面内的视频区域');
    // mpv expects an unsigned 32-bit HWND on Windows.
    this.wid = BigInt.asUintN(32, BigInt(this.hwnd)).toString();
    this.listenForInput(onInput);
  }

  private listenForInput(onInput: (code: SurfaceInput) => void): void {
    let pressed = false;
    const dispatch = (code: SurfaceInput) => queueMicrotask(() => onInput(code));
    const callback = register((hwnd: number | bigint, message: number, wParam: number | bigint, lParam: number | bigint) => {
      switch (message) {
        case WM_LBUTTONDOWN:
        case WM_LBUTTONDBLCLK:
          pressed = true;
          return 0;
        case WM_LBUTTONUP:
          if (pressed) dispatch('click');
          pressed = false;
          return 0;
        case WM_MOUSEWHEEL: {
          const delta = BigInt.asIntN(16, BigInt(wParam) >> 16n);
          if (delta) dispatch(delta > 0 ? 'ArrowUp' : 'ArrowDown');
          return 0;
        }
        case WM_NCDESTROY:
          removeWindowSubclass(hwnd, callback, 1);
          queueMicrotask(() => unregister(callback));
          break;
      }
      return defSubclassProc(hwnd, message, wParam, lParam);
    }, pointer(subclassProc));
    if (!setWindowSubclass(this.hwnd, callback, 1, 0)) unregister(callback);
  }

  show(bounds: VideoSurfaceBounds): void {
    const rect = { left: 0, top: 0, right: 0, bottom: 0 };
    if (!getClientRect(this.parent, rect)) return;
    const { x, y, width, height, scale } = bounds;
    const left = Math.max(0, Math.round(x * scale));
    const top = Math.max(0, Math.round(y * scale));
    const right = Math.min(rect.right, Math.round((x + width) * scale));
    const bottom = Math.min(rect.bottom, Math.round((y + height) * scale));
    if (right <= left || bottom <= top) {
      this.hide();
      return;
    }
    const geometry = [left, top, right, bottom].join(',');
    if (geometry === this.geometry) return;
    if (setWindowPos(this.hwnd, 0, left, top, right - left, bottom - top, SWP_NOACTIVATE | SWP_SHOWWINDOW)) {
      this.geometry = geometry;
    }
  }

  hide(): void {
    if (this.geometry === null) return;
    showWindow(this.hwnd, 0);
    this.geometry = null;
  }
}
