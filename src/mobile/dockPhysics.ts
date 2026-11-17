export type Spring = { value: number; velocity: number; target: number };
export const DOCK_OPTICAL_BLEED = 12;
/** Bound the final deformed footprint, not just the finger or resting width. */
export function fitDockLens(center: number, width: number, lift: number, stretch: number, dockWidth: number, dockHeight: number) {
  const inset = Math.min(4, dockWidth / 2);
  const strain = Math.max(-.12, Math.min(.2, stretch));
  const w = Math.min(Math.max(0, dockWidth - inset * 2), width + 4, (width + lift * 4) * (1 + strain));
  const h = Math.max(0, Math.min(dockHeight + DOCK_OPTICAL_BLEED * 2 - 2, (dockHeight - 8 + lift * 16) * (1 - strain * 1.4)));
  return { x: Math.max(inset, Math.min(dockWidth - inset - w, center - w / 2)), width: w, height: h };
}
export function springStep(spring: Spring, elapsed: number, stiffness = 460, damping = 32): boolean {
  const steps = Math.max(1, Math.ceil(Math.min(elapsed, 0.25) / 0.008));
  const dt = Math.min(elapsed, 0.25) / steps;
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
