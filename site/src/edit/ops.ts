// Edits as BetterQuesting's editor makes them, each one undo step on an EditDocument.
//
// Every operation writes the objects the way the game would save them after the same edit in its
// own editor: new quests and quest lines get the properties their constructors set up, task and
// reward lists keep BetterQuesting's ids, and prerequisites come out in the order of the HashSet
// the game keeps them in.

import type { BqObject, BqValue } from '../lib/bqjson.ts';
import { bqList, splitKey, uuidToB64 } from '../lib/bqjson.ts';
import { tagId } from '../lib/bqsave.ts';
import { type EditDocument, type Transaction, questKey, entryKey, lineKey, ORDER_KEY } from './document.ts';

const isObj = (v: BqValue | undefined): v is BqObject => !!v && typeof v === 'object' && !Array.isArray(v);

/** The "betterquesting" property compound of a quest or quest line tag (created when missing). */
export function bqProps(tag: BqObject): BqObject {
  if (!isObj(tag['properties:10'])) tag['properties:10'] = {};
  const props = tag['properties:10'] as BqObject;
  if (!isObj(props['betterquesting:10'])) props['betterquesting:10'] = {};
  return props['betterquesting:10'] as BqObject;
}

/** A property of a quest or quest line tag (undefined when it is not set). */
export function getProp(tag: BqObject | null | undefined, key: string): BqValue | undefined {
  const props = tag?.['properties:10'];
  const bq = isObj(props) ? props['betterquesting:10'] : undefined;
  return isObj(bq) ? bq[key] : undefined;
}

/** Set one of a quest's properties ("name:8", "visibility:8", ...). */
export function setQuestProperty(doc: EditDocument, questId: string, key: string, value: BqValue, label = 'Edit quest') {
  return setQuestsProperty(doc, [questId], key, value, label);
}

/** Set a property on several quests at once (the designer's icon and frame tools). */
export function setQuestsProperty(doc: EditDocument, questIds: string[], key: string, value: BqValue, label = 'Edit quest') {
  return doc.transact(label, (tx) => {
    for (const id of questIds) {
      const q = tx.quest(id);
      if (!q) continue;
      bqProps(q)[key] = clone(value);
      tx.set(questKey(id), q);
    }
  });
}

/** Set one of a quest line's properties. */
export function setLineProperty(doc: EditDocument, lineId: string, key: string, value: BqValue, label = 'Edit quest line') {
  return doc.transact(label, (tx) => {
    const l = tx.line(lineId);
    if (!l) return;
    bqProps(l)[key] = value;
    tx.set(lineKey(lineId), l);
  });
}

/** Move (and optionally resize) a quest's placement in a line (the designer's grab tool). */
export function placeQuest(
  doc: EditDocument, lineId: string, questId: string, x: number, y: number, size?: [number, number], label = 'Move quest',
) {
  return placeQuests(doc, lineId, [{ questId, x, y, w: size?.[0], h: size?.[1] }], label);
}

export interface Placement {
  questId: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
}

/** Move and resize several placements in one step (grab and scale on a selection). */
export function placeQuests(doc: EditDocument, lineId: string, places: Placement[], label = 'Move quests') {
  return doc.transact(label, (tx) => {
    for (const p of places) {
      const e = tx.entry(lineId, p.questId);
      if (!e) continue;
      e['x:3'] = Math.trunc(p.x);
      e['y:3'] = Math.trunc(p.y);
      if (p.w !== undefined) e['sizeX:3'] = Math.trunc(p.w);
      if (p.h !== undefined) e['sizeY:3'] = Math.trunc(p.h);
      tx.set(entryKey(lineId, p.questId), e);
    }
  });
}

// ---------------------------------------------------------------- ids and stacks

const clone = <T extends BqValue>(v: T): T =>
  (v && typeof v === 'object' ? (Array.isArray(v) ? v.map(clone) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]))) : v) as T;

export interface NewId {
  id: string;
  high: bigint;
  low: bigint;
}

/** UUID.randomUUID(): 122 random bits, version 4, IETF variant. */
export function randomId(taken: (id: string) => boolean = () => false): NewId {
  for (;;) {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const v = new DataView(b.buffer);
    const high = v.getBigInt64(0), low = v.getBigInt64(8);
    const id = uuidToB64(high, low);
    if (!taken(id)) return { id, high, low };
  }
}

/** The high and low halves of a base64 quest id. */
export function idHalves(id: string): [bigint, bigint] {
  const bin = atob(id.replace(/-/g, '+').replace(/_/g, '/'));
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = bin.charCodeAt(i);
  const v = new DataView(b.buffer);
  return [v.getBigInt64(0), v.getBigInt64(8)];
}

/** An item stack as BigItemStack.writeToNBT writes it. */
export function itemStackTag(id: string, damage = 0, count = 1, oreDict = '', tag?: BqObject): BqObject {
  const out: BqObject = { 'Count:3': count, 'Damage:2': damage, 'OreDict:8': oreDict, 'id:8': id };
  if (tag) out['tag:10'] = tag;
  return out;
}

/** A fluid stack as JsonHelper.FluidStackToJson writes it. */
export function fluidStackTag(name: string, amount = 1000, tag?: BqObject): BqObject {
  const out: BqObject = { 'Amount:3': amount, 'FluidName:8': name };
  if (tag) out['Tag:10'] = tag;
  return out;
}

/** A list tag ({"0:10": ..., "1:10": ...}) from compounds. */
export const compoundList = (items: BqObject[]): BqObject => Object.fromEntries(items.map((x, i) => [`${i}:10`, x]));

/** The compounds of a list tag, in index order. */
export const listItems = (v: BqValue | undefined): BqObject[] => bqList(v).filter(isObj);

// ---------------------------------------------------------------- new objects

/** QuestInstance's setupProps: what a quest made in game starts with. */
export function newQuestProps(): BqObject {
  return {
    'autoClaim:1': 0,
    'completion_animation:8': 'default',
    'completion_particle:8': 'default',
    'confetti_icon:10': itemStackTag('minecraft:stick', 0, 0),
    'countAsQuest:1': 1,
    'desc:8': 'No Description',
    'globalShare:1': 0,
    'icon:10': itemStackTag('minecraft:nether_star'),
    'isMain:1': 0,
    'isSilent:1': 0,
    'lockedProgress:1': 0,
    'name:8': 'New Quest',
    'notification_duration:5': -1,
    'notification_effect:3': -1,
    'notification_fade_in:5': -1,
    'notification_fade_out:5': -1,
    'notification_icon_offset_y:3': -2147483648,
    'notification_icon_scale:5': -1,
    'notification_pos_x:3': -2147483648,
    'notification_pos_y:3': -2147483648,
    'notification_show_icon:8': 'default',
    'notification_style:8': 'default',
    'notification_subtitle:8': '',
    'notification_subtitle_scale:5': -1,
    'notification_title:8': '',
    'notification_title_scale:5': -1,
    'particle_count:3': -1,
    'questLogic:8': 'AND',
    'repeatTime:3': -1,
    'repeat_relative:1': 1,
    'simultaneous:1': 0,
    'snd_complete:8': 'random.levelup',
    'snd_update:8': 'random.levelup',
    'taskLogic:8': 'AND',
    'visibility:8': 'NORMAL',
  };
}

/** A new quest's file: QuestInstance.writeToNBT plus its id, as "/bq_admin default save" writes it. */
export function newQuestTag(id: NewId, props = newQuestProps()): BqObject {
  return {
    'preRequisites:9': {},
    'properties:10': { 'betterquesting:10': props },
    'questIDHigh:4': id.high,
    'questIDLow:4': id.low,
    'rewards:9': {},
    'tasks:9': {},
  };
}

/** QuestLine's setupProps. */
export function newLineTag(id: NewId): BqObject {
  return {
    'properties:10': {
      'betterquesting:10': {
        'bg_image:8': '',
        'bg_size:3': 256,
        'desc:8': 'No Description',
        'icon:10': itemStackTag('minecraft:book'),
        'name:8': 'New Quest Line',
        'visibility:8': 'NORMAL',
      },
    },
    'questLineIDHigh:4': id.high,
    'questLineIDLow:4': id.low,
  };
}

/** A placement as QuestLineEntry.writeToNBT plus the quest id. */
export function entryTag(questId: string, x: number, y: number, w = 24, h = 24): BqObject {
  const [high, low] = idHalves(questId);
  return { 'questIDHigh:4': high, 'questIDLow:4': low, 'sizeX:3': w, 'sizeY:3': h, 'x:3': x, 'y:3': y };
}

// ---------------------------------------------------------------- prerequisites

/** A prerequisite: the quest it points at and its RequirementType (0 normal, 1 implicit, 2 hidden). */
export interface Prereq {
  id: string;
  type: number;
}

export function readPrereqs(quest: BqObject): Prereq[] {
  return listItems(quest['preRequisites:9']).map((r) => ({ id: tagId(r, 'quest'), type: Number(r['type:1'] ?? 0) }));
}

const i32 = (x: bigint) => Number(BigInt.asIntN(32, x));

/** HashMap's spread of UUID.hashCode(). */
function uuidHash(id: string): number {
  const [hi, lo] = idHalves(id);
  const x = BigInt.asIntN(64, hi ^ lo);
  const h = i32(x >> 32n) ^ i32(x);
  return (h ^ (h >>> 16)) | 0;
}

/**
 * The order a java.util.HashSet<UUID> filled in this order iterates in: by bucket, then by
 * insertion within a bucket. BetterQuesting keeps prerequisites in such a set and saves them in
 * its order (every quest in the modpack matches this).
 */
export function hashSetOrder(ids: string[]): string[] {
  const seen = new Set<string>();
  const items: { id: string; h: number; i: number }[] = [];
  let cap = 16;
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, h: uuidHash(id), i: items.length });
    if (items.length > cap * 0.75) cap *= 2;
  }
  return items.sort((a, b) => (a.h & (cap - 1)) - (b.h & (cap - 1)) || a.i - b.i).map((x) => x.id);
}

/** Write a quest's prerequisites, given in the order they were added to the game's set. */
export function writePrereqs(quest: BqObject, list: Prereq[]) {
  const type = new Map(list.map((p) => [p.id, p.type]));
  quest['preRequisites:9'] = compoundList(
    hashSetOrder(list.map((p) => p.id)).map((id) => {
      const [high, low] = idHalves(id);
      const t: BqObject = { 'questIDHigh:4': high, 'questIDLow:4': low };
      const k = type.get(id) ?? 0;
      if (k) t['type:1'] = k;
      return t;
    }),
  );
}

/** Add (or with remove, take out) prerequisites of a quest (GuiPrerequisiteEditor). */
export function editPrereqs(doc: EditDocument, questId: string, f: (list: Prereq[]) => Prereq[], label: string) {
  return doc.transact(label, (tx) => {
    const q = tx.quest(questId);
    if (!q) return;
    writePrereqs(q, f(readPrereqs(q)));
    tx.set(questKey(questId), q);
  });
}

export const addPrereq = (doc: EditDocument, questId: string, preId: string) =>
  editPrereqs(doc, questId, (l) => (l.some((p) => p.id === preId) ? l : [...l, { id: preId, type: 0 }]), 'Add prerequisite');

export const removePrereq = (doc: EditDocument, questId: string, preId: string) =>
  editPrereqs(doc, questId, (l) => l.filter((p) => p.id !== preId), 'Remove prerequisite');

/** RequirementType.next(): normal, implicit, hidden. */
export const cyclePrereqType = (doc: EditDocument, questId: string, preId: string) =>
  editPrereqs(doc, questId, (l) => l.map((p) => (p.id === preId ? { ...p, type: (p.type + 1) % 3 } : p)), 'Change prerequisite type');

/**
 * The designer's link tool: link `from` quests to `to`. Where neither already requires the other,
 * each becomes a prerequisite of `to`; otherwise both links are taken away.
 */
export function toggleLinks(doc: EditDocument, from: string[], to: string) {
  return doc.transact('Link quests', (tx) => {
    const q2 = tx.quest(to);
    if (!q2) return;
    let pre2 = readPrereqs(q2);
    let mod2 = false;
    for (const id of from) {
      if (id === to) continue;
      const q1 = tx.quest(id);
      const pre1 = q1 ? readPrereqs(q1) : [];
      if (!pre2.some((p) => p.id === id) && !pre1.some((p) => p.id === to)) {
        pre2 = [...pre2, { id, type: 0 }];
        mod2 = true;
      } else {
        if (pre2.some((p) => p.id === id)) {
          pre2 = pre2.filter((p) => p.id !== id);
          mod2 = true;
        }
        if (q1 && pre1.some((p) => p.id === to)) {
          writePrereqs(q1, pre1.filter((p) => p.id !== to));
          tx.set(questKey(id), q1);
        }
      }
    }
    if (mod2) {
      writePrereqs(q2, pre2);
      tx.set(questKey(to), q2);
    }
  });
}

// ---------------------------------------------------------------- quests

/** Create a quest (with a tag, or a new empty one), optionally placed in a line. */
export function createQuest(
  doc: EditDocument, at?: { lineId: string; x: number; y: number; w?: number; h?: number }, label = 'New quest',
): string | null {
  const id = randomId((x) => doc.db.quests.has(x));
  const ok = doc.transact(label, (tx) => {
    tx.set(questKey(id.id), newQuestTag(id));
    if (at && doc.db.lines.has(at.lineId)) tx.set(entryKey(at.lineId, id.id), entryTag(id.id, at.x, at.y, at.w, at.h));
  });
  return ok ? id.id : null;
}

/** Remove quests from the database, from every line and from every other quest's prerequisites. */
export function deleteQuests(doc: EditDocument, ids: string[], label = ids.length > 1 ? 'Delete quests' : 'Delete quest') {
  const gone = new Set(ids);
  return doc.transact(label, (tx) => deleteIn(doc, tx, gone));
}

function deleteIn(doc: EditDocument, tx: Transaction, gone: Set<string>) {
  for (const id of gone) {
    for (const [lineId, line] of doc.db.lines) if (line.entries.has(id)) tx.set(entryKey(lineId, id), null);
    tx.set(questKey(id), null);
  }
  for (const [qid, q] of doc.db.quests) {
    const pre = readPrereqs(q);
    if (!pre.some((p) => gone.has(p.id))) continue;
    const copy = tx.quest(qid)!;
    writePrereqs(copy, pre.filter((p) => !gone.has(p.id)));
    tx.set(questKey(qid), copy);
  }
}

/** Put a quest in a line at the first free spot from the top left (GuiQuestLineAddRemove). */
export function addToLine(doc: EditDocument, lineId: string, questId: string) {
  const line = doc.db.lines.get(lineId);
  if (!line || line.entries.has(questId)) return false;
  let x = 0, y = 0;
  search: for (;;) {
    for (const e of line.entries.values()) {
      const ex = Number(e['x:3'] ?? 0), ey = Number(e['y:3'] ?? 0);
      const s = Math.max(Number(e['sizeX:3'] ?? 24), Number(e['sizeY:3'] ?? 24));
      if (x >= ex && x < ex + s && y >= ey && y < ey + s) {
        x += s;
        y += s;
        continue search;
      }
    }
    break;
  }
  return doc.transact('Add quest to line', (tx) => tx.set(entryKey(lineId, questId), entryTag(questId, x, y)));
}

/** Take quests out of a line (they stay in the database). */
export function removeFromLine(doc: EditDocument, lineId: string, questIds: string[]) {
  return doc.transact(questIds.length > 1 ? 'Remove quests from line' : 'Remove quest from line', (tx) => {
    for (const id of questIds) if (tx.entry(lineId, id)) tx.set(entryKey(lineId, id), null);
  });
}

/**
 * The designer's copy tool: new quests with the copied quests' data, placed where they were
 * dropped. Prerequisites among the copied quests point at their copies.
 */
export function copyQuests(doc: EditDocument, lineId: string, copies: Placement[]) {
  if (!doc.db.lines.has(lineId)) return [];
  const newIds = new Map<string, NewId>();
  for (const c of copies) newIds.set(c.questId, randomId((x) => doc.db.quests.has(x) || [...newIds.values()].some((n) => n.id === x)));
  const ok = doc.transact(copies.length > 1 ? 'Copy quests' : 'Copy quest', (tx) => {
    for (const c of copies) {
      const src = tx.quest(c.questId);
      const nid = newIds.get(c.questId)!;
      if (!src) continue;
      const tag = src;
      tag['questIDHigh:4'] = nid.high;
      tag['questIDLow:4'] = nid.low;
      // readFromNBT on the copy: countAsQuest always ends up set.
      const props = bqProps(tag);
      if (!('countAsQuest:1' in props)) props['countAsQuest:1'] = 1;
      const pre = readPrereqs(tag);
      if (pre.some((p) => newIds.has(p.id))) {
        // The game removes the old ids from a copy of the set and adds the new ones.
        const kept = pre.filter((p) => !newIds.has(p.id));
        const remapped = pre.filter((p) => newIds.has(p.id)).map((p) => ({ id: newIds.get(p.id)!.id, type: p.type }));
        writePrereqs(tag, [...kept, ...remapped]);
      }
      tx.set(questKey(nid.id), tag);
      tx.set(entryKey(lineId, nid.id), entryTag(nid.id, c.x, c.y, c.w, c.h));
    }
  });
  return ok ? copies.map((c) => newIds.get(c.questId)!.id) : [];
}

/** Replace a quest's whole tag (the advanced NBT editor). Its id stays. */
export function setQuestTag(doc: EditDocument, questId: string, tag: BqObject, label = 'Edit quest') {
  return doc.transact(label, (tx) => {
    if (!tx.quest(questId)) return;
    const [high, low] = idHalves(questId);
    // QuestInstance keeps its properties, tasks, rewards and prerequisites; other keys are lost.
    const t: BqObject = {};
    for (const k of ['properties:10', 'tasks:9', 'rewards:9', 'preRequisites:9']) if (k in tag) t[k] = clone(tag[k]);
    t['questIDHigh:4'] = high;
    t['questIDLow:4'] = low;
    // QuestInstance.readFromNBT puts countAsQuest back and setupProps fills in the rest.
    const props = bqProps(t);
    const defaults = newQuestProps();
    for (const [k, v] of Object.entries(defaults)) {
      if (!(k in props) && k !== 'name:8' && k !== 'desc:8' && k !== 'icon:10') props[k] = v;
    }
    if (!('name:8' in props)) props['name:8'] = 'New Quest';
    if (!('desc:8' in props)) props['desc:8'] = 'No Description';
    if (!('icon:10' in props)) props['icon:10'] = defaults['icon:10'];
    for (const k of ['preRequisites:9', 'tasks:9', 'rewards:9']) if (!isObj(t[k])) t[k] = {};
    // The game keeps prerequisites in a set and rebuilds tasks and rewards from their types.
    writePrereqs(t, readPrereqs(t));
    for (const kind of ['tasks', 'rewards'] as Kind[]) {
      const list = readEntries(t, kind);
      const used = new Set(list.map(entryIndex).filter((i) => i >= 0));
      let next = 0;
      const fixed = list.map((e) => {
        let i = entryIndex(e);
        if (i < 0) {
          while (used.has(next)) next++;
          used.add((i = next));
        }
        return normalizeEntry(kind, e, entryType(e, kind), i);
      });
      writeEntries(t, kind, fixed);
    }
    tx.set(questKey(questId), t);
  });
}

// ---------------------------------------------------------------- quest lines

/** NetChapterEdit.requestCreate: a new quest line at the end of the order. */
export function createLine(doc: EditDocument): string | null {
  const id = randomId((x) => doc.db.lines.has(x));
  const ok = doc.transact('New quest line', (tx) => {
    const order = tx.lineOrder();
    tx.set(lineKey(id.id), newLineTag(id));
    tx.set(ORDER_KEY, [...order, id.id]);
  });
  return ok ? id.id : null;
}

/** Delete a quest line (its quests stay in the database). */
export function deleteLine(doc: EditDocument, lineId: string) {
  const line = doc.db.lines.get(lineId);
  if (!line) return false;
  return doc.transact('Delete quest line', (tx) => {
    // The order first, so undo has the order with the line in it.
    tx.set(ORDER_KEY, tx.lineOrder().filter((x) => x !== lineId));
    for (const qid of [...line.entries.keys()]) tx.set(entryKey(lineId, qid), null);
    tx.set(lineKey(lineId), null);
  });
}

/** Swap a quest line with the one above it (GuiQuestLinesEditor's up arrow). */
export function moveLineUp(doc: EditDocument, lineId: string) {
  return doc.transact('Move quest line', (tx) => {
    const order = tx.lineOrder();
    const i = order.indexOf(lineId);
    if (i <= 0) return;
    [order[i - 1], order[i]] = [order[i], order[i - 1]];
    tx.set(ORDER_KEY, order);
  });
}

/** Replace a quest line's QuestLine.json content (the designer's raw editor). */
export function setLineTag(doc: EditDocument, lineId: string, tag: BqObject, label = 'Edit quest line') {
  return doc.transact(label, (tx) => {
    if (!tx.line(lineId)) return;
    const [high, low] = idHalves(lineId);
    // A quest line saves its properties (and its placements, kept elsewhere); other keys are lost.
    const t: BqObject = isObj(tag['properties:10']) ? { 'properties:10': clone(tag['properties:10']) } : {};
    t['questLineIDHigh:4'] = high;
    t['questLineIDLow:4'] = low;
    fillLineDefaults(t, lineId);
    tx.set(lineKey(lineId), t);
  });
}

/** QuestLine.readFromNBT then setupProps: missing properties get their defaults. */
function fillLineDefaults(t: BqObject, lineId: string) {
  const [high, low] = idHalves(lineId);
  const props = bqProps(t);
  const defaults = bqProps(newLineTag({ id: lineId, high, low }));
  for (const [k, v] of Object.entries(defaults)) if (!(k in props)) props[k] = v;
}

/** UUID.compareTo: the high halves, then the low halves, as signed numbers. */
const compareIds = (a: string, b: string) => {
  const [ah, al] = idHalves(a), [bh, bl] = idHalves(b);
  return ah < bh ? -1 : ah > bh ? 1 : al < bl ? -1 : al > bl ? 1 : 0;
};

/**
 * A quest line as the designer's raw editor shows it (QuestLine.writeToNBT: its properties and a
 * "quests" list of placements, in the database's stable order).
 */
export function lineWithQuests(doc: EditDocument, lineId: string): BqObject | null {
  const line = doc.db.lines.get(lineId);
  if (!line) return null;
  const tag = clone(line.tag);
  delete tag['questLineIDHigh:4'];
  delete tag['questLineIDLow:4'];
  const entries = [...line.entries].sort((a, b) => compareIds(a[0], b[0])).map(([, e]) => clone(e));
  tag['quests:9'] = compoundList(entries);
  return tag;
}

/** Apply the designer's raw editor: properties, and the placements from its "quests" list. */
export function setLineWithQuests(doc: EditDocument, lineId: string, tag: BqObject) {
  const line = doc.db.lines.get(lineId);
  if (!line) return false;
  return doc.transact('Edit quest line', (tx) => {
    const quests = listItems(tag['quests:9']);
    const t: BqObject = isObj(tag['properties:10']) ? { 'properties:10': clone(tag['properties:10']) } : {};
    const [high, low] = idHalves(lineId);
    t['questLineIDHigh:4'] = high;
    t['questLineIDLow:4'] = low;
    fillLineDefaults(t, lineId);
    tx.set(lineKey(lineId), t);
    const keep = new Set<string>();
    for (const e of quests) {
      if (!('questIDHigh:4' in e) || !('questIDLow:4' in e)) continue;
      const qid = tagId(e, 'quest');
      keep.add(qid);
      // QuestLineEntry keeps x, y and the size; "size" is the old single size.
      const sx = Number(e['sizeX:3'] ?? e['size:3'] ?? 24), sy = Number(e['sizeY:3'] ?? e['size:3'] ?? 24);
      tx.set(entryKey(lineId, qid), entryTag(qid, Number(e['x:3'] ?? 0), Number(e['y:3'] ?? 0), sx, sy));
    }
    for (const qid of line.entries.keys()) if (!keep.has(qid)) tx.set(entryKey(lineId, qid), null);
  });
}

// ---------------------------------------------------------------- tasks and rewards

export type Kind = 'tasks' | 'rewards';
const KIND = {
  tasks: { list: 'tasks:9', id: 'taskID:8' },
  rewards: { list: 'rewards:9', id: 'rewardID:8' },
} as const;

/** What each registered type writes when made new (writeToNBT of a fresh instance). */
export const TASK_TYPES: Record<string, BqObject> = {
  'bq_standard:block_break': {
    'blocks:9': { '0:10': { 'amount:3': 1, 'blockID:8': 'minecraft:log', 'meta:3': -1, 'nbt:10': {}, 'oreDict:8': '' } },
  },
  'bq_standard:checkbox': {},
  'bq_standard:crafting': {
    'allowAnvil:1': 0, 'allowCraft:1': 1, 'allowCraftedFromStatistics:1': 0, 'allowSmelt:1': 1, 'ignoreNBT:1': 1,
    'partialMatch:1': 1, 'requiredItems:9': {},
  },
  'bq_standard:fluid': { 'autoConsume:1': 0, 'consume:1': 1, 'groupDetect:1': 0, 'ignoreNBT:1': 1, 'requiredFluids:9': {} },
  'bq_standard:hunt': {
    'damageType:8': '', 'ignoreNBT:1': 1, 'required:3': 1, 'subtypes:1': 1, 'target:8': 'Zombie', 'targetNBT:10': {},
  },
  'bq_standard:interact_entity': {
    'ignoreItemNBT:1': 0, 'ignoreTargetNBT:1': 1, 'item:10': {}, 'onHit:1': 0, 'onInteract:1': 1, 'partialItemMatch:1': 1,
    'requiredUses:3': 1, 'targetID:8': 'Villager', 'targetNBT:10': {}, 'targetSubtypes:1': 1,
  },
  'bq_standard:interact_item': {
    'block:10': { 'amount:3': 1, 'blockID:8': '', 'meta:3': -1, 'nbt:10': {}, 'oreDict:8': '' },
    'ignoreNbt:1': 1, 'item:10': {}, 'onHit:1': 0, 'onInteract:1': 1, 'partialMatch:1': 1, 'requiredUses:3': 1,
  },
  'bq_standard:location': {
    'biome:3': -1, 'dimension:3': 0, 'hideInfo:1': 0, 'invert:1': 0, 'name:8': 'New Location', 'posX:3': 0, 'posY:3': 0,
    'posZ:3': 0, 'range:3': -1, 'structure:8': '', 'taxiCabDist:1': 0, 'visible:1': 0,
  },
  'bq_standard:meeting': {
    'amount:3': 1, 'ignoreNBT:1': 1, 'range:3': 4, 'subtypes:1': 1, 'target:8': 'Villager', 'targetNBT:10': {},
  },
  'bq_standard:optional_retrieval': {
    'autoConsume:1': 0, 'consume:1': 0, 'groupDetect:1': 0, 'ignoreNBT:1': 1, 'partialMatch:1': 1,
    'requireOnlyOneItem:1': 0, 'requiredItems:9': {},
  },
  'bq_standard:retrieval': {
    'autoConsume:1': 0, 'consume:1': 0, 'groupDetect:1': 0, 'ignoreNBT:1': 1, 'partialMatch:1': 1,
    'requireOnlyOneItem:1': 0, 'requiredItems:9': {},
  },
  'bq_standard:scoreboard': {
    'operation:8': 'MORE_OR_EQUAL', 'scoreDisp:8': 'Score', 'scoreName:8': 'Score', 'target:3': 1, 'type:8': 'dummy',
    'unitConversion:5': 1, 'unitSuffix:8': '',
  },
  'bq_standard:xp': { 'amount:3': 30, 'consume:1': 1, 'isLevels:1': 1 },
};

export const REWARD_TYPES: Record<string, BqObject> = {
  'bq_standard:choice': { 'choices:9': {}, 'ignoreDisabled:1': 0 },
  'bq_standard:command': {
    'command:8': '/say VAR_NAME Claimed a reward', 'hideCommand:1': 0, 'ignoreDisabled:1': 1, 'viaPlayer:1': 0,
  },
  'bq_standard:item': { 'ignoreDisabled:1': 0, 'rewards:9': {} },
  'bq_standard:questcompletion': { 'ignoreDisabled:1': 0, 'isSilent:1': 0, 'questID:8': '' },
  'bq_standard:scoreboard': { 'ignoreDisabled:1': 1, 'relative:1': 1, 'score:8': 'Reputation', 'type:8': 'dummy', 'value:3': 1 },
  'bq_standard:xp': { 'amount:3': 1, 'ignoreDisabled:1': 0, 'isLevels:1': 1 },
};

const typesOf = (kind: Kind) => (kind === 'tasks' ? TASK_TYPES : REWARD_TYPES);

/** A quest's tasks or rewards, in BetterQuesting's order (by id). */
export function readEntries(quest: BqObject, kind: Kind): BqObject[] {
  return listItems(quest[KIND[kind].list]);
}

export const entryType = (e: BqObject, kind: Kind) => String(e[KIND[kind].id] ?? '');
export const entryIndex = (e: BqObject) => Number(e['index:3'] ?? -1);

function writeEntries(quest: BqObject, kind: Kind, list: BqObject[]) {
  quest[KIND[kind].list] = compoundList([...list].sort((a, b) => entryIndex(a) - entryIndex(b)));
}

/**
 * What the game keeps of an edited task or reward: readFromNBT then writeToNBT keeps the keys its
 * type writes (missing ones take their defaults) and drops the rest. Unknown types keep everything.
 */
export function normalizeEntry(kind: Kind, tag: BqObject, type: string, index: number): BqObject {
  const def = typesOf(kind)[type];
  let out: BqObject;
  if (!def) out = clone(tag);
  else {
    out = {};
    for (const [k, v] of Object.entries(def)) {
      const [name, t] = splitKey(k);
      const have = Object.keys(tag).find((x) => splitKey(x)[0] === name);
      out[k] = have !== undefined && splitKey(have)[1] === t ? clone(tag[have]) : clone(v);
    }
  }
  out[KIND[kind].id] = type;
  out['index:3'] = index;
  return out;
}

/** Add a task or reward of a type (TaskStorage.nextID: the lowest free id). */
export function addEntry(doc: EditDocument, questId: string, kind: Kind, type: string) {
  return doc.transact(kind === 'tasks' ? 'Add task' : 'Add reward', (tx) => {
    const q = tx.quest(questId);
    if (!q) return;
    const list = readEntries(q, kind);
    const used = new Set(list.map(entryIndex));
    let id = 0;
    while (used.has(id)) id++;
    list.push(normalizeEntry(kind, typesOf(kind)[type] ?? {}, type, id));
    writeEntries(q, kind, list);
    tx.set(questKey(questId), q);
  });
}

/** Remove the task or reward at a position in the list. */
export function removeEntry(doc: EditDocument, questId: string, kind: Kind, pos: number) {
  return doc.transact(kind === 'tasks' ? 'Remove task' : 'Remove reward', (tx) => {
    const q = tx.quest(questId);
    if (!q) return;
    const list = readEntries(q, kind);
    if (pos < 0 || pos >= list.length) return;
    list.splice(pos, 1);
    writeEntries(q, kind, list);
    tx.set(questKey(questId), q);
  });
}

/** Replace the task or reward at a position (its editor's result). Its type and id stay. */
export function setEntry(doc: EditDocument, questId: string, kind: Kind, pos: number, tag: BqObject) {
  return doc.transact(kind === 'tasks' ? 'Edit task' : 'Edit reward', (tx) => {
    const q = tx.quest(questId);
    if (!q) return;
    const list = readEntries(q, kind);
    const old = list[pos];
    if (!old) return;
    list[pos] = normalizeEntry(kind, tag, entryType(old, kind), entryIndex(old));
    writeEntries(q, kind, list);
    tx.set(questKey(questId), q);
  });
}
