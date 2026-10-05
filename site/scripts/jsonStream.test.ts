import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonStreamParser, type JsonPath, type Json } from './jsonStream.ts';

const sample = {
  a: 1,
  b: -2.5e3,
  s: 'plain',
  e: 'esc "quoted" \\ back\nslash é 😀 §9',
  t: true,
  f: false,
  z: null,
  arr: [1, 'two', { three: [3, [], {}] }, [true, null]],
  deep: { x: { y: { z: [0.5, 1e-7, 'ünïcödé'] } } },
};

function feed(text: string, chunk: number, handlers = {}): Json {
  const p = new JsonStreamParser(handlers);
  const bytes = Buffer.from(text, 'utf8');
  for (let i = 0; i < bytes.length; i += chunk) p.write(bytes.subarray(i, i + chunk));
  return p.end();
}

test('matches JSON.parse when everything is kept, for any chunking', () => {
  const text = JSON.stringify(sample, null, 1);
  for (const chunk of [1, 2, 3, 5, 7, 64, 1 << 20]) {
    assert.deepEqual(feed(text, chunk, { mode: () => 'keep' }), sample, `chunk ${chunk}`);
  }
});

test('scanned containers are reported with their path and dropped', () => {
  const text = JSON.stringify({
    id: 'root',
    keepMe: { k: [1, 2] },
    list: [{ kind: 'item', id: 'a', nested: { kind: 'item', id: 'b' } }, 7, { kind: 'fluid', id: 'c' }],
  });
  const seen: string[] = [];
  const root = feed(text, 3, {
    mode: (path: JsonPath) => (path.length === 1 && path[0] === 'keepMe' ? 'keep' : 'scan'),
    onScan: (path: JsonPath, v: Record<string, Json> | Json[]) => {
      if (!Array.isArray(v) && v.kind) seen.push(`${path.join('.')}=${v.id}`);
    },
  });
  assert.deepEqual(root, { id: 'root', keepMe: { k: [1, 2] } });
  assert.deepEqual(seen, ['list.0.nested=b', 'list.0=a', 'list.2=c']);
});

test('mode sees the parent members read so far', () => {
  const text = JSON.stringify({ domains: [{ id: 'x', entries: { a: 1 } }, { id: 'ore', entries: { b: [2] } }] });
  const kept: Json[] = [];
  feed(text, 4, {
    mode: (path: JsonPath, parent: Record<string, Json>) =>
      path.length === 3 && path[2] === 'entries' && parent.id === 'ore' ? 'keep' : 'scan',
    onScan: (path: JsonPath, v: Json) => {
      if (path.length === 2) kept.push(v);
    },
  });
  assert.deepEqual(kept, [{ id: 'x' }, { id: 'ore', entries: { b: [2] } }]);
});

test('rejects truncated input', () => {
  assert.throws(() => feed('{"a": [1, 2', 4));
  assert.throws(() => feed('{"a": "unterminated', 4));
});
