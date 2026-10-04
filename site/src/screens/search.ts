// Quest search (betterquesting.client.gui2.GuiQuestSearch + CanvasQuestSearch).

import { Screen } from '../gui/screen.ts';
import { CanvasEmpty, Rect, Transform, Align, type Panel } from '../gui/core.ts';
import { tex, col } from '../gui/theme.ts';
import { PanelButton, PanelTextBox, PanelGeneric, CanvasTextured, CanvasScrolling, PanelVScrollBar, itemTexture } from '../gui/widgets.ts';
import { PanelTextField } from '../gui/textfield.ts';
import { tr } from '../gui/lang.ts';
import { stripFormatting } from '../gui/font.ts';
import { itemName } from '../gui/items.ts';
import { book, quest as getQuest } from '../store.ts';
import type { ItemRef } from '../lib/model.ts';
import { PanelButtonQuest } from './questCanvas.ts';
import { QuestScreen } from './quest.ts';

let prevSearch = '';

interface Entry {
  questId: string;
  lineId: string;
  haystack: string;
  taskTexts: string[];
}

let entries: Entry[] | null = null;

function collect(): Entry[] {
  if (entries) return entries;
  entries = [];
  for (const l of book.lines) {
    for (const [id] of l.quests) {
      const q = getQuest(id);
      if (!q) continue;
      const taskTexts: string[] = [];
      for (const t of q.tasks) {
        for (const key of ['requiredItems', 'requiredFluids']) {
          const v = t[key];
          if (Array.isArray(v)) for (const it of v as ItemRef[]) if (it && 'id' in it) taskTexts.push(stripFormatting(itemName(it)));
        }
      }
      entries.push({
        questId: id,
        lineId: l.id,
        haystack: [id.toLowerCase(), q.name.toLowerCase(), stripFormatting(q.name).toLowerCase(), q.desc.toLowerCase()].join('\n'),
        taskTexts,
      });
    }
  }
  return entries;
}

export class SearchScreen extends Screen {
  private results!: CanvasScrolling;
  private timer = 0;

  title() {
    return tr('betterquesting.gui.search');
  }
  route() {
    return prevSearch ? `#/search/${encodeURIComponent(prevSearch)}` : '#/search';
  }

  constructor(parent: Screen | null, query?: string) {
    super(parent);
    if (query !== undefined) prevSearch = query;
  }

  build() {
    const bg = this.root.add(new CanvasTextured(new Transform(Align.FULL_BOX, [0, 0, 0, 0]), tex('panel_main')));
    const inner = bg.add(new CanvasEmpty(new Transform(Align.FULL_BOX, [8, 8, 8, 8])));
    inner.add(new PanelButton(Transform.at(Align.BOTTOM_CENTER, -100, -16, 200, 16), { text: tr('gui.back'), onClick: () => this.host.back() }));
    inner.add(new PanelTextBox(new Transform(Align.TOP_EDGE, [0, 0, 0, -16]), tr('betterquesting.gui.search')).setAlignment(1).setColor(col('text_main')));

    const field = inner.add(new PanelTextField(new Transform(Align.TOP_EDGE, [0, 16, 8, -32]), prevSearch));
    field.watermark = 'Search...';
    field.lockFocus = true;
    this.results = inner.add(new CanvasScrolling(new Transform(Align.FULL_BOX, [0, 32, 8, 24])));
    const bar = inner.add(new PanelVScrollBar(new Transform(Align.RIGHT_EDGE, [-8, 32, 0, 24])));
    this.results.scrollY = bar;
    field.onChange = (s) => {
      prevSearch = s;
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        this.search(s);
        this.host.notify(this);
      }, 120);
    };
    this.search(prevSearch);
    queueMicrotask(() => field.focus());
  }

  private search(query: string) {
    const q = query.toLowerCase();
    const width = this.results.transform.w();
    const panels: Panel[] = [];
    const seen = new Set<string>();
    let i = 0;
    for (const e of collect()) {
      const match = !q || e.haystack.includes(q) || e.taskTexts.some((t) => t.toLowerCase().includes(q));
      if (!match) continue;
      const key = `${e.questId}|${e.lineId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const quest = getQuest(e.questId)!;
      const line = book.lines.find((l) => l.id === e.lineId)!;
      const y = i * 32;
      panels.push(new PanelButton(new Rect(0, y, width, 32), { onClick: () => this.host.navigateToQuestOnMap(this, e.questId, e.lineId) }));
      panels.push(new PanelButtonQuest(new Rect(2, y + 2, 28, 28), quest, () => this.host.show(new QuestScreen(this, e.questId))));
      if (line.icon) panels.push(new PanelGeneric(new Rect(36, y + 2, 14, 14), itemTexture(line.icon)));
      panels.push(new PanelTextBox(new Rect(56, y + 6, width - 56, 16), line.name));
      panels.push(new PanelTextBox(new Rect(36, y + 20, width - 36, 16), quest.name));
      i++;
    }
    this.results.reset();
    this.results.addAll(panels);
    this.results.setScrollY(this.results.scrollBounds.ry);
  }
}
