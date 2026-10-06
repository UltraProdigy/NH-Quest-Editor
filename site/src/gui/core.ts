// Core of the GUI port: a drawing context in GUI units, BetterQuesting's rectangle/transform
// model, and the panel/canvas interfaces.
//
// Everything is laid out in Minecraft "GUI pixels" (the scaled resolution). Gfx maps those to
// device pixels with an offset and scale so that panels inside zoomed canvases (the quest map)
// can be drawn with the same code. Image edges are rounded to whole device pixels, which keeps
// nine-slice textures seamless at any zoom, like GL does.

import { drawTinted } from './assets.ts';
import { animating } from './frame.ts';

export class Gfx {
  g: CanvasRenderingContext2D;
  /** device = o + gui * s */
  ox = 0;
  oy = 0;
  s = 1;
  /** Device pixels per GUI unit at the root, i.e. the GUI scale. s / base is the GL modelview scale. */
  base = 1;
  /** Milliseconds, fixed for the frame so every animation reads the same clock. */
  now = 0;
  private stack: [number, number, number][] = [];
  private clipDepth = 0;

  constructor(g: CanvasRenderingContext2D) {
    this.g = g;
  }

  push() {
    this.stack.push([this.ox, this.oy, this.s]);
  }
  pop() {
    const t = this.stack.pop();
    if (t) [this.ox, this.oy, this.s] = t;
  }
  translate(x: number, y: number) {
    this.ox += x * this.s;
    this.oy += y * this.s;
  }
  scale(k: number) {
    this.s *= k;
  }

  dx(x: number) {
    return Math.round(this.ox + x * this.s);
  }
  dy(y: number) {
    return Math.round(this.oy + y * this.s);
  }

  /** Start clipping to a GUI-space rectangle (RenderUtils.startScissor). Always pair with endClip. */
  clip(x: number, y: number, w: number, h: number) {
    const x0 = this.dx(x), y0 = this.dy(y), x1 = this.dx(x + w), y1 = this.dy(y + h);
    this.g.save();
    this.g.beginPath();
    this.g.rect(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
    this.g.clip();
    this.clipDepth++;
  }
  endClip() {
    if (this.clipDepth > 0) {
      this.clipDepth--;
      this.g.restore();
    }
  }

  /** Draw an image region into a GUI-space rectangle, tinted by an ARGB colour. */
  image(
    img: CanvasImageSource,
    sx: number, sy: number, sw: number, sh: number,
    x: number, y: number, w: number, h: number,
    argb = 0xffffffff,
  ) {
    const x0 = this.dx(x), y0 = this.dy(y), x1 = this.dx(x + w), y1 = this.dy(y + h);
    drawTinted(this.g, img, sx, sy, sw, sh, x0, y0, x1 - x0, y1 - y0, argb);
  }

  /**
   * Draw part of an image (an exported item icon) into a GUI-space rectangle, snapped to device
   * pixels and always sampled nearest-neighbour. The game draws items as geometry with
   * GL_NEAREST textures, which picks one texel per screen pixel at any scale; point-sampling a
   * high-resolution render at each screen pixel gives the same picture. Filtering here would
   * blur, and enlarging a low-resolution render would make 3D blocks blocky.
   */
  icon(
    img: CanvasImageSource,
    sx: number, sy: number, sw: number, sh: number,
    x: number, y: number, w: number, h: number,
    alpha = 1,
  ) {
    const x0 = this.dx(x), y0 = this.dy(y), x1 = this.dx(x + w), y1 = this.dy(y + h);
    if (x1 <= x0 || y1 <= y0) return;
    const g = this.g;
    const prevA = g.globalAlpha;
    g.globalAlpha = prevA * alpha;
    g.drawImage(img, sx, sy, sw, sh, x0, y0, x1 - x0, y1 - y0);
    g.globalAlpha = prevA;
  }

  fill(x: number, y: number, w: number, h: number, argb: number) {
    const a = ((argb >>> 24) & 255) / 255;
    if (a <= 0 || w <= 0 || h <= 0) return;
    const x0 = this.dx(x), y0 = this.dy(y), x1 = this.dx(x + w), y1 = this.dy(y + h);
    this.g.fillStyle = `rgba(${(argb >>> 16) & 255},${(argb >>> 8) & 255},${argb & 255},${a})`;
    this.g.fillRect(x0, y0, x1 - x0, y1 - y0);
  }

  /** Vertical gradient (Gui.drawGradientRect). */
  gradient(x: number, y: number, w: number, h: number, top: number, bottom: number) {
    const x0 = this.dx(x), y0 = this.dy(y), x1 = this.dx(x + w), y1 = this.dy(y + h);
    if (x1 <= x0 || y1 <= y0) return;
    const css = (c: number) =>
      `rgba(${(c >>> 16) & 255},${(c >>> 8) & 255},${c & 255},${((c >>> 24) & 255) / 255})`;
    const gr = this.g.createLinearGradient(0, y0, 0, y1);
    gr.addColorStop(0, css(top));
    gr.addColorStop(1, css(bottom));
    this.g.fillStyle = gr;
    this.g.fillRect(x0, y0, x1 - x0, y1 - y0);
  }

  /** Fill a polygon given in GUI coordinates (used for dependency lines). */
  poly(pts: number[], argb: number) {
    const a = ((argb >>> 24) & 255) / 255;
    if (a <= 0) return;
    const g = this.g;
    g.beginPath();
    for (let i = 0; i < pts.length; i += 2) {
      const px = this.ox + pts[i] * this.s;
      const py = this.oy + pts[i + 1] * this.s;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.closePath();
    g.fillStyle = `rgba(${(argb >>> 16) & 255},${(argb >>> 8) & 255},${argb & 255},${a})`;
    g.fill();
  }

  /** GL_LINES with a given width in device pixels (glLineWidth is in screen pixels). */
  line(x1: number, y1: number, x2: number, y2: number, widthPx: number, argb: number, dash?: number[]) {
    const a = ((argb >>> 24) & 255) / 255;
    if (a <= 0) return;
    const g = this.g;
    g.save();
    g.beginPath();
    g.moveTo(this.ox + x1 * this.s, this.oy + y1 * this.s);
    g.lineTo(this.ox + x2 * this.s, this.oy + y2 * this.s);
    g.lineWidth = widthPx;
    if (dash) g.setLineDash(dash);
    g.strokeStyle = `rgba(${(argb >>> 16) & 255},${(argb >>> 8) & 255},${argb & 255},${a})`;
    g.stroke();
    g.restore();
  }
}

// ---------------------------------------------------------------- rectangles

export interface GuiRect {
  x(): number;
  y(): number;
  w(): number;
  h(): number;
  depth(): number;
  parent: GuiRect | null;
}

export const contains = (r: GuiRect, mx: number, my: number) => {
  const x = r.x(), y = r.y();
  return mx >= x && mx < x + r.w() && my >= y && my < y + r.h();
};

/** Rectangle offset from its parent's origin (GuiRectangle). */
export class Rect implements GuiRect {
  parent: GuiRect | null = null;
  constructor(
    public rx: number,
    public ry: number,
    public rw: number,
    public rh: number,
    public order = 0,
  ) {}
  x() { return this.rx + (this.parent ? this.parent.x() : 0); }
  y() { return this.ry + (this.parent ? this.parent.y() : 0); }
  w() { return this.rw; }
  h() { return this.rh; }
  depth() { return this.order; }
}

export type Anchor = readonly [l: number, t: number, r: number, b: number];
export type Padding = readonly [l: number, t: number, r: number, b: number];

export const Align = {
  FULL_BOX: [0, 0, 1, 1],
  TOP_LEFT: [0, 0, 0, 0],
  TOP_CENTER: [0.5, 0, 0.5, 0],
  TOP_RIGHT: [1, 0, 1, 0],
  TOP_EDGE: [0, 0, 1, 0],
  MID_LEFT: [0, 0.5, 0, 0.5],
  MID_CENTER: [0.5, 0.5, 0.5, 0.5],
  MID_RIGHT: [1, 0.5, 1, 0.5],
  BOTTOM_LEFT: [0, 1, 0, 1],
  BOTTOM_CENTER: [0.5, 1, 0.5, 1],
  BOTTOM_RIGHT: [1, 1, 1, 1],
  BOTTOM_EDGE: [0, 1, 1, 1],
  HALF_LEFT: [0, 0, 0.5, 1],
  HALF_RIGHT: [0.5, 0, 1, 1],
  HALF_TOP: [0, 0, 1, 0.5],
  HALF_BOTTOM: [0, 0.5, 1, 1],
  LEFT_EDGE: [0, 0, 0, 1],
  RIGHT_EDGE: [1, 0, 1, 1],
} as const satisfies Record<string, Anchor>;

export const quickAnchor = (a: Anchor, b: Anchor): Anchor => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];

/** Anchored transform relative to its parent (GuiTransform). */
export class Transform implements GuiRect {
  parent: GuiRect | null = null;
  anchor: [number, number, number, number];
  pad: [number, number, number, number];
  constructor(anchor: Anchor, padding: Padding, public order = 0) {
    this.anchor = [
      Math.min(anchor[0], anchor[2]),
      Math.min(anchor[1], anchor[3]),
      Math.max(anchor[0], anchor[2]),
      Math.max(anchor[1], anchor[3]),
    ];
    this.pad = [...padding];
  }
  /** GuiTransform(anchor, xOff, yOff, width, height, order) */
  static at(anchor: Anchor, x: number, y: number, w: number, h: number, order = 0) {
    return new Transform([anchor[0], anchor[1], anchor[0], anchor[1]], [x, y, -x - w, -y - h], order);
  }
  x() {
    const p = this.parent;
    return (p ? p.x() + Math.ceil(p.w() * this.anchor[0]) : 0) + this.pad[0];
  }
  y() {
    const p = this.parent;
    return (p ? p.y() + Math.ceil(p.h() * this.anchor[1]) : 0) + this.pad[1];
  }
  w() {
    const p = this.parent;
    return (p ? Math.ceil(p.w() * (this.anchor[2] - this.anchor[0])) : 0) - (this.pad[2] + this.pad[0]);
  }
  h() {
    const p = this.parent;
    return (p ? Math.ceil(p.h() * (this.anchor[3] - this.anchor[1])) : 0) - (this.pad[3] + this.pad[1]);
  }
  depth() { return this.order; }
}

/** A rectangle that animates from one rectangle to another (GuiRectLerp). */
export class RectLerp implements GuiRect {
  parent: GuiRect | null = null;
  private start: GuiRect;
  private target: GuiRect;
  private t0 = 0;
  private dur = 0;
  constructor(r: GuiRect) {
    this.start = r;
    this.target = r;
    this.parent = r.parent;
  }
  private blend() {
    if (this.dur <= 0) return 1;
    const b = Math.min(1, (performance.now() - this.t0) / this.dur);
    if (b < 1) animating(true);
    return b;
  }
  private idle() {
    return this.blend() >= 1;
  }
  lerpTo(r: GuiRect, ms: number) {
    if (ms <= 0) return;
    // Freeze the current position as the new start.
    this.start = new Rect(this.x(), this.y(), this.w(), this.h());
    this.target = r;
    this.t0 = performance.now();
    this.dur = ms;
  }
  snapTo(r: GuiRect) {
    this.start = r;
    this.target = r;
    this.dur = 0;
  }
  private lerp(a: number, b: number) {
    return Math.round(a + (b - a) * this.blend());
  }
  x() { return this.idle() ? this.target.x() : this.lerp(this.start.x(), this.target.x()); }
  y() { return this.idle() ? this.target.y() : this.lerp(this.start.y(), this.target.y()); }
  w() { return this.idle() ? this.target.w() : this.lerp(this.start.w(), this.target.w()); }
  h() { return this.idle() ? this.target.h() : this.lerp(this.start.h(), this.target.h()); }
  depth() { return this.target.depth(); }
}

// ---------------------------------------------------------------- panels

/** A tooltip line drawn by code instead of text (CodeChickenLib's ITooltipLineHandler). */
export interface TipLine {
  width: number;
  height: number;
  draw(gfx: Gfx, x: number, y: number): void;
}

export type Tooltip = (string | TipLine)[] | null;

/** Mouse buttons currently held (Mouse.isButtonDown). Updated by the screen host. */
export const mouseButtons = [false, false, false];
/** Shift held (Keyboard.isKeyDown(KEY_LSHIFT)). */
export const keys = { shift: false };

export interface Panel {
  transform: GuiRect;
  enabled: boolean;
  init(): void;
  draw(gfx: Gfx, mx: number, my: number): void;
  mouseDown(mx: number, my: number, button: number): boolean;
  mouseUp(mx: number, my: number, button: number): boolean;
  scroll(mx: number, my: number, dir: number): boolean;
  key(e: KeyboardEvent): boolean;
  tooltip(mx: number, my: number): Tooltip;
}

export abstract class BasePanel implements Panel {
  enabled = true;
  constructor(public transform: GuiRect) {}
  init() {}
  abstract draw(gfx: Gfx, mx: number, my: number): void;
  mouseDown(_mx: number, _my: number, _b: number) { return false; }
  mouseUp(_mx: number, _my: number, _b: number) { return false; }
  scroll(_mx: number, _my: number, _d: number) { return false; }
  key(_e: KeyboardEvent) { return false; }
  tooltip(_mx: number, _my: number): Tooltip { return null; }
}

/** A panel holding children in draw order (CanvasEmpty). Children get this canvas as parent. */
export class CanvasEmpty extends BasePanel {
  children: Panel[] = [];

  add<T extends Panel>(p: T): T {
    p.transform.parent = this.transform;
    this.children.push(p);
    // Stable sort by depth: higher depth draws first (ComparatorGuiDepth).
    if (this.children.some((c) => c.transform.depth() !== this.children[0].transform.depth())) {
      this.children = this.children
        .map((c, i) => [c, i] as const)
        .sort((a, b) => b[0].transform.depth() - a[0].transform.depth() || a[1] - b[1])
        .map((e) => e[0]);
    }
    p.init();
    return p;
  }
  remove(p: Panel) {
    const i = this.children.indexOf(p);
    if (i >= 0) this.children.splice(i, 1);
  }
  clear() {
    this.children = [];
  }

  draw(gfx: Gfx, mx: number, my: number) {
    for (const c of this.children) if (c.enabled) c.draw(gfx, mx, my);
  }
  mouseDown(mx: number, my: number, b: number) {
    for (let i = this.children.length - 1; i >= 0; i--) {
      const c = this.children[i];
      if (c.enabled && c.mouseDown(mx, my, b)) return true;
    }
    return false;
  }
  mouseUp(mx: number, my: number, b: number) {
    let used = false;
    for (let i = this.children.length - 1; i >= 0; i--) {
      const c = this.children[i];
      if (c.enabled && c.mouseUp(mx, my, b)) {
        used = true;
        break;
      }
    }
    return used;
  }
  scroll(mx: number, my: number, d: number) {
    for (let i = this.children.length - 1; i >= 0; i--) {
      const c = this.children[i];
      if (c.enabled && c.scroll(mx, my, d)) return true;
    }
    return false;
  }
  key(e: KeyboardEvent) {
    for (let i = this.children.length - 1; i >= 0; i--) {
      const c = this.children[i];
      if (c.enabled && c.key(e)) return true;
    }
    return false;
  }
  tooltip(mx: number, my: number): Tooltip {
    for (let i = this.children.length - 1; i >= 0; i--) {
      const c = this.children[i];
      if (!c.enabled) continue;
      const t = c.tooltip(mx, my);
      if (t && t.length) return t;
    }
    return null;
  }
}
