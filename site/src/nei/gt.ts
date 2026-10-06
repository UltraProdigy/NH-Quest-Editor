// GregTech recipe maps in NEI (GTNEIDefaultHandler and RecipeMapFrontend).
//
// GregTech builds each tab's NEI view from a ModularUI template: a background, a slot frame for
// every input and output up to the map's maximums, an animated progress bar, the GT logo and
// extra pictures, all shifted by the handler's window offset (-5, -11). Stacks sit one pixel inside
// their frames, and the description lines start below the background. The exporter records the
// template from the running game (GtLayout.template); without it, GregTech's defaults (UIHelper,
// BasicUIProperties) are drawn.

import { type Gfx } from '../gui/core.ts';
import { texture } from '../gui/assets.ts';
import { animating } from '../gui/frame.ts';
import { drawString } from '../gui/font.ts';
import type { GtDrawable, GtLayout, GtWidget, NeiHandler, NeiRecipe, Slot } from './model.ts';
import type { PlacedSlot } from './handlers.ts';
import { ticks } from './handlers.ts';
import { standardLines } from './text.ts';

type Pos = [number, number];
type Kind = 'itemIn' | 'itemOut' | 'fluidIn' | 'fluidOut';
const KINDS: Kind[] = ['itemIn', 'itemOut', 'fluidIn', 'fluidOut'];

// ---------------------------------------------------------------- GregTech's default layout

function grid(count: number, x0: number, y0: number, cols: number, rows = 100): Pos[] {
  const out: Pos[] = [];
  for (let j = 0; j < rows && out.length < count; j++) for (let i = 0; i < cols && out.length < count; i++) out.push([x0 + i * 18, y0 + j * 18]);
  return out;
}
const DEFAULTS: Record<Kind, (n: number) => Pos[]> = {
  itemIn: (n) =>
    n <= 0 ? [] : n === 1 ? grid(n, 52, 24, 1, 1) : n === 2 ? grid(n, 34, 24, 2, 1) : n === 3 ? grid(n, 16, 24, 3, 1)
      : n === 4 ? grid(n, 34, 15, 2, 2) : n <= 6 ? grid(n, 16, 15, 3, 2) : grid(n, 16, 6, 3),
  itemOut: (n) =>
    n <= 0 ? [] : n <= 3 ? grid(n, 106, 24, n, 1) : n === 4 ? grid(n, 106, 15, 2, 2) : n <= 6 ? grid(n, 106, 15, 3, 2) : grid(n, 106, 6, 3),
  fluidIn: (n) => Array.from({ length: n }, (_, i) => [Math.max(70 - n * 18, 16) + i * 18, 62] as Pos),
  fluidOut: (n) => Array.from({ length: n }, (_, i) => [106 + i * 18, 62] as Pos),
};

const ARROW: GtDrawable = { type: 'UITexture', location: 'gregtech:textures/gui/progressbar/arrow.png', u0: 0, v0: 0, u1: 1, v1: 0.5 };
const ARROW_FULL: GtDrawable = { ...ARROW, v0: 0.5, v1: 1 };
const LOGO: GtDrawable = { type: 'UITexture', location: 'gregtech:textures/gui/picture/gt_logo_17x17_transparent.png', u0: 0, v0: 0, u1: 1, v1: 1 };
const BACKGROUND: GtDrawable = {
  type: 'AdaptableUITexture', location: 'gregtech:textures/gui/background/nei_single_recipe.png',
  u0: 0, v0: 0, u1: 1, v1: 1, imageWidth: 64, imageHeight: 64, borderU: 2, borderV: 2,
};
const slotTexture = (fluid: boolean): GtDrawable => ({
  type: 'AdaptableUITexture', location: `modularui:textures/gui/slot/${fluid ? 'fluid' : 'item'}.png`,
  u0: 0, v0: 0, u1: 1, v1: 1, imageWidth: 18, imageHeight: 18, borderU: 1, borderV: 1,
});

/** The template GregTech would build with its default properties, for exports without one. */
function defaultTemplate(max: [number, number, number, number], offset: Pos): GtWidget[] {
  const w: GtWidget[] = [
    { type: 'ProgressBar', pos: [78 + offset[0], 24 + offset[1]], size: [20, 18], empty: ARROW, full: ARROW_FULL, direction: 'RIGHT', imageSize: 20 },
  ];
  KINDS.forEach((kind, k) =>
    DEFAULTS[kind](max[k]).forEach((p, index) =>
      w.push({ type: 'SlotWidget', pos: [p[0] + offset[0], p[1] + offset[1]], size: [18, 18], slot: kind, index, background: [slotTexture(k >= 2)] }),
    ),
  );
  w.push({ type: 'DrawableWidget', pos: [152 + offset[0], 63 + offset[1]], size: [17, 17], drawable: LOGO });
  return w;
}

interface Resolved {
  layout: GtLayout;
  offset: Pos;
  widgets: GtWidget[];
  background: GtDrawable[];
  bgPos: Pos;
  bgSize: Pos;
  /** Template slot positions (frame corner, offset included) by kind and slot number. */
  slots: Record<Kind | 'special', Pos[]>;
}
const resolved = new WeakMap<NeiHandler, Resolved>();

function resolve(h: NeiHandler): Resolved {
  let r = resolved.get(h);
  if (r) return r;
  const layout = h.layout ?? {};
  const offset = layout.offset ?? [-5, -11];
  const max = layout.max ?? h.max ?? [0, 0, 0, 0];
  const t = layout.template;
  const widgets = t?.widgets?.length ? t.widgets : defaultTemplate(max, offset);
  const slots: Resolved['slots'] = { itemIn: [], itemOut: [], fluidIn: [], fluidOut: [], special: [] };
  for (const w of widgets) if (w.slot) slots[w.slot][w.index ?? 0] = w.pos;
  if (!t?.widgets?.length && layout.useSpecialSlot !== false) slots.special[0] = [124 + offset[0], 62 + offset[1]];
  const bgOffset = layout.bgOffset ?? [3, 3];
  r = {
    layout,
    offset,
    widgets,
    background: t?.background?.length ? t.background : [BACKGROUND],
    bgPos: [offset[0] + bgOffset[0], offset[1] + bgOffset[1]],
    bgSize: t?.size ?? layout.bgSize ?? [170, 82],
    slots,
  };
  resolved.set(h, r);
  return r;
}

// ---------------------------------------------------------------- stacks

export function gtSlots(h: NeiHandler, rec: NeiRecipe): PlacedSlot[] {
  const { layout, offset, slots } = resolve(h);
  const out: PlacedSlot[] = [];
  const lists: Record<Kind, Slot[] | undefined> = { itemIn: rec.ii, itemOut: rec.io, fluidIn: rec.fi, fluidOut: rec.fo };
  const slotNo = (s: Slot, i: number) => (typeof s === 'object' && s.p !== undefined ? s.p : i);
  for (const kind of KINDS) {
    const list = lists[kind];
    if (!list?.length) continue;
    // Stacks past the template's slots go where the map's layout puts them for the recipe's count.
    const count = Math.max(...list.map((s, i) => slotNo(s, i) + 1));
    let extra: Pos[] | null = null;
    list.forEach((s, i) => {
      if (s === -1) return;
      const n = slotNo(s, i);
      let p: Pos | undefined = slots[kind][n];
      if (!p) {
        extra ??= (layout[kind]?.[String(count)] ?? DEFAULTS[kind](count)).map(([x, y]) => [x + offset[0], y + offset[1]] as Pos);
        p = extra[n];
      }
      if (p) out.push({ x: p[0] + 1, y: p[1] + 1, slot: s, input: kind === 'itemIn' || kind === 'fluidIn', fluid: kind.startsWith('fluid') });
    });
  }
  const sp = slots.special[0];
  if (rec.sp?.length && sp) out.push({ x: sp[0] + 1, y: sp[1] + 1, slot: rec.sp[0], input: true });
  return out;
}

export const gtRecipeHeight = (h: NeiHandler, _r: NeiRecipe) => h.height;

// ---------------------------------------------------------------- drawing

const unwrap = (d: GtDrawable | undefined): GtDrawable | undefined => (d && !d.location && d.inner ? unwrap(d.inner) : d);

/** Draw a UITexture (part of an image) into a rectangle; AdaptableUITextures as nine-slices. */
function drawDrawable(gfx: Gfx, d0: GtDrawable | undefined, x: number, y: number, w: number, h: number, part?: [number, number, number, number]) {
  const d = unwrap(d0);
  if (!d?.location) return;
  const img = texture(d.location);
  if (!img) return;
  const W = img.width, H = img.height;
  let u0 = (d.u0 ?? 0) * W, v0 = (d.v0 ?? 0) * H, u1 = (d.u1 ?? 1) * W, v1 = (d.v1 ?? 1) * H;
  if (part) {
    // Sub-area of the drawable (ProgressBar's partly filled bar), as fractions of it.
    const [pu0, pv0, pu1, pv1] = part;
    const du = u1 - u0, dv = v1 - v0;
    [u0, v0, u1, v1] = [u0 + du * pu0, v0 + dv * pv0, u0 + du * pu1, v0 + dv * pv1];
  }
  const adaptable = !!d.imageWidth && d.borderU !== undefined && !part && (w !== d.imageWidth || h !== d.imageHeight);
  if (!adaptable) {
    gfx.image(img, u0, v0, u1 - u0, v1 - v0, x, y, w, h);
    return;
  }
  // Texture pixels per GUI pixel, and the border in both.
  const k = (u1 - u0) / d.imageWidth!;
  const bu = d.borderU!, bv = d.borderV ?? bu;
  const tu = bu * k, tv = bv * k;
  const sw = u1 - u0, sh = v1 - v0;
  const blit = (sx: number, sy: number, sww: number, shh: number, dx: number, dy: number, dw: number, dh: number) =>
    gfx.image(img, u0 + sx, v0 + sy, sww, shh, dx, dy, dw, dh);
  blit(0, 0, tu, tv, x, y, bu, bv);
  blit(sw - tu, 0, tu, tv, x + w - bu, y, bu, bv);
  blit(0, sh - tv, tu, tv, x, y + h - bv, bu, bv);
  blit(sw - tu, sh - tv, tu, tv, x + w - bu, y + h - bv, bu, bv);
  blit(tu, 0, sw - 2 * tu, tv, x + bu, y, w - 2 * bu, bv);
  blit(tu, sh - tv, sw - 2 * tu, tv, x + bu, y + h - bv, w - 2 * bu, bv);
  blit(0, tv, tu, sh - 2 * tv, x, y + bv, bu, h - 2 * bv);
  blit(sw - tu, tv, tu, sh - 2 * tv, x + w - bu, y + bv, bu, h - 2 * bv);
  blit(tu, tv, sw - 2 * tu, sh - 2 * tv, x + bu, y + bv, w - 2 * bu, h - 2 * bv);
}

/** GTNEIDefaultHandler's progress: one sweep per 200 ticks, in steps of the bar's image size. */
function drawProgressBar(gfx: Gfx, w: GtWidget, x: number, y: number, now: number) {
  const [bw, bh] = w.size;
  drawDrawable(gfx, w.empty, x, y, bw, bh);
  animating();
  let p = (ticks(now) % 200) / 200;
  const steps = w.imageSize ?? bw;
  if (steps > 0) p = Math.floor(p * steps) / steps;
  if (p <= 0) return;
  switch ((w.direction ?? 'RIGHT').toUpperCase()) {
    case 'RIGHT':
      return drawDrawable(gfx, w.full, x, y, bw * p, bh, [0, 0, p, 1]);
    case 'LEFT':
      return drawDrawable(gfx, w.full, x + bw * (1 - p), y, bw * p, bh, [1 - p, 0, 1, 1]);
    case 'DOWN':
      return drawDrawable(gfx, w.full, x, y, bw, bh * p, [0, 0, 1, p]);
    case 'UP':
      return drawDrawable(gfx, w.full, x, y + bh * (1 - p), bw, bh * p, [0, 1 - p, 1, 1]);
    default: {
      // CIRCULAR_CW: the four quarters of the texture fill in turn (up, right, down, left).
      const q = (i: number) => Math.min(1, Math.max(0, (p - i * 0.25) / 0.25));
      const hw = bw / 2, hh = bh / 2;
      const a = q(0), b = q(1), c = q(2), e = q(3);
      if (a > 0) drawDrawable(gfx, w.full, x, y + bh - hh * a, hw, hh * a, [0, 1 - a / 2, 0.5, 1]);
      if (b > 0) drawDrawable(gfx, w.full, x, y, hw * b, hh, [0, 0, 0.5 * b, 0.5]);
      if (c > 0) drawDrawable(gfx, w.full, x + hw, y, hw, hh * c, [0.5, 0, 1, 0.5 * c]);
      if (e > 0) drawDrawable(gfx, w.full, x + bw - hw * e, y + hh, hw * e, hh, [1 - 0.5 * e, 0.5, 1, 1]);
    }
  }
}

export function drawGtBackground(gfx: Gfx, h: NeiHandler, _r: NeiRecipe, x: number, y: number, now: number) {
  const r = resolve(h);
  for (const d of r.background) drawDrawable(gfx, d, x + r.bgPos[0], y + r.bgPos[1], r.bgSize[0], r.bgSize[1]);
  for (const w of r.widgets) {
    const wx = x + w.pos[0], wy = y + w.pos[1];
    for (const d of w.background ?? []) drawDrawable(gfx, d, wx, wy, w.size[0], w.size[1]);
    if (w.type.includes('ProgressBar')) drawProgressBar(gfx, w, wx, wy, now);
    else if (w.drawable) drawDrawable(gfx, w.drawable, wx, wy, w.size[0], w.size[1]);
  }
}

// ---------------------------------------------------------------- description

/** The description lines of a recipe: recorded by the exporter, or the standard ones. */
export function descriptionLines(h: NeiHandler, r: NeiRecipe): string[] {
  if (r.t) return r.t;
  const base = standardLines(r.e ?? 0, r.d ?? 0, h.layout?.amperage ?? 1);
  return r.x ? [...base, ...r.x] : base;
}

/** ReadableNumberConverter.toWideReadableForm, for fluid amounts of 10,000 L and more. */
function wideReadable(n: number): string {
  const units = ['', 'k', 'M', 'G', 'T', 'P', 'E'];
  let u = 0;
  let v = n;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  const s = v >= 100 ? String(Math.floor(v)) : (Math.floor(v * 10) / 10).toString();
  return s + units[u];
}
export const fluidAmountText = (mb: number) => (mb < 10000 ? `${mb}L` : `${wideReadable(mb)}L`);

export function drawGtForeground(gfx: Gfx, h: NeiHandler, r: NeiRecipe, x: number, y: number, _now: number) {
  const { bgPos, bgSize } = resolve(h);
  // RecipeDisplayInfo: lines at x 5, from 3 below the background, 10 apart, black unless themed.
  let ty = y + bgPos[1] + bgSize[1] + 3;
  for (const line of descriptionLines(h, r)) {
    if (!line) continue;
    drawString(gfx, line, x + 5, ty, 0xff000000, false);
    ty += 10;
  }
}

/** Small text in a slot corner (NEIClientUtils.drawNEIOverlayText at half size). */
export function drawSlotBadge(gfx: Gfx, text: string, x: number, y: number, color = 0xfdd835) {
  gfx.push();
  gfx.translate(x, y);
  gfx.scale(0.5);
  drawString(gfx, text, 0, 0, 0xff000000 | color, false);
  gfx.pop();
}

/** GT's fluid display amount: half-size text at the bottom left of the slot. */
export function drawFluidAmount(gfx: Gfx, mb: number, x: number, y: number) {
  const text = fluidAmountText(mb);
  gfx.push();
  gfx.translate(x, y);
  gfx.scale(0.5);
  drawString(gfx, text, 0, 32 - 9 + 1, 0xffffffff, true);
  gfx.pop();
}
