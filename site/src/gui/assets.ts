// Loading of textures and other static assets.
//
// Minecraft resource locations ("domain:path") map to assets/<domain>/<path> under the site root.
// Images are fetched lazily; drawing code asks for an image while drawing and simply skips it until
// it has loaded (loading asks for a redraw, so it appears a frame later).

import { invalidate, redraw } from './frame.ts';

const BASE = import.meta.env.BASE_URL;

export function resourceUrl(loc: string): string {
  const i = loc.indexOf(':');
  const domain = i < 0 ? 'minecraft' : loc.slice(0, i);
  const path = i < 0 ? loc : loc.slice(i + 1);
  return `${BASE}assets/${domain.toLowerCase()}/${path}`;
}

export const siteUrl = (path: string) => `${BASE}${path.replace(/^\//, '')}`;

type Entry = {
  img: HTMLImageElement;
  ok: boolean;
  failed: boolean;
  waiting?: (() => void)[];
  /** Frame the image was last asked for, and its decoded size in bytes once loaded. */
  lastUse: number;
  bytes: number;
};
const images = new Map<string, Entry>();

/**
 * Decoded images kept at most (about 4 bytes per pixel). The item panel and recipe views can ask
 * for thousands of icon sheets (a 512 px sheet of 3D blocks holds only 4 icons), so images not
 * drawn for a while are dropped, least recently used first, and fetched again (from the HTTP
 * cache) if they are needed later.
 */
const BUDGET = 192 * 1024 * 1024;
let loadedBytes = 0;

function evict() {
  if (loadedBytes <= BUDGET) return;
  const recent = redraw.frame - 2;
  const old = [...images].filter(([, e]) => e.ok && e.lastUse < recent).sort((a, b) => a[1].lastUse - b[1].lastUse);
  for (const [url, e] of old) {
    if (loadedBytes <= BUDGET * 0.75) break;
    images.delete(url);
    loadedBytes -= e.bytes;
    e.img.onload = e.img.onerror = null;
    e.img.src = '';
  }
}

/** Returns the image if it has loaded, null otherwise (and starts loading it). */
export function image(url: string): HTMLImageElement | null {
  let e = images.get(url);
  if (!e) {
    const img = new Image();
    e = { img, ok: false, failed: false, lastUse: redraw.frame, bytes: 0 };
    const entry = e;
    img.onload = () => {
      entry.ok = true;
      entry.bytes = img.naturalWidth * img.naturalHeight * 4;
      loadedBytes += entry.bytes;
      for (const cb of entry.waiting ?? []) cb();
      entry.waiting = undefined;
      evict();
      invalidate();
    };
    img.onerror = () => (entry.failed = true);
    img.src = url;
    images.set(url, e);
  }
  e.lastUse = redraw.frame;
  return e.ok ? e.img : null;
}

export const texture = (loc: string) => image(resourceUrl(loc));

/** Call `cb` once the image at `url` (already requested with image()) has loaded. */
export function whenLoaded(url: string, cb: () => void) {
  const e = images.get(url);
  if (!e || e.failed) return;
  if (e.ok) cb();
  else (e.waiting ??= []).push(cb);
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${url}`));
    img.src = url;
  });
}

export async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

// ---------------------------------------------------------------- tinting

// GL colour multiplication (glColor * texture) is emulated by drawing a tinted copy of the
// source region. Copies are cached per (image, region, rgb).
const tintCache = new Map<string, HTMLCanvasElement>();
const ids = new WeakMap<CanvasImageSource, number>();
let nextId = 1;

function idOf(img: CanvasImageSource): number {
  let id = ids.get(img);
  if (!id) ids.set(img, (id = nextId++));
  return id;
}

/**
 * A copy of img's region (sx,sy,sw,sh) multiplied by rgb (0xRRGGBB). Returns the source itself
 * for white.
 */
export function tinted(
  img: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  rgb: number,
): { src: CanvasImageSource; sx: number; sy: number } {
  rgb &= 0xffffff;
  if (rgb === 0xffffff) return { src: img, sx, sy };
  const key = `${idOf(img)}|${sx},${sy},${sw},${sh}|${rgb}`;
  let c = tintCache.get(key);
  if (!c) {
    if (tintCache.size > 4000) tintCache.clear();
    c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(sw));
    c.height = Math.max(1, Math.ceil(sh));
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = `#${rgb.toString(16).padStart(6, '0')}`;
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    tintCache.set(key, c);
  }
  return { src: c, sx: 0, sy: 0 };
}

/**
 * Draw (sx,sy,sw,sh) of img into (dx,dy,dw,dh), multiplied by an ARGB colour the way glColor4f
 * would tint a texture.
 */
export function drawTinted(
  g: CanvasRenderingContext2D,
  img: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  argb = 0xffffffff,
) {
  if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return;
  const a = ((argb >>> 24) & 255) / 255;
  if (a <= 0) return;
  const t = tinted(img, sx, sy, sw, sh, argb);
  const prev = g.globalAlpha;
  if (a < 1) g.globalAlpha = prev * a;
  g.drawImage(t.src, t.sx, t.sy, sw, sh, dx, dy, dw, dh);
  g.globalAlpha = prev;
}
