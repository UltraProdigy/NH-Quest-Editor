import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standardLines } from '../src/nei/text.ts';
import { shardOf, INDEX_SHARDS } from '../src/nei/model.ts';
import { gtLookup, nbtFluid } from './gtLookup.ts';

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

test('GT lookups follow unification, familiar prefixes, fluids and ore stones', () => {
  const gt = gtLookup({
    unification: [
      { name: 'dustIron', target: 'gt:dust@26', familiar: ['gt:dustSmall@26', 'gt:dustTiny@26'], items: ['gt:dust@26', 'other:ironDust@0', 'bl:ironDust@0'], blacklisted: ['bl:ironDust@0'] },
      { name: 'oreIron', target: 'gregtech:gt.blockores@32', items: ['gregtech:gt.blockores@32'] },
    ],
    fluidContainers: [
      ['gt:cell@1', 'water', 1000, 'gt:cell@0'],
      ['minecraft:water_bucket@0', 'water', 1000, 'minecraft:bucket@0'],
    ],
    recipeAssociations: { 'gt:circuit@1': ['gt:cc@1'] },
  });
  // R on another mod's iron dust: GT's dust (its unified item) and the small and tiny dusts.
  assert.deepEqual(new Set(gt.recipes('other:ironDust@0')), new Set(['gt:dust@26', 'gt:dustSmall@26', 'gt:dustTiny@26']));
  // Blacklisted items are not unified for R, but still match outputs unified to the target.
  assert.deepEqual(gt.recipes('bl:ironDust@0'), ['gt:dust@26']);
  // U ignores the blacklist.
  assert.deepEqual(new Set(gt.usages('bl:ironDust@0')), new Set(['gt:dust@26', 'gt:dustSmall@26', 'gt:dustTiny@26']));
  // A water cell finds water and every water container; water finds its containers.
  assert.deepEqual(new Set(gt.recipes('gt:cell@1')), new Set(['fluid:water', 'minecraft:water_bucket@0']));
  assert.deepEqual(new Set(gt.usages('fluid:water')), new Set(['gt:cell@1', 'minecraft:water_bucket@0']));
  // Ore blocks: the same ore in every stone.
  assert.equal(gt.recipes('gregtech:gt.blockores@1032').length, 7); // the other seven stones
  assert.ok(gt.recipes('gregtech:gt.blockores@1032').includes('gregtech:gt.blockores@32'));
  assert.deepEqual(gt.recipes('gt:circuit@1'), ['gt:cc@1']);
  // Nothing known: nothing extra.
  assert.deepEqual(gtLookup(undefined).recipes('minecraft:stone@0'), []);
});

test('GT lookups for stacks with NBT, fluid display stacks and GT++ components', () => {
  assert.equal(nbtFluid('{Fluid:{Amount:8000,FluidName:"ic2constructionfoam"}}'), 'ic2constructionfoam');
  assert.equal(nbtFluid('{Capacity:50,Fluid:{FluidName:"water",Amount:50}}'), 'water');
  assert.equal(nbtFluid('{mDataName:"Any DNA"}'), undefined);
  const gt = gtLookup(
    {
      fluidContainers: [['gt:cell@1', 'water', 1000, 'gt:cell@0']],
      dataSticks: [['gt:stick@0', '{output:{id:1}}', 'gt:motor@1']],
      fluidDisplay: 'gregtech:gt.GregTech_FluidDisplay',
      fluidIds: { water: 1 },
      componentFamiliar: { 'miscutils:dustFoo@0': ['miscutils:dustSmallFoo@0', 'miscutils:dustTinyFoo@0'] },
    },
    { nbt: [['gt:flask@0#abc', '{Fluid:{FluidName:"water",Amount:50}}']], hash: (n) => `h${n.length}` },
  );
  assert.deepEqual(new Set(gt.recipes('gt:flask@0#abc')), new Set(['fluid:water', 'gt:cell@1']));
  assert.deepEqual(new Set(gt.recipes('gregtech:gt.GregTech_FluidDisplay@1')), new Set(['fluid:water', 'gt:cell@1']));
  assert.deepEqual(gt.recipes('gt:stick@0#h15'), ['gt:motor@1']);
  assert.deepEqual(gt.usages('gt:stick@0#h15'), ['gt:motor@1']);
  assert.equal(gt.recipes('miscutils:dustFoo@0').length, 2);
  const keys = new Set(gt.keys());
  for (const k of ['gt:flask@0#abc', 'gregtech:gt.GregTech_FluidDisplay@1', 'gt:stick@0#h15', 'miscutils:dustFoo@0']) assert.ok(keys.has(k), k);
});
