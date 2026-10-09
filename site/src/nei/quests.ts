// BetterQuesting's NEI tab (bq_standard QuestRecipeHandler): R on an item lists the quests that
// reward it, U the quests whose tasks ask for it, one quest per "recipe": the quest's name on top
// (click it to open the quest), the item inputs of its tasks on the left and its item rewards on
// the right, behind a pattern placeholder named after the quest. The site has the questbook, so
// these are built here rather than exported.
//
// As in game (with editing on, which shows every quest):
// - inputs are the stacks of retrieval, optional retrieval and crafting tasks, rewards those of
//   item and choice rewards, at most 16 on each side;
// - a stack with an ore dictionary name stands for every item of that name;
// - an item matches a stack of the same item and damage (or a wildcard damage) with the same NBT
//   (NEIServerUtils.areStacksSameTypeCraftingWithNBT). Quest stacks keep their NBT under another
//   hash than the recipe data, so a looked-up stack with NBT matches quest stacks with NBT by item.

import { book, quest as getQuest } from '../store.ts';
import { tr } from '../gui/lang.ts';
import type { Quest, ItemRef, TaskData } from '../lib/model.ts';
import type { GenericStack, NeiRecipe, Slot } from './model.ts';
import {
  questTab, loadNei, loadTooltips, itemCount, itemKeyAt, itemIndexOf, oreEntries, oreMembers, tooltipData,
} from './data.ts';

const WILDCARD = 32767;
const SLOT = 18;
const GRID = 4;
const INPUT_TYPES = new Set(['bq_standard:retrieval', 'bq_standard:optional_retrieval', 'bq_standard:crafting']);
const OUTPUT_TYPES = new Set(['bq_standard:item', 'bq_standard:choice']);
const PATTERN = 'betterquesting:pattern_placeholder@0';

interface Built {
  recipes: NeiRecipe[];
  /** Base key ("id@meta"), or "id@*" for wildcard stacks, to recipe numbers. */
  made: Map<string, number[]>;
  used: Map<string, number[]>;
  /** The same for stacks with NBT, by base key. */
  madeNbt: Map<string, number[]>;
  usedNbt: Map<string, number[]>;
}

let built: Promise<Built> | null = null;

const taskStacks = (t: TaskData): ItemRef[] => (Array.isArray(t.requiredItems) ? (t.requiredItems as ItemRef[]) : []);
const rewardStacks = (t: TaskData): ItemRef[] =>
  t.type === 'bq_standard:choice' ? ((t.choices as ItemRef[]) ?? []) : ((t.rewards as ItemRef[]) ?? []);

/** Every item of each registry name, for wildcard stacks. */
function byRegistry(): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (let i = 0; i < itemCount(); i++) {
    const k = itemKeyAt(i);
    if (k.includes('#') || k.startsWith('fluid:')) continue;
    const reg = k.replace(/@\d+$/, '');
    const l = out.get(reg);
    if (l) l.push(i);
    else out.set(reg, [i]);
  }
  return out;
}

/** Ore dictionary members by name: the recipe data's, else the item list's (tooltips.json). */
function oreTable(): Map<string, number[]> {
  const out = new Map<string, number[]>();
  oreEntries().forEach(([name], o) => out.set(name, oreMembers(o)));
  const tips = tooltipData();
  if (tips) {
    const extra = new Map<string, number[]>();
    for (const [item, names] of Object.entries(tips.ore)) {
      for (const n of names) {
        const name = tips.ores[n];
        if (out.has(name)) continue;
        const l = extra.get(name);
        if (l) l.push(Number(item));
        else extra.set(name, [Number(item)]);
      }
    }
    for (const [k, v] of extra) out.set(k, v);
  }
  return out;
}

async function build(): Promise<Built> {
  await loadNei();
  await loadTooltips();
  const regs = byRegistry();
  const ores = oreTable();
  const pattern = itemIndexOf(PATTERN);
  const out: Built = { recipes: [], made: new Map(), used: new Map(), madeNbt: new Map(), usedNbt: new Map() };
  const add = (map: Map<string, number[]>, key: string, r: number) => {
    const l = map.get(key);
    if (!l) map.set(key, [r]);
    else if (l[l.length - 1] !== r) l.push(r);
  };

  /** The items a quest stack stands for, and the keys it is found under. */
  const resolve = (ref: ItemRef): { items: number[]; keys: string[] } => {
    if (ref.ore) {
      const items = ores.get(ref.ore) ?? [];
      return { items, keys: items.map((i) => itemKeyAt(i).replace(/#.*$/, '')) };
    }
    if (ref.dmg === WILDCARD) return { items: regs.get(ref.id) ?? [], keys: [`${ref.id}@*`] };
    const base = `${ref.id}@${ref.dmg}`;
    const i = itemIndexOf(ref.k ?? base);
    return { items: i === undefined ? [] : [i], keys: [base] };
  };

  for (const q of Object.values(book.quests) as Quest[]) {
    const inputs: { ref: ItemRef; optional: boolean }[] = [];
    for (const t of q.tasks) if (INPUT_TYPES.has(t.type)) for (const ref of taskStacks(t)) inputs.push({ ref, optional: t.type === 'bq_standard:optional_retrieval' });
    const outputs: { ref: ItemRef; choice: boolean }[] = [];
    for (const t of q.rewards) if (OUTPUT_TYPES.has(t.type)) for (const ref of rewardStacks(t)) outputs.push({ ref, choice: t.type === 'bq_standard:choice' });
    if (!inputs.length && !outputs.length) continue;

    const r = out.recipes.length;
    const ps: GenericStack[] = [];
    const place = (ref: ItemRef, x: number, y: number, role: number, tip?: string) => {
      const { items, keys } = resolve(ref);
      const nbt = !!ref.nbt && !ref.ore;
      for (const k of keys) add(role === 0 ? (nbt ? out.usedNbt : out.used) : nbt ? out.madeNbt : out.made, k, r);
      if (!items.length) return;
      const s: Slot = items.length === 1 && ref.n <= 1 ? items[0] : { i: items.length === 1 ? items[0] : items, ...(ref.n > 1 ? { n: ref.n } : {}) };
      ps.push({ x, y, r: role, s, ...(tip ? { tip: [tip] } : {}) });
    };
    // CachedQuestRecipe.loadTasks: a 4 x 4 grid from (3, 29).
    inputs.slice(0, GRID * GRID).forEach(({ ref, optional }, n) => {
      place(ref, 3 + (n % GRID) * SLOT, 29 + Math.floor(n / GRID) * SLOT, 0, optional ? `§8§o${tr('bq_standard.task.optional_retrieval')}` : undefined);
    });
    // loadRewards: the pattern placeholder named after the quest first, then the rewards, from (93, 29).
    if (pattern !== undefined) ps.push({ x: 93, y: 29, r: 2, s: pattern, name: `§o${q.name}` });
    outputs.slice(0, GRID * GRID - 1).forEach(({ ref, choice }, n) => {
      const k = n + 1;
      place(ref, 93 + (k % GRID) * SLOT, 29 + Math.floor(k / GRID) * SLOT, 2, choice ? `§8§o${tr('bq_standard.reward.choice')}` : undefined);
    });
    out.recipes.push({ ps, q: q.id, qn: q.name });
  }
  return out;
}

let cache: Built | null = null;
const loaded = () =>
  (built ??= build().then((b) => {
    cache = b;
    return b;
  }));

/** The recipe numbers a key is found under: its base key, its registry's wildcard, and NBT stacks. */
function lookup(b: Built, key: string, mode: 'made' | 'used'): number[] {
  const base = key.replace(/#.*$/, '');
  const reg = base.replace(/@\d+$/, '');
  const plain = mode === 'made' ? b.made : b.used;
  const nbt = mode === 'made' ? b.madeNbt : b.usedNbt;
  const set = new Set<number>();
  const from = (m: Map<string, number[]>) => {
    for (const r of m.get(base) ?? []) set.add(r);
    for (const r of m.get(`${reg}@*`) ?? []) set.add(r);
  };
  from(key.includes('#') ? nbt : plain);
  return [...set].sort((a, c) => a - c);
}

/**
 * Install the tab's lookups (called once by main.ts). The quest recipes are built on the first
 * lookup, which every recipe of the tab comes from.
 */
export function installQuestTab() {
  questTab.made = async (key) => lookup(await loaded(), key, 'made');
  questTab.used = async (key) => lookup(await loaded(), key, 'used');
  questTab.recipe = (r) => cache?.recipes[r] ?? null;
}

/** The quest a recipe of the tab stands for. */
export const questOf = (rec: NeiRecipe) => (rec.q ? getQuest(rec.q) : undefined);
