// Read-only view of a quest's settings: what the in-game editor would let an editor change.

import { Screen } from '../gui/screen.ts';
import { CanvasEmpty, Rect, Transform, Align, type Panel } from '../gui/core.ts';
import { tex, col } from '../gui/theme.ts';
import { PanelButton, PanelTextBox, CanvasTextured, CanvasScrolling, PanelVScrollBar, PanelGeneric, itemTexture } from '../gui/widgets.ts';
import { tr } from '../gui/lang.ts';
import { stripFormatting } from '../gui/font.ts';
import { itemName } from '../gui/items.ts';
import { book, quest as getQuest, linesContaining, shortId, prop } from '../store.ts';
import type { ItemRef } from '../lib/model.ts';
import { QuestScreen } from './quest.ts';

const LABELS: [key: string, label: string][] = [
  ['visibility', 'Visibility'],
  ['questLogic', 'Prerequisite logic'],
  ['taskLogic', 'Task logic'],
  ['isMain', 'Main quest'],
  ['repeatTime', 'Repeat time'],
  ['repeat_relative', 'Repeat from completion'],
  ['autoClaim', 'Auto-claim rewards'],
  ['lockedProgress', 'Progress while locked'],
  ['simultaneous', 'Simultaneous tasks'],
  ['isGlobal', 'Global quest'],
  ['globalShare', 'Global share'],
  ['partySingleReward', 'Single reward per party'],
  ['countAsQuest', 'Counts toward completion'],
  ['isSilent', 'Silent'],
  ['snd_complete', 'Complete sound'],
  ['snd_update', 'Update sound'],
  ['completion_animation', 'Completion animation'],
  ['completion_particle', 'Completion particle'],
  ['particle_count', 'Particle count'],
];

const PREREQ_TYPES = ['Normal', 'Implicit', 'Hidden'];

function fmt(key: string, v: unknown): string {
  if (key === 'repeatTime') {
    const ticks = Number(v);
    if (ticks < 0) return 'Never';
    const s = Math.floor(ticks / 20);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return `${h ? `${h}h ` : ''}${h || m ? `${String(m).padStart(2, '0')}m ` : ''}${String(sec).padStart(2, '0')}s (${ticks} ticks)`;
  }
  if (typeof v === 'number' && /^(is|auto|locked|simultaneous|global|party|count|repeat_relative)/.test(key)) return v ? tr('gui.yes') : tr('gui.no');
  if (v && typeof v === 'object' && 'id' in (v as object)) return stripFormatting(itemName(v as ItemRef));
  if (v === undefined) return '§7(default)';
  return String(v);
}

export class PropertiesScreen extends Screen {
  constructor(parent: Screen | null, public questId: string) {
    super(parent);
  }
  title() {
    const q = getQuest(this.questId);
    return q ? `${stripFormatting(q.name)}: properties` : 'Properties';
  }
  route() {
    return `#/quest/${shortId(this.questId)}/properties`;
  }

  build() {
    const q = getQuest(this.questId);
    if (!q) return;
    const bg = this.root.add(new CanvasTextured(new Transform(Align.FULL_BOX, [0, 0, 0, 0]), tex('panel_main')));
    const inner = bg.add(new CanvasEmpty(new Transform(Align.FULL_BOX, [16, 16, 16, 16])));
    inner.add(new PanelTextBox(new Transform(Align.TOP_EDGE, [0, 0, 0, -16]), q.name).setAlignment(1).setColor(col('text_header')));
    const cs = inner.add(new CanvasScrolling(new Transform(Align.FULL_BOX, [0, 20, 8, 24])));
    const bar = inner.add(new PanelVScrollBar(new Transform(Align.RIGHT_EDGE, [-8, 20, 0, 24])));
    cs.scrollY = bar;
    inner.add(new PanelButton(Transform.at(Align.BOTTOM_CENTER, -100, -16, 200, 16), { text: tr('gui.back'), onClick: () => this.host.back() }));

    const w = cs.transform.w();
    const col1 = Math.min(160, Math.floor(w * 0.45));
    const panels: Panel[] = [];
    let y = 0;
    const text = (x: number, s: string, width: number, color = col('text_main')) => {
      const t = new PanelTextBox(new Rect(x, y, width, 0), s, true);
      t.setColor(color);
      t.init();
      panels.push(t);
      return t.transform.h();
    };
    const heading = (s: string) => {
      y += 4;
      y += text(0, `§l${s}`, w, col('text_header')) + 2;
    };
    const pair = (label: string, value: string) => {
      const h = Math.max(text(0, label, col1 - 4), text(col1, value, w - col1));
      y += h + 1;
    };

    heading('Quest');
    pair('ID', q.id);
    const lines = linesContaining(q.id);
    pair('Quest lines', lines.length ? lines.map((l) => stripFormatting(l.name)).join(', ') : '§7(none)');
    if (q.icon) {
      panels.push(new PanelGeneric(new Rect(col1, y, 16, 16), itemTexture(q.icon)));
      text(col1 + 20, stripFormatting(itemName(q.icon)), w - col1 - 20);
      text(0, 'Icon', col1 - 4);
      y += 18;
    }
    for (const [key, label] of LABELS) pair(label, fmt(key, prop(q, key)));

    heading(`Prerequisites (${q.pre.length})`);
    if (!q.pre.length) pair('', '§7(none)');
    for (const [id, type = 0] of q.pre) {
      const p = getQuest(id);
      const name = p ? p.name : `§c${id} (missing)`;
      const b = new PanelButton(new Rect(0, y, w, 16), {
        text: '',
        onClick: () => p && this.host.show(new QuestScreen(this, id)),
        active: !!p,
      });
      panels.push(b);
      const t = new PanelTextBox(new Rect(4, y + 4, w - 8, 9), `${name}§r  §7${PREREQ_TYPES[type] ?? type}`);
      t.setColor(col('btn_idle'));
      panels.push(t);
      y += 17;
    }

    const notif = Object.keys(q.props).filter((k) => k.startsWith('notification_'));
    if (notif.length) {
      heading('Notification overrides');
      for (const k of notif) pair(k.replace('notification_', ''), String(q.props[k]));
    }
    const extra = Object.keys(q.props).filter((k) => !LABELS.some(([x]) => x === k) && !k.startsWith('notification_'));
    const unknown = extra.filter((k) => !(k in book.defaults));
    if (unknown.length) {
      heading('Other keys');
      for (const k of unknown) pair(k, JSON.stringify(q.props[k]));
    }
    y += 4;
    cs.addAll(panels);
    bar.enabled = cs.scrollBounds.rh > 0;
  }
}
