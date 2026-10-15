// Connect review mode to the questbook screens (review/hooks.ts).

import type { Screen } from '../gui/screen.ts';
import { reviewHooks, STATUS_COLOR, type Ghost } from './hooks.ts';
import {
  reviewing, isReviewing, setShowBefore, questMark, questItem, placementItem, lineChangeCount, ghostsIn, isTicked, questFields,
  otherBook, setReviewRefresh, startReview, addressPr,
} from './session.ts';
import { fieldLine, diffText, value } from './format.ts';
import { book } from '../store.ts';
import { processTags } from '../gui/text.ts';
import { ReviewScreen, ReviewPickerScreen } from '../screens/review.ts';

export function installReview(refresh: () => void) {
  setReviewRefresh(refresh);
  const h = reviewHooks;
  h.active = isReviewing;
  h.label = () => (reviewing.data ? `PR #${reviewing.number} · ${reviewing.showBefore ? 'before' : 'after'}` : '');
  h.showingBefore = () => reviewing.showBefore;
  h.toggleBefore = () => {
    if (isReviewing()) setShowBefore(!reviewing.showBefore);
  };
  h.open = (from) => {
    const s = from as Screen;
    s.host.show(reviewing.number ? new ReviewScreen(s, reviewing.number) : new ReviewPickerScreen(s));
  };
  h.lineCount = lineChangeCount;
  h.questMark = (lineId, questId) => {
    const st = questMark(lineId, questId);
    if (!st) return null;
    const items = [questItem(questId), placementItem(lineId, questId)].filter((x) => !!x);
    return { color: STATUS_COLOR[st], dim: items.every(isTicked) };
  };
  h.questTooltip = (questId, lineId, all = false) => {
    const q = questItem(questId);
    const e = lineId ? placementItem(lineId, questId) : undefined;
    if (!q && !e) return [];
    const out = [`§6Changed in PR #${reviewing.number}:`];
    if (q?.status === 'added') out.push('§aNew quest');
    if (q?.status === 'removed') out.push('§cQuest removed');
    if (e?.status === 'added') out.push('§aPlaced in this line');
    if (e?.status === 'removed') out.push('§cTaken out of this line');
    const lines = [...(q?.fields ?? []), ...(e?.fields ?? [])].map((f) => fieldLine(f, questId));
    const max = all ? Infinity : 6;
    out.push(...lines.slice(0, max).map((l) => `§7${l}`));
    if (lines.length > max) out.push(`§7... and ${lines.length - max} more`);
    return out;
  };
  h.ghosts = (line) => {
    const other = otherBook();
    return ghostsIn(line.id, book).map((g): Ghost => {
      const [, x, y, w, hh] = g.at;
      const name = other?.quests[g.questId]?.name ?? g.questId;
      const where = reviewing.showBefore ? 'after' : 'before';
      return {
        quest: other?.quests[g.questId] ?? null,
        rect: [x, y, w, hh],
        color: STATUS_COLOR[g.status],
        to: g.now ? [g.now[1], g.now[2], g.now[3], g.now[4]] : undefined,
        tooltip: [
          name,
          g.status === 'moved' ? `§3Here ${where} the pull request` : g.status === 'removed' ? '§cTaken out by the pull request' : '§aAdded by the pull request',
          '§7B: switch between before and after',
        ],
      };
    });
  };
  h.areaMark = (questId, area, index) => {
    const it = questItem(questId);
    if (!it || it.status !== 'changed') return null;
    const f = questFields(questId, area, index);
    if (!f.length) return null;
    // A task or reward that is new or gone is green or red, the rest yellow.
    const kind = f.length === 1 ? f[0].what : '';
    return STATUS_COLOR[kind === 'added' && area !== 'pre' ? 'added' : kind === 'removed' && area !== 'pre' ? 'removed' : 'changed'];
  };
  h.questStatus = (questId) => {
    const it = questItem(questId);
    return it && (it.status === 'added' || it.status === 'removed') ? STATUS_COLOR[it.status] : null;
  };
  h.descDiff = (questId) => {
    const f = questFields(questId, 'desc')[0];
    if (!f) return null;
    // Compare the text as shown: BetterQuesting's tags ([warn], [quest], ...) turned into
    // formatting first, so they cannot recolour the marked words.
    const shown = (s: unknown) => processTags(String(s ?? ''), (id) => book.quests[id]?.name ?? otherBook()?.quests[id]?.name ?? null).text;
    return diffText(shown(f.before), shown(f.after));
  };
  h.propBefore = (questId, key) => {
    const f = questFields(questId, 'prop').find((x) => x.what === key);
    if (!f) return null;
    return value(reviewing.showBefore ? f.after : f.before, 'prop');
  };

  // A link with ?pr=<number> opens that review.
  const n = addressPr();
  if (n) void startReview(n);
}
