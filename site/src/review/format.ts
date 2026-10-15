// Readable text for review items and their field changes, and the description diff.

import { diffArrays } from 'diff';
import { itemName, fluidName } from '../gui/items.ts';
import { stripFormatting } from '../gui/font.ts';
import { getFormatFromString } from '../gui/text.ts';
import type { QuestbookData } from '../lib/model.ts';
import { typeName } from '../screens/taskPanels.ts';
import { isItem, isFluid, type FieldChange, type ReviewItem, type ItemStatus } from './diff.ts';
import { reviewing } from './session.ts';

export const STATUS_CODE: Record<ItemStatus, string> = { added: '§2', removed: '§c', changed: '§9', moved: '§5' };
const STATUS_SIGN: Record<ItemStatus, string> = { added: '+', removed: '-', changed: '~', moved: '>' };

const books = (): QuestbookData[] => {
  const r = reviewing.data?.result;
  return r ? [r.after, r.before, r.headBook, r.baseBook] : [];
};
export const questName = (id?: string) => {
  if (!id) return '';
  for (const b of books()) if (b.quests[id]) return stripFormatting(b.quests[id].name) || '(no name)';
  return id;
};
export const lineName = (id?: string) => {
  if (!id) return '';
  for (const b of books()) {
    const l = b.lines.find((x) => x.id === id);
    if (l) return stripFormatting(l.name) || '(no name)';
  }
  return id;
};

const clip = (s: string, n = 48) => (s.length > n ? s.slice(0, n - 3) + '...' : s);

/** A value as a short readable text. */
export function value(v: unknown, area?: FieldChange['area']): string {
  if (v === undefined || v === null) return '§8(none)§r';
  if (isItem(v)) {
    const name = v.ore ? `${v.ore} (ore dict)` : itemName(v);
    return `${v.n > 1 || area === 'task' || area === 'reward' ? `${v.n}x ` : ''}${stripFormatting(name)}`;
  }
  if (isFluid(v)) return `${v.n} mB ${stripFormatting(fluidName(v))}`;
  if (area === 'pre') return Array.isArray(v) ? `${questName(String(v[0]))} (${['normal', 'implicit', 'hidden'][Number(v[1])] ?? v[1]})` : questName(String(v));
  if (typeof v === 'string') return `"${clip(stripFormatting(v))}"`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (area === 'place' && Array.isArray(v)) return `${v[0]}, ${v[1]}`;
  return clip(JSON.stringify(v));
}

const KEY_NAMES: Record<string, string> = {
  requiredItems: 'item',
  rewards: 'item',
  choices: 'choice',
  requiredFluids: 'fluid',
};

/** "Task 2 (Retrieval), item 1" */
function where(f: FieldChange, book: QuestbookData | null, questId?: string): string {
  if (f.area !== 'task' && f.area !== 'reward') return '';
  const list = questId && book?.quests[questId] ? book.quests[questId][f.area === 'task' ? 'tasks' : 'rewards'] : [];
  const type = list[f.index!]?.type;
  const head = `${f.area === 'task' ? 'Task' : 'Reward'} ${f.index! + 1}${type ? ` (${typeName(type, f.area)})` : ''}`;
  return head;
}

/** One line per field change. */
export function fieldLine(f: FieldChange, questId?: string): string {
  const after = reviewing.data?.result.after ?? null;
  const arrow = (a: unknown, b: unknown) => `${value(a, f.area)} §7->§r ${value(b, f.area)}`;
  switch (f.area) {
    case 'name':
      return `Name: ${arrow(f.before, f.after)}`;
    case 'desc': {
      const s = diffStats(String(f.before ?? ''), String(f.after ?? ''));
      return `Description: §a+${s.added}§r §c-${s.removed}§r words`;
    }
    case 'icon':
      return `Icon: ${arrow(f.before, f.after)}`;
    case 'pre':
      if (f.what === 'added') return `§aNew prerequisite:§r ${value(f.after, 'pre')}`;
      if (f.what === 'removed') return `§cPrerequisite removed:§r ${value(f.before, 'pre')}`;
      return `Prerequisite: ${arrow(f.before, f.after)}`;
    case 'task':
    case 'reward': {
      const head = where(f, after, questId);
      if (f.what === 'added') return `§a${head} added§r`;
      if (f.what === 'removed') return `§c${f.area === 'task' ? 'Task' : 'Reward'} ${f.index! + 1} (${typeName(String(f.before), f.area)}) removed§r`;
      if (f.what === 'type') return `${head}: type ${typeName(String(f.before), f.area)} §7->§r ${typeName(String(f.after), f.area)}`;
      const m = /^(\w+) (\d+)$/.exec(f.what);
      const what = m ? `${KEY_NAMES[m[1]] ?? m[1]} ${m[2]}` : f.what;
      if (f.before === undefined) return `${head}, ${what} §aadded§r: ${value(f.after, f.area)}`;
      if (f.after === undefined) return `${head}, ${what} §cremoved§r: ${value(f.before, f.area)}`;
      return `${head}, ${what}: ${arrow(f.before, f.after)}`;
    }
    case 'prop':
      return `Property ${f.what}: ${arrow(f.before, f.after)}`;
    case 'line':
      return `Quest line ${f.what}: ${arrow(f.before, f.after)}`;
    case 'place':
      return f.what === 'position' ? `Moved: ${arrow(f.before, f.after)}` : `Size: ${arrow(f.before, f.after)}`;
    case 'settings':
      return `Setting ${f.what}: ${arrow(f.before, f.after)}`;
    case 'order':
      return 'The order of the quest lines changed';
  }
}

/** The row title of a review item. */
export function itemTitle(it: ReviewItem): string {
  const sign = `${STATUS_CODE[it.status]}${STATUS_SIGN[it.status]}§r `;
  switch (it.kind) {
    case 'q':
      return `${sign}${questName(it.questId)}${it.status === 'added' ? ' §a(new quest)' : it.status === 'removed' ? ' §c(quest removed)' : ''}`;
    case 'e':
      return `${sign}${questName(it.questId)} ${
        it.status === 'added' ? '§7placed in this line' : it.status === 'removed' ? '§7taken out of this line' : '§7moved'
      }`;
    case 'l':
      return `${sign}Quest line "${lineName(it.lineId)}"${it.status === 'added' ? ' §a(new)' : it.status === 'removed' ? ' §c(removed)' : ''}`;
    case 's':
      return `${sign}Questbook settings`;
    case 'o':
      return `${sign}Quest line order`;
  }
}

/** Detail lines under a row. */
export function itemDetails(it: ReviewItem): string[] {
  const out = it.fields.map((f) => fieldLine(f, it.questId));
  if (!out.length && it.status === 'changed') out.push('§7Only the file changed (no visible difference)');
  if (it.master === 'clash') out.push('§6Master changed this too since the branch started; the pull request\'s version is shown.');
  else if (it.master === 'merged') out.push('§7Already on master.');
  return out;
}

// ---------------------------------------------------------------- description diff

/** Formatting codes, runs of spaces and words, so a diff never splits a code. */
const tokens = (s: string) => s.match(/§x(?:§[0-9a-fA-F]){6}|§.|\s+|[^\s§]+|§/g) ?? [];

export function diffStats(a: string, b: string) {
  let added = 0, removed = 0;
  for (const part of diffArrays(tokens(a), tokens(b))) {
    const words = part.value.filter((t) => /\S/.test(t) && !t.startsWith('§')).length;
    if (part.added) added += words;
    else if (part.removed) removed += words;
  }
  return { added, removed };
}

/**
 * The new text with removed words struck through in red and added words underlined in green.
 * After each marked run the formatting the text had at that point is put back.
 */
export function diffText(a: string, b: string): string {
  let out = '';
  let shown = ''; // the new text so far, to know its formatting
  for (const part of diffArrays(tokens(a), tokens(b))) {
    const text = part.value.join('');
    const restore = () => '§r' + getFormatFromString(shown);
    if (part.added) {
      out += `§a§n${text.replace(/§./g, '')}${restore()}`;
      shown += text;
    } else if (part.removed) {
      out += `§c§m${text.replace(/§./g, '')}${restore()}`;
    } else {
      out += text;
      shown += text;
    }
  }
  return out;
}
