// PopColorInput: the text editor's colour picker (hex colour, or a two-colour gradient).

import { BasePanel, CanvasEmpty, Rect, Transform, Align, contains, mouseButtons, type Gfx, type GuiRect } from './core.ts';
import { tex, col, ColorTexture } from './theme.ts';
import { staticColor } from './color.ts';
import { PanelButton, PanelTextBox, PanelGeneric } from './widgets.ts';
import { PanelTextField } from './textfield.ts';
import { GrowingCanvas } from './popup.ts';

const SV_SIZE = 120, HUE_BAR_W = 12, SV_GRID = 20, PALETTE_COLS = 8, PALETTE_ROWS = 3, CELL = 12, GAP = 1, HISTORY_MAX = 40;
const PRESET_COLORS = [
  0xff0000, 0xff8000, 0xffff00, 0x80ff00, 0x00ff00, 0x00ff80, 0x00ffff, 0x0080ff, 0x0000ff, 0x8000ff, 0xff00ff, 0xff0080,
  0xffffff, 0xc0c0c0, 0x808080, 0x404040, 0x000000, 0x800000, 0x808000, 0x008000, 0x008080, 0x000080, 0x800080, 0xff6060,
];
const recentColors: number[] = [];

const f32 = Math.fround;

function hsvToRgb(h: number, s: number, v: number): number {
  const hi = Math.trunc(f32(h / 60)) % 6;
  const f = f32(h / 60) - hi;
  const p = f32(v * (1 - s)), q = f32(v * (1 - f * s)), t = f32(v * (1 - (1 - f) * s));
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][hi];
  return (Math.trunc(r * 255) << 16) | (Math.trunc(g * 255) << 8) | Math.trunc(b * 255);
}

function rgbToHsv(rgb: number): [number, number, number] {
  const r = ((rgb >> 16) & 255) / 255, g = ((rgb >> 8) & 255) / 255, b = (rgb & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (max !== min) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return [h, s, max];
}

function sanitizeHex(s: string): string {
  return s.replace(/[^0-9a-fA-F]/g, '').toUpperCase().padEnd(6, '0').slice(0, 6);
}
const parseRgb = (s: string) => parseInt(sanitizeHex(s), 16);
const hex6 = (rgb: number) => rgb.toString(16).toUpperCase().padStart(6, '0');

function addRecent(rgb: number) {
  const i = recentColors.indexOf(rgb);
  if (i >= 0) recentColors.splice(i, 1);
  recentColors.unshift(rgb);
  recentColors.length = Math.min(recentColors.length, HISTORY_MAX);
}

/** A panel that draws itself and reacts to clicks and drags through callbacks. */
class PanelCustom extends BasePanel {
  private dragging = false;
  constructor(
    t: GuiRect,
    private paint: (gfx: Gfx, x: number, y: number, w: number, h: number) => void,
    private press?: (mx: number, my: number, r: GuiRect) => boolean,
    private drags = false,
  ) {
    super(t);
  }
  draw(gfx: Gfx, mx: number, my: number) {
    const r = this.transform;
    if (this.dragging && mouseButtons[0]) this.press?.(mx, my, this.transform);
    else this.dragging = false;
    this.paint(gfx, r.x(), r.y(), r.w(), r.h());
  }
  mouseDown(mx: number, my: number, b: number) {
    if (b !== 0 || !contains(this.transform, mx, my) || !this.press) return false;
    const used = this.press(mx, my, this.transform);
    if (used && this.drags) this.dragging = true;
    return used;
  }
  mouseUp() {
    const was = this.dragging;
    this.dragging = false;
    return was;
  }
}

export class PopColorInput extends CanvasEmpty {
  private hue = 0;
  private sat = 1;
  private val = 1;
  private active = 0;
  private hex1!: PanelTextField;
  private hex2: PanelTextField | null = null;
  private last1 = '';
  private last2 = '';

  constructor(private title: string, private gradient: boolean, private callback: (formatting: string) => void, private close: () => void) {
    super(new Transform(Align.FULL_BOX, [0, 0, 0, 0]));
  }

  init() {
    this.children = [];
    this.add(new PanelGeneric(new Transform(Align.FULL_BOX, [0, 0, 0, 0], 1), new ColorTexture(staticColor(0x80000000))));
    const boxW = 300, boxH = this.gradient ? 230 : 200;
    const W = this.transform.w(), H = this.transform.h();
    const box = this.add(new GrowingCanvas(new Rect(Math.trunc(W / 2) - boxW / 2, Math.trunc(H / 2) - boxH / 2, boxW, boxH), tex('panel_main')));
    const at = (x: number, y: number, w: number, h: number) => new Rect(x, y, w, h);
    box.add(new PanelTextBox(at(8, 4, boxW - 16, 12), this.title).setAlignment(1).setColor(col('text_header')));
    let y = 18;
    const svX = 8, hueX = svX + SV_SIZE + 6;

    // Saturation (x) and value (y) for the current hue.
    box.add(
      new PanelCustom(
        at(svX, y, SV_SIZE, SV_SIZE),
        (gfx, x0, y0, w, h) => {
          const cw = w / SV_GRID, ch = h / SV_GRID;
          for (let r = 0; r < SV_GRID; r++) {
            for (let c = 0; c < SV_GRID; c++) {
              const rgb = hsvToRgb(this.hue, c / (SV_GRID - 1), 1 - r / (SV_GRID - 1));
              gfx.fill(x0 + c * cw, y0 + r * ch, cw + 0.5, ch + 0.5, (0xff000000 | rgb) >>> 0);
            }
          }
          const mx = x0 + this.sat * w, my = y0 + (1 - this.val) * h;
          for (const [s, argb] of [[5, 0xff000000], [3, 0xffffffff]] as const) {
            gfx.line(mx - s, my, mx + s, my, 1, argb);
            gfx.line(mx, my - s, mx, my + s, 1, argb);
          }
        },
        (mx, my, r) => {
          this.sat = Math.max(0, Math.min(1, (mx - r.x()) / r.w()));
          this.val = Math.max(0, Math.min(1, 1 - (my - r.y()) / r.h()));
          this.fromPicker();
          return true;
        },
        true,
      ),
    );
    box.add(
      new PanelCustom(
        at(hueX, y, HUE_BAR_W, SV_SIZE),
        (gfx, x0, y0, w, h) => {
          for (let r = 0; r < h; r++) gfx.fill(x0, y0 + r, w, 1, (0xff000000 | hsvToRgb((r / h) * 360, 1, 1)) >>> 0);
          const my = y0 + (this.hue / 360) * h;
          gfx.fill(x0 - 1, my - 2, w + 2, 4, 0xff000000);
          gfx.fill(x0, my - 1, w, 2, 0xffffffff);
        },
        (_mx, my, r) => {
          this.hue = Math.max(0, Math.min(359.9, ((my - r.y()) / r.h()) * 360));
          this.fromPicker();
          return true;
        },
        true,
      ),
    );

    const palX = hueX + HUE_BAR_W + 10;
    const cells = (list: () => number[], n: number, empty: boolean) =>
      new PanelCustom(
        at(palX, 0, 110, Math.ceil(n / PALETTE_COLS) * (CELL + GAP)),
        (gfx, x0, y0) => {
          const l = list();
          for (let i = 0; i < n; i++) {
            const cx = x0 + (i % PALETTE_COLS) * (CELL + GAP), cy = y0 + Math.trunc(i / PALETTE_COLS) * (CELL + GAP);
            if (i < l.length) gfx.fill(cx, cy, CELL, CELL, (0xff000000 | l[i]) >>> 0);
            else if (empty) {
              const c = 0xff404040;
              gfx.fill(cx, cy, CELL, 1, c);
              gfx.fill(cx, cy + CELL - 1, CELL, 1, c);
              gfx.fill(cx, cy, 1, CELL, c);
              gfx.fill(cx + CELL - 1, cy, 1, CELL, c);
            }
          }
        },
        (mx, my, r) => this.pick(list(), r, mx, my),
      );
    const palette = box.add(cells(() => PRESET_COLORS, PRESET_COLORS.length, false));
    (palette.transform as Rect).ry = y;
    let recentY = y + PALETTE_ROWS * (CELL + GAP) + 6;
    box.add(new PanelTextBox(at(palX, recentY, 60, 10), 'Recent').setColor(col('text_aux_0')));
    recentY += 11;
    const recent = box.add(cells(() => recentColors, HISTORY_MAX, true));
    (recent.transform as Rect).ry = recentY;

    y += SV_SIZE + 6;
    const fieldX = this.gradient ? 48 : 22;
    const preview = (x: number, yy: number, which: number) =>
      new PanelCustom(
        at(x, yy, 16, 16),
        (gfx, x0, y0, w, h) => {
          const f = which === 0 ? this.hex1 : this.hex2;
          gfx.fill(x0, y0, w, h, (0xff000000 | parseRgb(f?.text ?? '')) >>> 0);
          if (this.gradient && this.active === which) {
            gfx.fill(x0 - 1, y0 - 1, w + 2, 1, 0xffffffff);
            gfx.fill(x0 - 1, y0 + h, w + 2, 1, 0xffffffff);
            gfx.fill(x0 - 1, y0, 1, h, 0xffffffff);
            gfx.fill(x0 + w, y0, 1, h, 0xffffffff);
          }
        },
        () => {
          this.switchTo(which);
          return true;
        },
      );
    if (this.gradient) box.add(new PanelButton(at(8, y, 38, 16), { text: 'Start', onClick: () => this.switchTo(0) }));
    else box.add(new PanelTextBox(at(10, y + 3, 12, 12), '#').setColor(col('text_main')));
    this.hex1 = box.add(new PanelTextField(at(fieldX, y, 60, 16), 'FF0000'));
    this.last1 = 'FF0000';
    box.add(preview(fieldX + 64, y, 0));
    if (this.gradient) {
      y += 22;
      box.add(new PanelButton(at(8, y, 38, 16), { text: 'End', onClick: () => this.switchTo(1) }));
      this.hex2 = box.add(new PanelTextField(at(fieldX, y, 60, 16), '0000FF'));
      this.last2 = '0000FF';
      box.add(preview(fieldX + 64, y, 1));
    }
    for (const f of [this.hex1, this.hex2]) if (f) f.onChange = (s) => s.length > 6 && f.setText(s.slice(0, 6));
    y += 22;
    box.add(
      new PanelButton(at(boxW / 2 - 96, y, 88, 16), {
        text: 'OK',
        onClick: () => {
          const h1 = sanitizeHex(this.hex1.text);
          addRecent(parseInt(h1, 16));
          let out = `&#${h1}`;
          if (this.gradient && this.hex2) {
            const h2 = sanitizeHex(this.hex2.text);
            addRecent(parseInt(h2, 16));
            out = `&g&#${h1}&#${h2}`;
          }
          this.close();
          this.callback(out);
        },
      }),
    );
    box.add(new PanelButton(at(boxW / 2 + 8, y, 88, 16), { text: 'Cancel', onClick: () => this.close() }));
    [this.hue, this.sat, this.val] = rgbToHsv(0xff0000);
  }

  private pick(list: number[], r: GuiRect, mx: number, my: number) {
    const c = Math.trunc((mx - r.x()) / (CELL + GAP)), row = Math.trunc((my - r.y()) / (CELL + GAP));
    const i = row * PALETTE_COLS + c;
    if (c >= PALETTE_COLS || i >= list.length) return false;
    [this.hue, this.sat, this.val] = rgbToHsv(list[i]);
    this.fromPicker();
    return true;
  }

  private switchTo(i: number) {
    this.active = i;
    const f = i === 0 ? this.hex1 : this.hex2;
    if (f) [this.hue, this.sat, this.val] = rgbToHsv(parseRgb(f.text));
  }

  private fromPicker() {
    const h = hex6(hsvToRgb(this.hue, this.sat, this.val));
    if (this.active === 0) {
      this.hex1.setText(h);
      this.last1 = h;
    } else if (this.hex2) {
      this.hex2.setText(h);
      this.last2 = h;
    }
  }

  draw(gfx: Gfx, mx: number, my: number) {
    // Typing a full hex code moves the picker.
    if (this.hex1.text !== this.last1) {
      this.last1 = this.hex1.text;
      if (this.last1.length === 6 && this.active === 0) [this.hue, this.sat, this.val] = rgbToHsv(parseRgb(this.last1));
    }
    if (this.hex2 && this.hex2.text !== this.last2) {
      this.last2 = this.hex2.text;
      if (this.last2.length === 6 && this.active === 1) [this.hue, this.sat, this.val] = rgbToHsv(parseRgb(this.last2));
    }
    super.draw(gfx, mx, my);
  }

  // Everything goes to the popup while it is open.
  mouseDown(mx: number, my: number, b: number) {
    super.mouseDown(mx, my, b);
    return true;
  }
  mouseUp(mx: number, my: number, b: number) {
    super.mouseUp(mx, my, b);
    return true;
  }
  scroll(mx: number, my: number, d: number) {
    super.scroll(mx, my, d);
    return true;
  }
}
