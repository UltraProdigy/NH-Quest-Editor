// Screens (GuiScreenCanvas) and the host that runs them on a <canvas>: GUI scale, input,
// tooltips and redraw scheduling.

import {
  CanvasEmpty, Gfx, Rect, Transform, Align, mouseButtons, keys, pointer, softKeyboard, type Tooltip, type TipLine, type Panel,
  type TouchView,
} from './core.ts';
import { drawString, stringWidth, FONT_HEIGHT } from './font.ts';
import { splitString } from './text.ts';
import { redraw } from './frame.ts';

/** Frame interval while only animations change the picture (input still redraws at once). */
const ANIMATION_FRAME_MS = 1000 / 30;

/** Touch: how far (CSS pixels) a finger moves before a press becomes a drag. */
const TOUCH_SLOP = 10;
/** Touch: how long a finger rests before the press shows what the mouse would hover. */
const LONG_PRESS_MS = 450;
/** Touch: how far (CSS pixels) a tap may miss something with a tooltip and still reach it. */
const TAP_REACH = 8;

/**
 * Touch controls outside the canvas (the touch bar): `rightClick` makes the next tap a right click
 * (NEI's usages, the quest menu); `changed` is called when it changes.
 */
export const touchInput = {
  rightClick: false,
  changed: () => {},
};

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
  /** Touch: the view a finger at (mx, my) drags or pinches (see Panel.touchDrag). */
  touchDrag(mx: number, my: number, pinch = false): TouchView | null | undefined {
    if (this.popup?.enabled) return this.popup.touchDrag?.(mx, my, pinch) ?? null;
    return this.root.touchDrag(mx, my, pinch);
  }
  /** Called after the screen is shown again (returning from a child screen). */
  resumed() {}
  /** Draw what tooltip() returned. Screens that stand for another mod's GUI can draw it their way. */
  drawTooltip(gfx: Gfx, lines: (string | TipLine)[], mx: number, my: number) {
    drawHoveringText(gfx, lines, mx, my, this.width, this.height);
  }
}

// ---------------------------------------------------------------- tooltips

/**
 * Forge's GuiUtils.drawHoveringText as BQ uses it (RenderUtils.drawHoveringText). Lines may also be
 * drawn by code (TipLine), each as tall as it says, as NEI's tooltips allow.
 */
export function drawHoveringText(
  gfx: Gfx, lines: (string | TipLine)[], mx: number, my: number, sw: number, sh: number, maxW = -1,
) {
  if (!lines.length) return;
  const widthOf = (l: string | TipLine) => (typeof l === 'string' ? stringWidth(l) : l.width);
  let tw = 0;
  for (const l of lines) tw = Math.max(tw, widthOf(l));
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
    const out: (string | TipLine)[] = [];
    lines.forEach((l, i) => {
      const w = typeof l === 'string' ? splitString(l, tw, true) : [l];
      if (i === 0) titleLines = w.length;
      for (const x of w) {
        ww = Math.max(ww, widthOf(x));
        out.push(x);
      }
    });
    tw = ww;
    lines = out;
    tx = mx > sw / 2 ? mx - 16 - tw : mx + 12;
  }
  let ty = my - 12;
  let th = -2;
  for (const l of lines) th += typeof l === 'string' ? 10 : l.height;
  if (lines.length > titleLines) th += 2;
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
    if (typeof l === 'string') {
      drawString(gfx, l, tx, ty, 0xffffffff, true);
      ty += 10;
    } else {
      l.draw(gfx, tx, ty);
      ty += l.height;
    }
    if (i + 1 === titleLines) ty += 2;
  });
}

// ---------------------------------------------------------------- host

/** A text field of a screen being left lets go of the keyboard (and the phone's keyboard closes). */
function leaveTextField() {
  const a = document.activeElement as HTMLElement | null;
  if (a?.closest?.('input,textarea')) a.blur();
}

export interface HostOptions {
  /**
   * Called when the visible screen changes (for the URL and document title). push: a new screen
   * was opened; back: the screen was closed back to its parent.
   */
  onNavigate?: (s: Screen, push: boolean, back: boolean) => void;
}

export class Host {
  canvas: HTMLCanvasElement;
  gfx: Gfx;
  screen: Screen | null = null;
  /** 0 = auto (half of Minecraft's auto scale), otherwise a fixed GUI scale. */
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
  /** Whether tooltips show: always with a mouse; with touch only after a long press. */
  private tips = true;
  /** CSS pixels the canvas is moved up to keep a text field above the on-screen keyboard. */
  private kbShift = 0;

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
    redraw.animating = redraw.smooth = false;
    this.frame();
    this.lastFrame = performance.now();
    // Motion the viewer drives (zooming, trays) gets the next display frame.
    if (redraw.smooth) this.invalidate();
    // Something on screen moves on its own: draw again, but no faster than the animation rate.
    else if (redraw.animating) {
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
    if (!same) leaveTextField();
    this.screen = s;
    this.relayout();
    this.invalidate();
    this.opts.onNavigate?.(s, push && !same, false);
  }

  back() {
    const p = this.screen?.parent;
    if (!p) return;
    leaveTextField();
    p.host = this;
    this.screen = p;
    this.relayout();
    this.invalidate();
    p.resumed();
    this.opts.onNavigate?.(p, false, true);
  }

  /** Show a quest on the quest map, reusing the map screen in the parent chain if there is one. */
  navigateToQuestOnMap: (from: Screen, questId: string, lineId?: string) => void = () => {};
  /** Show a quest line on the quest map. */
  navigateToLine: (from: Screen, lineId: string) => void = () => {};

  /** Rebuild the current screen (after a setting that changes its contents). */
  refresh() {
    this.dirty = true;
    this.invalidate();
  }

  /** Report the current screen's route/title again (after it changed its own state). */
  notify(s: Screen) {
    if (s === this.screen) this.opts.onNavigate?.(s, false, false);
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

  /**
   * The automatic GUI scale. Minecraft's own rule (the largest scale that keeps 320x240 GUI
   * pixels) is huge on big monitors, and players usually pick about half of it (3 at 1440p), so
   * auto uses half. On high-density screens (phones) it keeps at least 1.5 device pixels per CSS
   * pixel so text stays readable.
   */
  autoScale() {
    const dpr = window.devicePixelRatio || 1;
    const max = this.maxScale();
    return Math.max(1, Math.min(max, Math.max(Math.round(max / 2), Math.ceil(1.5 * dpr))));
  }

  private relayout() {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const H = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
    // ScaledResolution never goes past the largest scale that keeps at least 320x240 GUI pixels.
    this.scale = this.scaleSetting > 0 ? Math.min(this.scaleSetting, this.maxScale()) : this.autoScale();
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

  private toGui(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return [
      Math.floor(((e.clientX - r.left) * dpr) / this.scale),
      Math.floor(((e.clientY - r.top) * dpr) / this.scale),
    ];
  }

  /** Back to the mouse after touch: tooltips follow the pointer again. */
  private usingMouse() {
    if (!pointer.touch) return;
    pointer.touch = false;
    this.tips = true;
  }

  private bind() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('mousemove', (e) => {
      this.usingMouse();
      [this.mx, this.my] = this.toGui(e);
      this.invalidate();
    });
    c.addEventListener('mouseleave', () => {
      this.mx = this.my = -1;
      this.invalidate();
    });
    c.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.usingMouse();
      [this.mx, this.my] = this.toGui(e);
      keys.shift = e.shiftKey;
      keys.alt = e.altKey;
      keys.ctrl = e.ctrlKey || e.metaKey;
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
        keys.shift = e.shiftKey;
        keys.alt = e.altKey;
        keys.ctrl = e.ctrlKey || e.metaKey;
        const d = Math.sign(e.deltaY);
        if (d) this.screen?.scroll(this.mx, this.my, d);
        this.invalidate();
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      keys.shift = e.shiftKey;
      keys.alt = e.altKey;
      keys.ctrl = e.ctrlKey || e.metaKey;
      // Alt shows NEI's hotkey list; keep it from opening the browser's menu bar.
      if (e.key === 'Alt') e.preventDefault();
      this.invalidate();
      if ((e.target as HTMLElement)?.closest?.('input,textarea,select')) return;
      if (this.screen?.key(e)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      keys.shift = e.shiftKey;
      keys.alt = e.altKey;
      keys.ctrl = e.ctrlKey || e.metaKey;
      if (e.key === 'Alt') e.preventDefault();
      this.invalidate();
    });
    window.addEventListener('blur', () => {
      mouseButtons.fill(false);
      keys.shift = keys.alt = keys.ctrl = false;
      this.invalidate();
    });

    this.bindTouch();
    this.bindKeyboardFit();
  }

  // ---------------------------------------------------------------- touch

  /**
   * Touch. A tap clicks where the finger lifted (so a text field that takes the tap can bring up
   * the on-screen keyboard). A finger that moves drags the view under it, a scrolling list or the
   * quest map, even when it started on a button; where there is no view it drags as the mouse
   * would (scroll bars, the designer's tools). A finger that rests shows what the mouse would
   * hover (the tooltip, which stays up after the finger lifts until the next touch); moving it
   * then moves the tooltip along. Two fingers pinch the view between them, zooming about that
   * point and following it as they move.
   */
  private bindTouch() {
    const c = this.canvas;
    type Mode = 'idle' | 'press' | 'pan' | 'drag' | 'hover' | 'pinch';
    let mode: Mode = 'idle';
    let sx = 0, sy = 0, scx = 0, scy = 0;
    let timer = 0;
    let view: TouchView | null = null;
    let lastView: TouchView | null = null;
    /** Recent finger positions (GUI pixels, ms) for the speed of a flick. */
    let trail: [number, number, number][] = [];
    let pinch: { view: TouchView | null; d0: number; z0: number; px: number; py: number; steps: number } | null = null;

    const mid = (e: TouchEvent): [number, number, number] => {
      const a = e.touches[0], b = e.touches[1];
      const [x, y] = this.toGui({ clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 });
      return [x, y, Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY))];
    };
    const cancelTimer = () => {
      if (timer) clearTimeout(timer);
      timer = 0;
    };
    /** Stop whatever one finger was doing, without a click. */
    const abandon = () => {
      cancelTimer();
      if (mode === 'pan') view?.endDrag(0, 0);
      if (mode === 'drag') this.screen?.mouseUp(-1e6, -1e6, 0);
      mouseButtons[0] = false;
      view = null;
    };

    c.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault();
        pointer.touch = true;
        if (e.touches.length === 1) {
          cancelTimer();
          lastView?.stopFling();
          lastView = null;
          const t = e.touches[0];
          scx = t.clientX;
          scy = t.clientY;
          [sx, sy] = this.toGui(t);
          // Shows a button as pressed, but no tooltip until the finger rests.
          [this.mx, this.my] = [sx, sy];
          this.tips = false;
          mode = 'press';
          trail = [[sx, sy, e.timeStamp]];
          timer = window.setTimeout(() => {
            timer = 0;
            if (mode !== 'press') return;
            mode = 'hover';
            this.tips = true;
            navigator.vibrate?.(8);
            this.invalidate();
          }, LONG_PRESS_MS);
        } else if (e.touches.length === 2 && mode !== 'pinch') {
          abandon();
          const [x, y, d] = mid(e);
          const v = this.screen?.touchDrag(x, y, true) ?? null;
          const zoom = v?.zoomable ? v : null;
          const [px, py] = zoom ? zoom.pointAt(x, y) : [0, 0];
          pinch = { view: zoom, d0: d, z0: zoom?.zoomLevel() ?? 1, px, py, steps: d };
          mode = 'pinch';
          this.tips = false;
          [this.mx, this.my] = [x, y];
        }
        this.invalidate();
      },
      { passive: false },
    );

    c.addEventListener(
      'touchmove',
      (e) => {
        e.preventDefault();
        if (mode === 'pinch') {
          if (e.touches.length < 2 || !pinch) return;
          const [x, y, d] = mid(e);
          [this.mx, this.my] = [x, y];
          if (pinch.view) pinch.view.pinchTo(pinch.z0 * (d / pinch.d0), pinch.px, pinch.py, x, y);
          else {
            // Nothing to zoom here: each 1.25x change in the fingers' distance is a wheel step.
            while (d >= pinch.steps * 1.25) {
              this.screen?.scroll(x, y, -1);
              pinch.steps *= 1.25;
            }
            while (d <= pinch.steps / 1.25) {
              this.screen?.scroll(x, y, 1);
              pinch.steps /= 1.25;
            }
          }
          this.invalidate();
          return;
        }
        if (e.touches.length !== 1 || mode === 'idle') return;
        const t = e.touches[0];
        if (mode === 'press') {
          if (Math.hypot(t.clientX - scx, t.clientY - scy) < TOUCH_SLOP) return;
          cancelTimer();
          const v = this.screen?.touchDrag(sx, sy) ?? null;
          mouseButtons[0] = true;
          if (v) {
            mode = 'pan';
            view = v;
            v.beginDrag(sx, sy);
          } else {
            mode = 'drag';
            this.screen?.mouseDown(sx, sy, 0);
          }
        }
        [this.mx, this.my] = this.toGui(t);
        if (mode === 'pan') view?.dragTo?.(this.mx, this.my);
        trail.push([this.mx, this.my, e.timeStamp]);
        if (trail.length > 8) trail.shift();
        this.invalidate();
      },
      { passive: false },
    );

    const touchEnd = (e: TouchEvent) => {
      if (e.touches.length > 0) {
        // A pinch lasts until every finger is up, so the last one does not start a drag.
        if (mode !== 'pinch') {
          abandon();
          mode = 'idle';
        }
        return;
      }
      cancelTimer();
      const was = mode;
      mode = 'idle';
      if (was === 'press' && e.type === 'touchend') this.tap(sx, sy);
      else if (was === 'pan' && view) {
        // The flick's speed over the last ~100 ms of the finger's path.
        const now = trail[trail.length - 1];
        let first = now;
        for (const p of trail) if (now[2] - p[2] <= 100) {
          first = p;
          break;
        }
        const dt = now[2] - first[2];
        const still = e.timeStamp - now[2] > 60;
        mouseButtons[0] = false;
        view.endDrag(dt > 0 && !still ? (now[0] - first[0]) / dt : 0, dt > 0 && !still ? (now[1] - first[1]) / dt : 0);
        lastView = view;
      } else if (was === 'drag') {
        mouseButtons[0] = false;
        this.screen?.mouseUp(this.mx, this.my, 0);
      } else if (was === 'hover') {
        // The tooltip stays where the finger was until the next touch.
        this.invalidate();
        return;
      }
      mouseButtons[0] = false;
      view = null;
      pinch = null;
      this.mx = this.my = -1;
      this.invalidate();
    };
    c.addEventListener('touchend', touchEnd);
    c.addEventListener('touchcancel', touchEnd);
    // Safari's own pinch and double-tap zoom of the page.
    document.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  /** A tap: a click (a right click when the touch bar asked for one) where the finger was. */
  private tap(x: number, y: number) {
    const s = this.screen;
    if (!s) return;
    const b = touchInput.rightClick ? 1 : 0;
    if (touchInput.rightClick) {
      touchInput.rightClick = false;
      touchInput.changed();
    }
    [x, y] = this.reach(s, x, y);
    this.mx = x;
    this.my = y;
    mouseButtons[b] = true;
    s.mouseDown(x, y, b);
    mouseButtons[b] = false;
    // A click that opened another screen is done; the new screen did not see it start.
    if (this.screen === s) s.mouseUp(x, y, b);
  }

  /**
   * Fingers are wider than the things they tap (16-pixel items and icons): a tap that lands on
   * nothing with a tooltip goes to the nearest thing that has one within a few pixels.
   */
  private reach(s: Screen, x: number, y: number): [number, number] {
    const hit = (px: number, py: number) => !!s.tooltip(px, py)?.length;
    if (hit(x, y)) return [x, y];
    const r = Math.max(2, Math.round((TAP_REACH * (window.devicePixelRatio || 1)) / this.scale));
    for (let d = 2; d <= r; d += 2) {
      for (let a = 0; a < 8; a++) {
        const px = x + Math.round(Math.cos((a * Math.PI) / 4) * d), py = y + Math.round(Math.sin((a * Math.PI) / 4) * d);
        if (hit(px, py)) return [px, py];
      }
    }
    return [x, y];
  }

  // ---------------------------------------------------------------- on-screen keyboard

  /** Keep the focused text field above the on-screen keyboard (see softKeyboard). */
  private bindKeyboardFit() {
    const vv = window.visualViewport;
    vv?.addEventListener('resize', () => this.invalidate());
    vv?.addEventListener('scroll', () => this.invalidate());
    document.addEventListener('focusout', () => {
      // Safari may have scrolled the page to the hidden input; put it back once typing is done.
      setTimeout(() => {
        if (!document.activeElement?.closest?.('input,textarea')) window.scrollTo(0, 0);
        this.invalidate();
      }, 50);
    });
  }

  private fitKeyboard() {
    const vv = window.visualViewport;
    const f = softKeyboard.field?.() ?? null;
    let shift = 0;
    if (vv && f && pointer.touch && document.activeElement?.closest?.('input,textarea')) {
      const k = this.scale / (window.devicePixelRatio || 1);
      const top = this.canvas.getBoundingClientRect().top + this.kbShift;
      const y0 = top + f[1] * k, y1 = top + (f[1] + f[3]) * k;
      const visTop = vv.offsetTop, visBottom = vv.offsetTop + vv.height;
      const margin = 8;
      if (y1 + margin > visBottom) shift = y1 + margin - visBottom;
      if (y0 - shift < visTop) shift = y0 - visTop;
      shift = Math.max(0, Math.round(shift));
    }
    if (shift !== this.kbShift) {
      this.kbShift = shift;
      this.canvas.style.transform = shift ? `translateY(${-shift}px)` : '';
    }
  }

  private frame() {
    redraw.frame++;
    if (this.dirty || this.deviceSize() !== this.lastSize) this.relayout();
    const gfx = this.gfx;
    const g = gfx.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.imageSmoothingEnabled = false;
    gfx.now = performance.now();
    gfx.ox = gfx.oy = 0;
    gfx.s = gfx.base = this.scale;
    // drawDefaultBackground over a world: a dark translucent gradient. There is no world here,
    // so it sits on a plain dark backdrop.
    g.fillStyle = '#1b1b1f';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    gfx.gradient(0, 0, this.w, this.h, 0xc0101010, 0xd0101010);
    const s = this.screen;
    if (!s) return;
    s.draw(gfx, this.mx, this.my);
    const tt = this.mx >= 0 && this.tips ? s.tooltip(this.mx, this.my) : null;
    if (tt && tt.length) s.drawTooltip(gfx, tt, this.mx, this.my);
    this.canvas.style.cursor = 'default';
    this.fitKeyboard();
  }
}

export { FONT_HEIGHT };
