// Site settings: theme, GUI scale and how quests are drawn. Not part of BetterQuesting; styled
// like its option screens.

import { Screen } from '../gui/screen.ts';
import { CanvasEmpty, Transform, Align } from '../gui/core.ts';
import { tex, col, themeList, currentTheme, setTheme } from '../gui/theme.ts';
import { PanelButton, PanelTextBox, CanvasTextured } from '../gui/widgets.ts';
import { tr } from '../gui/lang.ts';
import { itemIndexSource, hasItemIndex } from '../gui/items.ts';
import { book, view, type QuestState } from '../store.ts';
import { mapSettings } from './questCanvas.ts';
import { loadPrefs, savePrefs } from '../prefs.ts';

const STATES: [QuestState, string][] = [
  ['UNLOCKED', 'Unlocked'],
  ['LOCKED', 'Locked'],
  ['UNCLAIMED', 'Rewards pending'],
  ['COMPLETED', 'Completed'],
  ['REPEATABLE', 'Repeatable'],
];

export class SettingsScreen extends Screen {
  title() {
    return 'Settings';
  }
  route() {
    return '#/settings';
  }

  build() {
    const prefs = loadPrefs();
    const save = () => savePrefs(prefs);
    const bg = this.root.add(new CanvasTextured(new Transform(Align.FULL_BOX, [0, 0, 0, 0]), tex('panel_main')));
    const inner = bg.add(new CanvasEmpty(new Transform(Align.FULL_BOX, [16, 16, 16, 16])));
    inner.add(new PanelTextBox(new Transform(Align.TOP_EDGE, [0, 0, 0, -16]), '§lSite settings').setAlignment(1).setColor(col('text_header')));

    let y = 24;
    const row = (label: () => string, onClick: (b: PanelButton) => void) => {
      const b = inner.add(new PanelButton(Transform.at(Align.TOP_CENTER, -100, y, 200, 20), { text: label() }));
      b.onClick = () => {
        onClick(b);
        b.text = label();
        save();
      };
      y += 24;
      return b;
    };

    const themes = themeList();
    row(
      () => `Theme: ${themes.find((t) => t.id === currentTheme())?.name ?? currentTheme()}`,
      () => {
        const i = themes.findIndex((t) => t.id === currentTheme());
        const next = themes[(i + 1) % themes.length];
        setTheme(next.id);
        prefs.theme = next.id;
      },
    );
    row(
      () => `GUI scale: ${this.host.scaleSetting === 0 ? `Auto (${this.host.scale})` : this.host.scaleSetting}`,
      () => {
        const max = this.host.maxScale();
        const next = this.host.scaleSetting >= max ? 0 : this.host.scaleSetting + 1;
        this.host.setScale(next);
        prefs.scale = next;
      },
    );
    row(
      () => `Show quests as: ${STATES.find((s) => s[0] === view.state)?.[1]}`,
      () => {
        const i = STATES.findIndex((s) => s[0] === view.state);
        view.state = STATES[(i + 1) % STATES.length][0];
        prefs.state = view.state;
      },
    );
    row(
      () => `Mark hidden quests: ${mapSettings.markHidden ? tr('gui.yes') : tr('gui.no')}`,
      () => {
        mapSettings.markHidden = !mapSettings.markHidden;
        prefs.markHidden = mapSettings.markHidden;
      },
    );

    const src = book.source;
    const game = itemIndexSource();
    const info = [
      `Quests: ${src.repo}${src.commit ? ` @ ${src.commit.slice(0, 7)}` : ''}${src.date ? ` (${src.date.slice(0, 10)})` : ''}`,
      hasItemIndex() ? `Items and icons: ${game?.dailyTag ?? 'unknown build'}` : 'Items and icons: not available yet',
      '',
      '§7Hidden and secret quests are shown to everyone here, marked with an eye.',
      '§7Questbook textures from BetterQuesting (MIT). Minecraft assets belong to Mojang.',
    ].join('\n');
    inner.add(new PanelTextBox(new Transform(Align.FULL_BOX, [0, y + 8, 0, 24]), info).setColor(col('text_main')));

    inner.add(new PanelButton(Transform.at(Align.BOTTOM_CENTER, -100, -16, 200, 16), { text: tr('gui.done'), onClick: () => this.host.back() }));
  }
}
