// Drawing helpers shared by NEI's windows and panels: buttons (GuiNEIButton, LayoutManager's button
// background), nine-slice textures, and CodeChickenLib's tooltips.

import { type Gfx, type TipLine, keys as heldKeys } from '../gui/core.ts';
import { texture } from '../gui/assets.ts';
import { drawString, stringWidth } from '../gui/font.ts';

export const enum Btn { DISABLED = 0, NORMAL = 1, HOVER = 2 }

export interface Rect { x: number; y: number; w: number; h: number }
export const inside = (r: Rect, mx: number, my: number) => mx >= r.x && mx < r.x + r.w && my >= r.y && my < r.y + r.h;

/** CodeChickenLib's GuiDraw.TOOLTIP_LINESPACE: a line ending in it is followed by a 2 px gap. */
export const LINESPACE = '\u00a7h';

/**
 * The hotkeys NEI lists for a stack in the recipe window, as far as the site has them: with Alt
 * held the list (GuiContainerManager.collectHotkeyTips), otherwise how to show it.
 */
export function hotkeyLines(cycling: boolean, extra: [string, string][] = []): string[] {
  if (!heldKeys.alt) return ['§7Hold §6ALT§7 for hotkeys'];
  const tips: [string, string][] = [
    ['R', 'Recipe to make this item'],
    ['U', 'Recipes that use this item'],
  ];
  if (cycling) tips.push(['SHIFT + Scroll', 'Change Item']);
  tips.push(...extra);
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
export function drawMultilineTip(gfx: Gfx, list: (string | TipLine)[], x: number, y: number, sw: number, sh: number) {
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
export function tooltipBox(gfx: Gfx, x: number, y: number, w: number, h: number) {
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

/**
 * DrawableResource.draw with slices: corners as they are, edges and middle tiled. (u, v, tw, th)
 * is the source in texture units and `k` texture pixels per unit.
 */
export function nineSlice(
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
export function guiButton(gfx: Gfx, r: Rect, label: string, state: Btn) {
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
export function neiButton(gfx: Gfx, r: Rect, state: Btn, label = '') {
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

