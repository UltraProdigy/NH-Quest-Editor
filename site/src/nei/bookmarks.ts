// NEI's bookmark panel on the left of the screen (GTNH NotEnoughItems: BookmarkPanel, BookmarkGrid,
// BookmarkGridGenerator, BookmarksGridSlot, GroupingItem, BookmarkStorage, ShortcutInputHandler's
// bookmark keys). NEI is LGPL, so this follows its behaviour and numbers, not its code.
//
// What works as in game:
// - A over any item adds it, or removes it when it is bookmarked already; Ctrl + A keeps the
//   amount. In the recipe window the item remembers the recipe it was saved from.
// - Shift + A in the recipe window saves the recipe: the hovered (or first) result and every
//   ingredient with its amount. A over a bookmark removes that item, Shift + A the whole recipe.
// - The 7 px strip left of the grid: drag to make a group or add rows to one, right-drag to take
//   rows out, click to switch a group between grid and list view, Alt + click to collapse it,
//   Shift + drag to move it, Shift + A to delete it. Clicking the page label does the same for the
//   ungrouped bookmarks.
// - Shift + drag moves a bookmark, Ctrl + scroll changes its amount (a recipe's whole recipe).
// - Pages, the namespaces at the bottom ("< 1/2 >"), B and the bookmarks button to hide the panel,
//   the REI-style pop-in, recipe previews in the tooltip of saved recipes (GTNH's
//   recipeTooltipsMode=1: in grid view), holding Shift or Ctrl to see a recipe's parts.
//
// Not here: crafting chain mode (right click on a group) and the crafting tree (T), pulling items
// (V), chat links and favourites. Bookmarks are kept in this browser only.

import { type Gfx, type TipLine, keys as heldKeys } from '../gui/core.ts';
import { texture } from '../gui/assets.ts';
import { animating, invalidate } from '../gui/frame.ts';
import { drawString, stringWidth } from '../gui/font.ts';
import {
  itemIndexOf, itemKeyAt, drawNeiItem, itemTooltipLines, handlerList, recipe as getRecipe, slotItems,
} from './data.ts';
import type { NeiHandler } from './model.ts';
import { Btn, type Rect, inside, neiButton, nineSlice, hotkeyLines, LINESPACE } from './draw.ts';
import { drawRecipeWidget, recipeHeight, formatChance } from './handlers.ts';
import { acceptsFollowing } from './recipeScreen.ts';

const SLOT = 18;
const PADDING = 2;
const BUTTON = 16;
export const GROUP_PANEL_WIDTH = 7;
const CHANCE_FULL = 10000;
/** Integer.MIN_VALUE in GroupingItem: a new group. */
const NEW_GROUP = -2147483648;

const HIGHLIGHT = 0xee555555;
const DRAG_COLOR = 0x66555555;
const GROUP_NONE_COLOR = 0xff666666;
const PLACEHOLDER_COLOR = 0x66222222;
const INGREDIENTS_COLOR = 0x6645da75;
const RESULTS_COLOR = 0x9966ccff;
/** inventory.bookmarks.recipeMarkerColor. */
const MARKER_COLOR = 0xffadadad;

// ---------------------------------------------------------------- data

export type BookmarkType = 'item' | 'ingredient' | 'result';

/** BookmarkItem: what is stored for one bookmark. */
export interface Bookmark {
  /** Item key (NEI item list key). */
  k: string;
  /** Group (0: no group). */
  g: number;
  t: BookmarkType;
  /** Amount per multiplier (the recipe's amount of this item), and the multiplier. */
  f: number;
  m: number;
  /** Chance out of 10000 when the amount is not certain (f is then 1). */
  c?: number;
  /** Recipe: "<handler id>:<recipe number>". */
  r?: string;
  /** The items an ingredient slot accepts (its permutations), when more than one. */
  p?: string[];
}

interface Group {
  /** BookmarkViewMode.TODO_LIST (a row per item or recipe) instead of the grid. */
  todo: boolean;
  collapsed: boolean;
}

interface Space {
  items: Bookmark[];
  groups: Record<number, Group>;
}

interface Store {
  hidden: boolean;
  active: number;
  spaces: Space[];
}

const STORE_KEY = 'nhqe.bookmarks.v1';
const emptySpace = (todo = false): Space => ({ items: [], groups: { 0: { todo, collapsed: false } } });

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Store;
      if (Array.isArray(s.spaces) && s.spaces.length) {
        for (const sp of s.spaces) {
          sp.items = (sp.items ?? []).filter((b) => b && typeof b.k === 'string');
          sp.groups ??= {};
          sp.groups[0] ??= { todo: false, collapsed: false };
        }
        return { hidden: !!s.hidden, active: Math.max(0, Math.min(s.active | 0, s.spaces.length - 1)), spaces: s.spaces };
      }
    }
  } catch {
    // unreadable or blocked storage: start empty
  }
  return { hidden: false, active: 0, spaces: [emptySpace()] };
}

const store = loadStore();
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch {
      // ignore
    }
  }, 200) as unknown as number;
}

const space = () => store.spaces[store.active];
const groupOf = (sp: Space, g: number): Group => (sp.groups[g] ??= { todo: sp.groups[0]?.todo ?? false, collapsed: false });

/** Panel state shared by every screen: page, drags in progress, pop-in animation. */
const ui = {
  page: 0,
  generated: null as Generated | null,
  animation: new WeakMap<Bookmark, number>(),
};

/** Something changed: tidy the order (BookmarkGrid.sortIngredients), lay out again, save. */
function changed() {
  normalize(space());
  ui.generated = null;
  save();
  invalidate();
}

export const bookmarksHidden = () => store.hidden;
export function toggleBookmarks() {
  store.hidden = !store.hidden;
  save();
  invalidate();
}

// ---------------------------------------------------------------- amounts

/** BookmarkItem.getAmount: amount times multiplier, with chance rounded (up for ingredients). */
function amountOf(b: Bookmark, m = b.m): number {
  const a = b.f * m;
  if (b.c === undefined) return a;
  return b.t === 'ingredient' ? Math.ceil((a * b.c) / CHANCE_FULL) : Math.floor((a * b.c) / CHANCE_FULL);
}

/** ReadableNumberConverter.toWideReadableForm, roughly: at most four characters. */
function readable(n: number): string {
  if (n < 10000) return String(n);
  const units = ['K', 'M', 'G', 'T', 'P'];
  let v = n, u = -1;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  const s = v >= 100 ? String(Math.floor(v)) : v >= 10 ? String(Math.floor(v)) : (Math.floor(v * 10) / 10).toString();
  return s + units[u];
}

const isFluid = (k: string) => k.startsWith('fluid:');

// ---------------------------------------------------------------- recipes

const handlerIndexById = new Map<string, number>();
function handlerIndex(id: string): number {
  const list = handlerList();
  if (handlerIndexById.size !== list.length) {
    handlerIndexById.clear();
    list.forEach((h, i) => handlerIndexById.set(h.id, i));
  }
  return handlerIndexById.get(id) ?? -1;
}

/** "<handler id>:<recipe number>" → the handler's index and the recipe number. */
export function parseRecipeId(rid: string): { handler: number; h: NeiHandler; recipe: number; id: string } | null {
  const i = rid.lastIndexOf(':');
  if (i < 0) return null;
  const id = rid.slice(0, i), n = Number(rid.slice(i + 1));
  const hi = handlerIndex(id);
  const h = handlerList()[hi];
  return h && Number.isInteger(n) ? { handler: hi, h, recipe: n, id } : null;
}

export const recipeIdOf = (h: NeiHandler, recipe: number) => `${h.id}:${recipe}`;

/** A stack of a recipe as NEI's Recipe.RecipeIngredient sees it: the shown item, amount, chance, alternatives. */
export interface RecipeStack {
  item: number;
  n: number;
  c?: number;
  perms: number[];
}

// ---------------------------------------------------------------- tidy order (sortIngredients)

/** BookmarkGrid.sortItemsInsideGroup: in list view a recipe's result comes first, then its ingredients. */
function sortItemsInsideGroup(sp: Space, g: number) {
  let i = 0;
  while (i < sp.items.length) {
    const it = sp.items[i];
    if (it.g === g && it.r && sp.items.findIndex((x) => x.g === it.g && x.r === it.r) === i) {
      const same = sp.items.filter((x) => x.g === it.g && x.r === it.r);
      same.sort((a, b) => (a.t === 'ingredient' ? 1 : -1) - (b.t === 'ingredient' ? 1 : -1));
      const rest = sp.items.filter((x) => !same.includes(x));
      rest.splice(i, 0, ...same);
      sp.items = rest;
      i += same.length;
    } else i++;
  }
}

function normalize(sp: Space) {
  // A group's bookmarks stay together, where its first one is.
  for (let i = 0; i < sp.items.length; i++) {
    const it = sp.items[i];
    if (it.g !== 0) {
      const members = sp.items.filter((x) => x.g === it.g);
      const rest = sp.items.filter((x) => x.g !== it.g);
      rest.splice(i, 0, ...members);
      sp.items = rest;
      i += members.length - 1;
    }
  }
  const used = new Set(sp.items.map((b) => b.g));
  for (const key of Object.keys(sp.groups)) if (Number(key) !== 0 && !used.has(Number(key))) delete sp.groups[Number(key)];
  for (const g of [0, ...used]) {
    const group = groupOf(sp, g);
    if (group.todo) sortItemsInsideGroup(sp, g);
    // A recipe needs a result and an ingredient; otherwise its bookmarks become plain items.
    const state = new Map<string, number>();
    for (const it of sp.items) {
      if (!it.r && it.t !== 'item') it.t = 'item';
      else if (it.g === g && it.r && it.t !== 'item') state.set(it.r, (state.get(it.r) ?? 0) | (it.t === 'ingredient' ? 1 : 2));
    }
    for (const it of sp.items) {
      if (it.g === g && it.t !== 'item' && state.get(it.r!) !== 3) {
        if (it.t === 'ingredient') delete it.r;
        it.t = 'item';
      }
    }
  }
}

// ---------------------------------------------------------------- adding and removing

const sameRecipe = (b: Bookmark, rid: string | undefined, g: number) => b.g === g && !!rid && b.r === rid;

function indexOf(sp: Space, g: number, key: string, rid: string | undefined, ingredient: boolean) {
  return sp.items.findIndex((b) => b.g === g && ingredient === (b.t === 'ingredient') && b.r === rid && b.k === key);
}

const existsRecipe = (sp: Space, rid: string | undefined, g: number) =>
  !!rid && sp.items.some((b) => b.t !== 'item' && sameRecipe(b, rid, g));

function addBookmark(b: Bookmark) {
  space().items.push(b);
  ui.animation.set(b, 0);
}

/**
 * The A key over an item outside the bookmark panel (ShortcutInputHandler.saveRecipeInBookmark
 * without Shift, BookmarkPanel.addItem): add it, or remove it if it is there.
 * - In the recipe window `recipe` is the recipe it was hovered in: the item remembers it
 *   (bookmarkItemsWithRecipe, on by default) and its amount is what the recipe makes of it
 *   (`factor`, 0 for an ingredient; `chance` out of 10000 when not certain).
 * - Elsewhere the amount is kept only with Ctrl (`amount`).
 */
export function toggleItem(
  key: string,
  opts: { recipe?: { rid: string; factor: number; chance?: number }; amount?: number; withCount?: boolean } = {},
) {
  const sp = space();
  if (!sp) return;
  const rid = opts.recipe?.rid;
  const i = indexOf(sp, 0, key, rid, false);
  if (i >= 0) {
    removeAt(sp, i, false);
    changed();
    return;
  }
  let b: Bookmark;
  if (opts.recipe) {
    const exists = existsRecipe(sp, rid, 0);
    b = { k: key, g: 0, t: exists ? 'result' : 'item', f: opts.recipe.factor, m: 1, r: rid };
    if (opts.recipe.chance !== undefined) b.c = opts.recipe.chance;
    if (exists) b.m = sp.items.find((x) => sameRecipe(x, rid, 0))?.m ?? 1;
  } else {
    b = { k: key, g: 0, t: 'item', f: 1, m: opts.withCount ? Math.max(0, opts.amount ?? 1) : 0 };
  }
  addBookmark(b);
  changed();
}

/** The amount a recipe's stacks make of one item, as BookmarkItem.builder adds it up. */
export function recipeAmount(stacks: RecipeStack[], item: number): { factor: number; chance?: number } {
  let amount = 0;
  for (const o of stacks) if (o.perms.includes(item)) amount += o.n * (o.c ?? CHANCE_FULL);
  return amount % CHANCE_FULL === 0 ? { factor: amount / CHANCE_FULL } : { factor: 1, chance: amount };
}

/**
 * Shift + A in the recipe window: save the recipe (one result, all ingredients) or, when it is
 * saved already, remove it. With bookmarkRecipeWithCount (on by default) the amounts show.
 */
export function toggleRecipe(rid: string, result: RecipeStack, ingredients: RecipeStack[]) {
  const sp = space();
  if (!sp) return;
  if (sp.items.some((b) => sameRecipe(b, rid, 0))) {
    sp.items = sp.items.filter((b) => !sameRecipe(b, rid, 0));
    changed();
    return;
  }
  // BookmarkItem.builder(groupId, stack, recipe, type): the amount of each distinct item, summed
  // over every stack of the recipe that can be it.
  const build = (stacks: RecipeStack[], t: BookmarkType) => {
    const seen = new Set<string>();
    for (const s of stacks) {
      const k = itemKeyAt(s.item);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const a = recipeAmount(stacks, s.item);
      const b: Bookmark = { k, g: 0, t, f: a.factor, m: 1, r: rid };
      if (a.chance !== undefined) b.c = a.chance;
      const perms = [...new Set(s.perms)];
      if (t === 'ingredient' && perms.length > 1) b.p = perms.map((i) => itemKeyAt(i));
      addBookmark(b);
    }
  };
  build([result], 'result');
  build(ingredients, 'ingredient');
  changed();
}

/** BookmarkGrid.removeRecipe(itemIndex, removeFullRecipe). */
function removeAt(sp: Space, i: number, full: boolean) {
  const it = sp.items[i];
  if (!it) return;
  if (!full && it.r && it.t === 'result') {
    full = !sp.items.some((m) => m !== it && m.t === 'result' && sameRecipe(m, it.r, it.g));
  }
  if (it.r && it.t !== 'item' && full) sp.items = sp.items.filter((b) => !sameRecipe(b, it.r, it.g));
  else sp.items.splice(i, 1);
}

/** Whether an item key is bookmarked (for hotkey hints). */
export function isBookmarked(key: string, rid?: string) {
  const sp = space();
  return !!sp && indexOf(sp, 0, key, rid, false) >= 0;
}

// ---------------------------------------------------------------- the grid (BookmarkGridGenerator)

interface Generated {
  columns: number;
  rows: number;
  slotToItem: Map<number, number>;
  itemToSlot: Map<number, number>;
  rowToGroup: Map<number, number>;
  border: Map<number, string>;
  maxAbs: number;
  pageCount: number;
}

interface GridSlot {
  slot: number;
  item: number;
  b: Bookmark;
  rect: Rect;
  borders: [boolean, boolean, boolean, boolean] | null;
  firstOutput: boolean;
}

function generate(sp: Space, columns: number, rows: number, invalid: boolean[]): Generated {
  const out: Generated = {
    columns, rows, slotToItem: new Map(), itemToSlot: new Map(), rowToGroup: new Map(), border: new Map(), maxAbs: 0, pageCount: 0,
  };
  const maxIndex = rows * columns;
  if (!sp.items.length || maxIndex === 0 || invalid.every((x) => x)) return out;
  const isInvalid = (i: number) => invalid[i % maxIndex];

  const nextSlot = (index: number, prev: Bookmark | null, meta: Bookmark, todo: boolean): number => {
    index = Math.max(0, index);
    for (let j = 0; j < maxIndex; j++) {
      const first = index % columns === 0;
      if (isInvalid(index)) index++;
      // A new group starts on a new line.
      else if (!first && (!prev || prev.g !== meta.g)) index++;
      else if (!todo) return index;
      // In list view the first column holds an item, a result, or an ingredient whose recipe
      // cannot go on beside it; the rest of a recipe follows on the same row.
      else if (
        first &&
        (!meta.r || !prev || prev.g !== meta.g || meta.t !== 'ingredient' || meta.r !== prev.r ||
          (index + 1 < maxIndex && isInvalid((index + 1) % maxIndex)))
      ) return index;
      else if (!first && meta.t !== 'item' && prev!.t !== 'item' && meta.g === prev!.g && !!meta.r && meta.r === prev!.r) return index;
      else index++;
    }
    return -1;
  };

  let prev: Bookmark | null = null;
  let abs = -2;
  let i = 0;
  const size = sp.items.length;
  while (i < size && abs !== -1) {
    const b = sp.items[i];
    const group = groupOf(sp, b.g);
    if (group.collapsed) {
      // A collapsed group shows its results (and plain items) on one row.
      const results: number[] = [];
      for (let n = i; n < size && sp.items[n].g === b.g; n++) if (sp.items[n].t !== 'ingredient') results.push(n);
      for (let n = 0; n < results.length; n++) {
        const it = sp.items[results[n]];
        const next = nextSlot(abs + 1, prev, it, false);
        if (next === -1 || (n > 0 && next % columns === 0)) break;
        prev = it;
        abs = next;
        out.slotToItem.set(abs, results[n]);
        out.itemToSlot.set(results[n], abs);
        out.border.set(abs, `group:${b.g}`);
      }
      while (i < size && sp.items[i].g === b.g) i++;
    } else {
      abs = nextSlot(abs + 1, prev, b, group.todo);
      if (abs !== -1) {
        prev = b;
        out.slotToItem.set(abs, i);
        out.itemToSlot.set(i, abs);
        i++;
      }
    }
  }
  out.maxAbs = Math.max(-1, ...out.slotToItem.keys()) + 1;

  // generateGroups: each row's group, gaps (rows of hidden slots) inside a group filled in.
  let prevGroup = 0;
  for (let a = 0; a < out.maxAbs; a++) {
    const row = Math.floor(a / columns);
    if ((out.rowToGroup.get(row) ?? 0) === 0) {
      const g = out.slotToItem.has(a) ? sp.items[out.slotToItem.get(a)!].g : 0;
      out.rowToGroup.set(row, g);
      if (g !== 0) {
        const same = prevGroup === g;
        prevGroup = g;
        if (same) for (let r = row - 1; r >= 0 && out.rowToGroup.get(r) === 0; r--) out.rowToGroup.set(r, g);
      }
    }
  }
  out.pageCount = Math.ceil(out.maxAbs / maxIndex);
  return out;
}

// ---------------------------------------------------------------- dragging

interface PointEntry { cursor: number; top: number; bottom: number }

interface Grouping {
  groupId: number;
  start: PointEntry;
  end: PointEntry | null;
  startTime: number;
}

interface SortableGroup { groupId: number; shiftX: number; shiftY: number }

interface SortableItem { item: Bookmark; recipe: Bookmark[] }

const drag = {
  grouping: null as Grouping | null,
  sortGroup: null as SortableGroup | null,
  sortItem: null as SortableItem | null,
  downSlot: -1,
  downButton: -1,
  downTime: 0,
  downAt: [0, 0] as [number, number],
};

const editing = () => !!drag.sortItem || !!drag.sortGroup || !!drag.grouping?.end;

// ---------------------------------------------------------------- the panel

export class BookmarkPanel {
  panel: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private marginLeft = 0;
  private marginTop = 0;
  private paddingLeft = 0;
  private columns = 0;
  private rows = 0;
  private invalid: boolean[] = [];
  private perPage = 0;
  private prev: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private next: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private label: [number, number] = [0, 0];
  private nsPrev: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private nsNext: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private nsLabel: [number, number, boolean] = [0, 0, true];
  private layoutKey = '';

  constructor(private open: (key: string, mode: 'recipe' | 'usage', rid?: string) => void) {}

  /** BookmarkPanel.calculateBounds, resizeHeader and resizeFooter, and the grid's hidden slots. */
  layout(W: number, H: number, guiW: number, blocked: Rect[], bookmarksButton: Rect) {
    const maxWidth = Math.trunc((W - 176) / 2) - PADDING * 2;
    const maxHeight = H - PADDING * 2;
    const freeSpace = Math.trunc((W - guiW) / 2) - PADDING * 2;
    const width = Math.max(SLOT, Math.trunc((Math.min(freeSpace, maxWidth) - GROUP_PANEL_WIDTH) / SLOT) * SLOT) + GROUP_PANEL_WIDTH;
    const height = Math.max(SLOT, maxHeight);
    const p = (this.panel = { x: PADDING, y: PADDING, w: width, h: height });

    // Header: the page buttons, moved in past slots the GUI hides at the top.
    const hidden = (r: Rect) => blocked.some((b) => intersects(b, r));
    let padL = 0, padR = 0;
    while (padL < p.w && hidden({ x: p.x + padL, y: p.y, w: SLOT, h: SLOT })) padL += SLOT;
    while (padR < p.w && hidden({ x: p.x + p.w - padR - SLOT, y: p.y, w: SLOT, h: SLOT })) padR += SLOT;
    let header = 0;
    if (padL + padR < p.w) {
      this.prev = { x: p.x + padL, y: p.y, w: BUTTON, h: BUTTON };
      this.next = { x: p.x + p.w - BUTTON - padR, y: p.y, w: BUTTON, h: BUTTON };
      this.label = [p.x + padL + Math.trunc((p.w - padL - padR) / 2), p.y + 5];
      header = BUTTON + 2;
    }

    // Footer: the namespace buttons, centred right of the bookmarks button when beside it.
    const left = p.y + p.h > bookmarksButton.y ? bookmarksButton.x + bookmarksButton.w + 2 : p.x;
    const right = p.x + p.w;
    const center = left + Math.max(0, Math.trunc((right - left) / 2));
    const wide = right - left >= 70;
    const labelWidth = wide ? 36 : 18;
    const y = p.y + p.h - BUTTON;
    this.nsPrev = { x: center - Math.trunc(labelWidth / 2) - 2 - BUTTON, y, w: BUTTON, h: BUTTON };
    this.nsNext = { x: center + Math.trunc(labelWidth / 2) + 2, y, w: BUTTON, h: BUTTON };
    this.nsLabel = [center, y + 5, wide];
    const footer = BUTTON + 2;

    // The grid, right of the group strip.
    const gw = Math.max(0, p.w - GROUP_PANEL_WIDTH), gh = Math.max(0, p.h - header - footer);
    this.marginLeft = p.x + GROUP_PANEL_WIDTH;
    this.marginTop = p.y + header;
    this.columns = Math.trunc(gw / SLOT);
    this.rows = Math.trunc(gh / SLOT);
    this.paddingLeft = Math.trunc((gw % SLOT) / 2);
    this.invalid = [];
    this.perPage = 0;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.columns; c++) {
        const bad = hidden(this.slotRect(r * this.columns + c));
        this.invalid[r * this.columns + c] = bad;
        if (!bad) this.perPage++;
      }
    }
    const key = `${this.columns}x${this.rows}:${this.invalid.map((b) => (b ? 1 : 0)).join('')}`;
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      ui.generated = null;
    }
  }

  private slotRect(slot: number): Rect {
    const c = slot % this.columns, r = Math.floor(slot / this.columns);
    return { x: this.marginLeft + this.paddingLeft + c * SLOT, y: this.marginTop + r * SLOT, w: SLOT, h: SLOT };
  }

  private gen(): Generated {
    const g = ui.generated;
    if (g && g.columns === this.columns && g.rows === this.rows) return g;
    normalize(space());
    ui.generated = generate(space(), this.columns, this.rows, this.invalid);
    return ui.generated;
  }

  private get visible() {
    return !store.hidden && this.perPage > 0;
  }

  private numPages() {
    return this.gen().pageCount;
  }

  private page() {
    const n = this.numPages();
    ui.page = Math.max(0, Math.min(ui.page, n - 1));
    return ui.page;
  }

  /** The bookmarks on the current page. */
  private mask(): GridSlot[] {
    if (!this.visible) return [];
    const g = this.gen();
    const sp = space();
    const per = this.rows * this.columns;
    const page = this.page();
    const out: GridSlot[] = [];
    const shift = page * per;
    for (let a = shift; a < Math.min(g.maxAbs, shift + per); a++) {
      const i = g.slotToItem.get(a);
      if (i === undefined) continue;
      const b = sp.items[i];
      const slot = a - shift;
      const prevItem = sp.items[g.slotToItem.get(a - 1) ?? -1];
      const group = groupOf(sp, b.g);
      const firstOutput =
        b.t === 'result' && (slot % this.columns === 0 || !group.todo) &&
        (!prevItem || prevItem.t === 'ingredient' || !(prevItem.g === b.g && prevItem.r === b.r));
      let borders: GridSlot['borders'] = null;
      const id = g.border.get(a);
      if (id) {
        const c = slot % this.columns;
        borders = [
          c === 0 || g.border.get(a - 1) !== id,
          g.border.get(a - this.columns) !== id,
          c + 1 === this.columns || g.border.get(a + 1) !== id,
          g.border.get(a + this.columns) !== id,
        ];
      }
      out.push({ slot, item: i, b, rect: this.slotRect(slot), borders, firstOutput });
    }
    return out;
  }

  private lastRowIndex(): number {
    const m = this.mask();
    return this.columns > 0 && m.length ? Math.ceil((m[m.length - 1].slot + 1) / this.columns) - 1 : 0;
  }

  private rowIndex(my: number) {
    return Math.floor((my - this.marginTop) / SLOT);
  }

  /** The group of a row on this page (BookmarkGridGenerator.getRowGroupId). */
  private rowGroup(row: number, groups = this.gen().rowToGroup) {
    return groups.get(row + this.page() * this.rows) ?? 0;
  }

  /** BookmarkGrid.getHoveredRowIndex: the row under the mouse in the group strip (or the grid). */
  private hoveredRow(mx: number, my: number, groupPanel: boolean): number {
    if (!this.visible || !space().items.length) return -1;
    const left = this.marginLeft + this.paddingLeft;
    const r = this.rowIndex(my);
    const area = { x: left - (groupPanel ? GROUP_PANEL_WIDTH : 0), y: this.marginTop, w: this.columns * SLOT, h: (this.lastRowIndex() + 1) * SLOT };
    if (!inside(area, mx, my)) return -1;
    if (groupPanel && mx >= left - GROUP_PANEL_WIDTH && mx < left) return r;
    const c = Math.floor((mx - left) / SLOT);
    if (!groupPanel && c >= 0 && c < this.columns && !this.invalid[this.columns * r + c]) return r;
    return -1;
  }

  /** The area between the page buttons (the "page label"), which stands for the ungrouped bookmarks. */
  private labelArea(): Rect {
    return { x: this.prev.x + this.prev.w, y: this.prev.y, w: this.next.x - (this.prev.x + this.prev.w), h: this.prev.h };
  }

  private gridContains(mx: number, my: number) {
    const r = { x: this.marginLeft + this.paddingLeft, y: this.marginTop, w: this.columns * SLOT, h: this.rows * SLOT };
    if (!inside(r, mx, my)) return false;
    const c = Math.floor((mx - r.x) / SLOT), row = Math.floor((my - r.y) / SLOT);
    return !this.invalid[row * this.columns + c];
  }

  slotAt(mx: number, my: number): GridSlot | null {
    if (!this.visible || !this.gridContains(mx, my)) return null;
    const c = Math.floor((mx - this.marginLeft - this.paddingLeft) / SLOT), r = this.rowIndex(my);
    const slot = r * this.columns + c;
    return this.mask().find((s) => s.slot === slot) ?? null;
  }

  /** The bookmarked item under the mouse (for R and U). */
  hoveredItem(mx: number, my: number): { key: string; rid?: string } | null {
    const s = this.slotAt(mx, my);
    if (!s) return null;
    return { key: s.b.k, rid: s.b.t !== 'ingredient' ? s.b.r : undefined };
  }

  /** BookmarkPanel.contains: the grid, the group strip rows and the page label. */
  contains(mx: number, my: number) {
    if (!this.visible) return false;
    if (space().items.length && inside(this.labelArea(), mx, my)) return true;
    if (this.hoveredRow(mx, my, true) !== -1) return true;
    if (this.showsNamespaces() && (inside(this.nsPrev, mx, my) || inside(this.nsNext, mx, my))) return true;
    return this.gridContains(mx, my) && !!space().items.length;
  }

  // ---------------------------------------------------------------- namespaces (BookmarkStorage)

  private namespaceCount() {
    const s = store.spaces;
    if (s[s.length - 1].items.length > 0) s.push(emptySpace(s[s.length - 1].groups[0]?.todo));
    else if (store.active === s.length - 2 && space().items.length === 0) s.pop();
    return s.length;
  }

  private removeEmptyNamespace(): boolean {
    if (store.active !== store.spaces.length - 1 && space().items.length === 0) {
      store.spaces.splice(store.active, 1);
      store.active = Math.min(store.active, store.spaces.length - 1);
      return true;
    }
    return false;
  }

  private setNamespace(i: number) {
    store.active = Math.max(0, Math.min(i, store.spaces.length - 1));
    if (!space().items.length && store.active > 0) space().groups[0].todo = !!store.spaces[store.active - 1].groups[0]?.todo;
    ui.page = 0;
    ui.generated = null;
    save();
    invalidate();
  }

  private prevNamespace() {
    this.namespaceCount();
    this.removeEmptyNamespace();
    this.setNamespace(store.active === 0 ? this.namespaceCount() - 1 : store.active - 1);
  }

  private nextNamespace() {
    if (this.removeEmptyNamespace()) return this.setNamespace(store.active);
    this.setNamespace(store.active === this.namespaceCount() - 1 ? 0 : store.active + 1);
  }

  private showsNamespaces() {
    return this.visible && !(store.spaces.length <= 1 && !space().items.length);
  }

  // ---------------------------------------------------------------- drawing

  draw(gfx: Gfx, mx: number, my: number) {
    if (!this.visible) return;
    this.dragged(mx, my);
    const sp = space();
    const empty = !sp.items.length;

    if (!empty) {
      const pages = this.numPages();
      neiButton(gfx, this.prev, pages <= 1 ? Btn.DISABLED : inside(this.prev, mx, my) ? Btn.HOVER : Btn.NORMAL, '<');
      neiButton(gfx, this.next, pages <= 1 ? Btn.DISABLED : inside(this.next, mx, my) ? Btn.HOVER : Btn.NORMAL, '>');
      const label = `${this.page() + 1}/${Math.max(1, pages)}`;
      drawString(gfx, label, this.label[0] - Math.trunc(stringWidth(label) / 2), this.label[1], 0xffffffff, true);
    }
    if (this.showsNamespaces()) {
      const n = this.namespaceCount();
      neiButton(gfx, this.nsPrev, inside(this.nsPrev, mx, my) ? Btn.HOVER : Btn.NORMAL, '<');
      neiButton(gfx, this.nsNext, inside(this.nsNext, mx, my) ? Btn.HOVER : Btn.NORMAL, '>');
      const t = this.nsLabel[2] ? `${store.active + 1}/${n}` : `${store.active + 1}`;
      drawString(gfx, t, this.nsLabel[0] - Math.trunc(stringWidth(t) / 2), this.nsLabel[1], 0xffffffff, true);
    }
    if (empty) return;

    this.drawGroupPanel(gfx, mx, my);

    const mask = this.mask();
    const ctx = this.mouseContext(mx, my, mask);
    for (const s of mask) this.beforeDraw(gfx, s, ctx);
    for (const s of mask) if (s.borders) drawBorders(gfx, s.rect, s.borders, GROUP_NONE_COLOR);
    let popping = false;
    for (const s of mask) {
      const i = itemIndexOf(s.b.k);
      const scale = ui.animation.get(s.b);
      if (scale !== undefined && scale < 1) {
        popping = true;
        const k = Math.min(1, scale + 0.1);
        ui.animation.set(s.b, k);
        gfx.push();
        gfx.translate(s.rect.x + 9, s.rect.y + 9);
        gfx.scale(k);
        if (i !== undefined) drawNeiItem(gfx, i, -8, -8);
        gfx.pop();
      } else if (i !== undefined) drawNeiItem(gfx, i, s.rect.x + 1, s.rect.y + 1);
      this.afterDraw(gfx, s, ctx);
    }
    if (popping) animating();

    // A bookmark being moved follows the mouse.
    if (drag.sortItem) {
      const i = itemIndexOf(drag.sortItem.item.k);
      if (i !== undefined) drawNeiItem(gfx, i, mx - 8, my - 8);
    }
  }

  /** BookmarkGrid.draw's group strip: the hovered row, group brackets, and faint lines for the rest. */
  private drawGroupPanel(gfx: Gfx, mx: number, my: number) {
    const g = this.gen();
    if (!g.maxAbs) return;
    const sortId = drag.sortGroup ? drag.sortGroup.groupId : -3;
    const rowShift = this.page() * this.rows;
    let groups = g.rowToGroup;
    const left = this.marginLeft + this.paddingLeft;
    if (drag.grouping?.end) groups = prepareGroups(drag.grouping, groups);
    else if (sortId !== -3) {
      for (let r = 0; r < this.rows; r++) {
        if ((groups.get(rowShift + r) ?? 0) === sortId) gfx.fill(left - GROUP_PANEL_WIDTH, this.marginTop + r * SLOT, GROUP_PANEL_WIDTH, SLOT, DRAG_COLOR);
      }
    } else if (!editing()) {
      const r = this.hoveredRow(mx, my, true);
      if (r !== -1) gfx.fill(left - GROUP_PANEL_WIDTH, this.marginTop + r * SLOT, GROUP_PANEL_WIDTH, SLOT, HIGHLIGHT);
    }
    const prevPageGroup = groups.get(rowShift - 1) ?? 0;
    const nextPageGroup = groups.get(rowShift + this.rows) ?? 0;
    let prevGroup = 0;
    let start = -2;
    if (prevPageGroup === groups.get(rowShift)) {
      prevGroup = prevPageGroup;
      start = -1;
    }
    let r = 0;
    for (; r < this.rows && groups.has(rowShift + r); r++) {
      const id = groups.get(rowShift + r)!;
      if (start !== -2 && prevGroup !== id) {
        if (prevGroup !== 0 && prevGroup !== sortId) this.drawGroup(gfx, start, r - 1);
        else this.drawShadowGroup(gfx, start, r - 1);
        start = -2;
      }
      if (start === -2) start = r;
      prevGroup = id;
    }
    if (start !== -2) {
      const end = nextPageGroup !== 0 && nextPageGroup === groups.get(rowShift + this.rows - 1) ? this.rows : this.lastRowIndex();
      if (prevGroup !== 0 && prevGroup !== sortId) this.drawGroup(gfx, start, end);
      else this.drawShadowGroup(gfx, start, end);
    }
  }

  private drawGroup(gfx: Gfx, start: number, end: number) {
    const half = Math.trunc(GROUP_PANEL_WIDTH / 2);
    const pad = Math.trunc(SLOT / 4);
    const x = this.marginLeft + this.paddingLeft - half - 1;
    let height = (Math.min(end, this.rows - 1) - Math.max(0, start) + 1) * SLOT;
    let top = this.marginTop + Math.max(0, start) * SLOT;
    if (start >= 0) {
      gfx.fill(x, this.marginTop + start * SLOT + pad, half, 1, GROUP_NONE_COLOR);
      top += pad + 1;
      height -= pad + 1;
    }
    if (end < this.rows) {
      gfx.fill(x, this.marginTop + (end + 1) * SLOT - pad, half, 1, GROUP_NONE_COLOR);
      height -= pad;
    }
    gfx.fill(x, top, 1, height, GROUP_NONE_COLOR);
  }

  private drawShadowGroup(gfx: Gfx, start: number, end: number) {
    const top = this.marginTop + Math.max(0, start) * SLOT;
    const height = (Math.min(end, this.rows - 1) - Math.max(0, start) + 1) * SLOT;
    gfx.fill(this.marginLeft + this.paddingLeft - Math.trunc(GROUP_PANEL_WIDTH / 2) - 1, top + 2, 1, height - 4, PLACEHOLDER_COLOR);
  }

  /** BookmarkMouseContext: what the mouse is over, and which modifier keys are held. */
  private mouseContext(mx: number, my: number, mask: GridSlot[]) {
    if (editing() || !this.gridContains(mx, my)) {
      const row = this.hoveredRow(mx, my, false);
      if (editing() || row === -1) return null;
      // Over an empty part of a row: that row's group and recipe.
      const g = this.gen();
      let item = -1;
      const base = (this.page() * this.rows + row) * this.columns + this.columns - 1;
      for (let n = 0; n < this.columns; n++) {
        const i = g.slotToItem.get(base - n);
        if (i !== undefined) {
          item = i;
          break;
        }
      }
      if (item < 0) return null;
      const b = space().items[item];
      return { slot: -1, row, group: this.rowGroup(row), rid: groupOf(space(), b.g).collapsed ? undefined : b.r };
    }
    const s = mask.find((m) => inside(m.rect, mx, my));
    if (!s) return null;
    return { slot: s.slot, row: Math.floor(s.slot / this.columns), group: s.b.g, rid: s.b.r };
  }

  /** BookmarksGridSlot.beforeDraw: Shift or Ctrl colour a recipe's parts; otherwise the hover highlight. */
  private beforeDraw(gfx: Gfx, s: GridSlot, ctx: ReturnType<BookmarkPanel['mouseContext']>) {
    const shown = this.shownType(s, ctx);
    if (shown) {
      gfx.fill(s.rect.x, s.rect.y, SLOT, SLOT, s.b.t === 'ingredient' ? INGREDIENTS_COLOR : RESULTS_COLOR);
      return;
    }
    if (ctx && ctx.slot === s.slot) gfx.fill(s.rect.x, s.rect.y, SLOT, SLOT, HIGHLIGHT);
  }

  /** showShiftItem / showRealItem: which bookmarks light up while Shift or Ctrl is held. */
  private shownType(s: GridSlot, ctx: ReturnType<BookmarkPanel['mouseContext']>): 'shift' | 'real' | null {
    if (!ctx || s.b.g !== ctx.group) return null;
    const group = groupOf(space(), s.b.g);
    const row = Math.floor(s.slot / this.columns);
    if (heldKeys.shift) {
      if (s.slot === ctx.slot) return 'shift';
      if (s.b.t === 'item' && group.todo && ctx.row === row) return 'shift';
      if (s.b.t !== 'item' && !!ctx.rid && s.b.r === ctx.rid) return 'shift';
    }
    if (heldKeys.ctrl) {
      if (s.slot === ctx.slot || group.collapsed) return 'real';
      if (!ctx.rid && group.todo && ctx.row === row) return 'real';
      if (s.b.t !== 'item' && !!ctx.rid && s.b.r === ctx.rid) return 'real';
    }
    return null;
  }

  /** BookmarksGridSlot.afterDraw: the amount, a recipe's multiplier and its handler's icon. */
  private afterDraw(gfx: Gfx, s: GridSlot, ctx: ReturnType<BookmarkPanel['mouseContext']>) {
    const b = s.b;
    const shown = this.shownType(s, ctx);
    const amount = amountOf(b);
    const fluid = isFluid(b.k);
    if (amount > 0 || (b.c !== undefined && b.m > 0) || (shown === 'real' && b.f !== 0)) {
      let text = readable(amount);
      let color = 0xffffffff;
      if (fluid) text += 'L';
      if (b.c !== undefined) {
        text = '~' + text;
        color = 0xffffaa00;
      }
      overlayText(gfx, text, s.rect, color, fluid ? 'bl' : 'br');
    }
    if (b.t === 'ingredient' || !b.r) return;
    if (s.firstOutput) {
      if (shown) overlayText(gfx, `x${readable(b.m)}`, s.rect, 0xffffffff, 'tl');
      else if (b.m > 1) overlayText(gfx, `x${readable(b.m)}`, s.rect, MARKER_COLOR, 'tl');
      // showRecipeHandlerIcon: the recipe's tab icon, small, at the top right.
      const ref = parseRecipeId(b.r);
      const icon = ref?.h.icon !== undefined ? slotItems(ref.h.icon)[0] : undefined;
      if (icon !== undefined && icon >= 0) {
        const k = 0.4;
        gfx.push();
        gfx.translate(s.rect.x + 2 + 16 - 16 * k, s.rect.y);
        gfx.scale(k);
        drawNeiItem(gfx, icon, 0, 0);
        gfx.pop();
      }
    }
  }

  // ---------------------------------------------------------------- input

  /** Called every frame: carries on a drag (PanelWidget.mouseDragged, BookmarkPanel.mouseDragged). */
  private dragged(mx: number, my: number) {
    const held = performance.now() - drag.downTime;
    if (drag.grouping) {
      const over = this.rowIndex(my);
      if (drag.grouping.end || over + this.page() * this.rows !== drag.grouping.start.cursor || held > 250) {
        this.setEndPoint(Math.max(0, Math.min(over, this.lastRowIndex())));
      }
      animating();
      return;
    }
    if (drag.sortGroup) {
      const over = this.rowIndex(my);
      if (over >= 0 && over < this.rows && drag.sortGroup.groupId !== this.rowGroup(over)) this.moveGroup(drag.sortGroup.groupId, over);
      animating();
      return;
    }
    if (drag.sortItem) {
      const s = this.slotAt(mx, my);
      if (s && s.b !== drag.sortItem.item && !drag.sortItem.recipe.includes(s.b)) this.moveItem(drag.sortItem, s);
      animating();
      return;
    }
    if (drag.downSlot >= 0 && drag.downButton === 0 && heldKeys.shift) {
      const over = this.slotAt(mx, my);
      if (!over || over.slot !== drag.downSlot || held > 250) {
        const s = this.mask().find((m) => m.slot === drag.downSlot);
        if (s) {
          const recipe = s.b.r && s.b.t === 'result' ? space().items.filter((x) => sameRecipe(x, s.b.r, s.b.g)) : [s.b];
          drag.sortItem = { item: s.b, recipe };
          drag.downSlot = -1;
        }
      }
      animating();
    }
  }

  mouseDown(mx: number, my: number, b: number): boolean {
    if (!this.visible) return false;
    drag.downTime = performance.now();
    drag.downAt = [mx, my];
    const sp = space();
    if (this.showsNamespaces() && b === 0 && !editing()) {
      if (inside(this.nsPrev, mx, my)) return this.prevNamespace(), true;
      if (inside(this.nsNext, mx, my)) return this.nextNamespace(), true;
    }
    if (!sp.items.length) return false;
    const pages = this.numPages();
    if (inside(this.prev, mx, my)) return this.turn(b === 1 ? -this.page() : -1, pages), true;
    if (inside(this.next, mx, my)) return this.turn(b === 1 ? pages - 1 - this.page() : 1, pages), true;

    // Shift + drag in the group strip moves a group.
    if (b === 0 && heldKeys.shift) {
      const row = this.hoveredRow(mx, my, true);
      const g = row !== -1 ? this.rowGroup(row) : 0;
      if (g !== 0) {
        drag.sortGroup = { groupId: g, shiftX: 0, shiftY: 0 };
        return true;
      }
    }
    // A press in the group strip starts making a group (left) or taking rows out (right).
    if (!heldKeys.shift && (b === 0 || b === 1)) {
      const row = this.hoveredRow(mx, my, true);
      if (row !== -1) {
        let g = this.rowGroup(row);
        if (b === 1) g = 0;
        else if (g === 0) g = NEW_GROUP;
        drag.grouping = this.startGrouping(g, row);
        if (drag.grouping.start.top === -1 || drag.grouping.start.bottom === -1) drag.grouping = null;
        drag.downButton = b;
        return true;
      }
    }
    // The page label stands for the ungrouped bookmarks.
    if (inside(this.labelArea(), mx, my)) {
      const group = groupOf(sp, 0);
      if (heldKeys.alt && b === 0) group.collapsed = !group.collapsed;
      else if (b === 0) group.todo = !group.todo;
      changed();
      return true;
    }
    const s = this.slotAt(mx, my);
    if (s) {
      // Alt + click opens a collapsed group.
      if (b === 0 && heldKeys.alt) {
        const group = groupOf(sp, s.b.g);
        if (group.collapsed) {
          group.collapsed = false;
          changed();
        }
        return true;
      }
      drag.downSlot = s.slot;
      drag.downButton = b;
      return true;
    }
    return this.contains(mx, my);
  }

  mouseUp(mx: number, my: number, b: number): boolean {
    if (!this.visible) return false;
    let used = false;
    if (drag.sortItem || drag.sortGroup) {
      changed();
      used = true;
    } else if (drag.grouping?.end) {
      this.createGroup(drag.grouping);
      used = true;
    } else if (drag.grouping) {
      // A click in the group strip: grid or list view, Alt to collapse.
      const row = this.hoveredRow(mx, my, true);
      const g = row !== -1 ? this.rowGroup(row) : 0;
      if (g !== 0) {
        const group = groupOf(space(), g);
        if (b === 0 && heldKeys.alt) group.collapsed = !group.collapsed;
        else if (b === 0) group.todo = !group.todo;
        changed();
      }
      used = true;
    } else if (drag.downSlot >= 0 && drag.downButton === b) {
      const s = this.slotAt(mx, my);
      if (s && s.slot === drag.downSlot && (b === 0 || b === 1)) {
        this.open(s.b.k, b === 0 ? 'recipe' : 'usage', s.b.t !== 'ingredient' ? s.b.r : undefined);
        used = true;
      }
    }
    drag.sortItem = null;
    drag.sortGroup = null;
    drag.grouping = null;
    drag.downSlot = -1;
    drag.downButton = -1;
    return used;
  }

  private turn(d: number, pages: number) {
    if (pages <= 0) return;
    ui.page = (((this.page() + d) % pages) + pages) % pages;
    invalidate();
  }

  /** The wheel: namespaces over their buttons, Ctrl to change amounts, otherwise pages. */
  scroll(mx: number, my: number, d: number): boolean {
    if (!this.visible) return false;
    const shift = -d;
    const ns = { x: this.nsPrev.x, y: this.nsPrev.y, w: this.nsNext.x + this.nsNext.w - this.nsPrev.x, h: this.nsPrev.h };
    if ((!editing() || drag.sortGroup) && this.showsNamespaces() && inside(ns, mx, my)) {
      if (shift > 0) this.prevNamespace();
      else this.nextNamespace();
      return true;
    }
    if (!this.contains(mx, my)) return false;
    if (!editing() && heldKeys.ctrl) {
      const s = this.slotAt(mx, my);
      if (s) {
        this.shiftItemAmount(s.b, shift);
        return true;
      }
      const g = this.hoveredGroupId(mx, my);
      if (g !== -1) {
        this.shiftGroupAmount(g, shift * (heldKeys.alt ? 64 : 1));
        return true;
      }
    }
    this.turn(-shift, this.numPages());
    return true;
  }

  /** BookmarkPanel.getHoveredGroupId(true): a group strip row's group, or 0 over the page label. */
  private hoveredGroupId(mx: number, my: number): number {
    const row = this.hoveredRow(mx, my, true);
    if (row === -1 && space().items.length && inside(this.labelArea(), mx, my)) return 0;
    if (row >= 0) {
      const g = this.rowGroup(row);
      return g === 0 ? -1 : g;
    }
    return -1;
  }

  /** Keys over the panel: A and Shift + A remove, Page Up/Down turn pages. */
  key(e: KeyboardEvent, mx: number, my: number): boolean {
    if (!this.visible || e.ctrlKey || e.metaKey || e.altKey) return false;
    const k = e.key.toLowerCase();
    if (k === 'a') {
      // Shift + A over the group strip (or the page label) deletes that group.
      const g = this.hoveredGroupId(mx, my);
      if (g !== -1 && e.shiftKey) {
        space().items = space().items.filter((b) => b.g !== g);
        if (g !== 0) delete space().groups[g];
        changed();
        return true;
      }
      const s = this.slotAt(mx, my);
      if (s) {
        // BookmarkPanel.removeSlot: a collapsed group goes whole with Shift + A only.
        const group = groupOf(space(), s.b.g);
        if (group.collapsed) {
          if (e.shiftKey) space().items = space().items.filter((b) => b.g !== s.b.g);
        } else removeAt(space(), s.item, e.shiftKey);
        changed();
        return true;
      }
    }
    if (this.contains(mx, my)) {
      if (e.key === 'PageDown') return this.turn(1, this.numPages()), true;
      if (e.key === 'PageUp') return this.turn(-1, this.numPages()), true;
    }
    return false;
  }

  // ---------------------------------------------------------------- tooltips

  tooltip(mx: number, my: number): (string | TipLine)[] | null {
    if (!this.visible || !space().items.length) return null;
    const s = this.slotAt(mx, my);
    if (s) {
      const i = itemIndexOf(s.b.k);
      const lines: (string | TipLine)[] = i !== undefined ? itemTooltipLines(i) : [s.b.k];
      if (s.b.c !== undefined) {
        lines.splice(1, 0, `§7${s.b.t === 'ingredient' ? 'Consume' : 'Output'} Chance: ${formatChance(s.b.c)}`);
      }
      const group = groupOf(space(), s.b.g);
      const perms = s.b.t === 'ingredient' && s.b.r && s.b.p && s.b.p.length > 1
        ? s.b.p.map((k) => itemIndexOf(k)).filter((n): n is number => n !== undefined)
        : [];
      if (perms.length > 1 && i !== undefined) lines.push(acceptsFollowing(perms, i));
      // RecipeItemInputHandler with recipeTooltipsMode 1: a saved recipe's preview, in grid view.
      if (s.b.r && s.b.t !== 'ingredient' && !group.todo) {
        const tip = recipeTip(s.b.r);
        if (tip) lines.push(tip);
      }
      const extra: [string, string][] = [
        ['CTRL + Scroll', 'Change Quantity'],
        ['CTRL + ALT + Scroll', 'Change Quantity with Multiplier'],
        ['SHIFT + LMB + Drag', 'Move Position'],
      ];
      if (group.collapsed) extra.push(['ALT + LMB', 'Toggle Collapse/Expand'], ['SHIFT + A', 'Remove Group']);
      else if (!s.b.r || s.b.t === 'item') extra.push(['A', 'Remove Item']);
      else {
        extra.push(['SHIFT + A', 'Remove Recipe']);
        const onlyResult = s.b.t === 'result' && !space().items.some((m) => m !== s.b && m.t === 'result' && sameRecipe(m, s.b.r, s.b.g));
        extra.push(['A', s.b.t === 'ingredient' || !onlyResult ? 'Remove Item' : 'Remove Recipe']);
      }
      if (perms.length > 1) extra.push(['SHIFT + Scroll', 'Change Item']);
      lines.splice(1, 0, ...hotkeyLines(false, extra));
      if (typeof lines[0] === 'string') lines[0] += LINESPACE;
      return lines;
    }
    const row = this.hoveredRow(mx, my, true);
    if (row !== -1 || inside(this.labelArea(), mx, my)) {
      const g = row !== -1 ? this.rowGroup(row) : 0;
      const lines: string[] = ['Bookmarks Group'];
      if (heldKeys.alt) {
        const tips: [string, string][] = [['LMB + Drag', 'Create/Include Group'], ['SHIFT + A', 'Remove Group']];
        if (g !== 0 || row === -1) {
          tips.push(['LMB', 'Toggle Group Mode'], ['ALT + LMB', 'Toggle Collapse/Expand'], ['CTRL + Scroll', 'Change Quantity']);
        }
        if (g !== 0) tips.push(['RMB + Drag', 'Remove/Exclude Group'], ['SHIFT + LMB + Drag', 'Move Position']);
        tips.sort((a, b) => a[0].length - b[0].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        lines[0] += LINESPACE;
        lines.push(...tips.map(([k, m]) => `§6${k}§8 - §7${m}§r`));
      } else lines.push('§7Hold §6ALT§7 for hotkeys');
      return lines;
    }
    if (this.showsNamespaces() && (inside(this.nsPrev, mx, my) || inside(this.nsNext, mx, my))) return null;
    return null;
  }

  // ---------------------------------------------------------------- amounts (BookmarkGrid.shift*Amount)

  private shiftItemAmount(target: Bookmark, shift: number) {
    const sp = space();
    const group = groupOf(sp, target.g);
    if (group.collapsed) return this.shiftGroupAmount(target.g, shift);
    if (target.r && target.t !== 'item') {
      let m = Infinity;
      for (const b of sp.items) if (sameRecipe(b, target.r, target.g) && b.f !== 0) m = Math.min(m, shiftMultiplier(b.m, shift, 0));
      for (const b of sp.items) if (sameRecipe(b, target.r, target.g) && b.f !== 0) b.m = m;
    } else target.m = shiftMultiplier(target.m, shift, 0);
    changed();
  }

  private shiftGroupAmount(g: number, shift: number) {
    const sp = space();
    const items = sp.items.filter((b) => b.g === g && amountOf(b) > 0);
    const gcd = items.map((b) => Math.max(amountOf(b), amountOf(b, 1))).reduce((a, b) => gcdOf(a, b), 0);
    if (!gcd) return;
    let m = 2147483647;
    for (const b of items) {
      const a = amountOf(b);
      const factor = Math.ceil(a / gcd);
      const custom = factor > 0 ? Math.ceil(a / factor) : 0;
      m = Math.min(shiftMultiplier(custom, shift, 1), m);
    }
    for (const b of items) {
      const factor = Math.ceil(amountOf(b) / gcd);
      b.m = multiplierFromAmount(b, factor * m);
    }
    changed();
  }

  // ---------------------------------------------------------------- grouping (GroupingItem, createGroup)

  private rowItemIndex(row: number, first: boolean): number | null {
    const g = this.gen();
    const base = (this.page() * this.rows + row) * this.columns + (first ? 0 : this.columns - 1);
    for (let n = 0; n < this.columns; n++) {
      const i = g.slotToItem.get(base + n * (first ? 1 : -1));
      if (i !== undefined) return i;
    }
    return null;
  }

  private edgeRow(row: number, top: boolean): number {
    const i = this.rowItemIndex(row, top);
    if (i === null) return -1;
    const sp = space();
    const b = sp.items[i];
    const rowShift = this.page() * this.rows;
    if (b.r && b.t !== 'item') {
      const g = this.gen();
      const collapsed = groupOf(sp, b.g).collapsed;
      const sorted = [...g.slotToItem.entries()].sort((x, y) => x[0] - y[0]);
      if (!top) sorted.reverse();
      for (const [abs, idx] of sorted) {
        const r = sp.items[idx];
        if (r.g === b.g && (collapsed || (r.t !== 'item' && r.r === b.r))) return Math.floor(abs / this.columns);
      }
      return -1;
    }
    return rowShift + row;
  }

  private point(row: number): PointEntry | null {
    if (this.rowItemIndex(row, true) === null) return null;
    return { cursor: row + this.page() * this.rows, top: this.edgeRow(row, true), bottom: this.edgeRow(row, false) };
  }

  private startGrouping(groupId: number, row: number): Grouping {
    return { groupId, start: this.point(row) ?? { cursor: row + this.page() * this.rows, top: -1, bottom: -1 }, end: null, startTime: performance.now() };
  }

  private setEndPoint(row: number) {
    const p = this.point(row);
    if (p && drag.grouping) drag.grouping.end = p;
  }

  private createGroup(grouping: Grouping) {
    const sp = space();
    const g = this.gen();
    // collectItemsToRows: the bookmarks of each row (a collapsed group's all on its first row).
    const rowItems = new Map<number, Bookmark[]>();
    const all = [...sp.items];
    const totalRows = Math.ceil(g.maxAbs / this.columns);
    for (let row = 0; row < totalRows; row++) {
      let first: number | undefined;
      for (let n = 0; n < this.columns && first === undefined; n++) first = g.slotToItem.get(row * this.columns + n);
      if (first === undefined) continue;
      const b = sp.items[first];
      let items: Bookmark[];
      if (groupOf(sp, b.g).collapsed) items = all.filter((x) => x.g === b.g);
      else {
        items = [];
        for (let n = 0; n < this.columns; n++) {
          const i = g.slotToItem.get(row * this.columns + n);
          if (i !== undefined && all.includes(sp.items[i])) items.push(sp.items[i]);
        }
      }
      rowItems.set(row, items);
      for (const x of items) all.splice(all.indexOf(x), 1);
    }
    rowItems.set(totalRows, all);

    const newGroups = new Map<number, number>();
    let next = Math.max(0, ...sp.items.map((b) => b.g)) + 1;
    let change = false;
    for (const [row, id] of prepareGroups(grouping, g.rowToGroup)) {
      if (g.rowToGroup.get(row) === id) continue;
      let target = id;
      if (id === NEW_GROUP || id < 0) {
        if (!newGroups.has(id)) {
          const from = id === NEW_GROUP ? 0 : -id;
          sp.groups[next] = { todo: groupOf(sp, from).todo, collapsed: false };
          newGroups.set(id, next++);
        }
        target = newGroups.get(id)!;
      }
      for (const b of rowItems.get(row) ?? []) b.g = target;
      change = true;
    }
    if (change) {
      sp.items = [...rowItems.keys()].sort((a, b) => a - b).flatMap((r) => rowItems.get(r)!);
      changed();
    }
  }

  // ---------------------------------------------------------------- sorting (simplified SortableItem / SortableGroup)

  private moveItem(sort: SortableItem, over: GridSlot) {
    const sp = space();
    const target = over.b;
    if (groupOf(sp, target.g).collapsed) return;
    const moving = sort.recipe;
    const from = sp.items.indexOf(moving[0]);
    const rest = sp.items.filter((b) => !moving.includes(b));
    let at = rest.indexOf(target);
    if (at < 0) return;
    if (sp.items.indexOf(target) > from) at++;
    for (const b of moving) b.g = target.g;
    rest.splice(at, 0, ...moving);
    sp.items = rest;
    normalize(sp);
    ui.generated = null;
    invalidate();
  }

  private moveGroup(groupId: number, overRow: number) {
    const sp = space();
    const g = this.gen();
    const absRow = this.page() * this.rows + overRow;
    const overGroup = g.rowToGroup.get(absRow) ?? 0;
    if (overGroup === groupId) return;
    const members = sp.items.filter((b) => b.g === groupId);
    const firstRow = [...g.rowToGroup.entries()].find(([, id]) => id === groupId)?.[0] ?? 0;
    const down = absRow > firstRow;
    // The bookmark the group goes before (moving up) or after the row's block (moving down).
    let anchor: Bookmark | undefined;
    const rowFirst = this.rowItemIndex(overRow, true);
    if (rowFirst === null) return;
    const rowItem = sp.items[rowFirst];
    const block = rowItem.g !== 0 ? sp.items.filter((b) => b.g === rowItem.g) : [rowItem];
    const rest = sp.items.filter((b) => b.g !== groupId);
    if (down) {
      const lastOfRow = this.rowItemIndex(overRow, false);
      anchor = rowItem.g !== 0 ? block[block.length - 1] : lastOfRow !== null ? sp.items[lastOfRow] : rowItem;
      rest.splice(rest.indexOf(anchor) + 1, 0, ...members);
    } else {
      anchor = block[0];
      rest.splice(rest.indexOf(anchor), 0, ...members);
    }
    sp.items = rest;
    normalize(sp);
    ui.generated = null;
    invalidate();
  }
}

/** GroupingItem.prepareGroups: the row → group map as it would be after the drag. */
function prepareGroups(gr: Grouping, groups: Map<number, number>): Map<number, number> {
  const end = gr.end!;
  const top = Math.min(gr.start.top, end.top);
  const bottom = Math.max(gr.start.bottom, end.bottom);
  const out = new Map(groups);
  if (gr.groupId !== 0) {
    if (gr.start.cursor > end.cursor) {
      let r = end.top - 1;
      while (out.has(r) && out.get(r) === gr.groupId) out.set(r--, 0);
    } else if (gr.start.cursor < end.cursor) {
      let r = end.bottom + 1;
      while (out.has(r) && out.get(r) === gr.groupId) out.set(r++, 0);
    }
  } else if (out.has(top - 1) && out.get(top - 1) === out.get(bottom + 1)) {
    // Taking rows out of the middle of a group splits it: the rows below become a new group.
    const id = out.get(bottom)!;
    let r = bottom + 1;
    while (out.has(r) && out.get(r) === id) {
      out.set(r, -out.get(r)!);
      r++;
    }
  }
  for (let r = top; r <= bottom && out.has(r); r++) out.set(r, gr.groupId);
  return out;
}

function shiftMultiplier(m: number, shift: number, min: number) {
  const current = Math.trunc((m + shift) / shift) * shift;
  return Math.min(2147483647, current <= 0 && m > 1 ? 1 : Math.max(min, current));
}

const gcdOf = (a: number, b: number): number => (b === 0 ? a : gcdOf(b, a % b));

function multiplierFromAmount(b: Bookmark, amount: number) {
  if (b.f <= 0 || (b.c !== undefined && b.c <= 0)) return 0;
  const per = b.c !== undefined ? (b.f * b.c) / CHANCE_FULL : b.f;
  return Math.max(0, Math.ceil(amount / per));
}

// ---------------------------------------------------------------- drawing helpers

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** ItemsGridSlot.drawBorder: 0.75 px lines along a group's outer edges. */
function drawBorders(gfx: Gfx, r: Rect, borders: [boolean, boolean, boolean, boolean], color: number) {
  const lw = 0.75, half = lw / 2;
  const [left, top, right, bottom] = borders;
  if (left) gfx.fill(r.x - half, r.y + half, lw, r.h, color);
  if (right) gfx.fill(r.x + r.w - half, r.y - half, lw, r.h, color);
  if (top) gfx.fill(r.x - half, r.y - half, r.w, lw, color);
  if (bottom) gfx.fill(r.x + half, r.y + r.h - half, r.w, lw, color);
}

/**
 * NEIClientUtils.drawNEIOverlayText: half-size text in a corner of the slot's inner 16 x 16
 * (the slot rectangle less 1 px all round).
 */
function overlayText(gfx: Gfx, text: string, slot: Rect, color: number, align: 'tl' | 'tr' | 'bl' | 'br') {
  const s = 0.5;
  const x = slot.x + 1, y = slot.y + 1, w = slot.w - 2, h = slot.h - 2;
  const ax = align === 'tr' || align === 'br' ? 1 : -1;
  const ay = align === 'bl' || align === 'br' ? 1 : -1;
  const width = stringWidth(text);
  const ox = Math.ceil(x + w / 2 + (w / 2) * ax - (width / 2) * (ax + 1) * s);
  const oy = Math.ceil(y + h / 2 + (h / 2) * ay - (9 / 2) * (ay + 1) * s);
  gfx.push();
  gfx.translate(ox, oy);
  gfx.scale(s);
  drawString(gfx, text, 0, 0, color, true);
  gfx.pop();
}

/**
 * RecipeTooltipLineHandler: the saved recipe drawn under the bookmark's tooltip, on the recipe
 * window's background with the handler's name on top.
 */
function recipeTip(rid: string): TipLine | null {
  const ref = parseRecipeId(rid);
  if (!ref) return null;
  const rec = getRecipe(ref.handler, ref.recipe);
  if (!rec) return null;
  const h = ref.h;
  const ww = Math.max(166, h.width ?? 166);
  const wh = recipeHeight(h, null) + h.yShift;
  const BG = 5, T = 4;
  const width = ww + BG * 2, height = wh + BG * 2 + 12;
  return {
    width,
    height,
    draw(gfx, x, y) {
      const img = texture('nei:textures/gui/recipebg.png');
      if (img) {
        const k = img.width / 256;
        nineSlice(gfx, img, 0, 0, 176 + T * 2, 166 + T * 2, k, x - T, y - T, width + T * 2, height + T * 2, BG + T);
      }
      gfx.fill(x + BG, y + BG, width - BG * 2, 12, 0x30000000);
      const name = h.name.trim();
      drawString(gfx, name, x + Math.trunc(ww / 2) - Math.trunc(stringWidth(name) / 2), y + BG + 2, 0xffffffff, true);
      gfx.clip(x + BG, y + BG + 12, ww, wh);
      drawRecipeWidget(gfx, h, rec, x + BG, y + BG + 12 + h.yShift, gfx.now);
      gfx.endClip();
      animating();
    },
  };
}
