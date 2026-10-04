// The loaded questbook and the lookups the screens need.

import { fetchJson, siteUrl } from './gui/assets.ts';
import type { Quest, QuestLine, QuestbookData } from './lib/model.ts';

export let book: QuestbookData;
const dependants = new Map<string, string[]>();
const linesOf = new Map<string, QuestLine[]>();

export async function loadQuestbook() {
  book = await fetchJson<QuestbookData>(siteUrl('data/questbook.json'));
  for (const q of Object.values(book.quests)) {
    for (const [pre] of q.pre) {
      const list = dependants.get(pre) ?? [];
      list.push(q.id);
      dependants.set(pre, list);
    }
  }
  for (const l of book.lines) {
    for (const [id] of l.quests) {
      const list = linesOf.get(id) ?? [];
      list.push(l);
      linesOf.set(id, list);
    }
  }
}

export const quest = (id: string): Quest | undefined => book.quests[id];
export const line = (id: string): QuestLine | undefined => book.lines.find((l) => l.id === id);
export const dependantsOf = (id: string) => dependants.get(id) ?? [];
export const linesContaining = (id: string) => linesOf.get(id) ?? [];
export const isInAnyLine = (id: string) => (linesOf.get(id)?.length ?? 0) > 0;

/** A quest property with the database default applied. */
export function prop<T = unknown>(q: Quest, key: string): T {
  return (key in q.props ? q.props[key] : book.defaults[key]) as T;
}

/** Quest ids are URL-safe base64 with "==" padding; links drop the padding. */
export const shortId = (id: string) => id.replace(/=+$/, '');
export function fullId(s: string): string {
  if (book.quests[s]) return s;
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  return padded;
}

// ---------------------------------------------------------------- display state

/**
 * There is no player on the site, so every quest is drawn in one state. "unlocked" matches what
 * a player sees for available quests; the other states let people preview the other frames.
 */
export type QuestState = 'LOCKED' | 'UNLOCKED' | 'UNCLAIMED' | 'COMPLETED' | 'REPEATABLE';
export const view = {
  state: 'UNLOCKED' as QuestState,
};

export const questState = (_q: Quest): QuestState => view.state;
