// What each recipe handler draws: its background, where its stacks go, and anything drawn over
// them. Positions follow NotEnoughItems' handlers (ShapedRecipeHandler, ShapelessRecipeHandler,
// FurnaceRecipeHandler); GregTech recipe maps are in gt.ts.

import { type Gfx } from '../gui/core.ts';
import { texture } from '../gui/assets.ts';
import { animating } from '../gui/frame.ts';
import type { NeiHandler, NeiRecipe, Slot } from './model.ts';
import { itemIndexOf, fuelList as exportedFuels, cycleTime, picture } from './data.ts';
import { drawString, stringWidth } from '../gui/font.ts';
import { splitString } from '../gui/text.ts';
import { type Rect, inside } from './draw.ts';
import { gtSlots, drawGtBackground, drawGtForeground, gtRecipeHeight } from './gt.ts';

/** A stack placed in a recipe, relative to the recipe's origin (PositionedStack). */
export interface PlacedSlot {
  x: number;
  y: number;
  slot: Slot;
  /** Ingredient (true) or result (false). */
  input: boolean;
  fluid?: boolean;
  /** A stack the handler shows that is not part of the recipe (furnace fuel). */
  other?: boolean;
  /** Size of the stack's area when not 16 x 16 (generic handlers' tanks and the like). */
  w?: number;
  h?: number;
  /** The handler draws this stack itself (it is in its picture), so no item is drawn. */
  hidden?: boolean;
  /** Extra tooltip lines the handler gives the stack. */
  tip?: string[];
  /** A display name the stack was given, shown instead of the item's. */
  name?: string;
}

/** TemplateRecipeHandler.cycleticks: one tick per 50 ms. */
export const ticks = (now: number) => Math.floor(now / 50);

// ShapelessRecipeHandler.stackorder
const STACK_ORDER = [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2], [2, 0], [2, 1], [2, 2]];

// FurnaceRecipeHandler shows the fuels in turn, 48 ticks each: the ones the export recorded, or
// for older exports the common vanilla ones.
const FUEL_KEYS = [
  'minecraft:coal@0', 'minecraft:coal@1', 'minecraft:planks@0', 'minecraft:log@0', 'minecraft:stick@0',
  'minecraft:blaze_rod@0', 'minecraft:lava_bucket@0',
];
let fuels: number[] | null = null;
const fuelList = () =>
  (fuels ??= exportedFuels().length ? exportedFuels() : FUEL_KEYS.map((k) => itemIndexOf(k)).filter((i): i is number => i !== undefined));

export function recipeSlots(h: NeiHandler, r: NeiRecipe, now: number): PlacedSlot[] {
  const out: PlacedSlot[] = [];
  switch (h.kind) {
    case 'shaped': {
      const w = Math.max(1, r.w ?? 3);
      (r.g ?? []).forEach((s, i) => {
        if (s !== null && s !== -1) out.push({ x: 25 + (i % w) * 18, y: 6 + Math.floor(i / w) * 18, slot: s, input: true });
      });
      if (r.o !== undefined) out.push({ x: 119, y: 24, slot: r.o, input: false });
      break;
    }
    case 'shapeless': {
      (r.g ?? []).slice(0, 9).forEach((s, i) => {
        if (s !== null && s !== -1) out.push({ x: 25 + STACK_ORDER[i][0] * 18, y: 6 + STACK_ORDER[i][1] * 18, slot: s, input: true });
      });
      if (r.o !== undefined) out.push({ x: 119, y: 24, slot: r.o, input: false });
      break;
    }
    case 'smelting': {
      if (r.i !== undefined) out.push({ x: 51, y: 6, slot: r.i, input: true });
      const f = fuelList();
      if (f.length) out.push({ x: 51, y: 42, slot: f[Math.floor(ticks(cycleTime(now)) / 48) % f.length], input: true, other: true });
      if (r.o !== undefined) out.push({ x: 111, y: 24, slot: r.o, input: false });
      break;
    }
    case 'gt':
      out.push(...gtSlots(h, r));
      break;
    case 'generic':
    case 'quest':
      // PositionedStack.draw centres a 16 px item in the stack's area.
      for (const p of r.ps ?? []) {
        const w = p.w ?? 16, hh = p.h ?? 16;
        out.push({
          x: p.x + Math.trunc((w - 16) / 2), y: p.y + Math.trunc((hh - 16) / 2), slot: p.s, input: p.r === 0, other: p.r === 2,
          ...(w !== 16 || hh !== 16 ? { w, h: hh, x: p.x, y: p.y } : {}),
          ...(p.d ? { hidden: true } : {}),
          ...(p.tip ? { tip: p.tip } : {}),
          ...(p.name ? { name: p.name } : {}),
        });
      }
      break;
  }
  return out;
}

/**
 * A generic handler's picture and text of one layer (0: drawBackground, 1: drawForeground), as the
 * exporter captured them at GUI scale 1.
 */
function drawGenericLayer(gfx: Gfx, h: NeiHandler, r: NeiRecipe, x: number, y: number, layer: 0 | 1, now: number) {
  const pic = layer === 0 ? r.bg : r.fg;
  if (pic !== undefined) picture(gfx, pic, x, y);
  // The moving part of the foreground at the current tick (cycleticks % period).
  if (layer === 1 && h.anim) {
    animating();
    const t = ticks(cycleTime(now)) % h.anim.period;
    let k = 0;
    while (k + 1 < h.anim.keys.length && h.anim.keys[k + 1] <= t) k++;
    const p = h.anim.pics[k];
    if (p !== undefined && p >= 0) picture(gfx, p, x, y);
  }
  for (const [text, tx, ty, color, shadow, l] of r.tx ?? []) {
    if (l !== layer) continue;
    // FontRenderer.drawString: a colour without alpha bits is drawn opaque.
    const c = (color & 0xfc000000) === 0 ? (color | 0xff000000) >>> 0 : color >>> 0;
    drawString(gfx, text, x + tx, y + ty, c, !!shadow);
  }
}

/** Height of one recipe (IRecipeHandler.getRecipeHeight), without the handler's yShift. */
export function recipeHeight(h: NeiHandler, r: NeiRecipe | null): number {
  if (h.kind === 'gt' && r) return gtRecipeHeight(h, r);
  return h.height;
}

/** TemplateRecipeHandler.drawProgressBar. direction: 0 right, 1 down, 2 left, 3 up; +4 shrinks. */
function progressBar(
  gfx: Gfx, img: CanvasImageSource, x: number, y: number, tx: number, ty: number, w: number, h: number, completion: number, dir: number,
) {
  if (dir > 3) {
    completion = 1 - completion;
    dir %= 4;
  }
  const v = Math.trunc(completion * (dir % 2 === 0 ? w : h));
  if (v <= 0) return;
  if (dir === 0) gfx.image(img, tx, ty, v, h, x, y, v, h);
  else if (dir === 1) gfx.image(img, tx, ty, w, v, x, y, w, v);
  else if (dir === 2) gfx.image(img, tx + w - v, ty, v, h, x + w - v, y, v, h);
  else gfx.image(img, tx, ty + h - v, w, v, x, y + h - v, w, v);
}

/** drawBackground: the handler's texture behind the stacks. */
export function drawRecipeBackground(gfx: Gfx, h: NeiHandler, r: NeiRecipe, x: number, y: number, now: number) {
  if (h.kind === 'gt') return drawGtBackground(gfx, h, r, x, y, now);
  if (h.kind === 'generic') return drawGenericLayer(gfx, h, r, x, y, 0, now);
  if (h.kind === 'quest') {
    // QuestRecipeHandler.drawBackground: the two 4 x 4 grids and the arrow.
    const bg = texture('bq_standard:textures/gui/nei.png');
    if (bg) {
      const k = bg.width / 256;
      gfx.image(bg, 0, 0, 166 * k, 105 * k, x, y, 166, 105);
    }
    return;
  }
  const tex = texture(h.kind === 'smelting' ? 'minecraft:textures/gui/container/furnace.png' : 'minecraft:textures/gui/container/crafting_table.png');
  if (tex) gfx.image(tex, 5, 11, 166, 65, x, y, 166, 65);
}

/** drawForeground/drawExtras: animations and text over the stacks. mx, my: the mouse, relative to the recipe. */
export function drawRecipeForeground(gfx: Gfx, h: NeiHandler, r: NeiRecipe, x: number, y: number, now: number, mx = -1, my = -1) {
  if (h.kind === 'gt') return drawGtForeground(gfx, h, r, x, y, now);
  if (h.kind === 'generic') return drawGenericLayer(gfx, h, r, x, y, 1, now);
  if (h.kind === 'quest') {
    // QuestRecipeHandler.drawExtras: the quest's name, underlined and centred, wrapped upwards
    // from y = 16, in the hover colour while the mouse is over it.
    const t = questTitle(r);
    const hover = inside(t.rect, mx, my);
    t.lines.forEach((line, i) => {
      drawString(gfx, line, x + 83 - Math.trunc(stringWidth(line) / 2), y + t.rect.y + i * QUEST_LINE, hover ? 0xffa87a5e : 0xff000000);
    });
    return;
  }
  if (h.kind === 'smelting') {
    const tex = texture('minecraft:textures/gui/container/furnace.png');
    if (!tex) return;
    animating();
    const t = ticks(cycleTime(now)) % 48 / 48;
    progressBar(gfx, tex, x + 51, y + 25, 176, 0, 14, 14, t, 7);
    progressBar(gfx, tex, x + 74, y + 23, 176, 14, 24, 16, t, 0);
  }
}

const QUEST_LINE = 9 + 1;

/**
 * The quest name of a BetterQuesting recipe as drawExtras lays it out, and the area that opens the
 * quest when clicked (isMouseOverTitle), relative to the recipe.
 */
export function questTitle(r: NeiRecipe): { lines: string[]; rect: Rect } {
  const lines = splitString(`§n${(r.qn ?? '').replace(/§[0-9a-fk-or]/gi, '')}`, 166);
  const w = Math.max(0, ...lines.map((l) => stringWidth(l)));
  const top = 16 - (lines.length - 1) * QUEST_LINE;
  return { lines, rect: { x: 83 - Math.trunc(w / 2) - 1, y: top, w: w + 2, h: 9 + (lines.length - 1) * QUEST_LINE + 1 } };
}
