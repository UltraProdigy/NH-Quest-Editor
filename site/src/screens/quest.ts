// A single quest: description, tasks and rewards (betterquesting.client.gui2.GuiQuest).

import { Screen } from '../gui/screen.ts';
import { openNeiInventory } from '../nei/inventoryScreen.ts';
import { CanvasEmpty, Rect, Transform, Align, quickAnchor, type GuiRect, type Panel } from '../gui/core.ts';
import { tex, col, icon, line as themeLine, ImageTexture } from '../gui/theme.ts';
import {
  PanelButton, PanelTextBox, PanelGeneric, PanelLine, CanvasTextured, CanvasScrolling, PanelVScrollBar,
} from '../gui/widgets.ts';
import { PopContextMenu } from '../gui/popup.ts';
import { tr } from '../gui/lang.ts';
import { texture as loadTexture, whenLoaded, resourceUrl } from '../gui/assets.ts';
import { plainText, forceMonochrome } from '../gui/text.ts';
import { stringWidth, stripFormatting } from '../gui/font.ts';
import { staticColor } from '../gui/color.ts';
import { quest as getQuest, prop, dependantsOf, isInAnyLine, shortId } from '../store.ts';
import type { Quest } from '../lib/model.ts';
import { taskPanel, rewardPanel, typeName } from './taskPanels.ts';
import { PropertiesScreen } from './properties.ts';
import { canEdit } from './editor/common.ts';
import { QuestEditorScreen } from './editor/questEditor.ts';
import { PanelFill } from './questCanvas.ts';
import { reviewHooks, STATUS_COLOR, type QuestArea } from '../review/hooks.ts';

const mono = (s: string) => (forceMonochrome ? stripFormatting(s) : s);
const IMG = /\[img height=([1-9]\d*)\] *(.*?:.*?) *\[\/img\]/g;

/** " - changed" / " - new" / " - removed" after a task or reward title in review mode. */
const changeWord = (m: number | null) =>
  m === null ? '' : m === STATUS_COLOR.added ? ' - new' : m === STATUS_COLOR.removed ? ' - removed' : ' - changed';

/** Review mode: show the description with its changes marked (else the new text). */
let showDescDiff = true;

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
  /** The inventory key (E) opens the inventory with NEI's item panel, as it would in game. */
  key(e: KeyboardEvent) {
    if (!this.popup && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'e') {
      openNeiInventory(this);
      return true;
    }
    if (!this.popup && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'b' && reviewHooks.active()) {
      reviewHooks.toggleBefore();
      return true;
    }
    return super.key(e);
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
    // The questbook may have changed (edit mode): show the quest as it is now.
    this.q = getQuest(this.questId);
    const q = this.q;
    if (!q) {
      this.host.back();
      return;
    }
    const bg = this.root.add(new CanvasTextured(new Transform(Align.FULL_BOX, [0, 0, 0, 0]), tex('panel_main')));
    bg.add(new PanelTextBox(new Transform(Align.TOP_EDGE, [0, 16, 0, -32]), mono(q.name)).setAlignment(1).setColor(col('text_header')));
    const review = reviewHooks.active();
    const mark = (area: QuestArea, index?: number) => (review ? reviewHooks.areaMark(q.id, area, index) : null);
    if (review) {
      // Changes are marked beside the content, never over it: a line under the name and the
      // buttons, a bar beside the description, a tint behind tasks and rewards.
      const whole = reviewHooks.questStatus(q.id);
      const nameMark = mark('name');
      if (nameMark !== null) {
        const w = stringWidth(q.name);
        bg.add(new PanelFill(Transform.at(Align.TOP_CENTER, -Math.ceil(w / 2), 26, w, 2), nameMark));
      }
      const changes = reviewHooks.questTooltip(q.id, undefined, true);
      if (changes.length) {
        bg.add(
          new PanelButton(Transform.at(Align.TOP_RIGHT, -32, 10, 16, 16), {
            icon: icon('notice'),
            iconColor: staticColor(whole ?? STATUS_COLOR.changed),
            tooltip: [...changes, '', `§7Showing ${reviewHooks.showingBefore() ? 'before' : 'after'} the pull request.`, '§7Click or press B to switch.'],
            onClick: () => reviewHooks.toggleBefore(),
          }),
        );
        const which = reviewHooks.showingBefore() ? '§cbefore' : '§2after';
        const what = whole === STATUS_COLOR.added ? '§2new quest§r, ' : whole === STATUS_COLOR.removed ? '§4removed quest§r, ' : '';
        bg.add(new PanelTextBox(Transform.at(Align.TOP_RIGHT, -236, 14, 200, 10), `${what}${which}§r §7(B)`).setAlignment(2).setColor(col('text_main')));
      }
    }

    // The site acts like an editor's view: Back plus a (read-only) properties button, or in edit
    // mode BetterQuesting's Edit button.
    bg.add(new PanelButton(Transform.at(Align.BOTTOM_CENTER, -100, -16, 100, 16), { text: tr('gui.back'), onClick: () => this.host.back() }));
    bg.add(
      new PanelButton(Transform.at(Align.BOTTOM_CENTER, 0, -16, 100, 16), canEdit()
        ? { text: tr('betterquesting.btn.edit'), onClick: () => this.host.show(new QuestEditorScreen(this, this.questId)) }
        : { text: 'Properties', onClick: () => this.host.show(new PropertiesScreen(this, this.questId)) }),
    );
    const propMark = mark('prop');
    if (propMark !== null) bg.add(new PanelFill(Transform.at(Align.BOTTOM_CENTER, 2, -19, 96, 2), propMark));

    bg.add(
      new PanelButton(Transform.at(Align.TOP_LEFT, 16, 10, 16, 16), {
        icon: icon('copy'),
        tooltip: [tr('betterquesting.btn.copy_description')],
        onClick: () => navigator.clipboard?.writeText(plainText(q.desc, (id) => getQuest(id)?.name ?? null)),
      }),
    );
    let btnOffset = 34;
    const deps = this.dependencies();
    const preMark = mark('pre');
    if (deps.length || preMark !== null) {
      const b: PanelButton = bg.add(
        new PanelButton(Transform.at(Align.TOP_LEFT, btnOffset, 10, 16, 16), {
          icon: icon('left'),
          tooltip: [tr('betterquesting.btn.view_dependencies')],
          onClick: () => this.depPopup(b.transform, deps),
          active: deps.length > 0,
        }),
      );
      if (preMark !== null) bg.add(new PanelFill(Transform.at(Align.TOP_LEFT, btnOffset + 2, 27, 12, 2), preMark));
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
      btnOffset += 18;
    }
    // Review mode: the description with its changes marked, or as it is.
    if (review && reviewHooks.descDiff(q.id) !== null) {
      bg.add(
        new PanelButton(Transform.at(Align.TOP_LEFT, btnOffset, 10, 16, 16), {
          icon: icon('desc'),
          iconColor: staticColor(STATUS_COLOR.changed),
          tooltip: [showDescDiff ? 'Showing the description\'s changes' : 'Showing the description as it is', '§7Click to switch'],
          onClick: () => {
            showDescDiff = !showDescDiff;
            this.host.refresh();
          },
        }),
      );
    }

    const cvInner = bg.add(new CanvasEmpty(new Transform(Align.FULL_BOX, [16, 32, 16, 24])));

    // A screen taller than wide (a phone held upright) has no room for two columns: the
    // description and rewards go above, the tasks below, each the full width.
    const stacked = this.width < this.height;
    const hasReward = q.rewards.length > 0;
    this.descPanel(cvInner, hasReward, stacked);
    if (hasReward) {
      cvInner.add(
        new PanelButton(stacked ? new Transform([0, 1, 0.5, 1], [0, -16, 4, 0]) : new Transform([0, 1, 0.5, 1], [0, -16, 8, 0]), {
          text: tr('betterquesting.btn.claim'),
          active: false,
        }),
      );
      const rectReward = stacked ? new Transform([0, 0.3, 1, 0.5], [0, 4, 0, 8]) : new Transform([0, 0.5, 0.5, 1], [0, 0, 8, 16]);
      rectReward.parent = cvInner.transform;
      this.rewardPanel(cvInner, rectReward, q);
    }
    cvInner.add(
      new PanelButton(stacked && hasReward ? new Transform([0.5, 1, 1, 1], [4, -16, 0, 0]) : stacked ? new Transform(Align.BOTTOM_EDGE, [0, -16, 0, 0]) : new Transform([0.5, 1, 1, 1], [8, -16, 0, 0]), {
        text: tr('betterquesting.btn.detect_submit'),
        active: false,
      }),
    );
    const rectTask = stacked ? new Transform(Align.HALF_BOTTOM, [0, 8, 0, 20]) : new Transform(Align.HALF_RIGHT, [8, 16, 0, 16]);
    rectTask.parent = cvInner.transform;
    this.taskPanel(cvInner, rectTask, q);

    const ls0 = Transform.at(stacked ? Align.MID_LEFT : Align.TOP_CENTER, 0, 0, 0, 0);
    ls0.parent = cvInner.transform;
    const le0 = Transform.at(stacked ? Align.MID_RIGHT : Align.BOTTOM_CENTER, 0, 0, 0, 0);
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

  private descPanel(cvInner: CanvasEmpty, hasReward: boolean, stacked: boolean) {
    /** Bottom of the description (a fraction of the height) when stacked above the tasks. */
    const bottom = hasReward ? 0.3 : 0.5;
    const cs = (this.csDesc = cvInner.add(
      new CanvasScrolling(
        stacked
          ? new Transform([0, 0, 1, bottom], [0, 0, 12, 4])
          : hasReward ? new Transform([0, 0, 0.5, 0.5], [0, 0, 16, 16]) : new Transform(Align.HALF_LEFT, [0, 0, 16, 0]),
      ),
    ));
    const diff = showDescDiff && reviewHooks.active() ? reviewHooks.descDiff(this.q!.id) : null;
    const text = diff ?? this.q!.desc;
    const descMark = reviewHooks.active() ? reviewHooks.areaMark(this.q!.id, 'desc') : null;
    if (descMark !== null) {
      // A bar in the margin left of the description.
      cvInner.add(
        new PanelFill(
          stacked
            ? new Transform([0, 0, 0, bottom], [-7, 0, 4, 4])
            : hasReward ? new Transform([0, 0, 0, 0.5], [-7, 0, 4, 16]) : new Transform(Align.LEFT_EDGE, [-7, 0, 4, 0]),
          descMark,
        ),
      );
    }
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
      // addQuestDescImageSegment: a picture too wide for the given height is shrunk to the
      // container's width, and the panel's height follows. Lay out again once it has loaded.
      let h = Number(m[1]);
      const cw = cs.transform.w();
      const img = loadTexture(m[2]);
      if (img) {
        if (cw / img.naturalWidth < h / img.naturalHeight) h = -Math.floor(-(img.naturalHeight * cw) / img.naturalWidth);
      } else whenLoaded(resourceUrl(m[2]), () => this.host.screen === this && this.host.refresh());
      panels.push(new PanelGeneric(new Rect(0, y + 2, cw, h), new ImageTexture(m[2], true)));
      y += h + 2; // 2px above the picture, none below (as in BQ)
    }
    if (last < text.length && text.slice(last).trim()) addText(text.slice(last));
    cs.addAll(panels);
    const bar = cvInner.add(
      new PanelVScrollBar(
        stacked
          ? new Transform([1, 0, 1, bottom], [-8, 0, 0, 4])
          : new Transform(
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
    q.rewards.forEach((r, i) => {
      const top = y;
      const m = reviewHooks.active() ? reviewHooks.areaMark(q.id, 'reward', i) : null;
      const title = new PanelTextBox(Transform.at([0, 0, 0, 0], 0, y, rect.w(), 12), typeName(r.type, 'reward') + changeWord(m));
      title.setColor(m !== null ? staticColor(m) : col('text_header')).setAlignment(1);
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
      if (m !== null) panels.push(new PanelFill(new Rect(0, top, rect.w() - 8, y - top, 2), m, 0x30));
    });
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
      const top = y;
      const m = reviewHooks.active() ? reviewHooks.areaMark(q.id, 'task', i) : null;
      const title = new PanelTextBox(Transform.at([0, 0, 0, 0], 0, y, rect.w(), 12), `${i + 1}. ${typeName(t.type, 'task')}${changeWord(m)}`);
      title.setColor(m !== null ? staticColor(m) : col('text_header')).setAlignment(1);
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
      if (m !== null) {
        // A tint behind the task and a bar in the gap right of its frame.
        panels.push(new PanelFill(new Rect(0, top, rect.w() - 15, y - top - 3, 2), m, 0x30));
        panels.push(new PanelFill(new Rect(rect.w() - 13, top, 3, y - top - 3, 2), m));
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
