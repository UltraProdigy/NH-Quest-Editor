// Colours as BetterQuesting models them (IGuiColor): ARGB integers, optionally animated.

import { animating } from './frame.ts';

export interface GuiColor {
  /** Current ARGB value (unsigned). */
  argb(): number;
}

export const staticColor = (argb: number): GuiColor => {
  const v = argb >>> 0;
  return { argb: () => v };
};

export const WHITE = staticColor(0xffffffff);

export function lerpRGB(c1: number, c2: number, blend: number): number {
  // RenderUtils.lerpRGB: per-channel lerp including alpha.
  const ch = (c: number, s: number) => (c >>> s) & 255;
  const mix = (s: number) => Math.round(ch(c1, s) + (ch(c2, s) - ch(c1, s)) * blend) & 255;
  return ((mix(24) << 24) | (mix(16) << 16) | (mix(8) << 8) | mix(0)) >>> 0;
}

/**
 * Steps a pulse blend is rounded to. Tinted textures are cached per colour, so a continuous blend
 * would make a new tinted copy of every texture on every frame; 32 steps look the same.
 */
const PULSE_STEPS = 32;

/** GuiColorPulse: cosine blend between two colours. period in seconds, phase 0..1. */
export const pulseColor = (c1: GuiColor, c2: GuiColor, period: number, phase: number): GuiColor => ({
  argb() {
    animating();
    const pms = 1000 * period;
    let time = performance.now() % pms;
    time = ((time + pms * phase) % pms) / pms;
    const blend = Math.round((Math.cos(time * Math.PI * 2) / 2 + 0.5) * PULSE_STEPS) / PULSE_STEPS;
    return lerpRGB(c1.argb(), c2.argb(), blend);
  },
});

/** GuiColorSequence: steps through colours, `interval` seconds each. */
export const sequenceColor = (interval: number, colors: GuiColor[]): GuiColor => ({
  argb() {
    if (colors.length === 0) return 0xffffffff;
    if (colors.length > 1) animating();
    const i = Math.floor((performance.now() / 1000 / interval) % colors.length);
    return colors[i].argb();
  },
});

/** Parse BQ's colour strings ("FF000000", hex without #) and plain numbers. */
export function parseColorValue(v: unknown): number {
  if (typeof v === 'number') return v >>> 0;
  if (typeof v === 'string') {
    const n = parseInt(v.replace(/^#/, ''), 16);
    if (Number.isFinite(n)) return n >>> 0;
  }
  return 0xffffffff;
}

export const alphaOf = (argb: number) => ((argb >>> 24) & 255) / 255;
export const rgbCss = (argb: number) => `#${(argb & 0xffffff).toString(16).padStart(6, '0')}`;
export const rgbaCss = (argb: number) =>
  `rgba(${(argb >>> 16) & 255},${(argb >>> 8) & 255},${argb & 255},${alphaOf(argb)})`;
