// Pop-up context menu (betterquesting.api2.client.gui.popups.PopContextMenu).

import { CanvasEmpty, Rect, Transform, Align, contains, RectLerp, type Gfx, type Panel } from './core.ts';
import { tex } from './theme.ts';
import { PanelButton, CanvasScrolling, PanelVScrollBar, PanelGeneric } from './widgets.ts';
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
