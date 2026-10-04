// A single quest: description, tasks and rewards (betterquesting.client.gui2.GuiQuest).

import { Screen } from '../gui/screen.ts';
import { CanvasEmpty, Rect, Transform, Align, quickAnchor, type GuiRect, type Panel } from '../gui/core.ts';
import { tex, col, icon, line as themeLine, ImageTexture } from '../gui/theme.ts';
import {
  PanelButton, PanelTextBox, PanelGeneric, PanelLine, CanvasTextured, CanvasScrolling, PanelVScrollBar,
} from '../gui/widgets.ts';
import { PopContextMenu } from '../gui/popup.ts';
import { tr } from '../gui/lang.ts';
import { plainText, forceMonochrome } from '../gui/text.ts';
import { stringWidth, stripFormatting } from '../gui/font.ts';
import { quest as getQuest, prop, dependantsOf, isInAnyLine, shortId } from '../store.ts';
import type { Quest } from '../lib/model.ts';
import { taskPanel, rewardPanel, typeName } from './taskPanels.ts';
import { PropertiesScreen } from './properties.ts';

const mono = (s: string) => (forceMonochrome ? stripFormatting(s) : s);
const IMG = /\[img height=([1-9]\d*)\] *(.*?:.*?) *\[\/img\]/g;

// Scroll positions per quest, kept for the session (GuiQuest.scrollsPositions).
const scrolls = new Map<string, { task: number; reward: number; desc: number }>();

export class QuestScreen extends Screen {
  q: Quest | undefined;
  private csTask: CanvasScrolling | null = null;
  private csReward: CanvasScrolling | null = null;
  private csDesc: CanvasScrolling | null = null;

  constructor(parent: Screen | null, public questId: string) {
    super(parent);
    this.q = getQuest(questId);
  }

  title() {
    return this.q ? stripFormatting(this.q.name) : '';
  }
  route() {
    return `#/quest/${shortId(this.questId)}`;
  }

  private pos() {
    let p = scrolls.get(this.questId);
    if (!p) scrolls.set(this.questId, (p = { task: 0, reward: 0, desc: 0 }));
    return p;
  }

  build() {
    const q = this.q;
    if (!q) {
      this.host.back();
      return;
    }
    const bg = this.root.add(new CanvasTextured(new Transform(Align.FULL_BOX, [0, 0, 0, 0]), tex('panel_main')));
    bg.add(new PanelTextBox(new Transform(Align.TOP_EDGE, [0, 16, 0, -32]), mono(q.name)).setAlignment(1).setColor(col('text_header')));

    // The site acts like an editor's view: Back plus a (read-only) properties button.
    bg.add(new PanelButton(Transform.at(Align.BOTTOM_CENTER, -100, -16, 100, 16), { text: tr('gui.back'), onClick: () => this.host.back() }));
    bg.add(
      new PanelButton(Transform.at(Align.BOTTOM_CENTER, 0, -16, 100, 16), {
        text: 'Properties',
        onClick: () => this.host.show(new PropertiesScreen(this, this.questId)),
      }),
    );

    bg.add(
      new PanelButton(Transform.at(Align.TOP_LEFT, 16, 10, 16, 16), {
        icon: icon('copy'),
        tooltip: [tr('betterquesting.btn.copy_description')],
        onClick: () => navigator.clipboard?.writeText(plainText(q.desc, (id) => getQuest(id)?.name ?? null)),
      }),
    );
    let btnOffset = 34;
    const deps = this.dependencies();
    if (deps.length) {
      const b: PanelButton = bg.add(
        new PanelButton(Transform.at(Align.TOP_LEFT, btnOffset, 10, 16, 16), {
          icon: icon('left'),
          tooltip: [tr('betterquesting.btn.view_dependencies')],
          onClick: () => this.depPopup(b.transform, deps),
        }),
      );
      btnOffset += 18;
    }
    const dependants = this.dependants();
    if (dependants.length) {
      const b: PanelButton = bg.add(
        new PanelButton(Transform.at(Align.TOP_LEFT, btnOffset, 10, 16, 16), {
          icon: icon('right'),
          tooltip: [tr('betterquesting.btn.view_dependants')],
          onClick: () => this.depPopup(b.transform, dependants),
        }),
      );
    }

    const cvInner = bg.add(new CanvasEmpty(new Transform(Align.FULL_BOX, [16, 32, 16, 24])));

    if (q.rewards.length > 0) {
      this.descPanel(cvInner, true);
      cvInner.add(new PanelButton(new Transform([0, 1, 0.5, 1], [0, -16, 8, 0]), { text: tr('betterquesting.btn.claim'), active: false }));
      const rectReward = new Transform([0, 0.5, 0.5, 1], [0, 0, 8, 16]);
      rectReward.parent = cvInner.transform;
      this.rewardPanel(cvInner, rectReward, q);
    } else {
      this.descPanel(cvInner, false);
    }
    cvInner.add(new PanelButton(new Transform([0.5, 1, 1, 1], [8, -16, 0, 0]), { text: tr('betterquesting.btn.detect_submit'), active: false }));
    const rectTask = new Transform(Align.HALF_RIGHT, [8, 16, 0, 16]);
    rectTask.parent = cvInner.transform;
    this.taskPanel(cvInner, rectTask, q);

    const ls0 = Transform.at(Align.TOP_CENTER, 0, 0, 0, 0);
    ls0.parent = cvInner.transform;
    const le0 = Transform.at(Align.BOTTOM_CENTER, 0, 0, 0, 0);
    le0.parent = cvInner.transform;
    cvInner.add(new PanelLine(ls0, le0, themeLine('gui_divider'), 1, col('gui_divider'), 1));
  }

  private save() {
    const p = this.pos();
    if (this.csTask) p.task = this.csTask.getScrollY();
    if (this.csReward) p.reward = this.csReward.getScrollY();
    if (this.csDesc) p.desc = this.csDesc.getScrollY();
  }
  mouseUp(mx: number, my: number, b: number) {
    try {
      return super.mouseUp(mx, my, b);
    } finally {
      this.save();
    }
  }
  scroll(mx: number, my: number, d: number) {
    try {
      return super.scroll(mx, my, d);
    } finally {
      this.save();
    }
  }

  private dependencies() {
    return (this.q?.pre ?? [])
      .map(([id]) => getQuest(id))
      .filter((x): x is Quest => !!x && isInAnyLine(x.id));
  }
  private dependants() {
    return dependantsOf(this.questId)
      .map((id) => getQuest(id))
      .filter((x): x is Quest => !!x && isInAnyLine(x.id));
  }

  private depPopup(btn: GuiRect, list: Quest[]) {
    const maxW = Math.max(...list.map((x) => stringWidth(x.name)));
    const popup = new PopContextMenu(
      new Rect(btn.x(), btn.y() + btn.h(), maxW + 12, Math.min(list.length * 16, 160)),
      true,
      () => this.closePopup(),
    );
    for (const x of list) popup.addButton(mono(x.name), null, () => this.navigateTo(x.id));
    this.openPopup(popup);
  }

  /** Go to a quest on the quest map (GuiQuest.navigateToQuest). */
  navigateTo(id: string) {
    this.closePopup();
    this.host.navigateToQuestOnMap(this, id);
  }

  private openQuest(q: Quest) {
    this.host.show(new QuestScreen(this, q.id));
  }

  private descPanel(cvInner: CanvasEmpty, hasReward: boolean) {
    const cs = (this.csDesc = cvInner.add(
      new CanvasScrolling(
        hasReward ? new Transform([0, 0, 0.5, 0.5], [0, 0, 16, 16]) : new Transform(Align.HALF_LEFT, [0, 0, 16, 0]),
      ),
    ));
    const text = this.q!.desc;
    let last = 0;
    let y = 0;
    const panels: Panel[] = [];
    const addText = (s: string) => {
      const t = new PanelTextBox(new Rect(0, y, cs.transform.w(), 0), mono(s), true, true);
      t.setColor(col('text_main'));
      t.init();
      panels.push(t);
      return t.transform.h();
    };
    for (const m of text.matchAll(IMG)) {
      y += addText(text.slice(last, m.index));
      last = m.index! + m[0].length;
      const h = Number(m[1]);
      panels.push(new PanelGeneric(new Rect(0, y + 2, cs.transform.w(), h), new ImageTexture(m[2], true)));
      y += h + 4;
    }
    if (last < text.length && text.slice(last).trim()) addText(text.slice(last));
    cs.addAll(panels);
    const bar = cvInner.add(
      new PanelVScrollBar(
        new Transform(
          hasReward ? quickAnchor(Align.TOP_CENTER, Align.MID_CENTER) : quickAnchor(Align.TOP_CENTER, Align.BOTTOM_CENTER),
          [-16, 0, 8, hasReward ? 16 : 0],
        ),
      ),
    );
    cs.scrollY = bar;
    bar.enabled = cs.scrollBounds.rh > 0;
    cs.setScrollY(this.pos().desc);
    cs.updatePanelScroll();
  }

  private rewardPanel(cvInner: CanvasEmpty, rect: GuiRect, q: Quest) {
    const pn = cvInner.add(new CanvasEmpty(rect));
    const cs = (this.csReward = pn.add(new CanvasScrolling(new Transform(Align.FULL_BOX, [0, 0, 8, 0]))));
    const bar = pn.add(new PanelVScrollBar(new Transform(Align.RIGHT_EDGE, [-8, 0, 0, 0])));
    cs.scrollY = bar;
    let y = 0;
    const panels: Panel[] = [];
    for (const r of q.rewards) {
      const title = new PanelTextBox(Transform.at([0, 0, 0, 0], 0, y, rect.w(), 12), typeName(r.type, 'reward'));
      title.setColor(col('text_header')).setAlignment(1);
      panels.push(title);
      y += 12;
      const gui = rewardPanel(r, Transform.at(Align.FULL_BOX, 0, 0, rect.w(), rect.h(), 111), (x) => this.openQuest(x));
      if (gui) {
        gui.init();
        const wrap = new CanvasEmpty(Transform.at(Align.TOP_LEFT, 0, y, rect.w(), gui.transform.h() - gui.transform.y(), 1));
        wrap.add(gui);
        panels.push(wrap);
        y += wrap.transform.h();
      }
    }
    cs.addAll(panels);
    cs.setScrollY(this.pos().reward);
    cs.updatePanelScroll();
    bar.enabled = cs.scrollBounds.rh > 0;
  }

  private taskPanel(cvInner: CanvasEmpty, rect: GuiRect, q: Quest) {
    const pn = cvInner.add(new CanvasEmpty(rect));
    const cs = (this.csTask = pn.add(new CanvasScrolling(new Transform(Align.FULL_BOX, [0, 0, 8, 0]))));
    const bar = pn.add(new PanelVScrollBar(new Transform(Align.RIGHT_EDGE, [-8, 0, 0, 0])));
    cs.scrollY = bar;
    let y = 0;
    const logic = String(prop(q, 'taskLogic'));
    const panels: Panel[] = [];
    q.tasks.forEach((t, i) => {
      const title = new PanelTextBox(Transform.at([0, 0, 0, 0], 0, y, rect.w(), 12), `${i + 1}. ${typeName(t.type, 'task')}`);
      title.setColor(col('text_header')).setAlignment(1);
      panels.push(title);
      y += 10;
      const gui = taskPanel(t, Transform.at(Align.FULL_BOX, 10, 10, rect.w(), rect.h(), 0));
      if (gui) {
        gui.init();
        const wrap = new CanvasTextured(
          Transform.at(Align.TOP_LEFT, 0, y, rect.w() - 15, gui.transform.h() + 20 - gui.transform.y(), 1),
          tex('panel_main'),
        );
        wrap.add(gui);
        panels.push(wrap);
        y += wrap.transform.h() + 5;
      }
      if (logic === 'OR' && i < q.tasks.length - 1) {
        y += 10;
        panels.push(
          new PanelTextBox(Transform.at([0, 0, 0, 0], 0, y, rect.w(), 12), tr(`betterquesting.gui.logic.${logic.toLowerCase()}`))
            .setColor(col('text_highlight'))
            .setAlignment(1),
        );
        y += 10;
      }
      y += 8;
    });
    cs.addAll(panels);
    cs.setScrollY(this.pos().task);
    cs.updatePanelScroll();
    bar.enabled = cs.scrollBounds.rh > 0;
  }
}
