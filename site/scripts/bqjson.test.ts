import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBq, bqList, uuidToB64, splitKey } from '../src/lib/bqjson.ts';

test('long values keep full precision', () => {
  const v = parseBq('{"questIDHigh:4": -1056733930300291586, "questIDLow:4": -7925499133285634726, "x:3": 480}') as Record<string, unknown>;
  assert.equal(v['questIDHigh:4'], -1056733930300291586n);
  assert.equal(v['questIDLow:4'], -7925499133285634726n);
  assert.equal(v['x:3'], 480);
});

test('ids encode like BetterQuesting file names', () => {
  assert.equal(uuidToB64(0n, 2020n), 'AAAAAAAAAAAAAAAAAAAH5A==');
  assert.equal(uuidToB64(-1056733930300291586n, -7925499133285634726n), '8VW6FtZZRf6SAviHhNftWg==');
});

test('strings, escapes and lists', () => {
  const v = parseBq('{"desc:8": "you\\u0027ll \\u003d \\n", "l:9": {"1:8": "b", "0:8": "a", "10:8": "c"}}') as Record<string, unknown>;
  assert.equal(v['desc:8'], "you'll = \n");
  assert.deepEqual(bqList(v['l:9'] as never), ['a', 'b', 'c']);
});

test('typed keys', () => {
  assert.deepEqual(splitKey('name:8'), ['name', 8]);
  assert.deepEqual(splitKey(':8'), ['', 8]);
  assert.deepEqual(splitKey('plain'), ['plain', -1]);
});
