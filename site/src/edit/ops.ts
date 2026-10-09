// Edits as BetterQuesting's editor makes them, each one undo step on an EditDocument.

import type { BqObject, BqValue } from '../lib/bqjson.ts';
import { type EditDocument, questKey, entryKey, lineKey } from './document.ts';

const isObj = (v: BqValue | undefined): v is BqObject => !!v && typeof v === 'object' && !Array.isArray(v);

/** The "betterquesting" property compound of a quest or quest line tag (created when missing). */
export function bqProps(tag: BqObject): BqObject {
  if (!isObj(tag['properties:10'])) tag['properties:10'] = {};
  const props = tag['properties:10'] as BqObject;
  if (!isObj(props['betterquesting:10'])) props['betterquesting:10'] = {};
  return props['betterquesting:10'] as BqObject;
}

/** Set one of a quest's properties ("name:8", "visibility:8", ...). */
export function setQuestProperty(doc: EditDocument, questId: string, key: string, value: BqValue, label = 'Edit quest') {
  return doc.transact(label, (tx) => {
    const q = tx.quest(questId);
    if (!q) return;
    bqProps(q)[key] = value;
    tx.set(questKey(questId), q);
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
  return doc.transact(label, (tx) => {
    const e = tx.entry(lineId, questId);
    if (!e) return;
    e['x:3'] = Math.trunc(x);
    e['y:3'] = Math.trunc(y);
    if (size) {
      e['sizeX:3'] = Math.trunc(size[0]);
      e['sizeY:3'] = Math.trunc(size[1]);
    }
    tx.set(entryKey(lineId, questId), e);
  });
}
