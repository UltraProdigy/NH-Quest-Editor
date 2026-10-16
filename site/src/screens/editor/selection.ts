// GuiItemSelection, GuiFluidSelection and GuiEntitySelection: pick a stack, fluid or mob from the
// game's lists. The items come from NEI's item list (the site's game data); a player inventory
// does not exist here, so its place shows NEI's bookmarks.

import { Screen } from '../../gui/screen.ts';
import { BasePanel, CanvasEmpty, Rect, Transform, Align, contains, type Gfx, type GuiRect, type Panel, type Tooltip } from '../../gui/core.ts';
import { tex, col, ColorTexture, LayeredTexture } from '../../gui/theme.ts';
import { PanelButton, PanelTextBox, PanelVScrollBar, CanvasScrolling, PanelGeneric } from '../../gui/widgets.ts';
import { PanelTextField } from '../../gui/textfield.ts';
import { tr } from '../../gui/lang.ts';
import { drawItemKey, itemName as quickItemName, itemIndexKeys, itemTooltip, WILDCARD } from '../../gui/items.ts';
import { stripFormatting } from '../../gui/font.ts';
import { loadNei, loadList, loadTooltips, tooltipData, itemKeyAt, itemIndexOf, itemTooltipLines, neiLoaded } from '../../nei/data.ts';
import { bookmarkedKeys } from '../../nei/bookmarks.ts';
import type { BqObject } from '../../lib/bqjson.ts';
import { itemStackTag, fluidStackTag } from '../../edit/ops.ts';
import { entityIds, entityName } from '../taskPanels.ts';
import { addBackground, addTitle, addBottomButton, addDivider, label } from './common.ts';

// ---------------------------------------------------------------- stacks

/** BigItemStack, as the selection screen holds it. */
export interface Stack {
  id: string;
  dmg: number;
  count: number;
  ore: string;
  tag?: BqObject;
}

export function stackFromTag(t: BqObject | null | undefined): Stack | null {
  if (!t || typeof t['id:8'] !== 'string') return null;
  return {
    id: t['id:8'] as string,
    dmg: Number(t['Damage:2'] ?? 0),
    count: Number(t['Count:3'] ?? 1),
    ore: String(t['OreDict:8'] ?? ''),
    ...(t['tag:10'] && typeof t['tag:10'] === 'object' ? { tag: t['tag:10'] as BqObject } : {}),
  };
}

export const stackTag = (s: Stack): BqObject => itemStackTag(s.id, s.dmg, s.count, s.ore, s.tag);

/** The item key a stack is drawn and named by. */
const stackKey = (s: Stack) => `${s.id}@${s.dmg === WILDCARD ? 0 : s.dmg}`;
const keyStack = (key: string): Stack => {
  const m = /^(.*)@(\d+)(?:#.*)?$/.exec(key);
  return m ? { id: m[1], dmg: Number(m[2]), count: 1, ore: '' } : { id: key, dmg: 0, count: 1, ore: '' };
};

const isFluidKey = (k: string) => k.startsWith('fluid:');

// ---------------------------------------------------------------- the database grid

/**
 * CanvasItemDatabase / CanvasFluidDatabase: 18 px slots of every entry matching the search, as
 * many across as fit. Only the visible rows are drawn, so the whole item list fits.
 */
class PanelKeyGrid extends BasePanel {
  keys: string[] = [];
  bar: PanelVScrollBar | null = null;
  constructor(t: GuiRect, private onPick: (key: string) => void) {
    super(t);
  }
  private cols() {
    return Math.max(1, Math.floor(this.transform.w() / 18));
  }
  private rows() {
    return Math.ceil(this.keys.length / this.cols());
  }
  private top() {
    const extra = Math.max(0, this.rows() * 18 - this.transform.h());
    return Math.round((this.bar?.value ?? 0) * extra);
  }
  draw(gfx: Gfx, mx: number, my: number) {
    const r = this.transform;
    const cols = this.cols(), top = this.top();
    if (this.bar) this.bar.active = this.rows() * 18 > r.h();
    gfx.clip(r.x(), r.y(), r.w(), r.h());
    const first = Math.floor(top / 18), last = Math.ceil((top + r.h()) / 18);
    const frame = tex('item_frame');
    for (let row = first; row <= last; row++) {
      for (let c = 0; c < cols; c++) {
        const i = row * cols + c;
        if (i >= this.keys.length) break;
        const x = r.x() + c * 18, y = r.y() + row * 18 - top;
        frame.draw(gfx, x, y, 18, 18);
        drawKey(gfx, this.keys[i], x + 1, y + 1, 16);
        if (mx >= x && mx < x + 18 && my >= y && my < y + 18 && contains(r, mx, my)) gfx.fill(x + 1, y + 1, 16, 16, col('item_highlight').argb());
      }
    }
    gfx.endClip();
  }
  private at(mx: number, my: number): string | null {
    const r = this.transform;
    if (!contains(r, mx, my)) return null;
    const c = Math.floor((mx - r.x()) / 18), row = Math.floor((my - r.y() + this.top()) / 18);
    if (c >= this.cols()) return null;
    return this.keys[row * this.cols() + c] ?? null;
  }
  mouseDown(mx: number, my: number, b: number) {
    const k = this.at(mx, my);
    if (k && b === 0) {
      this.onPick(k);
      return true;
    }
    return !!k;
  }
  scroll(mx: number, my: number, d: number) {
    if (!contains(this.transform, mx, my) || !this.bar) return false;
    const extra = this.rows() * 18 - this.transform.h();
    if (extra <= 0) return false;
    this.bar.write(this.bar.value + (d * 18) / extra);
    return true;
  }
  tooltip(mx: number, my: number): Tooltip {
    const k = this.at(mx, my);
    return k ? keyTooltip(k) : null;
  }
}

function drawKey(gfx: Gfx, key: string, x: number, y: number, size: number) {
  drawItemKey(gfx, key, x, y, size);
}

function keyTooltip(key: string): string[] {
  const i = itemIndexOf(key);
  if (i !== undefined && neiLoaded()) return itemTooltipLines(i);
  return itemTooltip(key);
}

const keyName = (key: string) => {
  const i = itemIndexOf(key);
  return stripFormatting(i !== undefined && neiLoaded() ? itemTooltipLines(i)[0] : quickItemName(key));
};

/** A big slot showing one key, with its tooltip. */
class PanelKeySlot extends PanelButton {
  constructor(t: GuiRect, public shows: () => string | null) {
    super(t, {});
    const frame = tex('item_frame');
    this.textures = [frame, frame, new LayeredTexture([frame, new ColorTexture(col('item_highlight'), [1, 1, 1, 1])])];
    this.active = true;
  }
  draw(gfx: Gfx, mx: number, my: number) {
    super.draw(gfx, mx, my);
    const k = this.shows();
    const r = this.transform;
    if (!k) return;
    drawKey(gfx, k, r.x() + 1, r.y() + 1, Math.min(r.w(), r.h()) - 2);
  }
  tooltip(mx: number, my: number): Tooltip {
    const k = this.shows();
    return k && contains(this.transform, mx, my) ? keyTooltip(k) : null;
  }
}

/** Every item key NEI lists (or, without NEI data, the quest item index). */
async function allKeys(fluids: boolean): Promise<string[]> {
  if (await loadNei()) {
    void loadTooltips();
    const list = await loadList();
    if (list) return list.items.map(itemKeyAt).filter((k) => isFluidKey(k) === fluids);
  }
  return itemIndexKeys().filter((k) => isFluidKey(k) === fluids && !k.includes('#'));
}

/** The ore dictionary names an item has (OreDictionary.getOreIDs), from NEI's tooltip data. */
function oreNames(key: string): string[] {
  const tips = tooltipData();
  const i = itemIndexOf(key);
  if (!tips || i === undefined) return [];
  return (tips.ore[i] ?? []).map((o) => tips.ores[o]);
}

/** CanvasItemDatabase's search: registry name, display name or ore names containing the text. */
function matches(key: string, q: string): boolean {
  if (!q) return true;
  if (key.toLowerCase().includes(q)) return true;
  if (keyName(key).toLowerCase().includes(q)) return true;
  return oreNames(key).some((o) => o.toLowerCase().includes(q));
}

// ---------------------------------------------------------------- items

export class ItemSelectionScreen extends Screen {
  private stack: Stack | null;
  private all: string[] = [];
  private search = '';
  private grid: PanelKeyGrid | null = null;
  private timer = 0;
  private oreIdx = -1;
  private sizeField: PanelTextField | null = null;
  private oreBtn: PanelButton | null = null;

  constructor(parent: Screen | null, initial: BqObject | null | undefined, private callback: (tag: BqObject | null) => void) {
    super(parent);
    this.stack = stackFromTag(initial);
    if (this.stack?.ore) this.oreIdx = oreNames(stackKey(this.stack)).findIndex((o) => o.toLowerCase() === this.stack!.ore.toLowerCase());
    void allKeys(false).then((k) => {
      this.all = k;
      this.refresh();
      // The ore button needs NEI's tooltip data.
      void loadTooltips().then(() => this.host?.screen === this && this.host.refresh());
    });
  }
  title() {
    return tr('betterquesting.title.select_item');
  }
  route() {
    return (this.parent?.route() ?? '#/') + '/item';
  }

  private refresh() {
    if (!this.grid) return;
    const q = this.search.toLowerCase();
    this.grid.keys = this.all.filter((k) => matches(k, q));
  }

  build() {
    const bg = addBackground(this);
    addBottomButton(bg, tr('gui.done'), () => {
      this.host.back();
      this.callback(this.stack ? stackTag(this.stack) : null);
    });
    addTitle(bg, tr('betterquesting.title.select_item'));

    const right = bg.add(new CanvasEmpty(new Transform(Align.HALF_RIGHT, [8, 32, 16, 32])));
    const grid = (this.grid = right.add(new PanelKeyGrid(new Transform(Align.FULL_BOX, [0, 16, 8, 0]), (k) => this.pick(k))));
    const search = right.add(new PanelTextField(new Transform(Align.TOP_EDGE, [0, 0, 8, -16]), this.search));
    search.watermark = 'Search...';
    search.onChange = (s) => {
      this.search = s;
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.refresh(), 120);
    };
    const bar = right.add(new PanelVScrollBar(new Transform(Align.RIGHT_EDGE, [-8, 16, 0, 0])));
    grid.bar = bar;
    this.refresh();

    const topLeft = bg.add(new CanvasEmpty(new Transform([0, 0, 0.5, 0.4], [16, 32, 8, 8])));
    topLeft.add(label(new Transform(Align.TOP_EDGE, [0, 0, 0, -16]), tr('betterquesting.gui.selection')));
    topLeft.add(new PanelKeySlot(Transform.at(Align.TOP_LEFT, 0, 16, 36, 36), () => (this.stack ? stackKey(this.stack) : null)));
    topLeft.add(label(Transform.at(Align.TOP_LEFT, 36, 20, 16, 12), 'x', 1));
    const size = (this.sizeField = topLeft.add(new PanelTextField(new Transform(Align.TOP_EDGE, [52, 16, 0, -32]), this.stack ? String(this.stack.count) : '1')));
    size.filter = 'int';
    size.onChange = () => {
      if (this.stack) this.stack.count = Number(size.value());
    };
    const ores = this.stack ? oreNames(stackKey(this.stack)) : [];
    const ore = (this.oreBtn = topLeft.add(
      new PanelButton(new Transform(Align.TOP_EDGE, [52, 36, 24, -52]), {
        text: `Ore: ${this.stack?.ore || 'NONE'}`,
        onClick: () => {
          if (!this.stack) return;
          const names = oreNames(stackKey(this.stack));
          this.oreIdx++;
          if (this.oreIdx >= names.length || this.oreIdx < 0) {
            this.oreIdx = -1;
            this.stack.ore = '';
          } else this.stack.ore = names[this.oreIdx];
          ore.text = `Ore: ${this.stack.ore || 'NONE'}`;
        },
      }),
    ));
    if (this.stack && !ores.length && !this.stack.ore) ore.tooltipLines = ['§7No ore dictionary names known for this item'];
    topLeft.add(
      new PanelButton(Transform.at(Align.TOP_RIGHT, -16, 36, 16, 16), {
        text: '*',
        tooltip: ['Any damage value (32767)'],
        onClick: () => {
          if (this.stack) this.stack.dmg = WILDCARD;
        },
      }),
    );

    // Where the game shows the player's inventory: NEI's bookmarks.
    const bottomLeft = bg.add(new CanvasEmpty(new Transform([0, 0.4, 0.5, 1], [16, 8, 8, 32])));
    bottomLeft.add(label(new Transform(Align.TOP_EDGE, [0, 0, 0, -16]), 'NEI bookmarks'));
    const marks = bookmarkedKeys().filter((k) => !isFluidKey(k));
    const w = bottomLeft.transform.w(), h = bottomLeft.transform.h();
    const scale = Math.min(w / 162, (h - 20) / 72);
    const slot = Math.floor(18 * scale);
    for (let i = 0; i < 36; i++) {
      const x = (i % 9) * slot;
      const y = i < 27 ? Math.floor(i / 9) * slot + 16 : 20 + 3 * slot;
      const k = marks[i < 27 ? i + 9 : i - 27] ?? null;
      const s = bottomLeft.add(new PanelKeySlot(Transform.at(Align.TOP_LEFT, x, y, slot, slot), () => k));
      s.onClick = () => k && this.pick(k);
    }
    addDivider(bg, 32, 32);
  }

  private pick(key: string) {
    this.stack = keyStack(key);
    this.oreIdx = -1;
    this.sizeField?.setText('1');
    if (this.oreBtn) {
      this.oreBtn.text = 'Ore: NONE';
      this.oreBtn.tooltipLines = oreNames(key).length ? null : ['§7No ore dictionary names known for this item'];
    }
  }
}

// ---------------------------------------------------------------- fluids

export function fluidFromTag(t: BqObject | null | undefined): { name: string; amount: number; tag?: BqObject } | null {
  if (!t || typeof t['FluidName:8'] !== 'string') return null;
  return { name: t['FluidName:8'] as string, amount: Number(t['Amount:3'] ?? 0), ...(t['Tag:10'] ? { tag: t['Tag:10'] as BqObject } : {}) };
}

export class FluidSelectionScreen extends Screen {
  private fluid: { name: string; amount: number; tag?: BqObject } | null;
  private sizeField: PanelTextField | null = null;
  private all: string[] = [];
  private search = '';
  private grid: PanelKeyGrid | null = null;
  private timer = 0;

  constructor(parent: Screen | null, initial: BqObject | null | undefined, private callback: (tag: BqObject | null) => void) {
    super(parent);
    this.fluid = fluidFromTag(initial);
    void allKeys(true).then((k) => {
      this.all = k;
      this.refresh();
    });
  }
  title() {
    return tr('betterquesting.title.select_fluid');
  }
  /** FluidStack copy of the picked fluid; the amount field shows its amount. */
  private pick(k: string) {
    this.fluid = { name: k.slice('fluid:'.length), amount: 1000 };
    this.sizeField?.setText('1000');
  }
  route() {
    return (this.parent?.route() ?? '#/') + '/fluid';
  }
  private refresh() {
    if (!this.grid) return;
    const q = this.search.toLowerCase();
    this.grid.keys = this.all.filter((k) => matches(k, q));
  }

  build() {
    const bg = addBackground(this);
    addBottomButton(bg, tr('gui.done'), () => {
      this.host.back();
      this.callback(this.fluid ? fluidStackTag(this.fluid.name, this.fluid.amount, this.fluid.tag) : null);
    });
    addTitle(bg, tr('betterquesting.title.select_fluid'));
    const right = bg.add(new CanvasEmpty(new Transform(Align.HALF_RIGHT, [8, 32, 16, 32])));
    const grid = (this.grid = right.add(
      new PanelKeyGrid(new Transform(Align.FULL_BOX, [0, 16, 8, 0]), (k) => this.pick(k)),
    ));
    const search = right.add(new PanelTextField(new Transform(Align.TOP_EDGE, [0, 0, 8, -16]), this.search));
    search.watermark = 'Search...';
    search.onChange = (s) => {
      this.search = s;
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.refresh(), 120);
    };
    grid.bar = right.add(new PanelVScrollBar(new Transform(Align.RIGHT_EDGE, [-8, 16, 0, 0])));
    this.refresh();

    const topLeft = bg.add(new CanvasEmpty(new Transform([0, 0, 0.5, 0.4], [16, 32, 8, 8])));
    topLeft.add(label(new Transform(Align.TOP_EDGE, [0, 0, 0, -16]), tr('betterquesting.gui.selection')));
    topLeft.add(new PanelKeySlot(Transform.at(Align.TOP_LEFT, 0, 16, 36, 36), () => (this.fluid ? `fluid:${this.fluid.name}` : null)));
    topLeft.add(label(Transform.at(Align.TOP_LEFT, 36, 20, 16, 12), 'x', 1));
    const size = (this.sizeField = topLeft.add(new PanelTextField(new Transform(Align.TOP_EDGE, [52, 16, 0, -32]), this.fluid ? String(this.fluid.amount) : '1')));
    size.filter = 'int';
    size.onChange = () => {
      if (this.fluid) this.fluid.amount = Number(size.value());
    };
    const bottomLeft = bg.add(new CanvasEmpty(new Transform([0, 0.4, 0.5, 1], [16, 8, 8, 32])));
    bottomLeft.add(label(new Transform(Align.TOP_EDGE, [0, 0, 0, -16]), 'NEI bookmarks'));
    const marks = bookmarkedKeys().filter(isFluidKey);
    const w = bottomLeft.transform.w(), h = bottomLeft.transform.h();
    const slot = Math.floor(18 * Math.min(w / 162, (h - 20) / 72));
    for (let i = 0; i < 36; i++) {
      const x = (i % 9) * slot;
      const y = i < 27 ? Math.floor(i / 9) * slot + 16 : 20 + 3 * slot;
      const k = marks[i < 27 ? i + 9 : i - 27] ?? null;
      const s = bottomLeft.add(new PanelKeySlot(Transform.at(Align.TOP_LEFT, x, y, slot, slot), () => k));
      s.onClick = () => k && this.pick(k);
    }
    addDivider(bg, 32, 32);
  }
}

// ---------------------------------------------------------------- entities

/**
 * GuiEntitySelection. The browser cannot make the entity to write its data, so the result is its
 * id only ({"id": name}); tasks that ignore the entity's NBT (the default) behave the same.
 */
export class EntitySelectionScreen extends Screen {
  private search = '';
  private list: CanvasScrolling | null = null;

  constructor(parent: Screen | null, private selected: string | null, private callback: (id: string | null) => void) {
    super(parent);
  }
  title() {
    return tr('betterquesting.title.select_entity');
  }
  route() {
    return (this.parent?.route() ?? '#/') + '/entity';
  }

  build() {
    const bg = addBackground(this);
    addBottomButton(bg, tr('gui.done'), () => {
      this.host.back();
      this.callback(this.selected);
    });
    addTitle(bg, tr('betterquesting.title.select_entity'));
    const right = bg.add(new CanvasEmpty(new Transform(Align.HALF_RIGHT, [8, 32, 16, 32])));
    const list = (this.list = right.add(new CanvasScrolling(new Transform(Align.FULL_BOX, [0, 16, 8, 0]))));
    const search = right.add(new PanelTextField(new Transform(Align.TOP_EDGE, [0, 0, 8, -16]), this.search));
    search.watermark = 'Search...';
    search.onChange = (s) => {
      this.search = s;
      this.fill();
    };
    list.scrollY = right.add(new PanelVScrollBar(new Transform(Align.RIGHT_EDGE, [-8, 16, 0, 0])));
    this.fill();

    const left = bg.add(new CanvasEmpty(new Transform(Align.HALF_LEFT, [16, 32, 8, 32])));
    left.add(new PanelGeneric(new Transform(Align.FULL_BOX, [0, 0, 0, 0]), tex('panel_inner')));
    left.add(
      new PanelTextBox(
        new Transform(Align.MID_CENTER, [-80, -10, -80, -10]),
        this.selected ? `§l${entityName(this.selected)}§r\n§7${this.selected}` : '§7(none)',
      ).setAlignment(1).setColor(col('text_aux_0')),
    );
    addDivider(bg, 32, 32);
  }

  private fill() {
    const list = this.list!;
    const q = this.search.toLowerCase();
    const w = list.transform.w();
    const ids = [...new Set([...entityIds(), ...(this.selected ? [this.selected] : [])])].sort();
    const panels: Panel[] = [];
    let i = 0;
    for (const id of ids) {
      if (q && !id.toLowerCase().includes(q) && !entityName(id).toLowerCase().includes(q)) continue;
      panels.push(
        new PanelButton(new Rect(0, i++ * 16, w, 16), {
          text: id,
          active: id !== this.selected,
          onClick: () => {
            this.selected = id;
            this.host.refresh();
          },
        }),
      );
    }
    list.reset();
    list.addAll(panels);
  }
}
