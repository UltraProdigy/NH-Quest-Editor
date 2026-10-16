// GuiQuestLinesEditor: the quest lines (select, delete, move up, add) and the selected line's
// name, description, icon and visibility. GuiQuestLineAddRemove: a line's quests next to the quest
// database, to add or take out.

import type { Screen } from '../../gui/screen.ts';
import { CanvasEmpty, Transform, Align, Rect, type Panel } from '../../gui/core.ts';
import { PanelButton, CanvasScrolling, PanelVScrollBar } from '../../gui/widgets.ts';
import { PanelTextField } from '../../gui/textfield.ts';
import { icon } from '../../gui/theme.ts';
import { tr } from '../../gui/lang.ts';
import type { BqObject } from '../../lib/bqjson.ts';
import { lineKey } from '../../edit/document.ts';
import {
  getProp, bqProps, setLineProperty, createLine, deleteLine, moveLineUp, addToLine, removeFromLine, deleteQuests, createQuest,
} from '../../edit/ops.ts';
import {
  EditorScreen, addBackground, addTitle, addBottomButton, addDivider, lineName, questName, label, CanvasQuestDatabase,
} from './common.ts';
import { TextEditorScreen } from './textEditor.ts';
import { ItemSelectionScreen } from './selection.ts';
import { DesignerScreen } from './designer.ts';
import { VISIBILITY, next } from './questEditor.ts';
import { QuestScreen } from '../quest.ts';

export class QuestLinesEditorScreen extends EditorScreen {
  private selId: string | null = null;
  private tfName: PanelTextField | null = null;
  private tfDesc: PanelTextField | null = null;
  private listScroll = 0;
  private list: CanvasScrolling | null = null;

  constructor(parent: Screen | null, selected?: string) {
    super(parent);
    this.selId = selected ?? null;
  }
  title() {
    return tr('betterquesting.title.edit_line1');
  }
  protected routeSuffix() {
    return '/lines';
  }

  private prop(key: string) {
    return this.selId ? getProp(this.doc.db.lines.get(this.selId)?.tag, key) : undefined;
  }

  buildEditor() {
    if (this.selId && !this.doc.db.lines.has(this.selId)) this.selId = null;
    if (this.list) this.listScroll = this.list.getScrollY();
    const bg = addBackground(this);
    addTitle(bg, tr('betterquesting.title.edit_line1'));
    addBottomButton(bg, tr('gui.back'), () => {
      this.commit();
      this.host.back();
    });

    // Left: the lines.
    const list = (this.list = bg.add(new CanvasScrolling(new Transform(Align.HALF_LEFT, [16, 32, 16, 48]))));
    list.scrollY = bg.add(new PanelVScrollBar(new Transform([0.5, 0, 0.5, 1], [-16, 32, 8, 48])));
    const w = list.transform.w();
    const panels: Panel[] = [];
    let i = 0;
    for (const id of this.doc.db.lines.keys()) {
      const y = i++ * 16;
      panels.push(new PanelButton(new Rect(0, y, w - 32, 16), {
        text: lineName(this.doc, id),
        active: id !== this.selId,
        onClick: () => {
          this.commit();
          this.selId = id;
          this.host.refresh();
        },
      }));
      const del = new PanelButton(new Rect(w - 32, y, 16, 16), { onClick: () => deleteLine(this.doc, id) });
      del.setIcon(icon('trash'));
      const up = new PanelButton(new Rect(w - 16, y, 16, 16), { onClick: () => moveLineUp(this.doc, id) });
      up.setIcon(icon('up'));
      panels.push(del, up);
    }
    list.addAll(panels);
    list.setScrollY(this.listScroll);
    list.updatePanelScroll();
    bg.add(new PanelButton(new Transform([0, 1, 0.25, 1], [16, -40, 0, 24]), {
      text: tr('betterquesting.btn.new'),
      onClick: () => {
        this.commit();
        createLine(this.doc);
      },
    }));
    const imp = bg.add(new PanelButton(new Transform([0.25, 1, 0.5, 1], [0, -40, 16, 24]), { text: tr('betterquesting.btn.import'), active: false }));
    imp.tooltipLines = ['Importers read files from the game folder,', 'which the site cannot reach.'];

    // Right: the selected line.
    const sel = this.selId !== null;
    const right = bg.add(new CanvasEmpty(new Transform(Align.HALF_RIGHT, [8, 32, 16, 24])));
    right.add(label(new Transform(Align.TOP_EDGE, [0, 4, 0, -16]), tr('betterquesting.gui.name')));
    this.tfName = right.add(new PanelTextField(new Transform(Align.TOP_EDGE, [0, 16, 0, -32]), String(this.prop('name:8') ?? '')));
    this.tfName.onEnter = () => this.commit();
    right.add(label(new Transform(Align.TOP_EDGE, [0, 36, 0, -48]), tr('betterquesting.gui.description')));
    this.tfDesc = right.add(new PanelTextField(new Transform(Align.TOP_EDGE, [0, 48, 16, -64]), String(this.prop('desc:8') ?? '')));
    this.tfDesc.onEnter = () => this.commit();
    const at = (y: number) => new Transform(Align.TOP_EDGE, [0, y, 0, -y - 16]);
    right.add(new PanelButton(at(80), {
      text: tr('betterquesting.btn.icon'),
      active: sel,
      onClick: () => {
        const id = this.selId;
        if (!id) return;
        this.host.show(new ItemSelectionScreen(this, this.prop('icon:10') as BqObject | undefined, (v) =>
          v && setLineProperty(this.doc, id, 'icon:10', v, 'Change quest line icon')));
      },
    }));
    const vis = String(this.prop('visibility:8') ?? 'NORMAL');
    right.add(new PanelButton(at(96), {
      text: `${tr('betterquesting.btn.show')}: ${vis}`,
      active: sel,
      onClick: () => this.selId && setLineProperty(this.doc, this.selId, 'visibility:8', next(VISIBILITY, vis), 'Change quest line visibility'),
    }));
    right.add(new PanelButton(at(112), {
      text: tr('betterquesting.btn.add_remove_quests'),
      active: sel,
      onClick: () => this.selId && this.host.show(new QuestLineAddRemoveScreen(this, this.selId)),
    }));
    // In game the designer button sits over the visibility one (both at 96); it goes below here.
    right.add(new PanelButton(at(128), {
      text: tr('betterquesting.btn.designer'),
      active: sel,
      onClick: () => this.selId && this.host.show(new DesignerScreen(this, this.selId)),
    }));
    right.add(new PanelButton(new Transform(Align.TOP_RIGHT, [-16, 48, 0, -64]), {
      text: 'Aa',
      onClick: () => {
        const id = this.selId;
        if (!id) return;
        this.commit();
        this.host.show(new TextEditorScreen(this, String(this.prop('desc:8') ?? ''), (v) => setLineProperty(this.doc, id, 'desc:8', v, 'Edit quest line description')));
      },
    }));
    addDivider(bg, 32, 24);
  }

  /** onMouseClick: the name and description are saved when they differ. */
  private commit() {
    const id = this.selId;
    if (!id || !this.tfName || !this.tfDesc || !this.doc.db.lines.has(id)) return;
    const name = this.tfName.text, desc = this.tfDesc.text;
    if (name === String(this.prop('name:8') ?? '') && desc === String(this.prop('desc:8') ?? '')) return;
    this.doc.transact('Edit quest line', (tx) => {
      const t = tx.line(id);
      if (!t) return;
      bqProps(t)['name:8'] = name;
      bqProps(t)['desc:8'] = desc;
      tx.set(lineKey(id), t);
    });
  }

  mouseDown(mx: number, my: number, b: number) {
    const r = super.mouseDown(mx, my, b);
    this.commit();
    return r;
  }
  key(e: KeyboardEvent) {
    if (e.key === 'Escape' || e.key === 'Backspace') this.commit();
    return super.key(e);
  }
}

export class QuestLineAddRemoveScreen extends EditorScreen {
  private search = '';
  private dbScroll = 0;
  private db: CanvasQuestDatabase | null = null;

  constructor(parent: Screen | null, private lineId: string) {
    super(parent);
  }
  title() {
    return tr('betterquesting.title.edit_line2', this.doc ? lineName(this.doc, this.lineId) : '');
  }
  protected routeSuffix() {
    return '/quests';
  }

  buildEditor() {
    const line = this.doc.db.lines.get(this.lineId);
    if (this.db) this.dbScroll = this.db.getScrollY();
    const bg = addBackground(this);
    addTitle(bg, tr('betterquesting.title.edit_line2', line ? lineName(this.doc, this.lineId) : ''));
    addBottomButton(bg, tr('gui.back'), () => this.host.back());

    const left = bg.add(new CanvasEmpty(new Transform(Align.HALF_LEFT, [16, 32, 8, 24], 8)));
    if (line) left.add(label(new Transform(Align.TOP_EDGE, [0, 0, 0, -16]), lineName(this.doc, this.lineId), 1));
    const list = left.add(new CanvasScrolling(new Transform(Align.FULL_BOX, [0, 16, 8, 0])));
    list.scrollY = left.add(new PanelVScrollBar(new Transform(Align.RIGHT_EDGE, [-8, 16, 0, 0])));
    const w = list.transform.w();
    const panels: Panel[] = [];
    let i = 0;
    for (const qid of line?.entries.keys() ?? []) {
      const y = i++ * 16;
      if (!this.doc.db.quests.has(qid)) {
        // A placement of a quest that does not exist: the button deletes it.
        panels.push(new PanelButton(new Rect(w - 16, y, 16, 16), { text: '[ERROR]', onClick: () => deleteQuests(this.doc, [qid]) }));
        continue;
      }
      panels.push(new PanelButton(new Rect(0, y, w - 16, 16), { text: questName(this.doc, qid), onClick: () => this.host.show(new QuestScreen(this, qid)) }));
      const rem = new PanelButton(new Rect(w - 16, y, 16, 16), { onClick: () => removeFromLine(this.doc, this.lineId, [qid]) });
      rem.setIcon(icon('negative'));
      panels.push(rem);
    }
    list.addAll(panels);

    const right = bg.add(new CanvasEmpty(new Transform(Align.HALF_RIGHT, [8, 32, 16, 24])));
    right.add(label(new Transform(Align.TOP_EDGE, [0, 0, 0, -16]), tr('betterquesting.gui.database'), 1));
    const search = right.add(new PanelTextField(new Transform(Align.TOP_EDGE, [0, 16, 8, -32]), this.search));
    search.watermark = 'Search...';
    const db = (this.db = new CanvasQuestDatabase(new Transform(Align.FULL_BOX, [0, 32, 8, 24]), this.doc, (id, n, ww) => {
      const add = new PanelButton(new Rect(0, n * 16, 16, 16), { onClick: () => addToLine(this.doc, this.lineId, id), active: !!line && !line.entries.has(id) });
      add.setIcon(icon('positive'));
      const del = new PanelButton(new Rect(ww - 16, n * 16, 16, 16), { onClick: () => deleteQuests(this.doc, [id]) });
      del.setIcon(icon('trash'));
      return [add, new PanelButton(new Rect(16, n * 16, ww - 32, 16), { text: questName(this.doc, id), onClick: () => this.host.show(new QuestScreen(this, id)) }), del];
    }));
    right.add(db);
    db.scrollY = right.add(new PanelVScrollBar(new Transform(Align.RIGHT_EDGE, [-8, 32, 0, 24])));
    search.onChange = (s) => {
      this.search = s;
      db.setSearchFilter(s);
    };
    if (this.search) db.setSearchFilter(this.search);
    db.setScrollY(this.dbScroll);
    db.updatePanelScroll();
    right.add(new PanelButton(new Transform(Align.BOTTOM_EDGE, [0, -16, 0, 0]), { text: tr('betterquesting.btn.new'), onClick: () => createQuest(this.doc) }));
    addDivider(bg, 32, 24);
  }
}
