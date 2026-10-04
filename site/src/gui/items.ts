// Item names, icons and tooltips from the generated item index (data/items.json).
//
// The index is produced from the game-data export. Without it (or for items the export did not
// cover) items fall back to their registry name and a placeholder icon.

import { image, siteUrl, fetchJson } from './assets.ts';
import { type Gfx } from './core.ts';
import { animating } from './frame.ts';
import { drawString, stringWidth } from './font.ts';
import { drawIcon } from './itemRender.ts';
import type { ItemRef, FluidRef, ItemIndex, ItemInfo } from '../lib/model.ts';
import { itemKey, fluidKey } from '../lib/model.ts';

export const WILDCARD = 32767;

let index: ItemIndex | null = null;
let ore: Record<string, string[]> = {};
let mods: Record<string, string> = {};
let iconDir = 'data/icons/';

export async function loadItems() {
  try {
    const data = await fetchJson<ItemIndex & { ore?: Record<string, string[]>; mods?: Record<string, string>; iconDir?: string }>(
      siteUrl('data/items.json'),
    );
    index = data;
    ore = data.ore ?? {};
    mods = data.mods ?? {};
    if (data.iconDir) iconDir = data.iconDir;
  } catch {
    index = null; // no game data yet: placeholders everywhere
  }
}

export const hasItemIndex = () => index !== null;
export const itemIndexSource = () => index?.source ?? null;

function lookup(key: string): ItemInfo | undefined {
  return index?.items[key];
}

/** Index key of a stack: its exact (NBT) key when that was rendered, else registry name and meta. */
export function refKey(ref: ItemRef): string {
  return ref.k && lookup(ref.k) ? ref.k : itemKey(ref.id, ref.dmg);
}

/** Item variants for a stack: ore dictionary members, wildcard metas, or the stack itself. */
export function variants(ref: ItemRef): string[] {
  if (ref.k && lookup(ref.k)) return [ref.k];
  if (ref.ore) {
    const list = ore[ref.ore];
    if (list?.length) return list;
  }
  if (ref.dmg === WILDCARD && index) {
    const prefix = `${ref.id}@`;
    const keys = Object.keys(index.items).filter((k) => k.startsWith(prefix));
    if (keys.length) return keys;
  }
  return [itemKey(ref.id, ref.dmg)];
}

/** The variant shown right now (OreDictTexture cycles once per second). */
export function currentVariant(ref: ItemRef, interval = 1): string {
  const v = variants(ref);
  if (v.length === 1) return v[0];
  animating();
  return v[Math.floor(((performance.now() / 1000) % (v.length * interval)) / interval)];
}

export function itemName(ref: ItemRef | string): string {
  const key = typeof ref === 'string' ? ref : refKey(ref);
  const info = lookup(key);
  if (info) return info.n;
  if (typeof ref !== 'string' && ref.dmg === WILDCARD) {
    const v = variants(ref);
    const first = v.length ? lookup(v[0]) : undefined;
    if (first) return first.n;
  }
  const shown = key.replace(/#.*$/, '');
  return typeof ref === 'string' ? shown : shown.endsWith('@0') ? ref.id : shown;
}

export function fluidName(f: FluidRef): string {
  return lookup(fluidKey(f.fluid))?.n ?? f.fluid;
}

const modName = (modId?: string) => (modId ? (mods[modId] ?? modId) : undefined);

export function itemTooltip(ref: ItemRef | string, advanced = false): string[] {
  const key = typeof ref === 'string' ? ref : refKey(ref);
  const info = lookup(key);
  const lines = [info?.n ?? itemName(ref)];
  if (advanced || !info) lines.push(`§8${key.replace(/#.*$/, '').replace('@', ' @ ')}`);
  const mod = modName(info?.m ?? key.split(':')[0]);
  if (mod) lines.push(`§9§o${mod}`);
  return lines;
}

export function fluidTooltip(f: FluidRef): string[] {
  const info = lookup(fluidKey(f.fluid));
  return [info?.n ?? f.fluid, `§7${f.n} mB`, ...(info?.m ? [`§9§o${modName(info.m)}`] : [])];
}

// ---------------------------------------------------------------- drawing

/** Index entry whose icon to draw: the exact stack's, or its plain item's when it has none. */
function iconInfo(key: string): ItemInfo | undefined {
  const info = lookup(key);
  if (info?.i || !key.includes('#')) return info;
  return lookup(key.replace(/#.*$/, ''));
}

function drawPlaceholder(gfx: Gfx, x: number, y: number, size: number) {
  // Shown when no icon exists: a faint frame with a question mark.
  gfx.fill(x + size * 0.125, y + size * 0.125, size * 0.75, size * 0.75, 0x40000000);
  gfx.push();
  gfx.translate(x, y);
  gfx.scale(size / 16);
  drawString(gfx, '?', 6, 4, 0xffa0a0a0, true);
  gfx.pop();
}

/**
 * Draw an item into a square (ItemTexture/RenderUtils.RenderItemStack). `size` is the 16px slot
 * size; text is the stack-size label (drawn bottom-right, shrunk if wider than the slot).
 */
export function drawItemKey(gfx: Gfx, key: string, x: number, y: number, size = 16, text = '') {
  const info = iconInfo(key);
  const img = info?.i ? image(siteUrl(iconDir + info.i)) : null;
  // Exported icons are a 32-unit canvas with the 16-unit item in the middle (room for renders
  // that spill out of their slot), so the slot is the centre half of the image.
  if (img && info) drawIcon(gfx, img, info, x, y, size);
  else drawPlaceholder(gfx, x, y, size);
  if (text) {
    gfx.push();
    gfx.translate(x, y);
    gfx.scale(size / 16);
    const w = stringWidth(text);
    if (w > 17) {
      const s = 17 / w;
      gfx.translate(0, 17 - 9 * s);
      gfx.scale(s);
      drawString(gfx, text, 0, 0, 0xffffffff, true);
    } else {
      drawString(gfx, text, 17 - w, 18 - 9, 0xffffffff, true);
    }
    gfx.pop();
  }
}

export function drawItem(gfx: Gfx, ref: ItemRef, x: number, y: number, size = 16, showCount = false) {
  drawItemKey(gfx, currentVariant(ref), x, y, size, showCount && ref.n > 1 ? String(ref.n) : '');
}

export function drawFluid(gfx: Gfx, f: FluidRef, x: number, y: number, size = 16) {
  drawItemKey(gfx, fluidKey(f.fluid), x, y, size);
}

/** ItemTexture with keepAspect: fit a square item into a rectangle. */
export function drawItemFit(gfx: Gfx, ref: ItemRef, x: number, y: number, w: number, h: number, showCount = false) {
  const sx = w / 16, sy = h / 16, sa = Math.min(sx, sy);
  const dx = Math.floor((sx - sa) * 8), dy = Math.floor((sy - sa) * 8);
  drawItem(gfx, ref, x + dx, y + dy, 16 * sa, showCount);
}
