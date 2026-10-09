// NEI's overlay around a GUI (LayoutManager with LayoutStyleMinecraft and GTNH's settings in
// config/NEI/client.cfg): the item panel on the right (ItemPanel, ItemsPanelGrid) with its page
// buttons and collapsible groups, the search field centred at the bottom (SearchField), the item
// quantity widget under the panel, the options and bookmarks buttons at the bottom left and the
// subsets button at the top. One overlay is shared by every screen that shows it, so the search
// and the page stay as they were, as in game.
//
// The bookmark panel on the left is in bookmarks.ts. What does nothing here: options, the subsets
// dropdown (the "%" search does read the subsets), and the quantity (it only matters for cheating
// items in, and for Ctrl + A).

import { type Gfx, type TipLine, keys as heldKeys } from '../gui/core.ts';
import { texture } from '../gui/assets.ts';
import { animating, invalidate } from '../gui/frame.ts';
import { drawString, stringWidth } from '../gui/font.ts';
import {
  loadList, itemList, loadTooltips, tooltipData, itemName, itemMod, itemKeyAt, drawNeiItem, itemTooltipLines,
} from './data.ts';
import { getFilter, formatSearch, stripFormatting, setSubsets, type SearchItem } from './search.ts';
import type { NeiTooltips } from './model.ts';
import { Btn, type Rect, inside, neiButton, hotkeyLines, LINESPACE } from './draw.ts';
import type { RecipeMode } from './recipeScreen.ts';
import { BookmarkPanel, bookmarksHidden, toggleBookmarks, toggleItem } from './bookmarks.ts';

/** Open an item's recipes or usages; `rid` focuses a recipe saved with a bookmark. */
export type PanelOpen = (key: string, mode: RecipeMode, rid?: string) => void;

const SLOT = 18;
const PADDING = 2;
const BUTTON_SIZE = 20;
const MARGIN = 2;

/** inventory.collapsibleItems.collapsedColor / expandedColor, and their borders (alpha + 2/5). */
const GROUP_BG = 0x335555ee;
const GROUP_BORDER = 0x995555ee;
const HIGHLIGHT = 0xee555555;

// ---------------------------------------------------------------- shared state

const state = {
  search: '',
  cursor: 0,
  /** Selection end (GuiTextField.selectionEnd); equal to cursor when nothing is selected. */
  selEnd: 0,
  focused: false,
  focusFrame: 0,
  page: 0,
  quantity: 0,
  /** Groups toggled away from their default (CollapsibleItems.setExpanded). */
  toggled: new Set<number>(),
  /** The "G" button's state for all groups: null = per group. */
  allExpanded: null as boolean | null,
  /** ItemHistoryPanel: the items whose recipes or usages were looked up, newest first. */
  history: [] as number[],
};

const HISTORY_ROWS = 2; // inventory.history.useRows
const HISTORY_COLOR = 0xee555555; // inventory.history.historyColor

/** ItemHistoryPanel.addItem: called when a lookup opens (GuiCraftingRecipe / GuiUsageRecipe). */
export function addToHistory(item: number) {
  const h = state.history.filter((i) => i !== item);
  h.unshift(item);
  state.history = h.slice(0, 50);
}

let searchItems: SearchItem[] | null = null;
let searchItemsWithTooltips = false;

/** What NEI's search reads of each listed item, built once the list (and later tooltips) loaded. */
function searchData(): SearchItem[] | null {
  const list = itemList();
  if (!list) return null;
  const tips = tooltipData();
  if (searchItems && (searchItemsWithTooltips || !tips)) return searchItems;
  setSubsets(tips?.subsets ?? []);
  searchItems = list.items.map((i, pos) => {
    const key = itemKeyAt(i);
    return {
      name: stripFormatting(itemName(i)),
      mod: itemMod(i) ?? 'Minecraft',
      tooltip: stripFormatting((tips?.lines[i] ?? []).join('\n')),
      ores: (tips?.ore[i] ?? []).map((n) => tips!.ores[n]),
      id: identifier(key, i, tips),
      pos,
    };
  });
  searchItemsWithTooltips = !!tips;
  return searchItems;
}

/**
 * IdentifierFilter's text: the registry name and numeric id:damage (from the export's ids), or the
 * whole identifier the export recorded for the stack (fluids); older data has registry names only.
 */
function identifier(key: string, i: number, tips: NeiTooltips | null): string {
  const whole = tips?.idents?.[i];
  if (whole) return whole;
  const reg = key.startsWith('fluid:') ? key.slice(6) : key.replace(/@.*$/, '');
  const id = tips?.ids?.[reg];
  const meta = /@(\d+)/.exec(key)?.[1];
  return id !== undefined && meta !== undefined ? `${reg}\n${id}:${meta}` : reg;
}

const groupExpanded = (g: number) => {
  const list = itemList();
  if (state.allExpanded !== null) return state.allExpanded !== state.toggled.has(g);
  return !!list?.groups[g]?.[1] !== state.toggled.has(g);
};

interface Shown {
  /** Item indexes on the panel, in order (collapsed groups show their first item). */
  items: number[];
  /** Group of each shown item, -1 for none. */
  group: number[];
  /** Items of each group that passed the filter. */
  groupItems: Map<number, number[]>;
  /** Only one group's items matched: NEI opens it (forceExpand). */
  forceExpand: boolean;
}

let shownKey = '';
let shown: Shown = { items: [], group: [], groupItems: new Map(), forceExpand: false };

/**
 * ItemList.updateFilter and ItemsPanelGrid.refresh: the listed items the search lets through,
 * a group's items moved to where its first item is, and collapsed groups folded into one slot.
 */
function shownItems(): Shown {
  const list = itemList();
  if (!list) return shown;
  const tips = tooltipData();
  const key = `${state.search}\u0000${!!tips}\u0000${state.allExpanded}\u0000${[...state.toggled].join(',')}`;
  if (key === shownKey) return shown;
  shownKey = key;
  const data = searchData()!;
  const filter = getFilter(state.search);
  const firstOfGroup = new Map<number, number>();
  const passed: { pos: number; n: number }[] = [];
  for (let n = 0; n < list.items.length; n++) {
    const g = list.group[n];
    if (g >= 0 && !firstOfGroup.has(g)) firstOfGroup.set(g, n);
    if (filter(data[n])) passed.push({ pos: g >= 0 ? firstOfGroup.get(g)! : n, n });
  }
  // ItemListLoader.updateOrdering: group members sort to their group's first position (stable).
  passed.sort((a, b) => a.pos - b.pos);
  const out: Shown = { items: [], group: [], groupItems: new Map(), forceExpand: false };
  const seen = new Set<number>();
  let outside = false;
  for (const { n } of passed) {
    const g = list.group[n];
    const item = list.items[n];
    if (g < 0) {
      out.items.push(item);
      out.group.push(-1);
      outside = true;
      continue;
    }
    if (!seen.has(g) || groupExpanded(g)) {
      out.items.push(item);
      out.group.push(g);
      seen.add(g);
    }
    const gi = out.groupItems.get(g);
    if (gi) gi.push(item);
    else out.groupItems.set(g, [item]);
  }
  if (!outside && seen.size === 1 && out.items.length) {
    const g = [...seen][0];
    out.items = out.groupItems.get(g)!;
    out.group = out.items.map(() => g);
    out.forceExpand = true;
  }
  shown = out;
  return shown;
}

// ---------------------------------------------------------------- the overlay

/** The GUI the overlay sits around: its left/top and size (guiLeft, guiTop, xSize, ySize). */
export interface GuiArea {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Slot {
  rect: Rect;
  item: number;
  group: number;
  extended: boolean;
  bgItem: number;
  groupSize: number;
  borders: [boolean, boolean, boolean, boolean];
}

export class ItemPanelOverlay {
  private W = 0;
  private H = 0;
  private gui: GuiArea = { x: 0, y: 0, w: 176, h: 166 };
  private blocked: Rect[] = [];
  /** ItemPanel bounds. */
  private panel: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private grid: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private columns = 0;
  private rows = 0;
  private invalid: boolean[] = [];
  private perPage = 0;
  private mouseDownSlot = -1;
  private mouseDownButton = -1;
  /** The history area above the quantity widget (absent while it is empty). */
  private history: Rect | null = null;
  private historyColumns = 0;
  private laidOutHistory = -1;

  readonly bookmarkPanel: BookmarkPanel;

  constructor(private open: PanelOpen) {
    this.bookmarkPanel = new BookmarkPanel((key, mode, rid) => this.open(key, mode, rid));
    void loadList().then(() => {
      void loadTooltips();
      invalidate();
    });
  }

  /** LayoutManager.layout for a screen of W x H around `gui`; `blocked` are areas no slot may cover. */
  layout(W: number, H: number, gui: GuiArea, blocked: Rect[] = []) {
    this.W = W;
    this.H = H;
    this.gui = gui;
    this.blocked = [gui, ...blocked];
    // ItemPanel.calculateBounds (no extra padding configured).
    const maxWidth = Math.trunc((W - 176) / 2) - PADDING * 2;
    const maxHeight = H - PADDING * 2;
    const freeSpace = Math.trunc((W - gui.w) / 2) - PADDING * 2;
    const width = Math.max(SLOT, Math.trunc(Math.min(freeSpace, maxWidth) / SLOT) * SLOT);
    const height = Math.max(SLOT, maxHeight);
    this.panel = { x: W - width - PADDING, y: PADDING, w: width, h: height };
    // Header: page buttons (16 high) and 2 px; footer: the quantity widget and 2 px, and above it
    // the history panel once something was looked up (ItemPanel.resizeFooter).
    const header = 16 + 2;
    let footer = BUTTON_SIZE + PADDING;
    this.laidOutHistory = state.history.length;
    this.historyColumns = Math.trunc(width / SLOT);
    const historyRows = this.historyColumns ? Math.min(Math.ceil(state.history.length / this.historyColumns), HISTORY_ROWS) : 0;
    this.history = null;
    if (historyRows > 0) {
      const hh = 8 + SLOT * historyRows;
      this.history = { x: this.panel.x, y: this.panel.y + height - BUTTON_SIZE - hh, w: width, h: hh };
      footer += hh;
    }
    this.grid = { x: this.panel.x, y: this.panel.y + header, w: width, h: Math.max(0, height - header - footer) };
    this.columns = Math.trunc(this.grid.w / SLOT);
    this.rows = Math.trunc(this.grid.h / SLOT);
    // ItemsGrid.updateGuiOverlapSlots: slots under the GUI are left out.
    this.invalid = [];
    this.perPage = 0;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.columns; c++) {
        const rect = this.slotRect(r, c);
        const bad = this.blocked.some((b) => intersects(b, rect));
        this.invalid[r * this.columns + c] = bad;
        if (!bad) this.perPage++;
      }
    }
    this.bookmarkPanel.layout(W, H, gui.w, this.blocked, this.bookmarks());
  }

  private slotRect(row: number, column: number): Rect {
    const paddingLeft = Math.trunc((this.grid.w % SLOT) / 2);
    return { x: this.grid.x + paddingLeft + column * SLOT, y: this.grid.y + row * SLOT, w: SLOT, h: SLOT };
  }

  private numPages(n: number) {
    return this.perPage > 0 ? Math.ceil(n / this.perPage) : 0;
  }

  private pageButtons(): { prev: Rect; next: Rect; groups: Rect; label: [number, number] } {
    const p = this.panel;
    const prev = { x: p.x, y: p.y, w: 16, h: 16 };
    const next = { x: p.x + p.w - 16, y: p.y, w: 16, h: 16 };
    return { prev, next, groups: { x: next.x - 16 - 2, y: p.y, w: 16, h: 16 }, label: [p.x + Math.trunc(p.w / 2), p.y + 5] };
  }

  /** LayoutStyleMinecraft.getSearchFieldArea with the search widget centred. */
  private searchArea(): Rect {
    const w = Math.min(this.gui.w, 176) - MARGIN * 2;
    return { x: Math.trunc((this.W - w) / 2), y: this.H - BUTTON_SIZE - MARGIN, w, h: BUTTON_SIZE };
  }
  /** The quantity widget: "-" and "+" buttons around the field, the panel's width. */
  private quantityArea(): { less: Rect; more: Rect; field: Rect } {
    const p = this.panel;
    const y = p.y + p.h - BUTTON_SIZE;
    const less = { x: p.x, y, w: BUTTON_SIZE, h: BUTTON_SIZE };
    const more = { x: p.x + p.w - BUTTON_SIZE, y, w: BUTTON_SIZE, h: BUTTON_SIZE };
    return { less, more, field: { x: less.x + less.w + 1, y, w: more.x - less.x - less.w - 2, h: BUTTON_SIZE } };
  }
  private options(): Rect {
    return { x: MARGIN, y: this.H - BUTTON_SIZE - MARGIN, w: BUTTON_SIZE, h: BUTTON_SIZE };
  }
  private bookmarks(): Rect {
    return { x: MARGIN + BUTTON_SIZE + MARGIN, y: this.H - BUTTON_SIZE - MARGIN, w: BUTTON_SIZE, h: BUTTON_SIZE };
  }
  /** The subsets dropdown on top (shown when the GUI leaves more than 20 px above it). */
  private subsets(): Rect | null {
    if (this.gui.y <= 20) return null;
    return { x: Math.trunc((this.W - 150) / 2), y: MARGIN, w: 150, h: 16 };
  }

  /** Lay out again when the history panel appears or grows a row. */
  private ensureLayout() {
    if (this.laidOutHistory !== state.history.length && this.W) this.layout(this.W, this.H, this.gui, this.blocked.slice(1));
  }

  /** The history panel's slots: as many items as fit, from its top left, 4 px under its line. */
  private historySlots(): Slot[] {
    this.ensureLayout();
    const h = this.history;
    if (!h) return [];
    const rows = Math.trunc((h.h - 8) / SLOT);
    const pad = Math.trunc((h.w % SLOT) / 2);
    return state.history.slice(0, rows * this.historyColumns).map((item, i) => ({
      rect: { x: h.x + pad + (i % this.historyColumns) * SLOT, y: h.y + 4 + Math.trunc(i / this.historyColumns) * SLOT, w: SLOT, h: SLOT },
      item, group: -1, extended: false, bgItem: -1, groupSize: 1, borders: [false, false, false, false],
    }));
  }

  /** The slots of the current page (ItemsPanelGrid.getMask with calculateGroupBorders). */
  private slots(): Slot[] {
    this.ensureLayout();
    const s = shownItems();
    const pages = this.numPages(s.items.length);
    state.page = Math.max(0, Math.min(state.page, pages - 1));
    const out: Slot[] = [];
    const bySlot = new Map<number, number>();
    let itemIndex = state.page * this.perPage;
    for (let slot = 0; slot < this.rows * this.columns && itemIndex < s.items.length; slot++) {
      if (this.invalid[slot]) continue;
      const g = s.group[itemIndex];
      const members = g >= 0 ? s.groupItems.get(g) ?? [] : [];
      const grouped = g >= 0 && members.length > 1;
      const extended = grouped && (s.forceExpand || groupExpanded(g));
      out.push({
        rect: this.slotRect(Math.trunc(slot / this.columns), slot % this.columns),
        item: s.items[itemIndex],
        group: grouped ? g : -1,
        extended,
        bgItem: grouped ? members[members.length - 1] : -1,
        groupSize: grouped ? members.length : 1,
        borders: [false, false, false, false],
      });
      bySlot.set(slot, out.length - 1);
      itemIndex++;
    }
    // Borders where a group's slots meet other slots.
    const groupAt = (slot: number) => {
      const i = bySlot.get(slot);
      return i === undefined ? -1 : out[i].group;
    };
    for (const [slot, i] of bySlot) {
      const sl = out[i];
      if (sl.group < 0) continue;
      const c = slot % this.columns;
      sl.borders = [
        c === 0 || groupAt(slot - 1) !== sl.group,
        groupAt(slot - this.columns) !== sl.group,
        c + 1 === this.columns || groupAt(slot + 1) !== sl.group,
        groupAt(slot + this.columns) !== sl.group,
      ];
    }
    return out;
  }

  private slotAt(mx: number, my: number): Slot | null {
    for (const s of this.slots()) if (inside(s.rect, mx, my)) return s;
    for (const s of this.historySlots()) if (inside(s.rect, mx, my)) return s;
    return null;
  }

  /** The item under the mouse, for R and U. */
  hoveredItem(mx: number, my: number): number | null {
    return this.slotAt(mx, my)?.item ?? null;
  }

  /** The bookmark under the mouse, for R and U (a saved recipe opens at that recipe). */
  hoveredBookmark(mx: number, my: number): { key: string; rid?: string } | null {
    return this.bookmarkPanel.hoveredItem(mx, my);
  }

  // ---------------------------------------------------------------- drawing

  draw(gfx: Gfx, mx: number, my: number) {
    const list = itemList();
    const s = shownItems();
    const hasItems = !!list && s.items.length > 0 && this.perPage > 0;

    // Bottom left: options (recipe mode icon) and bookmarks (shown or hidden icon).
    this.iconButton(gfx, this.options(), 32, mx, my);
    this.iconButton(gfx, this.bookmarks(), bookmarksHidden() ? 0 : 16, mx, my);
    this.bookmarkPanel.draw(gfx, mx, my);
    const sub = this.subsets();
    if (sub) {
      const hover = inside(sub, mx, my);
      neiButton(gfx, sub, hover ? Btn.HOVER : Btn.NORMAL, 'Item Subsets');
    }

    // Header: "<", page n/m, "G" (when there are groups), ">".
    if (hasItems) {
      const b = this.pageButtons();
      const paged = this.numPages(s.items.length) > 1;
      neiButton(gfx, b.prev, !paged ? Btn.DISABLED : inside(b.prev, mx, my) ? Btn.HOVER : Btn.NORMAL, '<');
      neiButton(gfx, b.next, !paged ? Btn.DISABLED : inside(b.next, mx, my) ? Btn.HOVER : Btn.NORMAL, '>');
      if (list!.groups.length) neiButton(gfx, b.groups, inside(b.groups, mx, my) ? Btn.HOVER : Btn.NORMAL, 'G');
      const label = `${state.page + 1}/${Math.max(1, this.numPages(s.items.length))}`;
      drawString(gfx, label, b.label[0] - Math.trunc(stringWidth(label) / 2), b.label[1], 0xffffffff, true);
    }

    // The grid.
    if (!list) {
      const t = 'Loading Item List...';
      drawString(gfx, t, this.grid.x + Math.trunc(this.grid.w / 2) - Math.trunc(stringWidth(t) / 2), this.grid.y + Math.trunc(this.grid.h / 2), 0xffffffff, true);
    } else if (this.perPage > 0) {
      const slots = this.slots();
      for (const sl of slots) {
        if (inside(sl.rect, mx, my)) gfx.fill(sl.rect.x, sl.rect.y, SLOT, SLOT, HIGHLIGHT);
        if (sl.group >= 0) gfx.fill(sl.rect.x, sl.rect.y, SLOT, SLOT, GROUP_BG);
      }
      for (const sl of slots) if (sl.group >= 0) drawBorders(gfx, sl);
      for (const sl of slots) {
        if (sl.group >= 0 && !sl.extended && sl.bgItem >= 0) {
          drawNeiItem(gfx, sl.bgItem, sl.rect.x + 2, sl.rect.y);
          drawNeiItem(gfx, sl.item, sl.rect.x, sl.rect.y + 2);
        } else drawNeiItem(gfx, sl.item, sl.rect.x + 1, sl.rect.y + 1);
      }
    }

    // History: a dashed line (dash.png in the history colour) and the items.
    const hs = this.historySlots();
    if (this.history && hs.length) {
      const h = this.history;
      const dash = texture('nei:textures/dash.png');
      const width = this.historyColumns * SLOT;
      const shiftX = h.x + Math.trunc((h.w - width) / 2);
      if (dash) for (let i = 0; i < Math.trunc(width / 6); i++) gfx.image(dash, 0, 0, dash.width, dash.height, shiftX + i * 6, h.y, 6, 1, HISTORY_COLOR);
      for (const sl of hs) {
        if (inside(sl.rect, mx, my)) gfx.fill(sl.rect.x, sl.rect.y, SLOT, SLOT, HIGHLIGHT);
        drawNeiItem(gfx, sl.item, sl.rect.x + 1, sl.rect.y + 1);
      }
    }

    // Quantity widget.
    const q = this.quantityArea();
    neiButton(gfx, q.less, inside(q.less, mx, my) ? Btn.HOVER : Btn.NORMAL, '-');
    neiButton(gfx, q.more, inside(q.more, mx, my) ? Btn.HOVER : Btn.NORMAL, '+');
    textBox(gfx, q.field, state.quantity > 0 ? String(state.quantity) : '', 'One stack', 0xff909090, false, 0, 0);

    // Search field.
    const sa = this.searchArea();
    const empty = !!list && s.items.length === 0;
    const color = empty ? (state.focused ? 0xffcc3300 : 0xff993300) : state.focused ? 0xffe0e0e0 : 0xff909090;
    if (state.focused) animating();
    textBox(gfx, sa, state.search, 'Search...', color, state.focused, state.cursor, state.selEnd, true);
  }

  private iconButton(gfx: Gfx, r: Rect, u: number, mx: number, my: number) {
    neiButton(gfx, r, inside(r, mx, my) ? Btn.HOVER : Btn.NORMAL);
    const img = texture('nei:textures/nei_tabbed_sprites.png');
    if (img) {
      const k = img.width / 256;
      gfx.image(img, u * k, 0, 16 * k, 16 * k, r.x + Math.trunc((r.w - 16) / 2), r.y + Math.trunc((r.h - 16) / 2), 16, 16);
    }
  }

  // ---------------------------------------------------------------- input

  /** Whether the overlay takes a click at (mx, my). */
  contains(mx: number, my: number) {
    return (
      inside(this.panel, mx, my) || inside(this.searchArea(), mx, my) || inside(this.options(), mx, my) ||
      inside(this.bookmarks(), mx, my) || (!!this.subsets() && inside(this.subsets()!, mx, my)) ||
      this.bookmarkPanel.contains(mx, my)
    );
  }

  mouseDown(mx: number, my: number, b: number): boolean {
    const sa = this.searchArea();
    // TextField.onGuiClick: a click anywhere else leaves the field.
    if (!inside(sa, mx, my)) this.setFocus(false);
    if (inside(sa, mx, my)) {
      this.setFocus(true);
      if (b === 1) this.setSearch('');
      else state.cursor = state.selEnd = cursorAt(state.search, mx - (sa.x + 2 + 4));
      return true;
    }
    if (b === 0 && inside(this.bookmarks(), mx, my)) {
      toggleBookmarks();
      return true;
    }
    if (this.bookmarkPanel.mouseDown(mx, my, b)) return true;
    if (!this.contains(mx, my)) return false;
    const s = shownItems();
    const pages = this.numPages(s.items.length);
    const btn = this.pageButtons();
    if (s.items.length && this.perPage > 0) {
      if (inside(btn.prev, mx, my)) return this.turn(b === 1 ? -state.page : -1, pages), true;
      if (inside(btn.next, mx, my)) return this.turn(b === 1 ? pages - 1 - state.page : 1, pages), true;
      if (itemList()?.groups.length && inside(btn.groups, mx, my)) {
        // CollapsibleItems.toggleGroups: right click collapses all, left click expands all unless
        // one is expanded already.
        const anyExpanded = (itemList()?.groups ?? []).some((_, g) => groupExpanded(g));
        state.allExpanded = b === 1 ? false : !anyExpanded;
        state.toggled.clear();
        invalidate();
        return true;
      }
    }
    const q = this.quantityArea();
    if (inside(q.less, mx, my) || inside(q.more, mx, my)) {
      const step = heldKeys.shift ? 10 : 1;
      state.quantity = Math.max(0, state.quantity + (inside(q.more, mx, my) ? step : -step));
      return true;
    }
    const sl = this.slotAt(mx, my);
    if (sl) {
      // ItemPanel.handleClick: Alt + left click opens or closes a group.
      if (b === 0 && heldKeys.alt && sl.group >= 0 && !shownItems().forceExpand) {
        if (state.toggled.has(sl.group)) state.toggled.delete(sl.group);
        else state.toggled.add(sl.group);
        invalidate();
        return true;
      }
      this.mouseDownSlot = sl.rect.y * 10000 + sl.rect.x;
      this.mouseDownButton = b;
      return true;
    }
    return true;
  }

  /** PanelWidget.mouseUp: a click released on the same slot looks the item up (left R, right U). */
  mouseUp(mx: number, my: number, b: number): boolean {
    if (this.bookmarkPanel.mouseUp(mx, my, b)) return true;
    const down = this.mouseDownSlot;
    this.mouseDownSlot = -1;
    if (down < 0 || b !== this.mouseDownButton) return false;
    const sl = this.slotAt(mx, my);
    if (!sl || sl.rect.y * 10000 + sl.rect.x !== down) return true;
    if (b === 0 || b === 1) this.open(itemKeyAt(sl.item), b === 0 ? 'recipe' : 'usage');
    return true;
  }

  private turn(d: number, pages: number) {
    if (pages <= 0) return;
    state.page = (((state.page + d) % pages) + pages) % pages;
    invalidate();
  }

  /** The wheel over the panel turns its pages. */
  scroll(mx: number, my: number, d: number): boolean {
    if (this.bookmarkPanel.scroll(mx, my, d)) return true;
    if (!inside(this.panel, mx, my)) return false;
    this.turn(d, this.numPages(shownItems().items.length));
    return true;
  }

  /**
   * Keys: typing into the search field, F to focus it, Page Up/Down over the panel, B to hide the
   * bookmarks, A (Ctrl + A with the amount) to bookmark an item of the panel or the history.
   */
  key(e: KeyboardEvent, mx: number, my: number): boolean {
    if (state.focused) return this.typeKey(e);
    if (this.bookmarkPanel.key(e, mx, my)) return true;
    const k = e.key.toLowerCase();
    if (k === 'a' && !e.altKey) {
      const sl = this.slotAt(mx, my);
      if (sl) {
        toggleItem(itemKeyAt(sl.item), { withCount: e.ctrlKey || e.metaKey || e.shiftKey, amount: state.quantity || 1 });
        return true;
      }
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (k === 'b') {
      toggleBookmarks();
      return true;
    }
    if (e.key.toLowerCase() === 'f') {
      this.setFocus(true);
      state.cursor = state.selEnd = state.search.length;
      return true;
    }
    if (inside(this.panel, mx, my)) {
      if (e.key === 'PageDown') return this.turn(1, this.numPages(shownItems().items.length)), true;
      if (e.key === 'PageUp') return this.turn(-1, this.numPages(shownItems().items.length)), true;
    }
    return false;
  }

  get focused() {
    return state.focused;
  }

  private setFocus(f: boolean) {
    if (f && !state.focused) state.focusFrame = performance.now();
    state.focused = f;
  }

  private setSearch(s: string) {
    if (s === state.search) return;
    state.search = s.slice(0, 256);
    state.cursor = state.selEnd = Math.min(state.cursor, state.search.length);
    state.page = 0;
    if (state.search && !tooltipData()) void loadTooltips();
    invalidate();
  }

  /** GuiTextField.textboxKeyTyped, as far as a search field needs it. */
  private typeKey(e: KeyboardEvent): boolean {
    const t = state.search;
    const a = Math.min(state.cursor, state.selEnd), b = Math.max(state.cursor, state.selEnd);
    const write = (s: string) => {
      const next = (t.slice(0, a) + s + t.slice(b)).slice(0, 256);
      const pos = Math.min(a + s.length, next.length);
      this.setSearch(next);
      state.cursor = state.selEnd = pos;
    };
    const ctrl = e.ctrlKey || e.metaKey;
    const move = (pos: number) => {
      pos = Math.max(0, Math.min(t.length, pos));
      if (e.shiftKey) state.cursor = pos;
      else state.cursor = state.selEnd = pos;
    };
    switch (e.key) {
      case 'Enter':
      case 'Escape':
        this.setFocus(false);
        return true;
      case 'Backspace':
        if (a !== b) write('');
        else if (a > 0) {
          const from = ctrl ? wordStart(t, a) : a - 1;
          this.setSearch(t.slice(0, from) + t.slice(a));
          state.cursor = state.selEnd = from;
        }
        return true;
      case 'Delete':
        if (a !== b) write('');
        else if (a < t.length) {
          const to = ctrl ? wordEnd(t, a) : a + 1;
          this.setSearch(t.slice(0, a) + t.slice(to));
          state.cursor = state.selEnd = a;
        }
        return true;
      case 'ArrowLeft':
        move(ctrl ? wordStart(t, state.cursor) : state.cursor - 1);
        return true;
      case 'ArrowRight':
        move(ctrl ? wordEnd(t, state.cursor) : state.cursor + 1);
        return true;
      case 'Home':
        move(0);
        return true;
      case 'End':
        move(t.length);
        return true;
    }
    if (ctrl && e.key.toLowerCase() === 'a') {
      state.cursor = t.length;
      state.selEnd = 0;
      return true;
    }
    if (ctrl && e.key.toLowerCase() === 'c') {
      void navigator.clipboard?.writeText(t.slice(a, b));
      return true;
    }
    if (ctrl && e.key.toLowerCase() === 'x') {
      void navigator.clipboard?.writeText(t.slice(a, b));
      write('');
      return true;
    }
    if (ctrl && e.key.toLowerCase() === 'v') {
      void navigator.clipboard?.readText().then((s) => {
        write(s.replace(/[§\u0000-\u001f\u007f]/g, ''));
        invalidate();
      });
      return true;
    }
    if (e.key.length === 1 && !ctrl && e.key !== '§') {
      write(e.key);
      return true;
    }
    // Other keys stay with the field while it has focus (TextField.handleKeyPress).
    return !ctrl;
  }

  // ---------------------------------------------------------------- tooltips

  tooltip(mx: number, my: number): (string | TipLine)[] | null {
    const bt = this.bookmarkPanel.tooltip(mx, my);
    if (bt) return bt;
    const sl = this.slotAt(mx, my);
    if (sl) {
      const s = shownItems();
      // ItemPanel.handleItemTooltip: a closed group shows its name instead of the item's tooltip.
      const name = sl.group >= 0 ? (itemList()?.groups[sl.group]?.[0] ?? '') : '';
      const lines: (string | TipLine)[] = !s.forceExpand && sl.group >= 0 && !sl.extended && name ? [name] : itemTooltipLines(sl.item);
      // ItemPanel.handleHotkeys: Alt + left click opens or closes the group.
      const extra: [string, string][] = !s.forceExpand && sl.group >= 0 && sl.groupSize > 1
        ? [['ALT + LMB', `${sl.extended ? 'Collapse' : 'Expand'} Group (${sl.groupSize} items)`]]
        : [];
      extra.push(...bookmarkHotkeys());
      lines.splice(1, 0, ...hotkeyLines(false, extra));
      lines[0] += LINESPACE;
      return lines;
    }
    const b = this.pageButtons();
    if (itemList()?.groups.length && shownItems().items.length && inside(b.groups, mx, my)) return ['Collapse/Expand All Collapsible Items'];
    if (inside(this.options(), mx, my)) return ['NEI Options', '§7Only in game'];
    if (inside(this.bookmarks(), mx, my)) return ['Toggle visibility of the Bookmark Panel'];
    const sub = this.subsets();
    if (sub && inside(sub, mx, my)) return ['Item Subsets', '§7Only in game'];
    return null;
  }
}

// ---------------------------------------------------------------- helpers

/** The bookmark hotkeys NEI lists for a stack outside the bookmark panel. */
export function bookmarkHotkeys(recipe = false): [string, string][] {
  const out: [string, string][] = [['A', 'Add Bookmark'], ['CTRL + A', 'Add Bookmark with Count']];
  if (recipe) out.push(['SHIFT + A', 'Add Bookmark with Recipe'], ['CTRL + SHIFT + A', 'Add Bookmark with Recipe & Count']);
  return out;
}

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** ItemsGridSlot.drawBorder: 0.75 px lines along a group's outer edges. */
function drawBorders(gfx: Gfx, sl: Slot) {
  const { x, y, w, h } = sl.rect;
  const lw = 0.75, half = lw / 2;
  const [left, top, right, bottom] = sl.borders;
  if (left) gfx.fill(x - half, y + half, lw, h, GROUP_BORDER);
  if (right) gfx.fill(x + w - half, y - half, lw, h, GROUP_BORDER);
  if (top) gfx.fill(x - half, y - half, w, lw, GROUP_BORDER);
  if (bottom) gfx.fill(x + half, y + h - half, w, lw, GROUP_BORDER);
}

const isWordChar = (c: string) => c !== ' ';
function wordStart(t: string, pos: number) {
  let p = pos;
  while (p > 0 && !isWordChar(t[p - 1])) p--;
  while (p > 0 && isWordChar(t[p - 1])) p--;
  return p;
}
function wordEnd(t: string, pos: number) {
  let p = pos;
  while (p < t.length && isWordChar(t[p])) p++;
  while (p < t.length && !isWordChar(t[p])) p++;
  return p;
}

/** The cursor position nearest to x pixels into the text. */
function cursorAt(text: string, x: number) {
  for (let i = 0; i <= text.length; i++) if (stringWidth(text.slice(0, i)) > x) return Math.max(0, i - 1);
  return text.length;
}

/**
 * TextField.draw with FormattedTextField.drawTextBox: a gray-bordered black box inset by 2, the
 * text 4 px in (coloured by the search's formatter when `formatted`), the placeholder when empty
 * and unfocused, a blinking cursor and the selection.
 */
function textBox(
  gfx: Gfx, area: Rect, text: string, placeholder: string, color: number, focused: boolean, cursor: number, selEnd: number,
  formatted = false,
) {
  const fx = area.x + 2, fy = area.y + 2, fw = area.w - 4, fh = area.h - 4;
  gfx.fill(fx - 1, fy - 1, fw + 2, fh + 2, 0xffa0a0a0);
  gfx.fill(fx, fy, fw, fh, 0xff000000);
  const x = fx + 4, y = fy + Math.trunc((fh - 8) / 2);
  if (!focused && !text) {
    drawString(gfx, trimToWidth(placeholder, fw - 8), x, y, 0xff303030, true);
    return;
  }
  // Scroll so the cursor stays in view (GuiTextField.lineScrollOffset).
  let offset = 0;
  while (offset < cursor && stringWidth(text.slice(offset, cursor)) > fw - 8) offset++;
  const visible = trimToWidth(text.slice(offset), fw - 8);
  let shownText = visible;
  if (formatted) {
    const f = formatSearch(text);
    if (stripFormatting(f).toLowerCase() === text.toLowerCase()) shownText = formattedSlice(f, offset, offset + visible.length);
  }
  gfx.clip(fx, fy, fw, fh);
  drawString(gfx, shownText, x, y, color, true);
  const ca = cursor - offset;
  const cx = x + stringWidth(visible.slice(0, Math.max(0, ca)));
  if (selEnd !== cursor) {
    const sa = Math.max(0, Math.min(cursor, selEnd) - offset), sb = Math.min(visible.length, Math.max(cursor, selEnd) - offset);
    const x0 = x + stringWidth(visible.slice(0, sa)), x1 = x + stringWidth(visible.slice(0, sb));
    gfx.fill(x0, y - 1, x1 - x0, 1 + 9 + 1, 0x800000ff);
  }
  if (focused && Math.floor((performance.now() - state.focusFrame) / 300) % 2 === 0) {
    if (cursor < text.length) gfx.fill(cx - 1, y - 1, 1, 1 + 9 + 1, 0xffd0d0d0);
    else drawString(gfx, '_', cx, y, color, true);
  }
  gfx.endClip();
}

function trimToWidth(s: string, w: number) {
  let out = '';
  for (const ch of s) {
    if (stringWidth(out + ch) > w) break;
    out += ch;
  }
  return out;
}

/** The part of a formatted string covering plain characters [from, to), with the colour in force. */
function formattedSlice(f: string, from: number, to: number) {
  let plain = 0, color = '', out = '';
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '§' && i + 1 < f.length) {
      const code = f.slice(i, i + 2);
      if (plain >= from && plain < to) out += code;
      else color = code;
      i++;
      continue;
    }
    if (plain >= from && plain < to) {
      if (!out) out = color;
      out += f[i];
    }
    plain++;
  }
  return out;
}
