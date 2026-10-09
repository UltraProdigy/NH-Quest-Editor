// The questbook's main screen: quest line list, quest map and quest line description
// (betterquesting.client.gui2.GuiQuestLines).

import { Screen } from '../gui/screen.ts';
import { openNeiInventory } from '../nei/inventoryScreen.ts';
import { Transform, Align, Rect, type Panel } from '../gui/core.ts';
import { staticColor, pulseColor } from '../gui/color.ts';
import { tex, col, icon, setShowDependencyArrows, showDependencyArrows } from '../gui/theme.ts';
import {
  PanelButton, PanelTextBox, PanelGeneric, CanvasTextured, CanvasHoverTray, CanvasScrolling, PanelVScrollBar,
  itemTexture,
} from '../gui/widgets.ts';
import { tr } from '../gui/lang.ts';
import { forceMonochrome, setForceMonochrome } from '../gui/text.ts';
import { book, prop, quest as getQuest, line as getLine, shortId, dependantsOf } from '../store.ts';
import { PopContextMenu } from '../gui/popup.ts';
import { stringWidth, stripFormatting } from '../gui/font.ts';
import type { Quest, QuestLine } from '../lib/model.ts';
import { CanvasQuestLine, mapSettings, highlightColor } from './questCanvas.ts';
import { QuestScreen } from './quest.ts';
import { SettingsScreen } from './settings.ts';
import { SearchScreen } from './search.ts';
import { loadPrefs, savePrefs } from '../prefs.ts';

const GRAY = staticColor(0xff444444);
const WHITE = staticColor(0xffffffff);
const mono = (s: string) => (forceMonochrome ? stripFormatting(s) : s);

// Settings kept for the session, like BQ's static fields and config.
const ui = {
  trayLock: loadPrefs().trayLock,
  hideLockedLines: false,
  viewMode: false,
  chapterScroll: 0,
};

export class QuestLinesScreen extends Screen {
  selectedLine: QuestLine | null = null;
  private firstView = true;
  private cvQuest!: CanvasQuestLine;
  private cvFrame!: CanvasHoverTray;
  private cvChapterTray!: CanvasHoverTray;
  private cvDescTray!: CanvasHoverTray;
  private cvLines!: CanvasScrolling;
  private scLines!: PanelVScrollBar;
  private cvDesc!: CanvasScrolling;
  private scDesc!: PanelVScrollBar;
  private txTitle!: PanelTextBox;
  private txCompletion!: PanelTextBox;
  private txGlobal!: PanelTextBox;
  private icoChapter!: PanelGeneric;
  private lineButtons: { btn: PanelButton; line: QuestLine }[] = [];
  private view: { zoom: number; center: [number, number] } | null = null;
  private pendingFocus: string | null = null;

  constructor(parent: Screen | null, lineId?: string, focusQuest?: string) {
    super(parent);
    if (lineId) {
      this.selectedLine = getLine(lineId) ?? null;
      this.firstView = !this.selectedLine;
    }
    if (focusQuest) this.pendingFocus = focusQuest;
  }

  title() {
    return this.selectedLine ? stripFormatting(this.selectedLine.name) : '';
  }

  /** The inventory key (E) opens the inventory with NEI's item panel, as it would in game. */
  key(e: KeyboardEvent) {
    if (!this.popup && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'e') {
      openNeiInventory(this);
      return true;
    }
    return super.key(e);
  }

  route() {
    return this.selectedLine ? `#/line/${shortId(this.selectedLine.id)}` : '#/';
  }

  build() {
    // Keep the map position across rebuilds (window resizes).
    // Keep the viewer's map position across rebuilds (window resizes). A view nobody has moved
    // is fitted again instead, since it was only fitted to the old size.
    this.view =
      this.cvQuest?.questLine && this.cvQuest.userMoved
        ? { zoom: this.cvQuest.zoom.read(), center: this.cvQuest.center() }
        : null;
    const firstQuestView = this.firstView && !this.selectedLine && this.selectFirstLine();
    const preOpen = ui.trayLock || firstQuestView;

    const bg = this.root.add(new CanvasTextured(new Transform(Align.FULL_BOX, [0, 0, 0, 0]), tex('panel_main')));

    // Bottom-left: site settings (where the editor's buttons would be) and search.
    bg.add(
      new PanelButton(Transform.at(Align.BOTTOM_LEFT, 8, -24, 32, 16), {
        icon: icon('gear'),
        tooltip: ['Site settings'],
        onClick: () => this.host.show(new SettingsScreen(this)),
      }),
    );
    bg.add(
      new PanelButton(Transform.at(Align.BOTTOM_LEFT, 8, -40, 32, 16), {
        icon: icon('zoom'),
        tooltip: [tr('betterquesting.gui.search')],
        onClick: () => this.host.show(new SearchScreen(this)),
      }),
    );

    this.txTitle = bg.add(new PanelTextBox(new Transform([0, 0, 0.5, 0], [60, 12, 0, -24]), ''));
    this.txTitle.setColor(col('text_header'));
    this.txCompletion = bg.add(new PanelTextBox(new Transform([0, 0, 0.5, 0], [214, 12, -154, -24]), ''));
    this.txCompletion.setColor(col('text_header'));
    this.icoChapter = bg.add(new PanelGeneric(Transform.at(Align.TOP_LEFT, 40, 8, 16, 16), null));

    this.cvFrame = bg.add(
      new CanvasHoverTray(
        new Transform(Align.FULL_BOX, [40 + 150 + 24, 24, 8, 8]),
        new Transform(Align.FULL_BOX, [40, 24, 8, 8]),
        tex('aux_frame_0'),
      ),
    );
    this.cvFrame.setTrayState(!preOpen, 1);

    const descOpen = false;
    const chapterOpen = firstQuestView || (preOpen && !descOpen);

    // Quest line list.
    this.cvChapterTray = bg.add(
      new CanvasHoverTray(
        new Transform(Align.LEFT_EDGE, [40, 24, -24, 8], -1),
        new Transform(Align.LEFT_EDGE, [40, 24, -40 - 150 - 24, 8], -1),
        tex('panel_inner'),
      ),
    );
    this.cvChapterTray.onOpen = () => {
      this.cvDescTray.setTrayState(false, 200);
      this.cvFrame.setTrayState(false, 200);
      this.buildChapterList();
    };
    this.cvLines = this.cvChapterTray.open.add(new CanvasScrolling(new Transform(Align.FULL_BOX, [8, 20, 16, 8])));
    this.txGlobal = this.cvChapterTray.open.add(new PanelTextBox(new Transform([0, 0, 1, 0], [8, 8, 16, -20]), ''));
    this.txGlobal.setColor(col('text_header'));
    this.scLines = this.cvChapterTray.open.add(new PanelVScrollBar(new Transform(Align.RIGHT_EDGE, [-16, 8, 8, 8])));
    this.cvLines.scrollY = this.scLines;
    const lockBtn: PanelButton = this.cvChapterTray.open.add(
      new PanelButton(Transform.at(Align.TOP_RIGHT, -36, 3, 16, 16, -2), {
        textures: [null, null, null],
        onClick: () => {
          ui.trayLock = !ui.trayLock;
          savePrefs({ ...loadPrefs(), trayLock: ui.trayLock });
          updateLock();
        },
      }),
    );
    const updateLock = () => {
      lockBtn.setIcon(icon(ui.trayLock ? 'locked' : 'unlocked'));
      lockBtn.tooltipLines = [tr('betterquesting.btn.lock_tray'), tr(`betterquesting.tooltip.lock_tray.${ui.trayLock}`)];
    };
    updateLock();

    // Quest line description.
    this.cvDescTray = bg.add(
      new CanvasHoverTray(
        new Transform(Align.LEFT_EDGE, [40, 24, -24, 8], -1),
        new Transform(Align.LEFT_EDGE, [40, 24, -40 - 150 - 24, 8], -1),
        tex('panel_inner'),
      ),
    );
    this.cvDesc = this.cvDescTray.open.add(new CanvasScrolling(new Transform(Align.FULL_BOX, [8, 8, 20, 8])));
    this.scDesc = this.cvDescTray.open.add(new PanelVScrollBar(new Transform(Align.RIGHT_EDGE, [-16, 8, 8, 8])));
    this.cvDesc.scrollY = this.scDesc;
    this.cvDescTray.onOpen = () => {
      this.cvChapterTray.setTrayState(false, 200);
      this.cvFrame.setTrayState(false, 200);
      this.cvDesc.reset();
      if (this.selectedLine) {
        // Lay out at the open width: the tray is still animating (cvDesc has 8+20 padding).
        const t = new PanelTextBox(new Rect(0, 0, this.cvDescTray.openWidth - 28, 0), mono(this.selectedLine.desc), true);
        t.setColor(col('text_aux_0'));
        this.cvDesc.add(t);
        this.scDesc.enabled = this.cvDesc.scrollBounds.rh > 0;
      } else this.scDesc.enabled = false;
    };

    // Left side bar.
    let yOff = 24;
    const side = (o: ConstructorParameters<typeof PanelButton>[1]) => {
      const b = bg.add(new PanelButton(Transform.at(Align.TOP_LEFT, 8, yOff, 32, 16, -2), o));
      yOff += 16;
      return b;
    };
    const btnTray = side({
      onClick: () => {
        this.cvFrame.setTrayState(this.cvChapterTray.isOpen, 200);
        this.cvChapterTray.setTrayState(!this.cvChapterTray.isOpen, 200);
        btnTray.setIcon(icon('quest'));
      },
      tooltip: [tr('betterquesting.title.quest_lines')],
    });
    btnTray.setIcon(
      icon('quest'),
      !this.selectedLine && !chapterOpen ? pulseColor(staticColor(0xffffffff), GRAY, 2, 0) : WHITE,
    );
    side({
      icon: icon('desc'),
      tooltip: [tr('betterquesting.gui.description')],
      onClick: () => {
        this.cvFrame.setTrayState(this.cvDescTray.isOpen, 200);
        this.cvDescTray.setTrayState(!this.cvDescTray.isOpen, 200);
      },
    });
    const claim = side({
      tooltip: [tr('betterquesting.btn.claim_all'), tr('betterquesting.btn.claim_all_detailed')],
      active: false,
    });
    claim.setIcon(icon('chest_all'), GRAY);
    side({
      icon: icon('box_fit'),
      tooltip: [tr('betterquesting.btn.zoom_fit')],
      onClick: () => this.cvQuest.questLine && this.cvQuest.fitToWindow(),
    });
    const toggle = (
      iconKey: string,
      label: string,
      get: () => boolean,
      set: (v: boolean) => void,
      tipKey: (v: boolean) => string,
      grayWhen: boolean,
      after?: () => void,
    ) => {
      const b = side({});
      const update = () => {
        b.setIcon(icon(iconKey), get() === grayWhen ? GRAY : WHITE);
        b.tooltipLines = [tr(label), tr(tipKey(get()))];
      };
      b.onClick = () => {
        set(!get());
        update();
        after?.();
        const p = loadPrefs();
        p.arrows = showDependencyArrows;
        p.implicit = mapSettings.alwaysDrawImplicit;
        p.mono = forceMonochrome;
        savePrefs(p);
      };
      update();
      return b;
    };
    toggle(
      'quest_lines_shown', 'betterquesting.btn.hide_locked_quest_lines',
      () => ui.hideLockedLines, (v) => (ui.hideLockedLines = v),
      (v) => `betterquesting.tooltip.cycle.${v}`, true, () => this.buildChapterList(),
    );
    toggle(
      'view_mode_on', 'betterquesting.btn.view_mode',
      () => ui.viewMode, (v) => (ui.viewMode = v),
      (v) => `betterquesting.tooltip.cycle.${v}`, false,
    );
    toggle(
      'visibility_normal', 'betterquesting.btn.always_draw_implicit',
      () => mapSettings.alwaysDrawImplicit, (v) => (mapSettings.alwaysDrawImplicit = v),
      (v) => `betterquesting.tooltip.cycle.${v}`, false, () => this.refreshContent(),
    );
    toggle(
      'two_way', 'betterquesting.btn.show_dependency_arrows',
      () => showDependencyArrows, (v) => setShowDependencyArrows(v),
      (v) => `betterquesting.tooltip.cycle.${v}`, false,
    );
    toggle(
      'paint', 'betterquesting.btn.force_monochrome',
      () => forceMonochrome, (v) => setForceMonochrome(v),
      (v) => `betterquesting.tooltip.cycle.${!v}`, true, () => this.host.refresh(),
    );

    // The quest map.
    this.cvQuest = new CanvasQuestLine(new Transform(Align.FULL_BOX, [0, 0, 0, 0]));
    this.cvQuest.onOpen = (q) => this.openQuest(q);
    this.cvQuest.onContextMenu = (q, mx, my) => this.questMenu(q, mx, my);
    this.cvFrame.add(this.cvQuest);

    if (this.selectedLine) {
      this.cvQuest.setQuestLine(this.selectedLine);
      if (this.view) {
        this.cvQuest.setZoom(this.view.zoom);
        this.cvQuest.centerAt(...this.view.center);
        this.cvQuest.refreshScrollBounds();
        this.cvQuest.updatePanelScroll();
        this.cvQuest.userMoved = true;
      }
      this.refreshCompletion();
      this.txTitle.setText(mono(this.selectedLine.name));
      this.icoChapter.texture = this.selectedLine.icon ? itemTexture(this.selectedLine.icon) : null;
    }

    this.cvChapterTray.setTrayState(chapterOpen, 1);
    this.cvDescTray.setTrayState(descOpen, 1);
    this.computeGlobalCompletion();
    if (this.cvChapterTray.isOpen) this.buildChapterList();
    this.cvLines.setScrollY(ui.chapterScroll);
    this.cvLines.updatePanelScroll();

    if (this.pendingFocus) {
      const id = this.pendingFocus;
      this.pendingFocus = null;
      this.focusQuest(id);
    }
    this.firstView = false;
  }

  private selectFirstLine() {
    const first = book.lines[0];
    if (!first) return false;
    this.selectedLine = first;
    return true;
  }

  private visibleLines() {
    // The site shows every quest line, as an editor would see them.
    return book.lines;
  }

  private buildChapterList() {
    this.cvLines.reset();
    this.lineButtons = [];
    // Lay out at the open width: when the tray was just opened it is still animating from closed
    // (cvLines has 8+16 padding).
    const listW = this.cvChapterTray.openWidth - 24;
    const panels: Panel[] = [];
    let row = 0;
    for (const l of this.visibleLines()) {
      if (l.icon) panels.push(new PanelGeneric(new Rect(0, row * 16, 16, 16, 0), itemTexture(l.icon)));
      const btn = new PanelButton(new Rect(16, row * 16, listW - 16, 16, 0), {
        text: mono(l.name),
        align: 0,
        active: l !== this.selectedLine,
        onClick: () => this.openQuestLine(l),
      });
      panels.push(btn);
      this.lineButtons.push({ btn, line: l });
      row++;
    }
    this.cvLines.addAll(panels);
    this.cvLines.refreshScrollBounds();
    const viewH = this.cvLines.transform.h();
    const contentH = row * 16;
    const scrollable = contentH > viewH;
    this.scLines.enabled = scrollable;
    if (scrollable) this.scLines.handleSize = Math.max(16, Math.floor((viewH * viewH) / contentH));
  }

  private countable(q: Quest) {
    const vis = prop<string>(q, 'visibility');
    return vis !== 'HIDDEN' && vis !== 'SECRET' && !!prop<number>(q, 'countAsQuest');
  }

  private refreshCompletion() {
    if (!this.selectedLine) return;
    let total = 0;
    for (const [id] of this.selectedLine.quests) {
      const q = getQuest(id);
      if (q && this.countable(q)) total++;
    }
    this.txCompletion.setText(tr('betterquesting.title.completion', 0, total, '0.00'));
  }

  private computeGlobalCompletion() {
    const seen = new Set<string>();
    let total = 0;
    for (const l of this.visibleLines()) {
      for (const [id] of l.quests) {
        if (seen.has(id)) continue;
        seen.add(id);
        const q = getQuest(id);
        if (q && this.countable(q)) total++;
      }
    }
    this.txGlobal.setText(tr('betterquesting.title.completion_total', 0, total, '0.00'));
  }

  openQuestLine(l: QuestLine) {
    this.selectedLine = l;
    for (const e of this.lineButtons) e.btn.active = e.line !== l;
    this.cvQuest.setQuestLine(l);
    this.icoChapter.texture = l.icon ? itemTexture(l.icon) : null;
    this.txTitle.setText(mono(l.name));
    this.refreshCompletion();
    if (!ui.trayLock) {
      this.cvFrame.setTrayState(true, 200);
      this.cvChapterTray.setTrayState(false, 200);
      this.cvQuest.fitToWindow();
    }
    ui.chapterScroll = this.cvLines.getScrollY();
    this.host.notify(this);
  }

  private refreshContent() {
    const zoom = this.cvQuest.zoom.read();
    const sx = this.cvQuest.getScrollX(), sy = this.cvQuest.getScrollY();
    const moved = this.cvQuest.userMoved;
    this.cvQuest.setQuestLine(this.selectedLine);
    this.cvQuest.setZoom(zoom);
    this.cvQuest.setScrollX(sx);
    this.cvQuest.setScrollY(sy);
    this.cvQuest.refreshScrollBounds();
    this.cvQuest.updatePanelScroll();
    this.cvQuest.userMoved = moved;
  }

  /** Right-click menu on a quest (GuiQuestLines' context menu, minus the in-game actions). */
  private questMenu(q: Quest, mx: number, my: number) {
    const close = () => this.closePopup();
    const link = () => `${location.origin}${location.pathname}#/quest/${shortId(q.id)}`;
    const deps = q.pre.map(([id]) => getQuest(id)).filter((x): x is Quest => !!x);
    const dependants = dependantsOf(q.id).map((id) => getQuest(id)).filter((x): x is Quest => !!x);
    const labels = [
      'Copy link',
      tr('betterquesting.btn.copy_quest'),
      tr('betterquesting.btn.view_dependencies') + ' >',
      tr('betterquesting.btn.view_dependants') + ' >',
    ];
    const width = Math.max(...labels.map((l) => stringWidth(l))) + 20;
    const sub = (title: string, list: Quest[]) => {
      const w = Math.max(width, ...list.map((x) => stringWidth(x.name) + 12));
      const m = new PopContextMenu(new Rect(mx, my, w, Math.min((list.length + 1) * 16, 160)), true, close);
      m.addButton('<', null, () => this.openPopup(main()));
      for (const x of list) m.addButton(mono(x.name), null, () => {
        close();
        this.focusQuest(x.id);
      });
      if (!list.length) m.addButton(title, null, null);
      return m;
    };
    const main = () => {
      const m = new PopContextMenu(new Rect(mx, my, width, labels.length * 16), true, close);
      m.addButton(labels[0], null, () => {
        void navigator.clipboard?.writeText(link());
        close();
      });
      m.addButton(labels[1], null, () => {
        void navigator.clipboard?.writeText(q.id);
        close();
      });
      m.addButton(labels[2], null, deps.length ? () => this.openPopup(sub(labels[2], deps)) : null);
      m.addButton(labels[3], null, dependants.length ? () => this.openPopup(sub(labels[3], dependants)) : null);
      return m;
    };
    this.openPopup(main());
  }

  private openQuest(q: Quest) {
    ui.chapterScroll = this.cvLines.getScrollY();
    this.host.show(new QuestScreen(this, q.id));
  }

  /** Open the line containing a quest and highlight it (GuiQuestLines.navigateToQuest). */
  focusQuest(id: string, lineId?: string) {
    const has = (x: QuestLine | null | undefined) => !!x && x.quests.some((p) => p[0] === id);
    const preferred = lineId ? getLine(lineId) : undefined;
    const l =
      (has(preferred) ? preferred : null) ??
      (has(this.selectedLine) ? this.selectedLine : null) ??
      book.lines.find((x) => has(x));
    if (!l) return;
    if (l !== this.selectedLine || !this.cvQuest.questLine) this.openQuestLine(l);
    else {
      this.cvFrame.setTrayState(true, 200);
      this.cvChapterTray.setTrayState(false, 200);
    }
    const b = this.cvQuest.buttonFor(id);
    if (b) {
      b.highlight = highlightColor();
      this.cvQuest.setZoom(2);
      this.cvQuest.centerOn(b);
      this.cvQuest.userMoved = true;
    }
  }

  resumed() {
    this.host.notify(this);
  }
}

