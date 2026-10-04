// Builds public/data/questbook.json from a BetterQuesting DefaultQuests folder.
//
// Usage: node scripts/build-quests.ts <DefaultQuests dir> [out file]
// Optional env: QUESTS_REPO, QUESTS_COMMIT, QUESTS_DATE (recorded as the data source).
//
// If the DefaultQuests folder has a sibling "resources" folder (config/betterquesting/resources,
// where modpacks put custom themes and pictures), its contents are copied to public/assets and
// its themes are listed in public/data/themes.json.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync, cpSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { parseBq, splitKey, bqList, uuidToB64, NBT } from '../src/lib/bqjson.ts';
import type { BqObject, BqValue } from '../src/lib/bqjson.ts';
import type { ItemRef, FluidRef, Quest, QuestLine, QuestbookData, TaskData, PrereqRef, Placement } from '../src/lib/model.ts';

const [, , srcArg, outArg] = process.argv;
if (!srcArg) {
  console.error('Usage: node scripts/build-quests.ts <DefaultQuests dir> [out file]');
  process.exit(2);
}
const src = resolve(srcArg);
const out = resolve(outArg ?? 'public/data/questbook.json');

const readBq = (file: string): BqObject => {
  try {
    return parseBq(readFileSync(file, 'utf8')) as BqObject;
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
};

function* jsonFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* jsonFiles(p);
    else if (name.endsWith('.json')) yield p;
  }
}

const isObj = (v: BqValue | undefined): v is BqObject => !!v && typeof v === 'object' && !Array.isArray(v);

const idOf = (o: BqObject, prefix: string): string =>
  uuidToB64(BigInt(o[`${prefix}High:4`] as bigint ?? 0n), BigInt(o[`${prefix}Low:4`] as bigint ?? 0n));

/** Convert typed NBT JSON to plain JSON: strip suffixes, lists to arrays, longs to strings. */
function plain(v: BqValue, type = -1): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map((x) => plain(x));
  if (!isObj(v)) return v;
  if (type === NBT.LIST) {
    return Object.entries(v)
      .map(([k, x]) => [splitKey(k), x] as const)
      .sort((a, b) => Number(a[0][0]) - Number(b[0][0]))
      .map(([[, t], x]) => convert(x, t));
  }
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    const [name, t] = splitKey(k);
    o[name] = convert(x, t);
  }
  return o;
}

function item(v: BqObject): ItemRef {
  const ref: ItemRef = {
    id: String(v['id:8'] ?? ''),
    dmg: Number(v['Damage:2'] ?? 0),
    n: Number(v['Count:3'] ?? 1),
  };
  const ore = v['OreDict:8'];
  if (typeof ore === 'string' && ore) ref.ore = ore;
  if (isObj(v['tag:10'])) ref.nbt = plain(v['tag:10'], NBT.COMPOUND) as Record<string, unknown>;
  return ref;
}

function fluid(v: BqObject): FluidRef {
  return { fluid: String(v['FluidName:8'] ?? ''), n: Number(v['Amount:3'] ?? 0) };
}

/** Like plain(), but recognises item and fluid stacks inside tasks and rewards. */
function convert(v: BqValue, type: number): unknown {
  if (type === NBT.COMPOUND && isObj(v)) {
    if ('id:8' in v && 'Damage:2' in v) return item(v);
    if ('FluidName:8' in v && 'Amount:3' in v) return fluid(v);
  }
  return plain(v, type);
}

function taskData(v: BqValue, idKey: string): TaskData {
  const o = convert(v, NBT.COMPOUND) as Record<string, unknown>;
  const { [idKey]: type, index: _index, ...rest } = o;
  return { type: String(type), ...rest };
}

// ---------------------------------------------------------------- quests

const quests: Record<string, Quest> = {};
const rawProps: Record<string, Record<string, unknown>> = {};

for (const file of jsonFiles(join(src, 'Quests'))) {
  const q = readBq(file);
  const id = idOf(q, 'questID');
  const props = (q['properties:10'] as BqObject | undefined)?.['betterquesting:10'] as BqObject | undefined ?? {};
  const p = plain(props, NBT.COMPOUND) as Record<string, unknown>;
  const icon = isObj(props['icon:10']) ? item(props['icon:10']) : undefined;
  const { name, desc, icon: _icon, ...settings } = p;

  const pre: PrereqRef[] = bqList(q['preRequisites:9']).filter(isObj).map((r) => {
    const t = r['type:1'];
    return t === undefined || t === 0 ? [idOf(r, 'questID')] : [idOf(r, 'questID'), Number(t)];
  });

  quests[id] = {
    id,
    name: String(name ?? ''),
    desc: String(desc ?? ''),
    ...(icon ? { icon } : {}),
    pre,
    tasks: bqList(q['tasks:9']).map((t) => taskData(t, 'taskID')),
    rewards: bqList(q['rewards:9']).map((r) => taskData(r, 'rewardID')),
    props: {},
  };
  rawProps[id] = settings;
}

// Store only the properties that differ from the most common value.
const counts = new Map<string, Map<string, { v: unknown; n: number }>>();
for (const props of Object.values(rawProps)) {
  for (const [k, v] of Object.entries(props)) {
    const key = JSON.stringify(v);
    const m = counts.get(k) ?? new Map();
    const e = m.get(key) ?? { v, n: 0 };
    e.n++;
    m.set(key, e);
    counts.set(k, m);
  }
}
const total = Object.keys(rawProps).length;
const defaults: Record<string, unknown> = {};
for (const [k, m] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
  const best = [...m.values()].sort((a, b) => b.n - a.n)[0];
  // Keys missing from most quests (isGlobal, partySingleReward...) get no default.
  if (best.n * 2 > total) defaults[k] = best.v;
}
for (const [id, props] of Object.entries(rawProps)) {
  for (const [k, v] of Object.entries(props)) {
    if (!(k in defaults) || JSON.stringify(v) !== JSON.stringify(defaults[k])) quests[id].props[k] = v;
  }
}

// ---------------------------------------------------------------- questlines

const order = readFileSync(join(src, 'QuestLinesOrder.txt'), 'utf8')
  .split('\n')
  .map((l) => l.split(':')[0].trim())
  .filter(Boolean);

const lines = new Map<string, QuestLine>();
for (const dirName of readdirSync(join(src, 'QuestLines'))) {
  const dir = join(src, 'QuestLines', dirName);
  if (!statSync(dir).isDirectory()) continue;
  const l = readBq(join(dir, 'QuestLine.json'));
  const props = (l['properties:10'] as BqObject)['betterquesting:10'] as BqObject;
  const id = idOf(l, 'questLineID');
  const placements: Placement[] = [];
  for (const f of readdirSync(dir)) {
    if (f === 'QuestLine.json' || !f.endsWith('.json')) continue;
    const e = readBq(join(dir, f));
    placements.push([
      idOf(e, 'questID'),
      Number(e['x:3'] ?? 0),
      Number(e['y:3'] ?? 0),
      Number(e['sizeX:3'] ?? 24),
      Number(e['sizeY:3'] ?? 24),
    ]);
  }
  // Stable order: by position, then id.
  placements.sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0].localeCompare(b[0]));
  lines.set(id, {
    id,
    name: String(props['name:8'] ?? ''),
    desc: String(props['desc:8'] ?? ''),
    ...(isObj(props['icon:10']) ? { icon: item(props['icon:10']) } : {}),
    visibility: String(props['visibility:8'] ?? 'NORMAL'),
    bgImage: String(props['bg_image:8'] ?? ''),
    bgSize: Number(props['bg_size:3'] ?? 256),
    quests: placements,
  });
}

const orderedLines = [
  ...order.filter((id) => lines.has(id)).map((id) => lines.get(id)!),
  ...[...lines.values()].filter((l) => !order.includes(l.id)),
];

// ---------------------------------------------------------------- write

const settingsFile = readBq(join(src, 'QuestSettings.json'));
const data: QuestbookData = {
  format: 1,
  generatedAt: new Date().toISOString(),
  source: {
    repo: process.env.QUESTS_REPO ?? 'GTNewHorizons/GT-New-Horizons-Modpack',
    commit: process.env.QUESTS_COMMIT ?? '',
    date: process.env.QUESTS_DATE ?? '',
  },
  settings: plain(settingsFile['betterquesting:10'] ?? {}, NBT.COMPOUND) as Record<string, unknown>,
  defaults,
  lines: orderedLines,
  quests,
};

mkdirSync(dirname(out), { recursive: true });
const json = JSON.stringify(data);
writeFileSync(out, json);

// ---------------------------------------------------------------- modpack resources

const resources = join(src, '..', 'resources');
const themes: unknown[] = [];
if (existsSync(resources)) {
  const assets = resolve(dirname(out), '..', 'assets');
  for (const domain of readdirSync(resources)) {
    const dir = join(resources, domain);
    if (!statSync(dir).isDirectory()) continue;
    const target = join(assets, domain.toLowerCase());
    if (['minecraft', 'betterquesting', 'bq_standard'].includes(domain.toLowerCase())) continue;
    rmSync(target, { recursive: true, force: true });
    cpSync(dir, target, { recursive: true, filter: (f) => !f.endsWith('bq_themes.json') });
    const themeFile = join(dir, 'bq_themes.json');
    if (existsSync(themeFile)) {
      const t = JSON.parse(readFileSync(themeFile, 'utf8'));
      themes.push(...(Array.isArray(t) ? t : [t]));
    }
  }
}
writeFileSync(join(dirname(out), 'themes.json'), JSON.stringify(themes));

const missing = orderedLines.flatMap((l) => l.quests.filter((p) => !quests[p[0]]).map((p) => `${l.name}: ${p[0]}`));
const placed = new Set(orderedLines.flatMap((l) => l.quests.map((p) => p[0])));
console.log(
  `questbook: ${Object.keys(quests).length} quests, ${orderedLines.length} questlines, ` +
    `${orderedLines.reduce((n, l) => n + l.quests.length, 0)} placements, ` +
    `${Object.keys(quests).length - placed.size} unplaced, ${themes.length} extra themes, ` +
    `${(json.length / 1e6).toFixed(1)} MB -> ${out}`,
);
if (missing.length) console.warn(`placements without a quest file (${missing.length}):\n  ${missing.slice(0, 20).join('\n  ')}`);
