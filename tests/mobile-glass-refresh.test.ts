import { afterEach, describe, expect, it, vi } from 'vitest';
import { continuousCapture } from '../src/mobile/continuousCapture';
import { fitDockLens } from '../src/mobile/dockPhysics';

afterEach(() => vi.useRealTimers());
describe('live glass sampling', () => {
  it('updates without gestures, never overlaps requests, and stops when hidden', async () => {
    vi.useFakeTimers();
    let complete: (() => void) | undefined;
    const capture = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
    const loop = continuousCapture(capture, 80);
    loop.setVisible(true);
    expect(capture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(capture).toHaveBeenCalledTimes(1);
    complete!(); await vi.advanceTimersByTimeAsync(80);
    expect(capture).toHaveBeenCalledTimes(2);
    loop.setVisible(false); complete!(); await vi.advanceTimersByTimeAsync(500);
    expect(capture).toHaveBeenCalledTimes(2);
    loop.setVisible(true);
    expect(capture).toHaveBeenCalledTimes(3);
    loop.dispose(); complete!(); await vi.advanceTimersByTimeAsync(500);
    expect(capture).toHaveBeenCalledTimes(3);
  });
  it('resumes after capture errors and rapid visibility changes without parallel work', async () => {
    vi.useFakeTimers();
    let complete: (() => void) | undefined;
    const capture = vi.fn().mockRejectedValueOnce(new Error('surface lost'))
      .mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
    const loop = continuousCapture(capture, 80);
    loop.setVisible(true); await vi.advanceTimersByTimeAsync(80);
    loop.setVisible(false); loop.setVisible(true);
    expect(capture).toHaveBeenCalledTimes(2);
    complete!(); await vi.advanceTimersByTimeAsync(80);
    expect(capture).toHaveBeenCalledTimes(3);
    loop.dispose(); complete!();
  });
});
describe('optical lens bounds', () => {
  it.each([-500, 0, 30, 160, 310, 900])('keeps the fully lifted, stretched lens inside a 320px dock at %s', center => {
    const lens = fitDockLens(center, 76, 1.12, .18, 320, 80);
    expect(lens.x).toBeGreaterThanOrEqual(4);
    expect(lens.x + lens.width).toBeLessThanOrEqual(316);
    expect(lens.height).toBeLessThanOrEqual(72);
  });
  it('fits a narrow dock without a negative position', () => {
    expect(fitDockLens(0, 76, 1, .18, 50, 38)).toMatchObject({ x: 4, width: 42 });
  });
});
