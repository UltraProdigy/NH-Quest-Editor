// Builds the data behind the NEI recipe views (public/data/nei/) from the game-data export
// (exporter/, format dev.gtnhplanner.oracle.v1).
//
// Usage: node scripts/build-recipes.ts <export.json[.gz]> <icons dir> [out dir] [--ordering <handlerordering.csv>]
//   [--pictures <dir>]  (the generic handlers' pictures; default: <icons dir>/../nei-layouts/handlers)
//
// Output, all loaded on demand by the site (src/nei/data.ts):
// - items.json: every item, fluid and ore dictionary name the recipes mention. Items are numbered;
//   recipes refer to them by number.
// - handlers.json: one entry per NEI tab (shaped and shapeless crafting, smelting, each GregTech
//   recipe map) with its name, catalysts, layout and the recipe chunks.
// - recipes/<n>.json: the recipes, a few hundred kilobytes per file, each holding a run of one
//   handler's recipes.
// - index/<n>.json: per item key, which recipes make it ("made by") and use it ("used in"),
//   sharded by a hash of the key.
// - icons/<n>.png: the item icons, shrunk to the smallest size that loses nothing and packed into
//   512 px sheets (16x16 icons of 32 px, 8x8 of 64 px, and so on).
// - list.json: NEI's item list in its order with its collapsible groups (newer exports only).
// - tooltips.json: the item list's tooltips, for the item panel's tooltips and NEI's search.
// - pictures/<n>.png: what the generically captured handlers draw (backgrounds, foregrounds),
//   cropped to what was drawn.
//
// See src/nei/model.ts for the shapes.

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { parseJsonFile, type Json, type JsonPath } from './jsonStream.ts';
import type { NeiItems, NeiHandler, NeiRecipeChunk, NeiIndexShard, Slot, SlotObj, NeiRecipe, GtLayout } from '../src/nei/model.ts';
import { standardLines } from '../src/nei/text.ts';
import { INDEX_SHARDS, shardOf } from '../src/nei/model.ts';
import { gtLookup, type GtLookupExport } from './gtLookup.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const orderingArg = flag('--ordering');
const picturesArg = flag('--pictures');
const [exportArg, iconsArg, outArg] = args;
if (!exportArg || !iconsArg) {
  console.error('Usage: node scripts/build-recipes.ts <export.json[.gz]> <icons dir> [out dir] [--ordering <csv>]');
  process.exit(2);
}
const outDir = resolve(outArg ?? 'public/data/nei');
const iconsDir = resolve(iconsArg);
const picturesDir = resolve(picturesArg ?? join(iconsDir, '..', 'nei-layouts', 'handlers'));
const WILDCARD = 32767;

// ---------------------------------------------------------------- export shapes

interface Res {
  kind: 'item' | 'fluid' | 'oreDictionary' | 'choice' | 'text';
  id?: string;
  registryId?: string;
  meta?: number;
  amount?: number;
  displayName?: string;
  modId?: string;
  icon?: string;
  nbt?: string;
  names?: string[];
  alternatives?: Res[];
  chance?: number;
  consumed?: boolean;
  slotIndex?: number;
  /** GT: the recipe slot, when empty slots before it were left out. */
  slot?: number;
}
interface GtMap {
  id: string;
  name: string;
  catalysts?: { resource: Res; priority?: number }[];
}

/** One NEI recipe handler as the exporter recorded it (domain "nei", newer exports only). */
interface NeiExport {
  index: number;
  className: string;
  kind: 'shaped' | 'shapeless' | 'smelting' | 'gt' | 'other';
  id?: string;
  handlerId?: string;
  name?: string;
  tabName?: string;
  order?: number;
  info?: { modName?: string; height?: number; width?: number; yShift?: number; showBadge?: boolean; multiple?: boolean; icon?: Res };
  catalysts?: Res[];
  map?: string;
  recipes?: number[];
  lines?: string[][];
  layout?: GtLayout;
}

/** NEI's item list (domain "nei", itemList). */
interface ListItemExport extends Res {
  group?: number;
  hidden?: boolean;
  tooltip?: string[];
  rarity?: string;
  /** What NEI's identifier search (&) matches: "registry name\nid:damage", or "fluid name\nfluid id". */
  ident?: string;
}
interface ListExport {
  groups?: { name?: string; expanded?: boolean }[];
  items?: ListItemExport[];
  /** NEI's item subsets: full name and [start, length] runs of positions in items. */
  subsets?: { name?: string; items?: number[] }[];
}

/** A generically captured handler (domain "nei", generic): see exporter NeiGenericCapture. */
interface GenericStackExport {
  x: number;
  y: number;
  w?: number;
  h?: number;
  /** 0 ingredient, 1 result, 2 other. */
  r: number;
  i?: number[];
  a?: number;
  c?: number;
  tip?: string[];
  d?: number;
}
type GenericText = [text: string, x: number, y: number, color: number, shadow: number, layer: number];
interface GenericRecipeExport {
  s?: GenericStackExport[];
  t?: GenericText[];
  bg?: number;
  fg?: number;
  for?: number[];
}
interface GenericHandlerExport {
  index: number;
  size?: [number, number];
  margin?: number;
  mode?: string;
  status?: string;
  truncated?: boolean;
  recipes?: GenericRecipeExport[];
}
interface GenericExport {
  items?: Res[];
  images?: string[];
  handlers?: GenericHandlerExport[];
}

// ---------------------------------------------------------------- items

interface ItemRec {
  key: string;
  name: string;
  mod: string;
  icon?: string;
  nbt?: string;
}
const items = new Map<string, ItemRec>();
const byRegistry = new Map<string, Set<string>>();
const nbtHash = (nbt: string) => createHash('sha1').update(nbt).digest('hex').slice(0, 8);

/** Key of an item or fluid resource; registers it. Wildcard metas register nothing. */
function itemKeyOf(r: Res): string | null {
  if (r.kind === 'fluid') {
    const key = `fluid:${r.id}`;
    if (!items.has(key)) items.set(key, { key, name: r.displayName ?? r.id!, mod: '', icon: r.icon });
    else if (!items.get(key)!.icon && r.icon) items.get(key)!.icon = r.icon;
    return key;
  }
  if (r.kind !== 'item' || !r.id) return null;
  const reg = r.registryId ?? r.id.replace(/@\d+$/, '');
  const meta = r.meta ?? 0;
  const base = `${reg}@${meta}`;
  if (meta === WILDCARD) return base;
  const key = r.nbt && r.nbt !== '{}' ? `${base}#${nbtHash(r.nbt)}` : base;
  const prev = items.get(key);
  if (!prev) {
    items.set(key, {
      key, name: r.displayName ?? key, mod: r.modId ?? reg.slice(0, reg.indexOf(':')), icon: r.icon,
      ...(key !== base ? { nbt: r.nbt } : {}),
    });
    let set = byRegistry.get(reg);
    if (!set) byRegistry.set(reg, (set = new Set()));
    set.add(key);
  } else if (!prev.icon && r.icon) prev.icon = r.icon;
  return key;
}
const baseKey = (key: string) => key.replace(/#.*$/, '');

// Slots are collected with item keys first and numbered once every item is known.
type KSlot = { k?: string[]; o?: string; n?: number; c?: number; nc?: 1; p?: number };

const oreNames = new Map<string, string[]>(); // ore name -> member keys (wildcards kept as reg@32767)
const oreUsed = new Set<string>();

function slotOf(r: Res | null | undefined): KSlot | null {
  if (!r) return null;
  const s: KSlot = {};
  if (r.kind === 'oreDictionary' && r.names?.length) {
    const name = r.names.length === 1 ? r.names[0] : r.names.join('|');
    s.o = name;
    oreUsed.add(name);
  } else if (r.kind === 'choice' && r.alternatives?.length) {
    s.k = r.alternatives.map((a) => itemKeyOf({ ...a, kind: 'item' })).filter((k): k is string => !!k);
  } else {
    const k = itemKeyOf(r);
    if (!k) return null;
    s.k = [k];
    if (r.alternatives?.length) {
      for (const a of r.alternatives) {
        const ak = itemKeyOf(a);
        if (ak && !s.k.includes(ak)) s.k.push(ak);
      }
    }
  }
  if (r.amount !== undefined && r.amount !== 1) s.n = r.amount;
  if (typeof r.chance === 'number' && r.chance < 1) s.c = Math.round(r.chance * 10000);
  if (r.consumed === false) s.nc = 1;
  if (typeof r.slot === 'number') s.p = r.slot;
  return s;
}

// ---------------------------------------------------------------- handlers and recipes

type KRecipe =
  | { t: 'shaped'; w: number; g: (KSlot | null)[]; o: KSlot }
  | { t: 'shapeless'; g: KSlot[]; o: KSlot }
  | { t: 'smelting'; i: KSlot; o: KSlot }
  | { t: 'gt'; e: number; d: number; s: number; ii: KSlot[]; io: KSlot[]; fi: KSlot[]; fo: KSlot[]; sp: KSlot[]; f?: number; lines?: string[] }
  | {
      t: 'generic';
      s: { x: number; y: number; w?: number; h?: number; r: number; k: KSlot; tip?: string[]; d?: 1 }[];
      tx?: GenericText[];
      bg?: number;
      fg?: number;
      for?: string[];
    };

interface KHandler {
  id: string;
  /** NEI handler id used by handlerordering.csv. */
  orderId: string;
  name: string;
  kind: NeiHandler['kind'];
  catalysts: KSlot[];
  icon?: KSlot;
  recipes: KRecipe[];
  layout?: GtLayout;
  height: number;
  yShift: number;
  multiple: boolean;
  tab?: string;
  mod?: string;
  badges?: boolean;
  /** Generic handlers: the recipe width (HandlerInfo), when not NEI's 166. */
  width?: number;
}

const shaped: KHandler = {
  id: 'crafting.shaped', orderId: 'codechicken.nei.recipe.ShapedRecipeHandler', name: 'Shaped Crafting', kind: 'shaped',
  catalysts: [], recipes: [], height: 65, yShift: 0, multiple: true,
};
const shapeless: KHandler = {
  id: 'crafting.shapeless', orderId: 'codechicken.nei.recipe.ShapelessRecipeHandler', name: 'Shapeless Crafting', kind: 'shapeless',
  catalysts: [], recipes: [], height: 65, yShift: 0, multiple: true,
};
const smelting: KHandler = {
  id: 'smelting', orderId: 'codechicken.nei.recipe.FurnaceRecipeHandler', name: 'Smelting', kind: 'smelting',
  catalysts: [], recipes: [], height: 65, yShift: 0, multiple: true,
};
const gtHandlers: KHandler[] = [];
const gtByMap = new Map<string, KHandler>();
const neiExport: NeiExport[] = [];
const fuelKeys: string[] = [];
let gtLookupExport: GtLookupExport | undefined;
let listExport: ListExport | undefined;
let genericExport: GenericExport | undefined;

/**
 * Grid width of a shaped recipe. Forge's ShapedOreRecipe keeps its width in a field the older
 * exports did not read (they report 0); for those it is guessed from the last filled slot.
 */
function shapedWidth(width: number, inputs: Res[]): number {
  if (width > 0) return width;
  const last = Math.max(-1, ...inputs.map((i) => i.slotIndex ?? 0));
  if (last >= 4) return 3;
  if (last === 3) return 2;
  if (last === 2) return 3;
  return 1;
}

function craftingRecipe(r: Record<string, Json>) {
  const type = String(r.type ?? '');
  const inputs = (r.inputs ?? []) as unknown as Res[];
  const out = slotOf(r.output as unknown as Res);
  if (!out) return;
  const isShapeless = type === 'shapeless' || (type !== 'shaped' && /shapeless/i.test(type));
  const isShaped = type === 'shaped' || (!isShapeless && /shaped/i.test(type));
  if (isShapeless) {
    const g = inputs.map(slotOf).filter((s): s is KSlot => !!s);
    if (g.length) shapeless.recipes.push({ t: 'shapeless', g, o: out });
  } else if (isShaped) {
    const w = shapedWidth(Number(r.width ?? 0), inputs);
    const g: (KSlot | null)[] = [];
    for (const i of inputs) {
      const s = slotOf(i);
      if (s) g[i.slotIndex ?? g.length] = s;
    }
    for (let i = 0; i < g.length; i++) g[i] ??= null;
    if (g.length && g.length <= 9) shaped.recipes.push({ t: 'shaped', w, g, o: out });
  }
}

function smeltingRecipe(r: Record<string, Json>) {
  const i = slotOf(r.input as unknown as Res);
  const o = slotOf(r.output as unknown as Res);
  if (i && o) {
    if (i.n) delete i.n; // NEI shows the ingredient as one item
    smelting.recipes.push({ t: 'smelting', i, o });
  }
}

let currentMap: KHandler | null = null;
function gtMap(m: GtMap): KHandler {
  const cats = [...(m.catalysts ?? [])]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.priority ?? 0) - (a.c.priority ?? 0) || a.i - b.i)
    .map(({ c }) => slotOf({ ...c.resource, amount: 1 }))
    .filter((s): s is KSlot => !!s);
  const h: KHandler = {
    id: m.id, orderId: m.id, name: m.name, kind: 'gt', catalysts: cats, recipes: [],
    height: 135, yShift: 8, multiple: true, badges: true,
  };
  gtHandlers.push(h);
  gtByMap.set(m.id, h);
  return h;
}

function gtRecipe(r: Record<string, Json>) {
  if (!currentMap) return;
  if (r.enabled === false) return;
  const list = (k: string) => ((r[k] ?? []) as unknown as Res[]).map(slotOf).filter((s): s is KSlot => !!s);
  const rec: KRecipe = {
    t: 'gt',
    e: Number(r.eut ?? 0),
    d: Number(r.durationTicks ?? 0),
    s: Number(r.specialValue ?? 0),
    ii: list('itemInputs'),
    io: list('itemOutputs'),
    fi: list('fluidInputs'),
    fo: list('fluidOutputs'),
    sp: list('nonConsumedInputs'),
  };
  if (r.fusionStartupEu !== undefined) rec.f = Number(r.fusionStartupEu);
  currentMap.recipes.push(rec);
}

// ---------------------------------------------------------------- read the export

let modNames: Record<string, string> = {};
const domainIds: string[] = [];

console.time('read export');
await parseJsonFile(resolve(exportArg), {
  mode(path: JsonPath, parent) {
    const n = path.length;
    if (n === 1) return path[0] === 'modNames' ? 'keep' : 'scan';
    if (path[0] !== 'domains') return 'scan';
    if (n === 2) return 'scan';
    const id = n === 3 ? String((parent as Record<string, Json>).id) : domainIds[path[1] as number];
    if (n === 3) {
      domainIds[path[1] as number] = id;
      if (id === 'oreDictionary' && path[2] === 'entries') return 'keep';
      if (id === 'nei' && ['handlers', 'fuels', 'gtLookup', 'itemList', 'generic'].includes(String(path[2]))) return 'keep';
      return 'scan';
    }
    if ((id === 'crafting' || id === 'smelting') && path[2] === 'recipes') return n === 4 ? 'scan' : 'keep';
    if (id === 'gregtech' && path[2] === 'recipeMaps') {
      if (n === 4) return 'scan'; // a map: its scalars plus the kept members below
      if (n === 5) {
        if (path[4] === 'recipes') {
          currentMap = gtMap(parent as unknown as GtMap);
          return 'scan';
        }
        return path[4] === 'catalysts' ? 'keep' : 'scan';
      }
      if (n === 6) return 'scan'; // a recipe
      return path[6] === 'runtimeCalculation' ? 'scan' : 'keep';
    }
    return 'scan';
  },
  onScan(path, v) {
    if (path[0] !== 'domains') return;
    const id = domainIds[path[1] as number];
    if (path.length === 4 && path[2] === 'recipes' && !Array.isArray(v)) {
      if (id === 'crafting') craftingRecipe(v);
      else if (id === 'smelting') smeltingRecipe(v);
    } else if (path.length === 6 && id === 'gregtech' && path[4] === 'recipes' && !Array.isArray(v)) {
      gtRecipe(v);
    } else if (path.length === 2 && id === 'nei') {
      const d = v as Record<string, Json>;
      neiExport.push(...((d.handlers ?? []) as unknown as NeiExport[]));
      gtLookupExport = d.gtLookup as unknown as GtLookupExport | undefined;
      listExport = d.itemList as unknown as ListExport | undefined;
      genericExport = d.generic as unknown as GenericExport | undefined;
      for (const f of (d.fuels ?? []) as unknown as Res[]) {
        const k = itemKeyOf(f);
        if (k) fuelKeys.push(k);
      }
      // Register the items the handlers show (tab icons, catalysts).
      for (const h of neiExport) {
        if (h.info?.icon) itemKeyOf(h.info.icon);
        for (const c of h.catalysts ?? []) itemKeyOf(c);
      }
    } else if (path.length === 2 && id === 'oreDictionary') {
      const entries = (v as Record<string, Json>).entries as unknown as Record<string, Res[]> | undefined;
      for (const [name, list] of Object.entries(entries ?? {})) {
        oreNames.set(name, list.map((r) => itemKeyOf(r)).filter((k): k is string => !!k));
      }
    }
  },
}).then((root) => {
  modNames = ((root as Record<string, Json>).modNames ?? {}) as Record<string, string>;
});
console.timeEnd('read export');

// ---------------------------------------------------------------- NEI's item list, generic handlers

// The item list in NEI's order (ItemList.items): every stack the item panel shows, registered like
// recipe items so they get numbers and icons.
const listKeys: string[] = [];
const listGroup: number[] = [];
const tooltipOf = new Map<string, string[]>();
const rarityOf = new Map<string, string>();
const identOf = new Map<string, string>();
/** Position in the export's item list -> position in listKeys. */
const listPos = new Map<number, number>();
for (const [pos, it] of (listExport?.items ?? []).entries()) {
  if (it.hidden) continue;
  const k = itemKeyOf(it);
  if (!k || k.endsWith(`@${WILDCARD}`)) continue;
  listPos.set(pos, listKeys.length);
  if (it.ident) identOf.set(k, it.ident);
  listKeys.push(k);
  listGroup.push(it.group ?? -1);
  if (it.tooltip && it.tooltip.length > 1) tooltipOf.set(k, it.tooltip.slice(1));
  const rarity = /^\u00a7([0-9a-fk-or])$/i.exec(it.rarity ?? '')?.[1];
  if (rarity && rarity.toLowerCase() !== 'f') rarityOf.set(k, rarity.toLowerCase());
}

// Stacks of the generically captured handlers, by the capture's item numbers.
const genericKeys = (genericExport?.items ?? []).map((r) => itemKeyOf(r));
const genericAmount = (genericExport?.items ?? []).map((r) => r.amount ?? 1);
const genericByIndex = new Map<number, GenericHandlerExport>();
for (const g of genericExport?.handlers ?? []) if (g.recipes?.length) genericByIndex.set(g.index, g);
const genericMargin = (genericExport?.handlers ?? [])[0]?.margin ?? 16;

/** A captured recipe with item keys; pictures keep the capture's numbers until written. */
function genericRecipe(r: GenericRecipeExport): KRecipe {
  const s = (r.s ?? []).map((st) => {
    let ids = (st.i ?? []).filter((i) => genericKeys[i]);
    if (st.a && st.a > 0 && st.a < ids.length) ids = [...ids.slice(st.a), ...ids.slice(0, st.a)];
    const k: KSlot = { k: [...new Set(ids.map((i) => genericKeys[i]!))] };
    const n = ids.length ? genericAmount[ids[0]] : 1;
    if (n !== 1) k.n = n;
    if (st.c !== undefined) k.c = st.c;
    return {
      x: st.x, y: st.y, r: st.r, k,
      ...(st.w !== undefined && st.w !== 16 ? { w: st.w } : {}),
      ...(st.h !== undefined && st.h !== 16 ? { h: st.h } : {}),
      ...(st.tip?.length ? { tip: st.tip } : {}),
      ...(st.d ? { d: 1 as const } : {}),
    };
  });
  const out: KRecipe = { t: 'generic', s };
  if (r.t?.length) out.tx = r.t;
  if (r.bg !== undefined) out.bg = r.bg;
  if (r.fg !== undefined) out.fg = r.fg;
  if (r.for?.length) out.for = r.for.map((i) => genericKeys[i]).filter((k): k is string => !!k);
  return out;
}

// ---------------------------------------------------------------- handlers as NEI shows them

let allHandlers: KHandler[];

/** The exporter writes some floats as strings ("0.5"); texture coordinates must be numbers. */
function numbers(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(numbers);
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    out[k] = typeof x === 'string' && /^(u0|v0|u1|v1)$/.test(k) && !Number.isNaN(Number(x)) ? Number(x) : numbers(x);
  }
  return out;
}
const slotsOf = (list: Res[] | undefined) => (list ?? []).map((r) => slotOf({ ...r, amount: 1 })).filter((s): s is KSlot => !!s);

if (neiExport.length) {
  // The export recorded NEI's handlers: their names, tabs, catalysts and order, and for GregTech
  // the recipes of each tab (hidden ones left out, in NEI's order) with their description lines.
  const out: { h: KHandler; order: number; index: number }[] = [];
  const vanilla: Record<string, KHandler> = { shaped, shapeless, smelting };
  const usedIds = new Set<string>();
  for (const e of neiExport) {
    let h: KHandler | undefined;
    if (e.kind in vanilla) {
      h = vanilla[e.kind];
      if (!h.recipes.length) continue;
    } else if (e.kind === 'gt' && e.map && gtByMap.has(e.map)) {
      const all = gtByMap.get(e.map)!.recipes;
      const recipes: KRecipe[] = [];
      (e.recipes ?? []).forEach((i, n) => {
        const r = all[i];
        if (r?.t !== 'gt') return;
        recipes.push({ ...r, lines: e.lines?.[n] });
      });
      if (!recipes.length) continue;
      const layout = numbers(e.layout ?? {}) as GtLayout;
      h = {
        id: e.id ?? e.map, orderId: e.id ?? e.map, name: e.name ?? e.map, kind: 'gt', catalysts: [], recipes,
        layout, height: 135, yShift: 8, multiple: true,
      };
    } else if (e.kind === 'other' && genericByIndex.has(e.index)) {
      const g = genericByIndex.get(e.index)!;
      let id = e.id ?? e.handlerId ?? e.className;
      if (usedIds.has(id)) id = `${id}.${e.index}`;
      h = {
        id, orderId: id, name: e.name ?? e.className, kind: 'generic', catalysts: [],
        recipes: (g.recipes ?? []).map(genericRecipe),
        height: g.size?.[1] ?? 65, yShift: 0, multiple: true,
        ...(g.size && g.size[0] !== 166 ? { width: g.size[0] } : {}),
      };
    } else continue;
    usedIds.add(h.id);
    h.name = (e.name ?? h.name).trim();
    if (e.tabName && e.tabName.trim() !== h.name) h.tab = e.tabName.trim();
    if (e.info?.modName) h.mod = e.info.modName;
    if (e.info?.height) h.height = e.info.height;
    if (e.info?.yShift !== undefined) h.yShift = e.info.yShift;
    if (e.info?.showBadge !== undefined) h.badges = e.info.showBadge;
    if (e.info?.icon) h.icon = slotOf({ ...e.info.icon, amount: 1 }) ?? undefined;
    h.catalysts = slotsOf(e.catalysts);
    out.push({ h, order: e.order ?? 0, index: e.index });
  }
  allHandlers = out.sort((a, b) => a.order - b.order || a.index - b.index).map((x) => x.h);
} else {
  // Older exports: one tab per GT map with all its recipes, crafting tables and furnaces as the
  // catalysts of the vanilla handlers, and the modpack's handler order when given.
  for (const [h, key] of [
    [shaped, 'minecraft:crafting_table@0'],
    [shapeless, 'minecraft:crafting_table@0'],
    [smelting, 'minecraft:furnace@0'],
  ] as const) {
    if (items.has(key)) h.catalysts.push({ k: [key] });
  }
  const ordering = new Map<string, number>();
  if (orderingArg && existsSync(orderingArg)) {
    for (const line of readFileSync(orderingArg, 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const [id, n] = line.split(',');
      if (id && n !== undefined && n.trim() !== '' && !Number.isNaN(Number(n))) ordering.set(id.trim(), Number(n));
    }
  }
  allHandlers = [shaped, shapeless, smelting, ...gtHandlers]
    .filter((h) => h.recipes.length > 0)
    .map((h, i) => ({ h, i }))
    .sort((a, b) => (ordering.get(a.h.orderId) ?? 0) - (ordering.get(b.h.orderId) ?? 0) || a.i - b.i)
    .map(({ h }) => h);
}

// ---------------------------------------------------------------- number everything

/** Wildcard metas and ore names become the item keys they stand for. */
function expand(key: string): string[] {
  if (key.endsWith(`@${WILDCARD}`)) {
    const reg = key.slice(0, -`@${WILDCARD}`.length);
    const all = [...(byRegistry.get(reg) ?? [])].filter((k) => !k.includes('#')).sort(naturalCompare);
    return all.length ? all : [];
  }
  return [key];
}
function naturalCompare(a: string, b: string) {
  const am = /^(.*)@(\d+)(#.*)?$/.exec(a), bm = /^(.*)@(\d+)(#.*)?$/.exec(b);
  if (am && bm && am[1] === bm[1]) return Number(am[2]) - Number(bm[2]) || (am[3] ?? '').localeCompare(bm[3] ?? '');
  return a < b ? -1 : a > b ? 1 : 0;
}

const oreList = [...oreUsed].sort();
const oreMembers = new Map<string, string[]>();
for (const name of oreList) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of name.split('|')) {
    for (const k of oreNames.get(part) ?? []) for (const e of expand(k)) if (!seen.has(e)) seen.add(e), out.push(e);
  }
  oreMembers.set(name, out);
}

const keys = [...items.keys()].sort(naturalCompare);
const indexOf = new Map(keys.map((k, i) => [k, i]));
const oreIndex = new Map(oreList.map((n, i) => [n, i]));

function numberSlot(s: KSlot): Slot {
  const o: SlotObj = {};
  if (s.o !== undefined) o.o = oreIndex.get(s.o)!;
  if (s.k) {
    const ks: number[] = [];
    for (const k of s.k) for (const e of expand(k)) {
      const i = indexOf.get(e);
      if (i !== undefined && !ks.includes(i)) ks.push(i);
    }
    if (!ks.length) return -1;
    o.i = ks.length === 1 ? ks[0] : ks;
  }
  if (s.n !== undefined) o.n = s.n;
  if (s.c !== undefined) o.c = s.c;
  if (s.nc) o.nc = 1;
  if (s.p !== undefined) o.p = s.p;
  const plain = Object.keys(o).length === 1 && typeof o.i === 'number';
  return plain ? (o.i as number) : o;
}
const numberSlots = (list: KSlot[]) => list.map(numberSlot);

function numberRecipe(r: KRecipe, amperage = 1): NeiRecipe {
  switch (r.t) {
    case 'shaped':
      return { w: r.w, g: r.g.map((s) => (s ? numberSlot(s) : null)), o: numberSlot(r.o) };
    case 'shapeless':
      return { g: numberSlots(r.g), o: numberSlot(r.o) };
    case 'smelting':
      return { i: numberSlot(r.i), o: numberSlot(r.o) };
    case 'gt': {
      const g: NeiRecipe = { e: r.e, d: r.d };
      if (r.s) g.s = r.s;
      if (r.ii.length) g.ii = numberSlots(r.ii);
      if (r.io.length) g.io = numberSlots(r.io);
      if (r.fi.length) g.fi = numberSlots(r.fi);
      if (r.fo.length) g.fo = numberSlots(r.fo);
      if (r.sp.length) g.sp = numberSlots(r.sp);
      if (r.f !== undefined) g.f = r.f;
      // Keep only the description lines the site cannot rebuild from the numbers.
      if (r.lines?.length) {
        const std = standardLines(r.e, r.d, amperage);
        const lines = r.lines.filter((l) => l !== '');
        if (std.every((l, i) => lines[i] === l)) {
          if (lines.length > std.length) g.x = lines.slice(std.length);
        } else g.t = lines;
      }
      return g;
    }
    case 'generic': {
      const g: NeiRecipe = {
        ps: r.s.map((st) => ({
          x: st.x, y: st.y, r: st.r, s: numberSlot(st.k),
          ...(st.w !== undefined ? { w: st.w } : {}),
          ...(st.h !== undefined ? { h: st.h } : {}),
          ...(st.tip ? { tip: st.tip } : {}),
          ...(st.d ? { d: 1 as const } : {}),
        })),
      };
      if (r.tx) g.tx = r.tx;
      if (r.bg !== undefined) g.bg = pictureNo(r.bg);
      if (r.fg !== undefined) g.fg = pictureNo(r.fg);
      return g;
    }
  }
}

/** Output numbers of the captured pictures, in order of first use; written with the icons. */
const pictureOut = new Map<number, number>();
function pictureNo(id: number): number {
  let n = pictureOut.get(id);
  if (n === undefined) pictureOut.set(id, (n = pictureOut.size));
  return n;
}

// ---------------------------------------------------------------- write

rmSync(outDir, { recursive: true, force: true });
for (const d of ['recipes', 'index', 'icons']) mkdirSync(join(outDir, d), { recursive: true });

// Recipes, in chunks of about CHUNK_BYTES of JSON, each a run of one handler's recipes.
const CHUNK_BYTES = 256 * 1024;
const handlersOut: NeiHandler[] = [];
let chunkNo = 0;
const refs = new Map<string, { m: Map<number, number[]>; u: Map<number, number[]>; c?: number[] }>();
const ref = (key: string) => {
  let r = refs.get(key);
  if (!r) refs.set(key, (r = { m: new Map(), u: new Map() }));
  return r;
};
function addRef(key: string, kind: 'm' | 'u', h: number, recipe: number) {
  const map = ref(key)[kind];
  let list = map.get(h);
  if (!list) map.set(h, (list = []));
  if (list[list.length - 1] !== recipe) list.push(recipe);
}
function slotKeys(s: Slot | null): string[] {
  if (s === null || s === -1) return [];
  if (typeof s === 'number') return [baseKey(keys[s])];
  const out: string[] = [];
  if (s.o !== undefined) out.push(`ore:${oreList[s.o]}`);
  if (s.i !== undefined) for (const i of typeof s.i === 'number' ? [s.i] : s.i) out.push(baseKey(keys[i]));
  return out;
}

allHandlers.forEach((h, hi) => {
  const chunks: [file: number, count: number][] = [];
  let buf: NeiRecipe[] = [];
  let bytes = 0;
  const flush = () => {
    if (!buf.length) return;
    const chunk: NeiRecipeChunk = { h: hi, r: buf };
    writeFileSync(join(outDir, 'recipes', `${chunkNo}.json`), JSON.stringify(chunk));
    chunks.push([chunkNo++, buf.length]);
    buf = [];
    bytes = 0;
  };
  h.recipes.forEach((r, ri) => {
    const n = numberRecipe(r, h.layout?.amperage ?? 1);
    const s = JSON.stringify(n);
    if (bytes + s.length > CHUNK_BYTES) flush();
    buf.push(n);
    bytes += s.length + 1;
    // Index: what each recipe makes and uses.
    const made: (Slot | null)[] = [];
    const used: (Slot | null)[] = [];
    if ('o' in n) made.push(n.o as Slot);
    if ('g' in n) used.push(...(n.g as (Slot | null)[]));
    if ('i' in n && n.i !== undefined && 'o' in n) used.push(n.i as Slot);
    if ('io' in n) made.push(...(n.io ?? []));
    if ('fo' in n) made.push(...(n.fo ?? []));
    if ('ii' in n) used.push(...(n.ii ?? []));
    if ('fi' in n) used.push(...(n.fi ?? []));
    if ('sp' in n) used.push(...(n.sp ?? []));
    // Generic handlers, as NEI's Recipe.of reads a recipe: the result stack, or the other stacks
    // when there is none; ingredients are used. Handlers captured item by item know exactly which
    // items each recipe was shown for.
    let madeKeys: string[] | null = null;
    if (n.ps) {
      const results = n.ps.filter((p) => p.r === 1);
      made.push(...(results.length ? results : n.ps.filter((p) => p.r === 2)).map((p) => p.s));
      used.push(...n.ps.filter((p) => p.r === 0).map((p) => p.s));
      if (r.t === 'generic' && r.for?.length) madeKeys = r.for.map(baseKey);
    }
    for (const k of new Set(madeKeys ?? made.flatMap(slotKeys))) addRef(k, 'm', hi, ri);
    for (const k of new Set(used.flatMap(slotKeys))) addRef(k, 'u', hi, ri);
  });
  flush();
  const cats = h.catalysts.map(numberSlot).filter((s) => s !== -1);
  for (const c of cats) for (const k of slotKeys(c)) (ref(k).c ??= []).push(hi);
  const out: NeiHandler = {
    id: h.id,
    name: h.name,
    kind: h.kind,
    count: h.recipes.length,
    chunks,
    catalysts: cats,
    height: h.height,
    yShift: h.yShift,
  };
  const icon = h.icon ? numberSlot(h.icon) : cats[0];
  if (icon !== undefined && icon !== -1) out.icon = icon;
  if (h.layout) out.layout = h.layout;
  if (h.tab) out.tab = h.tab;
  if (h.mod) out.mod = h.mod;
  if (h.badges !== undefined) out.badges = h.badges;
  if (h.width) out.width = h.width;
  if (h.kind === 'gt') {
    const max: [number, number, number, number] = [0, 0, 0, 0];
    for (const r of h.recipes) {
      if (r.t !== 'gt') continue;
      max[0] = Math.max(max[0], r.ii.length);
      max[1] = Math.max(max[1], r.io.length);
      max[2] = Math.max(max[2], r.fi.length);
      max[3] = Math.max(max[3], r.fo.length);
    }
    out.max = max;
  }
  handlersOut.push(out);
});
const fuels = fuelKeys.map((k) => indexOf.get(k)).filter((i): i is number => i !== undefined);

// The generic handlers' pictures, cropped to what was drawn: [x, y, width, height] relative to the
// recipe's origin (the capture drew with a margin around the recipe).
const pics: [number, number, number, number][] = [];
if (pictureOut.size) {
  mkdirSync(join(outDir, 'pictures'), { recursive: true });
  const images = genericExport?.images ?? [];
  let missing = 0;
  for (const [id, no] of pictureOut) {
    pics[no] = [0, 0, 0, 0];
    const file = join(picturesDir, images[id] ?? '');
    if (!images[id] || !existsSync(file)) {
      missing++;
      continue;
    }
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let x0 = info.width, y0 = info.height, x1 = -1, y1 = -1;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      if (!data[(y * info.width + x) * 4 + 3]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (x1 < 0) continue;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    await sharp(file).extract({ left: x0, top: y0, width: w, height: h }).png({ compressionLevel: 9 })
      .toFile(join(outDir, 'pictures', `${no}.png`));
    pics[no] = [x0 - genericMargin, y0 - genericMargin, w, h];
  }
  console.log(`pictures: ${pictureOut.size} (${missing} missing)`);
}

writeFileSync(
  join(outDir, 'handlers.json'),
  JSON.stringify({ format: 1, handlers: handlersOut, ...(fuels.length ? { fuels } : {}), ...(pics.length ? { pics } : {}) }),
);

// NEI's item list and what the item panel and its search need beyond items.json: tooltips (the
// lines under the name), rarity colours and every ore dictionary name of the listed items.
if (listKeys.length) {
  const listIdx = listKeys.map((k) => indexOf.get(k)!);
  writeFileSync(
    join(outDir, 'list.json'),
    JSON.stringify({
      format: 1,
      items: listIdx,
      group: listGroup,
      groups: (listExport?.groups ?? []).map((g) => [g.name ?? '', g.expanded ? 1 : 0]),
    }),
  );
  const lines: Record<number, string[]> = {};
  const rarity: Record<number, string> = {};
  for (const [k, l] of tooltipOf) lines[indexOf.get(k)!] = l;
  for (const [k, r] of rarityOf) rarity[indexOf.get(k)!] = r;
  // Ore names of each listed item (OreDictionary.getOreIDs): wildcard entries cover every meta.
  const listed = new Set(listKeys);
  const byBase = new Map<string, string[]>();
  for (const k of listKeys) {
    const b = baseKey(k);
    const l = byBase.get(b);
    if (l) l.push(k);
    else byBase.set(b, [k]);
  }
  const byReg = new Map<string, string[]>();
  for (const k of listKeys) {
    const reg = k.replace(/@.*$/, '');
    const l = byReg.get(reg);
    if (l) l.push(k);
    else byReg.set(reg, [k]);
  }
  const oreNamesList: string[] = [];
  const ore: Record<number, number[]> = {};
  for (const [name, members] of oreNames) {
    let n = -1;
    for (const m of members) {
      const targets = m.endsWith(`@${WILDCARD}`) ? (byReg.get(m.slice(0, -`@${WILDCARD}`.length)) ?? []) : (byBase.get(m) ?? []);
      for (const t of targets) {
        if (!listed.has(t)) continue;
        if (n < 0) n = oreNamesList.push(name) - 1;
        const i = indexOf.get(t)!;
        const l = (ore[i] ??= []);
        if (!l.includes(n)) l.push(n);
      }
    }
  }
  // NEI's identifier search (&): numeric item ids by registry name ("id" for item k@meta is
  // "reg\nid:meta"); for stacks whose identifier does not follow that (fluids), the whole text.
  const ids: Record<string, number> = {};
  const idents: Record<number, string> = {};
  for (const [k, ident] of identOf) {
    const reg = k.replace(/@.*$/, '');
    const m = /^(.*)\n(\d+):(\d+)$/.exec(ident);
    const meta = /@(\d+)/.exec(k)?.[1];
    if (m && m[1] === reg && meta !== undefined && m[3] === meta && (ids[reg] === undefined || ids[reg] === Number(m[2]))) ids[reg] = Number(m[2]);
    else idents[indexOf.get(k)!] = ident;
  }
  // NEI's item subsets (%): each tag's full name and the item indexes it holds, as [start, length]
  // runs over the list order.
  const subsets: [string, number[]][] = [];
  for (const t of listExport?.subsets ?? []) {
    if (!t.name || !t.items?.length) continue;
    const positions: number[] = [];
    for (let i = 0; i + 1 < t.items.length; i += 2) {
      for (let p = t.items[i]; p < t.items[i] + t.items[i + 1]; p++) {
        const at = listPos.get(p);
        if (at !== undefined) positions.push(at);
      }
    }
    const runs: number[] = [];
    for (const p of positions) {
      if (runs.length && runs[runs.length - 2] + runs[runs.length - 1] === p) runs[runs.length - 1]++;
      else runs.push(p, 1);
    }
    if (runs.length) subsets.push([t.name, runs]);
  }
  writeFileSync(
    join(outDir, 'tooltips.json'),
    JSON.stringify({
      format: 1, lines, rarity, ores: oreNamesList, ore,
      ...(Object.keys(ids).length ? { ids } : {}),
      ...(Object.keys(idents).length ? { idents } : {}),
      ...(subsets.length ? { subsets } : {}),
    }),
  );
  console.log(
    `item list: ${listKeys.length} items, ${listExport?.groups?.length ?? 0} groups, ${tooltipOf.size} tooltips, ` +
      `${Object.keys(ids).length} numeric ids, ${subsets.length} subsets`,
  );
}

// GregTech tabs also show the recipes of related items (unified and familiar items, a fluid and
// its containers); list the related keys that have GregTech recipes of their own.
const lookup = gtLookup(gtLookupExport, {
  nbt: [...items.values()].filter((it) => it.nbt).map((it) => [it.key, it.nbt!] as [string, string]),
});
const isGt = allHandlers.map((h) => h.kind === 'gt');
const hasGt = (key: string, kind: 'm' | 'u') => [...(refs.get(key)?.[kind].keys() ?? [])].some((h) => isGt[h]);
const related = new Map<string, { gm?: string[]; gu?: string[] }>();
let relatedCount = 0;
for (const key of new Set([...lookup.keys(), ...keys.map(baseKey)])) {
  // Stacks with NBT (data sticks, filled containers) are looked up under their full key.
  const gm = lookup.recipes(key).filter((k) => hasGt(k, 'm'));
  const gu = lookup.usages(key).filter((k) => hasGt(k, 'u'));
  if (!gm.length && !gu.length) continue;
  related.set(key, { ...(gm.length ? { gm } : {}), ...(gu.length ? { gu } : {}) });
  relatedCount++;
}

// Index shards.
const shards: NeiIndexShard[] = Array.from({ length: INDEX_SHARDS }, () => ({}));
for (const key of new Set([...refs.keys(), ...related.keys()])) {
  const r = refs.get(key);
  const e: NeiIndexShard[string] = {};
  if (r?.m.size) e.m = [...r.m].map(([h, list]) => [h, list]);
  if (r?.u.size) e.u = [...r.u].map(([h, list]) => [h, list]);
  if (r?.c?.length) e.c = r.c;
  Object.assign(e, related.get(key));
  shards[shardOf(key)][key] = e;
}
shards.forEach((s, i) => writeFileSync(join(outDir, 'index', `${i}.json`), JSON.stringify(s)));

// ---------------------------------------------------------------- icons

console.time('icons');
const SHEET = 512;

/** The smallest of 32/64/128 px that reproduces a 256 px render exactly when point-sampled. */
function smallestLossless(px: Buffer, S: number): number {
  for (const n of [32, 64, 128]) {
    if (n >= S || S % n) continue;
    const k = S / n;
    let ok = true;
    outer: for (let y = 0; y < S; y++) {
      const sy = y - (y % k);
      for (let x = 0; x < S; x++) {
        const a = (y * S + x) * 4, b = (sy * S + x - (x % k)) * 4;
        if (px[a] !== px[b] || px[a + 1] !== px[b + 1] || px[a + 2] !== px[b + 2] || px[a + 3] !== px[b + 3]) {
          ok = false;
          break outer;
        }
      }
    }
    if (ok) return n;
  }
  return S;
}

/** An icon file decoded and shrunk, or null when it is missing or empty. */
async function readIcon(file: string): Promise<{ size: number; data: Buffer } | null> {
  const path = join(iconsDir, file);
  if (!existsSync(path)) return null;
  try {
    const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== info.height) return null;
    let blank = true;
    for (let i = 3; i < data.length; i += 4) if (data[i]) { blank = false; break; }
    if (blank) return null;
    const S = info.width;
    const n = smallestLossless(data, S);
    if (n === S) return { size: S, data };
    const k = S / n;
    const small = Buffer.alloc(n * n * 4);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const src = (y * k * S + x * k) * 4;
      data.copy(small, (y * n + x) * 4, src, src + 4);
    }
    return { size: n, data: small };
  } catch (e) {
    console.warn(`icon ${file}: ${(e as Error).message}`);
    return null;
  }
}

// Sheets fill in key order (after the item list), so items of one mod and kind share sheets. A
// sheet is written as soon as it is full, so only one open sheet per size is held in memory.
const sheetSizes: number[] = [];
const open = new Map<number, { no: number; cells: Buffer[] }>();
const cellOfFile = new Map<string, number>();
const cellOfHash = new Map<string, number>();
const iconOf: number[] = new Array(keys.length).fill(-1);
let missingIcons = 0;
let iconBytes = 0;
const writes: Promise<void>[] = [];

async function writeSheet(no: number, size: number, cells: Buffer[]) {
  const cols = SHEET / size;
  const rows = Math.ceil(cells.length / cols);
  const w = cells.length < cols ? cells.length * size : SHEET;
  const sheet = Buffer.alloc(w * rows * size * 4);
  cells.forEach((c, i) => {
    const cx = (i % cols) * size, cy = Math.floor(i / cols) * size;
    for (let y = 0; y < size; y++) c.copy(sheet, ((cy + y) * w + cx) * 4, y * size * 4, (y + 1) * size * 4);
  });
  const png = await sharp(sheet, { raw: { width: w, height: rows * size, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(join(outDir, 'icons', `${no}.png`), png);
  iconBytes += png.length;
}

// NEI's item list goes first, in its order, so a page of the item panel needs few sheets.
const iconOrder = [...new Set([...listKeys.map((k) => indexOf.get(k)!), ...keys.keys()])];
for (const i of iconOrder) {
  const file = items.get(keys[i])!.icon;
  if (!file) {
    missingIcons++;
    continue;
  }
  let cell = cellOfFile.get(file);
  if (cell === undefined) {
    const img = await readIcon(file);
    if (!img) {
      cellOfFile.set(file, -1);
      missingIcons++;
      continue;
    }
    const hash = createHash('sha1').update(img.data).digest('hex');
    cell = cellOfHash.get(hash);
    if (cell === undefined) {
      let s = open.get(img.size);
      if (!s) {
        s = { no: sheetSizes.length, cells: [] };
        sheetSizes.push(img.size);
        open.set(img.size, s);
      }
      cell = s.no * 256 + s.cells.length;
      s.cells.push(img.data);
      if (s.cells.length >= (SHEET / img.size) ** 2) {
        writes.push(writeSheet(s.no, img.size, s.cells));
        open.delete(img.size);
      }
      cellOfHash.set(hash, cell);
    }
    cellOfFile.set(file, cell);
  }
  if (cell < 0) missingIcons++;
  else iconOf[i] = cell;
}
for (const [size, s] of open) writes.push(writeSheet(s.no, size, s.cells));
await Promise.all(writes);
console.timeEnd('icons');

// ---------------------------------------------------------------- item table

const modList: string[] = [];
const modIdx = new Map<string, number>();
const modOf = (m: string) => {
  let i = modIdx.get(m);
  if (i === undefined) {
    modIdx.set(m, (i = modList.length));
    modList.push(modNames[m] ?? modNames[m.toLowerCase()] ?? (m === 'minecraft' ? 'Minecraft' : m));
  }
  return i;
};
const itemsOut: NeiItems = {
  format: 1,
  generatedAt: new Date().toISOString(),
  source: { dailyTag: process.env.DAILY_TAG ?? '' },
  keys,
  names: keys.map((k) => items.get(k)!.name),
  mods: keys.map((k) => (k.startsWith('fluid:') ? -1 : modOf(items.get(k)!.mod))),
  modNames: modList,
  icons: iconOf,
  sheets: sheetSizes,
  ore: oreList.map((n) => [n, (oreMembers.get(n) ?? []).map((k) => indexOf.get(k)).filter((i): i is number => i !== undefined)]),
};
writeFileSync(join(outDir, 'items.json'), JSON.stringify(itemsOut));

const total = allHandlers.reduce((a, h) => a + h.recipes.length, 0);
console.log(
  `recipes: ${total} in ${allHandlers.length} handlers, ${chunkNo} chunks; items: ${keys.length} ` +
    `(${missingIcons} without icon); ore names: ${oreList.length}; index keys: ${refs.size}; ` +
    `GT related lookups: ${relatedCount}; ` +
    `icons: ${cellOfHash.size} unique in ${sheetSizes.length} sheets, ${(iconBytes / 1048576).toFixed(1)} MB`,
);
