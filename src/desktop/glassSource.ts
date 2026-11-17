import type { DockGlassSource } from '../mobile/useDockGlass';

export const desktopGlassSource: DockGlassSource = {
  available: async () => !!(window as any).electronAPI?.captureGlass,
  async capture(bounds) {
    const guest = document.querySelector<HTMLElement>('webview[data-active-browser="true"]') as any;
    const empty = { dataUrl: '', bounds };
    if (!guest || document.hidden) return empty;
    const frame = guest.getBoundingClientRect();
    let id: number;
    try { id = guest.getWebContentsId(); } catch { return empty; }
    const region = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    const viewport = { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
    const result = await (window as any).electronAPI?.captureGlass({ guestId: id, region, viewport });
    // A tab switch or layout change must not install pixels from the old page.
    const current = guest.getBoundingClientRect();
    if (guest.dataset.activeBrowser !== 'true' || !guest.isConnected
      || (['x', 'y', 'width', 'height'] as const).some(key => Math.abs(current[key] - frame[key]) > 1)) return empty;
    return result?.dataUrl ? result : empty;
  },
};

export async function captureDesktopTool(bounds: DOMRect): Promise<{ dataUrl: string }> {
  const result = await (window as any).electronAPI?.screenshot({ x: Math.round(bounds.x), y: Math.round(bounds.y),
    width: Math.round(bounds.width), height: Math.round(bounds.height) });
  return { dataUrl: result?.image || '' };
}
