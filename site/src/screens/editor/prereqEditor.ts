// GuiPrerequisiteEditor: a quest's prerequisites (with their visibility type) on the left, the
// quest database on the right to add from, open, delete or make new quests.

import type { Screen } from '../../gui/screen.ts';
import { CanvasEmpty, Transform, Align, Rect, type Panel } from '../../gui/core.ts';
import { PanelButton, CanvasScrolling, PanelVScrollBar } from '../../gui/widgets.ts';
import { PanelTextField } from '../../gui/textfield.ts';
import { icon } from '../../gui/theme.ts';
import { tr } from '../../gui/lang.ts';
import { readPrereqs, addPrereq, removePrereq, cyclePrereqType, deleteQuests, createQuest } from '../../edit/ops.ts';
import {
  EditorScreen, addBackground, addTitle, addBottomButton, addDivider, questTag, questName, label, CanvasQuestDatabase,
} from './common.ts';
import { QuestScreen } from '../quest.ts';

const TYPE_ICON = ['visibility_normal', 'visibility_implicit', 'visibility_hidden'];
const TYPE_TIP = ['normal', 'implicit', 'hidden'];

export class PrerequisiteEditorScreen extends EditorScreen {
  private search = '';
  private dbScroll = 0;
  private db: CanvasQuestDatabase | null = null;

  constructor(parent: Screen | null, private questId: string) {
    super(parent);
  }
  title() {
    return tr('betterquesting.title.pre_requisites');
  }
  protected routeSuffix() {
    return '/requirements';
  }

  buildEditor() {
    const q = questTag(this.doc, this.questId);
    if (!q) {
      queueMicrotask(() => this.host.back());
      return;
    }
    if (this.db) this.dbScroll = this.db.getScrollY();
    const bg = addBackground(this);
    addTitle(bg, tr('betterquesting.title.pre_requisites'));
    addBottomButton(bg, tr('gui.back'), () => this.host.back());
    const pre = readPrereqs(q);
    const has = new Set(pre.map((p) => p.id));

    const right = bg.add(new CanvasEmpty(new Transform(Align.HALF_RIGHT, [8, 32, 16, 24])));
    right.add(label(new Transform(Align.TOP_EDGE, [0, 0, 0, -16]), tr('betterquesting.gui.database'), 1));
    const search = right.add(new PanelTextField(new Transform(Align.TOP_EDGE, [0, 16, 8, -32]), this.search));
    search.watermark = 'Search...';
    const db = (this.db = new CanvasQuestDatabase(new Transform(Align.FULL_BOX, [0, 32, 8, 24]), this.doc, (id, i, w) => {
      const add = new PanelButton(new Rect(0, i * 16, 16, 16), { onClick: () => addPrereq(this.doc, this.questId, id), active: !has.has(id) });
      add.setIcon(icon('positive'));
      const del = new PanelButton(new Rect(w - 16, i * 16, 16, 16), { onClick: () => deleteQuests(this.doc, [id]) });
      del.setIcon(icon('trash'));
      return [add, new PanelButton(new Rect(16, i * 16, w - 32, 16), { text: questName(this.doc, id), onClick: () => this.host.show(new QuestScreen(this, id)) }), del];
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

    const left = bg.add(new CanvasEmpty(new Transform(Align.HALF_LEFT, [16, 32, 8, 24])));
    left.add(label(new Transform(Align.TOP_EDGE, [0, 0, 0, -16]), questName(this.doc, this.questId), 1));
    const list = left.add(new CanvasScrolling(new Transform(Align.FULL_BOX, [0, 16, 8, 0])));
    list.scrollY = left.add(new PanelVScrollBar(new Transform(Align.RIGHT_EDGE, [-8, 16, 0, 0])));
    const w = list.transform.w();
    const panels: Panel[] = [];
    pre.forEach((p, i) => {
      const exists = this.doc.db.quests.has(p.id);
      panels.push(new PanelButton(new Rect(0, i * 16, w - 32, 16), {
        text: exists ? questName(this.doc, p.id) : `§c${p.id}`,
        onClick: () => exists && this.host.show(new QuestScreen(this, p.id)),
      }));
      const type = new PanelButton(new Rect(w - 32, i * 16, 16, 16), {
        onClick: () => cyclePrereqType(this.doc, this.questId, p.id),
        tooltip: [tr(`betterquesting.btn.prereq_visbility.${TYPE_TIP[p.type] ?? 'normal'}`)],
      });
      type.setIcon(icon(TYPE_ICON[p.type] ?? TYPE_ICON[0]));
      panels.push(type);
      const rem = new PanelButton(new Rect(w - 16, i * 16, 16, 16), { onClick: () => removePrereq(this.doc, this.questId, p.id) });
      rem.setIcon(icon('negative'));
      panels.push(rem);
    });
    list.addAll(panels);
    addDivider(bg, 32, 24);
  }
}
