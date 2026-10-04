// Minecraft's bitmap font, rendered the way GTNH renders it.
//
// GTNH replaces the vanilla FontRenderer with Angelica's BatchingFontRenderer, and BetterQuesting
// measures text with GTNHLib's FontRendering helpers. Both use the vanilla glyph data (ascii.png,
// glyph_sizes.bin, unicode_page_XX.png) with the vanilla metrics, plus extra formatting:
// "&" codes converted to "§" codes, §x RGB colours, §g gradients, §q rainbow, §z wave,
// §v upside-down and §u shadow toggles.

import { resourceUrl, loadImage, tinted, image } from './assets.ts';
import type { Gfx } from './core.ts';
import { animating } from './frame.ts';

export const FONT_HEIGHT = 9;
export const SECTION = '§';

const ASCII =
  'ÀÁÂÈÊËÍÓÔÕÚßãõğİıŒœŞşŴŵžȇ\u0000\u0000\u0000\u0000\u0000\u0000\u0000 !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\u0000ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αβΓπΣσμτΦΘΩδ∞∅∈∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u0000';

const asciiIndex = new Map<number, number>();
for (let i = ASCII.length - 1; i >= 0; i--) asciiIndex.set(ASCII.charCodeAt(i), i);
asciiIndex.delete(0);

/** The 32 vanilla colours: 0-15 text, 16-31 their shadows. */
export const COLOR_CODES: number[] = [];
for (let i = 0; i < 32; i++) {
  const j = ((i >> 3) & 1) * 85;
  let k = ((i >> 2) & 1) * 170 + j;
  let l = ((i >> 1) & 1) * 170 + j;
  let i1 = (i & 1) * 170 + j;
  if (i === 6) k += 85;
  if (i >= 16) {
    k = Math.floor(k / 4);
    l = Math.floor(l / 4);
    i1 = Math.floor(i1 / 4);
  }
  COLOR_CODES[i] = ((k & 255) << 16) | ((l & 255) << 8) | (i1 & 255);
}

const charWidth = new Int32Array(256);
let glyphWidth = new Uint8Array(65536);
let asciiImg: HTMLImageElement | null = null;
let ready = false;

export async function loadFont() {
  const [img, sizes] = await Promise.all([
    loadImage(resourceUrl('minecraft:textures/font/ascii.png')),
    fetch(resourceUrl('minecraft:font/glyph_sizes.bin')).then((r) => (r.ok ? r.arrayBuffer() : new ArrayBuffer(65536))),
  ]);
  asciiImg = img;
  glyphWidth = new Uint8Array(sizes.byteLength >= 65536 ? sizes : new ArrayBuffer(65536));
  // FontRenderer.readFontTexture: width = last non-empty column, scaled to 8px cells, + 1.
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height).data;
  const W = c.width, cell = W / 16, cellH = c.height / 16, f = 8 / cell;
  for (let ch = 0; ch < 256; ch++) {
    const cx = ch % 16, cy = Math.floor(ch / 16);
    let col = cell - 1;
    for (; col >= 0; col--) {
      let empty = true;
      for (let row = 0; row < cellH && empty; row++) {
        if (data[((cy * cellH + row) * W + cx * cell + col) * 4 + 3] !== 0) empty = false;
      }
      if (!empty) break;
    }
    col++;
    charWidth[ch] = Math.floor(0.5 + col * f) + 1;
  }
  charWidth[32] = 4;
  ready = true;
}

export const fontReady = () => ready;

/** Advance of a single character (Angelica getCharWidthFine). § returns -1. */
export function charWidthFine(code: number): number {
  if (code === 0xa7) return -1;
  if (code === 32 || code === 0xa0 || code === 0x202f) return 4;
  const i = asciiIndex.get(code);
  if (i !== undefined) return charWidth[i];
  const gw = glyphWidth[code] ?? 0;
  if (!gw) return 0;
  const start = (gw >>> 4) & 15;
  const end = (gw & 15) + 1;
  return (end - start) / 2 + 1;
}

// ---------------------------------------------------------------- & code conversion

const VALID_SINGLE = '0123456789abcdefklmnorqzvu';
const isHex = (c: string) => /^[0-9a-fA-F]$/.test(c);
const isHex6At = (s: string, i: number) => i + 6 <= s.length && /^[0-9a-fA-F]{6}$/.test(s.slice(i, i + 6));

/** Angelica's ColorCodeUtils.convertAmpersandToSectionX. */
export function convertAmpersands(text: string): string {
  if (!text.includes('&')) return text;
  let out = '';
  let last = 0;
  let idx = text.indexOf('&');
  const len = text.length;
  while (idx !== -1 && idx + 1 < len) {
    if (idx > 0 && text[idx - 1] === '\\') {
      out += text.slice(last, idx - 1) + '';
      last = idx + 1;
      idx = text.indexOf('&', last);
      continue;
    }
    if (text[idx + 1] === '#' && idx + 7 < len && isHex6At(text, idx + 2)) {
      out += text.slice(last, idx) + SECTION + 'x';
      for (let i = 2; i <= 7; i++) out += SECTION + text[idx + i];
      last = idx + 8;
      idx = text.indexOf('&', last);
      continue;
    }
    if (
      text[idx + 1].toLowerCase() === 'g' && idx + 17 < len &&
      text[idx + 2] === '&' && text[idx + 3] === '#' && text[idx + 10] === '&' && text[idx + 11] === '#' &&
      isHex6At(text, idx + 4) && isHex6At(text, idx + 12)
    ) {
      out += text.slice(last, idx) + SECTION + 'g';
      last = idx + 2;
      idx = text.indexOf('&', last);
      continue;
    }
    if (VALID_SINGLE.includes(text[idx + 1].toLowerCase())) {
      out += text.slice(last, idx) + SECTION + text[idx + 1];
      last = idx + 2;
    }
    idx = text.indexOf('&', idx + 1);
  }
  return out + text.slice(last);
}

const isSectionXPayload = (s: string, start: number) => {
  if (start + 12 > s.length) return false;
  for (let k = 0; k < 6; k++) {
    const p = start + k * 2;
    if (s[p] !== SECTION || !isHex(s[p + 1])) return false;
  }
  return true;
};

const boldAfter = (wasBold: boolean, fmt: string) => {
  const c = fmt.toLowerCase();
  if (c === 'l') return true;
  if (c === 'r' || /[0-9a-f]/.test(c)) return false;
  return wasBold;
};

/** GTNHLib FontRendering.getStringWidth (with Angelica's & conversion). */
export function stringWidth(str: string): number {
  if (!str) return 0;
  str = convertAmpersands(str);
  let width = 0;
  let bold = false;
  for (let i = 0; i < str.length; i++) {
    let w = charWidthFine(str.charCodeAt(i));
    if (w < 0 && i + 1 < str.length) {
      i++;
      const f = str[i];
      if (f.toLowerCase() === 'x' && isSectionXPayload(str, i + 1)) i += 12;
      else bold = boldAfter(bold, f);
      w = 0;
    }
    width += w;
    if (bold && w > 0) width += 1;
  }
  return Math.ceil(width);
}

const isAmpGradientAt = (s: string, i: number) =>
  i + 18 <= s.length && s[i + 2] === '&' && s[i + 3] === '#' && isHex6At(s, i + 4) && s[i + 10] === '&' &&
  s[i + 11] === '#' && isHex6At(s, i + 12);

/** GTNHLib FontRendering.sizeStringToWidth: how many chars fit in wrapWidth. */
export function sizeStringToWidth(str: string, wrapWidth: number): number {
  const n = str.length;
  let width = 0, i = 0, lastBreak = -1, bold = false;
  while (i < n) {
    const c = str[i];
    if (c === '\n') {
      lastBreak = i;
      break;
    }
    let countIt = true;
    if (c === SECTION) {
      countIt = false;
      if (i + 1 < n) {
        i++;
        const f = str[i];
        if (f.toLowerCase() === 'x' && isSectionXPayload(str, i + 1)) i += 12;
        else bold = boldAfter(bold, f);
      }
    } else if (c === '&' && i + 1 < n) {
      const nx = str[i + 1];
      if (nx === '#' && isHex6At(str, i + 2)) {
        i += 7;
        countIt = false;
      } else if (nx.toLowerCase() === 'g' && isAmpGradientAt(str, i)) {
        i += 17;
        countIt = false;
      } else if ('0123456789abcdefklmnorxqzvu'.includes(nx.toLowerCase())) {
        bold = boldAfter(bold, nx);
        i += 1;
        countIt = false;
      }
    }
    if (countIt) {
      if (c === ' ' || c === '&') lastBreak = i;
      width += charWidthFine(str.charCodeAt(i));
      if (bold) width += 1;
    }
    if (Math.ceil(width) > wrapWidth) break;
    i++;
  }
  if (i !== n && lastBreak !== -1 && lastBreak < i) return lastBreak;
  return i;
}

// ---------------------------------------------------------------- drawing

const unicodePage = (page: number) =>
  image(resourceUrl(`minecraft:textures/font/unicode_page_${page.toString(16).padStart(2, '0')}.png`));

const RAINBOW: number[] = [];
for (let i = 0; i < 24; i++) {
  const h = i * 15;
  const x = 1 - Math.abs(((h / 60) % 2) - 1);
  const [r, g, b] =
    h < 60 ? [1, x, 0] : h < 120 ? [x, 1, 0] : h < 180 ? [0, 1, x] : h < 240 ? [0, x, 1] : h < 300 ? [x, 0, 1] : [1, 0, x];
  RAINBOW.push(((Math.floor(r * 255) << 16) | (Math.floor(g * 255) << 8) | Math.floor(b * 255)) >>> 0);
}

const parseHexPairs = (s: string, start: number, count: number) => {
  let v = 0;
  for (let k = 0; k < count; k++) {
    const p = start + k * 2;
    if (s[p] !== SECTION || !isHex(s[p + 1])) return -1;
    v = (v << 4) | parseInt(s[p + 1], 16);
  }
  return v;
};
const parseSectionXAt = (s: string, start: number) =>
  s[start] === SECTION && s[start + 1]?.toLowerCase() === 'x' ? parseHexPairs(s, start + 2, 6) : -1;

function countVisible(s: string, from: number) {
  let n = 0;
  for (let i = from; i < s.length; i++) {
    if (s[i] === SECTION && i + 1 < s.length) {
      const c = s[i + 1].toLowerCase();
      if (c === 'r' || /[0-9a-f]/.test(c) || c === 'x' || c === 'q' || c === 'g') break;
      i++;
    } else n++;
  }
  return n;
}

function drawGlyph(
  gfx: Gfx,
  code: number,
  x: number,
  y: number,
  rgb: number,
  alpha: number,
  italic: boolean,
  flip: boolean,
) {
  let img: CanvasImageSource | null = null;
  let sx = 0, sy = 0, sw = 0, sh = 0, dw = 0;
  const i = asciiIndex.get(code);
  if (i !== undefined) {
    if (!asciiImg) return;
    img = asciiImg;
    const k = asciiImg.naturalWidth / 128;
    sx = (i % 16) * 8 * k;
    sy = Math.floor(i / 16) * 8 * k;
    dw = charWidth[i] - 1;
    sw = dw * k;
    sh = 8 * k;
  } else {
    const gw = glyphWidth[code];
    if (!gw) return;
    img = unicodePage(code >> 8);
    if (!img) return;
    const k = (img as HTMLImageElement).naturalWidth / 256;
    const start = (gw >>> 4) & 15, end = (gw & 15) + 1;
    sx = ((code % 16) * 16 + start) * k;
    sy = Math.floor((code & 255) / 16) * 16 * k;
    sw = (end - start) * k;
    sh = 16 * k;
    dw = (end - start) / 2;
  }
  if (dw <= 0) return;
  const t = tinted(img, 0, 0, (img as HTMLImageElement).naturalWidth, (img as HTMLImageElement).naturalHeight, rgb);
  const g = gfx.g;
  const s = gfx.s;
  const x0 = Math.round(gfx.ox + x * s);
  const y0 = Math.round(gfx.oy + y * s);
  const w = Math.round(gfx.ox + (x + dw) * s) - x0;
  const h = Math.round(gfx.oy + (y + 8) * s) - y0;
  const prevA = g.globalAlpha;
  g.globalAlpha = prevA * alpha;
  if (italic || flip) {
    g.save();
    if (italic && h > 0) {
      // The top edge shifts right by 1 GUI unit and the bottom edge left by 1.
      const c = (-2 * s) / h;
      g.transform(1, 0, c, 1, s - c * y0, 0);
    }
    if (flip) g.transform(1, 0, 0, -1, 0, 2 * y0 + h);
    g.drawImage(t.src, sx, sy, sw, sh, x0, y0, w, h);
    g.restore();
  } else {
    g.drawImage(t.src, sx, sy, sw, sh, x0, y0, w, h);
  }
  g.globalAlpha = prevA;
}

let wavePhaseTime = 0;

/**
 * Draw a single line of formatted text (FontRenderer.drawString). Returns the end x position.
 * color is ARGB; an alpha of 0 is treated as opaque, like vanilla.
 */
export function drawString(gfx: Gfx, text: string, x: number, y: number, color: number, shadow = false): number {
  if (!text) return x;
  text = convertAmpersands(text);
  if ((color & 0xfc000000) === 0) color = (color | 0xff000000) >>> 0;
  const alpha = ((color >>> 24) & 255) / 255;
  const baseRgb = color & 0xffffff;
  const baseShadow = (color & 0xfcfcfc) >> 2;
  wavePhaseTime = performance.now() * 5e-3;

  let curRgb = baseRgb, curShadowRgb = baseShadow;
  let random = false, bold = false, strike = false, under = false, italic = false;
  let rainbow = false, wave = false, flip = false, gradient = false, segShadow = false;
  let shadowOverride = -1;
  let gStart = 0, gEnd = 0, gIdx = 0, gTotal = 0, gStep = 0, rIdx = 0, vis = 0;
  let curX = x;

  const lineRect = (x0: number, x1: number, yy: number, rgb: number, shadowRgb: number, withShadow: boolean) => {
    if (x1 <= x0) return;
    if (withShadow) gfx.fill(x0 + 1, yy + 1, x1 - x0, 1, ((Math.round(alpha * 255) << 24) | shadowRgb) >>> 0);
    gfx.fill(x0, yy, x1 - x0, 1, ((Math.round(alpha * 255) << 24) | rgb) >>> 0);
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === SECTION && i + 1 < text.length) {
      const f = text[i + 1].toLowerCase();
      i++;
      if (f === 'x' && i + 12 < text.length + 0 && isSectionXPayload(text, i + 1)) {
        const rgb = parseHexPairs(text, i + 1, 6);
        rainbow = gradient = false;
        curRgb = rgb;
        curShadowRgb = (rgb & 0xfcfcfc) >> 2;
        i += 12;
      } else if (/[0-9a-f]/.test(f)) {
        random = bold = strike = under = italic = rainbow = gradient = false;
        const ci = parseInt(f, 16);
        curRgb = COLOR_CODES[ci];
        curShadowRgb = COLOR_CODES[ci + 16];
      } else if (f === 'k') random = true;
      else if (f === 'l') bold = true;
      else if (f === 'm') strike = true;
      else if (f === 'n') under = true;
      else if (f === 'o') italic = true;
      else if (f === 'q') {
        rainbow = true;
        gradient = false;
        rIdx = 0;
      } else if (f === 'z') wave = !wave;
      else if (f === 'v') flip = !flip;
      else if (f === 'u') {
        const custom = parseSectionXAt(text, i + 1);
        if (custom !== -1) {
          segShadow = true;
          shadowOverride = custom;
          i += 14;
        } else {
          segShadow = !segShadow;
          if (!segShadow) shadowOverride = -1;
        }
      } else if (f === 'g') {
        const c1 = parseSectionXAt(text, i + 1);
        const c2 = parseSectionXAt(text, i + 15);
        if (c1 !== -1 && c2 !== -1) {
          gradient = true;
          rainbow = false;
          gStart = c1;
          gEnd = c2;
          gIdx = 0;
          gTotal = countVisible(text, i + 29);
          gStep = gTotal > 1 ? 1 / (gTotal - 1) : 0;
          i += 28;
        }
      } else if (f === 'r') {
        random = bold = strike = under = italic = rainbow = wave = flip = gradient = segShadow = false;
        shadowOverride = -1;
        curRgb = baseRgb;
        curShadowRgb = baseShadow;
      }
      continue;
    }

    let code = ch.charCodeAt(0);
    if (code === 0xe000) code = 38; // escaped &
    vis++;
    if (code === 32 || code === 0xa0 || code === 0x202f) {
      const adv = 4 + (bold ? 1 : 0);
      if (under) lineRect(curX - 1, curX + adv, y + FONT_HEIGHT - 1, curRgb, curShadowRgb, shadow || segShadow);
      if (strike) lineRect(curX - 1, curX + adv, y + 3, curRgb, curShadowRgb, shadow || segShadow);
      curX += adv;
      continue;
    }
    if (random || wave) animating();
    if (random) {
      const idx = asciiIndex.get(code);
      if (idx !== undefined) {
        const w = charWidth[idx];
        const same: number[] = [];
        for (let k = 0; k < 256; k++) if (charWidth[k] === w && ASCII.charCodeAt(k) !== 0) same.push(ASCII.charCodeAt(k));
        if (same.length) code = same[Math.floor(Math.random() * same.length)];
      }
    }
    if (rainbow) {
      curRgb = RAINBOW[rIdx % 24];
      curShadowRgb = (curRgb & 0xfcfcfc) >> 2;
      rIdx++;
    }
    if (gradient && gTotal > 0) {
      const t = Math.min(gIdx * gStep, 1);
      const mix = (s: number) => Math.floor(((gStart >> s) & 255) * (1 - t) + ((gEnd >> s) & 255) * t);
      curRgb = (mix(16) << 16) | (mix(8) << 8) | mix(0);
      curShadowRgb = (curRgb & 0xfcfcfc) >> 2;
      gIdx++;
    }
    const adv = charWidthFine(code);
    let gy = y;
    if (wave) gy += Math.sin(vis * 0.5 + wavePhaseTime) * 2;
    if (shadow || segShadow) {
      const srgb = shadowOverride >= 0 ? shadowOverride : curShadowRgb;
      drawGlyph(gfx, code, curX + 1, gy + 1, srgb, alpha, italic, flip);
      if (bold) drawGlyph(gfx, code, curX + 2, gy + 1, srgb, alpha, italic, flip);
    }
    drawGlyph(gfx, code, curX, gy, curRgb, alpha, italic, flip);
    if (bold) drawGlyph(gfx, code, curX + 1, gy, curRgb, alpha, italic, flip);
    const total = adv + (bold ? 1 : 0);
    if (under) lineRect(curX - 1, curX + total, y + FONT_HEIGHT - 1, curRgb, curShadowRgb, shadow || segShadow);
    if (strike) lineRect(curX - 1, curX + total, y + 3, curRgb, curShadowRgb, shadow || segShadow);
    curX += total;
  }
  return curX;
}

/** Remove all formatting codes (EnumChatFormatting.getTextWithoutFormattingCodes). */
export const stripFormatting = (s: string) => s.replace(/§[0-9a-fk-or]/gi, '');
