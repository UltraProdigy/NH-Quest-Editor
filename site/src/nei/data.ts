// Loading and lookups for the recipe data (public/data/nei/, see model.ts). Everything is fetched
// the first time a recipe view needs it and cached.

import { fetchJson, siteUrl, image } from '../gui/assets.ts';
import { type Gfx, keys as heldKeys } from '../gui/core.ts';
import { animating, invalidate } from '../gui/frame.ts';
import { drawString, stringWidth } from '../gui/font.ts';
import { drawItemKey, itemInfo } from '../gui/items.ts';
import type { NeiItems, NeiHandlers, NeiHandler, NeiRecipe, NeiRecipeChunk, NeiIndexShard, Slot, SlotObj, NeiList, NeiTooltips } from './model.ts';
import { shardOf } from './model.ts';

const DIR = 'data/nei/';

let items: NeiItems | null = null;
let handlers: NeiHandler[] = [];
let fuels: number[] = [];
let pics: [number, number, number, number][] = [];
let keyIndex = new Map<string, number>();
/** Ore names each item belongs to (only names some recipe uses). */
let oreOf = new Map<number, number[]>();
let loading: Promise<boolean> | null = null;

/** Load the item table and the handler list. Resolves false when there is no recipe data. */
export function loadNei(): Promise<boolean> {
  loading ??= (async () => {
    try {
      const [it, hs] = await Promise.all([
        fetchJson<NeiItems>(siteUrl(DIR + 'items.json')),
        fetchJson<NeiHandlers>(siteUrl(DIR + 'handlers.json')),
      ]);
      items = it;
      handlers = hs.handlers;
      fuels = hs.fuels ?? [];
      pics = hs.pics ?? [];
      keyIndex = new Map(it.keys.map((k, i) => [k, i]));
      oreOf = new Map();
      it.ore.forEach(([, members], o) => {
        for (const m of members) {
          const list = oreOf.get(m);
          if (list) list.push(o);
          else oreOf.set(m, [o]);
        }
      });
      return true;
    } catch (e) {
      console.warn('No recipe data:', e);
      return false;
    }
  })();
  return loading;
}

export const neiLoaded = () => items !== null;
export const handlerList = () => handlers;
/** The smelting handler's fuels, when the export recorded them. */
export const fuelList = () => fuels;
export const itemCount = () => items?.keys.length ?? 0;
export const itemKeyAt = (i: number) => items?.keys[i] ?? '';
export const itemIndexOf = (key: string) => keyIndex.get(key) ?? keyIndex.get(key.replace(/#.*$/, ''));
export const oreName = (o: number) => items?.ore[o]?.[0] ?? '';
export const oreMembers = (o: number) => items?.ore[o]?.[1] ?? [];
/** Ore dictionary entries of items.json by name. */
export const oreEntries = () => items?.ore ?? [];

/** Draw a generic handler's picture with the recipe's origin at (x, y). */
export function picture(gfx: Gfx, n: number, x: number, y: number) {
  const p = pics[n];
  if (!p || !p[2]) return;
  const img = image(siteUrl(`${DIR}pictures/${n}.png`));
  if (img) gfx.image(img, 0, 0, p[2], p[3], x + p[0], y + p[1], p[2], p[3]);
}

// ---------------------------------------------------------------- NEI's item list

let list: NeiList | null = null;
let listLoading: Promise<NeiList | null> | null = null;
/** NEI's item list (list.json); null when the data has none (older exports). */
export function loadList(): Promise<NeiList | null> {
  listLoading ??= (async () => {
    if (!(await loadNei())) return null;
    try {
      list = await fetchJson<NeiList>(siteUrl(DIR + 'list.json'));
    } catch {
      list = null;
    }
    invalidate();
    return list;
  })();
  return listLoading;
}
export const itemList = () => list;

let tooltips: NeiTooltips | null = null;
let tooltipsLoading: Promise<NeiTooltips | null> | null = null;
/** The item list's tooltips, rarities and ore names (tooltips.json), loaded on first use. */
export function loadTooltips(): Promise<NeiTooltips | null> {
  tooltipsLoading ??= (async () => {
    try {
      tooltips = await fetchJson<NeiTooltips>(siteUrl(DIR + 'tooltips.json'));
    } catch {
      tooltips = null;
    }
    invalidate();
    return tooltips;
  })();
  return tooltipsLoading;
}
export const tooltipData = () => tooltips;

// ---------------------------------------------------------------- index lookups

const shards = new Map<number, Promise<NeiIndexShard>>();
function shard(key: string): Promise<NeiIndexShard> {
  const n = shardOf(key);
  let p = shards.get(n);
  if (!p) {
    p = fetchJson<NeiIndexShard>(siteUrl(`${DIR}index/${n}.json`)).catch(() => ({}));
    shards.set(n, p);
  }
  return p;
}
const entry = async (key: string) => (await shard(key))[key];

/** Recipes of one handler shown for a lookup; null = every recipe of the handler (a catalyst). */
export interface HandlerRecipes {
  handler: number;
  recipes: number[] | null;
}

function merge(into: Map<number, Set<number> | null>, list: [number, number[]][] | undefined, gtOnly = false) {
  for (const [h, rs] of list ?? []) {
    if (gtOnly && handlers[h]?.kind !== 'gt') continue;
    if (into.has(h) && into.get(h) === null) continue;
    let set = into.get(h);
    if (!set) into.set(h, (set = new Set()));
    for (const r of rs) set.add(r);
  }
}
function finish(m: Map<number, Set<number> | null>): HandlerRecipes[] {
  return [...m.keys()]
    .sort((a, b) => a - b)
    .map((h) => {
      const set = m.get(h);
      return { handler: h, recipes: set ? [...set].sort((a, b) => a - b) : null };
    })
    .filter((e) => e.recipes === null || e.recipes.length > 0);
}

const baseKey = (key: string) => key.replace(/#.*$/, '');

/**
 * The fluid a stack with NBT holds, for stacks the index does not know by their full key (quest
 * items). Installed by main.ts.
 */
export const nbtFluidOf = { get: (_key: string): string | undefined => undefined };

/**
 * BetterQuesting's tab (handler kind "quest"): its recipes are the quests that give (made) or ask
 * for (used) an item, built from the questbook by quests.ts, which installs these.
 */
export const questTab = {
  made: async (_key: string): Promise<number[]> => [],
  used: async (_key: string): Promise<number[]> => [],
  recipe: (_r: number): NeiRecipe | null => null,
  /** Open a quest (clicking its name), from the recipe screen `from`. */
  open: (_from: unknown, _questId: string): void => {},
};

async function addQuests(m: Map<number, Set<number> | null>, key: string, mode: 'made' | 'used') {
  const h = handlers.findIndex((x) => x.kind === 'quest');
  if (h < 0) return;
  const rs = await questTab[mode](key);
  if (rs.length) m.set(h, new Set(rs));
}

/** Keys whose GregTech recipes (gm) or usages (gu) also show for this one. */
async function related(key: string, e: NeiIndexShard[string] | undefined, kind: 'gm' | 'gu'): Promise<string[]> {
  const out = new Set(e?.[kind] ?? []);
  if (key.includes('#')) {
    // Stacks whose NBT matters to GregTech: data sticks and containers holding their fluid in NBT.
    for (const k of (await entry(key))?.[kind] ?? []) out.add(k);
    const fluid = nbtFluidOf.get(key);
    if (fluid) {
      out.add(`fluid:${fluid}`);
      for (const k of (await entry(`fluid:${fluid}`))?.[kind] ?? []) out.add(k);
    }
  }
  out.delete(baseKey(key));
  return [...out];
}

/**
 * The recipes that make an item ("R" in NEI). GregTech tabs also list the recipes of the items
 * GregTech relates to it (GTNEIDefaultHandler.loadCraftingRecipes): its unified and familiar
 * items, and for a fluid or a filled container the fluid and all its containers.
 */
export async function recipesFor(key: string): Promise<HandlerRecipes[]> {
  if (!(await loadNei())) return [];
  const m = new Map<number, Set<number> | null>();
  const e = await entry(baseKey(key));
  merge(m, e?.m);
  for (const r of await Promise.all((await related(key, e, 'gm')).map(entry))) merge(m, r?.m, true);
  await addQuests(m, key, 'made');
  return finish(m);
}

/**
 * The recipes that use an item ("U" in NEI): as an ingredient, through its ore names, or as a
 * catalyst; GregTech tabs add the usages of related items (GTNEIDefaultHandler.loadUsageRecipes).
 */
export async function usagesFor(key: string): Promise<HandlerRecipes[]> {
  if (!(await loadNei())) return [];
  const base = baseKey(key);
  const m = new Map<number, Set<number> | null>();
  const e = await entry(base);
  for (const h of e?.c ?? []) m.set(h, null);
  merge(m, e?.u);
  for (const r of await Promise.all((await related(key, e, 'gu')).map(entry))) merge(m, r?.u, true);
  const idx = keyIndex.get(base);
  if (idx !== undefined) {
    const ores = oreOf.get(idx) ?? [];
    const entries = await Promise.all(ores.map((o) => entry(`ore:${oreName(o)}`)));
    for (const oe of entries) merge(m, oe?.u);
  }
  await addQuests(m, key, 'used');
  return finish(m);
}

// ---------------------------------------------------------------- recipes

const chunks = new Map<number, NeiRecipeChunk | Promise<NeiRecipeChunk>>();

/** A recipe if its chunk has loaded; otherwise starts loading it and returns null. */
export function recipe(h: number, r: number): NeiRecipe | null {
  const hd = handlers[h];
  if (!hd) return null;
  if (hd.kind === 'quest') return questTab.recipe(r);
  let start = 0;
  for (const [file, count] of hd.chunks) {
    if (r < start + count) {
      const c = chunks.get(file);
      if (c && !(c instanceof Promise)) return c.r[r - start] ?? null;
      if (!c) {
        const p = fetchJson<NeiRecipeChunk>(siteUrl(`${DIR}recipes/${file}.json`));
        chunks.set(file, p);
        p.then((v) => {
          chunks.set(file, v);
          invalidate();
        }).catch(() => chunks.delete(file));
      }
      return null;
    }
    start += count;
  }
  return null;
}

// ---------------------------------------------------------------- slots

export const slotObj = (s: Slot): SlotObj => (typeof s === 'number' ? { i: s } : s);

/** The items a slot cycles through. */
export function slotItems(s: Slot | null | undefined): number[] {
  if (s === null || s === undefined || s === -1) return [];
  if (typeof s === 'number') return [s];
  if (s.i !== undefined) return typeof s.i === 'number' ? [s.i] : s.i;
  if (s.o !== undefined) return oreMembers(s.o);
  return [];
}

let cycleClock = 0;
let cycleLast = -1;
/**
 * The time cycling stacks follow: it stands still while Shift is held, as NEI's recipe widgets
 * stop cycling then (RecipeWidget.tickCycle, TemplateRecipeHandler.onUpdate).
 */
export function cycleTime(now: number): number {
  if (cycleLast >= 0 && now > cycleLast && !heldKeys.shift) cycleClock += now - cycleLast;
  cycleLast = Math.max(cycleLast, now);
  return cycleClock;
}

/** Items a slot was moved on by with Shift + scroll (RecipeWidget.scrollPermutations). */
const slotShift = new WeakMap<object, number>();
export function shiftSlot(s: Slot, d: number) {
  if (typeof s === 'object') slotShift.set(s, (slotShift.get(s) ?? 0) + d);
}

/** NEI cycles every multi-item slot once a second (20 ticks), all in step. */
export function slotItem(s: Slot | null | undefined, now: number): number {
  const list = slotItems(s);
  if (list.length <= 1) return list[0] ?? -1;
  animating();
  const n = Math.floor(cycleTime(now) / 1000) + (typeof s === 'object' && s ? (slotShift.get(s) ?? 0) : 0);
  return list[((n % list.length) + list.length) % list.length];
}

export const slotAmount = (s: Slot | null | undefined) => (s && typeof s === 'object' ? (s.n ?? 1) : 1);

// ---------------------------------------------------------------- names and icons

export function itemName(i: number): string {
  return items?.names[i] ?? '?';
}

export function itemMod(i: number): string | null {
  if (!items) return null;
  const m = items.mods[i];
  return m >= 0 ? (items.modNames[m] ?? null) : null;
}

/**
 * An item's tooltip as NEI shows it (GuiContainerManager.itemDisplayNameMultiline): the name in its
 * rarity colour, the lines the item adds in gray, and the mod name (Waila). The lines come with
 * tooltips.json, which loads on first use.
 */
export function itemTooltipLines(i: number): string[] {
  if (!tooltips) void loadTooltips();
  const rarity = tooltips?.rarity[i];
  const out = [(rarity ? `§${rarity}` : '') + itemName(i)];
  for (const l of tooltips?.lines[i] ?? []) out.push(l.startsWith(TOOLTIP_HANDLER) ? l : `§7${l}§r`);
  const mod = itemMod(i);
  if (mod) out.push(`§9§o${mod}`);
  return out;
}

/** GuiDraw.TOOLTIP_HANDLER: lines starting with it are drawn by code, not as text. */
const TOOLTIP_HANDLER = '\u00a7x';

/** Draw item i into a 16x16 slot at (x, y), with an optional stack-size label. */
export function drawNeiItem(gfx: Gfx, i: number, x: number, y: number, label = '') {
  if (i < 0 || !items) return;
  const key = items.keys[i];
  // Stacks the quest pipeline rendered (animations, lighting, glint) look exactly like in game.
  if (itemInfo(key)?.i) {
    drawItemKey(gfx, key, x, y, 16, label);
    return;
  }
  const cell = items.icons[i];
  if (cell >= 0) {
    const sheet = Math.floor(cell / 256), n = cell % 256;
    const size = items.sheets[sheet];
    const img = image(siteUrl(`${DIR}icons/${sheet}.png`));
    if (img) {
      const cols = img.width / size;
      const sx = (n % cols) * size, sy = Math.floor(n / cols) * size;
      // Icons are a 32-unit canvas with the 16-unit item in the middle.
      gfx.icon(img, sx, sy, size, size, x - 8, y - 8, 32, 32);
    }
  } else drawItemKey(gfx, key, x, y, 16);
  if (label) drawStackLabel(gfx, label, x, y);
}

/** RenderItem.renderItemOverlayIntoGUI's stack size text. */
export function drawStackLabel(gfx: Gfx, label: string, x: number, y: number) {
  drawString(gfx, label, x + 17 - stringWidth(label), y + 9, 0xffffffff, true);
}
