// Text fields (PanelTextField): single line, or wrapped over several lines for the text editor.
// Typing goes through a hidden <input> (or <textarea>) so that browser text entry (IME, mobile
// keyboards, paste, selection keys) works; the field draws its value, selection and cursor itself.

import { BasePanel, contains, mouseButtons, type Gfx, type GuiRect } from './core.ts';
import { animating, invalidate } from './frame.ts';
import { tex, col } from './theme.ts';
import { drawString, stringWidth, FONT_HEIGHT } from './font.ts';
import { splitString, getFormatFromString } from './text.ts';
import { javaFloat, javaDouble } from '../lib/bqwrite.ts';

/** FieldFilterString / FieldFilterNumber: what a field accepts and how its value is read. */
export type FieldFilter = 'string' | 'byte' | 'short' | 'int' | 'long' | 'float' | 'double';

const INT_RANGE: Partial<Record<FieldFilter, [number, number]>> = {
  byte: [-128, 127],
  short: [-32768, 32767],
  int: [-2147483648, 2147483647],
};

/** FieldFilterNumber.filterText: digits and "-" (and "." for floating point) only. */
export function filterText(filter: FieldFilter, s: string): string {
  if (filter === 'string') return s;
  return s.replace(filter === 'float' || filter === 'double' ? /[^.0123456789-]/g : /[^0123456789-]/g, '');
}

/** FieldFilterNumber.parseValue: Java's parse, or 0 when it would throw. */
export function parseValue(filter: FieldFilter, s: string): number | bigint | string {
  if (filter === 'string') return s;
  if (filter === 'long') {
    if (!/^-?\d+$/.test(s)) return 0n;
    const v = BigInt(s);
    return v >= -(2n ** 63n) && v < 2n ** 63n ? v : 0n;
  }
  if (filter === 'float' || filter === 'double') {
    const v = /^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
    return Number.isFinite(v) ? (filter === 'float' ? Math.fround(v) : v) : 0;
  }
  if (!/^-?\d+$/.test(s)) return 0;
  const v = Number(s);
  const [lo, hi] = INT_RANGE[filter]!;
  return v >= lo && v <= hi ? v : 0;
}

/** The value's text as Java prints it (what a number field shows once it loses focus). */
export function valueText(filter: FieldFilter, v: number | bigint | string): string {
  if (filter === 'float') return javaFloat(Number(v));
  if (filter === 'double') return javaDouble(Number(v));
  return String(v);
}

/** Text as drawn, and where each source index lands in it (PanelTextField.TextDisplayText). */
export interface DisplayText {
  text: string;
  /** Display index of each source index, length + 1 entries. */
  map: number[];
}

export const identityDisplay = (s: string): DisplayText => ({ text: s, map: Array.from({ length: s.length + 1 }, (_, i) => i) });

function sourceIndex(d: DisplayText, displayIndex: number): number {
  const m = d.map;
  let low = 0, high = m.length - 1;
  const c = Math.min(Math.max(displayIndex, m[0]), m[high]);
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (m[mid] < c) low = mid + 1;
    else if (m[mid] > c) high = mid - 1;
    else return mid;
  }
  return Math.max(0, high);
}
const displayIndex = (d: DisplayText, i: number) => d.map[Math.min(Math.max(i, 0), d.map.length - 1)];

/** RenderUtils.getCursorPos: the index under x in one line. */
function cursorPos(text: string, x: number): number {
  if (!text.length) return 0;
  let i = 0;
  for (; i < text.length; i++) if (stringWidth(text.slice(0, i + 1)) > x) break;
  if (i - 1 >= 0 && text[i - 1] === '\n') return i - 1;
  return i;
}

// ---------------------------------------------------------------- the hidden input

let input: HTMLInputElement | null = null;
let area: HTMLTextAreaElement | null = null;
let owner: PanelTextField | null = null;

type Field = HTMLInputElement | HTMLTextAreaElement;

function setup(el: Field) {
  el.autocomplete = 'off';
  el.spellcheck = false;
  el.setAttribute('aria-label', 'Text');
  Object.assign(el.style, {
    position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0', border: '0', padding: '0',
    resize: 'none', overflow: 'hidden',
  });
  el.addEventListener('input', () => {
    owner?.fromInput();
    invalidate();
  });
  el.addEventListener('keydown', (e) => {
    const ev = e as KeyboardEvent;
    if (ev.key === 'Enter' && el === input && owner?.onEnter) {
      ev.preventDefault();
      owner.onEnter();
    }
    if ((ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && el === area && owner) {
      ev.preventDefault();
      owner.moveLine(ev.key === 'ArrowUp' ? -1 : 1, ev.shiftKey);
    }
    // Ctrl + Z / Y stay with the browser's own undo inside the field.
    if (ev.key === 'Escape') el.blur();
    ev.stopPropagation();
    if (ev.key === 'Escape') {
      // Let the screen handle Escape (go back) after leaving the field.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    }
    invalidate();
  });
  el.addEventListener('keyup', () => invalidate());
  el.addEventListener('select', () => invalidate());
  el.addEventListener('blur', () => {
    if (owner && !owner.lockFocus) owner.blurred();
  });
  document.body.appendChild(el);
}

function element(wrap: boolean): Field {
  if (wrap) {
    if (!area) setup((area = document.createElement('textarea')));
    return area;
  }
  if (!input) {
    input = document.createElement('input');
    input.type = 'text';
    setup(input);
  }
  return input;
}

// ---------------------------------------------------------------- the field

export class PanelTextField extends BasePanel {
  text = '';
  watermark = '';
  focused = false;
  lockFocus = false;
  /** Called on every change with the text (after filtering). */
  onChange?: (s: string) => void;
  /** Called on Enter (single line only). */
  onEnter?: () => void;
  /** Called when the field loses focus. */
  onBlur?: () => void;
  /** Draw the text as stars (a password or token). */
  mask = false;
  filter: FieldFilter = 'string';
  /** Wrapped over several lines (the text editor). */
  wrap = false;
  /** Draw the box behind the text. */
  background = true;
  displayFormatter: (s: string) => DisplayText = identityDisplay;
  /** Moves with the vertical scroll position in wrapped mode (0..1). */
  scrollDriver: { value: number; write(v: number): void; read(): number } | null = null;
  active = true;
  /** Cursor and selection anchor (source indexes). */
  private caret = 0;
  private anchor = 0;
  private scrollX = 0;
  private scrollY = 0;
  private dragging = false;
  /** Preferred x for up / down in wrapped mode. */
  private prefX = -1;
  private display: DisplayText = identityDisplay('');
  private shownFor: string | null = null;

  constructor(t: GuiRect, text = '') {
    super(t);
    this.text = text;
  }

  // ---------------------------------------------------------------- state

  private el(): Field | null {
    return owner === this ? element(this.wrap) : null;
  }

  private syncFromElement() {
    const el = this.el();
    if (!el) return;
    const s = el.selectionStart ?? 0, e = el.selectionEnd ?? s;
    if (el.selectionDirection === 'backward') {
      this.caret = s;
      this.anchor = e;
    } else {
      this.caret = e;
      this.anchor = s;
    }
  }

  private syncToElement() {
    const el = this.el();
    if (!el) return;
    if (el.value !== this.text) el.value = this.text;
    const a = Math.min(this.caret, this.anchor), b = Math.max(this.caret, this.anchor);
    el.setSelectionRange(a, b, this.caret < this.anchor ? 'backward' : 'forward');
  }

  private shown(): DisplayText {
    const t = this.mask ? '*'.repeat(this.text.length) : this.text;
    if (this.shownFor !== t) {
      this.display = this.mask ? identityDisplay(t) : this.displayFormatter(t);
      this.shownFor = t;
    }
    return this.display;
  }

  focus() {
    const el = element(this.wrap);
    if (owner && owner !== this) owner.focused = false;
    owner = this;
    this.focused = true;
    el.value = this.text;
    el.focus({ preventScroll: true });
    this.syncToElement();
  }

  blurred() {
    if (!this.focused) return;
    this.focused = false;
    // A number field shows its value as Java prints it once it loses focus.
    if (this.filter !== 'string' && this.text) {
      const t = valueText(this.filter, parseValue(this.filter, this.text));
      if (t !== this.text) this.text = t;
    }
    this.onBlur?.();
  }

  unfocus() {
    if (owner === this) element(this.wrap).blur();
    this.blurred();
  }

  fromInput() {
    const el = this.el();
    if (!el) return;
    let v = el.value;
    const f = filterText(this.filter, v);
    if (f !== v) {
      const pos = (el.selectionStart ?? v.length) - (v.length - f.length);
      el.value = v = f;
      el.setSelectionRange(Math.max(0, pos), Math.max(0, pos));
    }
    this.text = v;
    this.syncFromElement();
    this.prefX = -1;
    this.revealCaret();
    this.onChange?.(this.text);
  }

  setText(s: string) {
    this.text = s;
    this.caret = Math.min(this.caret, s.length);
    this.anchor = Math.min(this.anchor, s.length);
    if (owner === this) {
      const el = element(this.wrap);
      el.value = s;
      this.syncToElement();
    }
  }

  /** The parsed value (a number field's number). */
  value() {
    return parseValue(this.filter, this.text);
  }

  get selectionStart() {
    return Math.min(this.caret, this.anchor);
  }
  get selectionEnd() {
    return Math.max(this.caret, this.anchor);
  }
  selectedText() {
    this.syncFromElement();
    return this.text.slice(this.selectionStart, this.selectionEnd);
  }

  /** Replace the selection with text and put the cursor after it (PanelTextField.writeText). */
  writeText(s: string) {
    this.syncFromElement();
    const a = this.selectionStart, b = this.selectionEnd;
    const t = filterText(this.filter, this.text.slice(0, a) + s + this.text.slice(b));
    this.text = t;
    this.caret = this.anchor = Math.min(t.length, a + s.length);
    if (owner === this) element(this.wrap).value = t;
    this.syncToElement();
    this.revealCaret();
    this.onChange?.(this.text);
  }

  /** Select from a to b (the cursor ends at b). */
  setSelection(a: number, b: number) {
    this.anchor = Math.min(this.text.length, Math.max(0, a));
    this.caret = Math.min(this.text.length, Math.max(0, b));
    this.syncToElement();
    this.revealCaret();
  }

  moveCursorBy(n: number) {
    this.caret = this.anchor = Math.min(this.text.length, Math.max(0, this.caret + n));
    this.syncToElement();
    this.revealCaret();
  }

  private setCaret(i: number, extend: boolean) {
    this.caret = Math.min(this.text.length, Math.max(0, i));
    if (!extend) this.anchor = this.caret;
    this.syncToElement();
    this.revealCaret();
  }

  // ---------------------------------------------------------------- layout

  private innerW() {
    return this.transform.w() - 8;
  }
  private innerH() {
    return this.transform.h() - 8;
  }

  /** Lines as typed (splitStringWithoutFormat): their lengths add up to the display text's. */
  private visualLines(): string[] {
    const d = this.shown();
    return d.text ? splitString(d.text, this.innerW(), false) : [''];
  }

  /** Where the cursor is drawn, relative to the text origin. */
  private caretXY(): [number, number] {
    const d = this.shown();
    const di = displayIndex(d, this.caret);
    if (!this.wrap) return [stringWidth(d.text.slice(0, di)), 0];
    const lines = this.visualLines();
    let idx = 0, fmt = '';
    for (let y = 0; y < lines.length; y++) {
      const s = lines[y];
      if (di >= idx && di < idx + s.length + (y === lines.length - 1 ? 1 : 0)) {
        return [stringWidth(fmt + s.slice(0, di - idx)), y * FONT_HEIGHT];
      }
      idx += s.length;
      fmt = getFormatFromString(fmt + s);
    }
    return [0, Math.max(0, lines.length - 1) * FONT_HEIGHT];
  }

  scrollHeight() {
    if (!this.wrap) return 0;
    const d = this.shown();
    return Math.max(0, splitString(d.text, this.innerW(), true).length * FONT_HEIGHT - this.innerH());
  }
  hasVerticalScroll() {
    return this.scrollHeight() > 0;
  }

  private revealCaret() {
    const [x, y] = this.caretXY();
    if (!this.wrap) {
      const w = this.innerW();
      if (x < this.scrollX) this.scrollX = x;
      else if (x > this.scrollX + w) this.scrollX = x - w;
      this.scrollX = Math.max(0, Math.min(this.scrollX, Math.max(0, stringWidth(this.shown().text) - w)));
    } else {
      const h = this.innerH();
      let sy = this.currentScrollY();
      if (y < sy) sy = y;
      else if (y > sy + h - FONT_HEIGHT) sy = y - h + FONT_HEIGHT;
      this.setScrollY(sy);
    }
  }

  private currentScrollY() {
    const max = this.scrollHeight();
    if (this.scrollDriver) return Math.round(this.scrollDriver.read() * max);
    return Math.min(this.scrollY, max);
  }
  private setScrollY(sy: number) {
    const max = this.scrollHeight();
    sy = Math.max(0, Math.min(sy, max));
    this.scrollY = sy;
    if (this.scrollDriver) this.scrollDriver.write(max > 0 ? sy / max : 0);
  }

  /** The source index under a point in GUI coordinates. */
  private indexAt(mx: number, my: number): number {
    const r = this.transform;
    const d = this.shown();
    if (!this.wrap) return sourceIndex(d, cursorPos(d.text, mx - (r.x() + 4) + this.scrollX));
    const lines = this.visualLines();
    const row = Math.min(Math.max(Math.floor((my - (r.y() + 4) + this.currentScrollY()) / FONT_HEIGHT), 0), lines.length - 1);
    let idx = 0, fmt = '';
    for (let i = 0; i < row; i++) {
      idx += lines[i].length;
      fmt = getFormatFromString(fmt + lines[i]);
    }
    return sourceIndex(d, idx + cursorPos(fmt + lines[row], mx - (r.x() + 4)) - fmt.length);
  }

  /** Up or down a visual line, keeping the column (wrapped mode). */
  moveLine(dir: number, extend: boolean) {
    this.syncFromElement();
    const [x, y] = this.caretXY();
    if (this.prefX < 0) this.prefX = x;
    const r = this.transform;
    const lines = this.visualLines();
    const row = Math.round(y / FONT_HEIGHT) + dir;
    if (row < 0) return this.setCaret(0, extend);
    if (row >= lines.length) return this.setCaret(this.text.length, extend);
    const px = this.prefX;
    const i = this.indexAt(r.x() + 4 + px, r.y() + 4 + row * FONT_HEIGHT - this.currentScrollY() + 1);
    this.setCaret(i, extend);
    this.prefX = px;
  }

  // ---------------------------------------------------------------- drawing and input

  draw(gfx: Gfx, mx: number, my: number) {
    const r = this.transform;
    this.syncFromElement();
    if (this.dragging && mouseButtons[0]) {
      const i = this.indexAt(mx, my);
      if (i !== this.caret) this.setCaret(i, true);
    } else if (this.dragging) this.dragging = false;

    const state = !this.active ? 0 : this.focused ? 2 : 1;
    if (this.background) tex(`text_box_${state}`).draw(gfx, r.x(), r.y(), r.w(), r.h());
    const d = this.shown();
    gfx.clip(r.x(), r.y(), r.w(), r.h());
    const ox = r.x() + 4 - (this.wrap ? 0 : this.scrollX);
    const oy = r.y() + 4 - (this.wrap ? this.currentScrollY() : 0);
    const hl = col('text_highlight').argb();
    const a = displayIndex(d, this.selectionStart), b = displayIndex(d, this.selectionEnd);
    if (!d.text) {
      if (!this.focused) drawString(gfx, this.watermark, r.x() + 4, r.y() + 4, col('text_watermark').argb(), false);
    } else if (!this.wrap) {
      drawString(gfx, d.text, ox, oy, col('text_aux_0').argb(), false);
      if (a !== b && this.focused) {
        const x1 = stringWidth(d.text.slice(0, a)), x2 = stringWidth(d.text.slice(0, b));
        highlight(gfx, ox + x1, oy, x2 - x1, FONT_HEIGHT, hl);
      }
    } else {
      const shownLines = splitString(d.text, this.innerW(), true);
      const plain = this.visualLines();
      const first = Math.max(0, Math.floor((r.y() - oy) / FONT_HEIGHT));
      const last = Math.min(shownLines.length - 1, Math.ceil((r.y() + r.h() - oy) / FONT_HEIGHT));
      let idx = 0, fmt = '';
      for (let i = 0; i < Math.min(shownLines.length, plain.length); i++) {
        const line = plain[i];
        if (i >= first && i <= last) {
          drawString(gfx, shownLines[i], ox, oy + i * FONT_HEIGHT, col('text_aux_0').argb(), false);
          const i1 = Math.max(idx, a) - idx, i2 = Math.min(idx + line.length, b) - idx;
          if (this.focused && i1 < i2 && i1 >= 0 && i2 <= line.length) {
            const x1 = stringWidth(fmt + line.slice(0, i1)), x2 = stringWidth(fmt + line.slice(0, i2));
            highlight(gfx, ox + x1, oy + i * FONT_HEIGHT, x2 - x1, FONT_HEIGHT, hl);
          }
        }
        idx += line.length;
        fmt = getFormatFromString(fmt + line);
      }
    }
    if (this.focused) {
      animating();
      if (a === b && Math.floor(performance.now() / 500) % 2 === 0) {
        const [cx, cy] = this.caretXY();
        gfx.fill(ox + cx, oy + cy, 1, FONT_HEIGHT, hl);
      }
    }
    gfx.endClip();
  }

  mouseDown(mx: number, my: number, b: number) {
    if (this.active && contains(this.transform, mx, my)) {
      if (b === 1 && !this.wrap) {
        this.setText('');
        this.onChange?.('');
      }
      if (!this.focused || owner !== this) this.focus();
      this.prefX = -1;
      this.setCaret(this.indexAt(mx, my), false);
      this.dragging = b === 0;
      return true;
    }
    if (this.focused && !this.lockFocus) {
      if (owner === this) element(this.wrap).blur();
      this.blurred();
    }
    return false;
  }

  mouseUp(_mx: number, _my: number, _b: number) {
    const was = this.dragging;
    this.dragging = false;
    return this.focused && was;
  }

  scroll(mx: number, my: number, d: number) {
    if (!this.wrap || !contains(this.transform, mx, my) || this.scrollHeight() <= 0) return false;
    this.setScrollY(this.currentScrollY() + d * FONT_HEIGHT * 2);
    return true;
  }
}

/** RenderUtils.drawHighlightBox: the selection drawn over the text (an inverting OR in GL). */
function highlight(gfx: Gfx, x: number, y: number, w: number, h: number, argb: number) {
  const g = gfx.g;
  const prev = g.globalCompositeOperation;
  g.globalCompositeOperation = 'difference';
  gfx.fill(x, y, w, h, (0xff000000 | (argb & 0xffffff)) >>> 0);
  g.globalCompositeOperation = prev;
}
