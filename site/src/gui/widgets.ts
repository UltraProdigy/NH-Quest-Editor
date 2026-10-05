// Ports of BetterQuesting's standard panels (api2.client.gui.*).

import {
  BasePanel, CanvasEmpty, type Gfx, type GuiRect, type Panel, type Tooltip, Rect, RectLerp, Transform, Align,
  contains, mouseButtons,
} from './core.ts';
import { type GuiColor, WHITE } from './color.ts';
import { animating } from './frame.ts';
import { type GuiTexture, type GuiLine, tex, col, ColorTexture, LayeredTexture } from './theme.ts';
import { drawString, stringWidth, FONT_HEIGHT } from './font.ts';
import { splitString, processTags, type LinkRange } from './text.ts';
import { drawItemFit, itemTooltip, currentVariant, drawFluid, fluidTooltip } from './items.ts';
import type { ItemRef, FluidRef } from '../lib/model.ts';

/** Text width correction from the BQ config (GTNH: 1.0). */
export const TEXT_WIDTH_CORRECTION = 1.0;

// ---------------------------------------------------------------- value drivers

/** A 0..1 value with optional smoothing (FloatSimpleIO / IValueIO<Float>). */
export interface ValueIO {
  read(): number;
  readRaw(): number;
  write(v: number): void;
  writeRaw(v: number): void;
}

export class FloatIO implements ValueIO {
  private v: number;
  private s: number;
  private t = performance.now();
  constructor(start = 0, private min = 0, private max = 1, private lerp = false, private speed = 0.02) {
    this.v = this.s = start;
  }
  private clamp(x: number) {
    return Math.min(this.max, Math.max(this.min, x));
  }
  read() {
    if (this.lerp && this.s !== this.v) {
      if (Math.abs(this.s - this.v) < 0.001) return (this.s = this.v);
      animating(true);
      const now = performance.now();
      const d = now - this.t;
      this.s = this.s + (this.v - this.s) * Math.min(1, Math.max(0, d * this.speed));
      if (d > 0) this.t = now;
      return this.s;
    }
    return this.v;
  }
  readRaw() {
    return this.v;
  }
  write(x: number) {
    if (this.s === this.v) this.t = performance.now();
    this.v = this.clamp(x);
  }
  writeRaw(x: number) {
    this.v = this.s = this.clamp(x);
  }
}

// ---------------------------------------------------------------- simple panels

/** Draws a texture into its rectangle (PanelGeneric). */
export class PanelGeneric extends BasePanel {
  constructor(t: GuiRect, public texture: GuiTexture | null, public color?: GuiColor) {
    super(t);
  }
  draw(gfx: Gfx) {
    const r = this.transform;
    this.texture?.draw(gfx, r.x(), r.y(), r.w(), r.h(), this.color);
  }
}

/** A canvas with a background texture (CanvasTextured). */
export class CanvasTextured extends CanvasEmpty {
  constructor(t: GuiRect, public bg: GuiTexture | null) {
    super(t);
  }
  draw(gfx: Gfx, mx: number, my: number) {
    const r = this.transform;
    this.bg?.draw(gfx, r.x(), r.y(), r.w(), r.h());
    super.draw(gfx, mx, my);
  }
}

/** A canvas whose size is the extent of its children (CanvasMinimum). */
export class CanvasMinimum extends CanvasEmpty {
  private fw = 0;
  private fh = 0;
  constructor(private inner: GuiRect) {
    super(inner);
    const self = this;
    this.transform = {
      get parent() { return inner.parent; },
      set parent(p) { inner.parent = p; },
      x: () => inner.x(),
      y: () => inner.y(),
      w: () => self.fw,
      h: () => self.fh,
      depth: () => inner.depth(),
    };
  }
  /** Width of the rectangle this canvas was created with. */
  get initialWidth() {
    return this.inner.w();
  }
  /** Subclasses (and the task panels) rebuild their children here; it may run more than once. */
  init() {
    this.children = [];
  }
  add<T extends Panel>(p: T): T {
    super.add(p);
    this.recalc();
    return p;
  }
  recalc() {
    let w = 0, h = 0;
    for (const c of this.children) {
      const t = c.transform;
      h = Math.max(h, t.y() + t.h());
      w = Math.max(w, t.x() + t.w());
    }
    this.fw = w;
    this.fh = h;
  }
}

// ---------------------------------------------------------------- buttons

export interface ButtonOptions {
  text?: string;
  icon?: GuiTexture | null;
  iconColor?: GuiColor | null;
  iconPadding?: number;
  tooltip?: string[] | null;
  onClick?: (b: PanelButton) => void;
  active?: boolean;
  align?: 0 | 1 | 2;
  textures?: [GuiTexture | null, GuiTexture | null, GuiTexture | null];
}

export class PanelButton extends BasePanel {
  text: string;
  icon: GuiTexture | null;
  iconColor: GuiColor | null;
  iconPad: number;
  tooltipLines: string[] | null;
  onClick?: (b: PanelButton) => void;
  active: boolean;
  align: 0 | 1 | 2;
  shadow = true;
  textures: [GuiTexture | null, GuiTexture | null, GuiTexture | null];
  colors: [GuiColor, GuiColor, GuiColor] = [col('btn_disabled'), col('btn_idle'), col('btn_hover')];
  private pending = false;

  constructor(t: GuiRect, o: ButtonOptions = {}) {
    super(t);
    this.text = o.text ?? '';
    this.icon = o.icon ?? null;
    this.iconColor = o.iconColor ?? null;
    this.iconPad = (o.iconPadding ?? 0) * 2;
    this.tooltipLines = o.tooltip ?? null;
    this.onClick = o.onClick;
    this.active = o.active ?? true;
    this.align = o.align ?? 1;
    this.textures = o.textures ?? [tex('btn_normal_0'), tex('btn_normal_1'), tex('btn_normal_2')];
  }

  setIcon(icon: GuiTexture | null, color: GuiColor | null = null, padding = 0) {
    this.icon = icon;
    this.iconColor = color;
    this.iconPad = padding * 2;
  }

  protected state(mx: number, my: number) {
    let s = !this.active ? 0 : contains(this.transform, mx, my) ? 2 : 1;
    if (s === 2 && this.pending && mouseButtons[0]) s = 0;
    return s;
  }

  draw(gfx: Gfx, mx: number, my: number) {
    const r = this.transform;
    const x = r.x(), y = r.y(), w = r.w(), h = r.h();
    const s = this.state(mx, my);
    this.textures[s]?.draw(gfx, x, y, w, h);
    if (this.icon) {
      const isz = Math.min(h - this.iconPad, w - this.iconPad);
      if (isz > 0) {
        this.icon.draw(
          gfx,
          x + Math.trunc(w / 2) - Math.trunc(isz / 2),
          y + Math.trunc(h / 2) - Math.trunc(isz / 2),
          isz,
          isz,
          this.iconColor ?? undefined,
        );
      }
    }
    if (this.text) {
      const ty = y + Math.trunc(h / 2) - 4;
      const color = this.colors[s].argb();
      if (this.align === 0) drawString(gfx, this.text, x + 4, ty, color, this.shadow);
      else if (this.align === 2) drawString(gfx, this.text, Math.floor(x + w - stringWidth(this.text) / 2 - 4), ty, color, this.shadow);
      else drawString(gfx, this.text, Math.floor(x + Math.floor(w / 2) - stringWidth(this.text) / 2), ty, color, this.shadow);
    }
  }

  mouseDown(mx: number, my: number, b: number) {
    const inside = contains(this.transform, mx, my);
    this.pending = this.active && b === 0 && inside;
    return (b === 0 || b === 1) && inside;
  }
  mouseUp(mx: number, my: number, b: number) {
    if (!this.pending) return false;
    this.pending = false;
    const clicked = this.active && b === 0 && contains(this.transform, mx, my);
    if (clicked) this.onClick?.(this);
    return clicked;
  }
  tooltip(mx: number, my: number): Tooltip {
    return contains(this.transform, mx, my) ? this.tooltipLines : null;
  }
}

/** Texture that draws an item stack (ItemTexture / OreDictTexture). */
export const itemTexture = (ref: ItemRef, showCount = false): GuiTexture => ({
  draw: (gfx, x, y, w, h) => drawItemFit(gfx, ref, x, y, w, h, showCount),
});

export const fluidTexture = (f: FluidRef): GuiTexture => ({
  draw: (gfx, x, y, w, h) => {
    const s = Math.min(w, h);
    drawFluid(gfx, f, x + (w - s) / 2, y + (h - s) / 2, s);
  },
});

/** An item in a slot frame with its tooltip (PanelItemSlot). */
export class PanelItemSlot extends PanelButton {
  constructor(t: GuiRect, public stack: ItemRef | null, opts: { showCount?: boolean; onClick?: (b: PanelButton) => void } = {}) {
    super(t, { onClick: opts.onClick });
    const frame = tex('item_frame');
    this.textures = [
      frame,
      frame,
      new LayeredTexture([frame, new ColorTexture(col('item_highlight'), [1, 1, 1, 1])]),
    ];
    if (stack) this.setIcon(itemTexture(stack, opts.showCount ?? false), null, 1);
  }
  tooltip(mx: number, my: number): Tooltip {
    if (!this.stack || !contains(this.transform, mx, my)) return null;
    return itemTooltip(currentVariant(this.stack));
  }
}

export class PanelFluidSlot extends PanelButton {
  constructor(t: GuiRect, public fluid: FluidRef) {
    super(t);
    const frame = tex('item_frame');
    this.textures = [
      frame,
      frame,
      new LayeredTexture([frame, new ColorTexture(col('item_highlight'), [1, 1, 1, 1])]),
    ];
    this.setIcon(fluidTexture(fluid), null, 1);
  }
  tooltip(mx: number, my: number): Tooltip {
    return contains(this.transform, mx, my) ? fluidTooltip(this.fluid) : null;
  }
}

// ---------------------------------------------------------------- text

/** Hooks the host provides for links inside quest text. */
export const textLinks = {
  questName: (_id: string): string | null => null,
  tooltip: (_link: LinkRange): string[] | null => null,
  open: (_link: LinkRange): void => {},
};

export class PanelTextBox extends BasePanel {
  private raw = '';
  text = '';
  color: GuiColor = WHITE;
  align: 0 | 1 | 2 = 0;
  shadow = false;
  fontScale = 12;
  private lines = 1;
  private autoH = 0;
  private links: LinkRange[] = [];
  private zones: { rect: GuiRect; link: LinkRange }[] = [];

  constructor(t: GuiRect, text: string, public autoFit = false, public hyperlinks = false) {
    super(t);
    const base = t;
    if (autoFit) {
      const self = this;
      this.transform = {
        get parent() { return base.parent; },
        set parent(p) { base.parent = p; },
        x: () => base.x(),
        y: () => base.y(),
        w: () => base.w(),
        h: () => self.autoH,
        depth: () => base.depth(),
      };
    }
    this.setText(text);
  }

  setColor(c: GuiColor) {
    this.color = c;
    return this;
  }
  setAlignment(a: 0 | 1 | 2) {
    this.align = a;
    return this;
  }

  setText(text: string) {
    this.raw = text;
    if (this.hyperlinks) {
      const p = processTags(text, (id) => textLinks.questName(id));
      this.text = p.text;
      this.links = p.links;
    } else {
      this.text = text;
      this.links = [];
    }
    this.layout();
    return this;
  }

  private wrapWidth() {
    const s = this.fontScale / 12;
    return Math.floor(this.transform.w() / s / TEXT_WIDTH_CORRECTION);
  }

  layout() {
    const s = this.fontScale / 12;
    if (this.autoFit) {
      const sl = splitString(this.text, this.wrapWidth(), false);
      this.lines = sl.length - 1;
      this.autoH = Math.floor(FONT_HEIGHT * sl.length * s);
      this.bake(sl);
    } else {
      this.lines = Math.floor(this.transform.h() / (FONT_HEIGHT * s)) - 1;
    }
  }

  init() {
    this.layout();
  }

  /** Link hot zones (PanelTextBox.bakeHotZones). */
  private bake(lines: string[]) {
    this.zones = [];
    if (!this.links.length) return;
    const box = this.transform;
    const zone = (x: number, row: number, w: number, link: LinkRange) => {
      const r = new Rect(x, FONT_HEIGHT * row, w, FONT_HEIGHT);
      r.parent = box;
      this.zones.push({ rect: r, link });
    };
    for (const l of this.links) {
      let pos = 0;
      let started = false;
      for (let i = 0; i < lines.length; pos += lines[i++].length) {
        const line = lines[i];
        if (!started) {
          if (l.start < pos + line.length) {
            const left = stringWidth(line.slice(0, l.start - pos));
            if (l.end <= pos + line.length) {
              zone(left, i, stringWidth(line.slice(0, l.end - pos)) - left, l);
              break;
            }
            started = true;
            zone(left, i, box.w(), l);
          }
        } else if (l.end <= pos + line.length) {
          zone(0, i, stringWidth(line.slice(0, l.end - pos)), l);
          break;
        } else zone(0, i, box.w(), l);
      }
    }
  }

  draw(gfx: Gfx) {
    const r = this.transform;
    const s = this.fontScale / 12;
    const bw = this.wrapWidth();
    if (bw <= 0) return;
    const w = Math.ceil(stringWidth(this.text) * s);
    gfx.push();
    gfx.translate(r.x(), r.y());
    gfx.scale(s);
    let x = 0;
    if (this.align === 2 && bw >= w) x = bw - w;
    else if (this.align === 1 && bw >= w) x = Math.trunc(bw / 2) - Math.trunc(w / 2);
    drawSplitString(gfx, this.text, x, 0, bw, this.color.argb(), this.shadow, 0, this.lines);
    gfx.pop();
  }

  mouseDown(mx: number, my: number, _b: number) {
    for (const z of this.zones) {
      if (contains(z.rect, mx, my)) {
        textLinks.open(z.link);
        return true;
      }
    }
    return false;
  }

  tooltip(mx: number, my: number): Tooltip {
    for (const z of this.zones) if (contains(z.rect, mx, my)) return textLinks.tooltip(z.link);
    return null;
  }

  get rawText() {
    return this.raw;
  }
}

/** RenderUtils.drawSplitString: wrapped lines start..end, FONT_HEIGHT apart. */
export function drawSplitString(
  gfx: Gfx, text: string, x: number, y: number, width: number, color: number, shadow: boolean, start: number, end: number,
) {
  if (!text || start > end) return;
  text = text.replace(/\r/g, '');
  const list = splitString(text, width, true);
  for (let i = start; i <= end; i++) {
    if (i < 0 || i >= list.length) continue;
    drawString(gfx, list[i], x, y + FONT_HEIGHT * (i - start), color, shadow);
  }
}

// ---------------------------------------------------------------- lines

export class PanelLine extends BasePanel {
  constructor(
    public start: GuiRect,
    public end: GuiRect,
    public line: GuiLine,
    public width: number,
    public color: GuiColor,
    order = 0,
    public predicate: ((mx: number, my: number) => boolean) | null = null,
    public animate: ((mx: number, my: number) => boolean) | null = null,
  ) {
    super(new Rect(0, 0, 0, 0, order));
    // Bounds for scroll extents and culling: the box spanning both ends.
    const self = this;
    this.transform = {
      parent: null,
      x: () => Math.min(self.start.x(), self.end.x()),
      y: () => Math.min(self.start.y(), self.end.y()),
      w: () => Math.max(self.start.x() + self.start.w(), self.end.x() + self.end.w()) - Math.min(self.start.x(), self.end.x()),
      h: () => Math.max(self.start.y() + self.start.h(), self.end.y() + self.end.h()) - Math.min(self.start.y(), self.end.y()),
      depth: () => order,
    };
  }
  draw(gfx: Gfx, mx: number, my: number) {
    if (this.predicate && !this.predicate(mx, my)) return;
    this.line.draw(gfx, this.start, this.end, this.width, this.color, !!this.animate?.(mx, my));
  }
}

// ---------------------------------------------------------------- scrolling

export class PanelVScrollBar extends BasePanel implements ValueIO {
  value = 0;
  speed = 1 / 15;
  handleSize = 16;
  inset = 0;
  active = true;
  private dragging = false;
  bg: GuiTexture | null = tex('scroll_v_bg');
  handle: [GuiTexture | null, GuiTexture | null, GuiTexture | null] = [tex('scroll_v_0'), tex('scroll_v_1'), tex('scroll_v_2')];

  draw(gfx: Gfx, mx: number, my: number) {
    const r = this.transform;
    if (this.active && this.dragging && (mouseButtons[0] || mouseButtons[2])) {
      this.write((my - (r.y() + this.handleSize / 2)) / (r.h() - this.handleSize));
    } else if (this.dragging) this.dragging = false;
    this.bg?.draw(gfx, r.x(), r.y(), r.w(), r.h());
    const sy = Math.floor((r.h() - this.handleSize - this.inset * 2) * this.value);
    const state = !this.active ? 0 : this.dragging || contains(r, mx, my) ? 2 : 1;
    this.handle[state]?.draw(gfx, r.x() + this.inset, r.y() + sy + this.inset, r.w() - this.inset * 2, this.handleSize);
  }
  mouseDown(mx: number, my: number, b: number) {
    if (!this.active || !contains(this.transform, mx, my)) return false;
    if (b === 0 || b === 2) {
      this.dragging = true;
      return true;
    }
    return false;
  }
  scroll(mx: number, my: number, d: number) {
    if (!this.active || d === 0 || !contains(this.transform, mx, my)) return false;
    const dy = d * this.speed;
    if ((dy < 0 && this.value <= 0) || (dy > 0 && this.value >= 1)) return false;
    this.write(dy + this.value);
    return true;
  }
  read() { return this.value; }
  readRaw() { return this.value; }
  write(v: number) { this.value = Math.min(1, Math.max(0, v)); }
  writeRaw(v: number) { this.value = v; }
}

/** Scrollable (and optionally zoomable) canvas (CanvasScrolling). Children use canvas coordinates. */
export class CanvasScrolling extends BasePanel {
  children: Panel[] = [];
  scrollBounds = new Rect(0, 0, 0, 0);
  window = new Rect(0, 0, 0, 0);
  extended = false;
  zoomMode = false;
  margin = 0;
  scrollX: ValueIO = new FloatIO(0, 0, 1, false, 0.02);
  scrollY: ValueIO = new FloatIO(0, 0, 1, false, 0.02);
  zoom: ValueIO = new FloatIO(1, 0.2, 2, true, 1 / 100);
  scrollSpeed = 12;
  zoomSpeed = 1.25;
  zoomToCursor = true;
  /** Set once the viewer drags or zooms; lets screens decide whether to keep or reset the view. */
  userMoved = false;
  protected dragging = false;
  protected dragged = false;
  private dragSX = 0;
  private dragSY = 0;
  private dragMX = 0;
  private dragMY = 0;
  lsz = 1;
  lsx = 0;
  lsy = 0;

  setupAdvanceScroll(zoom: boolean, extended: boolean, margin: number) {
    this.zoomMode = zoom;
    this.extended = extended;
    this.margin = margin;
    return this;
  }

  getScrollX() {
    return Math.round(this.scrollBounds.rx + this.scrollBounds.rw * this.scrollX.read());
  }
  getScrollY() {
    return Math.round(this.scrollBounds.ry + this.scrollBounds.rh * this.scrollY.read());
  }
  setScrollX(sx: number) {
    if (this.scrollBounds.rw <= 0) return;
    this.scrollX.writeRaw((sx - this.scrollBounds.rx) / this.scrollBounds.rw);
    this.updatePanelScroll();
  }
  setScrollY(sy: number) {
    if (this.scrollBounds.rh <= 0) return;
    this.scrollY.writeRaw((sy - this.scrollBounds.ry) / this.scrollBounds.rh);
    this.updatePanelScroll();
  }
  setZoom(z: number) {
    this.zoom.writeRaw(z);
    this.lsz = this.zoom.read();
    this.refreshScrollBounds();
  }

  add<T extends Panel>(p: T): T {
    this.children.push(p);
    if (this.children.some((c) => c.transform.depth() !== this.children[0].transform.depth())) {
      this.children = this.children
        .map((c, i) => [c, i] as const)
        .sort((a, b) => b[0].transform.depth() - a[0].transform.depth() || a[1] - b[1])
        .map((e) => e[0]);
    }
    p.init();
    this.refreshScrollBounds();
    return p;
  }
  /** Add many panels with one bounds refresh. */
  addAll(ps: Panel[]) {
    for (const p of ps) {
      this.children.push(p);
      p.init();
    }
    this.children = this.children
      .map((c, i) => [c, i] as const)
      .sort((a, b) => b[0].transform.depth() - a[0].transform.depth() || a[1] - b[1])
      .map((e) => e[0]);
    this.refreshScrollBounds();
  }
  reset() {
    this.children = [];
    this.refreshScrollBounds();
  }

  refreshScrollBounds() {
    let first = true, l = 0, r = 0, t = 0, b = 0;
    const zs = this.zoom.read();
    for (const p of this.children) {
      const tr = p.transform;
      const x = tr.x(), y = tr.y(), w = tr.w(), h = tr.h();
      if (first) {
        l = x; t = y; r = x + w; b = y + h;
        first = false;
      } else {
        l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x + w); b = Math.max(b, y + h);
      }
    }
    l -= this.margin; r += this.margin; t -= this.margin; b += this.margin;
    r -= Math.ceil(this.transform.w() / zs);
    b -= Math.ceil(this.transform.h() / zs);
    const sb = this.scrollBounds;
    if (this.extended) {
      sb.rx = Math.min(l, r);
      sb.ry = Math.min(t, b);
      sb.rw = Math.max(l, r) - sb.rx;
      sb.rh = Math.max(t, b) - sb.ry;
    } else {
      sb.rx = l;
      sb.ry = t;
      sb.rw = Math.max(0, r - l);
      sb.rh = Math.max(0, b - t);
    }
    this.updatePanelScroll();
  }

  updatePanelScroll() {
    this.lsx = this.getScrollX();
    this.lsy = this.getScrollY();
    const zs = this.zoom.read();
    this.window.rx = this.lsx;
    this.window.ry = this.lsy;
    this.window.rw = Math.ceil(this.transform.w() / zs);
    this.window.rh = Math.ceil(this.transform.h() / zs);
  }

  protected toLocal(mx: number, my: number): [number, number] {
    const zs = this.zoom.read();
    const t = this.transform;
    return [Math.trunc((mx - t.x()) / zs) + this.lsx, Math.trunc((my - t.y()) / zs) + this.lsy];
  }

  protected visible(): Panel[] {
    const w = this.window;
    const x0 = w.rx, y0 = w.ry, x1 = w.rx + w.rw, y1 = w.ry + w.rh;
    return this.children.filter((p) => {
      const t = p.transform;
      const x = t.x(), y = t.y();
      return x < x1 && x + t.w() >= x0 && y < y1 && y + t.h() >= y0;
    });
  }

  draw(gfx: Gfx, mx: number, my: number) {
    const zs = this.zoom.read();
    const t = this.transform;
    const vw = Math.ceil(t.w() / zs), vh = Math.ceil(t.h() / zs);
    const tx = t.x(), ty = t.y();
    if (this.dragging && (mouseButtons[0] || mouseButtons[2])) {
      const dx = Math.trunc((this.dragMX - mx) / zs);
      const dy = Math.trunc((this.dragMY - my) / zs);
      if (this.scrollBounds.rw > 0) {
        this.scrollX.write(dx / this.scrollBounds.rw + this.dragSX);
        if (!this.dragged && Math.abs(this.dragSX - this.scrollX.read()) > 0.05) this.dragged = this.userMoved = true;
      }
      if (this.scrollBounds.rh > 0) {
        this.scrollY.write(dy / this.scrollBounds.rh + this.dragSY);
        if (!this.dragged && Math.abs(this.dragSY - this.scrollY.read()) > 0.05) this.dragged = this.userMoved = true;
      }
    } else if (this.dragging || this.dragged) {
      this.dragging = false;
      this.dragged = false;
    }

    if (this.lsz !== zs) {
      const csx = this.getScrollX(), csy = this.getScrollY();
      if (!this.zoomToCursor) {
        const change = zs / this.lsz;
        let swcx = this.window.rw / 2, swcy = this.window.rh / 2;
        swcx -= swcx / change;
        swcy -= swcy / change;
        this.refreshScrollBounds();
        if (this.scrollBounds.rw > 0) this.scrollX.write((csx + swcx - this.scrollBounds.rx) / this.scrollBounds.rw);
        if (this.scrollBounds.rh > 0) this.scrollY.write((csy + swcy - this.scrollBounds.ry) / this.scrollBounds.rh);
      } else {
        const swcx = (mx - tx) / t.w(), swcy = (my - ty) / t.h();
        let dw = this.window.rw, dh = this.window.rh;
        this.refreshScrollBounds();
        dw -= this.window.rw;
        dh -= this.window.rh;
        if (this.scrollBounds.rw > 0) this.scrollX.write((csx + swcx * dw - this.scrollBounds.rx) / this.scrollBounds.rw);
        if (this.scrollBounds.rh > 0) this.scrollY.write((csy + swcy * dh - this.scrollBounds.ry) / this.scrollBounds.rh);
      }
      this.updatePanelScroll();
      this.lsz = zs;
    } else if (this.lsx !== this.getScrollX() || this.lsy !== this.getScrollY() || this.window.rw !== vw || this.window.rh !== vh) {
      this.updatePanelScroll();
    }

    gfx.clip(tx, ty, t.w(), t.h());
    gfx.push();
    gfx.translate(tx, ty);
    gfx.scale(zs);
    gfx.translate(-this.lsx, -this.lsy);
    let [smx, smy] = this.toLocal(mx, my);
    if (!contains(t, mx, my)) smx = smy = -1e9;
    this.drawChildren(gfx, smx, smy);
    gfx.pop();
    gfx.endClip();
  }

  protected drawChildren(gfx: Gfx, smx: number, smy: number) {
    for (const p of this.visible()) if (p.enabled) p.draw(gfx, smx, smy);
  }

  mouseDown(mx: number, my: number, b: number) {
    if (!contains(this.transform, mx, my)) return false;
    const [smx, smy] = this.toLocal(mx, my);
    for (let i = this.children.length - 1; i >= 0; i--) {
      const c = this.children[i];
      if (c.enabled && c.mouseDown(smx, smy, b)) return true;
    }
    if (b === 0 || b === 2) {
      this.dragSX = this.scrollX.read();
      this.dragSY = this.scrollY.read();
      this.dragMX = mx;
      this.dragMY = my;
      this.dragging = true;
      return true;
    }
    return false;
  }

  mouseUp(mx: number, my: number, b: number) {
    let used = false;
    if (!this.dragged) {
      if (!contains(this.transform, mx, my)) return false;
      const [smx, smy] = this.toLocal(mx, my);
      for (let i = this.children.length - 1; i >= 0; i--) {
        if (this.children[i].mouseUp(smx, smy, b)) {
          used = true;
          break;
        }
      }
    }
    if (this.dragging) {
      if (!mouseButtons[0] && !mouseButtons[2]) this.dragging = false;
      return true;
    }
    return used;
  }

  scroll(mx: number, my: number, d: number) {
    if (d === 0 || !contains(this.transform, mx, my)) return false;
    const [smx, smy] = this.toLocal(mx, my);
    for (let i = this.children.length - 1; i >= 0; i--) {
      const c = this.children[i];
      if (c.enabled && c.scroll(smx, smy, d)) return true;
    }
    if (this.zoomMode) {
      const cs = this.zoom.readRaw();
      this.userMoved = true;
      if (d > 0) this.zoom.write(cs / this.zoomSpeed);
      else if (d < 0) this.zoom.write(cs * this.zoomSpeed);
    } else if (this.scrollBounds.rh > 0) {
      const dy = (d * this.scrollSpeed) / this.scrollBounds.rh;
      const cs = this.scrollY.read();
      if (!((dy < 0 && cs <= 0) || (dy > 0 && cs >= 1))) {
        this.scrollY.write(cs + dy);
        this.updatePanelScroll();
      }
    }
    return false;
  }

  tooltip(mx: number, my: number): Tooltip {
    if (!contains(this.transform, mx, my) || this.dragging) return null;
    const [smx, smy] = this.toLocal(mx, my);
    const vis = this.visible();
    for (let i = vis.length - 1; i >= 0; i--) {
      const c = vis[i];
      if (!c.enabled) continue;
      const tt = c.tooltip(smx, smy);
      if (tt && tt.length) return tt;
    }
    return null;
  }
}

// ---------------------------------------------------------------- trays

/** A panel that animates between a closed and an open rectangle (CanvasHoverTray). */
export class CanvasHoverTray extends CanvasEmpty {
  lerp: RectLerp;
  open: CanvasEmpty;
  closed: CanvasEmpty;
  onOpen?: () => void;
  onClose?: () => void;
  manual = true;

  constructor(private rClosed: GuiRect, private rOpen: GuiRect, public bg: GuiTexture | null) {
    super(rClosed);
    this.lerp = new RectLerp(rClosed);
    this.transform = this.lerp;
    const inner = new Transform(Align.FULL_BOX, [0, 0, 0, 0]);
    this.open = new CanvasEmpty(inner);
    this.closed = new CanvasEmpty(inner);
    // Children of the tray canvases are positioned within the (animated) tray rectangle.
    inner.parent = this.lerp;
  }

  init() {
    // Called after the tray is added to a canvas: both tray rectangles take the tray's parent.
    this.rClosed.parent = this.lerp.parent;
    this.rOpen.parent = this.lerp.parent;
    this.children = [this.open, this.closed];
    this.open.transform.parent = this.lerp;
    this.open.enabled = false;
    this.closed.enabled = true;
  }

  get isOpen() {
    return this.open.enabled;
  }

  /** Width of the tray once fully open (the live width is still animating right after opening). */
  get openWidth() {
    return this.rOpen.w();
  }

  setTrayState(open: boolean, ms: number) {
    if (!open && this.isOpen) {
      this.rClosed.parent = this.lerp.parent;
      this.lerp.lerpTo(this.rClosed, ms);
      this.open.enabled = false;
      this.closed.enabled = true;
      this.onClose?.();
    } else if (open && !this.isOpen) {
      this.rOpen.parent = this.lerp.parent;
      this.lerp.lerpTo(this.rOpen, ms);
      this.open.enabled = true;
      this.closed.enabled = false;
      this.onOpen?.();
    }
  }

  draw(gfx: Gfx, mx: number, my: number) {
    const r = this.lerp;
    gfx.clip(r.x(), r.y(), r.w(), r.h());
    this.bg?.draw(gfx, r.x(), r.y(), r.w(), r.h());
    for (const c of this.children) if (c.enabled) c.draw(gfx, mx, my);
    gfx.endClip();
  }

  mouseDown(mx: number, my: number, b: number) {
    return super.mouseDown(mx, my, b) || (!!this.bg && contains(this.lerp, mx, my));
  }
  mouseUp(mx: number, my: number, b: number) {
    return super.mouseUp(mx, my, b) || (!!this.bg && contains(this.lerp, mx, my));
  }
  scroll(mx: number, my: number, d: number) {
    return super.scroll(mx, my, d) || (!!this.bg && contains(this.lerp, mx, my));
  }
}

