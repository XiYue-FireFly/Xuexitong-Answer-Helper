/** Neutral-centered displacement field for the raised capsule's content. */
export function lensDisplacement() {
  const width = 128, height = 80;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    const dx = x - width / 2;
    const nx = dx - Math.max(-24, Math.min(24, dx)), ny = y - height / 2;
    const length = Math.hypot(nx, ny);
    const edge = Math.pow(1 - Math.max(0, Math.min(1, (40 - length) / 12)), 2);
    pixels.set([128 - nx / Math.max(1, length) * edge * 126, 128 - ny / Math.max(1, length) * edge * 126, 128, 255], offset);
  }
  return { pixels, width, height };
}
