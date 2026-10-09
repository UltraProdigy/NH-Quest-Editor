import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseBq } from '../src/lib/bqjson.ts';
import type { BqObject } from '../src/lib/bqjson.ts';
import { writeBq, javaDouble, javaFloat, gsonString } from '../src/lib/bqwrite.ts';
import { loadDb, saveDb, matchBaseCase, stripFormatting, buildFileName } from '../src/lib/bqsave.ts';

const f32 = (bits: number): number => {
  const v = new DataView(new ArrayBuffer(4));
  v.setInt32(0, bits);
  return v.getFloat32(0);
};

test('doubles print like Double.toString', () => {
  const cases: [number, string][] = [
    [0, '0.0'], [-0, '-0.0'], [1, '1.0'], [-1, '-1.0'], [0.1, '0.1'], [100, '100.0'],
    [0.001, '0.001'], [0.0001, '1.0E-4'], [1e7, '1.0E7'], [9999999, '9999999.0'],
    [1234567, '1234567.0'], [123456789, '1.23456789E8'], [1e-5, '1.0E-5'], [0.085, '0.085'],
    [5e-324, '4.9E-324'], [1.7976931348623157e308, '1.7976931348623157E308'],
  ];
  for (const [x, s] of cases) assert.equal(javaDouble(x), s, String(x));
});

test('floats print like Float.toString', () => {
  const cases: [number, string][] = [
    [0.085, '0.085'], [0.1, '0.1'], [0.3, '0.3'], [2.5, '2.5'], [0.001, '0.001'], [1e7, '1.0E7'],
    [16777216, '1.6777216E7'], [3.4028235e38, '3.4028235E38'], [1.4e-45, '1.4E-45'], [-1, '-1.0'],
    // Ties go to the even digit, as in Java (JS would round these up).
    [359427.125, '359427.12'], [32009.3125, '32009.312'],
  ];
  for (const [x, s] of cases) assert.equal(javaFloat(x), s, String(x));
  assert.equal(javaFloat(f32(0x3dcccccd)), '0.1');
});

test('strings escape like Gson with HTML-safe escaping', () => {
  assert.equal(gsonString(`it's <a> & b = "c"\\\n\t\u0001\u2028`), '"it\\u0027s \\u003ca\\u003e \\u0026 b \\u003d \\"c\\"\\\\\\n\\t\\u0001\\u2028"');
  assert.equal(gsonString('§6Gold'), '"§6Gold"');
});

test('compounds sort by name without the type, lists by index', () => {
  const v = parseBq('{"id2:8": "x", "id:8": "y", "l:9": {"10:3": 3, "9:3": 2, "0:3": 1}, "e:10": {}, "f:5": 1.5, "a:11": [1, 2]}') as BqObject;
  assert.equal(
    writeBq(v),
    '{\n  "a:11": [\n    1,\n    2\n  ],\n  "e:10": {},\n  "f:5": 1.5,\n  "id:8": "y",\n  "id2:8": "x",\n  "l:9": {\n    "0:3": 1,\n    "9:3": 2,\n    "10:3": 3\n  }\n}',
  );
  assert.equal(writeBq(parseBq('{"q:4": -7925499133285634726}') as BqObject), '{\n  "q:4": -7925499133285634726\n}');
});

test('file names follow BetterQuesting', () => {
  assert.equal(stripFormatting('§2§lTier 1 &#ff00aaLV \\& more &q'), 'Tier 1 LV & more ');
  assert.equal(buildFileName('§6Adept Thaumaturgy', 'AAAAAAAAAAAAAAAAAAAAFw=='), 'AdeptThaumaturgy-AAAAAAAAAAAAAAAAAAAAFw==');
  assert.equal(buildFileName('A very long quest name indeed', 'x'), 'Averylongquestna-x');
});

test('paths that differ only in case keep the base spelling', () => {
  const out = matchBaseCase(new Map([['Q/DenseCables-a.json', '1'], ['Q/New-b.json', '2']]), ['Q/Densecables-a.json']);
  assert.deepEqual([...out.keys()], ['Q/Densecables-a.json', 'Q/New-b.json']);
});

// The gate: the modpack's whole DefaultQuests folder survives load + save byte for byte.
// CI sets QUESTS_DIR to the modpack checkout; locally the test is skipped without it.
const questsDir = process.env.QUESTS_DIR;
test('DefaultQuests round trip', { skip: !questsDir || !existsSync(questsDir) ? 'QUESTS_DIR not set' : false }, () => {
  const files = new Map<string, string>();
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files.set(relative(questsDir!, p).split('\\').join('/'), readFileSync(p, 'utf8'));
    }
  };
  walk(questsDir!);
  assert.ok(files.size > 1000, `only ${files.size} files in ${questsDir}`);

  const differ: string[] = [];
  for (const [p, text] of files) {
    if (p.endsWith('.json') && writeBq(parseBq(text) as BqObject) !== text) differ.push(p);
  }
  assert.deepEqual(differ.slice(0, 10), [], `${differ.length} files don't re-serialize identically`);

  const saved = matchBaseCase(saveDb(loadDb(files)), files.keys());
  const missing = [...files.keys()].filter((p) => !saved.has(p));
  const extra = [...saved.keys()].filter((p) => !files.has(p));
  const changed = [...files.keys()].filter((p) => saved.has(p) && saved.get(p) !== files.get(p));
  assert.deepEqual({ missing: missing.slice(0, 10), extra: extra.slice(0, 10), changed: changed.slice(0, 10) }, { missing: [], extra: [], changed: [] });
});
