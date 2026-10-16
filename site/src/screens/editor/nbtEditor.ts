// GuiNbtEditor (PanelScrollingNBT), GuiNbtAdd and GuiNbtType: the raw NBT editor behind the
// "Advanced" buttons. It edits a tag in place; the callback gets the tag when Back is pressed
// (Escape leaves without it, as in game).

import { Screen } from '../../gui/screen.ts';
import { Rect, Transform, Align, type Panel } from '../../gui/core.ts';
import { col } from '../../gui/theme.ts';
import { staticColor } from '../../gui/color.ts';
import { PanelButton, PanelTextBox, CanvasScrolling, PanelVScrollBar } from '../../gui/widgets.ts';
import { PanelTextField, valueText, type FieldFilter } from '../../gui/textfield.ts';
import { tr } from '../../gui/lang.ts';
import { keys } from '../../gui/core.ts';
import { itemName, fluidName } from '../../gui/items.ts';
import { splitKey, type BqObject, type BqValue } from '../../lib/bqjson.ts';
import { itemStackTag, fluidStackTag } from '../../edit/ops.ts';
import { entityIds } from '../taskPanels.ts';
import { addBackground, addTitle, addBottomButton, addLine, label } from './common.ts';
import { TextEditorScreen } from './textEditor.ts';
import { ItemSelectionScreen, FluidSelectionScreen, EntitySelectionScreen, stackFromTag } from './selection.ts';

const isObj = (v: BqValue | undefined): v is BqObject => !!v && typeof v === 'object' && !Array.isArray(v);

/** Java's String.compareTo order. */
const javaCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface Entry {
  /** The key in the container ("name:8" or "3:10"). */
  full: string;
  /** Name (compound) or index (list). */
  name: string;
  type: number;
  value: BqValue;
}

/** A compound's or list's entries as the editor lists them (compound keys sorted by name). */
export function entriesOf(tag: BqObject, list: boolean): Entry[] {
  const out = Object.keys(tag).map((full) => {
    const [name, type] = splitKey(full);
    return { full, name, type, value: tag[full] };
  });
  if (list) out.sort((a, b) => Number(a.name) - Number(b.name));
  else out.sort((a, b) => javaCompare(a.name, b.name));
  return out;
}

/** Put list entries back with their positions as keys. */
function setListEntries(tag: BqObject, list: { type: number; value: BqValue }[]) {
  for (const k of Object.keys(tag)) delete tag[k];
  list.forEach((e, i) => (tag[`${i}:${e.type}`] = e.value));
}

/** JsonHelper.isItem / isFluid / isEntity, as far as the site can tell. */
export const isItemTag = (t: BqObject) => typeof t['id:8'] === 'string' && Object.keys(t).some((k) => splitKey(k)[0] === 'Count') && Object.keys(t).some((k) => splitKey(k)[0] === 'Damage');
export const isFluidTag = (t: BqObject) => typeof t['FluidName:8'] === 'string' && Object.keys(t).some((k) => splitKey(k)[0] === 'Amount');
export const isEntityTag = (t: BqObject) => typeof t['id:8'] === 'string' && !isItemTag(t) && entityIds().includes(t['id:8'] as string);

const clear = (t: BqObject) => {
  for (const k of Object.keys(t)) delete t[k];
};

/** NbtItemCallback: the stack written over the tag (stone when nothing was picked). */
const writeItem = (t: BqObject, v: BqObject | null) => {
  clear(t);
  Object.assign(t, v ?? itemStackTag('minecraft:stone'));
};
const writeFluid = (t: BqObject, v: BqObject | null) => {
  clear(t);
  Object.assign(t, v ?? fluidStackTag('water', 1000));
};
const writeEntity = (t: BqObject, id: string | null) => {
  clear(t);
  t['id:8'] = id ?? 'Pig';
};

const FILTER: Record<number, FieldFilter> = { 1: 'byte', 2: 'short', 3: 'int', 4: 'long', 5: 'float', 6: 'double' };
const TYPE_NAME: Record<number, string> = {
  1: 'NBTTagByte', 2: 'NBTTagShort', 3: 'NBTTagInt', 4: 'NBTTagLong', 5: 'NBTTagFloat', 6: 'NBTTagDouble', 7: 'NBTTagByteArray',
  8: 'NBTTagString', 9: 'NBTTagList', 10: 'NBTTagCompound', 11: 'NBTTagIntArray', 12: 'NBTTagLongArray',
};

const btnTitle = (t: BqObject) => {
  if (isItemTag(t)) {
    const s = stackFromTag(t)!;
    return `${tr('betterquesting.btn.item')}: ${itemName({ id: s.id, dmg: s.dmg, n: s.count })}`;
  }
  if (isFluidTag(t)) return `${tr('betterquesting.btn.fluid')}: ${fluidName({ fluid: t['FluidName:8'] as string, n: 0 })}`;
  if (isEntityTag(t)) return `${tr('betterquesting.btn.entity')}: ${t['id:8']}`;
  return 'Object...';
};

const GRAY = staticColor(0xff808080);
const GREEN = staticColor(0xff00ff00);
const RED = staticColor(0xffff0000);

export class NbtEditorScreen extends Screen {
  private scrollPos = 0;
  private cv: CanvasScrolling | null = null;

  /**
   * `tag` is edited in place. `list` says whether it is an NBT list ({"0:10": ...}) rather than a
   * compound. The callback runs when Back is pressed.
   */
  constructor(
    parent: Screen | null,
    private tag: BqObject,
    private list: boolean,
    private callback: ((tag: BqObject) => void) | null,
  ) {
    super(parent);
  }

  title() {
    return tr(this.list ? 'betterquesting.title.json_array' : 'betterquesting.title.json_object');
  }
  route() {
    return (this.parent?.route() ?? '#/') + '/nbt';
  }

  build() {
    if (this.cv) this.scrollPos = this.cv.getScrollY();
    const bg = addBackground(this);
    addBottomButton(bg, tr('gui.back'), () => {
      this.host.back();
      this.callback?.(this.tag);
    });
    addTitle(bg, this.title());
    const cv = (this.cv = bg.add(new CanvasScrolling(new Transform(Align.FULL_BOX, [16, 32, 24, 32]))));
    const bar = bg.add(new PanelVScrollBar(new Transform(Align.RIGHT_EDGE, [-24, 32, 16, 32])));
    cv.scrollY = bar;
    addLine(bg, Transform.at(Align.TOP_LEFT, 16, 32, 0, 0), Transform.at(Align.TOP_RIGHT, -16, 32, 0, 0), -1);
    addLine(bg, Transform.at(Align.BOTTOM_LEFT, 16, -32, 0, 0), Transform.at(Align.BOTTOM_RIGHT, -16, -32, 0, 0), -1);
    this.fill(cv);
    cv.setScrollY(this.scrollPos);
    cv.updatePanelScroll();
    bar.enabled = cv.scrollBounds.rh > 0;
  }

  private fill(cv: CanvasScrolling) {
    const width = cv.transform.w();
    const lw = Math.trunc(width / 3), rw = width - lw;
    const tag = this.tag;
    const panels: Panel[] = [];
    const entries = entriesOf(tag, this.list);
    const set = (full: string, v: BqValue) => (tag[full] = v);
    const button = (x: number, y: number, w: number, text: string, onClick: () => void) => {
      const b = new PanelButton(new Rect(x, y, w, 16), { text, onClick });
      panels.push(b);
      return b;
    };
    const field = (x: number, y: number, w: number, text: string, filter: FieldFilter, onChange: (f: PanelTextField) => void) => {
      const f = new PanelTextField(new Rect(x, y, w, 16), text);
      f.filter = filter;
      f.onChange = () => onChange(f);
      panels.push(f);
      return f;
    };
    const plusMinus = (y: number, index: number, full: string | null) => {
      const ins = button(width - 32, y, 16, '+', () => this.insert(index));
      ins.colors = [GRAY, GREEN, GREEN];
      if (full !== null) {
        const del = button(width - 16, y, 16, 'x', () => this.remove(full));
        del.colors = [GRAY, RED, RED];
      }
    };

    entries.forEach((e, i) => {
      const y = i * 16;
      panels.push(new PanelTextBox(new Rect(0, y + 4, lw - 8, 12), this.list ? `#${i}` : e.name).setAlignment(2).setColor(col('text_main')));
      const v = e.value;
      if (e.type === 10 && isObj(v)) {
        button(lw, y, rw - 48, btnTitle(v), () => this.editCompound(v));
        button(width - 48, y, 16, '...', () => this.host.show(new NbtTypeScreen(this, v)));
      } else if (e.type === 9 && isObj(v)) {
        button(lw, y, rw - 32, 'List...', () => this.host.show(new NbtEditorScreen(this, v, true, null)));
      } else if (e.type === 8) {
        field(lw, y, rw - 48, String(v ?? ''), 'string', (f) => set(e.full, f.text));
        button(width - 48, y, 16, 'Aa', () => this.host.show(new TextEditorScreen(this, String(tag[e.full] ?? ''), (s) => set(e.full, s))));
      } else if (e.type === 1) {
        const n = Number(v);
        const b = new PanelButton(new Rect(lw + Math.trunc(rw / 2), y, Math.ceil(rw / 2) - 32, 16), { text: n > 0 ? 'true' : 'false' });
        const f = field(lw, y, Math.trunc(rw / 2), String(n), 'byte', (ff) => {
          const x = Number(ff.value());
          set(e.full, x);
          b.text = x > 0 ? 'true' : 'false';
        });
        b.onClick = () => {
          const on = Number(tag[e.full]) > 0;
          set(e.full, on ? 0 : 1);
          f.setText(on ? '0' : '1');
          b.text = on ? 'false' : 'true';
        };
        panels.push(b);
      } else if (e.type >= 2 && e.type <= 6) {
        const filter = FILTER[e.type];
        field(lw, y, rw - 32, valueText(filter, typeof v === 'bigint' || typeof v === 'number' ? v : 0), filter, (f) => set(e.full, f.value() as BqValue));
      } else {
        panels.push(new PanelTextBox(new Rect(lw, y + 4, rw - 48, 12), `${TYPE_NAME[e.type] ?? 'NBTBase'} Not Supported Yet`).setAlignment(1).setColor(col('text_main')));
      }
      plusMinus(y, this.list ? i : -1, e.full);
    });
    const end = entries.length * 16;
    // Keeps the list from shrinking (an empty row under the last entry), then "+" to append.
    panels.push(new PanelTextBox(new Rect(0, end, width - 32, 16), ''));
    plusMinus(end, entries.length, null);
    cv.reset();
    cv.addAll(panels);
  }

  private editCompound(v: BqObject) {
    if (isItemTag(v)) this.host.show(new ItemSelectionScreen(this, v, (t) => writeItem(v, t)));
    else if (isFluidTag(v)) this.host.show(new FluidSelectionScreen(this, v, (t) => writeFluid(v, t)));
    else if (isEntityTag(v)) this.host.show(new EntitySelectionScreen(this, v['id:8'] as string, (id) => writeEntity(v, id)));
    else this.host.show(new NbtEditorScreen(this, v, false, null));
  }

  private insert(index: number) {
    if (!this.list) {
      this.host.show(new NbtAddScreen(this, this.tag, false, -1));
      return;
    }
    // Shift + "+": a stone item stack right away.
    if (keys.shift) {
      insertAt(this.tag, index, 10, itemStackTag('minecraft:stone'));
      this.host.refresh();
      return;
    }
    this.host.show(new NbtAddScreen(this, this.tag, true, index));
  }

  private remove(full: string) {
    if (!this.list) delete this.tag[full];
    else {
      const rest = entriesOf(this.tag, true).filter((e) => e.full !== full);
      setListEntries(this.tag, rest);
    }
    this.host.refresh();
  }
}

/** Insert into a list at a position (or append past the end). */
function insertAt(tag: BqObject, index: number, type: number, value: BqValue) {
  const list: { type: number; value: BqValue }[] = entriesOf(tag, true);
  list.splice(Math.min(index, list.length), 0, { type, value });
  setListEntries(tag, list);
}

/** GuiNbtAdd: pick a type (and for a compound, a key) for a new entry. */
export class NbtAddScreen extends Screen {
  private newKey = '';
  private selected: { type: number; make: () => BqValue } | null = null;
  private selectedLabel = '';

  constructor(parent: Screen | null, private tag: BqObject, private list: boolean, private index: number) {
    super(parent);
  }
  title() {
    return tr('betterquesting.title.json_add');
  }
  route() {
    return (this.parent?.route() ?? '#/') + '/add';
  }

  build() {
    const bg = addBackground(this);
    addBottomButton(bg, tr('gui.cancel'), () => this.host.back(), -100, 100);
    const confirm = addBottomButton(bg, tr('gui.done'), () => this.confirm(), 0, 100);
    addTitle(bg, tr('betterquesting.title.json_add'));
    const hasKey = (k: string) => Object.keys(this.tag).some((x) => splitKey(x)[0] === k);
    const update = () => {
      confirm.active = !!this.selected && (this.list || (!!this.newKey && !hasKey(this.newKey)));
    };
    if (!this.list) {
      const head = bg.add(label(Transform.at(Align.TOP_CENTER, -100, 36, 200, 12), ''));
      const key = bg.add(new PanelTextField(Transform.at(Align.TOP_CENTER, -100, 48, 200, 16), this.newKey));
      const status = () =>
        head.setText(
          !this.newKey ? '§c' + tr('betterquesting.gui.no_key') : hasKey(this.newKey) ? '§c' + tr('betterquesting.gui.duplicate_key') : tr('betterquesting.gui.key'),
        );
      key.onChange = (s) => {
        this.newKey = s;
        status();
        update();
      };
      status();
    }
    const options: [string, number, () => BqValue, number, number, number][] = [
      [tr('betterquesting.btn.item'), 10, () => itemStackTag('minecraft:stone'), 0, 0, 100],
      [tr('betterquesting.btn.fluid'), 10, () => fluidStackTag('water', 1000), 100, 0, 92],
      [tr('betterquesting.btn.entity'), 10, () => ({ 'id:8': 'Pig' }), 0, 16, 192],
      ['NBTTagString', 8, () => '', 0, 32, 192],
      ['NBTTagCompound', 10, () => ({}), 0, 48, 192],
      ['NBTTagList', 9, () => ({}), 0, 64, 192],
      ['NBTTagByte', 1, () => 0, 0, 80, 192],
      ['NBTTagShort', 2, () => 0, 0, 96, 192],
      ['NBTTagInt', 3, () => 0, 0, 112, 192],
      ['NBTTagLong', 4, () => 0n, 0, 128, 192],
      ['NBTTagFloat', 5, () => 0, 0, 144, 192],
      ['NBTTagDouble', 6, () => 0, 0, 160, 192],
      ['NBTTagByteArray', 7, () => [], 0, 176, 192],
      ['NBTTagIntArray', 11, () => [], 0, 192, 192],
    ];
    const cv = bg.add(new CanvasScrolling(new Transform([0.5, 0, 0.5, 1], [-100, 64, -92, 32])));
    const bar = bg.add(new PanelVScrollBar(new Transform([0.5, 0, 0.5, 1], [92, 64, -100, 32])));
    cv.scrollY = bar;
    cv.addAll(
      options.map(
        ([text, type, make, x, y, w]) =>
          new PanelButton(new Rect(x, y, w, 16), {
            text,
            active: this.selectedLabel !== text,
            onClick: () => {
              this.selected = { type, make };
              this.selectedLabel = text;
              this.host.refresh();
            },
          }),
      ),
    );
    update();
  }

  private confirm() {
    if (!this.selected) return;
    const v = this.selected.make();
    if (!this.list) this.tag[`${this.newKey}:${this.selected.type}`] = v;
    else insertAt(this.tag, this.index, this.selected.type, v);
    this.host.back();
  }
}

/** GuiNbtType: open a compound as raw NBT, or as an item, fluid or entity. */
export class NbtTypeScreen extends Screen {
  constructor(parent: Screen, private tag: BqObject) {
    super(parent);
  }
  title() {
    return tr('betterquesting.title.json_object');
  }
  route() {
    return (this.parent?.route() ?? '#/') + '/type';
  }
  build() {
    const bg = addBackground(this);
    addTitle(bg, tr('betterquesting.title.json_object'));
    addBottomButton(bg, tr('gui.back'), () => this.host.back());
    const t = this.tag;
    const parent = this.parent!;
    // Each choice replaces this screen (it opens with the editor as its parent).
    const go = (s: Screen) => {
      this.host.back();
      this.host.show(s);
    };
    const btn = (y: number, key: string, f: () => void) =>
      bg.add(new PanelButton(Transform.at(Align.MID_CENTER, -100, y, 200, 16), { text: tr(key), onClick: f }));
    btn(-32, 'betterquesting.btn.raw_nbt', () => go(new NbtEditorScreen(parent, t, false, null)));
    btn(-16, 'betterquesting.btn.item', () => go(new ItemSelectionScreen(parent, t, (v) => writeItem(t, v))));
    btn(0, 'betterquesting.btn.fluid', () => go(new FluidSelectionScreen(parent, t, (v) => writeFluid(t, v))));
    btn(16, 'betterquesting.btn.entity', () => go(new EntitySelectionScreen(parent, typeof t['id:8'] === 'string' ? (t['id:8'] as string) : null, (id) => writeEntity(t, id))));
  }
}
