// Drawing exported item icons the way BetterQuesting draws items in game.
//
// Icons rendered from the exact quest stacks (exporter QuestStackIconExporter) are vertical strips
// of square layers: animation frames, then for lit items a light layer and an optional texture
// layer. Three things the game does at draw time are redone here:
//
// - Animated textures: the frame is picked from the game-tick clock (20 ticks a second).
// - Lighting: BetterQuesting scales items with glScalef(k, k, 1) (ItemTexture's size / 16 times the
//   quest map zoom) before RenderItem sets up the GUI item lights. Because z is not scaled, the
//   lights and normals tilt and large or zoomed-in blocks come out darker. The exporter splits a
//   lit item into unlit colours U, the two lights' diffuse factors D0/D1 and the texture colours T,
//   so here colour = min(T, U * (0.4 + 0.6 * (c0(k) * D0 + c1(k) * D1))), where c0 and c1 are what
//   the fixed-function pipeline does to each light at scale k (1 at k = 1).
// - The enchantment glint (RenderItem.renderEffect): two scrolling layers of
//   textures/misc/enchanted_item_glint.png, tinted (0.5, 0.25, 0.8), added over the item.

import { image, siteUrl } from './assets.ts';
import { type Gfx } from './core.ts';
import { animating } from './frame.ts';
import type { ItemInfo } from '../lib/model.ts';
import { lightScale, frameAt } from './itemMath.ts';

// ---------------------------------------------------------------- lighting

const pixelCache = new WeakMap<HTMLImageElement, Uint8ClampedArray>();
function pixels(img: HTMLImageElement): Uint8ClampedArray {
  let d = pixelCache.get(img);
  if (!d) {
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0);
    d = g.getImageData(0, 0, img.width, img.height).data;
    pixelCache.set(img, d);
  }
  return d;
}

const LIT_CACHE_SIZE = 160;
const litCache = new Map<string, HTMLCanvasElement>();

// Relighting costs a pass over a 256x256 icon. While the quest map zooms, k crosses a bucket every
// few frames for every lit icon on screen at once; doing them all in one frame stalls it. Each
// frame gets a time budget: past it, an icon keeps its nearest already-lit bucket and is redone
// in a later frame.
const RELIGHT_BUDGET_MS = 4;
let budgetFrame = -1;
let budgetUsed = 0;

function cached(key: string): HTMLCanvasElement | undefined {
  const hit = litCache.get(key);
  if (hit) {
    litCache.delete(key);
    litCache.set(key, hit);
  }
  return hit;
}

/**
 * The lit layer for one frame at modelview scale k (bucketed to 1/8 octave), cached. `now` is the
 * time of the frame being drawn, for the per-frame budget.
 */
export function relight(img: HTMLImageElement, info: ItemInfo, frame: number, k: number, now = -1): HTMLCanvasElement {
  const bucket = Math.round(Math.log2(Math.max(k, 1 / 64)) * 8);
  const base = `${img.src}|${frame}|`;
  const hit = cached(base + bucket);
  if (hit) return hit;
  if (now !== budgetFrame) {
    budgetFrame = now;
    budgetUsed = 0;
  }
  if (budgetUsed >= RELIGHT_BUDGET_MS) {
    for (let d = 1; d <= 24; d++) {
      const near = litCache.get(base + (bucket - d)) ?? litCache.get(base + (bucket + d));
      if (near) {
        animating(true); // come back for the exact bucket
        return near;
      }
    }
  }
  const started = performance.now();
  const canvas = relightBucket(img, info, frame, bucket);
  budgetUsed += performance.now() - started;
  litCache.set(base + bucket, canvas);
  if (litCache.size > LIT_CACHE_SIZE) litCache.delete(litCache.keys().next().value!);
  return canvas;
}

function relightBucket(img: HTMLImageElement, info: ItemInfo, frame: number, bucket: number): HTMLCanvasElement {
  const [c0, c1] = lightScale(2 ** (bucket / 8));
  const S = img.width;
  const N = S * S * 4;
  const frames = info.f ?? 1;
  const px = pixels(img);
  const u = frame * N, d = frames * N, t = info.l === 2 ? (frames + 1) * N : -1;
  const out = new ImageData(S, S);
  const o = out.data;
  for (let i = 0; i < N; i += 4) {
    const a = px[u + i + 3];
    if (!a) continue;
    const light = 0.4 + (0.6 * (c0 * px[d + i] + c1 * px[d + i + 1])) / 255;
    for (let c = 0; c < 3; c++) {
      const unlit = px[u + i + c];
      // Without a texture layer the vertex colour is white and the texture is the unlit colour.
      // With one, scale it by how this frame's colour compares with the first frame's.
      let cap = unlit;
      if (t >= 0) {
        const first = px[i + c];
        cap = first ? (px[t + i + c] * unlit) / first : px[t + i + c];
      }
      o[i + c] = Math.min(cap, Math.round(unlit * light));
    }
    o[i + 3] = a;
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  canvas.getContext('2d')!.putImageData(out, 0, 0);
  return canvas;
}

// ---------------------------------------------------------------- glint

let tintedGlint: HTMLCanvasElement | null = null;
function glintTexture(): HTMLCanvasElement | null {
  if (tintedGlint) return tintedGlint;
  const img = image(siteUrl('assets/minecraft/textures/misc/enchanted_item_glint.png'));
  if (!img) return null;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height);
  const p = data.data;
  for (let i = 0; i < p.length; i += 4) {
    p[i] *= 0.5;
    p[i + 1] *= 0.25;
    p[i + 2] *= 0.8;
  }
  g.putImageData(data, 0, 0);
  return (tintedGlint = c);
}

let glintCanvas: HTMLCanvasElement | null = null;

/**
 * RenderItem.renderGlint over an item drawn at (x, y) with slot size `size`: the 20x20 quad at
 * (-2, -2) in item units, two layers whose texture coordinates are (f2 + gx + f4 * gy) / 256 and
 * gy / 256 (f2 scrolls with time, f4 = 4 or -1), added where the item is (GL_DST_ALPHA, GL_ONE).
 */
function drawGlint(
  gfx: Gfx, src: CanvasImageSource, sx: number, sy: number, S: number, x: number, y: number, size: number,
) {
  const tex = glintTexture();
  if (!tex) return;
  animating();
  const x0 = gfx.dx(x - size / 2), y0 = gfx.dy(y - size / 2);
  const w = gfx.dx(x + size * 1.5) - x0, h = gfx.dy(y + size * 1.5) - y0;
  if (w <= 0 || h <= 0) return;
  const canvas = (glintCanvas ??= document.createElement('canvas'));
  if (canvas.width < w || canvas.height < h) {
    canvas.width = Math.max(canvas.width, w);
    canvas.height = Math.max(canvas.height, h);
  }
  const g = canvas.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, w, h);
  const unit = (gfx.s * size) / 16; // device pixels per item unit
  const qx = (gfx.ox + x * gfx.s - x0) - 2 * unit, qy = (gfx.oy + y * gfx.s - y0) - 2 * unit;
  g.imageSmoothingEnabled = true; // the glint texture's .mcmeta asks for blur
  const scale = tex.width / 256; // texture pixels per glint coordinate unit
  for (let layer = 0; layer < 2; layer++) {
    const period = 3000 + layer * 1873;
    const f2 = ((gfx.now % period) / period) * 256;
    const f4 = layer === 0 ? 4 : -1;
    const pattern = g.createPattern(tex, 'repeat')!;
    // texel (tx, ty) -> quad coordinates gy = ty / scale, gx = tx / scale - f2 - f4 * gy -> device.
    const k = unit / scale;
    pattern.setTransform(new DOMMatrix([k, 0, -f4 * k, k, qx - f2 * unit, qy]));
    g.fillStyle = pattern;
    g.globalCompositeOperation = layer === 0 ? 'source-over' : 'lighter';
    g.fillRect(qx, qy, 20 * unit, 20 * unit);
  }
  g.globalCompositeOperation = 'destination-in';
  g.imageSmoothingEnabled = false;
  g.drawImage(src, sx, sy, S, S, 0, 0, w, h);
  const main = gfx.g;
  const op = main.globalCompositeOperation;
  main.globalCompositeOperation = 'lighter';
  main.drawImage(canvas, 0, 0, w, h, x0, y0, w, h);
  main.globalCompositeOperation = op;
}

// ---------------------------------------------------------------- entry point

/**
 * Draws an exported icon (a 32-unit canvas with the 16-unit item in the middle) for a slot of
 * `size` at (x, y), with its animation frame, BetterQuesting's lighting and the glint.
 */
export function drawIcon(gfx: Gfx, img: HTMLImageElement, info: ItemInfo, x: number, y: number, size: number) {
  const S = img.width;
  let frame = 0;
  if (info.f && info.f > 1 && info.t) {
    animating();
    frame = frameAt(info.t, gfx.now);
  }
  let src: CanvasImageSource = img;
  let sy = frame * S;
  if (info.l && img.height >= S * ((info.f ?? 1) + info.l)) {
    const k = (size * gfx.s) / (16 * gfx.base);
    src = relight(img, info, frame, k, gfx.now);
    sy = 0;
  }
  gfx.icon(src, 0, sy, S, S, x - size / 2, y - size / 2, size * 2, size * 2);
  if (info.g) drawGlint(gfx, src, 0, sy, S, x, y, size);
}
