// BetterQuesting themes: data-driven textures, colours and line styles.
//
// A theme (bq_themes.json) overrides some keys and may inherit from a parent theme; anything not
// set falls back to the built-in presets (bq-presets.json, extracted from BQ's Preset* classes).

import { texture as loadTexture } from './assets.ts';
import { type GuiColor, staticColor, pulseColor, sequenceColor, parseColorValue, WHITE } from './color.ts';
import { type Gfx, type GuiRect } from './core.ts';
import { animating } from './frame.ts';
import presets from './bq-presets.json';

// ---------------------------------------------------------------- textures

export interface GuiTexture {
  draw(gfx: Gfx, x: number, y: number, w: number, h: number, color?: GuiColor): void;
}

const ATLAS = 256; // BQ computes UVs as pixel / 256, whatever the real atlas size.

function atlasScale(img: HTMLImageElement) {
  return { kx: img.naturalWidth / ATLAS, ky: img.naturalHeight / ATLAS };
}

export const enum SliceMode {
  STRETCH = 0,
  SLICED_TILE = 1,
  SLICED_STRETCH = 2,
}

export class SlicedTexture implements GuiTexture {
  constructor(
    public atlas: string,
    public bounds: [number, number, number, number],
    public border: [number, number, number, number], // l, t, r, b
    public mode: SliceMode = SliceMode.SLICED_TILE,
  ) {}

  draw(gfx: Gfx, x: number, y: number, width: number, height: number, color: GuiColor = WHITE) {
    if (width <= 0 || height <= 0) return;
    const img = loadTexture(this.atlas);
    if (!img) return;
    const { kx, ky } = atlasScale(img);
    const argb = color.argb();
    const [u, v, tw, th] = this.bounds;
    const [l, t, r, b] = this.border;
    const quad = (dx: number, dy: number, dw: number, dh: number, su: number, sv: number, sw: number, sh: number) => {
      if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return;
      gfx.image(img, su * kx, sv * ky, sw * kx, sh * ky, dx, dy, dw, dh, argb);
    };

    // Too small for the borders: BQ draws at the minimum size and scales down to fit.
    const w = Math.max(width, l + r);
    const h = Math.max(height, t + b);
    const sxk = width / w;
    const syk = height / h;
    const Q = (qx: number, qy: number, qw: number, qh: number, su: number, sv: number, sw: number, sh: number) =>
      quad(x + qx * sxk, y + qy * syk, qw * sxk, qh * syk, su, sv, sw, sh);

    if (this.mode === SliceMode.SLICED_TILE) {
      const fw = tw - l - r;
      const fh = th - t - b;
      if (fw > 0 && fh > 0) {
        const cw = w - l - r;
        const ch = h - t - b;
        const xPasses = Math.floor(cw / fw), remW = cw % fw;
        const yPasses = Math.floor(ch / fh), remH = ch % fh;
        Q(0, 0, l, t, u, v, l, t);
        Q(l + cw, 0, r, t, u + l + fw, v, r, t);
        Q(0, t + ch, l, b, u, v + t + fh, l, b);
        Q(l + cw, t + ch, r, b, u + l + fw, v + t + fh, r, b);
        for (let i = 0; i < xPasses + (remW > 0 ? 1 : 0); i++) {
          const dw = i === xPasses ? remW : fw;
          Q(l + i * fw, 0, dw, t, u + l, v, dw, t);
          Q(l + i * fw, t + ch, dw, b, u + l, v + t + fh, dw, b);
          for (let j = 0; j < yPasses + (remH > 0 ? 1 : 0); j++) {
            const dh = j === yPasses ? remH : fh;
            Q(l + i * fw, t + j * fh, dw, dh, u + l, v + t, dw, dh);
          }
        }
        for (let j = 0; j < yPasses + (remH > 0 ? 1 : 0); j++) {
          const dh = j === yPasses ? remH : fh;
          Q(0, t + j * fh, l, dh, u, v + t, l, dh);
          Q(l + cw, t + j * fh, r, dh, u + l + fw, v + t, r, dh);
        }
      }
    } else if (this.mode === SliceMode.SLICED_STRETCH) {
      const iu = u + l, iv = v + t;
      const iw = tw - l - r, ih = th - t - b;
      if (iw >= 0 && ih >= 0) {
        const sw = w - l - r, sh = h - t - b;
        Q(0, 0, l, t, u, v, l, t);
        Q(l, 0, sw, t, u + l, v, iw, t);
        Q(w - r, 0, r, t, u + l + iw, v, r, t);
        Q(0, t, l, sh, u, v + t, l, ih);
        Q(l, t, sw, sh, iu, iv, iw, ih);
        Q(w - r, t, r, sh, u + l + iw, v + t, r, ih);
        Q(0, h - b, l, b, u, v + t + ih, l, b);
        Q(l, h - b, sw, b, u + l, v + t + ih, iw, b);
        Q(w - r, h - b, r, b, u + l + iw, v + t + ih, r, b);
      }
    } else {
      Q(0, 0, w, h, u, v, tw, th);
    }
  }
}

export class SimpleTexture implements GuiTexture {
  constructor(
    public atlas: string,
    public bounds: [number, number, number, number],
    public keepAspect = false,
  ) {}
  draw(gfx: Gfx, x: number, y: number, width: number, height: number, color: GuiColor = WHITE) {
    if (width <= 0 || height <= 0) return;
    const img = loadTexture(this.atlas);
    if (!img) return;
    const { kx, ky } = atlasScale(img);
    const [u, v, tw, th] = this.bounds;
    let sx = width / tw, sy = height / th;
    let dx = x, dy = y;
    if (this.keepAspect) {
      const sa = Math.min(sx, sy);
      dx += ((sx - sa) * tw) / 2;
      dy += ((sy - sa) * th) / 2;
      sx = sy = sa;
    }
    gfx.image(img, u * kx, v * ky, tw * kx, th * ky, dx, dy, tw * sx, th * sy, color.argb());
  }
}

/** Draws a whole image file scaled into the rectangle (SimpleNoUVTexture). */
export class ImageTexture implements GuiTexture {
  constructor(public loc: string, public keepAspect = true) {}
  draw(gfx: Gfx, x: number, y: number, w: number, h: number, color: GuiColor = WHITE) {
    const img = loadTexture(this.loc);
    if (!img) return;
    let dw = w, dh = h, dx = x, dy = y;
    if (this.keepAspect) {
      const s = Math.min(w / img.naturalWidth, h / img.naturalHeight);
      dw = img.naturalWidth * s;
      dh = img.naturalHeight * s;
      dx += (w - dw) / 2;
      dy += (h - dh) / 2;
    }
    gfx.image(img, 0, 0, img.naturalWidth, img.naturalHeight, dx, dy, dw, dh, color.argb());
  }
}

export class ColorTexture implements GuiTexture {
  constructor(public color: GuiColor, public pad: [number, number, number, number] = [0, 0, 0, 0]) {}
  draw(gfx: Gfx, x: number, y: number, w: number, h: number, color?: GuiColor) {
    const [l, t, r] = this.pad;
    // BQ subtracts (b + r) from the height; kept for fidelity.
    gfx.fill(x + l, y + t, w - (r + l), h - (this.pad[3] + r), (color ?? this.color).argb());
  }
}

export class LayeredTexture implements GuiTexture {
  constructor(public layers: GuiTexture[]) {}
  draw(gfx: Gfx, x: number, y: number, w: number, h: number, color?: GuiColor) {
    for (const l of this.layers) l.draw(gfx, x, y, w, h, color);
  }
}

export class SlideShowTexture implements GuiTexture {
  constructor(public interval: number, public slides: GuiTexture[]) {}
  current(now = performance.now()): GuiTexture | null {
    if (!this.slides.length) return null;
    if (this.slides.length > 1) animating();
    return this.slides[Math.floor(((now / 1000) % (this.slides.length * this.interval)) / this.interval)];
  }
  draw(gfx: Gfx, x: number, y: number, w: number, h: number, color?: GuiColor) {
    this.current()?.draw(gfx, x, y, w, h, color);
  }
}

/** A texture with a fixed tint (GuiTextureColored). */
export const colored = (tex: GuiTexture, color: GuiColor): GuiTexture => ({
  draw: (gfx, x, y, w, h) => tex.draw(gfx, x, y, w, h, color),
});

// ---------------------------------------------------------------- lines

export interface GuiLine {
  draw(gfx: Gfx, start: GuiRect, end: GuiRect, width: number, color: GuiColor, animate: boolean): void;
}

export class SimpleLine implements GuiLine {
  constructor(public stippleScale = 1, public mask = 0xffff) {}
  draw(gfx: Gfx, a: GuiRect, b: GuiRect, width: number, color: GuiColor) {
    const x1 = a.x() + a.w() / 2, y1 = a.y() + a.h() / 2;
    const x2 = b.x() + b.w() / 2, y2 = b.y() + b.h() / 2;
    let dash: number[] | undefined;
    if ((this.mask & 0xffff) !== 0xffff) {
      // Convert the 16-bit stipple mask into on/off runs (in device pixels, like GL).
      dash = [];
      let bit = this.mask & 1, run = 0;
      for (let i = 0; i < 16; i++) {
        const cur = (this.mask >> i) & 1;
        if (cur === bit) run++;
        else {
          dash.push(run * this.stippleScale);
          bit = cur;
          run = 1;
        }
      }
      dash.push(run * this.stippleScale);
      if ((this.mask & 1) === 0) dash.unshift(0);
    }
    gfx.line(x1, y1, x2, y2, width, color.argb(), dash);
  }
}

export let showDependencyArrows = true;
export const setShowDependencyArrows = (v: boolean) => (showDependencyArrows = v);

export class DirectionalLine implements GuiLine {
  constructor(
    public arrowWidth = 0.5,
    public arrowSize = 0.75,
    public arrowOpacity = 0.2,
    public widthScale = 1,
  ) {}
  draw(gfx: Gfx, a: GuiRect, b: GuiRect, width: number, color: GuiColor, animate: boolean) {
    const w = width * this.widthScale;
    const sx = a.x() + a.w() / 2, sy = a.y() + a.h() / 2;
    const ddx = b.x() + b.w() / 2 - sx, ddy = b.y() + b.h() / 2 - sy;
    const len = Math.sqrt(ddx * ddx + ddy * ddy);
    const cos = len > 0 ? ddx / len : 1, sin = len > 0 ? ddy / len : 0;
    const P = (x: number, y: number) => [sx + x * cos - y * sin, sy + x * sin + y * cos];
    const argb = color.argb();
    gfx.poly([...P(0, w / 2), ...P(len, w / 2), ...P(len, -w / 2), ...P(0, -w / 2)], argb);
    if (showDependencyArrows && len > 0) {
      const alpha = Math.max(0, Math.min(255, Math.round(this.arrowOpacity * ((argb >>> 24) & 255))));
      const arrowColor = (alpha << 24) >>> 0;
      const n = Math.ceil(len / 20);
      const size = w * this.arrowSize;
      const off = n % 2 === 1 ? 0 : 1 / (n + 1) / 2;
      const aw = this.arrowWidth * w;
      for (let i = 0; i <= n; i++) {
        let p = i / (n + 1) + off;
        if (animate) {
          animating();
          const period = len * 50;
          p = (p + (performance.now() % period) / period) % 1;
        }
        const ax = len * p;
        const left = ax - aw / 2, right = ax + aw / 2;
        const tipL = ax + size - aw / 2, tipR = ax + size + aw / 2;
        gfx.poly([...P(left, w / 2), ...P(right, w / 2), ...P(tipR, 0), ...P(tipL, 0)], arrowColor);
        gfx.poly([...P(left, -w / 2), ...P(tipL, 0), ...P(tipR, 0), ...P(right, -w / 2)], arrowColor);
      }
    }
  }
}

// ---------------------------------------------------------------- loading

type Json = Record<string, unknown>;
const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
const arr4 = (v: unknown, d: [number, number, number, number]): [number, number, number, number] => {
  const out: [number, number, number, number] = [...d];
  if (Array.isArray(v)) for (let i = 0; i < 4 && i < v.length; i++) if (typeof v[i] === 'number') out[i] = v[i];
  return out;
};

export function colorFromJson(j: Json | undefined): GuiColor | null {
  if (!j) return null;
  switch (j.colorType) {
    case 'betterquesting:color_static':
      return staticColor(parseColorValue(j.color ?? 'FFFFFFFF'));
    case 'betterquesting:color_pulse':
      return pulseColor(
        colorFromJson(j.color1 as Json) ?? WHITE,
        colorFromJson(j.color2 as Json) ?? WHITE,
        num(j.period, 1),
        num(j.phase, 1),
      );
    case 'betterquesting:color_sequence':
      return sequenceColor(
        num(j.interval, 1),
        ((j.colors as Json[]) ?? []).map((c) => colorFromJson(c) ?? WHITE),
      );
    default:
      return null;
  }
}

export function textureFromJson(j: Json | undefined): GuiTexture | null {
  if (!j) return null;
  switch (j.textureType) {
    case 'betterquesting:texture_sliced': {
      const bounds = arr4(j.bounds, [0, 0, 16, 16]);
      const pad = arr4(j.padding, [0, 0, 16, 16]);
      const mode = Math.max(0, Math.min(2, num(j.sliceMode, 0))) as SliceMode;
      return new SlicedTexture(String(j.atlas ?? 'betterquesting:textures/gui/null_texture.png'), bounds, pad, mode);
    }
    case 'betterquesting:texture_simple':
      return new SimpleTexture(
        String(j.atlas ?? 'betterquesting:textures/gui/null_texture.png'),
        arr4(j.bounds, [0, 0, 16, 16]),
        !j.stretch,
      );
    case 'betterquesting:texture_color':
      return new ColorTexture(colorFromJson(j.color as Json) ?? WHITE, arr4(j.padding, [0, 0, 0, 0]));
    case 'betterquesting:texture_layered':
      return new LayeredTexture(
        ((j.layers as Json[]) ?? []).map(textureFromJson).filter((t): t is GuiTexture => !!t),
      );
    case 'betterquesting:texture_slides':
      return new SlideShowTexture(
        num(j.interval, 1),
        ((j.slides as Json[]) ?? []).map(textureFromJson).filter((t): t is GuiTexture => !!t),
      );
    default:
      return null;
  }
}

export function lineFromJson(j: Json | undefined): GuiLine | null {
  if (!j) return null;
  switch (j.lineType) {
    case 'betterquesting:line_simple':
      return new SimpleLine(num(j.stippleScale, 1), parseInt(String(j.stippleMask ?? '1111111111111111'), 2));
    case 'betterquesting:line_directional':
      return new DirectionalLine(
        num(j.arrowWidth, 0.5),
        num(j.arrowSize, 0.75),
        num(j.arrowOpacity, 0.2),
        num(j.widthScale, 1),
      );
    default:
      return null;
  }
}

export interface ThemeJson {
  themeID: string;
  themeName?: string;
  themeParent?: string;
  textures?: Record<string, Json>;
  colors?: Record<string, Json>;
  lines?: Record<string, Json>;
}

interface ResolvedTheme {
  id: string;
  name: string;
  parent: string | null;
  textures: Map<string, GuiTexture>;
  colors: Map<string, GuiColor>;
  lines: Map<string, GuiLine>;
}

const themes = new Map<string, ResolvedTheme>();
const defaults = {
  textures: new Map<string, GuiTexture>(),
  colors: new Map<string, GuiColor>(),
  lines: new Map<string, GuiLine>(),
};
for (const [k, v] of Object.entries(presets.textures)) {
  const t = textureFromJson(v as Json);
  if (t) defaults.textures.set(k, t);
}
for (const [k, v] of Object.entries(presets.colors)) {
  const c = colorFromJson(v as Json);
  if (c) defaults.colors.set(k, c);
}
for (const [k, v] of Object.entries(presets.lines)) {
  const l = lineFromJson(v as Json);
  if (l) defaults.lines.set(k, l);
}

export function registerThemes(list: ThemeJson[]) {
  for (const t of list) {
    const r: ResolvedTheme = {
      id: t.themeID,
      name: t.themeName ?? t.themeID,
      parent: t.themeParent && t.themeParent !== 'none' ? t.themeParent : null,
      textures: new Map(),
      colors: new Map(),
      lines: new Map(),
    };
    for (const [k, v] of Object.entries(t.textures ?? {})) {
      const x = textureFromJson(v);
      if (x) r.textures.set(k, x);
    }
    for (const [k, v] of Object.entries(t.colors ?? {})) {
      const x = colorFromJson(v);
      if (x) r.colors.set(k, x);
    }
    for (const [k, v] of Object.entries(t.lines ?? {})) {
      const x = lineFromJson(v);
      if (x) r.lines.set(k, x);
    }
    themes.set(r.id, r);
  }
}

export const themeList = () => [...themes.values()].map((t) => ({ id: t.id, name: t.name }));

let current = 'betterquesting:light';
export const currentTheme = () => current;
export function setTheme(id: string) {
  if (themes.has(id)) current = id;
}

function lookup<T>(kind: 'textures' | 'colors' | 'lines', key: string): T | undefined {
  const full = key.includes(':') ? key : `betterquesting:${key}`;
  let t = themes.get(current);
  const seen = new Set<string>();
  while (t && !seen.has(t.id)) {
    seen.add(t.id);
    const v = t[kind].get(full);
    if (v) return v as T;
    t = t.parent ? themes.get(t.parent) : undefined;
  }
  return defaults[kind].get(full) as T | undefined;
}

const NULL_TEXTURE: GuiTexture = { draw() {} };

/** Resolve through the current theme every draw, so switching theme takes effect immediately. */
export const tex = (key: string): GuiTexture => ({
  draw: (gfx, x, y, w, h, c) => (lookup<GuiTexture>('textures', key) ?? NULL_TEXTURE).draw(gfx, x, y, w, h, c),
});
export const col = (key: string): GuiColor => ({
  argb: () => (lookup<GuiColor>('colors', key) ?? WHITE).argb(),
});
export const line = (key: string): GuiLine => ({
  draw: (gfx, a, b, w, c, anim) => lookup<GuiLine>('lines', key)?.draw(gfx, a, b, w, c, anim),
});
export const icon = (key: string) => tex(`icon_${key}`);
