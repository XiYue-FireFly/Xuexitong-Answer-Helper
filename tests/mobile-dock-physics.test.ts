import { describe, expect, it } from 'vitest';
import { releaseIndex, rubberBand, springStep } from '../src/mobile/dockPhysics';
describe('dock movement', () => {
  it('catches up after a delayed frame instead of turning a fast tap into slow motion', () => {
    const spring = { value: 0, velocity: 0, target: 300 };
    springStep(spring, .25, 1024, 60);
    expect(spring.value).toBeGreaterThan(295);
    expect(spring.value).toBeLessThan(302);
  });
  it('settles at the target and stops scheduling frames', () => {
    const spring = { value: 0, velocity: 0, target: 240 };
    let moving = true;
    for (let i = 0; i < 120 && moving; i++) moving = springStep(spring, 1 / 60);
    expect(moving).toBe(false); expect(spring.value).toBe(240);
  });
  it('survives long frames and a target reversed during travel', () => {
    const spring = { value: 0, velocity: 1000, target: 300 };
    springStep(spring, 10); spring.target = -50;
    for (let i = 0; i < 120; i++) springStep(spring, 1 / 60);
    expect(spring.value).toBe(-50);
  });
  it('gives a quick flick momentum but limits it to one extra destination', () => {
    const centers = [30, 90, 150, 210, 270];
    expect(releaseIndex(centers, 50, 0, 0)).toBe(0);
    expect(releaseIndex(centers, 50, 1000, 0)).toBe(1);
    expect(releaseIndex(centers, 5, -900, 0)).toBe(0);
  });
  it('bounds edge resistance without snapping at zero', () => {
    expect(rubberBand(0, 16)).toBe(0); expect(rubberBand(1000, 16)).toBeLessThanOrEqual(16);
    expect(rubberBand(-10, 16)).toBe(-rubberBand(10, 16));
  });
});
