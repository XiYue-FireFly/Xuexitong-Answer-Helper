import { describe, expect, it } from 'vitest';
import { glassRegion } from '../electron/glass-region';

describe('desktop guest viewport sampling', () => {
  const viewport = { x: 0, y: 120, width: 1400, height: 740 };
  it('converts a floating dock to guest coordinates with optical bleed', () => {
    expect(glassRegion({ x: 375, y: 780, width: 650, height: 64 }, viewport)).toEqual({
      bounds: { x: 351, y: 756, width: 698, height: 104 },
      rect: { x: 351, y: 636, width: 698, height: 104 },
    });
  });
  it('clips to the actual guest viewport when a panel meets its top and right edges', () => {
    expect(glassRegion({ x: 800, y: 100, width: 590, height: 620 }, viewport)).toEqual({
      bounds: { x: 776, y: 120, width: 624, height: 624 },
      rect: { x: 776, y: 0, width: 624, height: 624 },
    });
  });
  it.each([
    { x: NaN, y: 130, width: 40, height: 40 },
    { x: 40, y: Infinity, width: 40, height: 40 },
    { x: 40, y: 130, width: -40, height: 40 },
    { x: 40, y: 130, width: 40, height: 0 },
    { y: 130, width: 40, height: 40 },
    { x: 2000, y: 130, width: 40, height: 40 },
  ])('rejects invalid or disjoint capture regions: %j', rect => {
    expect(glassRegion(rect as any, viewport)).toBeNull();
  });
  it('does not retain a previous viewport after resizing', () => {
    const request = { x: 20, y: 600, width: 600, height: 64 };
    const result = glassRegion(request, { x: 10, y: 100, width: 640, height: 570 });
    expect(result?.bounds).toEqual({ x: 10, y: 576, width: 634, height: 94 });
    expect(result?.rect).toEqual({ x: 0, y: 476, width: 634, height: 94 });
  });
});
