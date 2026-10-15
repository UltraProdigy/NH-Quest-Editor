// What a pull request changes in the questbook. Works on whole DefaultQuests file sets, so it
// does not need GitHub: give it the site's quest files (the modpack's master branch) and, for
// every file the pull request touches, its text where the branch started (merge base) and at the
// pull request's head.
//
// Both versions are laid over master's files and loaded as BetterQuesting databases; comparing
// the two object by object (a quest, a quest line, one placement, the settings, the line order,
// the same keys the editor uses) gives what the pull request itself changes, whatever happened
// on master since. Those changes are then applied to master, which is what the site shows: the
// questbook as it would be with the pull request merged.

import { parseBq, type BqObject } from '../lib/bqjson.ts';
import { tagId, SETTINGS_FILE, QUEST_LINE_ORDER_FILE, QUEST_LINE_DIR, QUEST_DIR, QUEST_LINE_FILE } from '../lib/bqsave.ts';
import { EditDocument, type RawBundle, type ObjectKey } from '../edit/document.ts';
import type { Quest, QuestLine, QuestbookData, Placement, TaskData, PrereqRef } from '../lib/model.ts';

/** Text of a file by its path inside DefaultQuests; null when the file does not exist. */
export type FileVersions = Map<string, string | null>;

// ---------------------------------------------------------------- files to objects

/** File and folder names end in "-<id>" (buildFileName); ids are 22 base64 characters and "==". */
const ID_AT_END = /-([A-Za-z0-9_-]{22}==)$/;
const idOf = (name: string) => ID_AT_END.exec(name.replace(/\.json$/, ''))?.[1] ?? null;

/** The object a file holds, as an EditDocument key; null for files that are not part of the database. */
export function identityOf(path: string, text?: string | null): ObjectKey | null {
  if (path === SETTINGS_FILE) return 's';
  if (path === QUEST_LINE_ORDER_FILE) return 'o';
  const parts = path.split('/');
  const fromText = (prefix: 'quest' | 'questLine') => {
    if (!text) return null;
    try {
      return tagId(parseBq(text) as BqObject, prefix);
    } catch {
      return null;
    }
  };
  if (parts[0] === QUEST_LINE_DIR && parts.length === 3) {
    const line = idOf(parts[1]);
    if (!line) return null;
    if (parts[2] === QUEST_LINE_FILE) return `l:${line}`;
    const quest = idOf(parts[2]) ?? fromText('quest');
    return quest ? `e:${line}:${quest}` : null;
  }
  if (parts[0] === QUEST_DIR && parts.length >= 2 && path.endsWith('.json')) {
    const quest = idOf(parts[parts.length - 1]) ?? fromText('quest');
    return quest ? `q:${quest}` : null;
  }
  return null;
}

/**
 * Master's files with some files replaced. Replacing goes by object, not by path: a file the
 * other side renamed (a quest renamed or moved to another line) is replaced too, so no object
 * ends up in the database twice.
 */
export function overlay(master: ReadonlyMap<string, string>, versions: FileVersions): Map<string, string> {
  const out = new Map(master);
  const byObject = new Map<ObjectKey, string[]>();
  for (const p of master.keys()) {
    const k = identityOf(p);
    if (!k) continue;
    const list = byObject.get(k);
    if (list) list.push(p);
    else byObject.set(k, [p]);
  }
  for (const [p, text] of versions) {
    out.delete(p);
    const k = identityOf(p, text);
    if (k) for (const q of byObject.get(k) ?? []) out.delete(q);
  }
  for (const [p, text] of versions) if (text !== null) out.set(p, text);

  // A placement must sit next to its line's QuestLine.json. If master renamed the line's folder
  // since the branch started, move the branch's placements into master's folder.
  const lineDir = new Map<string, string>();
  for (const p of out.keys()) {
    const parts = p.split('/');
    if (parts[0] === QUEST_LINE_DIR && parts.length === 3 && parts[2] === QUEST_LINE_FILE) {
      const id = idOf(parts[1]);
      if (id) lineDir.set(id, parts[1]);
    }
  }
  for (const [p, text] of [...out]) {
    const parts = p.split('/');
    if (parts[0] !== QUEST_LINE_DIR || parts.length !== 3 || parts[2] === QUEST_LINE_FILE) continue;
    const id = idOf(parts[1]);
    const dir = id ? lineDir.get(id) : undefined;
    if (dir && dir !== parts[1]) {
      out.delete(p);
      out.set(`${QUEST_LINE_DIR}/${dir}/${parts[2]}`, text);
    } else if (!dir) out.delete(p); // its line is gone
  }
  return out;
}

export interface ObjectChange {
  key: ObjectKey;
  /** Text at the merge base (null: did not exist). */
  base: string | null;
  /** Text at the pull request's head (null: removed). */
  head: string | null;
}

/** How a change relates to master as it is now. */
export type MasterState =
  /** Master has the object as the branch started: the change applies cleanly. */
  | 'clean'
  /** Master already has the pull request's version (it was merged, or the same change landed). */
  | 'merged'
  /** Master changed the object too since the branch started; the pull request's version is shown. */
  | 'clash';

export interface PrResult {
  changes: (ObjectChange & { master: MasterState })[];
  /** The pull request's own before and after (merge base and head, over master's other files). */
  baseBook: QuestbookData;
  headBook: QuestbookData;
  /** What the site shows: master, and master with the pull request applied. */
  before: QuestbookData;
  after: QuestbookData;
  /** Master with the pull request applied, for editing on top of it later. */
  doc: EditDocument;
}

/**
 * Work out a pull request's changes and apply them to master. `base` and `head` hold the
 * touched files (paths inside DefaultQuests) at the merge base and at the head.
 */
export function diffPullRequest(master: RawBundle, base: FileVersions, head: FileVersions): PrResult {
  const files = new Map(Object.entries(master.files));
  const bundleOf = (f: Map<string, string>): RawBundle => ({ ...master, files: Object.fromEntries(f) });
  const baseDoc = new EditDocument(bundleOf(overlay(files, base)));
  const headDoc = new EditDocument(bundleOf(overlay(files, head)));

  const keys = new Set<ObjectKey>();
  for (const v of [base, head]) for (const [p, t] of v) {
    const k = identityOf(p, t);
    if (k) keys.add(k);
  }
  const rank = (k: string) => ({ o: 0, s: 1, l: 2, q: 3, e: 4 })[k[0]] ?? 5;
  const changes: ObjectChange[] = [];
  for (const key of [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
    const b = baseDoc.read(key), h = headDoc.read(key);
    if (b !== h) changes.push({ key, base: b, head: h });
  }

  const doc = new EditDocument(master);
  const before = doc.questbook();
  const withState = changes.map((c) => {
    const now = doc.read(c.key);
    const state: MasterState = now === c.head ? 'merged' : now === c.base ? 'clean' : 'clash';
    return { ...c, master: state };
  });
  doc.restore(changes.map((c) => ({ key: c.key, text: c.head, base: c.base })));
  return { changes: withState, baseBook: baseDoc.questbook(), headBook: headDoc.questbook(), before, after: doc.questbook(), doc };
}

// ---------------------------------------------------------------- what changed inside an object

/** Where in a quest (or line, ...) a change is, for highlighting it and describing it. */
export type Area = 'name' | 'desc' | 'icon' | 'pre' | 'task' | 'reward' | 'prop' | 'line' | 'place' | 'settings' | 'order';

export interface FieldChange {
  area: Area;
  /** Task or reward number (0-based). */
  index?: number;
  /** What changed: a property name, "type", "requiredItems 2", "added", "removed", ... */
  what: string;
  before?: unknown;
  after?: unknown;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const isItem = (v: unknown): v is import('../lib/model.ts').ItemRef =>
  isObj(v) && typeof v.id === 'string' && typeof v.dmg === 'number';
export const isFluid = (v: unknown): v is import('../lib/model.ts').FluidRef =>
  isObj(v) && typeof v.fluid === 'string' && typeof v.n === 'number';

function entryChanges(area: 'task' | 'reward', a: TaskData[], b: TaskData[]): FieldChange[] {
  const out: FieldChange[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (!x) out.push({ area, index: i, what: 'added', after: y.type });
    else if (!y) out.push({ area, index: i, what: 'removed', before: x.type });
    else if (x.type !== y.type) out.push({ area, index: i, what: 'type', before: x.type, after: y.type });
    else {
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => k !== 'type' && k !== 'index');
      for (const k of keys) {
        const vx = x[k], vy = y[k];
        if (same(vx, vy)) continue;
        const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : null);
        const lx = list(vx), ly = list(vy);
        if (lx && ly && [...lx, ...ly].every((e) => isItem(e) || isFluid(e))) {
          for (let j = 0; j < Math.max(lx.length, ly.length); j++) {
            if (!same(lx[j], ly[j])) out.push({ area, index: i, what: `${k} ${j + 1}`, before: lx[j], after: ly[j] });
          }
        } else out.push({ area, index: i, what: k, before: vx, after: vy });
      }
    }
  }
  return out;
}

const preMap = (l: PrereqRef[]) => new Map(l.map(([id, t]) => [id, t ?? 0]));

/** Field by field changes between two versions of a quest (either may be missing). */
export function questChanges(a: Quest | undefined, b: Quest | undefined, defA: Record<string, unknown>, defB: Record<string, unknown>): FieldChange[] {
  if (!a || !b) return [];
  const out: FieldChange[] = [];
  if (a.name !== b.name) out.push({ area: 'name', what: 'name', before: a.name, after: b.name });
  if (a.desc !== b.desc) out.push({ area: 'desc', what: 'description', before: a.desc, after: b.desc });
  if (!same(a.icon, b.icon)) out.push({ area: 'icon', what: 'icon', before: a.icon, after: b.icon });
  const pa = preMap(a.pre), pb = preMap(b.pre);
  for (const [id, t] of pb) {
    if (!pa.has(id)) out.push({ area: 'pre', what: 'added', after: id });
    else if (pa.get(id) !== t) out.push({ area: 'pre', what: 'type', before: [id, pa.get(id)], after: [id, t] });
  }
  for (const id of pa.keys()) if (!pb.has(id)) out.push({ area: 'pre', what: 'removed', before: id });
  out.push(...entryChanges('task', a.tasks, b.tasks));
  out.push(...entryChanges('reward', a.rewards, b.rewards));
  const keys = new Set([...Object.keys(a.props), ...Object.keys(b.props), ...Object.keys(defA), ...Object.keys(defB)]);
  for (const k of keys) {
    const va = k in a.props ? a.props[k] : defA[k];
    const vb = k in b.props ? b.props[k] : defB[k];
    if (!same(va, vb)) out.push({ area: 'prop', what: k, before: va, after: vb });
  }
  return out;
}

/** Changes to a quest line's own properties (not its quests). */
export function lineChanges(a: QuestLine | undefined, b: QuestLine | undefined): FieldChange[] {
  if (!a || !b) return [];
  const out: FieldChange[] = [];
  for (const k of ['name', 'desc', 'icon', 'visibility', 'bgImage', 'bgSize'] as const) {
    if (!same(a[k], b[k])) out.push({ area: k === 'name' ? 'name' : k === 'desc' ? 'desc' : k === 'icon' ? 'icon' : 'line', what: k, before: a[k], after: b[k] });
  }
  return out;
}

export const placementIn = (book: QuestbookData, lineId: string, questId: string): Placement | undefined =>
  book.lines.find((l) => l.id === lineId)?.quests.find((p) => p[0] === questId);

/** A placement's change: moved and/or resized. */
export function placementChanges(a: Placement | undefined, b: Placement | undefined): FieldChange[] {
  if (!a || !b) return [];
  const out: FieldChange[] = [];
  if (a[1] !== b[1] || a[2] !== b[2]) out.push({ area: 'place', what: 'position', before: [a[1], a[2]], after: [b[1], b[2]] });
  if (a[3] !== b[3] || a[4] !== b[4]) out.push({ area: 'place', what: 'size', before: [a[3], a[4]], after: [b[3], b[4]] });
  return out;
}

export function settingsChanges(a: Record<string, unknown>, b: Record<string, unknown>): FieldChange[] {
  const out: FieldChange[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!same(a[k], b[k])) out.push({ area: 'settings', what: k, before: a[k], after: b[k] });
  }
  return out;
}

// ---------------------------------------------------------------- review items

export type ItemStatus = 'added' | 'removed' | 'changed' | 'moved';

/** One reviewable change: a row with a checkbox in the review screen. */
export interface ReviewItem {
  key: ObjectKey;
  kind: 'q' | 'l' | 'e' | 's' | 'o';
  status: ItemStatus;
  questId?: string;
  lineId?: string;
  fields: FieldChange[];
  master: MasterState;
  /** The pull request's text of the object: a tick stays only while this is unchanged. */
  head: string | null;
}

/** Turn object changes into review items with their field changes. */
export function reviewItems(r: Pick<PrResult, 'changes' | 'baseBook' | 'headBook'>): ReviewItem[] {
  const { baseBook: A, headBook: B } = r;
  const line = (book: QuestbookData, id: string) => book.lines.find((l) => l.id === id);
  return r.changes.map((c) => {
    const [kind, a, b] = c.key.split(':') as ['q' | 'l' | 'e' | 's' | 'o', string, string];
    const status: ItemStatus = c.base === null ? 'added' : c.head === null ? 'removed' : 'changed';
    const item: ReviewItem = { key: c.key, kind, status, fields: [], master: c.master, head: c.head };
    switch (kind) {
      case 'q':
        item.questId = a;
        item.fields = questChanges(A.quests[a], B.quests[a], A.defaults, B.defaults);
        break;
      case 'l':
        item.lineId = a;
        item.fields = lineChanges(line(A, a), line(B, a));
        break;
      case 'e': {
        item.lineId = a;
        item.questId = b;
        item.fields = placementChanges(placementIn(A, a, b), placementIn(B, a, b));
        if (status === 'changed') item.status = 'moved';
        break;
      }
      case 's':
        item.fields = settingsChanges(A.settings, B.settings);
        break;
      case 'o':
        item.fields = [{ area: 'order', what: 'order', before: A.lines.map((l) => l.id), after: B.lines.map((l) => l.id) }];
        break;
    }
    return item;
  });
}
