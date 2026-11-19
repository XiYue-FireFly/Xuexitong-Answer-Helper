import { describe, expect, it } from 'vitest';
import { dockBounds, dockReducer, initialDockState } from '../src/ui/dockState';
import { fitDockLens } from '../src/mobile/dockPhysics';

describe('adaptive dock UI', () => {
  it('grows only the raised ultra lens and bounds its complete footprint at either end', () => {
    for (const center of [-400,0,130,900]) {
      const rest = fitDockLens(center,82,0,0,268,62,16);
      const raised = fitDockLens(center,82,1.12,.2,268,62,16);
      expect(rest.width).toBe(82);
      expect(raised.width).toBeLessThanOrEqual(98);
      expect(raised.x).toBeGreaterThanOrEqual(4);
      expect(raised.x + raised.width).toBeLessThanOrEqual(264);
      expect(fitDockLens(center,82,1,0,268,62,16).height).toBeGreaterThan(rest.height);
    }
  });
  it('ignores small movements and panel scrolling, collapses on page travel, expands only at the top', () => {
    let state = dockReducer(initialDockState, { type: 'scroll', y: 20, delta: 20, panelOpen: false });
    expect(state.collapsed).toBe(false);
    state = dockReducer(state, { type: 'scroll', y: 80, delta: 60, panelOpen: true });
    expect(state.collapsed).toBe(false);
    state = dockReducer(state, { type: 'scroll', y: 120, delta: 40, panelOpen: false });
    expect(state.collapsed).toBe(true);
    state = dockReducer(state, { type: 'scroll', y: 60, delta: -60, panelOpen: false });
    expect(state.collapsed).toBe(true);
    expect(dockReducer(state, { type: 'scroll', y: 0, delta: -60, panelOpen: false }).collapsed).toBe(false);
  });
  it('collapses once at run start, allows manual expansion, and expands on completion', () => {
    let state = dockReducer(initialDockState, { type: 'running', value: true });
    expect(state.collapsed).toBe(true);
    expect(dockReducer(state, { type: 'scroll', y: 0, delta: -300, panelOpen: false }).collapsed).toBe(true);
    state = dockReducer(state, { type: 'expand' });
    expect(dockReducer(state, { type: 'running', value: true }).collapsed).toBe(false);
    state = dockReducer(state, { type: 'running', value: false });
    expect(state.collapsed).toBe(false);
  });
  it('ignores invalid telemetry', () => {
    expect(dockReducer(initialDockState, { type: 'scroll', y: NaN, delta: 100, panelOpen: false })).toBe(initialDockState);
  });
  for (const edge of ['bottom','top','left','right'] as const) {
    for (const [width,height,count] of [[360,640,3],[700,420,7],[1400,900,7],[320,280,3]]) {
      it(`keeps ${count} controls and the answer capsule inside ${width}x${height} on ${edge}`, () => {
        const area = { x: 0, y: 90, width, height: height - 90 };
        for (const collapsed of [true,false]) {
          const rect = dockBounds(edge,collapsed,count,area);
          expect(rect.left).toBeGreaterThanOrEqual(0);
          expect(rect.top).toBeGreaterThanOrEqual(area.y);
          expect(rect.left + rect.width).toBeLessThanOrEqual(width);
          expect(rect.top + rect.height).toBeLessThanOrEqual(height);
          if (collapsed) {
            expect(rect.width).toBe(62); expect(rect.height).toBe(62);
            expect(rect.left).toBe(edge === 'right' ? width - 76 : 14);
            expect(rect.top).toBe(edge === 'top' ? 104 : height - 76);
          }
        }
      });
    }
  }
});
