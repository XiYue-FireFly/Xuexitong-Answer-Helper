export function clipRect(rect, width, height, padding = 0) {
  if (![rect.x, rect.y, rect.width, rect.height, width, height, padding].every(Number.isFinite)
      || rect.width <= 0 || rect.height <= 0 || width <= 0 || height <= 0 || padding < 0) return null;
  const x = Math.max(0, rect.x - padding), y = Math.max(0, rect.y - padding);
  const right = Math.min(width, rect.x + rect.width + padding);
  const bottom = Math.min(height, rect.y + rect.height + padding);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

export function unionRects(rectangles) {
  if (!rectangles.length) return null;
  const left = Math.min(...rectangles.map(r => r.x));
  const top = Math.min(...rectangles.map(r => r.y));
  const right = Math.max(...rectangles.map(r => r.x + r.width));
  const bottom = Math.max(...rectangles.map(r => r.y + r.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function sameRect(a, b, tolerance = 1) {
  return ['x', 'y', 'width', 'height'].every(key => Math.abs(a[key] - b[key]) <= tolerance);
}
