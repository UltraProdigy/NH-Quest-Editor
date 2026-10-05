// Builds public/data/items.json, names.json and the icon files the questbook needs, from the
// game-data export (exporter/, format dev.gtnhplanner.oracle.v1).
//
// Usage: node scripts/build-items.ts <export.json[.gz]> <icons dir> <questbook.json> [out dir]
// Optional env: DAILY_TAG (recorded as the data source).
//
// <icons dir>/quest/manifest.json, when present, has icons rendered from the exact stacks the quests
// use (scripts/build-quests.ts --stacks); those replace the recipe export's icon for the same key and
// add the stacks with NBT (keys "<id>@<dmg>#<hash>").
//
// Phase 1 only ships what the questbook references (quest/line icons, task and reward items,
// their ore dictionary members). The full item index comes with the recipe views.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { parseJsonFile } from './jsonStream.ts';
import type { QuestbookData, ItemIndex, ItemInfo, ItemRef } from '../src/lib/model.ts';

const [, , exportArg, iconsArg, questsArg, outArg] = process.argv;
if (!exportArg || !iconsArg || !questsArg) {
  console.error('Usage: node scripts/build-items.ts <export.json> <icons dir> <questbook.json> [out dir]');
  process.exit(2);
}
const outDir = resolve(outArg ?? 'public/data');
const iconOut = join(outDir, 'icons');

interface Resource {
  kind: 'item' | 'fluid';
  id: string;
  registryId?: string;
  meta?: number;
  displayName?: string;
  modId?: string;
  icon?: string;
  nbt?: string;
}

// The export is read as a stream (it is several hundred MB, near V8's string limit). Only the
// root's own members, the ore dictionary, the mob list and the name tables are kept; every other
// object is looked at for item and fluid resources as it closes and then dropped.
interface Domain {
  id: string;
  entries?: Record<string, Resource[]>;
  mobs?: { entityName: string; displayName: string }[];
}
interface ExportRoot {
  generatedAt?: string;
  /** Registry domain or mod id -> mod name, as tooltips show it (newer exports only). */
  modNames?: Record<string, string>;
  /** Dimension id -> name, as BQ's location task shows it (newer exports only). */
  dimensionNames?: Record<string, string>;
}
const KEEP_ROOT = new Set(['modNames', 'dimensionNames']);
const domains: Domain[] = [];

// ---------------------------------------------------------------- collect every resource

const items = new Map<string, ItemInfo & { nbt: boolean }>();
const keyOf = (r: Resource) =>
  r.kind === 'fluid' ? `fluid:${r.id}` : `${r.registryId ?? r.id.replace(/@\d+$/, '')}@${r.meta ?? 0}`;

function resource(o: Record<string, unknown>) {
  if ((o.kind !== 'item' && o.kind !== 'fluid') || typeof o.id !== 'string') return;
  const r = o as unknown as Resource;
  const key = keyOf(r);
  const prev = items.get(key);
  const hasNbt = !!r.nbt;
  // Prefer the plain (no NBT) stack: its name and icon are the item's defaults.
  if (!prev || (prev.nbt && !hasNbt) || (!prev.i && r.icon)) {
    items.set(key, {
      n: r.displayName ?? key,
      ...(r.icon ? { i: r.icon } : {}),
      ...(r.modId ? { m: r.modId } : {}),
      nbt: hasNbt,
    });
  }
}
function visit(v: unknown) {
  if (Array.isArray(v)) {
    for (const x of v) visit(x);
    return;
  }
  if (!v || typeof v !== 'object') return;
  const o = v as Record<string, unknown>;
  resource(o);
  for (const k in o) {
    const x = o[k];
    if (x && typeof x === 'object') visit(x);
  }
}

console.time('read export');
const exp = (await parseJsonFile(resolve(exportArg), {
  mode(path, parent) {
    if (path.length === 1) return KEEP_ROOT.has(path[0] as string) ? 'keep' : 'scan';
    if (path.length === 3 && path[0] === 'domains') {
      const id = (parent as Record<string, unknown>).id;
      if ((id === 'oreDictionary' && path[2] === 'entries') || (id === 'mobDrops' && path[2] === 'mobs')) return 'keep';
    }
    return 'scan';
  },
  onScan(path, v) {
    if (path.length === 2 && path[0] === 'domains') {
      domains.push(v as unknown as Domain);
      visit(v); // resources inside the kept parts (ore dictionary members)
    } else if (!Array.isArray(v)) resource(v);
  },
})) as ExportRoot;
console.timeEnd('read export');
const book = JSON.parse(readFileSync(resolve(questsArg), 'utf8')) as QuestbookData;

// ---------------------------------------------------------------- icons of the exact quest stacks

interface QuestIcon {
  name?: string | null;
  icon?: string;
  frames?: number;
  ticks?: number[];
  lit?: number;
  t?: number;
  glint?: number;
  random?: number;
}
const questManifestFile = join(resolve(iconsArg), 'quest', 'manifest.json');
const questIcons: Record<string, QuestIcon> = existsSync(questManifestFile)
  ? JSON.parse(readFileSync(questManifestFile, 'utf8'))
  : {};
for (const [key, q] of Object.entries(questIcons)) {
  const base = items.get(key.replace(/#.*$/, ''));
  const info: ItemInfo & { nbt: boolean } = {
    n: q.name || base?.n || key,
    ...(base?.m ? { m: base.m } : {}),
    nbt: key.includes('#'),
  };
  if (q.icon) {
    info.i = q.icon;
    if (q.frames && q.frames > 1) {
      info.f = q.frames;
      if (q.random) info.r = 1;
      else info.t = q.ticks;
    }
    if (q.lit) info.l = q.t ? 2 : 1;
    if (q.glint) info.g = 1;
  } else if (!key.includes('#') && base?.i) {
    info.i = base.i; // the quest render came out empty; keep the recipe export's icon
  }
  items.set(key, info);
}

const oreDomain = domains.find((d) => d.id === 'oreDictionary');
const oreAll = new Map<string, string[]>();
for (const [name, list] of Object.entries(oreDomain?.entries ?? {})) oreAll.set(name, list.map(keyOf));

const entities: Record<string, string> = {};
for (const m of domains.find((d) => d.id === 'mobDrops')?.mobs ?? []) entities[m.entityName] = m.displayName;

// ---------------------------------------------------------------- what the questbook needs

const needed = new Set<string>();
const oreNeeded = new Set<string>();
const missing = new Set<string>();
const WILDCARD = 32767;
const byRegistry = new Map<string, string[]>();
for (const k of items.keys()) {
  const at = k.lastIndexOf('@');
  if (at < 0) continue;
  const reg = k.slice(0, at);
  const list = byRegistry.get(reg) ?? [];
  list.push(k);
  byRegistry.set(reg, list);
}

function need(ref: ItemRef) {
  const key = `${ref.id}@${ref.dmg}`;
  if (ref.k && items.has(ref.k)) needed.add(ref.k);
  if (ref.ore && oreAll.has(ref.ore)) {
    oreNeeded.add(ref.ore);
    for (const k of oreAll.get(ref.ore)!) needWithWildcard(k);
  }
  needWithWildcard(key);
}
function needWithWildcard(key: string) {
  if (items.has(key)) needed.add(key);
  if (key.endsWith(`@${WILDCARD}`)) {
    for (const k of byRegistry.get(key.slice(0, -`@${WILDCARD}`.length)) ?? []) needed.add(k);
  } else if (!items.has(key)) missing.add(key);
}
function walkRefs(v: unknown) {
  if (Array.isArray(v)) return v.forEach(walkRefs);
  if (!v || typeof v !== 'object') return;
  const o = v as Record<string, unknown>;
  if (typeof o.id === 'string' && typeof o.dmg === 'number' && typeof o.n === 'number') need(o as unknown as ItemRef);
  else if (typeof o.fluid === 'string') {
    const k = `fluid:${o.fluid}`;
    if (items.has(k)) needed.add(k);
    else missing.add(k);
  }
  for (const k in o) if (k !== 'nbt') walkRefs(o[k]);
}
for (const q of Object.values(book.quests)) {
  if (q.icon) need(q.icon);
  walkRefs(q.tasks);
  walkRefs(q.rewards);
}
for (const l of book.lines) if (l.icon) need(l.icon);
// Fixed items drawn by the GUI itself.
for (const id of ['minecraft:crafting_table', 'minecraft:furnace', 'minecraft:anvil', 'minecraft:experience_bottle']) {
  needWithWildcard(`${id}@0`);
}

// ---------------------------------------------------------------- write

mkdirSync(iconOut, { recursive: true });
for (const f of readdirSync(iconOut)) rmSync(join(iconOut, f), { recursive: true, force: true });
const out: Record<string, ItemInfo> = {};
let copied = 0, noIcon = 0;
const iconsDir = resolve(iconsArg);
for (const key of [...needed].sort()) {
  const it = items.get(key)!;
  const { nbt: _nbt, ...info } = it;
  if (it.i && existsSync(join(iconsDir, it.i))) {
    if (!existsSync(join(iconOut, it.i))) {
      mkdirSync(dirname(join(iconOut, it.i)), { recursive: true });
      copyFileSync(join(iconsDir, it.i), join(iconOut, it.i));
      copied++;
    }
  } else {
    delete info.i;
    delete info.f;
    delete info.t;
    delete info.l;
    delete info.g;
    delete info.r;
    noIcon++;
  }
  out[key] = info;
}
const ore: Record<string, string[]> = {};
for (const name of [...oreNeeded].sort()) ore[name] = oreAll.get(name)!.filter((k) => out[k] || k.endsWith(`@${WILDCARD}`));

// Mod names for the tooltips' last line, keyed by registry domain (only the domains shipped).
const mods: Record<string, string> = {};
for (const key of Object.keys(out)) {
  if (key.startsWith('fluid:')) continue;
  const domain = key.slice(0, key.indexOf(':'));
  const name = exp.modNames?.[domain] ?? exp.modNames?.[domain.toLowerCase()];
  if (name) mods[domain] = name;
  const m = out[key].m;
  if (m && m !== domain && exp.modNames?.[m]) mods[m] = exp.modNames[m];
}

const index: ItemIndex & { ore: Record<string, string[]>; mods: Record<string, string>; iconDir: string } = {
  format: 1,
  generatedAt: new Date().toISOString(),
  source: { dailyTag: process.env.DAILY_TAG ?? '' },
  items: out,
  ore,
  mods,
  iconDir: 'data/icons/',
};
writeFileSync(join(outDir, 'items.json'), JSON.stringify(index));
writeFileSync(join(outDir, 'names.json'), JSON.stringify({ entities, dimensions: exp.dimensionNames ?? {} }));

console.log(
  `items: ${Object.keys(out).length} entries (${items.size} in export), ${copied} icons copied, ` +
    `${noIcon} without icon, ${Object.keys(ore).length} ore names, ${Object.keys(entities).length} entity names, ` +
    `${Object.keys(mods).length} mod names, ${Object.keys(exp.dimensionNames ?? {}).length} dimension names`,
);
console.log(`quest items not in the export: ${missing.size}`);
console.log([...missing].slice(0, 40).join('\n'));
