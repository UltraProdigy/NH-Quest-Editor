import './style.css';
import { Host, type Screen } from './gui/screen.ts';
import { loadFont } from './gui/font.ts';
import { loadLang, tr } from './gui/lang.ts';
import { registerThemes, setTheme, setShowDependencyArrows, type ThemeJson } from './gui/theme.ts';
import { loadItems } from './gui/items.ts';
import { fetchJson, resourceUrl, siteUrl } from './gui/assets.ts';
import { textLinks, itemLookup } from './gui/widgets.ts';
import { PopItemList } from './gui/popup.ts';
import { openLookup, RecipeScreen, type RecipeMode } from './nei/recipeScreen.ts';
import { NeiInventoryScreen } from './nei/inventoryScreen.ts';
import { splitString, plainText, setForceMonochrome } from './gui/text.ts';
import { loadQuestbook, quest as getQuest, fullId, linesContaining, view, questNbtFluid, type QuestState } from './store.ts';
import { nbtFluidOf, questTab, loadNei, itemIndexOf, itemKeyAt } from './nei/data.ts';
import { toggleItem } from './nei/bookmarks.ts';
import { installQuestTab } from './nei/quests.ts';
import { QuestLinesScreen } from './screens/questLines.ts';
import { QuestScreen } from './screens/quest.ts';
import { SearchScreen } from './screens/search.ts';
import { SettingsScreen } from './screens/settings.ts';
import { PropertiesScreen } from './screens/properties.ts';
import { mapSettings } from './screens/questCanvas.ts';
import { setGameNames } from './screens/taskPanels.ts';
import { loadPrefs } from './prefs.ts';
import { setRefresh, startEditing, editKey } from './edit/session.ts';
import { EditsScreen } from './screens/edits.ts';
import { ReviewScreen, ReviewPickerScreen } from './screens/review.ts';
import { installReview } from './review/install.ts';
import { startReview } from './review/session.ts';
import { installTouchBar } from './touchbar.ts';

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

  // Browser history follows the screens: opening a screen adds an entry, and closing it goes back
  // one, so the phone's back gesture and the site's own back buttons agree. Each entry the site
  // added counts how deep it is (history.state.depth); the first one is 0.
  const depth = () => (history.state as { depth?: number } | null)?.depth ?? 0;
  /** Set while the site goes back in the history itself, until the browser reports it. */
  let ownBack = false;
  /** Screens closed in this task (one Escape may close several): one step back for them all. */
  let backs = 0;
  /** Set while the screens follow the browser's back button (the history moved already). */
  let followingHistory = false;
  let touchBar: { update(): void } | null = null;
  const host = new Host(canvas, {
    onNavigate: (s, push, back) => {
      const hash = s.route();
      const title = s.title();
      document.title = title ? `${title} · ${SITE_TITLE}` : SITE_TITLE;
      touchBar?.update();
      if (followingHistory) return;
      if (back && depth() > 0) {
        // The parent's entry is the one before this screen's: step back to it.
        if (backs++ === 0) {
          queueMicrotask(() => {
            const n = Math.min(backs, depth());
            backs = 0;
            ownBack = true;
            history.go(-n);
          });
        }
        return;
      }
      if (location.hash !== hash) {
        if (push) history.pushState({ depth: depth() + 1 }, '', hash);
        else history.replaceState({ depth: depth() }, '', hash);
      }
    },
  });
  touchBar = installTouchBar(host);
  host.setScale(prefs.scale);

  // Edit mode: screens rebuild after every change; Ctrl + Z / Ctrl + Y undo and redo.
  setRefresh(() => host.refresh());
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement)?.closest?.('input,textarea,select')) return;
    if (editKey(e)) e.preventDefault();
  }, true);
  if (prefs.editMode) void startEditing();
  // Review mode (a modpack pull request); ?pr=<number> in the address starts it.
  installReview(() => host.refresh());

  host.navigateToLine = (from, lineId) => {
    let s: Screen | null = from;
    while (s && !(s instanceof QuestLinesScreen)) s = s.parent;
    if (s instanceof QuestLinesScreen) {
      host.show(s, false);
      const l = s.lineById(lineId);
      if (l) s.openQuestLine(l);
      host.notify(s);
    } else host.show(new QuestLinesScreen(null, lineId), true);
  };
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
  nbtFluidOf.get = questNbtFluid;
  itemLookup.open = (key, mode) => {
    if (host.screen) void openLookup(host.screen, key, mode);
  };
  // NEI's A key over quest items: bookmarks show in NEI's panel (E, or any recipe window).
  itemLookup.bookmark = (key, withCount) => {
    void loadNei().then(() => {
      const i = itemIndexOf(key);
      toggleItem(i !== undefined ? itemKeyAt(i) : key.replace(/#.*$/, ''), { withCount, amount: 1 });
    });
  };
  // NEI's BetterQuesting tab: quests that ask for or give an item; their names open them.
  installQuestTab();
  questTab.open = (from, id) => host.show(new QuestScreen(from as Screen, id));
  itemLookup.variants = (title, stacks) => {
    const s = host.screen;
    if (s) s.openPopup(new PopItemList(title, stacks, () => s.closePopup()));
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
    if (kind === 'nei') {
      if (host.screen instanceof NeiInventoryScreen) return;
      const lines = new QuestLinesScreen(null);
      lines.host = host;
      host.show(new NeiInventoryScreen(lines), false);
      return;
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
    if (kind === 'edits') {
      const lines = new QuestLinesScreen(null);
      lines.host = host;
      host.show(new EditsScreen(lines), false);
      return;
    }
    if (kind === 'review') {
      const lines = new QuestLinesScreen(null);
      lines.host = host;
      const n = Number(arg);
      if (Number.isInteger(n) && n > 0) {
        if (host.screen instanceof ReviewScreen && host.screen.n === n) return;
        host.show(new ReviewScreen(lines, n), false);
        void startReview(n);
      } else host.show(new ReviewPickerScreen(lines), false);
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
  window.addEventListener('popstate', () => {
    if (ownBack) {
      // Our own step back: the screen is shown already; the entry may name it differently.
      ownBack = false;
      const hash = host.screen?.route();
      if (hash && location.hash !== hash) history.replaceState({ depth: depth() }, '', hash);
      return;
    }
    // The browser's back button: when the entry is a screen we came from, close back to it so it
    // is as it was left (map position, scroll, tray); anything else is opened from its address.
    let n = 0;
    for (let s = host.screen?.parent ?? null; s; s = s.parent) {
      n++;
      if (s.route() === location.hash) {
        followingHistory = true;
        try {
          for (let i = 0; i < n; i++) host.back();
        } finally {
          followingHistory = false;
        }
        return;
      }
    }
    void openRoute();
  });
  await openRoute();
  status.remove();
}

start().catch((e) => {
  console.error(e);
  status.textContent = `Failed to load the questbook: ${(e as Error).message}`;
});
