// The questbook being edited: BetterQuesting's database loaded from the raw DefaultQuests files
// (data/quests-raw.json), changed through transactions that can be undone and redone.
//
// Every change goes through `transact`, which records the old and new value of each object it
// touches (a quest, a quest line, one placement, the settings, the quest line order). That record
// is the undo history, and the set of touched objects is what autosave keeps: their current text
// (BetterQuesting's JSON) plus what they were in the base data, so work survives a reload and a
// newer base can be checked for clashes.

import { parseBq } from '../lib/bqjson.ts';
import type { BqObject } from '../lib/bqjson.ts';
import { writeBq } from '../lib/bqwrite.ts';
import { loadDb, saveDb, matchBaseCase, type QuestDb, type QuestLineRecord } from '../lib/bqsave.ts';
import { buildQuestbook } from '../lib/questbook.ts';
import type { QuestbookData } from '../lib/model.ts';

export interface RawBundle {
  format: 1;
  source: { repo: string; commit: string; date: string };
  /** Where the files live in the modpack repo. */
  root: string;
  files: Record<string, string>;
}

/**
 * The objects a transaction can touch, by key:
 * - "q:<quest id>"           a quest (its whole file)
 * - "l:<line id>"            a quest line's QuestLine.json
 * - "e:<line id>:<quest id>" a quest's placement in a line
 * - "s"                      QuestSettings.json
 * - "o"                      the quest line order (JSON list of ids)
 * A value is BetterQuesting JSON text, or null when the object does not exist.
 */
export type ObjectKey = string;
type Snapshot = Map<ObjectKey, string | null>;

interface Change {
  label: string;
  before: Snapshot;
  after: Snapshot;
}

export interface FileChanges {
  changed: string[];
  added: string[];
  deleted: string[];
}

const clone = (o: BqObject): BqObject => parseBq(writeBq(o)) as BqObject;

export class EditDocument {
  readonly base: ReadonlyMap<string, string>;
  readonly db: QuestDb;
  /** Text of each touched object in the base data (null: it did not exist). */
  readonly baseObjects = new Map<ObjectKey, string | null>();
  private undoStack: Change[] = [];
  private redoStack: Change[] = [];
  /** Bumped on every change; caches compare against it. */
  version = 0;
  private listeners = new Set<() => void>();
  private cache: { version: number; files?: Map<string, string>; book?: QuestbookData } = { version: -1 };

  readonly bundle: RawBundle;

  constructor(bundle: RawBundle) {
    this.bundle = bundle;
    this.base = new Map(Object.entries(bundle.files));
    this.db = loadDb(this.base);
  }

  get source() {
    return this.bundle.source;
  }

  onChange(f: () => void) {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private changed() {
    this.version++;
    for (const f of this.listeners) f();
  }

  // ---------------------------------------------------------------- objects

  /** The current text of an object (null when it does not exist). */
  read(key: ObjectKey): string | null {
    const [kind, a, b] = key.split(':');
    switch (kind) {
      case 'q': {
        const q = this.db.quests.get(a);
        return q ? writeBq(q) : null;
      }
      case 'l': {
        const l = this.db.lines.get(a);
        return l ? writeBq(l.tag) : null;
      }
      case 'e': {
        const e = this.db.lines.get(a)?.entries.get(b);
        return e ? writeBq(e) : null;
      }
      case 's':
        return writeBq(this.db.settings);
      case 'o':
        return JSON.stringify([...this.db.lines.keys()]);
    }
    throw new Error(`Unknown object ${key}`);
  }

  /** Set an object from its text (null removes it). Keeps line order and placements consistent. */
  private write(key: ObjectKey, text: string | null) {
    const [kind, a, b] = key.split(':');
    switch (kind) {
      case 'q':
        if (text === null) this.db.quests.delete(a);
        else this.db.quests.set(a, parseBq(text) as BqObject);
        return;
      case 'l': {
        if (text === null) {
          this.db.lines.delete(a);
          return;
        }
        const tag = parseBq(text) as BqObject;
        const line = this.db.lines.get(a);
        if (line) line.tag = tag;
        else this.db.lines.set(a, { tag, entries: new Map() });
        return;
      }
      case 'e': {
        let line = this.db.lines.get(a);
        if (!line) {
          if (text === null) return;
          // A placement in a line that is not there (yet): keep it on a hidden record.
          line = { tag: {}, entries: new Map() } as QuestLineRecord;
          this.db.lines.set(a, line);
        }
        if (text === null) line.entries.delete(b);
        else line.entries.set(b, parseBq(text) as BqObject);
        return;
      }
      case 's':
        if (text !== null) (this.db as { settings: BqObject }).settings = parseBq(text) as BqObject;
        return;
      case 'o': {
        if (text === null) return;
        const ids = JSON.parse(text) as string[];
        const old = new Map(this.db.lines);
        this.db.lines.clear();
        for (const id of ids) {
          const l = old.get(id);
          if (l) this.db.lines.set(id, l);
        }
        for (const [id, l] of old) if (!this.db.lines.has(id)) this.db.lines.set(id, l);
        return;
      }
    }
  }

  // ---------------------------------------------------------------- transactions

  /**
   * Make a change. `fn` gets a writer: set(key, tag | null) replaces an object, quest/line/entry
   * give copies to modify and set back. Everything set in one call is one undo step.
   */
  transact(label: string, fn: (tx: Transaction) => void): boolean {
    const before: Snapshot = new Map();
    const after: Snapshot = new Map();
    const tx: Transaction = {
      quest: (id) => {
        const q = this.db.quests.get(id);
        return q ? clone(q) : null;
      },
      line: (id) => {
        const l = this.db.lines.get(id);
        return l ? clone(l.tag) : null;
      },
      entry: (lineId, questId) => {
        const e = this.db.lines.get(lineId)?.entries.get(questId);
        return e ? clone(e) : null;
      },
      settings: () => clone(this.db.settings),
      lineOrder: () => [...this.db.lines.keys()],
      set: (key, value) => {
        const text = value === null ? null : Array.isArray(value) ? JSON.stringify(value) : writeBq(value);
        if (!before.has(key)) before.set(key, this.read(key));
        this.write(key, text);
        after.set(key, text);
      },
    };
    fn(tx);
    // Drop objects that ended up as they were.
    for (const [k, v] of after) if (before.get(k) === v) {
      before.delete(k);
      after.delete(k);
    }
    if (!after.size) return false;
    // The first value an object had this session is its base value.
    for (const [k, v] of before) if (!this.baseObjects.has(k)) this.baseObjects.set(k, v);
    this.undoStack.push({ label, before, after });
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.redoStack = [];
    this.changed();
    return true;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  get undoLabel() {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }
  get redoLabel() {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }

  /** Write objects in the given order, the quest line order last (it needs the lines to exist). */
  private apply(entries: [ObjectKey, string | null][]) {
    for (const [k, v] of entries) if (k !== ORDER_KEY) this.write(k, v);
    for (const [k, v] of entries) if (k === ORDER_KEY) this.write(k, v);
  }

  undo(): boolean {
    const c = this.undoStack.pop();
    if (!c) return false;
    this.apply([...c.before].reverse());
    this.redoStack.push(c);
    this.changed();
    return true;
  }

  redo(): boolean {
    const c = this.redoStack.pop();
    if (!c) return false;
    this.apply([...c.after]);
    this.undoStack.push(c);
    this.changed();
    return true;
  }

  // ---------------------------------------------------------------- results

  /** Every object changed from the base data, with its current and base text. */
  edits(): { key: ObjectKey; text: string | null; base: string | null }[] {
    const out = [];
    for (const [key, base] of this.baseObjects) {
      const text = this.read(key);
      if (text !== base) out.push({ key, text, base });
    }
    return out;
  }

  /** Apply saved edits (autosave) on top of the base data, as one step that cannot be undone. */
  restore(edits: { key: ObjectKey; text: string | null; base: string | null }[]) {
    // Lines first, then placements and quests, then the order.
    const rank = (k: string) => ({ l: 0, s: 0, q: 1, e: 2, o: 3 })[k[0]] ?? 4;
    for (const e of [...edits].sort((a, b) => rank(a.key) - rank(b.key))) {
      if (!this.baseObjects.has(e.key)) this.baseObjects.set(e.key, this.read(e.key));
      this.write(e.key, e.text);
    }
    this.changed();
  }

  /** The DefaultQuests files as BetterQuesting would save them now (repo spellings kept). */
  files(): Map<string, string> {
    if (this.cache.version !== this.version) this.cache = { version: this.version };
    return (this.cache.files ??= matchBaseCase(saveDb(this.db), this.base.keys()));
  }

  /** Which files differ from the base data. */
  fileChanges(): FileChanges {
    const now = this.files();
    const changed: string[] = [], added: string[] = [], deleted: string[] = [];
    for (const [p, t] of now) {
      const b = this.base.get(p);
      if (b === undefined) added.push(p);
      else if (b !== t) changed.push(p);
    }
    for (const p of this.base.keys()) if (!now.has(p)) deleted.push(p);
    return { changed: changed.sort(), added: added.sort(), deleted: deleted.sort() };
  }

  /** The site's questbook model of the edited database. */
  questbook(): QuestbookData {
    if (this.cache.version !== this.version) this.cache = { version: this.version };
    return (this.cache.book ??= buildQuestbook(this.db, this.bundle.source));
  }
}

export interface Transaction {
  quest(id: string): BqObject | null;
  line(id: string): BqObject | null;
  entry(lineId: string, questId: string): BqObject | null;
  settings(): BqObject;
  lineOrder(): string[];
  set(key: ObjectKey, value: BqObject | string[] | null): void;
}

export const questKey = (id: string) => `q:${id}`;
export const lineKey = (id: string) => `l:${id}`;
export const entryKey = (lineId: string, questId: string) => `e:${lineId}:${questId}`;
export const SETTINGS_KEY = 's';
export const ORDER_KEY = 'o';
