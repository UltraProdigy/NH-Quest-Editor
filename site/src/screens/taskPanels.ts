// Task and reward panels from bq_standard (bq_standard.client.gui.tasks / .rewards).
// The site has no player, so every task shows zero progress.

import { Rect, Transform, Align, type GuiRect, type Panel } from '../gui/core.ts';
import { staticColor } from '../gui/color.ts';
import { col, icon, colored } from '../gui/theme.ts';
import {
  CanvasMinimum, PanelItemSlot, PanelFluidSlot, PanelTextBox, PanelGeneric, PanelButton, itemTexture,
} from '../gui/widgets.ts';
import { tr } from '../gui/lang.ts';
import { stripFormatting, drawString } from '../gui/font.ts';
import { itemName, fluidName } from '../gui/items.ts';
import type { ItemRef, FluidRef, TaskData, Quest } from '../lib/model.ts';
import { quest as getQuest } from '../store.ts';
import { PanelButtonQuest } from './questCanvas.ts';

const TEXT = () => col('text_main');
const GREEN = '§a', RED = '§c';
const yesNo = (v: unknown) => (v ? RED + tr('gui.yes') : GREEN + tr('gui.no'));

const items = (t: TaskData, key: string) => (Array.isArray(t[key]) ? (t[key] as ItemRef[]) : []);

function itemSlot(rect: GuiRect, stack: ItemRef) {
  return new PanelItemSlot(rect, stack);
}

/** PanelTaskItemBase: a slot and "name (oredict) / 0/n / INCOMPLETE" per item. */
function itemTaskPanel(
  rect: GuiRect,
  list: ItemRef[],
  slotRect: (i: number) => Rect,
  textRect: (i: number, w: number) => Rect,
  extras: (c: CanvasMinimum, w: number) => void,
  extraInfo?: (c: CanvasMinimum, i: number) => void,
) {
  const c = new CanvasMinimum(rect);
  const orig = c.init.bind(c);
  c.init = () => {
    orig();
    const w = c.initialWidth;
    extras(c, w);
    list.forEach((stack, i) => {
      c.add(itemSlot(slotRect(i), stack));
      let text = stripFormatting(itemName(stack));
      if (stack.ore) text += ` (${stack.ore})`;
      text += `\n0/${stack.n}\n${RED}${tr('betterquesting.tooltip.incomplete')}`;
      c.add(new PanelTextBox(textRect(i, w), text).setColor(TEXT()));
      extraInfo?.(c, i);
    });
    c.recalc();
  };
  return c;
}

// Names come from the export (WorldProvider.getDimensionName, as TaskLocation.getDimName); this table
// only covers data built from an older export. BQ shows the bare number for unknown dimensions.
const DIMENSIONS: Record<number, string> = { 0: 'Overworld', [-1]: 'Nether', 1: 'The End', 7: 'Twilight Forest' };
let extraDims: Record<string, string> = {};
let entityNames: Record<string, string> = {};
export function setGameNames(dims: Record<string, string> | undefined, entities: Record<string, string> | undefined) {
  extraDims = dims ?? {};
  entityNames = entities ?? {};
}
const dimName = (d: number) => extraDims[String(d)] ?? DIMENSIONS[d] ?? String(d);
const entityName = (id: string) => entityNames[id] ?? (id.includes('.') ? id.slice(id.indexOf('.') + 1) : id);

export function taskPanel(task: TaskData, rect: GuiRect): Panel | null {
  switch (task.type) {
    case 'bq_standard:retrieval':
    case 'bq_standard:optional_retrieval': {
      const list = items(task, 'requiredItems');
      const onlyOne = !!task.requireOnlyOneItem;
      const h = onlyOne ? 48 : 32;
      return itemTaskPanel(
        rect,
        list,
        (i) => new Rect(0, i * h + 16, 28, 28),
        (i, w) => new Rect(32, i * h + 16, w - 28, 28),
        (c, w) =>
          c.add(
            new PanelTextBox(Transform.at(Align.TOP_EDGE, 0, 0, w, 16), tr('bq_standard.btn.consume', yesNo(task.consume))).setColor(TEXT()),
          ),
        (c, i) => {
          if (!onlyOne || list.length - i <= 1) return;
          c.add(new PanelTextBox(new Rect(0, i * 48 + 50, 28, 18), 'OR').setColor(col('text_highlight')).setAlignment(1));
        },
      );
    }
    case 'bq_standard:crafting': {
      const tick = colored(icon('tick'), staticColor(0xff00ff00));
      const cross = colored(icon('cross'), staticColor(0xffff0000));
      return itemTaskPanel(
        rect,
        items(task, 'requiredItems'),
        (i) => new Rect(0, i * 28 + 24, 28, 28),
        (i, w) => new Rect(36, i * 28 + 24, w - 36, 28),
        (c) => {
          const block = (id: string) => itemTexture({ id, dmg: 0, n: 1 });
          c.add(new PanelGeneric(new Rect(0, 0, 16, 16), block('minecraft:crafting_table')));
          c.add(new PanelGeneric(new Rect(10, 10, 6, 6), task.allowCraft ? tick : cross));
          c.add(new PanelGeneric(new Rect(24, 0, 16, 16), block('minecraft:furnace')));
          c.add(new PanelGeneric(new Rect(34, 10, 6, 6), task.allowSmelt ? tick : cross));
          c.add(new PanelGeneric(new Rect(48, 0, 16, 16), block('minecraft:anvil')));
          c.add(new PanelGeneric(new Rect(58, 10, 6, 6), task.allowAnvil ? tick : cross));
        },
      );
    }
    case 'bq_standard:fluid': {
      const fluids = Array.isArray(task.requiredFluids) ? (task.requiredFluids as FluidRef[]) : [];
      const c = new CanvasMinimum(rect);
      const orig = c.init.bind(c);
      c.init = () => {
        orig();
        const w = c.initialWidth;
        c.add(new PanelTextBox(Transform.at(Align.TOP_EDGE, 0, 0, w, 12), tr('bq_standard.btn.consume', yesNo(task.consume))).setColor(TEXT()));
        fluids.forEach((f, i) => {
          c.add(new PanelFluidSlot(new Rect(0, i * 28 + 12, 28, 28), f));
          const text = `${fluidName(f)}\n0/${f.n}mB\n${RED}${tr('betterquesting.tooltip.incomplete')}`;
          c.add(new PanelTextBox(new Rect(36, i * 28 + 12, w - 36, 28), text).setColor(TEXT()));
        });
        c.recalc();
      };
      return c;
    }
    case 'bq_standard:checkbox': {
      const c = new CanvasMinimum(rect);
      const orig = c.init.bind(c);
      c.init = () => {
        orig();
        const b = new PanelButton(Transform.at(Align.TOP_LEFT, Math.trunc((c.initialWidth - 32) / 2), 0, 32, 32));
        b.setIcon(icon('cross'), staticColor(0xffff0000), 4);
        c.add(b);
        c.recalc();
      };
      return c;
    }
    case 'bq_standard:hunt':
    case 'bq_standard:meeting': {
      const c = new CanvasMinimum(rect);
      const orig = c.init.bind(c);
      c.init = () => {
        orig();
        const w = c.initialWidth;
        const name = entityName(String(task.target ?? ''));
        const text =
          task.type === 'bq_standard:hunt'
            ? `${tr('bq_standard.gui.kill', name)} 0/${task.required ?? 1}`
            : `${tr('bq_standard.gui.meet', name)} x${task.amount ?? 1}`;
        c.add(
          new PanelTextBox(Transform.at(Align.TOP_EDGE, 0, 0, w, task.type === 'bq_standard:hunt' ? 12 : 16), text)
            .setAlignment(1)
            .setColor(TEXT()),
        );
        c.recalc();
      };
      return c;
    }
    case 'bq_standard:location': {
      const c = new CanvasMinimum(rect);
      const orig = c.init.bind(c);
      c.init = () => {
        orig();
        const w = c.initialWidth;
        let desc = tr(String(task.name ?? ''));
        if (!task.hideInfo) {
          desc += ` (${dimName(Number(task.dimension ?? 0))})`;
          if (Number(task.range ?? -1) >= 0) {
            desc += '\n' + tr('bq_standard.gui.location', `(${task.posX}, ${task.posY}, ${task.posZ})`);
            desc += '\n' + tr('bq_standard.gui.distance', '?m');
          }
        }
        desc += '\n§l' + RED + tr('bq_standard.gui.undiscovered');
        const textH = (desc.split('\n').length) * 12;
        c.add(new PanelTextBox(Transform.at(Align.TOP_LEFT, 0, 0, w, textH), desc).setColor(TEXT()));
        const inner = Math.min(Math.min(rect.w(), 128), rect.h() - textH);
        const textColor = TEXT();
        c.add(
          new PanelGeneric(Transform.at(Align.TOP_LEFT, Math.trunc((w - inner) / 2), textH, inner, inner), {
            // The compass: with no player position there is no needle, only "?".
            draw(gfx, x, y, cw, ch) {
              const radius = Math.trunc(cw / 2) - 12;
              const cx = x + Math.trunc(cw / 2), cy = y + Math.trunc(ch / 2);
              gfx.fill(cx - radius, cy - radius, radius * 2, radius * 2, 0xff000000);
              const white = 0xffffffff;
              gfx.line(cx - radius, cy - radius, cx + radius, cy - radius, 4, white);
              gfx.line(cx - radius, cy - radius, cx - radius, cy + radius, 4, white);
              gfx.line(cx + radius, cy + radius, cx + radius, cy - radius, 4, white);
              gfx.line(cx + radius, cy + radius, cx - radius, cy + radius, 4, white);
              const tc = textColor.argb();
              drawString(gfx, '§lN', cx - 4, cy - radius - 9, tc);
              drawString(gfx, '§lS', cx - 4, cy + radius + 2, tc);
              drawString(gfx, '§lE', cx + radius + 2, cy - 4, tc);
              drawString(gfx, '§lW', cx - radius - 8, cy - 4, tc);
              gfx.push();
              gfx.scale(2);
              drawString(gfx, '§l?', Math.trunc(cx / 2) - 4, Math.trunc(cy / 2) - 4, 0xffff0000);
              gfx.pop();
            },
          }),
        );
        c.recalc();
      };
      return c;
    }
    default:
      return null;
  }
}

export function rewardPanel(reward: TaskData, rect: GuiRect, openQuest: (q: Quest) => void): Panel | null {
  switch (reward.type) {
    case 'bq_standard:item':
    case 'bq_standard:choice': {
      const choice = reward.type === 'bq_standard:choice';
      const list = items(reward, choice ? 'choices' : 'rewards');
      const c = new CanvasMinimum(rect);
      const orig = c.init.bind(c);
      c.init = () => {
        orig();
        const w = c.initialWidth;
        const x0 = choice ? 40 : 0;
        if (choice) c.add(new PanelItemSlot(Transform.at(Align.TOP_LEFT, 0, 0, 32, 32), null));
        list.forEach((stack, i) => {
          c.add(new PanelItemSlot(new Rect(x0, i * 18, 18, 18), stack));
          c.add(
            new PanelTextBox(new Rect(x0 + 22, i * 18 + 4, w - 22, 14), `${stack.n} ${stripFormatting(itemName(stack))}`).setColor(TEXT()),
          );
        });
        c.recalc();
      };
      return c;
    }
    case 'bq_standard:questcompletion': {
      const c = new CanvasMinimum(rect);
      const orig = c.init.bind(c);
      c.init = () => {
        orig();
        const w = c.initialWidth;
        const q = getQuest(String(reward.questID ?? '')) ?? null;
        c.add(new PanelButtonQuest(new Rect(0, 0, 18, 18), q, openQuest));
        c.add(new PanelTextBox(Transform.at(Align.TOP_LEFT, 36, 2, w - 36, 16), tr('bq_standard.gui.questcompletion')).setColor(TEXT()));
        c.recalc();
      };
      return c;
    }
    case 'bq_standard:xp': {
      const c = new CanvasMinimum(rect);
      const orig = c.init.bind(c);
      c.init = () => {
        orig();
        const w = c.initialWidth;
        c.add(new PanelGeneric(Transform.at(Align.TOP_LEFT, 0, 0, 32, 32), itemTexture({ id: 'minecraft:experience_bottle', dmg: 0, n: 1 })));
        const amount = Number(reward.amount ?? 0);
        const txt = (amount >= 0 ? `${GREEN}+` : `${RED}-`) + Math.abs(amount) + (reward.isLevels ? 'L' : 'XP');
        c.add(new PanelTextBox(Transform.at(Align.TOP_LEFT, 36, 2, w - 36, 16), tr('bq_standard.gui.experience')).setColor(TEXT()));
        c.add(new PanelTextBox(Transform.at(Align.TOP_LEFT, 40, 16, w - 40, 16), txt).setColor(TEXT()));
        c.recalc();
      };
      return c;
    }
    default:
      return null;
  }
}

/** Translation key for a task/reward type, e.g. "bq_standard:retrieval" -> "bq_standard.task.retrieval". */
export const typeName = (type: string, kind: 'task' | 'reward') => {
  const [domain, name] = type.includes(':') ? type.split(':') : ['bq_standard', type];
  return tr(`${domain}.${kind}.${name}`);
};
