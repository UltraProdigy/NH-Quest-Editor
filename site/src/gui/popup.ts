// Pop-ups: the context menu (betterquesting.api2.client.gui.popups.PopContextMenu) and the item
// list (PopItemList).

import { CanvasEmpty, Rect, Transform, Align, contains, RectLerp, type Gfx, type Panel } from './core.ts';
import { tex } from './theme.ts';
import { PanelButton, CanvasScrolling, PanelVScrollBar, PanelGeneric, CanvasTextured, PanelTextBox, PanelItemSlot } from './widgets.ts';
import { ColorTexture, col } from './theme.ts';
import { staticColor } from './color.ts';
import type { ItemRef } from '../lib/model.ts';
import type { GuiTexture } from './theme.ts';

interface Entry {
  text: string;
  icon: GuiTexture | null;
  action: (() => void) | null;
}

/** Background that grows from nothing to its size (CanvasResizeable + lerpToRect). */
class GrowingCanvas extends CanvasEmpty {
  lerp: RectLerp;
  target: Rect;
  constructor(target: Rect, public bg: GuiTexture) {
    const lerp = new RectLerp(new Rect(0, 0, 0, 0));
    super(lerp);
    this.lerp = lerp;
    this.target = target;
  }
  init() {
    const p = this.lerp.parent;
    const start = new Rect(0, 0, 0, 0);
    start.parent = p;
    this.lerp.snapTo(start);
    this.target.parent = p;
    this.lerp.lerpTo(this.target, 100);
  }
  draw(gfx: Gfx, mx: number, my: number) {
    const r = this.lerp;
    gfx.clip(r.x(), r.y(), r.w(), r.h());
    this.bg.draw(gfx, r.x(), r.y(), r.w(), r.h());
    super.draw(gfx, mx, my);
    gfx.endClip();
  }
}

export class PopContextMenu extends CanvasEmpty {
  private entries: Entry[] = [];
  constructor(private rect: Rect, private autoClose = true, private close: () => void = () => {}) {
    super(rect);
  }

  addButton(text: string, icon: GuiTexture | null, action: (() => void) | null) {
    this.entries.push({ text, icon, action });
    return this;
  }

  init() {
    this.children = [];
    const listH = Math.min(this.entries.length * 16, this.rect.rh);
    const par = this.rect.parent;
    if (par) {
      // Shift back on screen if hanging off the edge.
      this.rect.rx += Math.min(0, par.x() + par.w() - (this.rect.x() + this.rect.rw));
      this.rect.ry += Math.min(0, par.y() + par.h() - (this.rect.y() + listH));
    }
    const w = this.rect.rw;
    const bg = this.add(new GrowingCanvas(new Rect(0, 0, w - 8, listH), tex('panel_inner')));
    const scroll = bg.add(new CanvasScrolling(new Transform(Align.FULL_BOX, [0, 0, 0, 0])));
    const bar = this.add(new PanelVScrollBar(new Rect(w - 8, 0, 8, listH)));
    scroll.scrollY = bar;
    const panels: Panel[] = [];
    this.entries.forEach((e, i) => {
      if (e.icon) panels.push(new PanelGeneric(new Rect(0, i * 16, 16, 16), e.icon));
      const b = new PanelButton(new Rect(e.icon ? 16 : 0, i * 16, e.icon ? w - 24 : w - 8, 16), {
        text: e.text,
        active: !!e.action,
        onClick: () => e.action?.(),
      });
      panels.push(b);
    });
    scroll.addAll(panels);
    bar.enabled = this.entries.length * 16 > listH;
  }

  mouseDown(mx: number, my: number, b: number) {
    const used = super.mouseDown(mx, my, b);
    if (this.autoClose && !used && !contains(this.rect, mx, my)) {
      this.close();
      return true;
    }
    return used;
  }
}

/**
 * PopItemList: a dimmed screen with a panel of 32 px item slots (as many across as fit in half
 * the screen, scrolling past five and a half rows), a title and a Close button below.
 */
export class PopItemList extends CanvasEmpty {
  constructor(private message: string, private list: ItemRef[], private close: () => void) {
    super(new Transform(Align.FULL_BOX, [0, 0, 0, 0]));
  }

  init() {
    this.children = [];
    const W = this.transform.w(), H = this.transform.h();
    const n = this.list.length;
    this.add(new PanelGeneric(new Transform(Align.FULL_BOX, [0, 0, 0, 0], 1), new ColorTexture(staticColor(0x80000000))));
    const perRow = Math.max(1, Math.min(Math.trunc((W * 0.5) / 36), n));
    const rows = Math.ceil(n / perRow);
    const popH = Math.trunc(Math.min(rows, 5.5) * 36) + 32;
    const popW = Math.max(perRow, 3) * 36 + 20;
    const fw = popW / W, fh = popH / H;
    const box = this.add(
      new CanvasTextured(new Transform([(1 - fw) / 2, (1 - fh) / 2, 1 - (1 - fw) / 2, 1 - (1 - fh) / 2], [0, 0, 0, 0]), tex('panel_main')),
    );
    const cw = box.transform.w(), ch = box.transform.h();
    box.add(new PanelTextBox(new Transform(Align.FULL_BOX, [8, 8, 8, 8]), this.message).setAlignment(1).setColor(col('text_main')));
    const sw = (Math.min(n, perRow) * 36) / cw;
    const scroll = box.add(new CanvasScrolling(new Transform([(1 - sw) / 2, 20 / ch, 1 - (1 - sw) / 2, 0.95], [0, 0, 0, 0])));
    const slots: Panel[] = [];
    const scrollW = scroll.transform.w();
    this.list.forEach((stack, i) => {
      const inRow = Math.min(n - Math.trunc(i / perRow) * perRow, perRow);
      const xOff = Math.trunc(scrollW / 2) - Math.trunc((inRow * 36) / 2);
      slots.push(new PanelItemSlot(new Rect((i % perRow) * 36 + xOff, Math.trunc(i / perRow) * 36, 32, 32, 10), stack));
    });
    scroll.addAll(slots);
    const bottom = 1 - (1 - fh) / 2;
    this.add(
      new PanelButton(Transform.at([0.5, bottom, 0.5, bottom], -Math.trunc(popW / 2), 3, popW, 16), {
        text: 'Close',
        onClick: () => this.close(),
      }),
    );
  }
}
