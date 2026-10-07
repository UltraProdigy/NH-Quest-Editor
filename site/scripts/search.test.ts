import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFilter, splitByDelimiters, splitSearchText, formatSearch, getPattern, type SearchItem } from '../src/nei/search.ts';

const item = (o: Partial<SearchItem>): SearchItem => ({ name: '', mod: 'Minecraft', tooltip: '', ores: [], id: 'minecraft:stone', ...o });
const ironDust = item({ name: 'Iron Dust', mod: 'GregTech', tooltip: 'Fe', ores: ['dustIron'], id: 'gregtech:gt.metaitem.01' });
const ironIngot = item({ name: 'Iron Ingot', mod: 'Minecraft', ores: ['ingotIron'], id: 'minecraft:iron_ingot' });
const copperDust = item({ name: 'Copper Dust', mod: 'GregTech', tooltip: 'Cu', ores: ['dustCopper'], id: 'gregtech:gt.metaitem.01' });
const all = [ironDust, ironIngot, copperDust];
const names = (q: string) => all.filter(getFilter(q)).map((i) => i.name);

test('splitByDelimiters keeps the delimiters and quoted parts', () => {
  assert.deepEqual(splitByDelimiters('a|b', '|', false), [['', 'a'], ['|', 'b']]);
  assert.deepEqual(splitByDelimiters('iron -dust', '-!@%', true), [['', 'iron '], ['-', 'dust']]);
  assert.deepEqual(splitByDelimiters('"a|b"|c', '|', false), [['', '"a|b"'], ['|', 'c']]);
});

test('tokens: prefixes, negation and quotes', () => {
  const [a, b, c] = splitSearchText('@greg -dust "iron ingot"');
  assert.equal(a.firstChar, '@');
  assert.equal(a.rawText, 'greg');
  assert.equal(b.ignore, '-');
  assert.equal(b.rawText, 'dust');
  assert.equal(c.quotes, true);
  assert.equal(c.rawText, 'iron ingot');
});

test('a plain word matches names, tooltips, ore names and ids (GTNH: always searched)', () => {
  assert.deepEqual(names('iron'), ['Iron Dust', 'Iron Ingot']);
  assert.deepEqual(names('fe'), ['Iron Dust']);
  assert.deepEqual(names('dustcopper'), ['Copper Dust']);
  assert.deepEqual(names('iron_ingot'), ['Iron Ingot']);
});

test('words are ANDed, | is OR, - negates, @ is the mod name', () => {
  assert.deepEqual(names('iron dust'), ['Iron Dust']);
  assert.deepEqual(names('copper|ingot'), ['Iron Ingot', 'Copper Dust']);
  assert.deepEqual(names('iron -dust'), ['Iron Ingot']);
  assert.deepEqual(names('@gregtech'), ['Iron Dust', 'Copper Dust']);
  assert.deepEqual(names('@minecraft iron'), ['Iron Ingot']);
  assert.deepEqual(names(''), ['Iron Dust', 'Iron Ingot', 'Copper Dust']);
});

test('extended patterns: ? and * wildcards, r/regex/', () => {
  assert.deepEqual(names('c?pper'), ['Copper Dust']);
  assert.deepEqual(names('i*n d'), ['Iron Dust']);
  // NEI splits on spaces and | before it sees the regex, so a regex can hold neither.
  assert.deepEqual(names('r/^iron.[di]/'), ['Iron Dust', 'Iron Ingot']);
  assert.equal(getPattern('a.b')!.test('axb'), false);
});

test('the search field colours prefixes, negation and alternatives', () => {
  assert.equal(formatSearch('@gt -dust|x'), '§7§d@§dgt §9-§rdust§7|§rx');
});
