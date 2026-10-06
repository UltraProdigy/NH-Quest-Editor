// What each recipe handler draws: its background, where its stacks go, and anything drawn over
// them. Positions follow NotEnoughItems' handlers (ShapedRecipeHandler, ShapelessRecipeHandler,
// FurnaceRecipeHandler); GregTech recipe maps are in gt.ts.

import { type Gfx } from '../gui/core.ts';
import { texture } from '../gui/assets.ts';
import { animating } from '../gui/frame.ts';
import type { NeiHandler, NeiRecipe, Slot } from './model.ts';
import { itemIndexOf, fuelList as exportedFuels, cycleTime } from './data.ts';
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
  }
  return out;
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
  const tex = texture(h.kind === 'smelting' ? 'minecraft:textures/gui/container/furnace.png' : 'minecraft:textures/gui/container/crafting_table.png');
  if (tex) gfx.image(tex, 5, 11, 166, 65, x, y, 166, 65);
}

/** drawForeground/drawExtras: animations and text over the stacks. */
export function drawRecipeForeground(gfx: Gfx, h: NeiHandler, r: NeiRecipe, x: number, y: number, now: number) {
  if (h.kind === 'gt') return drawGtForeground(gfx, h, r, x, y, now);
  if (h.kind === 'smelting') {
    const tex = texture('minecraft:textures/gui/container/furnace.png');
    if (!tex) return;
    animating();
    const t = ticks(cycleTime(now)) % 48 / 48;
    progressBar(gfx, tex, x + 51, y + 25, 176, 0, 14, 14, t, 7);
    progressBar(gfx, tex, x + 74, y + 23, 176, 14, 24, 16, t, 0);
  }
}
