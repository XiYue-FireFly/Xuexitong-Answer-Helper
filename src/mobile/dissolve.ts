/** Independent Canvas renderer: sweep across real UI pixels, then disperse them. */
export function dissolveSurface(canvas: HTMLCanvasElement, image: HTMLImageElement, bounds: DOMRect,
  onComplete: () => void, duration = 820): () => void {
  const context = canvas.getContext('2d');
  if (!context || bounds.width <= 0 || bounds.height <= 0) { onComplete(); return () => {}; }
  const ratio = Math.min(devicePixelRatio, 1.5);
  const margin = 42;
  canvas.width = Math.ceil((bounds.width + margin * 2) * ratio);
  canvas.height = Math.ceil((bounds.height + margin * 2) * ratio);
  Object.assign(canvas.style, { left: `${bounds.x - margin}px`, top: `${bounds.y - margin}px`,
    width: `${bounds.width + margin * 2}px`, height: `${bounds.height + margin * 2}px` });
  context.scale(ratio, ratio);
  const sample = document.createElement('canvas');
  const step = Math.max(2.5, Math.sqrt(bounds.width * bounds.height / 12000));
  const columns = Math.ceil(bounds.width / step), rows = Math.ceil(bounds.height / step);
  sample.width = columns; sample.height = rows;
  const sampleContext = sample.getContext('2d', { willReadFrequently: true });
  if (!sampleContext) { onComplete(); return () => {}; }
  sampleContext.drawImage(image, 0, 0, columns, rows);
  const colors = sampleContext.getImageData(0, 0, columns, rows).data;
  // Stable local randomness keeps frames coherent; no external assets or shaders.
  const particles = Array.from({ length: columns * rows }, (_, index) => {
    const seed = Math.sin((index + 1) * 127.1) * 43758.5453;
    const random = seed - Math.floor(seed);
    return { x: index % columns * step, y: Math.floor(index / columns) * step,
      start: index % columns / columns * 0.5 + random * 0.12,
      vx: 20 + random * 72, vy: -24 - random * 54, life: 0.25 + random * 0.23, random,
      r: colors[index * 4], g: colors[index * 4 + 1], b: colors[index * 4 + 2] };
  });
  let frame = 0, started = 0, stopped = false;
  const render = (now: number) => {
    if (stopped) return;
    if (!started) started = now;
    const progress = Math.min(1, (now - started) / duration);
    context.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
    // Draw once, then remove individual cells: no seams between scaled strips.
    context.globalAlpha = 1;
    context.drawImage(image, margin, margin, bounds.width, bounds.height);
    for (const particle of particles) {
      if (progress > particle.start) context.clearRect(margin + particle.x, margin + particle.y, step + 0.5, step + 0.5);
    }
    for (const particle of particles) {
      const age = progress - particle.start;
      if (age <= 0 || age >= particle.life) continue;
      const life = age / particle.life;
      const grey = (particle.r + particle.g + particle.b) / 3;
      const ash = Math.min(0.85, life * 1.5);
      context.fillStyle = `rgb(${particle.r + (grey - particle.r) * ash},${particle.g + (grey - particle.g) * ash},${particle.b + (grey - particle.b) * ash})`;
      context.globalAlpha = (1 - life) * 0.9;
      const size = Math.max(0.45, step * (0.42 - life * 0.30));
      context.fillRect(margin + particle.x + particle.vx * age,
        margin + particle.y + particle.vy * age + 22 * age * age, size, size);
    }
    context.globalAlpha = 1;
    if (progress < 1) frame = requestAnimationFrame(render);
    else { stopped = true; context.clearRect(0, 0, canvas.width, canvas.height); onComplete(); }
  };
  frame = requestAnimationFrame(render);
  return () => { stopped = true; cancelAnimationFrame(frame); canvas.width = canvas.height = 0; sample.width = sample.height = 0; };
}
