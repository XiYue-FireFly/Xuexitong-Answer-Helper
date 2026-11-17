export type GlassRect = { x: number; y: number; width: number; height: number };

/** The request uses viewport DIP coordinates, never document scroll offsets. */
export function glassRegion(request: GlassRect, viewport: GlassRect, bleed = 24) {
  if (![request, viewport].every(rect => rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0 && rect.height > 0)) return null;
  const left = Math.max(viewport.x, Math.floor(request.x - bleed));
  const top = Math.max(viewport.y, Math.floor(request.y - bleed));
  const right = Math.min(viewport.x + viewport.width, Math.ceil(request.x + request.width + bleed));
  const bottom = Math.min(viewport.y + viewport.height, Math.ceil(request.y + request.height + bleed));
  if (right <= left || bottom <= top) return null;
  const bounds = { x: left, y: top, width: right - left, height: bottom - top };
  return { bounds, rect: { ...bounds, x: Math.round(left - viewport.x), y: Math.round(top - viewport.y) } };
}
