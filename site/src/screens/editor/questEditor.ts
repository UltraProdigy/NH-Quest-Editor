// GuiQuestEditor: a quest's name, description, icon, visibility and logic, with the buttons to
// its task, reward and prerequisite editors, the notification settings and the raw NBT.
// And GuiQuestNotificationSettings: the quest's own completion notification.

import type { Screen } from '../../gui/screen.ts';
import { Transform, Align, Rect, type Panel } from '../../gui/core.ts';
import { PanelButton, PanelTextBox, CanvasScrolling, PanelVScrollBar } from '../../gui/widgets.ts';
import { PanelTextField } from '../../gui/textfield.ts';
import { col } from '../../gui/theme.ts';
import { tr } from '../../gui/lang.ts';
import { CanvasEmpty } from '../../gui/core.ts';
import type { BqObject, BqValue } from '../../lib/bqjson.ts';
import { getProp, setQuestProperty, setQuestTag, newQuestProps, bqProps } from '../../edit/ops.ts';
import { questKey } from '../../edit/document.ts';
import { EditorScreen, addBackground, addTitle, addBottomButton, questTag, label } from './common.ts';
import { TextEditorScreen } from './textEditor.ts';
import { ItemSelectionScreen } from './selection.ts';
import { NbtEditorScreen } from './nbtEditor.ts';
import { TaskEditorScreen } from './taskEditor.ts';
import { PrerequisiteEditorScreen } from './prereqEditor.ts';

export const VISIBILITY = ['HIDDEN', 'SECRET', 'UNLOCKED', 'NORMAL', 'COMPLETED', 'CHAIN', 'ALWAYS'];
export const LOGIC = ['AND', 'NAND', 'OR', 'NOR', 'XOR', 'XNOR'];
export const next = (list: string[], v: string) => list[(list.indexOf(v) + 1) % list.length];

/** A quest's tag as QuestInstance.writeToNBT gives it (no id). */
export function questData(tag: BqObject): BqObject {
  const t = structuredClone(tag);
  delete t['questIDHigh:4'];
  delete t['questIDLow:4'];
  return t;
}

export class QuestEditorScreen extends EditorScreen {
  private flName: PanelTextField | null = null;
  private flDesc: PanelTextField | null = null;

  constructor(parent: Screen | null, public questId: string) {
    super(parent);
  }

  title() {
    return tr('betterquesting.title.edit_quest');
  }
  protected routeSuffix() {
    return '/edit';
  }

  private prop(key: string) {
    return getProp(questTag(this.doc, this.questId), key);
  }

  buildEditor() {
    const q = questTag(this.doc, this.questId);
    if (!q) {
      queueMicrotask(() => this.host.back());
      return;
    }
    const bg = addBackground(this);
    addTitle(bg, tr('betterquesting.title.edit_quest', String(this.prop('name:8') ?? '')));
    addBottomButton(bg, tr('gui.back'), () => {
      this.commit();
      this.host.back();
    });
    const at = (x: number, y: number, w: number, h: number) => Transform.at(Align.MID_CENTER, x, y, w, h);
    bg.add(label(at(-100, -60, 200, 12), tr('betterquesting.gui.name')));
    this.flName = bg.add(new PanelTextField(at(-100, -48, 200, 16), String(this.prop('name:8') ?? '')));
    this.flName.onEnter = () => this.commit();
    bg.add(label(at(-100, -28, 200, 12), tr('betterquesting.gui.description')));
    this.flDesc = bg.add(new PanelTextField(at(-100, -16, 184, 16), String(this.prop('desc:8') ?? '')));
    this.flDesc.onEnter = () => this.commit();

    const btn = (x: number, y: number, w: number, text: string, onClick: () => void) =>
      bg.add(new PanelButton(at(x, y, w, 16), { text, onClick }));
    btn(84, -16, 16, 'Aa', () => {
      this.commit();
      this.host.show(
        new TextEditorScreen(this, String(this.prop('desc:8') ?? ''), (v) => setQuestProperty(this.doc, this.questId, 'desc:8', v, 'Edit quest description'), true),
      );
    });
    btn(-100, 16, 100, tr('betterquesting.btn.tasks'), () => this.host.show(new TaskEditorScreen(this, this.questId, 'tasks')));
    btn(0, 16, 100, tr('betterquesting.btn.rewards'), () => this.host.show(new TaskEditorScreen(this, this.questId, 'rewards')));
    btn(-100, 32, 100, tr('betterquesting.btn.requirements'), () => this.host.show(new PrerequisiteEditorScreen(this, this.questId)));
    btn(0, 32, 100, tr('betterquesting.btn.icon'), () =>
      this.host.show(
        // Nothing picked: setProperty ignores a null value, the icon stays.
        new ItemSelectionScreen(this, this.prop('icon:10') as BqObject | undefined, (v) =>
          v && setQuestProperty(this.doc, this.questId, 'icon:10', v, 'Change quest icon'),
        ),
      ),
    );
    const vis = String(this.prop('visibility:8') ?? 'NORMAL');
    btn(-100, 48, 100, `${tr('betterquesting.btn.show')}: ${vis}`, () =>
      setQuestProperty(this.doc, this.questId, 'visibility:8', next(VISIBILITY, vis), 'Change quest visibility'),
    );
    const logic = String(this.prop('questLogic:8') ?? 'AND');
    btn(0, 48, 100, `${tr('betterquesting.btn.logic')}: ${logic}`, () =>
      setQuestProperty(this.doc, this.questId, 'questLogic:8', next(LOGIC, logic), 'Change prerequisite logic'),
    );
    btn(-100, 64, 200, tr('betterquesting.btn.notification'), () => this.host.show(new NotificationSettingsScreen(this, this.questId)));
    btn(-100, 80, 200, tr('betterquesting.btn.advanced'), () => {
      this.commit();
      const tag = questTag(this.doc, this.questId);
      if (!tag) return;
      this.host.show(new NbtEditorScreen(this, questData(tag), false, (v) => setQuestTag(this.doc, this.questId, v, 'Edit quest (advanced)')));
    });
  }

  /** onMouseClick: the name and description fields are saved when they differ. */
  private commit() {
    const q = this.doc && questTag(this.doc, this.questId);
    if (!q || !this.flName || !this.flDesc) return;
    const name = this.flName.text, desc = this.flDesc.text;
    if (name === String(this.prop('name:8') ?? '') && desc === String(this.prop('desc:8') ?? '')) return;
    this.doc.transact('Edit quest', (tx) => {
      const t = tx.quest(this.questId);
      if (!t) return;
      bqProps(t)['name:8'] = name;
      bqProps(t)['desc:8'] = desc;
      tx.set(questKey(this.questId), t);
    });
  }

  mouseDown(mx: number, my: number, b: number) {
    const r = super.mouseDown(mx, my, b);
    this.commit();
    return r;
  }

  key(e: KeyboardEvent) {
    if (e.key === 'Escape' || e.key === 'Backspace') this.commit();
    return super.key(e);
  }
}

// ---------------------------------------------------------------- notification settings

const DEF = () => tr('betterquesting.notification.default');
const cycle = (cur: string, ...order: string[]) => order[(order.indexOf(cur) + 1) % order.length] ?? order[0];

/** The stepper: past the ends goes back to the default (sentinel), from the default it starts at base. */
const stepF = (cur: number, up: boolean, min: number, max: number, step: number, base: number) => {
  if (cur < 0) return base;
  const v = Math.fround(cur + (up ? step : -step));
  return up ? (v > max ? -1 : v) : v < min ? -1 : v;
};
const stepI = (cur: number, up: boolean, min: number, max: number, step: number, base: number, sentinel: number) => {
  if (cur === sentinel) return base;
  const v = cur + (up ? step : -step);
  return up ? (v > max ? sentinel : v) : v < min ? sentinel : v;
};

const ANIM_KEY: Record<string, string> = {
  fly_in: 'flyin', rise: 'rise', slide: 'slide', zoom: 'zoom', pop: 'pop', spin: 'spin', spin_reverse: 'spinrev',
  bounce: 'bounce', wobble: 'wobble', swing: 'swing', slam: 'slam', tada: 'tada', none: 'none',
};
const EFFECT_KEY: Record<number, string> = { 3: 'hyperspace', 4: 'singularity', 5: 'warp', 6: 'lightspeed' };

/** GuiQuestNotificationSettings (without the preview, which needs the game's notification). */
export class NotificationSettingsScreen extends EditorScreen {
  private v: Record<string, BqValue> = {};

  constructor(parent: Screen | null, private questId: string) {
    super(parent);
  }
  title() {
    return tr('betterquesting.notification.quest.title');
  }
  protected routeSuffix() {
    return '/notification';
  }

  private load() {
    const d = newQuestProps();
    const q = questTag(this.doc, this.questId);
    const keys = [
      'notification_style:8', 'notification_show_icon:8', 'completion_animation:8', 'completion_particle:8', 'notification_title:8',
      'notification_subtitle:8', 'confetti_icon:10', 'notification_title_scale:5', 'notification_subtitle_scale:5',
      'notification_icon_scale:5', 'notification_duration:5', 'notification_fade_in:5', 'notification_fade_out:5',
      'notification_icon_offset_y:3', 'notification_pos_x:3', 'notification_pos_y:3', 'particle_count:3', 'notification_effect:3',
    ];
    for (const k of keys) this.v[k] = structuredClone(getProp(q, k) ?? d[k]);
  }

  /** apply(): every setting written to the quest (one undo step when something changed). */
  private apply() {
    this.doc.transact('Edit quest notification', (tx) => {
      const t = tx.quest(this.questId);
      if (!t) return;
      Object.assign(bqProps(t), structuredClone(this.v));
      tx.set(questKey(this.questId), t);
    });
  }

  buildEditor() {
    // Every change is applied at once, so the quest holds the current settings.
    this.load();
    const v = this.v;
    const s = (k: string) => String(v[k] ?? '');
    const n = (k: string) => Number(v[k] ?? 0);
    const bg = addBackground(this);
    const inner = bg.add(new CanvasEmpty(new Transform(Align.FULL_BOX, [16, 16, 16, 16])));
    inner.add(new PanelTextBox(new Transform([0, 0, 1, 0], [0, 0, 0, -16]), tr('betterquesting.notification.quest.title')).setAlignment(1).setColor(col('text_header')));
    const centerW = 200;
    const cv = inner.add(new CanvasScrolling(new Transform([0.5, 0, 0.5, 1], [-centerW / 2, 20, -centerW / 2, 24])));
    const bar = inner.add(new PanelVScrollBar(new Transform([0.5, 0, 0.5, 1], [centerW / 2 + 16, 20, -centerW / 2 - 24, 24])));
    cv.scrollY = bar;
    const panels: Panel[] = [];
    let y = 0;
    const change = (f: () => void) => () => {
      f();
      this.apply();
      this.host.refresh();
    };
    const addCycle = (labelKey: string, text: string, onClick: () => void) => {
      panels.push(new PanelTextBox(new Rect(0, y + 4, centerW / 2 - 4, 12), tr(labelKey)).setAlignment(2).setColor(col('text_main')));
      panels.push(new PanelButton(new Rect(centerW / 2 + 4, y, centerW / 2 - 4, 16), { text, onClick }));
      y += 20;
    };
    const addNumber = (labelKey: string, text: string, down: () => void, up: () => void) => {
      panels.push(new PanelTextBox(new Rect(0, y + 4, centerW / 2 - 4, 12), tr(labelKey)).setAlignment(2).setColor(col('text_main')));
      panels.push(new PanelTextBox(new Rect(centerW / 2 + 4, y + 4, centerW / 2 - 44, 12), text).setAlignment(1).setColor(col('text_main')));
      panels.push(new PanelButton(new Rect(centerW - 36, y, 16, 16), { text: '-', onClick: change(down) }));
      panels.push(new PanelButton(new Rect(centerW - 16, y, 16, 16), { text: '+', onClick: change(up) }));
      y += 20;
    };
    const style = s('notification_style:8');
    addCycle('betterquesting.notification.style', ['title', 'classic', 'off'].includes(style) ? tr(`betterquesting.notification.style.${style}`) : DEF(),
      change(() => (v['notification_style:8'] = cycle(style, 'default', 'title', 'classic', 'off'))));
    const icon = s('notification_show_icon:8');
    addCycle('betterquesting.notification.showicon', icon === 'yes' ? tr('betterquesting.notification.icon.show') : icon === 'no' ? tr('betterquesting.notification.icon.hide') : DEF(),
      change(() => (v['notification_show_icon:8'] = cycle(icon, 'default', 'yes', 'no'))));
    const anim = s('completion_animation:8');
    addCycle('betterquesting.notification.animate', anim === 'default' ? DEF() : tr(`betterquesting.notification.animate.${ANIM_KEY[anim] ?? anim}`),
      change(() => (v['completion_animation:8'] = cycle(anim, 'default', 'none', 'fly_in', 'rise', 'slide', 'zoom', 'pop', 'spin', 'spin_reverse', 'bounce', 'wobble', 'swing', 'slam', 'tada'))));
    const particle = s('completion_particle:8');
    const pKey: Record<string, string> = { none: 'none', confetti: 'confetti', sparkle: 'sparkle', firework: 'firework', item_confetti: 'item' };
    addCycle('betterquesting.notification.particle', pKey[particle] ? tr(`betterquesting.notification.particle.${pKey[particle]}`) : DEF(),
      change(() => (v['completion_particle:8'] = cycle(particle, 'default', 'none', 'confetti', 'sparkle', 'firework', 'item_confetti'))));
    const eff = n('notification_effect:3');
    addCycle('betterquesting.notification.effect', eff < 0 ? DEF() : tr(`betterquesting.notification.effect.${EFFECT_KEY[eff] ?? 'none'}`),
      change(() => {
        let t = eff >= 6 ? -1 : eff + 1;
        if (t === 1 || t === 2) t = 3;
        v['notification_effect:3'] = t;
      }));
    const textLabel = (x: string) => (x ? x : DEF());
    addCycle('betterquesting.notification.titletext', textLabel(s('notification_title:8')), () =>
      this.host.show(new TextEditorScreen(this, s('notification_title:8'), (t) => {
        v['notification_title:8'] = t ?? '';
        this.apply();
      })));
    addCycle('betterquesting.notification.subtitletext', textLabel(s('notification_subtitle:8')), () =>
      this.host.show(new TextEditorScreen(this, s('notification_subtitle:8'), (t) => {
        v['notification_subtitle:8'] = t ?? '';
        this.apply();
      })));
    addCycle('betterquesting.notification.particle.item', tr('betterquesting.btn.edit'), () =>
      this.host.show(new ItemSelectionScreen(this, v['confetti_icon:10'] as BqObject, (t) => {
        if (t) v['confetti_icon:10'] = t;
        this.apply();
      })));
    const scale = (x: number) => (x < 0 ? DEF() : `${x.toFixed(1)}x`);
    const sec = (x: number) => (x < 0 ? DEF() : `${x.toFixed(1)}s`);
    const int = (x: number, sentinel: number) => (x === sentinel ? DEF() : String(x));
    const f = (k: string, min: number, max: number, step: number, base: number) => [
      () => (v[k] = stepF(n(k), false, min, max, step, base)),
      () => (v[k] = stepF(n(k), true, min, max, step, base)),
    ] as const;
    const i = (k: string, min: number, max: number, step: number, base: number, sentinel: number) => [
      () => (v[k] = stepI(n(k), false, min, max, step, base, sentinel)),
      () => (v[k] = stepI(n(k), true, min, max, step, base, sentinel)),
    ] as const;
    const MIN = -2147483648;
    addNumber('betterquesting.notification.titlescale', scale(n('notification_title_scale:5')), ...f('notification_title_scale:5', 0.5, 8, 0.5, 0.5));
    addNumber('betterquesting.notification.subtitlescale', scale(n('notification_subtitle_scale:5')), ...f('notification_subtitle_scale:5', 0.5, 8, 0.5, 0.5));
    addNumber('betterquesting.notification.duration', sec(n('notification_duration:5')), ...f('notification_duration:5', 1, 15, 0.5, 1));
    addNumber('betterquesting.notification.fadein', sec(n('notification_fade_in:5')), ...f('notification_fade_in:5', 0, 5, 0.5, 0));
    addNumber('betterquesting.notification.fadeout', sec(n('notification_fade_out:5')), ...f('notification_fade_out:5', 0, 5, 0.5, 0));
    addNumber('betterquesting.notification.iconscale', scale(n('notification_icon_scale:5')), ...f('notification_icon_scale:5', 0.5, 8, 0.5, 0.5));
    addNumber('betterquesting.notification.iconoffset', int(n('notification_icon_offset_y:3'), MIN), ...i('notification_icon_offset_y:3', -100, 100, 5, 0, MIN));
    addNumber('betterquesting.notification.posx', int(n('notification_pos_x:3'), MIN), ...i('notification_pos_x:3', -1000, 1000, 5, 0, MIN));
    addNumber('betterquesting.notification.posy', int(n('notification_pos_y:3'), MIN), ...i('notification_pos_y:3', -1000, 1000, 5, 0, MIN));
    addNumber('betterquesting.notification.particlecount', int(n('particle_count:3'), -1), ...i('particle_count:3', 0, 500, 5, 0, -1));
    cv.addAll(panels);
    bar.enabled = cv.scrollBounds.rh > 0;

    const btnW = (centerW - 8) / 3;
    const bottom = (x: number, text: string, onClick: () => void, active = true) =>
      inner.add(new PanelButton(Transform.at([0.5, 1, 0.5, 1], x, -16, btnW, 16), { text, onClick, active }));
    bottom(-centerW / 2, tr('betterquesting.notification.reset'), () => {
      const d = newQuestProps();
      for (const k of Object.keys(v)) v[k] = structuredClone(d[k]);
      this.apply();
      this.host.refresh();
    });
    const prev = bottom(-centerW / 2 + btnW + 4, tr('betterquesting.notification.preview'), () => {}, false);
    prev.tooltipLines = ['The preview plays the notification in game,', 'which the site cannot show.'];
    bottom(-centerW / 2 + (btnW + 4) * 2, tr('betterquesting.notification.done'), () => {
      this.apply();
      this.host.back();
    });
  }
}
