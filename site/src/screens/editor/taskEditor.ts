// GuiTaskEditor and GuiRewardEditor: a quest's tasks (or rewards) on the left, every registered
// type on the right to add one. Editing opens the type's own editor (hunt, meeting, scoreboard)
// or the raw NBT editor.

import type { Screen } from '../../gui/screen.ts';
import { Transform, Align, Rect, type Panel } from '../../gui/core.ts';
import { PanelButton, PanelTextBox, CanvasScrolling, PanelVScrollBar, PanelGeneric } from '../../gui/widgets.ts';
import { PanelTextField } from '../../gui/textfield.ts';
import { tex, col } from '../../gui/theme.ts';
import { tr } from '../../gui/lang.ts';
import type { BqObject } from '../../lib/bqjson.ts';
import {
  readEntries, entryType, addEntry, removeEntry, setEntry, TASK_TYPES, REWARD_TYPES, type Kind,
} from '../../edit/ops.ts';
import { EditorScreen, addBackground, addTitle, addBottomButton, addDivider, questTag, label } from './common.ts';
import { NbtEditorScreen } from './nbtEditor.ts';
import { EntitySelectionScreen } from './selection.ts';
import { typeName, entityName } from '../taskPanels.ts';

/** A task's or reward's own data (writeToNBT, without the type and id the storage adds). */
function entryData(e: BqObject): BqObject {
  const t = structuredClone(e);
  delete t['taskID:8'];
  delete t['rewardID:8'];
  delete t['index:3'];
  return t;
}

export class TaskEditorScreen extends EditorScreen {
  private search = '';
  private listScroll = 0;
  private list: CanvasScrolling | null = null;

  constructor(parent: Screen | null, private questId: string, private kind: Kind) {
    super(parent);
  }
  title() {
    return tr(this.kind === 'tasks' ? 'betterquesting.title.edit_tasks' : 'betterquesting.title.edit_rewards');
  }
  protected routeSuffix() {
    return `/${this.kind}`;
  }

  buildEditor() {
    const q = questTag(this.doc, this.questId);
    if (!q) {
      queueMicrotask(() => this.host.back());
      return;
    }
    if (this.list) this.listScroll = this.list.getScrollY();
    const bg = addBackground(this);
    addTitle(bg, this.title());
    addBottomButton(bg, tr('gui.back'), () => this.host.back());

    // The registry: every type, by name.
    const reg = bg.add(new CanvasScrolling(new Transform(Align.HALF_RIGHT, [8, 48, 24, 32])));
    const regBar = bg.add(new PanelVScrollBar(new Transform(Align.RIGHT_EDGE, [-24, 48, 16, 32])));
    reg.scrollY = regBar;
    const field = bg.add(new PanelTextField(new Transform([0.5, 0, 1, 0], [8, 32, 16, -48]), this.search));
    field.watermark = 'Search...';
    const types = Object.keys(this.kind === 'tasks' ? TASK_TYPES : REWARD_TYPES).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
    const fillReg = () => {
      const w = reg.transform.w();
      const q = this.search.toLowerCase();
      reg.reset();
      reg.addAll(
        types
          .filter((t) => t.toLowerCase().includes(q))
          .map((t, i) => new PanelButton(new Rect(0, i * 16, w, 16), { text: t, onClick: () => addEntry(this.doc, this.questId, this.kind, t) })),
      );
    };
    field.onChange = (s) => {
      this.search = s;
      fillReg();
    };
    fillReg();

    // The quest's entries.
    const list = (this.list = bg.add(new CanvasScrolling(new Transform(Align.HALF_LEFT, [16, 32, 16, 32]))));
    const bar = bg.add(new PanelVScrollBar(new Transform([0.5, 0, 0.5, 1], [-16, 32, 8, 32])));
    list.scrollY = bar;
    const w = list.transform.w();
    const panels: Panel[] = [];
    readEntries(q, this.kind).forEach((e, i) => {
      const type = entryType(e, this.kind);
      panels.push(new PanelButton(new Rect(0, i * 16, w - 16, 16), { text: typeName(type, this.kind === 'tasks' ? 'task' : 'reward'), onClick: () => this.edit(i) }));
      panels.push(new PanelButton(new Rect(w - 16, i * 16, 16, 16), { text: '§c§lx', onClick: () => removeEntry(this.doc, this.questId, this.kind, i) }));
    });
    list.addAll(panels);
    list.setScrollY(this.listScroll);
    list.updatePanelScroll();
    addDivider(bg, 32, 32);
  }

  private edit(pos: number) {
    const q = questTag(this.doc, this.questId);
    const e = q && readEntries(q, this.kind)[pos];
    if (!e) return;
    const type = entryType(e, this.kind);
    const save = (data: BqObject) => setEntry(this.doc, this.questId, this.kind, pos, data);
    const data = entryData(e);
    if (this.kind === 'tasks' && (type === 'bq_standard:hunt' || type === 'bq_standard:meeting')) {
      this.host.show(new MobTaskEditorScreen(this, data, type === 'bq_standard:hunt', save));
    } else if (this.kind === 'tasks' && type === 'bq_standard:scoreboard') {
      this.host.show(new ScoreboardTaskEditorScreen(this, data, save));
    } else {
      this.host.show(new NbtEditorScreen(this, data, false, save));
    }
  }
}

/** GuiEditTaskHunt and GuiEditTaskMeeting. */
class MobTaskEditorScreen extends EditorScreen {
  constructor(parent: Screen, private data: BqObject, private hunt: boolean, private save: (d: BqObject) => void) {
    super(parent);
  }
  title() {
    return tr(this.hunt ? 'bq_standard.title.edit_hunt' : 'bq_standard.title.edit_meeting');
  }
  protected routeSuffix() {
    return '/task';
  }
  buildEditor() {
    const d = this.data;
    const bg = addBackground(this);
    bg.add(new PanelTextBox(new Transform(Align.TOP_EDGE, [16, 16, 16, -32]), this.title()).setAlignment(1).setColor(col('text_header')));
    // The game shows the mob turning here; the site names it.
    const target = String(d['target:8'] ?? '');
    bg.add(new PanelGeneric(new Transform(Align.HALF_TOP, [16, 32, 16, 0]), tex('panel_inner')));
    bg.add(
      new PanelTextBox(Transform.at([0.5, 0.25, 0.5, 0.25], -100, 0, 200, 24), `§l${entityName(target)}§r\n§7${target}`).setAlignment(1).setColor(col('text_aux_0')),
    );
    const amountKey = this.hunt ? 'required:3' : 'amount:3';
    bg.add(label(Transform.at(Align.MID_CENTER, -100, 4, 96, 12), tr('bq_standard.gui.amount'), 2));
    const f = bg.add(new PanelTextField(Transform.at(Align.MID_CENTER, 0, 0, 100, 16), String(d[amountKey] ?? 1)));
    f.filter = 'int';
    f.onChange = () => (d[amountKey] = Number(f.value()));
    bg.add(
      new PanelButton(Transform.at(Align.MID_CENTER, -100, 16, 200, 16), {
        text: tr('bq_standard.btn.select_mob'),
        tooltip: ['§7The mob\'s NBT is left empty: the browser cannot', '§7create the entity to read it.'],
        onClick: () =>
          this.host.show(
            new EntitySelectionScreen(this, target || null, (id) => {
              d['target:8'] = id ?? (this.hunt ? 'Zombie' : 'Villager');
              d['targetNBT:10'] = {};
              if (this.hunt) this.save(d);
            }),
          ),
      }),
    );
    bg.add(
      new PanelButton(Transform.at(Align.MID_CENTER, -100, 32, 200, 16), {
        text: tr('betterquesting.btn.advanced'),
        onClick: () => this.host.show(new NbtEditorScreen(this, d, false, null)),
      }),
    );
    addBottomButton(bg, tr(this.hunt ? 'gui.done' : 'gui.back'), () => {
      this.save(d);
      this.host.back();
    });
  }
}

const OPERATIONS: [string, string][] = [
  ['EQUAL', '='], ['LESS_THAN', '<'], ['MORE_THAN', '>'], ['LESS_OR_EQUAL', '<='], ['MORE_OR_EQUAL', '>='], ['NOT', '=/='],
];

/** GuiEditTaskScoreboard. */
class ScoreboardTaskEditorScreen extends EditorScreen {
  constructor(parent: Screen, private data: BqObject, private save: (d: BqObject) => void) {
    super(parent);
  }
  title() {
    return tr('bq_standard.title.edit_scoreboard');
  }
  protected routeSuffix() {
    return '/task';
  }
  buildEditor() {
    const d = this.data;
    const bg = addBackground(this);
    bg.add(new PanelTextBox(new Transform(Align.TOP_EDGE, [16, 16, 16, -32]), this.title()).setAlignment(1).setColor(col('text_header')));
    const at = (x: number, y: number, w: number, h: number) => Transform.at(Align.MID_CENTER, x, y, w, h);
    bg.add(label(at(-100, -28, 50, 12), tr('betterquesting.gui.name')));
    bg.add(label(at(-100, -12, 50, 12), 'ID'));
    const disp = bg.add(new PanelTextField(at(-50, -32, 150, 16), String(d['scoreDisp:8'] ?? '')));
    disp.onChange = (s) => (d['scoreDisp:8'] = s);
    const name = bg.add(new PanelTextField(at(-50, -16, 150, 16), String(d['scoreName:8'] ?? '')));
    name.onChange = (s) => (d['scoreName:8'] = s);
    const op = String(d['operation:8'] ?? 'MORE_OR_EQUAL');
    const opIdx = Math.max(0, OPERATIONS.findIndex(([k]) => k === op));
    const b = bg.add(
      new PanelButton(at(-100, 0, 50, 16), {
        text: OPERATIONS[opIdx][1],
        onClick: () => {
          const i = (OPERATIONS.findIndex(([k]) => k === d['operation:8']) + 1) % OPERATIONS.length;
          d['operation:8'] = OPERATIONS[i][0];
          b.text = OPERATIONS[i][1];
        },
      }),
    );
    const target = bg.add(new PanelTextField(at(-50, 0, 150, 16), String(d['target:3'] ?? 1)));
    target.filter = 'int';
    target.onChange = () => (d['target:3'] = Number(target.value()));
    bg.add(new PanelButton(at(-100, 16, 200, 16), { text: tr('betterquesting.btn.advanced'), onClick: () => this.host.show(new NbtEditorScreen(this, d, false, null)) }));
    addBottomButton(bg, tr('gui.back'), () => {
      this.save(d);
      this.host.back();
    });
  }
}
