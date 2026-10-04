// Single-line text field (PanelTextField). Typing goes through a hidden <input> so that
// browser text entry (IME, mobile keyboards, paste) works; the field draws its value itself.

import { BasePanel, contains, type Gfx, type GuiRect } from './core.ts';
import { animating, invalidate } from './frame.ts';
import { tex, col } from './theme.ts';
import { drawString, stringWidth } from './font.ts';

let input: HTMLInputElement | null = null;
let owner: PanelTextField | null = null;

function hiddenInput(): HTMLInputElement {
  if (input) return input;
  input = document.createElement('input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Search');
  Object.assign(input.style, {
    position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0', border: '0', padding: '0',
  });
  input.addEventListener('input', () => {
    owner?.fromInput();
    invalidate();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') input!.blur();
    e.stopPropagation();
    if (e.key === 'Escape') {
      // Let the screen handle Escape (go back) after leaving the field.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    }
  });
  input.addEventListener('blur', () => {
    if (owner && !owner.lockFocus) owner.focused = false;
  });
  document.body.appendChild(input);
  return input;
}

export class PanelTextField extends BasePanel {
  text = '';
  watermark = '';
  focused = false;
  lockFocus = false;
  onChange?: (s: string) => void;

  constructor(t: GuiRect, text = '') {
    super(t);
    this.text = text;
  }

  focus() {
    const el = hiddenInput();
    owner = this;
    this.focused = true;
    el.value = this.text;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }

  fromInput() {
    if (!input) return;
    this.text = input.value;
    this.onChange?.(this.text);
  }

  setText(s: string) {
    this.text = s;
    if (owner === this && input) input.value = s;
  }

  draw(gfx: Gfx) {
    const r = this.transform;
    const state = this.focused ? 2 : 1;
    tex(`text_box_${state}`).draw(gfx, r.x(), r.y(), r.w(), r.h());
    gfx.clip(r.x(), r.y(), r.w(), r.h());
    if (!this.text) {
      if (!this.focused) drawString(gfx, this.watermark, r.x() + 4, r.y() + 4, col('text_watermark').argb(), false);
    } else {
      // Keep the end of long text visible.
      const w = stringWidth(this.text);
      const off = Math.max(0, w - (r.w() - 10));
      drawString(gfx, this.text, r.x() + 4 - off, r.y() + 4, col('text_aux_0').argb(), false);
    }
    if (this.focused) animating();
    if (this.focused && Math.floor(performance.now() / 500) % 2 === 0) {
      const w = stringWidth(this.text);
      const off = Math.max(0, w - (r.w() - 10));
      gfx.fill(r.x() + 4 + w - off, r.y() + 3, 1, 10, col('text_highlight').argb());
    }
    gfx.endClip();
  }

  mouseDown(mx: number, my: number, b: number) {
    if (contains(this.transform, mx, my)) {
      if (b === 1) {
        this.setText('');
        this.onChange?.('');
      }
      this.focus();
      return true;
    }
    if (!this.lockFocus) {
      this.focused = false;
      if (owner === this) input?.blur();
    }
    return false;
  }
}
