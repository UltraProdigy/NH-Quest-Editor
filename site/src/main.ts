import './style.css';
import { Host, type Screen } from './gui/screen.ts';
import { loadFont } from './gui/font.ts';
import { loadLang, tr } from './gui/lang.ts';
import { registerThemes, setTheme, setShowDependencyArrows, type ThemeJson } from './gui/theme.ts';
import { loadItems } from './gui/items.ts';
import { fetchJson, resourceUrl, siteUrl } from './gui/assets.ts';
import { textLinks, itemLookup } from './gui/widgets.ts';
import { openLookup, RecipeScreen, type RecipeMode } from './nei/recipeScreen.ts';
import { splitString, plainText, setForceMonochrome } from './gui/text.ts';
import { loadQuestbook, quest as getQuest, fullId, linesContaining, view, type QuestState } from './store.ts';
import { QuestLinesScreen } from './screens/questLines.ts';
import { QuestScreen } from './screens/quest.ts';
import { SearchScreen } from './screens/search.ts';
import { SettingsScreen } from './screens/settings.ts';
import { PropertiesScreen } from './screens/properties.ts';
import { mapSettings } from './screens/questCanvas.ts';
import { setGameNames } from './screens/taskPanels.ts';
import { loadPrefs } from './prefs.ts';

const SITE_TITLE = 'GTNH Questbook';
const canvas = document.getElementById('gui') as HTMLCanvasElement;
const status = document.getElementById('status')!;

async function start() {
  const [, , themes] = await Promise.all([
    loadFont(),
    loadLang(['betterquesting', 'bq_standard']),
    fetchJson<ThemeJson[]>(resourceUrl('betterquesting:bq_themes.json')),
    loadQuestbook(),
    loadItems(),
  ]);
  registerThemes(themes);
  // Themes shipped with the modpack (config/betterquesting/resources), copied in by the data build.
  try {
    const extra = await fetchJson<ThemeJson[]>(siteUrl('data/themes.json'));
    registerThemes(extra);
  } catch {
    // none
  }
  try {
    const names = await fetchJson<{ dimensions?: Record<string, string>; entities?: Record<string, string> }>(siteUrl('data/names.json'));
    setGameNames(names.dimensions, names.entities);
  } catch {
    // none
  }

  const prefs = loadPrefs();
  setTheme(prefs.theme);
  view.state = prefs.state as QuestState;
  mapSettings.markHidden = prefs.markHidden;
  setShowDependencyArrows(prefs.arrows);
  mapSettings.alwaysDrawImplicit = prefs.implicit;
  setForceMonochrome(prefs.mono);

  const host = new Host(canvas, {
    onNavigate: (s, push) => {
      const hash = s.route();
      const title = s.title();
      document.title = title ? `${title} · ${SITE_TITLE}` : SITE_TITLE;
      if (location.hash !== hash) {
        if (push) history.pushState(null, '', hash);
        else history.replaceState(null, '', hash);
      }
    },
  });
  host.setScale(prefs.scale);

  host.navigateToQuestOnMap = (from, questId, lineId) => {
    let s: Screen | null = from;
    while (s && !(s instanceof QuestLinesScreen)) s = s.parent;
    if (s instanceof QuestLinesScreen) {
      host.show(s, false);
      s.focusQuest(questId, lineId);
      host.notify(s);
    } else {
      const lines = new QuestLinesScreen(null, lineId ?? linesContaining(questId)[0]?.id, questId);
      host.show(lines, true);
    }
  };

  // NEI: left click on an item shows its recipes, right click its uses.
  itemLookup.open = (key, mode) => {
    if (host.screen) void openLookup(host.screen, key, mode);
  };

  // Links inside quest descriptions.
  textLinks.questName = (id) => getQuest(id)?.name ?? null;
  textLinks.tooltip = (link) => {
    if (link.quest) {
      const q = getQuest(link.quest);
      if (!q) return null;
      const out = [q.name];
      const desc = plainText(q.desc, (id) => getQuest(id)?.name ?? null).trim();
      if (desc) {
        const lines = splitString(desc, 180);
        out.push(...lines.slice(0, 2).map((l) => '§7' + l));
        if (lines.length > 2) out.push('§7...');
      }
      out.push('§7' + tr('betterquesting.tooltip.quest_link.click'));
      return out;
    }
    return link.url ? ['§9' + link.url] : null;
  };
  textLinks.open = (link) => {
    if (link.quest && host.screen) host.navigateToQuestOnMap(host.screen, link.quest);
    else if (link.url) {
      const url = /^[a-z]+:/i.test(link.url) ? link.url : `https://${link.url}`;
      if (/^https?:/i.test(url)) window.open(url, '_blank', 'noopener');
    }
  };

  const openRoute = async () => {
    const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    const [kind, arg, sub] = parts;
    if ((kind === 'recipe' || kind === 'usage') && arg) {
      // Reuse the recipe screen chain when going back and forth in the browser history.
      const cur = host.screen;
      if (cur instanceof RecipeScreen && cur.route() === location.hash) return;
      const lines = new QuestLinesScreen(null);
      lines.host = host;
      const ok = await openLookup(lines, arg, kind as RecipeMode, { handler: sub, page: Number(parts[3]) || undefined }, false);
      if (ok) return;
    }
    if (kind === 'quest' && arg) {
      const id = fullId(arg);
      if (getQuest(id)) {
        const lines = new QuestLinesScreen(null, linesContaining(id)[0]?.id);
        lines.host = host;
        const q = new QuestScreen(lines, id);
        if (sub === 'properties') {
          q.host = host;
          host.show(new PropertiesScreen(q, id), false);
        } else host.show(q, false);
        return;
      }
    }
    if (kind === 'line' && arg) {
      host.show(new QuestLinesScreen(null, fullId(arg)), false);
      return;
    }
    if (kind === 'search') {
      const lines = new QuestLinesScreen(null);
      lines.host = host;
      host.show(new SearchScreen(lines, arg ?? ''), false);
      return;
    }
    if (kind === 'settings') {
      const lines = new QuestLinesScreen(null);
      lines.host = host;
      host.show(new SettingsScreen(lines), false);
      return;
    }
    host.show(new QuestLinesScreen(null), false);
  };
  window.addEventListener('popstate', () => void openRoute());
  await openRoute();
  status.remove();
}

start().catch((e) => {
  console.error(e);
  status.textContent = `Failed to load the questbook: ${(e as Error).message}`;
});
