export type Spring = { value: number; velocity: number; target: number };
/** Bound the final deformed footprint, not just the finger or resting width. */
export function fitDockLens(center: number, width: number, lift: number, stretch: number, dockWidth: number, dockHeight: number) {
  const inset = Math.min(4, dockWidth / 2);
  const w = Math.min(Math.max(0, dockWidth - inset * 2), width * (1 + Math.max(0, stretch)) + lift * 12);
  const h = Math.max(0, Math.min(dockHeight - 8, (dockHeight - 12 + lift * 10) * (1 - Math.max(0, stretch) * .7)));
  return { x: Math.max(inset, Math.min(dockWidth - inset - w, center - w / 2)), width: w, height: h };
}
export function springStep(spring: Spring, elapsed: number, stiffness = 460, damping = 32): boolean {
  const steps = Math.max(1, Math.ceil(Math.min(elapsed, 0.05) / 0.008));
  const dt = Math.min(elapsed, 0.05) / steps;
  for (let i = 0; i < steps; i++) {
    spring.velocity += ((spring.target - spring.value) * stiffness - spring.velocity * damping) * dt;
    spring.value += spring.velocity * dt;
  }
  if (Math.abs(spring.target - spring.value) < 0.025 && Math.abs(spring.velocity) < 0.06) {
    spring.value = spring.target; spring.velocity = 0; return false;
  }
  return true;
}
export function rubberBand(distance: number, limit: number): number {
  return Math.sign(distance) * limit * (1 - Math.exp(-Math.abs(distance) / Math.max(1, limit)));
}
export function releaseIndex(centers: number[], x: number, velocity: number, current: number): number {
  const projected = x + Math.max(-1800, Math.min(1800, velocity)) * 0.10;
  const closest = centers.reduce((best, center, index) => Math.abs(center - projected) < Math.abs(centers[best] - projected) ? index : best, 0);
  return Math.max(0, Math.min(centers.length - 1, Math.max(current - 1, Math.min(current + 1, closest))));
}
