import { useEffect, useRef, type RefObject } from 'react';
import { continuousCapture } from '../mobile/continuousCapture';
import { desktopGlassSource } from './glassSource';

/** Install source pixels directly; live captures never rerender the tool pages. */
export function usePanelBackdrop(sheet: RefObject<HTMLElement>, open: boolean) {
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (!open) return;
    imageRef.current?.removeAttribute('src');
    let disposed = false;
    const captures = continuousCapture(async () => {
      const element = sheet.current, image = imageRef.current;
      if (!element || !image) return;
      const bounds = element.getBoundingClientRect();
      const result = await desktopGlassSource.capture(bounds);
      if (disposed) return;
      if (!result.dataUrl) { image.removeAttribute('src'); return; }
      const decoded = new Image(); decoded.src = result.dataUrl; await decoded.decode();
      const current = element.getBoundingClientRect();
      if (disposed || (['x', 'y', 'width', 'height'] as const).some(key => Math.abs(current[key] - bounds[key]) > 1)) return;
      Object.assign(image.style, { left: `${result.bounds.x - current.x}px`, top: `${result.bounds.y - current.y}px`,
        width: `${result.bounds.width}px`, height: `${result.bounds.height}px` });
      image.src = result.dataUrl;
    }, 160, 320);
    const visibility = () => captures.setVisible(!document.hidden);
    visibility(); document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; captures.dispose(); document.removeEventListener('visibilitychange', visibility); };
  }, [open, sheet]);
  return imageRef;
}
