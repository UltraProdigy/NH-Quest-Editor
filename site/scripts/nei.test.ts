import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standardLines } from '../src/nei/text.ts';
import { shardOf, INDEX_SHARDS } from '../src/nei/model.ts';

test('standard GT description lines match what GregTech draws', () => {
  // From the EBF and distillation tower in game (GT5U.nei.display.*).
  assert.deepEqual(standardLines(30, 12000), ['Total: 360,000 EU', 'Usage: 30 EU/t (§2LV§r)', 'Time: 600 seconds']);
  assert.deepEqual(standardLines(120, 24), ['Total: 2,880 EU', 'Usage: 120 EU/t (§6MV§r)', 'Time: 1.2 seconds']);
  assert.deepEqual(standardLines(2400, 16), ['Total: 38,400 EU', 'Usage: 2,400 EU/t (§9IV§r)', 'Time: 16 ticks']);
  // ULV recipes show LV, and generators (no consumption) only their time.
  assert.equal(standardLines(7, 100)[1], 'Usage: 7 EU/t (§2LV§r)');
  assert.deepEqual(standardLines(0, 20), ['Time: 20 ticks']);
});

test('index shards are stable and in range', () => {
  assert.equal(shardOf('minecraft:iron_ingot@0'), shardOf('minecraft:iron_ingot@0'));
  for (const k of ['a', 'fluid:water', 'ore:ingotIron', 'gregtech:gt.metaitem.01@11305']) {
    const s = shardOf(k);
    assert.ok(s >= 0 && s < INDEX_SHARDS && Number.isInteger(s));
  }
});
