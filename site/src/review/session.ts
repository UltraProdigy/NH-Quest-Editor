// Review mode: the questbook as a pull request would leave it, with its changes listed and
// marked. The pull request is part of the address (?pr=<number>), so a link to any screen opens
// the same review.

import { invalidate } from '../gui/frame.ts';
import { loadRawBundle, showInstead } from '../edit/session.ts';
import { sha1Hex } from '../lib/sha1.ts';
import type { Placement, QuestbookData } from '../lib/model.ts';
import { placementIn, type FieldChange, type ReviewItem, type ItemStatus } from './diff.ts';
import { pullRequest, GitHubError, type PullRequest } from './github.ts';
import { loadPull, type LoadedPull } from './load.ts';

export const reviewing = {
  /** The pull request being reviewed (also while it loads). */
  number: 0,
  loading: false,
  progress: '',
  error: '',
  pr: null as PullRequest | null,
  data: null as LoadedPull | null,
  /** Show master as it is (before the pull request) instead of with it. */
  showBefore: false,
};

let onRefresh: () => void = () => {};
export function setReviewRefresh(f: () => void) {
  onRefresh = f;
}

let loadToken = 0;

/** Start reviewing a pull request (or reload the one being reviewed). */
export async function startReview(n: number, force = false): Promise<boolean> {
  if (!force && reviewing.number === n && (reviewing.data || reviewing.loading)) return !!reviewing.data;
  const token = ++loadToken;
  reviewing.number = n;
  reviewing.loading = true;
  reviewing.error = '';
  reviewing.progress = 'Loading the pull request...';
  if (reviewing.data?.pr.number !== n) {
    reviewing.data = null;
    reviewing.pr = null;
  }
  setAddress(n);
  onRefresh();
  invalidate();
  try {
    const [pr, master] = await Promise.all([
      pullRequest(n).catch((e) => {
        throw e instanceof GitHubError && e.status === 404 ? new Error(`There is no pull request #${n} in the modpack.`) : e;
      }),
      loadRawBundle(),
    ]);
    if (token !== loadToken) return false;
    reviewing.pr = pr;
    const data = await loadPull(pr, master, (m) => {
      if (token !== loadToken) return;
      reviewing.progress = m;
      onRefresh();
      invalidate();
    });
    if (token !== loadToken) return false;
    reviewing.data = data;
    index(data);
    show();
    return true;
  } catch (e) {
    if (token !== loadToken) return false;
    reviewing.error = (e as Error).message || 'Could not load the pull request';
    onRefresh();
    return false;
  } finally {
    if (token === loadToken) {
      reviewing.loading = false;
      reviewing.progress = '';
      invalidate();
    }
  }
}

export function stopReview() {
  loadToken++;
  Object.assign(reviewing, { number: 0, loading: false, progress: '', error: '', pr: null, data: null, showBefore: false });
  clearIndex();
  setAddress(0);
  showInstead(null);
}

export function setShowBefore(v: boolean) {
  reviewing.showBefore = v;
  show();
}

function show() {
  const r = reviewing.data?.result;
  if (r) showInstead(reviewing.showBefore ? r.before : r.after);
}

/** The pull request in the address: ?pr=<number>. */
export function addressPr(): number {
  const n = Number(new URLSearchParams(location.search).get('pr'));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function setAddress(n: number) {
  const url = new URL(location.href);
  if (n) url.searchParams.set('pr', String(n));
  else url.searchParams.delete('pr');
  if (url.href !== location.href) history.replaceState(history.state, '', url.href);
}

/** The questbook not shown right now (to draw where things were or will be). */
export function otherBook(): QuestbookData | null {
  const r = reviewing.data?.result;
  return r ? (reviewing.showBefore ? r.after : r.before) : null;
}
export const isReviewing = () => !!reviewing.data;

// ---------------------------------------------------------------- lookups for the screens

const byQuest = new Map<string, ReviewItem>();
const byPlacement = new Map<string, ReviewItem>();
const byLine = new Map<string, ReviewItem>();
/** Quests with a change shown in each line (their own or their placement's). */
const perLine = new Map<string, Set<string>>();

function clearIndex() {
  byQuest.clear();
  byPlacement.clear();
  byLine.clear();
  perLine.clear();
}

function index(d: LoadedPull) {
  clearIndex();
  const { before, after } = d.result;
  const add = (line: string, quest: string) => {
    let s = perLine.get(line);
    if (!s) perLine.set(line, (s = new Set()));
    s.add(quest);
  };
  for (const it of d.items) {
    if (it.kind === 'q') {
      byQuest.set(it.questId!, it);
      for (const b of [before, after]) for (const l of b.lines) if (l.quests.some((p) => p[0] === it.questId)) add(l.id, it.questId!);
    } else if (it.kind === 'e') {
      byPlacement.set(`${it.lineId}:${it.questId}`, it);
      add(it.lineId!, it.questId!);
    } else if (it.kind === 'l') byLine.set(it.lineId!, it);
  }
}

export const questItem = (id: string) => byQuest.get(id);
export const placementItem = (lineId: string, questId: string) => byPlacement.get(`${lineId}:${questId}`);
export const lineItem = (id: string) => byLine.get(id);
/** How many quests changed in a line, plus one if the line itself changed. */
export const lineChangeCount = (id: string) => (perLine.get(id)?.size ?? 0) + (byLine.has(id) ? 1 : 0);
export const changedQuestsIn = (id: string) => perLine.get(id) ?? new Set<string>();

/** Changes inside a quest of one area ("task" 2, "desc", ...). */
export function questFields(id: string, area?: FieldChange['area'], index?: number): FieldChange[] {
  const f = byQuest.get(id)?.fields ?? [];
  return f.filter((x) => (!area || x.area === area) && (index === undefined || x.index === index));
}

/** The status to mark a quest with in a line, if any. */
export function questMark(lineId: string, questId: string): ItemStatus | null {
  const q = byQuest.get(questId);
  if (q && q.status !== 'changed') return q.status;
  const e = byPlacement.get(`${lineId}:${questId}`);
  if (e && e.status !== 'changed') return e.status;
  if (q) return 'changed';
  return e ? 'moved' : null;
}

/** Placements in the other questbook that are not where this one has them: drawn as outlines. */
export function ghostsIn(lineId: string, shown: QuestbookData): { questId: string; at: Placement; status: ItemStatus; now?: Placement }[] {
  const other = otherBook();
  if (!other) return [];
  const out = [];
  for (const questId of perLine.get(lineId) ?? []) {
    const there = placementIn(other, lineId, questId);
    if (!there) continue;
    const here = placementIn(shown, lineId, questId);
    if (here && here[1] === there[1] && here[2] === there[2] && here[3] === there[3] && here[4] === there[4]) continue;
    // A placement only in the other book: removed by the pull request (shown after) or added (shown before).
    const status: ItemStatus = here ? 'moved' : reviewing.showBefore ? 'added' : 'removed';
    out.push({ questId, at: there, status, now: here });
  }
  return out;
}

// ---------------------------------------------------------------- ticks

const TICKS_KEY = 'nhqe.review.ticks.v1';
const hashes = new WeakMap<ReviewItem, string>();
const hashOf = (it: ReviewItem) => {
  let h = hashes.get(it);
  if (!h) hashes.set(it, (h = sha1Hex(it.head ?? '\u0000removed').slice(0, 12)));
  return h;
};

function loadTicks(): Record<string, Record<string, string>> {
  try {
    return JSON.parse(localStorage.getItem(TICKS_KEY) ?? '{}') as Record<string, Record<string, string>>;
  } catch {
    return {};
  }
}
let ticks = loadTicks();

/** Ticked items stay ticked until the pull request changes that object again. */
export function isTicked(it: ReviewItem): boolean {
  return ticks[reviewing.number]?.[it.key] === hashOf(it);
}

export function setTicked(items: ReviewItem[], v: boolean) {
  ticks = loadTicks();
  const t = (ticks[reviewing.number] ??= {});
  for (const it of items) {
    if (v) t[it.key] = hashOf(it);
    else delete t[it.key];
  }
  if (!Object.keys(t).length) delete ticks[reviewing.number];
  try {
    localStorage.setItem(TICKS_KEY, JSON.stringify(ticks));
  } catch {
    // storage unavailable: ticks last for this visit
  }
  invalidate();
}

export const tickedCount = () => reviewing.data?.items.filter(isTicked).length ?? 0;
