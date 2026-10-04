// Screens (GuiScreenCanvas) and the host that runs them on a <canvas>: GUI scale, input,
// tooltips and redraw scheduling.

import { CanvasEmpty, Gfx, Rect, Transform, Align, mouseButtons, keys, type Tooltip, type Panel } from './core.ts';
import { drawString, stringWidth, FONT_HEIGHT } from './font.ts';
import { splitString } from './text.ts';
import { redraw } from './frame.ts';

/** Frame interval while only animations change the picture (input still redraws at once). */
const ANIMATION_FRAME_MS = 1000 / 30;

export abstract class Screen {
  root!: CanvasEmpty;
  width = 0;
  height = 0;
  useMargins = true;
  host!: Host;
  popup: Panel | null = null;
  private screenRect = new Rect(0, 0, 0, 0);

  constructor(public parent: Screen | null) {}

  /** Build all panels (initPanel). Called on open and again on every resize. */
  abstract build(): void;

  /** The URL hash for this screen. */
  abstract route(): string;

  /** Document title for this screen. */
  title(): string {
    return '';
  }

  layout(w: number, h: number) {
    this.width = w;
    this.height = h;
    const screenRect = (this.screenRect = new Rect(0, 0, w, h));
    const t = new Transform(Align.FULL_BOX, [0, 0, 0, 0]);
    t.parent = screenRect;
    this.popup = null;
    if (this.useMargins) {
      const mx = 16, my = 16;
      t.pad = [mx, my, mx, my];
    }
    this.root = new CanvasEmpty(t);
    this.build();
  }

  openPopup(p: Panel) {
    p.transform.parent = this.screenRect;
    this.popup = p;
    p.init();
  }
  closePopup() {
    this.popup = null;
  }

  draw(gfx: Gfx, mx: number, my: number) {
    this.root.draw(gfx, mx, my);
    if (this.popup?.enabled) this.popup.draw(gfx, mx, my);
  }
  mouseDown(mx: number, my: number, b: number) {
    if (this.popup?.enabled) {
      this.popup.mouseDown(mx, my, b);
      return true;
    }
    const used = this.root.mouseDown(mx, my, b);
    if (!used && b === 1 && this.parent) {
      this.host.back();
      return false;
    }
    return used;
  }
  mouseUp(mx: number, my: number, b: number) {
    if (this.popup?.enabled) {
      this.popup.mouseUp(mx, my, b);
      return true;
    }
    return this.root.mouseUp(mx, my, b);
  }
  scroll(mx: number, my: number, d: number) {
    if (this.popup?.enabled) {
      this.popup.scroll(mx, my, d);
      return true;
    }
    return this.root.scroll(mx, my, d);
  }
  key(e: KeyboardEvent) {
    if (this.popup && e.key === 'Escape') {
      this.closePopup();
      return true;
    }
    if (this.root.key(e)) return true;
    if ((e.key === 'Escape' || e.key === 'Backspace') && this.parent) {
      this.host.back();
      return true;
    }
    return false;
  }
  tooltip(mx: number, my: number): Tooltip {
    if (this.popup?.enabled) return this.popup.tooltip(mx, my);
    return this.root.tooltip(mx, my);
  }
  /** Called after the screen is shown again (returning from a child screen). */
  resumed() {}
}

// ---------------------------------------------------------------- tooltips

/** Forge's GuiUtils.drawHoveringText as BQ uses it (RenderUtils.drawHoveringText). */
export function drawHoveringText(gfx: Gfx, lines: string[], mx: number, my: number, sw: number, sh: number, maxW = -1) {
  if (!lines.length) return;
  let tw = 0;
  for (const l of lines) tw = Math.max(tw, stringWidth(l));
  let wrap = false;
  let titleLines = 1;
  let tx = mx + 12;
  if (tx + tw + 4 > sw) {
    tx = mx - 16 - tw;
    if (tx < 4) {
      tw = mx > sw / 2 ? mx - 12 - 8 : sw - 16 - mx;
      wrap = true;
    }
  }
  if (maxW > 0 && tw > maxW) {
    tw = maxW;
    wrap = true;
  }
  if (wrap) {
    let ww = 0;
    const out: string[] = [];
    lines.forEach((l, i) => {
      const w = splitString(l, tw, true);
      if (i === 0) titleLines = w.length;
      for (const x of w) {
        ww = Math.max(ww, stringWidth(x));
        out.push(x);
      }
    });
    tw = ww;
    lines = out;
    tx = mx > sw / 2 ? mx - 16 - tw : mx + 12;
  }
  let ty = my - 12;
  let th = 8;
  if (lines.length > 1) {
    th += (lines.length - 1) * 10;
    if (lines.length > titleLines) th += 2;
  }
  if (ty < 4) ty = 4;
  else if (ty + th + 4 > sh) ty = sh - th - 4;

  const bg = 0xf0100010, b0 = 0x505000ff, b1 = ((b0 & 0xfefefe) >> 1) | (b0 & 0xff000000);
  const r = (x0: number, y0: number, x1: number, y1: number, c0: number, c1: number) =>
    gfx.gradient(x0, y0, x1 - x0, y1 - y0, c0 >>> 0, c1 >>> 0);
  r(tx - 3, ty - 4, tx + tw + 3, ty - 3, bg, bg);
  r(tx - 3, ty + th + 3, tx + tw + 3, ty + th + 4, bg, bg);
  r(tx - 3, ty - 3, tx + tw + 3, ty + th + 3, bg, bg);
  r(tx - 4, ty - 3, tx - 3, ty + th + 3, bg, bg);
  r(tx + tw + 3, ty - 3, tx + tw + 4, ty + th + 3, bg, bg);
  r(tx - 3, ty - 3 + 1, tx - 3 + 1, ty + th + 3 - 1, b0, b1);
  r(tx + tw + 2, ty - 3 + 1, tx + tw + 3, ty + th + 3 - 1, b0, b1);
  r(tx - 3, ty - 3, tx + tw + 3, ty - 3 + 1, b0, b0);
  r(tx - 3, ty + th + 2, tx + tw + 3, ty + th + 3, b1, b1);
  lines.forEach((l, i) => {
    drawString(gfx, l, tx, ty, 0xffffffff, true);
    if (i + 1 === titleLines) ty += 2;
    ty += 10;
  });
}

// ---------------------------------------------------------------- host

export interface HostOptions {
  /** Called when the visible screen changes (for the URL and document title). push: a new screen was opened. */
  onNavigate?: (s: Screen, push: boolean) => void;
}

export class Host {
  canvas: HTMLCanvasElement;
  gfx: Gfx;
  screen: Screen | null = null;
  /** 0 = auto (Minecraft's rule), otherwise a fixed GUI scale. */
  scaleSetting = 0;
  scale = 2;
  private mx = -1;
  private my = -1;
  private w = 0;
  private h = 0;
  private dirty = true;
  private lastSize = '';
  private frameQueued = false;
  private animTimer = 0;
  private lastFrame = 0;

  private deviceSize() {
    const dpr = window.devicePixelRatio || 1;
    return `${Math.floor(this.canvas.clientWidth * dpr)}x${Math.floor(this.canvas.clientHeight * dpr)}`;
  }

  constructor(canvas: HTMLCanvasElement, private opts: HostOptions = {}) {
    this.canvas = canvas;
    const g = canvas.getContext('2d', { alpha: false })!;
    this.gfx = new Gfx(g);
    this.bind();
    const resized = () => {
      // Only a real size change rebuilds the screen (Minecraft re-inits GUIs on resize).
      if (this.deviceSize() !== this.lastSize) this.dirty = true;
      this.invalidate();
    };
    new ResizeObserver(resized).observe(canvas);
    // Browser zoom changes devicePixelRatio, which the observer does not always report.
    window.addEventListener('resize', resized);
    redraw.request = () => this.invalidate();
    this.invalidate();
  }

  /** Draw a frame at the next display refresh. */
  invalidate() {
    if (this.frameQueued) return;
    this.frameQueued = true;
    requestAnimationFrame(this.tick);
  }

  private tick = () => {
    this.frameQueued = false;
    if (this.animTimer) {
      clearTimeout(this.animTimer);
      this.animTimer = 0;
    }
    redraw.animating = false;
    this.frame();
    this.lastFrame = performance.now();
    // Something on screen moves on its own: draw again, but no faster than the animation rate.
    if (redraw.animating) {
      const wait = Math.max(0, ANIMATION_FRAME_MS - (performance.now() - this.lastFrame));
      this.animTimer = window.setTimeout(() => {
        this.animTimer = 0;
        this.invalidate();
      }, wait);
    }
  };

  /** Open a screen. Pass push=false when restoring a screen (no new history entry). */
  show(s: Screen, push = true) {
    s.host = this;
    // Re-showing a screen that is already open (e.g. to rebuild it) is not navigation.
    const same = s === this.screen;
    this.screen = s;
    this.relayout();
    this.invalidate();
    this.opts.onNavigate?.(s, push && !same);
  }

  back() {
    const p = this.screen?.parent;
    if (!p) return;
    p.host = this;
    this.screen = p;
    this.relayout();
    this.invalidate();
    p.resumed();
    this.opts.onNavigate?.(p, false);
  }

  /** Show a quest on the quest map, reusing the map screen in the parent chain if there is one. */
  navigateToQuestOnMap: (from: Screen, questId: string, lineId?: string) => void = () => {};

  /** Rebuild the current screen (after a setting that changes its contents). */
  refresh() {
    this.dirty = true;
    this.invalidate();
  }

  /** Report the current screen's route/title again (after it changed its own state). */
  notify(s: Screen) {
    if (s === this.screen) this.opts.onNavigate?.(s, false);
    this.invalidate();
  }

  setScale(v: number) {
    this.scaleSetting = v;
    this.dirty = true;
    this.invalidate();
  }

  maxScale() {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.floor(this.canvas.clientWidth * dpr), H = Math.floor(this.canvas.clientHeight * dpr);
    let s = 1;
    while (W / (s + 1) >= 320 && H / (s + 1) >= 240) s++;
    return s;
  }

  private relayout() {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const H = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
    // ScaledResolution: the largest scale that keeps at least 320x240 GUI pixels.
    const max = this.maxScale();
    this.scale = this.scaleSetting > 0 ? Math.min(this.scaleSetting, max) : max;
    this.w = Math.ceil(W / this.scale);
    this.h = Math.ceil(H / this.scale);
    this.gfx.g.imageSmoothingEnabled = false;
    this.lastSize = this.deviceSize();
    this.screen?.layout(this.w, this.h);
    this.dirty = false;
  }

  get guiWidth() {
    return this.w;
  }
  get guiHeight() {
    return this.h;
  }

  private toGui(e: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return [
      Math.floor(((e.clientX - r.left) * dpr) / this.scale),
      Math.floor(((e.clientY - r.top) * dpr) / this.scale),
    ];
  }

  private bind() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('mousemove', (e) => {
      [this.mx, this.my] = this.toGui(e);
      this.invalidate();
    });
    c.addEventListener('mouseleave', () => {
      this.mx = this.my = -1;
      this.invalidate();
    });
    c.addEventListener('mousedown', (e) => {
      e.preventDefault();
      [this.mx, this.my] = this.toGui(e);
      // Minecraft numbers buttons left=0, right=1, middle=2.
      const b = e.button === 2 ? 1 : e.button === 1 ? 2 : 0;
      mouseButtons[b] = true;
      this.screen?.mouseDown(this.mx, this.my, b);
      this.invalidate();
    });
    window.addEventListener('mouseup', (e) => {
      const b = e.button === 2 ? 1 : e.button === 1 ? 2 : 0;
      mouseButtons[b] = false;
      [this.mx, this.my] = this.toGui(e);
      this.screen?.mouseUp(this.mx, this.my, b);
      this.invalidate();
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        [this.mx, this.my] = this.toGui(e);
        const d = Math.sign(e.deltaY);
        if (d) this.screen?.scroll(this.mx, this.my, d);
        this.invalidate();
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      keys.shift = e.shiftKey;
      this.invalidate();
      if ((e.target as HTMLElement)?.closest?.('input,textarea,select')) return;
      if (this.screen?.key(e)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      keys.shift = e.shiftKey;
      this.invalidate();
    });
    window.addEventListener('blur', () => {
      mouseButtons.fill(false);
      keys.shift = false;
      this.invalidate();
    });

    // Touch: one finger behaves like the left mouse button.
    c.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length !== 1) return;
        e.preventDefault();
        [this.mx, this.my] = this.toGui(e.touches[0] as unknown as MouseEvent);
        mouseButtons[0] = true;
        this.screen?.mouseDown(this.mx, this.my, 0);
        this.invalidate();
      },
      { passive: false },
    );
    c.addEventListener(
      'touchmove',
      (e) => {
        if (e.touches.length !== 1) return;
        e.preventDefault();
        [this.mx, this.my] = this.toGui(e.touches[0] as unknown as MouseEvent);
        this.invalidate();
      },
      { passive: false },
    );
    c.addEventListener('touchend', () => {
      mouseButtons[0] = false;
      this.screen?.mouseUp(this.mx, this.my, 0);
      this.mx = this.my = -1;
      this.invalidate();
    });
  }

  private frame() {
    if (this.dirty || this.deviceSize() !== this.lastSize) this.relayout();
    const gfx = this.gfx;
    const g = gfx.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.imageSmoothingEnabled = false;
    gfx.now = performance.now();
    gfx.ox = gfx.oy = 0;
    gfx.s = this.scale;
    // drawDefaultBackground over a world: a dark translucent gradient. There is no world here,
    // so it sits on a plain dark backdrop.
    g.fillStyle = '#1b1b1f';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    gfx.gradient(0, 0, this.w, this.h, 0xc0101010, 0xd0101010);
    const s = this.screen;
    if (!s) return;
    s.draw(gfx, this.mx, this.my);
    const tt = this.mx >= 0 ? s.tooltip(this.mx, this.my) : null;
    if (tt && tt.length) drawHoveringText(gfx, tt, this.mx, this.my, this.w, this.h);
    this.canvas.style.cursor = 'default';
  }
}

export { FONT_HEIGHT };
