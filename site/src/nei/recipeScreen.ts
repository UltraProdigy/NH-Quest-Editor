// NEI's recipe window (GuiRecipe, GTNH NotEnoughItems): the recipes ("R") or usages ("U") of an
// item, one tab per handler, paged, with the handler's catalysts in a panel on the left.
//
// Layout, all in GUI pixels, follows GuiRecipe.initGui with GTNH's settings (JEI-style 24 px tabs,
// catalysts in a grid, a window at most 370 high):
// - the window is 176 wide, centred, drawn from recipebg.png as a nine-slice with 5 px borders;
// - row 1 (y + 3): "<" handler ">" buttons around the handler name;
// - row 2 (y + 17): "<" page ">" buttons, the recipe search toggle and "Page n/m";
// - recipes from y + 32, each RecipeWidget handler height + yShift tall, as many as fit;
// - tabs above the window, catalysts to its left.

import { Screen } from '../gui/screen.ts';
import { type Gfx, type Tooltip, type TipLine, keys as heldKeys } from '../gui/core.ts';
import { texture } from '../gui/assets.ts';
import { drawString, stringWidth } from '../gui/font.ts';
import {
  handlerList, recipe as getRecipe, recipesFor, usagesFor, slotItem, slotItems, slotObj, slotAmount, drawNeiItem,
  itemTooltipLines, itemKeyAt, itemName, itemIndexOf, shiftSlot, type HandlerRecipes,
} from './data.ts';
import { recipeSlots, recipeHeight, drawRecipeBackground, drawRecipeForeground, type PlacedSlot } from './handlers.ts';
import { drawSlotBadge, drawFluidAmount } from './gt.ts';
import type { NeiHandler } from './model.ts';

export type RecipeMode = 'recipe' | 'usage';

const X_SIZE = 176;
const TAB = 24;
const MAX_HEIGHT = 370;
const BUTTON_W = 13, BUTTON_H = 12;
const BORDER = 5, TRANSPARENCY = 4;

const enum Btn { DISABLED = 0, NORMAL = 1, HOVER = 2 }

interface Rect { x: number; y: number; w: number; h: number }
const inside = (r: Rect, mx: number, my: number) => mx >= r.x && mx < r.x + r.w && my >= r.y && my < r.y + r.h;

/** Where a recipe widget sits on the current page. */
interface Placed { recipe: number; x: number; y: number; h: number }

/** Called when an item in a recipe is clicked: open its recipes (left) or usages (right). */
export type OpenLookup = (from: Screen, key: string, mode: RecipeMode) => void;

export class RecipeScreen extends Screen {
  useMargins = false;
  /** Index into `list` of the open handler, and the page within it. */
  type = 0;
  page = 0;
  private tabPage = -1;
  private gl = 0;
  private gt = 0;
  private ySize = 0;
  private pages: number[][] = [];

  constructor(
    parent: Screen | null,
    public mode: RecipeMode,
    public itemKey: string,
    public list: HandlerRecipes[],
    private open: OpenLookup,
    start?: { handler?: string; page?: number },
  ) {
    super(parent);
    if (start?.handler) {
      const i = list.findIndex((e) => handlerList()[e.handler]?.id === start.handler);
      if (i >= 0) this.type = i;
    }
    if (start?.page) this.page = Math.max(0, start.page - 1);
  }

  route() {
    const h = this.handler();
    let r = `#/${this.mode}/${encodeURIComponent(this.itemKey)}`;
    if (h && (this.type > 0 || this.page > 0)) r += `/${encodeURIComponent(h.id)}`;
    if (this.page > 0) r += `/${this.page + 1}`;
    return r;
  }
  title() {
    const i = itemIndexOf(this.itemKey);
    const name = i !== undefined ? itemName(i) : this.itemKey;
    return `${name} · ${this.mode === 'recipe' ? 'Recipes' : 'Uses'}`;
  }

  private handler(): NeiHandler | undefined {
    return handlerList()[this.list[this.type]?.handler];
  }
  /** Recipe numbers of the open handler (all of them for a catalyst lookup). */
  private recipes(): number[] {
    const e = this.list[this.type];
    if (!e) return [];
    if (e.recipes) return e.recipes;
    const h = handlerList()[e.handler];
    return Array.from({ length: h?.count ?? 0 }, (_, i) => i);
  }

  build() {
    const W = this.width, H = this.height;
    this.ySize = Math.min(H - 22 - 22 - TAB, MAX_HEIGHT);
    this.gl = Math.floor((W - X_SIZE) / 2);
    this.gt = Math.max(22 - 3 + TAB, Math.floor((H - this.ySize) / 2));
    this.paginate();
  }

  /** RecipePageManager.rebuildPages: as many recipe widgets per page as fit (at least one). */
  private paginate() {
    const h = this.handler();
    const avail = this.ySize - 32 - 4;
    this.pages = [];
    if (!h) return;
    let page: number[] = [];
    let used = 0;
    for (const r of this.recipes()) {
      const rh = recipeHeight(h, null) + h.yShift;
      if (page.length && used + rh > avail) {
        this.pages.push(page);
        page = [];
        used = 0;
      }
      page.push(r);
      used += rh;
    }
    if (page.length) this.pages.push(page);
    this.page = Math.min(this.page, Math.max(0, this.pages.length - 1));
    if (this.tabPage < 0) this.tabPage = Math.floor(this.type / this.tabsPerPage());
  }

  private setType(i: number) {
    const n = this.list.length;
    this.type = ((i % n) + n) % n;
    this.page = 0;
    this.tabPage = Math.floor(this.type / this.tabsPerPage());
    this.paginate();
    this.host.notify(this);
  }
  private changePage(d: number) {
    const n = this.pages.length;
    if (n <= 1) return;
    this.page = (((this.page + d) % n) + n) % n;
    this.host.notify(this);
  }

  // ---------------------------------------------------------------- geometry

  private typeButtons(): [Rect, Rect] {
    const y = this.gt + 3;
    return [
      { x: this.gl + BORDER, y, w: BUTTON_W, h: BUTTON_H },
      { x: this.gl + X_SIZE - BORDER - BUTTON_W + 1, y, w: BUTTON_W, h: BUTTON_H },
    ];
  }
  private pageButtons(): [Rect, Rect] {
    const y = this.gt + 17;
    return [
      { x: this.gl + BORDER, y, w: BUTTON_W, h: BUTTON_H },
      { x: this.gl + X_SIZE - BORDER - BUTTON_W + 1, y, w: BUTTON_W, h: BUTTON_H },
    ];
  }
  private typeArea(): Rect {
    const [p, n] = this.typeButtons();
    return { x: p.x + BUTTON_W, y: p.y, w: n.x - p.x - BUTTON_W - 1, h: BUTTON_H };
  }
  private pageArea(): Rect {
    const [p, n] = this.pageButtons();
    return { x: p.x + BUTTON_W, y: p.y, w: n.x - p.x - BUTTON_W - 1, h: BUTTON_H };
  }
  private searchButton(): Rect {
    return { x: this.gl + BORDER + BUTTON_W, y: this.gt + 17, w: 12, h: 12 };
  }
  private container(): Rect {
    return { x: this.gl + 3, y: this.gt + 32, w: X_SIZE - 6, h: this.ySize - 32 - 4 };
  }

  private tabsPerPage() {
    return Math.max(1, Math.floor((X_SIZE - 4) / TAB));
  }
  private tabArea(): Rect {
    return { x: this.gl + 4, y: this.gt - TAB + 3, w: this.tabsPerPage() * TAB, h: TAB };
  }
  private tabArrows(): [Rect, Rect] | null {
    if (this.list.length <= this.tabsPerPage()) return null;
    const a = this.tabArea();
    return [
      { x: a.x - 8 + 1, y: a.y + 2, w: 8, h: TAB - 4 },
      { x: a.x + a.w - 1, y: a.y + 2, w: 8, h: TAB - 4 },
    ];
  }
  private tabs(): { i: number; r: Rect }[] {
    const per = this.tabsPerPage();
    const a = this.tabArea();
    const out = [];
    for (let k = 0; k < per; k++) {
      const i = this.tabPage * per + k;
      if (i >= this.list.length) break;
      out.push({ i, r: { x: a.x + k * TAB, y: a.y, w: TAB, h: TAB } });
    }
    return out;
  }

  /** GuiRecipeCatalyst: a grid of 16 px slots, filled column by column from the right. */
  private catalysts(): { rect: Rect; slots: { x: number; y: number; slot: number }[] } | null {
    const h = this.handler();
    const items = (h?.catalysts ?? []).map((c) => slotItems(c)[0]).filter((i) => i !== undefined && i >= 0);
    if (!items.length) return null;
    const avail = this.ySize - 5;
    const perCol = Math.floor(Math.max(0, avail - 2 - 12) / 16);
    if (perCol <= 0) return null;
    const cols = Math.ceil(items.length / perCol);
    const rows = Math.ceil(items.length / cols);
    const padBlock = 7, padStart = 7, padEnd = 3;
    const w = cols * 16 + padStart + padEnd;
    const hh = rows * 16 + padBlock * 2;
    const x = this.gl - w + 4, y = this.gt;
    const slots = items.map((slot, i) => ({
      x: x + padStart + cols * 16 - 16 - Math.floor(i / rows) * 16,
      y: y + padBlock + (i % rows) * 16,
      slot,
    }));
    return { rect: { x, y, w, h: hh }, slots };
  }

  /** The recipe widgets on the current page. */
  private placed(): Placed[] {
    const h = this.handler();
    const c = this.container();
    const out: Placed[] = [];
    if (!h) return out;
    let y = c.y;
    for (const r of this.pages[this.page] ?? []) {
      const rh = recipeHeight(h, null) + h.yShift;
      out.push({ recipe: r, x: c.x + 2, y, h: rh });
      y += rh;
    }
    return out;
  }

  /** The stack under the mouse: in a recipe or in the catalyst panel. */
  private hovered(mx: number, my: number): { item: number; ps?: PlacedSlot; h?: NeiHandler; px?: number; py?: number } | null {
    const h = this.handler();
    if (h) {
      for (const p of this.placed()) {
        const rec = getRecipe(this.list[this.type].handler, p.recipe);
        if (!rec) continue;
        const ox = p.x, oy = p.y + h.yShift;
        for (const ps of recipeSlots(h, rec, performance.now())) {
          if (inside({ x: ox + ps.x, y: oy + ps.y, w: 16, h: 16 }, mx, my)) {
            const item = slotItem(ps.slot, performance.now());
            if (item >= 0) return { item, ps, h, px: ox + ps.x, py: oy + ps.y };
          }
        }
      }
    }
    for (const s of this.catalysts()?.slots ?? []) {
      if (inside({ x: s.x, y: s.y, w: 16, h: 16 }, mx, my)) return { item: s.slot };
    }
    return null;
  }

  // ---------------------------------------------------------------- drawing

  draw(gfx: Gfx, mx: number, my: number) {
    const now = gfx.now;
    this.drawWindow(gfx);
    this.drawHeader(gfx, mx, my);
    this.drawTabs(gfx, mx, my);
    this.drawRecipes(gfx, mx, my, now);
    this.drawCatalysts(gfx, mx, my);
  }

  /** recipebg.png as a nine-slice with the window's 5 px border (plus 4 px of transparency). */
  private drawWindow(gfx: Gfx) {
    const img = texture('nei:textures/gui/recipebg.png');
    if (!img) return;
    const s = img.width / 256;
    nineSlice(gfx, img, 0, 0, 176 + 2 * TRANSPARENCY, 166 + 2 * TRANSPARENCY, s,
      this.gl - TRANSPARENCY, this.gt - TRANSPARENCY, X_SIZE + 2 * TRANSPARENCY, this.ySize + 2 * TRANSPARENCY, BORDER + TRANSPARENCY);
  }

  private drawHeader(gfx: Gfx, mx: number, my: number) {
    const ta = this.typeArea(), pa = this.pageArea();
    gfx.fill(ta.x, ta.y, ta.w, ta.h, 0x30000000);
    gfx.fill(pa.x, pa.y, pa.w, pa.h, 0x30000000);
    const h = this.handler();
    const textMiddle = Math.trunc((BUTTON_W - 9) / 2);
    if (h) {
      const title = h.name.trim();
      const tw = stringWidth(title);
      const tx = this.gl + Math.trunc((X_SIZE - tw) / 2), ty = ta.y + textMiddle;
      const hover = inside({ x: tx, y: ty, w: tw, h: 9 }, mx, my);
      drawString(gfx, title, this.gl + X_SIZE / 2 - Math.trunc(tw / 2), ty, hover ? 0xffffff55 : 0xffffffff, true);
    }
    // The recipe search is in game only; its toggle is drawn as NEI draws it.
    const sb = this.searchButton();
    neiButton(gfx, sb, inside(sb, mx, my) ? Btn.HOVER : Btn.NORMAL);
    const sprites = texture('nei:textures/nei_sprites.png');
    if (sprites) {
      const k = sprites.width / 256;
      gfx.image(sprites, 0, 76 * k, 10 * k, 10 * k, sb.x + 1, sb.y + 1, 10, 10);
    }
    const pageText = `Page ${this.page + 1}/${Math.max(1, this.pages.length)}`;
    drawString(gfx, pageText, this.gl + X_SIZE / 2 - Math.trunc(stringWidth(pageText) / 2), pa.y + textMiddle, 0xffffffff, true);

    for (const [i, b] of this.typeButtons().entries()) guiButton(gfx, b, i ? '>' : '<', inside(b, mx, my) ? Btn.HOVER : Btn.NORMAL);
    const paged = this.pages.length > 1;
    for (const [i, b] of this.pageButtons().entries()) guiButton(gfx, b, i ? '>' : '<', !paged ? Btn.DISABLED : inside(b, mx, my) ? Btn.HOVER : Btn.NORMAL);
  }

  private drawTabs(gfx: Gfx, mx: number, my: number) {
    const img = texture('nei:textures/nei_tabbed_sprites.png');
    for (const { i, r } of this.tabs()) {
      if (img) {
        const k = img.width / 256;
        const sel = i === this.type;
        gfx.image(img, (sel ? 0 : 24) * k, 16 * k, 24 * k, 24 * k, r.x, r.y, 24, 24);
      }
      const h = handlerList()[this.list[i].handler];
      const icon = h?.icon !== undefined ? slotItems(h.icon)[0] : undefined;
      if (icon !== undefined && icon >= 0) drawNeiItem(gfx, icon, r.x + 4, r.y + 4);
      else if (h) {
        const t = h.name.slice(0, 2);
        drawString(gfx, t, r.x + 12 - Math.trunc(stringWidth(t) / 2), r.y + 12 - 3, i === this.type ? 0xffffffa0 : 0xffe0e0e0, true);
      }
    }
    const arrows = this.tabArrows();
    if (arrows) for (const [i, b] of arrows.entries()) neiButton(gfx, b, inside(b, mx, my) ? Btn.HOVER : Btn.NORMAL, i ? '>' : '<');
  }

  private drawRecipes(gfx: Gfx, mx: number, my: number, now: number) {
    const h = this.handler();
    if (!h) return;
    const hi = this.list[this.type].handler;
    const c = this.container();
    gfx.clip(c.x, c.y, c.w, c.h);
    for (const p of this.placed()) {
      const rec = getRecipe(hi, p.recipe);
      if (!rec) continue;
      const ox = p.x, oy = p.y + h.yShift;
      drawRecipeBackground(gfx, h, rec, ox, oy, now);
      const slots = recipeSlots(h, rec, now);
      for (const ps of slots) {
        const item = slotItem(ps.slot, now);
        const o = typeof ps.slot === 'object' ? ps.slot : null;
        const n = slotAmount(ps.slot);
        const x = ox + ps.x, y = oy + ps.y;
        if (item >= 0) {
          const fluid = ps.fluid || itemKeyAt(item).startsWith('fluid:');
          drawNeiItem(gfx, item, x, y, !fluid && n > 1 ? String(n) : '');
          if (fluid && h.kind === 'gt' && n > 0) drawFluidAmount(gfx, n, x, y);
        }
        if (h.badges ?? h.kind === 'gt') {
          if (o?.nc) drawSlotBadge(gfx, 'NC', x, y);
          else if (o?.c !== undefined) drawSlotBadge(gfx, formatChance(o.c), x, y);
        }
        if (inside({ x, y, w: 16, h: 16 }, mx, my)) gfx.fill(x, y, 16, 16, 0x80ffffff);
      }
      drawRecipeForeground(gfx, h, rec, ox, oy, now);
      this.drawRecipeButtons(gfx, p, mx, my);
    }
    gfx.endClip();
  }

  /**
   * The buttons at a recipe's right edge (RecipeWidget.getDefaultButtons): overlay, favourite and
   * GTNH's "P". There is no inventory to fill or favourites to keep here, so they are drawn the
   * way NEI draws them when they do not apply.
   */
  private drawRecipeButtons(gfx: Gfx, p: Placed, _mx: number, _my: number) {
    const x = p.x + 166 - 12;
    let y = p.y + p.h - 12 - 6;
    const sprites = texture('nei:textures/nei_sprites.png');
    const k = sprites ? sprites.width / 256 : 1;
    for (const icon of [46, 10, -1]) {
      guiButton(gfx, { x, y, w: 12, h: 12 }, '', Btn.DISABLED);
      if (icon >= 0 && sprites) {
        const ix = x + Math.trunc((12 - 9 - 1) / 2), iy = y + Math.trunc((12 - 10) / 2);
        gfx.image(sprites, icon * k, 76 * k, 9 * k, 10 * k, ix, iy, 9, 10);
      } else if (icon < 0) {
        drawString(gfx, 'P', x + 6 - Math.trunc(stringWidth('P') / 2), y + 2, 0xffe0e0e0, true);
      }
      y -= 12 + 1;
    }
  }

  private drawCatalysts(gfx: Gfx, mx: number, my: number) {
    const cat = this.catalysts();
    if (!cat) return;
    const { rect } = cat;
    const bg = texture('nei:textures/catalyst_tab.png');
    if (bg) nineSlice(gfx, bg, 0, 0, bg.width, bg.height, bg.width / 36, rect.x - TRANSPARENCY, rect.y - TRANSPARENCY, rect.w + 2 * TRANSPARENCY, rect.h + 2 * TRANSPARENCY, 6 + TRANSPARENCY);
    const fg = texture('nei:textures/slot.png');
    if (fg) nineSlice(gfx, fg, 0, 0, fg.width, fg.height, fg.width / 18, rect.x + 7 - 1, rect.y + 7 - 1, rect.w - 7 - 3 + 2, rect.h - 14 + 2, 1);
    for (const s of cat.slots) {
      drawNeiItem(gfx, s.slot, s.x, s.y);
      if (inside({ x: s.x, y: s.y, w: 16, h: 16 }, mx, my)) gfx.fill(s.x, s.y, 16, 16, 0x80ffffff);
    }
  }

  // ---------------------------------------------------------------- input

  mouseDown(mx: number, my: number, b: number) {
    if (b !== 0 && b !== 1) return true;
    const hit = this.hovered(mx, my);
    if (hit) {
      this.open(this, itemKeyAt(hit.item), b === 0 ? 'recipe' : 'usage');
      return true;
    }
    if (b === 0) {
      for (const { i, r } of this.tabs()) if (inside(r, mx, my)) return this.setType(i), true;
      const arrows = this.tabArrows();
      if (arrows) {
        const pages = Math.ceil(this.list.length / this.tabsPerPage());
        if (inside(arrows[0], mx, my)) return (this.tabPage = (this.tabPage + pages - 1) % pages), true;
        if (inside(arrows[1], mx, my)) return (this.tabPage = (this.tabPage + 1) % pages), true;
      }
      const [p, n] = this.typeButtons();
      if (inside(p, mx, my)) return this.setType(this.type - 1), true;
      if (inside(n, mx, my)) return this.setType(this.type + 1), true;
      const [pp, np] = this.pageButtons();
      if (inside(pp, mx, my)) return this.changePage(-1), true;
      if (inside(np, mx, my)) return this.changePage(1), true;
    }
    // A right click outside the window goes back, like the rest of the site.
    if (b === 1 && !this.inWindow(mx, my)) {
      this.host.back();
      return true;
    }
    return true;
  }
  mouseUp() {
    return true;
  }

  private inWindow(mx: number, my: number) {
    const cat = this.catalysts();
    return (
      inside({ x: this.gl - TRANSPARENCY, y: this.gt - TAB, w: X_SIZE + 2 * TRANSPARENCY, h: this.ySize + TAB + TRANSPARENCY }, mx, my) ||
      (!!cat && inside(cat.rect, mx, my))
    );
  }

  scroll(mx: number, my: number, d: number) {
    // Shift + scroll over a cycling stack shows its next or previous item (RecipeWidget.onMouseWheel).
    if (heldKeys.shift) {
      const hit = this.hovered(mx, my);
      if (hit?.ps && new Set(slotItems(hit.ps.slot)).size > 1) {
        shiftSlot(hit.ps.slot, d > 0 ? 1 : -1);
        return true;
      }
    }
    // Over the tabs: switch handler. Shift or over the handler name: switch handler. Elsewhere in
    // the recipes or over the page row: turn the page.
    if (inside(this.tabArea(), mx, my) || heldKeys.shift || inside(this.typeArea(), mx, my)) {
      this.setType(this.type + (d > 0 ? 1 : -1));
      return true;
    }
    if (inside(this.container(), mx, my) || inside(this.pageArea(), mx, my)) {
      this.changePage(d > 0 ? 1 : -1);
      return true;
    }
    return false;
  }

  key(e: KeyboardEvent) {
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') {
      // Escape closes every recipe screen at once (NEI returns to the first GUI).
      let cur = this.host.screen;
      while (cur instanceof RecipeScreen && cur.parent) {
        this.host.back();
        cur = this.host.screen;
      }
      return true;
    }
    if (e.key === 'Backspace') {
      this.host.back();
      return true;
    }
    if ((k === 'r' || k === 'u') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const hit = this.lastMouse ? this.hovered(this.lastMouse[0], this.lastMouse[1]) : null;
      if (hit) {
        this.open(this, itemKeyAt(hit.item), k === 'r' ? 'recipe' : 'usage');
        return true;
      }
    }
    if (e.key === 'PageUp') return this.changePage(-1), true;
    if (e.key === 'PageDown') return this.changePage(1), true;
    if (e.key === 'ArrowLeft' && e.shiftKey) return this.setType(this.type - 1), true;
    if (e.key === 'ArrowRight' && e.shiftKey) return this.setType(this.type + 1), true;
    return false;
  }

  private lastMouse: [number, number] | null = null;

  tooltip(mx: number, my: number): Tooltip {
    this.lastMouse = [mx, my];
    const hit = this.hovered(mx, my);
    if (hit) {
      const lines: (string | TipLine)[] = itemTooltipLines(hit.item);
      const o = hit.ps && typeof hit.ps.slot === 'object' ? slotObj(hit.ps.slot) : null;
      if (hit.ps && (hit.h?.badges ?? hit.h?.kind === 'gt')) {
        const n = slotAmount(hit.ps.slot);
        if (hit.ps.fluid || itemKeyAt(hit.item).startsWith('fluid:')) lines.splice(1, 0, `§7${n.toLocaleString('en-US')} L`);
        if (o?.nc) lines.push('§7Does not get consumed in the process');
        else if (o?.c !== undefined) lines.push(`§7${hit.ps.input ? 'Consume' : 'Output'} Chance: ${formatChance(o.c)}`);
      }
      const alts = hit.ps ? slotItems(hit.ps.slot) : [];
      const cycling = new Set(alts).size > 1;
      if (cycling) lines.push(acceptsFollowing(alts, hit.item));
      // GuiContainerManager.renderToolTips: the hotkeys (or how to show them) under the name, and a
      // gap after the name.
      lines.splice(1, 0, ...hotkeyLines(cycling));
      lines[0] += LINESPACE;
      return lines;
    }
    for (const { i, r } of this.tabs()) {
      if (inside(r, mx, my)) {
        const h = handlerList()[this.list[i].handler];
        if (!h) return null;
        return [(h.tab ?? h.name) + LINESPACE, `§9${h.mod ?? handlerMod(h)}`];
      }
    }
    if (inside(this.searchButton(), mx, my)) return ['Recipe search' + LINESPACE, '§7Only in game'];
    return null;
  }

  drawTooltip(gfx: Gfx, lines: (string | TipLine)[], mx: number, my: number) {
    drawMultilineTip(gfx, lines, mx + 12, my - 12, this.width, this.height);
  }
}

/**
 * NEI's "Accepts following" tooltip line (AcceptsFollowingTooltipLineHandler, an
 * ItemsTooltipLineHandler grid): every item a cycling slot takes, at most 11 across and 4 rows,
 * the one shown now highlighted, and "+n" for the ones that do not fit.
 */
export function acceptsFollowing(list: number[], active: number): TipLine {
  const SLOT = 18, MAX_COLUMNS = 11, MAX_ROWS = 4, LABEL_MARGIN = 15, MARGIN_TOP = 2;
  const label = 'Accepts following';
  const items = [...new Set(list)];
  const len = items.length;
  const cols = Math.min(MAX_COLUMNS, len);
  const rows = Math.min(MAX_ROWS, Math.ceil(len / cols));
  let count = Math.min(len, cols * rows);
  if (count < len) count -= Math.ceil((stringWidth(`+${len - count}`) - 2) / SLOT);
  const width = Math.max(cols * SLOT, stringWidth(label) + LABEL_MARGIN);
  const activeIndex = items.indexOf(active);
  // gridIndexShift: scroll the grid so the shown item stays in view.
  const shift = activeIndex < 0 ? 0 : Math.max(0, Math.min(len - count, activeIndex - count + 2));
  return {
    width,
    height: rows * SLOT + 9 + 2 + MARGIN_TOP,
    draw(gfx, x, y) {
      y += MARGIN_TOP;
      drawString(gfx, `§7${label}:`, x, y, 0xffffffff, true);
      const gy = y + 9 + 2;
      for (let n = 0; n < count; n++) {
        const i = shift + n;
        const sx = x + (n % cols) * SLOT, sy = gy + Math.floor(n / cols) * SLOT;
        if (i === activeIndex) gfx.fill(sx, sy, SLOT, SLOT, 0x66555555);
        drawNeiItem(gfx, items[i], sx + 1, sy + 1);
      }
      const hidden = len - count;
      if (hidden > 0) {
        const t = `+${hidden}`;
        drawString(gfx, `§7${t}`, x + width - stringWidth(t) - 2, gy + (rows - 1) * SLOT + 1 + Math.round((16 - 9) / 2), 0xffffffff, true);
      }
    },
  };
}

/** CodeChickenLib's GuiDraw.TOOLTIP_LINESPACE: a line ending in it is followed by a 2 px gap. */
const LINESPACE = '\u00a7h';

/**
 * The hotkeys NEI lists for a stack in the recipe window, as far as the site has them: with Alt
 * held the list (GuiContainerManager.collectHotkeyTips), otherwise how to show it.
 */
function hotkeyLines(cycling: boolean): string[] {
  if (!heldKeys.alt) return ['§7Hold §6ALT§7 for hotkeys'];
  const tips: [string, string][] = [
    ['R', 'Recipe to make this item'],
    ['U', 'Recipes that use this item'],
  ];
  if (cycling) tips.push(['SHIFT + Scroll', 'Change Item']);
  tips.sort((a, b) => a[0].length - b[0].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out = tips.map(([k, m]) => `§6${k}§8 - §7${m}§r`);
  out[out.length - 1] += LINESPACE;
  return out;
}

/**
 * CodeChickenLib's GuiDraw.drawMultilineTip, which NEI draws its tooltips with: no wrapping, 10 px
 * lines (12 after a LINESPACE), drawn code lines at their own size, flipped to the cursor's left
 * when it would leave the screen.
 */
function drawMultilineTip(gfx: Gfx, list: (string | TipLine)[], x: number, y: number, sw: number, sh: number) {
  if (!list.length) return;
  const text = (s: string) => (s.endsWith(LINESPACE) ? s.slice(0, -LINESPACE.length) : s);
  let w = 0;
  let h = -2;
  list.forEach((s, i) => {
    if (typeof s === 'string') {
      w = Math.max(w, stringWidth(text(s)));
      h += s.endsWith(LINESPACE) && i + 1 < list.length ? 12 : 10;
    } else {
      w = Math.max(w, s.width);
      h += s.height;
    }
  });
  if (x < 8) x = 8;
  else if (x > sw - w - 8) {
    x -= 24 + w;
    if (x < 8) x = 8;
  }
  y = Math.min(Math.max(y, 8), sh - 8 - h);
  tooltipBox(gfx, x - 4, y - 4, w + 7, h + 7);
  for (const s of list) {
    if (typeof s === 'string') {
      drawString(gfx, text(s), x, y, 0xffffffff, true);
      y += s.endsWith(LINESPACE) ? 12 : 10;
    } else {
      s.draw(gfx, x, y);
      y += s.height;
    }
  }
}

/** GuiDraw.drawTooltipBox with CodeChickenCore's default colours. */
function tooltipBox(gfx: Gfx, x: number, y: number, w: number, h: number) {
  const bg = 0xf0100010, b0 = 0x505000ff, b1 = 0x5028007f;
  const r = (rx: number, ry: number, rw: number, rh: number, c0: number, c1: number) => gfx.gradient(rx, ry, rw, rh, c0 >>> 0, c1 >>> 0);
  r(x + 1, y, w - 1, 1, bg, bg);
  r(x + 1, y + h, w - 1, 1, bg, bg);
  r(x + 1, y + 1, w - 1, h - 1, bg, bg);
  r(x, y + 1, 1, h - 1, bg, bg);
  r(x + w, y + 1, 1, h - 1, bg, bg);
  r(x + 1, y + 2, 1, h - 3, b0, b1);
  r(x + w - 1, y + 2, 1, h - 3, b0, b1);
  r(x + 1, y + 1, w - 1, 1, b0, b0);
  r(x + 1, y + h - 1, w - 1, 1, b1, b1);
}

const handlerMod = (h: NeiHandler) => (h.kind === 'gt' ? 'GregTech' : 'Minecraft');

/** NEIClientUtils.formatChance. */
export function formatChance(c: number) {
  const pct = c / 100;
  return `${Number.isInteger(pct) ? pct : Number(pct.toFixed(2))}%`;
}

// ---------------------------------------------------------------- NEI drawing helpers

/**
 * DrawableResource.draw with slices: corners as they are, edges and middle tiled. (u, v, tw, th)
 * is the source in texture units and `k` texture pixels per unit.
 */
function nineSlice(
  gfx: Gfx, img: CanvasImageSource, u: number, v: number, tw: number, th: number, k: number,
  x: number, y: number, w: number, h: number, b: number,
) {
  const mw = tw - 2 * b, mh = th - 2 * b;
  const iw = w - 2 * b, ih = h - 2 * b;
  if (mw <= 0 || mh <= 0 || iw <= 0 || ih <= 0) return;
  const blit = (sx: number, sy: number, sw: number, sh: number, dx: number, dy: number) =>
    gfx.image(img, (u + sx) * k, (v + sy) * k, sw * k, sh * k, dx, dy, sw, sh);
  for (let ox = 0; ox < iw; ox += mw) {
    const cw = Math.min(mw, iw - ox);
    for (let oy = 0; oy < ih; oy += mh) blit(b, b, cw, Math.min(mh, ih - oy), x + b + ox, y + b + oy);
    blit(b, 0, cw, b, x + b + ox, y);
    blit(b, b + mh, cw, b, x + b + ox, y + b + ih);
  }
  for (let oy = 0; oy < ih; oy += mh) {
    const ch = Math.min(mh, ih - oy);
    blit(0, b, b, ch, x, y + b + oy);
    blit(b + mw, b, b, ch, x + b + iw, y + b + oy);
  }
  blit(0, 0, b, b, x, y);
  blit(b + mw, 0, b, b, x + b + iw, y);
  blit(0, b + mh, b, b, x, y + b + ih);
  blit(b + mw, b + mh, b, b, x + b + iw, y + b + ih);
}

/** GuiNEIButton: four corners of a widgets.png button, at most w/2 x h/2 each, and a centred label. */
function guiButton(gfx: Gfx, r: Rect, label: string, state: Btn) {
  const img = texture('minecraft:textures/gui/widgets.png');
  if (img) {
    const k = img.width / 256;
    const v = 46 + state * 20;
    const hw = Math.trunc(r.w / 2), hh = Math.trunc(r.h / 2);
    gfx.image(img, 0, v * k, hw * k, hh * k, r.x, r.y, hw, hh);
    gfx.image(img, (200 - hw) * k, v * k, hw * k, hh * k, r.x + hw, r.y, hw, hh);
    gfx.image(img, 0, (v + 20 - hh) * k, hw * k, hh * k, r.x, r.y + hh, hw, hh);
    gfx.image(img, (200 - hw) * k, (v + 20 - hh) * k, hw * k, hh * k, r.x + hw, r.y + hh, hw, hh);
  }
  if (label) {
    const color = state === Btn.DISABLED ? 0xffa0a0a0 : state === Btn.HOVER ? 0xffffffa0 : 0xffe0e0e0;
    drawString(gfx, label, r.x + Math.trunc(r.w / 2) - Math.trunc(stringWidth(label) / 2), r.y + Math.trunc((r.h - 8) / 2), color, true);
  }
}

/** LayoutManager.drawButtonBackground with edges (nei.Button), and an optional label. */
function neiButton(gfx: Gfx, r: Rect, state: Btn, label = '') {
  const img = texture('minecraft:textures/gui/widgets.png');
  if (img) {
    const k = img.width / 256;
    const ty = 46 + state * 20;
    const w1 = Math.trunc(r.w / 2), h1 = Math.trunc(r.h / 2), w2 = Math.trunc((r.w + 1) / 2), h2 = Math.trunc((r.h + 1) / 2);
    const x2 = r.x + r.w - w2, y2 = r.y + r.h - h2;
    const ty2 = ty + 20 - h2, tx2 = 200 - w2;
    gfx.image(img, 0, ty * k, w1 * k, h1 * k, r.x, r.y, w1, h1);
    gfx.image(img, 0, ty2 * k, w1 * k, h2 * k, r.x, y2, w1, h2);
    gfx.image(img, tx2 * k, ty * k, w2 * k, h1 * k, x2, r.y, w2, h1);
    gfx.image(img, tx2 * k, ty2 * k, w2 * k, h2 * k, x2, y2, w2, h2);
  }
  if (label) {
    const color = state === Btn.HOVER ? 0xffffffa0 : state === Btn.DISABLED ? 0xff601010 : 0xffe0e0e0;
    drawString(gfx, label, r.x + Math.trunc(r.w / 2) - Math.trunc(stringWidth(label) / 2), r.y + Math.trunc((r.h - 8) / 2), color, true);
  }
}

// ---------------------------------------------------------------- opening

/** Look up an item and open the recipe window for it; returns false when there is nothing to show. */
export async function openLookup(
  from: Screen, key: string, mode: RecipeMode, start?: { handler?: string; page?: number }, push = true,
): Promise<boolean> {
  const list = mode === 'recipe' ? await recipesFor(key) : await usagesFor(key);
  if (!list.length) return false;
  const screen = new RecipeScreen(from, mode, key, list, (s, k, m) => void openLookup(s, k, m), start);
  from.host.show(screen, push);
  return true;
}
