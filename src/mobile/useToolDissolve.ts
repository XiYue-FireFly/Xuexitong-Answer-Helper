import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { NativeWebView } from '../platform/nativeWebViewPlugin';
import { dissolveSurface } from './dissolve';

export function useToolDissolve(sheet: RefObject<HTMLElement>, canvas: RefObject<HTMLCanvasElement>) {
  const revision = useRef(0);
  const cleanup = useRef<() => void>(() => {});
  const [dissolving, setDissolving] = useState(false);
  const [mode, setMode] = useState<'close' | 'switch' | null>(null);
  const cancel = useCallback(() => {
    ++revision.current;
    cleanup.current(); cleanup.current = () => {};
    sheet.current?.classList.remove('is-dissolving');
    setDissolving(false);
    setMode(null);
  }, [sheet]);
  useEffect(() => {
    const hide = () => { if (document.hidden) cancel(); };
    window.addEventListener('resize', cancel);
    document.addEventListener('visibilitychange', hide);
    return () => { ++revision.current; cleanup.current(); window.removeEventListener('resize', cancel); document.removeEventListener('visibilitychange', hide); };
  }, [cancel]);

  const run = useCallback(async (mode: 'close' | 'switch', apply: () => void) => {
    cancel();
    setMode(mode);
    const target = mode === 'close' ? sheet.current : sheet.current?.querySelector<HTMLElement>('.mobile-main');
    const layer = canvas.current;
    if (!target || !layer || matchMedia('(prefers-reduced-motion: reduce)').matches) { setMode(null); apply(); return; }
    const request = revision.current;
    const bounds = target.getBoundingClientRect();
    try {
      // Cancel old canvas before PixelCopy, so it cannot capture a previous transition.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (request !== revision.current) return;
      const result = await Promise.race([
        NativeWebView.captureToolSurface({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }),
        new Promise<{ dataUrl: string }>(resolve => setTimeout(() => resolve({ dataUrl: '' }), 650)),
      ]);
      if (request !== revision.current) return;
      if (!result.dataUrl) { setMode(null); apply(); return; }
      const image = new Image(); image.src = result.dataUrl;
      await image.decode();
      if (request !== revision.current) return;
      setDissolving(true);
      if (mode === 'close') sheet.current?.classList.add('is-dissolving');
      else apply();
      cleanup.current = dissolveSurface(layer, image, bounds, () => {
        if (request !== revision.current) return;
        cleanup.current(); cleanup.current = () => {};
        // A closing source stays hidden until React commits panelOpen=false;
        // showing it between clearing the canvas and that commit causes a flash.
        if (mode !== 'close') sheet.current?.classList.remove('is-dissolving');
        setDissolving(false);
        setMode(null);
        if (mode === 'close') apply();
      }, mode === 'close' ? 900 : 650);
    } catch {
      if (request === revision.current) { cancel(); apply(); }
    }
  }, [cancel, sheet, canvas]);
  return { run, cancel, dissolving, closing: mode === 'close' };
}
