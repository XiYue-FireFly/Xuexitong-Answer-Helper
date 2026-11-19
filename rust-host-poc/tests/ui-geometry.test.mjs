import test from 'node:test';
import assert from 'node:assert/strict';
import { clipRect, sameRect, unionRects } from '../geometry.mjs';

test('shadow/input padding stays within the physical window viewport', () => {
  assert.deepEqual(clipRect({ x: -3, y: 10, width: 60, height: 30 }, 100, 80, 8),
    { x: 0, y: 2, width: 65, height: 46 });
  assert.equal(clipRect({ x: 120, y: 10, width: 20, height: 20 }, 100, 80), null);
});

test('a capture spans both toolbar and panel without sampling outside their viewport', () => {
  assert.deepEqual(unionRects([
    { x: 20, y: 100, width: 300, height: 300 },
    { x: 250, y: 600, width: 400, height: 50 },
  ]), { x: 20, y: 100, width: 630, height: 550 });
});

test('moving or resizing UI rejects stale capture geometry', () => {
  const original = { x: 10, y: 20, width: 100, height: 50 };
  assert.equal(sameRect(original, { ...original, x: 10.9 }), true);
  assert.equal(sameRect(original, { ...original, width: 102 }), false);
});

test('invalid geometry cannot become native input islands', () => {
  assert.equal(clipRect({ x: Number.NaN, y: 0, width: 10, height: 10 }, 100, 100), null);
  assert.equal(clipRect({ x: 0, y: 0, width: -1, height: 10 }, 100, 100), null);
  assert.equal(unionRects([]), null);
});
