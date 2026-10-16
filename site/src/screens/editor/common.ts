// Shared pieces of the editor screens (betterquesting.client.gui2.editors): the edited database,
// the standard background, title, dividers and the searchable quest database list.

import { Screen } from '../../gui/screen.ts';
import { CanvasEmpty, Transform, Align, Rect, type Panel, type GuiRect } from '../../gui/core.ts';
import { tex, col, line as themeLine } from '../../gui/theme.ts';
import { PanelButton, PanelTextBox, PanelLine, CanvasTextured, CanvasScrolling } from '../../gui/widgets.ts';
import { editing, display } from '../../edit/session.ts';
import type { EditDocument } from '../../edit/document.ts';
import { getProp } from '../../edit/ops.ts';
import type { BqObject } from '../../lib/bqjson.ts';

/** Edit mode is on with the quest files loaded, and the questbook shown is the edited one. */
export const canEdit = () => editing.on && !!editing.doc && !display.override;

export const editDoc = (): EditDocument | null => (canEdit() ? editing.doc : null);

/** A quest's name in the edited database. */
export function questName(doc: EditDocument, id: string): string {
  const q = doc.db.quests.get(id);
  return q ? String(getProp(q, 'name:8') ?? '') : '';
}

export function lineName(doc: EditDocument, id: string): string {
  const l = doc.db.lines.get(id);
  return l ? String(getProp(l.tag, 'name:8') ?? '') : '';
}

export const questTag = (doc: EditDocument, id: string): BqObject | undefined => doc.db.quests.get(id);

/**
 * An editor screen. The edited questbook changes under it (every change rebuilds the screen), and
 * when edit mode goes away it closes.
 */
export abstract class EditorScreen extends Screen {
  doc!: EditDocument;

  build() {
    const d = editDoc();
    if (!d) {
      queueMicrotask(() => this.host.screen === this && this.host.back());
      return;
    }
    this.doc = d;
    this.buildEditor();
  }

  /** Build the panels (initPanel); the database is in this.doc. */
  abstract buildEditor(): void;

  route() {
    return (this.parent?.route() ?? '#/') + this.routeSuffix();
  }
  protected routeSuffix() {
    return '/edit';
  }
}

/** PanelTextBox title at the top (GuiPadding(0, 16, 0, -32)). */
export function addTitle(bg: CanvasEmpty, text: string) {
  return bg.add(new PanelTextBox(new Transform(Align.TOP_EDGE, [0, 16, 0, -32]), text).setAlignment(1).setColor(col('text_header')));
}

/** The panel_main background that fills the screen. */
export const addBackground = (s: Screen) => s.root.add(new CanvasTextured(new Transform(Align.FULL_BOX, [0, 0, 0, 0]), tex('panel_main')));

/** A centred button at the bottom (200 wide, or 100 at an offset). */
export function addBottomButton(bg: CanvasEmpty, text: string, onClick: () => void, x = -100, w = 200) {
  return bg.add(new PanelButton(Transform.at(Align.BOTTOM_CENTER, x, -16, w, 16), { text, onClick }));
}

/** The vertical divider down the middle (TOP_CENTER 0,top to BOTTOM_CENTER 0,-bottom). */
export function addDivider(bg: CanvasEmpty, top = 32, bottom = 24) {
  const a = Transform.at(Align.TOP_CENTER, 0, top, 0, 0);
  a.parent = bg.transform;
  const b = Transform.at(Align.BOTTOM_CENTER, 0, -bottom, 0, 0);
  b.parent = bg.transform;
  bg.add(new PanelLine(a, b, themeLine('gui_divider'), 1, col('gui_divider'), 1));
}

/** A horizontal divider between two points of the background. */
export function addLine(bg: CanvasEmpty, from: GuiRect, to: GuiRect, order = 1) {
  from.parent = bg.transform;
  to.parent = bg.transform;
  bg.add(new PanelLine(from, to, themeLine('gui_divider'), 1, col('gui_divider'), order));
}

/** A label in the main text colour. */
export const label = (t: GuiRect, text: string, align: 0 | 1 | 2 = 0) => new PanelTextBox(t, text).setAlignment(align).setColor(col('text_main'));

/**
 * CanvasQuestDatabase: every quest in the database whose id or name contains the search text,
 * one row each, made by `row`.
 */
export class CanvasQuestDatabase extends CanvasScrolling {
  private search = '';
  private timer = 0;

  constructor(
    t: GuiRect,
    private doc: EditDocument,
    private row: (id: string, index: number, width: number) => Panel[],
  ) {
    super(t);
  }

  init() {
    this.refresh();
  }

  setSearchFilter(s: string) {
    this.search = s.toLowerCase();
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.refresh(), 100);
  }

  refresh() {
    const keep = this.getScrollY();
    const w = this.transform.w();
    const panels: Panel[] = [];
    let i = 0;
    const q = this.search;
    for (const id of this.doc.db.quests.keys()) {
      if (q && !id.toLowerCase().includes(q) && !questName(this.doc, id).toLowerCase().includes(q)) continue;
      panels.push(...this.row(id, i++, w));
    }
    this.reset();
    this.addAll(panels);
    this.setScrollY(keep);
    this.updatePanelScroll();
  }
}

/** A list row button with the quest's name (PanelButtonStorage). */
export const rowButton = (x: number, y: number, w: number, text: string, onClick: () => void, active = true) =>
  new PanelButton(new Rect(x, y, w, 16), { text, onClick, active });
