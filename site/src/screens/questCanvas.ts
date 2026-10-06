// The quest map: PanelButtonQuest and CanvasQuestLine.

import { type Gfx, Rect, contains, keys, type Tooltip, type Panel } from '../gui/core.ts';
import { type GuiColor, pulseColor, staticColor } from '../gui/color.ts';
import { tex, col, line as themeLine, icon, ImageTexture, type GuiTexture } from '../gui/theme.ts';
import { PanelButton, CanvasScrolling, PanelLine, PanelGeneric, itemTexture, lookupOnKey } from '../gui/widgets.ts';
import { currentVariant } from '../gui/items.ts';
import { tr } from '../gui/lang.ts';
import { quest as getQuest, prop, questState, type QuestState } from '../store.ts';
import type { Quest, QuestLine } from '../lib/model.ts';
import { forceMonochrome } from '../gui/text.ts';
import { stripFormatting } from '../gui/font.ts';

const FRAME: Record<QuestState, number> = { LOCKED: 0, UNLOCKED: 1, UNCLAIMED: 2, COMPLETED: 3, REPEATABLE: 4 };
const ICON_COLOR: Record<QuestState, string> = {
  LOCKED: 'quest_icon_locked',
  UNLOCKED: 'quest_icon_unlocked',
  UNCLAIMED: 'quest_icon_pending',
  COMPLETED: 'quest_icon_complete',
  REPEATABLE: 'quest_icon_repeatable',
};
const LINE: Record<QuestState, [string, string]> = {
  LOCKED: ['quest_locked', 'quest_line_locked'],
  UNLOCKED: ['quest_unlocked', 'quest_line_unlocked'],
  UNCLAIMED: ['quest_pending', 'quest_line_pending'],
  COMPLETED: ['quest_complete', 'quest_line_complete'],
  REPEATABLE: ['quest_repeatable', 'quest_line_repeatable'],
};

const mono = (s: string) => (forceMonochrome ? stripFormatting(s) : s);

/** Settings toggled from the side bar (BQ_Settings equivalents). */
export const mapSettings = {
  alwaysDrawImplicit: false,
  animateArrows: true,
  /** Mark hidden and secret quests, which the game would not show to players. */
  markHidden: true,
};

export class PanelButtonQuest extends PanelButton {
  rect: Rect;
  frame: GuiTexture;
  highlight: GuiColor | null = null;

  constructor(rect: Rect, public q: Quest | null, onOpen?: (q: Quest) => void) {
    super(rect, { onClick: () => q && onOpen?.(q) });
    this.rect = rect;
    const state: QuestState = q ? questState(q) : 'LOCKED';
    const main = q ? !!prop<number>(q, 'isMain') : false;
    this.frame = tex(`quest_${main ? 'main' : 'norm'}_${FRAME[state]}`);
    const color = col(ICON_COLOR[state]);
    const colored: GuiTexture = {
      draw: (gfx, x, y, w, h) => this.frame.draw(gfx, x, y, w, h, this.highlight ?? color),
    };
    this.textures = [colored, colored, colored];
    if (q?.icon) this.setIcon(itemTexture(q.icon), null, 4);
    else this.setIcon(null);
    this.active = true;
    // R and U over a quest look up its icon in NEI (clicking opens the quest).
    lookupOnKey(this, () => (q?.icon ? currentVariant(q.icon) : null));
  }

  draw(gfx: Gfx, mx: number, my: number) {
    super.draw(gfx, mx, my);
    const q = this.q;
    if (q && mapSettings.markHidden) {
      const vis = prop<string>(q, 'visibility');
      if (vis === 'HIDDEN' || vis === 'SECRET') {
        const r = this.transform;
        const s = Math.max(6, Math.floor(r.w() / 3));
        icon('visibility_hidden').draw(gfx, r.x() + r.w() - s, r.y() + r.h() - s, s, s, staticColor(0xffffffff));
      }
    }
  }

  tooltip(mx: number, my: number): Tooltip {
    if (!contains(this.transform, mx, my) || !this.q) return null;
    const q = this.q;
    const lines = [mono(q.name)];
    const state = questState(q);
    if (state === 'COMPLETED' || state === 'UNCLAIMED' || state === 'REPEATABLE') {
      lines.push('§a' + tr('betterquesting.tooltip.complete'));
      if (state === 'UNCLAIMED') lines.push('§7' + tr('betterquesting.tooltip.rewards_pending'));
      else if (state === 'REPEATABLE') lines.push('§7' + tr('betterquesting.tooltip.repeatable'));
    } else if (state === 'LOCKED') {
      lines.push('§c§n' + tr('betterquesting.tooltip.requires') + ' (' + String(prop(q, 'questLogic')).toUpperCase() + ')');
      for (const [id] of q.pre) {
        const p = getQuest(id);
        if (p) lines.push('- ' + mono(p.name));
      }
    } else {
      lines.push('§7' + tr('betterquesting.tooltip.tasks_complete', 0, q.tasks.length));
    }
    const vis = prop<string>(q, 'visibility');
    if (vis === 'HIDDEN' || vis === 'SECRET') lines.push('§8' + (vis === 'HIDDEN' ? 'Hidden quest' : 'Secret quest'));
    return lines;
  }
}

export class CanvasQuestLine extends CanvasScrolling {
  buttons: PanelButtonQuest[] = [];
  questLine: QuestLine | null = null;
  zoomToFitMargin = 24;
  onOpen?: (q: Quest) => void;
  onContextMenu?: (q: Quest, mx: number, my: number) => void;

  constructor(t: import('../gui/core.ts').GuiRect) {
    super(t);
    this.setupAdvanceScroll(true, true, 3000);
  }

  setQuestLine(l: QuestLine | null) {
    this.reset();
    this.userMoved = false;
    this.buttons = [];
    this.questLine = l;
    if (!l) return;
    const panels: Panel[] = [];
    if (l.bgImage) panels.push(new PanelGeneric(new Rect(0, 0, l.bgSize, l.bgSize, 1), new ImageTexture(l.bgImage, false)));

    const byId = new Map<string, PanelButtonQuest>();
    for (const [id, x, y, w, h] of l.quests) {
      const q = getQuest(id) ?? null;
      const b = new PanelButtonQuest(new Rect(x, y, w, h), q, (qq) => this.onOpen?.(qq));
      this.buttons.push(b);
      byId.set(id, b);
    }
    for (const b of byId.values()) {
      const q = b.q;
      if (!q || !q.pre.length) continue;
      const main = !!prop<number>(q, 'isMain');
      const [lineKey, colKey] = LINE[questState(q)];
      for (const [preId, type = 0] of q.pre) {
        const parent = byId.get(preId);
        if (!parent) continue;
        let color: GuiColor = col(colKey);
        let predicate: ((mx: number, my: number) => boolean) | null = null;
        const animate = mapSettings.animateArrows
          ? (mx: number, my: number) => contains(parent.rect, mx, my) || contains(b.rect, mx, my)
          : null;
        if (type === 1) {
          if (!mapSettings.alwaysDrawImplicit) {
            predicate = (mx, my) => contains(parent.rect, mx, my) || contains(b.rect, mx, my) || keys.shift;
            color = pulseColor(color, col('quest_line_implicit_mixin'), 2, 0);
          }
        } else if (type !== 0) continue; // hidden requirement: no line
        panels.push(new PanelLine(parent.rect, b.rect, themeLine(lineKey), main ? 8 : 4, color, 1, predicate, animate));
      }
    }
    panels.push(...this.buttons);
    this.addAll(panels);
    this.fitToWindow();
  }

  fitToWindow() {
    if (!this.buttons.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of this.buttons) {
      minX = Math.min(minX, b.rect.rx);
      minY = Math.min(minY, b.rect.ry);
      maxX = Math.max(maxX, b.rect.rx + b.rect.rw);
      maxY = Math.max(maxY, b.rect.ry + b.rect.rh);
    }
    minX -= this.zoomToFitMargin;
    minY -= this.zoomToFitMargin;
    maxX += this.zoomToFitMargin;
    maxY += this.zoomToFitMargin;
    this.setZoom(Math.min(this.transform.w() / (maxX - minX), this.transform.h() / (maxY - minY)));
    this.refreshScrollBounds();
    const sb = this.scrollBounds;
    this.setScrollX(sb.rx + Math.trunc(sb.rw / 2));
    this.setScrollY(sb.ry + Math.trunc(sb.rh / 2));
    this.updatePanelScroll();
  }

  /** The canvas point at the middle of the view. */
  center(): [number, number] {
    return [this.lsx + Math.trunc(this.window.rw / 2), this.lsy + Math.trunc(this.window.rh / 2)];
  }

  centerAt(cx: number, cy: number) {
    this.setScrollX(cx - Math.trunc(this.window.rw / 2));
    this.setScrollY(cy - Math.trunc(this.window.rh / 2));
  }

  centerOn(b: PanelButtonQuest) {
    const cx = b.rect.rx + Math.trunc(b.rect.rw / 2);
    const cy = b.rect.ry + Math.trunc(b.rect.rh / 2);
    this.setScrollX(cx - Math.trunc(this.window.rw / 2));
    this.setScrollY(cy - Math.trunc(this.window.rh / 2));
  }

  mouseDown(mx: number, my: number, b: number) {
    if (b === 1 && contains(this.transform, mx, my)) {
      const btn = this.buttonAt(mx, my);
      if (btn?.q && this.onContextMenu) {
        this.onContextMenu(btn.q, mx, my);
        return true;
      }
    }
    return super.mouseDown(mx, my, b);
  }

  buttonFor(id: string) {
    return this.buttons.find((b) => b.q?.id === id);
  }

  buttonAt(mx: number, my: number) {
    const [smx, smy] = this.toLocal(mx, my);
    return this.buttons.find((b) => contains(b.rect, smx, smy)) ?? null;
  }
}

export const highlightColor = () =>
  pulseColor(staticColor(0xff000000), staticColor(0xffffbf00), 0.7, 0);
