import { afterEach, describe, expect, it, vi } from 'vitest';
import { continuousCapture } from '../src/mobile/continuousCapture';
import { fitDockLens } from '../src/mobile/dockPhysics';
import { lensDisplacement } from '../src/mobile/lensDisplacement';

afterEach(() => vi.useRealTimers());
describe('raised lens content refraction', () => {
  it('leaves the center unchanged and bends the opposite rims in opposite directions', () => {
    const { pixels, width, height } = lensDisplacement();
    const pixel = (x: number, y: number) => Array.from(pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4));
    expect(pixel(width / 2, height / 2)).toEqual([128, 128, 128, 255]);
    expect(pixel(width / 2, 1)[1]).toBeGreaterThan(180);
    expect(pixel(width / 2, height - 2)[1]).toBeLessThan(75);
    expect(pixel(1, height / 2)[0]).toBeGreaterThan(180);
    expect(pixel(width - 2, height / 2)[0]).toBeLessThan(75);
  });
});
describe('live glass sampling', () => {
  it('can defer the first capture to leave the tap animation free', async () => {
    vi.useFakeTimers();
    const capture = vi.fn(async () => undefined);
    const loop = continuousCapture(capture, 100, 180);
    loop.setVisible(true);
    expect(capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(179); expect(capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(capture).toHaveBeenCalledTimes(1);
    loop.dispose();
  });
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
  it.each([36, 44, 54, 70])('keeps a held moving lens within one button slot at resting width %s', width => {
    const lens = fitDockLens(150, width, 1.12, .2, 380, 64);
    expect(lens.width).toBeLessThanOrEqual(width + 4);
  });
  it.each([-500, 0, 30, 160, 310, 900])('keeps the fully lifted, stretched lens inside a 320px dock at %s', center => {
    const lens = fitDockLens(center, 76, 1.12, .18, 320, 80);
    expect(lens.x).toBeGreaterThanOrEqual(4);
    expect(lens.x + lens.width).toBeLessThanOrEqual(316);
    expect(lens.height).toBeLessThanOrEqual(96);
  });
  it('fits a narrow dock without a negative position', () => {
    expect(fitDockLens(0, 76, 1, .18, 50, 38)).toMatchObject({ x: 4, width: 42 });
  });
  it('raises the held lens above the bar while keeping the bar and horizontal footprint fixed', () => {
    const rest = fitDockLens(150, 84, 0, 0, 320, 62);
    const held = fitDockLens(150, 84, 1, 0, 320, 62);
    expect(rest.height).toBeLessThan(62);
    expect(held.height).toBeGreaterThan(62);
    expect(held.height - rest.height).toBeGreaterThanOrEqual(14);
    expect(held.width).toBeGreaterThan(rest.width);
    expect(held.x + held.width / 2).toBe(rest.x + rest.width / 2);
  });
});
