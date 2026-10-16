// GuiTextEditor: a full screen, wrapped text field with formatting buttons and macros. The
// callback gets the text when the screen closes.

import { Screen } from '../../gui/screen.ts';
import { Transform, Align, Rect, type Panel } from '../../gui/core.ts';
import { CanvasScrolling, PanelButton, PanelVScrollBar } from '../../gui/widgets.ts';
import { PanelTextField, type DisplayText } from '../../gui/textfield.ts';
import { PopColorInput } from '../../gui/colorPopup.ts';
import { tr } from '../../gui/lang.ts';
import { getFormatFromString } from '../../gui/text.ts';
import { stripFormatting } from '../../lib/bqsave.ts';
import { addBackground, addTitle, addBottomButton } from './common.ts';

const RESET = '§r';
const TAG_COLOR = '§c';
const TAG_CANDIDATE = /\[[^\]\r\n]*]/g;
const OPENING_TAG = /^\[([0-9a-zA-Z]+)((?: [0-9a-zA-Z]+=[^ ]+)*)]$/;
const CLOSING_TAG = /^\[\/([0-9a-zA-Z]+)]$/;
const FORMATTING_TAGS = new Set(['note', 'warn', 'quest', 'bold', 'italic', 'underline', 'strikethrough', 'obfuscated', 'url', 'questlink']);
const IMAGE_OPENING_TAG = /^\[img height=[1-9]\d*]$/;

const isSupportedTag = (t: string) => {
  const o = OPENING_TAG.exec(t);
  if (o && FORMATTING_TAGS.has(o[1])) return true;
  const c = CLOSING_TAG.exec(t);
  if (c && FORMATTING_TAGS.has(c[1])) return true;
  return IMAGE_OPENING_TAG.test(t) || t === '[/img]';
};

const isHex = (s: string, i: number) => /^[0-9a-fA-F]{6}$/.test(s.slice(i, i + 6));
const isValidSectionX = (t: string, pos: number) => {
  if (pos + 14 > t.length || t[pos] !== '§' || t[pos + 1].toLowerCase() !== 'x') return false;
  for (let i = 0; i < 6; i++) if (t[pos + 2 + i * 2] !== '§' || !/[0-9a-fA-F]/.test(t[pos + 3 + i * 2])) return false;
  return true;
};

/**
 * TextEditorSyntaxHighlighter: [tags] in red, & codes shown and applied to themselves, §
 * codes applied (and hidden, as the game's font hides them).
 */
export function highlight(text: string): DisplayText {
  const map = new Array<number>(text.length + 1).fill(0);
  let out = '';
  let active = '';
  const raw = (start: number, end: number) => {
    for (let i = start; i < end; i++) {
      map[i] = out.length;
      out += text[i];
    }
    map[end] = out.length;
  };
  const ampersand = (i: number, end: number): string | null => {
    if (text[i] !== '&' || i + 1 >= end) return null;
    const c = text[i + 1].toLowerCase();
    if (c === '#' && i + 8 <= end && isHex(text, i + 2)) return '§x' + [...text.slice(i + 2, i + 8)].map((h) => '§' + h).join('');
    if (/[0-9a-fk-or]/.test(c)) return '§' + c;
    return null;
  };
  const source = (start: number, end: number) => {
    let i = start;
    while (i < end) {
      const f = ampersand(i, end);
      if (f !== null) {
        const len = f.startsWith('§x') ? 8 : 2;
        out += f;
        raw(i, i + 1);
        out += f;
        raw(i + 1, i + len);
        active = getFormatFromString(active + f);
        i += len;
        continue;
      }
      let sec = 0;
      if (text[i] === '§' && i + 1 < end) sec = text[i + 1].toLowerCase() === 'x' && i + 14 <= end && isValidSectionX(text, i) ? 14 : 2;
      if (sec) {
        raw(i, i + sec);
        active = getFormatFromString(active + text.slice(i, i + sec));
        i += sec;
        continue;
      }
      map[i] = out.length;
      out += text[i];
      i++;
    }
    map[end] = out.length;
  };
  let at = 0;
  for (const m of text.matchAll(TAG_CANDIDATE)) {
    if (!isSupportedTag(m[0])) continue;
    source(at, m.index!);
    out += TAG_COLOR;
    raw(m.index!, m.index! + m[0].length);
    out += RESET + active;
    map[m.index! + m[0].length] = out.length;
    at = m.index! + m[0].length;
  }
  source(at, text.length);
  return { text: out, map };
}

/** EnumChatFormatting: code and friendly name. */
const FORMATS: [string, string][] = [
  ['0', 'black'], ['1', 'dark_blue'], ['2', 'dark_green'], ['3', 'dark_aqua'], ['4', 'dark_red'], ['5', 'dark_purple'],
  ['6', 'gold'], ['7', 'gray'], ['8', 'dark_gray'], ['9', 'blue'], ['a', 'green'], ['b', 'aqua'], ['c', 'red'],
  ['d', 'light_purple'], ['e', 'yellow'], ['f', 'white'], ['k', 'obfuscated'], ['l', 'bold'], ['m', 'strikethrough'],
  ['n', 'underline'], ['o', 'italic'], ['r', 'reset'],
];

/** TextEditorActionRegistry: macros wrap the selection, actions apply formatting. */
type Action = { key: string; run: (s: TextEditorScreen) => void };
const macro = (key: string, open: string, close: string): Action => ({
  key,
  run: (s) => s.replaceSelected(open + s.selected() + close),
});
const format = (key: string, f: string): Action => ({ key, run: (s) => s.applyFormatting(f, s.selected()) });
const ACTIONS: Action[] = [
  macro('betterquesting.editor.macro.hyperlink', '[url]', '[/url]'),
  macro('betterquesting.editor.macro.warning', '[warn]', '[/warn]'),
  macro('betterquesting.editor.macro.note', '[note]', '[/note]'),
  macro('betterquesting.editor.macro.quest_title', '[quest]', '[/quest]'),
  macro('betterquesting.editor.macro.quest_link', '[questlink]', '[/questlink]'),
  { key: 'betterquesting.editor.action.hex_color', run: (s) => s.colorPicker('betterquesting.editor.color_picker.hex', false) },
  format('betterquesting.editor.action.rainbow', '&q'),
  format('betterquesting.editor.action.wave', '&z'),
  format('betterquesting.editor.action.flip', '&v'),
  { key: 'betterquesting.editor.action.gradient', run: (s) => s.colorPicker('betterquesting.editor.color_picker.gradient', true) },
  {
    key: 'betterquesting.editor.action.clear_format',
    run: (s) => {
      const sel = s.selected();
      s.replaceSelected(sel ? stripFormatting(sel) : '§r');
    },
  },
];
const IMAGE_MACRO = macro('betterquesting.editor.macro.image', '[img height=100]', '[/img]');

export class TextEditorScreen extends Screen {
  private field: PanelTextField | null = null;
  private text: string;
  private closed = false;
  private sel: [number, number] = [0, 0];

  constructor(
    parent: Screen | null,
    text: string,
    private callback: ((value: string) => void) | null,
    private imageSupport = false,
  ) {
    super(parent);
    this.text = text;
  }

  title() {
    return tr('betterquesting.title.edit_text');
  }
  route() {
    return (this.parent?.route() ?? '#/') + '/text';
  }

  build() {
    // Keep what was typed (and the selection) across rebuilds.
    if (this.field) {
      this.text = this.field.text;
      this.sel = [this.field.selectionStart, this.field.selectionEnd];
    }
    const bg = addBackground(this);
    addBottomButton(bg, tr('gui.back'), () => this.close());
    addTitle(bg, tr('betterquesting.title.edit_text'));

    const f = (this.field = bg.add(new PanelTextField(new Transform(Align.FULL_BOX, [124, 32, 24, 32]), this.text)));
    f.wrap = true;
    f.lockFocus = true;
    f.displayFormatter = highlight;
    const bar = bg.add(new PanelVScrollBar(new Transform(Align.RIGHT_EDGE, [0, 0, -8, 0])));
    bar.transform.parent = f.transform;
    f.scrollDriver = bar;
    f.onChange = () => (bar.active = f.hasVerticalScroll());
    bar.active = f.hasVerticalScroll();

    const list = bg.add(new CanvasScrolling(new Transform(Align.LEFT_EDGE, [16, 32, -116, 32])));
    const panels: Panel[] = [];
    let n = 0;
    const add = (text: string, onClick: () => void) => panels.push(new PanelButton(new Rect(0, 16 * n++, 100, 16), { text, onClick }));
    if (this.imageSupport) {
      add(tr('betterquesting.editor.macro.select_image'), () => {});
      (panels[panels.length - 1] as PanelButton).active = false;
      (panels[panels.length - 1] as PanelButton).tooltipLines = ['Pictures come from the game\'s resources,', 'which cannot be added from the browser.'];
      add(tr(IMAGE_MACRO.key), () => IMAGE_MACRO.run(this));
    }
    for (const a of ACTIONS) add(tr(a.key), () => a.run(this));
    for (const [code, name] of FORMATS) {
      add(`§${code}${name}§r`, () => {
        const s = this.selected();
        this.replaceSelected(s ? `§${code}${s}§r` : `§${code}`);
      });
    }
    list.addAll(panels);
    const sc = bg.add(new PanelVScrollBar(new Transform(Align.RIGHT_EDGE, [0, 0, -8, 0])));
    sc.transform.parent = list.transform;
    list.scrollY = sc;
    sc.active = list.scrollBounds.rh > 0;

    queueMicrotask(() => {
      if (this.host.screen !== this || this.field !== f) return;
      f.focus();
      // Back where the cursor was before a rebuild.
      f.setSelection(this.sel[0], this.sel[1]);
    });
  }

  selected() {
    return this.field?.selectedText() ?? '';
  }

  replaceSelected(s: string) {
    this.field?.writeText(s);
  }

  applyFormatting(f: string, selected: string) {
    this.replaceSelected(selected ? f + selected + '§r' : f);
  }

  colorPicker(titleKey: string, gradient: boolean) {
    const selected = this.selected();
    const field = this.field;
    this.openPopup(
      new PopColorInput(tr(titleKey), gradient, (f) => {
        field?.focus();
        this.applyFormatting(f, selected);
      }, () => {
        this.closePopup();
        field?.focus();
      }),
    );
  }

  /** onGuiClosed: hand the text back, then leave. */
  close() {
    if (this.closed) return;
    this.closed = true;
    const value = this.field?.text ?? this.text;
    this.field?.unfocus();
    this.host.back();
    this.callback?.(value);
  }

  key(e: KeyboardEvent) {
    if (this.popup && e.key === 'Escape') {
      this.closePopup();
      this.field?.focus();
      return true;
    }
    if (e.key === 'Escape') {
      this.close();
      return true;
    }
    return super.key(e);
  }

  mouseDown(mx: number, my: number, b: number) {
    if (this.popup) return super.mouseDown(mx, my, b);
    const used = this.root.mouseDown(mx, my, b);
    // A right click elsewhere leaves, like Back.
    if (!used && b === 1) this.close();
    return used;
  }
}
