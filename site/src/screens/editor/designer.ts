// GuiDesigner: a quest line's map with the toolbox (PanelToolController and the main tab's
// tools): open, new, grab, link, copy, scale, delete, remove, icon and frame, with grid snapping
// and box selection (drag; Shift adds, Ctrl takes away, Ctrl + A all, Ctrl + Shift + A none).

import type { Screen } from '../../gui/screen.ts';
import { BasePanel, CanvasEmpty, Rect, Transform, Align, contains, keys, type Gfx, type GuiRect, type Tooltip } from '../../gui/core.ts';
import { PanelButton, PanelGeneric, PanelTextBox, CanvasTextured } from '../../gui/widgets.ts';
import { tex, col, line as themeLine, icon, ColorTexture } from '../../gui/theme.ts';
import { pulseColor, staticColor, type GuiColor } from '../../gui/color.ts';
import { tr } from '../../gui/lang.ts';
import { splitString } from '../../gui/text.ts';
import { line as getLine } from '../../store.ts';
import type { BqObject } from '../../lib/bqjson.ts';
import {
  placeQuests, createQuest, toggleLinks, copyQuests, deleteQuests, removeFromLine, setQuestsProperty, getProp,
  lineWithQuests, setLineWithQuests,
} from '../../edit/ops.ts';
import { CanvasQuestLine, PanelButtonQuest } from '../questCanvas.ts';
import { QuestScreen } from '../quest.ts';
import { EditorScreen, addBottomButton } from './common.ts';
import { NbtEditorScreen } from './nbtEditor.ts';
import { ItemSelectionScreen } from './selection.ts';

// ---------------------------------------------------------------- snapping

/** ToolboxTabMain: grid snap sizes; the index starts at 4 (12). */
const SNAPS = [1, 4, 6, 8, 12, 16, 24, 32];
let snapIdx = 4;
const snap = () => SNAPS[snapIdx % SNAPS.length];
const floorSnap = (v: number, s: number) => v - (((v % s) + s) % s);

/** ToolboxTabMain.drawGrid: minor lines every snap, the major one through 0. */
function drawGrid(gfx: Gfx, ui: CanvasQuestLine) {
  const s = snap();
  if (s <= 1) return;
  const zs = ui.zoom.read();
  const sx = ui.getScrollX(), sy = ui.getScrollY();
  const offX = ((((-sx) % s) + s) % s) * zs, midX = Math.floor(-sx / s);
  const offY = ((((-sy) % s) + s) % s) * zs, midY = Math.floor(-sy / s);
  const t = ui.transform;
  const x = t.x(), y = t.y(), w = t.w(), h = t.h();
  const divX = Math.ceil((w - offX) / (zs * s)), divY = Math.ceil((h - offY) / (zs * s));
  const minor = col('grid_minor'), major = col('grid_major');
  const lMinor = themeLine('grid_minor'), lMajor = themeLine('grid_major');
  const p1 = new Rect(0, 0, 0, 0), p2 = new Rect(0, 0, 0, 0);
  gfx.clip(x, y, w, h);
  p1.ry = y;
  p2.ry = y + h;
  for (let i = 0; i < divX; i++) {
    p1.rx = p2.rx = x + Math.trunc(i * s * zs + offX);
    if (i === midX) lMajor.draw(gfx, p1, p2, 2, major, false);
    else lMinor.draw(gfx, p1, p2, 1, minor, false);
  }
  p1.rx = x;
  p2.rx = x + w;
  for (let j = 0; j < divY; j++) {
    p1.ry = p2.ry = y + Math.trunc(j * s * zs + offY);
    if (j === midY) lMajor.draw(gfx, p1, p2, 2, major, false);
    else lMinor.draw(gfx, p1, p2, 1, minor, false);
  }
  gfx.endClip();
}

/** BoxLine: a rectangle's outline. */
function boxLine(gfx: Gfx, a: { x: number; y: number; w: number; h: number }, width: number, color: GuiColor) {
  const x0 = Math.min(a.x, a.x + a.w), x1 = Math.max(a.x, a.x + a.w), y0 = Math.min(a.y, a.y + a.h), y1 = Math.max(a.y, a.y + a.h);
  const c = color.argb();
  gfx.line(x0, y0, x1, y0, width, c);
  gfx.line(x0, y1, x1, y1, width, c);
  gfx.line(x0, y0, x0, y1, width, c);
  gfx.line(x1, y0, x1, y1, width, c);
}

const SEL_COLOR = pulseColor(staticColor(0xffffffff), staticColor(0xff000000), 2, 0);
const HIGHLIGHT = new ColorTexture(pulseColor(staticColor(0x22ffffff), staticColor(0x77ffffff), 2, 0));

// ---------------------------------------------------------------- tools

interface Tool {
  name: string;
  icon: string;
  /** Things the site cannot do (progress tools): shown, but not usable. */
  disabled?: string;
  init(): void;
  disable(): void;
  drawCanvas(gfx: Gfx, mx: number, my: number): void;
  drawOverlay(gfx: Gfx): void;
  mouseDown(mx: number, my: number, b: number): boolean;
  key(e: KeyboardEvent): boolean;
  tooltip(): string[] | null;
  /** The controller may start box selections. */
  useSelection(): boolean;
}

/** What the tools work with: the canvas, the selection and the database. */
interface ToolContext {
  canvas: () => CanvasQuestLine;
  selected: () => PanelButtonQuest[];
  screen: DesignerScreen;
}

const local = (c: CanvasQuestLine, mx: number, my: number): [number, number] => {
  const zs = c.zoom.read();
  const t = c.transform;
  return [Math.floor((mx - t.x()) / zs + c.lsx), Math.floor((my - t.y()) / zs + c.lsy)];
};

/** The clicked button, or with a selection, the selection when the click is on it. */
function targets(ctx: ToolContext, mx: number, my: number): PanelButtonQuest[] | null {
  const btn = ctx.canvas().buttonAt(mx, my);
  if (!btn?.q) return null;
  const sel = ctx.selected();
  if (sel.length && !sel.includes(btn)) return null;
  return sel.length ? sel : [btn];
}

const base = (name: string, iconKey: string): Tool => ({
  name,
  icon: iconKey,
  init() {},
  disable() {},
  drawCanvas() {},
  drawOverlay() {},
  mouseDown: () => false,
  key: () => false,
  tooltip: () => null,
  useSelection: () => true,
});

function openTool(ctx: ToolContext): Tool {
  return {
    ...base('open', 'cursor'),
    useSelection: () => false,
    mouseDown(mx, my, b) {
      if (b !== 0 || !contains(ctx.canvas().transform, mx, my)) return false;
      const btn = ctx.canvas().buttonAt(mx, my);
      if (!btn?.q) return false;
      ctx.screen.host.show(new QuestScreen(ctx.screen, btn.q.id));
      return true;
    },
  };
}

function newTool(ctx: ToolContext): Tool {
  let ghost: PanelButtonQuest | null = null;
  return {
    ...base('new', 'new'),
    useSelection: () => false,
    init() {
      ghost = new PanelButtonQuest(new Rect(0, 0, 24, 24), null);
    },
    disable() {
      ghost = null;
    },
    drawCanvas(gfx, mx, my) {
      if (!ghost) return;
      const s = snap();
      ghost.rect.rx = floorSnap(mx, s);
      ghost.rect.ry = floorSnap(my, s);
      ghost.draw(gfx, mx, my);
    },
    drawOverlay: (gfx) => drawGrid(gfx, ctx.canvas()),
    tooltip: () => [],
    mouseDown(mx, my, b) {
      if (b !== 0 || !ghost || !contains(ctx.canvas().transform, mx, my)) return false;
      createQuest(ctx.screen.doc, { lineId: ctx.screen.lineId, x: ghost.rect.rx, y: ghost.rect.ry, w: 24, h: 24 });
      return true;
    },
  };
}

interface Grab {
  btn: PanelButtonQuest;
  offX: number;
  offY: number;
}

function grabTool(ctx: ToolContext): Tool {
  let grabs: Grab[] = [];
  const reset = () => {
    for (const g of grabs) {
      const p = ctx.screen.placement(g.btn.q!.id);
      if (p) {
        g.btn.rect.rx = p[0];
        g.btn.rect.ry = p[1];
      }
    }
    grabs = [];
  };
  return {
    ...base('grab', 'grab'),
    useSelection: () => grabs.length === 0,
    init: () => (grabs = []),
    disable: reset,
    drawCanvas(_gfx, mx, my) {
      if (!grabs.length) return;
      const s = Math.max(1, snap());
      const dx = floorSnap(mx, s), dy = floorSnap(my, s);
      for (const g of grabs) {
        g.btn.rect.rx = dx + g.offX;
        g.btn.rect.ry = dy + g.offY;
      }
    },
    drawOverlay: (gfx) => drawGrid(gfx, ctx.canvas()),
    tooltip() {
      if (!grabs.length) return null;
      const g = grabs.find((x) => x.offX === 0 && x.offY === 0);
      return g ? [`X: ${g.btn.rect.rx}`, `Y: ${g.btn.rect.ry}`] : [];
    },
    key: () => grabs.length > 0,
    mouseDown(mx, my, b) {
      if (b === 1 && grabs.length) {
        reset();
        return true;
      }
      if (b !== 0 || !contains(ctx.canvas().transform, mx, my)) return false;
      if (grabs.length) {
        const moves = grabs.map((g) => ({ questId: g.btn.q!.id, x: g.btn.rect.rx, y: g.btn.rect.ry }));
        grabs = [];
        placeQuests(ctx.screen.doc, ctx.screen.lineId, moves, moves.length > 1 ? 'Move quests' : 'Move quest');
        return true;
      }
      const clicked = ctx.canvas().buttonAt(mx, my);
      if (!clicked?.q) return false;
      const sel = ctx.selected();
      if (sel.length) {
        if (!sel.includes(clicked)) return false;
        grabs = sel.map((btn) => ({ btn, offX: btn.rect.rx - clicked.rect.rx, offY: btn.rect.ry - clicked.rect.ry }));
      } else grabs = [{ btn: clicked, offX: 0, offY: 0 }];
      return true;
    },
  };
}

function linkTool(ctx: ToolContext): Tool {
  let linking: PanelButtonQuest[] = [];
  return {
    ...base('link', 'link'),
    useSelection: () => linking.length === 0,
    init: () => (linking = []),
    disable: () => (linking = []),
    drawCanvas(gfx, mx, my) {
      const mouse = new Rect(mx, my, 0, 0);
      for (const b of linking) themeLine('quest_complete').draw(gfx, b.rect, mouse, 2, col('quest_line_complete'), true);
    },
    mouseDown(mx, my, b) {
      if (b === 1 && linking.length) {
        linking = [];
        return true;
      }
      if (b !== 0 || !contains(ctx.canvas().transform, mx, my)) return false;
      const btn = ctx.canvas().buttonAt(mx, my);
      if (!linking.length) {
        if (!btn?.q) return false;
        const sel = ctx.selected();
        if (sel.length) {
          if (!sel.includes(btn)) return false;
          linking = [...sel];
        } else linking = [btn];
        return true;
      }
      if (!btn?.q) return false;
      linking = linking.filter((x) => x !== btn);
      if (!linking.length) return false;
      const from = linking.map((x) => x.q!.id);
      linking = [];
      toggleLinks(ctx.screen.doc, from, btn.q.id);
      return true;
    },
  };
}

function copyTool(ctx: ToolContext): Tool {
  let grabs: Grab[] = [];
  return {
    ...base('copy', 'copy'),
    useSelection: () => grabs.length === 0,
    init: () => (grabs = []),
    disable: () => (grabs = []),
    drawCanvas(gfx, mx, my) {
      if (!grabs.length) return;
      const s = Math.max(1, snap());
      const dx = floorSnap(mx, s), dy = floorSnap(my, s);
      for (const g of grabs) {
        g.btn.rect.rx = dx + g.offX;
        g.btn.rect.ry = dy + g.offY;
        g.btn.draw(gfx, dx, dy);
      }
    },
    drawOverlay: (gfx) => grabs.length > 0 && drawGrid(gfx, ctx.canvas()),
    tooltip: () => (grabs.length ? [] : null),
    key: () => grabs.length > 0,
    mouseDown(mx, my, b) {
      if (b === 1 && grabs.length) {
        grabs = [];
        return true;
      }
      if (b !== 0 || !contains(ctx.canvas().transform, mx, my)) return false;
      if (!grabs.length) {
        const clicked = ctx.canvas().buttonAt(mx, my);
        if (!clicked?.q) return false;
        const sel = ctx.selected();
        if (sel.length && !sel.includes(clicked)) return false;
        const from = sel.length ? sel : [clicked];
        grabs = from.map((btn) => ({
          btn: new PanelButtonQuest(new Rect(btn.rect.rx, btn.rect.ry, btn.rect.rw, btn.rect.rh), btn.q),
          offX: btn.rect.rx - clicked.rect.rx,
          offY: btn.rect.ry - clicked.rect.ry,
        }));
        return true;
      }
      const copies = grabs.map((g) => ({ questId: g.btn.q!.id, x: g.btn.rect.rx, y: g.btn.rect.ry, w: g.btn.rect.rw, h: g.btn.rect.rh }));
      grabs = [];
      copyQuests(ctx.screen.doc, ctx.screen.lineId, copies);
      return true;
    },
  };
}

interface ScaleGrab {
  btn: PanelButtonQuest;
  anchor: [number, number, number, number];
  sx: number;
  sy: number;
}

function scaleTool(ctx: ToolContext): Tool {
  let grabs: ScaleGrab[] = [];
  const bounds = { x: 0, y: 0, w: 0, h: 0 };
  const reset = () => {
    for (const g of grabs) {
      const p = ctx.screen.placement(g.btn.q!.id);
      if (p) [g.btn.rect.rx, g.btn.rect.ry, g.btn.rect.rw, g.btn.rect.rh] = p;
    }
    grabs = [];
  };
  return {
    ...base('scale', 'scale'),
    useSelection: () => grabs.length === 0,
    init: () => (grabs = []),
    disable: reset,
    drawCanvas(gfx, mx, my) {
      if (!grabs.length) return;
      const s = Math.max(1, snap());
      const half = Math.trunc(s / 2);
      const dx = floorSnap(mx + half, s), dy = floorSnap(my + half, s);
      bounds.w = dx - bounds.x;
      bounds.h = dy - bounds.y;
      for (const g of grabs) {
        const r = g.btn.rect;
        r.rw = Math.max(1, Math.round(bounds.w * g.anchor[2]));
        r.rh = Math.max(1, Math.round(bounds.h * g.anchor[3]));
        if (keys.shift) {
          r.rx = g.sx - Math.trunc(r.rw / 2);
          r.ry = g.sy - Math.trunc(r.rh / 2);
        } else {
          r.rx = bounds.x + Math.round(bounds.w * g.anchor[0]);
          r.ry = bounds.y + Math.round(bounds.h * g.anchor[1]);
        }
      }
      if (grabs.length > 1 && !keys.shift) boxLine(gfx, bounds, 2, SEL_COLOR);
    },
    drawOverlay: (gfx) => grabs.length > 0 && drawGrid(gfx, ctx.canvas()),
    tooltip: () => (grabs.length ? [] : null),
    key: () => grabs.length > 0,
    mouseDown(mx, my, b) {
      if (b === 1 && grabs.length) {
        reset();
        return true;
      }
      if (b !== 0 || !contains(ctx.canvas().transform, mx, my)) return false;
      if (grabs.length) {
        const places = grabs.map((g) => ({ questId: g.btn.q!.id, x: g.btn.rect.rx, y: g.btn.rect.ry, w: g.btn.rect.rw, h: g.btn.rect.rh }));
        grabs = [];
        placeQuests(ctx.screen.doc, ctx.screen.lineId, places, places.length > 1 ? 'Scale quests' : 'Scale quest');
        return true;
      }
      const clicked = ctx.canvas().buttonAt(mx, my);
      if (!clicked?.q) return false;
      const sel = ctx.selected();
      const mk = (btn: PanelButtonQuest, anchor: [number, number, number, number]): ScaleGrab => ({
        btn, anchor, sx: btn.rect.rx + Math.trunc(btn.rect.rw / 2), sy: btn.rect.ry + Math.trunc(btn.rect.rh / 2),
      });
      if (sel.length) {
        if (!sel.includes(clicked)) return false;
        let first = true;
        for (const btn of sel) {
          const r = btn.rect;
          if (first) {
            Object.assign(bounds, { x: r.rx, y: r.ry, w: r.rw, h: r.rh });
            first = false;
          } else {
            const x = Math.min(bounds.x, r.rx), y = Math.min(bounds.y, r.ry);
            bounds.w = Math.max(bounds.x + bounds.w, r.rx + r.rw) - x;
            bounds.h = Math.max(bounds.y + bounds.h, r.ry + r.rh) - y;
            bounds.x = x;
            bounds.y = y;
          }
        }
        const f = Math.fround;
        grabs = sel.map((btn) =>
          mk(btn, [
            f((btn.rect.rx - bounds.x) / bounds.w), f((btn.rect.ry - bounds.y) / bounds.h), f(btn.rect.rw / bounds.w), f(btn.rect.rh / bounds.h),
          ]),
        );
      } else {
        Object.assign(bounds, { x: clicked.rect.rx, y: clicked.rect.ry, w: clicked.rect.rw, h: clicked.rect.rh });
        grabs = [mk(clicked, [0, 0, 1, 1])];
      }
      return true;
    },
  };
}

/** Delete, remove, icon and frame: act on the clicked quest or the selection (Enter: the selection). */
function listTool(ctx: ToolContext, name: string, iconKey: string, act: (ids: string[], btns: PanelButtonQuest[]) => void): Tool {
  return {
    ...base(name, iconKey),
    mouseDown(mx, my, b) {
      if (b !== 0 || !contains(ctx.canvas().transform, mx, my)) return false;
      const list = targets(ctx, mx, my);
      if (!list) return false;
      act(list.map((x) => x.q!.id), list);
      return true;
    },
    key(e) {
      const sel = ctx.selected();
      if (!sel.length || e.key !== 'Enter') return false;
      act(sel.map((x) => x.q!.id), sel);
      return true;
    },
  };
}

function progressTool(name: string, iconKey: string): Tool {
  return { ...base(name, iconKey), disabled: 'There are no players on the site, so quest progress cannot be changed.' };
}

// ---------------------------------------------------------------- the controller

/** PanelToolController: lays over the canvas, runs the active tool and the box selection. */
class PanelToolController extends BasePanel {
  selBounds: { x: number; y: number; w: number; h: number } | null = null;

  constructor(t: GuiRect, private screen: DesignerScreen) {
    super(t);
  }

  private get tool() {
    return this.screen.tool;
  }
  private get canvas() {
    return this.screen.canvas;
  }

  draw(gfx: Gfx, mx: number, my: number) {
    const tool = this.tool;
    const c = this.canvas;
    if (!tool || !c) return;
    const [smx, smy] = local(c, mx, my);
    const t = this.transform;
    gfx.clip(t.x(), t.y(), t.w(), t.h());
    gfx.push();
    gfx.translate(t.x() - c.lsx * c.zoom.read(), t.y() - c.lsy * c.zoom.read());
    gfx.ox = Math.round(gfx.ox);
    gfx.oy = Math.round(gfx.oy);
    gfx.scale(c.zoom.read());
    if (this.selBounds) {
      this.selBounds.w = smx - this.selBounds.x;
      this.selBounds.h = smy - this.selBounds.y;
      boxLine(gfx, this.selBounds, 2, SEL_COLOR);
    }
    for (const b of this.screen.selectedButtons()) HIGHLIGHT.draw(gfx, b.rect.x(), b.rect.y(), b.rect.w(), b.rect.h());
    tool.drawCanvas(gfx, smx, smy);
    gfx.pop();
    gfx.endClip();
    tool.drawOverlay(gfx);
  }

  mouseDown(mx: number, my: number, b: number) {
    const tool = this.tool;
    if (!tool || !contains(this.transform, mx, my)) return false;
    if (tool.mouseDown(mx, my, b)) return true;
    if (!tool.useSelection()) return false;
    if (b === 1) {
      this.selBounds = null;
      this.screen.selection = [];
      return true;
    }
    if (b === 0) {
      const [smx, smy] = local(this.canvas!, mx, my);
      this.selBounds = { x: smx, y: smy, w: 0, h: 0 };
      return true;
    }
    return false;
  }

  mouseUp(_mx: number, _my: number, _b: number) {
    const sb = this.selBounds;
    if (!sb) return false;
    this.selBounds = null;
    const x = Math.min(sb.x, sb.x + sb.w), y = Math.min(sb.y, sb.y + sb.h), w = Math.abs(sb.w), h = Math.abs(sb.h);
    const append = keys.shift, subtract = keys.ctrl;
    let sel = append || subtract ? [...this.screen.selection] : [];
    for (const btn of this.canvas!.buttons) {
      if (!btn.q) continue;
      const r = btn.rect;
      const cx = r.rx + Math.trunc(r.rw / 2), cy = r.ry + Math.trunc(r.rh / 2);
      const inBox = cx >= x && cx < x + w && cy >= y && cy < y + h;
      const clickOn = sb.x >= r.rx && sb.x < r.rx + r.rw && sb.y >= r.ry && sb.y < r.ry + r.rh && Math.max(w, h) < 4;
      if (!inBox && !clickOn) continue;
      if (subtract) sel = sel.filter((id) => id !== btn.q!.id);
      else if (!sel.includes(btn.q.id)) sel.push(btn.q.id);
    }
    this.screen.selection = sel;
    return true;
  }

  scroll() {
    return false;
  }

  /** A finger on the canvas uses the tool, as the mouse does; two fingers still pinch the view. */
  touchDrag(mx: number, my: number, pinch = false) {
    return !pinch && this.tool && contains(this.transform, mx, my) ? null : undefined;
  }

  key(e: KeyboardEvent) {
    const tool = this.tool;
    if (!tool) return false;
    if (tool.key(e)) return true;
    if (tool.useSelection() && e.key.toLowerCase() === 'a' && keys.ctrl) {
      this.selBounds = null;
      this.screen.selection = keys.shift ? [] : this.canvas!.buttons.filter((b) => b.q).map((b) => b.q!.id);
      return true;
    }
    return false;
  }

  tooltip(mx: number, my: number): Tooltip {
    if (this.selBounds) return [];
    if (!contains(this.transform, mx, my)) return null;
    return this.tool?.tooltip() ?? null;
  }
}

// ---------------------------------------------------------------- the screen

/** Kept while the designer is open on a line: the active tool, the snap and the view. */
const sessions = new Map<string, { tool: string; view: { zoom: number; sx: number; sy: number } | null; selection: string[] }>();

export class DesignerScreen extends EditorScreen {
  canvas: CanvasQuestLine | null = null;
  tool: Tool | null = null;
  selection: string[] = [];
  private tools: Tool[] = [];
  private view: { zoom: number; sx: number; sy: number } | null = null;

  constructor(parent: Screen | null, public lineId: string) {
    super(parent);
    const s = sessions.get(lineId);
    if (s) {
      this.view = s.view;
      this.selection = s.selection;
    }
    const ctx: ToolContext = { canvas: () => this.canvas!, selected: () => this.selectedButtons(), screen: this };
    this.tools = [
      openTool(ctx),
      newTool(ctx),
      grabTool(ctx),
      linkTool(ctx),
      copyTool(ctx),
      scaleTool(ctx),
      listTool(ctx, 'delete', 'trash', (ids) => deleteQuests(this.doc, ids)),
      listTool(ctx, 'remove', 'negative', (ids) => removeFromLine(this.doc, this.lineId, ids)),
      progressTool('complete', 'tick'),
      progressTool('reset', 'refresh'),
      listTool(ctx, 'icon', 'item', (ids) => {
        const first = this.doc.db.quests.get(ids[0]);
        this.host.show(
          new ItemSelectionScreen(this, getProp(first, 'icon:10') as BqObject | undefined, (v) =>
            v && setQuestsProperty(this.doc, ids, 'icon:10', v, ids.length > 1 ? 'Change quest icons' : 'Change quest icon'),
          ),
        );
      }),
      listTool(ctx, 'frame', 'notice', (ids) => {
        const state = getProp(this.doc.db.quests.get(ids[0]), 'isMain:1') ? 0 : 1;
        setQuestsProperty(this.doc, ids, 'isMain:1', state, 'Change quest frame');
      }),
    ];
    this.setTool(this.tools.find((t) => t.name === (s?.tool ?? 'open')) ?? this.tools[0]);
  }

  title() {
    return tr('betterquesting.btn.designer');
  }
  protected routeSuffix() {
    return '/designer';
  }

  selectedButtons(): PanelButtonQuest[] {
    const c = this.canvas;
    if (!c) return [];
    return this.selection.map((id) => c.buttonFor(id)).filter((b): b is PanelButtonQuest => !!b);
  }

  /** The placement [x, y, w, h] of a quest in the edited line. */
  placement(questId: string): [number, number, number, number] | null {
    const e = this.doc.db.lines.get(this.lineId)?.entries.get(questId);
    return e ? [Number(e['x:3'] ?? 0), Number(e['y:3'] ?? 0), Number(e['sizeX:3'] ?? 24), Number(e['sizeY:3'] ?? 24)] : null;
  }

  setTool(t: Tool) {
    if (t.disabled) return;
    this.tool?.disable();
    this.tool = t;
    t.init();
  }

  private remember() {
    const c = this.canvas;
    if (c && c.questLine) this.view = { zoom: c.zoom.read(), sx: c.getScrollX(), sy: c.getScrollY() };
    sessions.set(this.lineId, { tool: this.tool?.name ?? 'open', view: this.view, selection: this.selection });
  }

  buildEditor() {
    const line = getLine(this.lineId);
    if (!line || !this.doc.db.lines.has(this.lineId)) {
      queueMicrotask(() => this.host.back());
      return;
    }
    if (this.canvas) this.remember();
    // A rebuild (the line changed) puts the tool back to its start, keeping its choice.
    this.tool?.disable();
    this.tool?.init();

    const bg = this.root.add(new CanvasTextured(new Transform(Align.FULL_BOX, [0, 0, 96, 0]), tex('panel_main')));
    const tray = this.root.add(new CanvasTextured(new Transform(Align.RIGHT_EDGE, [-96, 0, 0, 0]), tex('panel_main')));
    addBottomButton(bg, tr('gui.done'), () => {
      this.remember();
      this.tool?.disable();
      this.host.back();
    });
    bg.add(new PanelGeneric(new Transform(Align.FULL_BOX, [16, 16, 16, 16]), tex('aux_frame_0')));
    const c = (this.canvas = bg.add(new CanvasQuestLine(new Transform(Align.FULL_BOX, [16, 16, 16, 16]))));
    c.setQuestLine(line);
    if (this.view) {
      c.setZoom(this.view.zoom);
      c.refreshScrollBounds();
      c.setScrollX(this.view.sx);
      c.setScrollY(this.view.sy);
      c.updatePanelScroll();
    }
    bg.add(new PanelToolController(new Transform(Align.FULL_BOX, [16, 16, 16, 16], -1), this));

    // The tool tray (one tab: Main).
    tray.add(new PanelButton(new Transform([0, 0, 0.5, 0], [16, 32, 0, -40]), { icon: icon('left') }));
    tray.add(new PanelButton(new Transform([0.5, 0, 1, 0], [0, 32, 16, -40]), { icon: icon('right') }));
    tray.add(new PanelTextBox(new Transform(Align.TOP_EDGE, [16, 20, 16, -32]), tr('betterquesting.toolbox.tab.main')).setAlignment(1).setColor(col('text_header')));
    const tab = tray.add(new CanvasEmpty(new Transform(Align.FULL_BOX, [16, 48, 16, 16])));
    const w = tab.transform.w();
    const tip = (key: string) => [tr(`betterquesting.toolbox.tool.${key}.name`), ...splitString('§7' + tr(`betterquesting.toolbox.tool.${key}.desc`), 128)];
    const black = staticColor(0xff000000);
    const snapBtn = tab.add(new PanelButton(new Rect(0, 0, Math.trunc(w / 2), 16), {
      text: String(snap()),
      icon: icon('grid'),
      tooltip: tip('snap'),
      onClick: () => {
        snapIdx = (snapIdx + 1) % SNAPS.length;
        snapBtn.text = String(snap());
      },
    }));
    snapBtn.shadow = false;
    snapBtn.colors = [black, black, black];
    tab.add(new PanelButton(new Rect(Math.trunc(w / 2), 0, Math.trunc(w / 2), 16), {
      icon: icon('props'),
      tooltip: tip('raw'),
      onClick: () => {
        const raw = lineWithQuests(this.doc, this.lineId);
        if (raw) this.host.show(new NbtEditorScreen(this, raw, false, (v) => setLineWithQuests(this.doc, this.lineId, v)));
      },
    }));
    const TOOL_TIP: Record<string, string> = { new: 'new', delete: 'delete', remove: 'remove', complete: 'complete', reset: 'reset' };
    this.tools.forEach((t, i) => {
      const b = tab.add(new PanelButton(new Rect((i % 2) * Math.trunc(w / 2), Math.trunc(i / 2) * 16 + 24, Math.trunc(w / 2), 16), {
        icon: icon(t.icon),
        tooltip: t.disabled ? [...tip(TOOL_TIP[t.name] ?? t.name), '§c' + t.disabled] : tip(TOOL_TIP[t.name] ?? t.name),
        active: !t.disabled && this.tool !== t,
        onClick: () => {
          this.setTool(t);
          this.remember();
          this.host.refresh();
        },
      }));
      if (t.disabled) b.iconColor = staticColor(0xff666666);
    });
    // In game this button also shows the snap size (its text is set from it).
    const fit = tab.add(new PanelButton(new Rect(0, (Math.trunc(this.tools.length / 2) + 1) * 16 + 24, Math.trunc(w / 2), 16), {
      text: String(snap()),
      icon: icon('box_fit'),
      tooltip: [tr('betterquesting.btn.zoom_fit')],
      onClick: () => c.fitToWindow(),
    }));
    fit.shadow = false;
    fit.colors = [black, black, black];
  }

  key(e: KeyboardEvent) {
    // Escape and Backspace leave like Done (the tool lets go first).
    if (e.key === 'Escape') {
      this.remember();
      this.tool?.disable();
    }
    return super.key(e);
  }
}
