import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lightScale, frameAt } from '../src/gui/itemMath.ts';

test('GUI item lights are unchanged at scale 1', () => {
  const [c0, c1] = lightScale(1);
  assert.ok(Math.abs(c0 - 1) < 1e-9 && Math.abs(c1 - 1) < 1e-9);
});

test('BetterQuesting scaling darkens large items like the game', () => {
  // Reference values from a direct fixed-function computation (normals through the inverse
  // transpose with GL_RESCALE_NORMAL, lights through the modelview).
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-3;
  const [a0, a1] = lightScale(2);
  assert.ok(close(a0, 0.8898) && close(a1, 0.7249), `${a0} ${a1}`);
  const [b0, b1] = lightScale(5.8);
  assert.ok(close(b0, 0.3987) && close(b1, 0.2955), `${b0} ${b1}`);
});

test('animation frames follow the game tick clock', () => {
  const ticks = [2, 1, 3]; // 6-tick loop
  assert.equal(frameAt(ticks, 0), 0);
  assert.equal(frameAt(ticks, 99), 0);
  assert.equal(frameAt(ticks, 100), 1);
  assert.equal(frameAt(ticks, 150), 2);
  assert.equal(frameAt(ticks, 299), 2);
  assert.equal(frameAt(ticks, 300), 0);
});
