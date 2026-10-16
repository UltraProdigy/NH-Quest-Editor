import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { EditDocument, type RawBundle } from '../src/edit/document.ts';
import {
  hashSetOrder, readPrereqs, addPrereq, removePrereq, cyclePrereqType, toggleLinks, createQuest, deleteQuests, addToLine,
  removeFromLine, copyQuests, createLine, deleteLine, moveLineUp, addEntry, removeEntry, setEntry, readEntries,
  normalizeEntry, entryType, entryIndex, TASK_TYPES, REWARD_TYPES, setQuestsProperty, lineWithQuests, setLineWithQuests,
  setQuestTag, randomId, idHalves, getProp, type Kind,
} from '../src/edit/ops.ts';
import { loadDb, saveDb } from '../src/lib/bqsave.ts';
import { parseBq, uuidToB64, splitKey, type BqObject } from '../src/lib/bqjson.ts';
import { writeBq } from '../src/lib/bqwrite.ts';

test('random ids are version 4 UUIDs and decode back', () => {
  for (let i = 0; i < 50; i++) {
    const id = randomId();
    assert.equal(uuidToB64(id.high, id.low), id.id);
    assert.deepEqual(idHalves(id.id), [id.high, id.low]);
    assert.equal(Number((BigInt.asUintN(64, id.high) >> 12n) & 0xfn), 4);
    assert.equal(Number(BigInt.asUintN(64, id.low) >> 62n), 2);
  }
});

const questsDir = process.env.QUESTS_DIR;
const skip = !questsDir || !existsSync(questsDir) ? 'QUESTS_DIR not set' : false;

let cached: RawBundle | null = null;
function bundle(): RawBundle {
  if (cached) return cached;
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(questsDir!, p).split('\\').join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(questsDir!);
  return (cached = { format: 1, source: { repo: 'test', commit: 'base', date: '' }, root: 'x', files });
}

const unchanged = (doc: EditDocument) => assert.deepEqual(doc.fileChanges(), { changed: [], added: [], deleted: [] });

test('prerequisites are written in HashSet order, as every quest in the modpack is', { skip }, () => {
  const doc = new EditDocument(bundle());
  let checked = 0;
  for (const q of doc.db.quests.values()) {
    const ids = readPrereqs(q).map((p) => p.id);
    if (ids.length < 2) continue;
    assert.deepEqual(hashSetOrder(ids), ids);
    checked++;
  }
  assert.ok(checked > 100);
});

test('tasks and rewards: the editor writes them as the game does', { skip }, () => {
  const doc = new EditDocument(bundle());
  const seen: Record<Kind, Map<string, string>> = { tasks: new Map(), rewards: new Map() };
  for (const q of doc.db.quests.values()) {
    for (const kind of ['tasks', 'rewards'] as Kind[]) {
      for (const e of readEntries(q, kind)) {
        const type = entryType(e, kind);
        const known = (kind === 'tasks' ? TASK_TYPES : REWARD_TYPES)[type];
        assert.ok(known, `${kind} type ${type} has defaults`);
        // Reading and writing a saved entry gives it back unchanged.
        assert.equal(writeBq(normalizeEntry(kind, e, type, entryIndex(e))), writeBq(e));
        // A new one has the same keys as the saved ones.
        const keys = Object.keys(normalizeEntry(kind, known, type, 0)).sort().join();
        if (!seen[kind].has(type)) seen[kind].set(type, Object.keys(e).sort().join());
        assert.equal(keys, Object.keys(e).sort().join(), `${type} keys`);
      }
    }
  }
  assert.ok(seen.tasks.size >= 5 && seen.rewards.size >= 3);
});

test('new quests and quest lines save as BetterQuesting writes them and undo cleanly', { skip }, () => {
  const doc = new EditDocument(bundle());
  const lineId = [...doc.db.lines.keys()][0];
  const qid = createQuest(doc, { lineId, x: 1000, y: 1000 })!;
  assert.ok(qid);
  const files = doc.files();
  const added = doc.fileChanges().added;
  assert.equal(added.length, 2, JSON.stringify(added));
  const questFile = added.find((p) => p.startsWith('Quests/'))!;
  assert.match(questFile, /\/NewQuest-.*\.json$/);
  const tag = parseBq(files.get(questFile)!) as BqObject;
  assert.equal(getProp(tag, 'name:8'), 'New Quest');
  assert.equal(getProp(tag, 'notification_duration:5'), -1);
  assert.ok(files.get(questFile)!.includes('"notification_duration:5": -1.0'));
  // It loads back as the same quest.
  const again = loadDb(files);
  assert.equal(writeBq(again.quests.get(qid)!), writeBq(doc.db.quests.get(qid)!));
  assert.ok(doc.questbook().quests[qid]);
  assert.ok(doc.questbook().lines.find((l) => l.id === lineId)!.quests.some((p) => p[0] === qid));

  const newLine = createLine(doc)!;
  const order = doc.files().get('QuestLinesOrder.txt')!.trim().split('\n');
  assert.equal(order[order.length - 1], `${newLine}: New Quest Line`);
  assert.ok(doc.fileChanges().added.some((p) => p.startsWith('QuestLines/NewQuestLine-')));

  assert.ok(doc.undo() && doc.undo());
  unchanged(doc);
});

test('deleting quests and lines, and putting them back', { skip }, () => {
  const doc = new EditDocument(bundle());
  // A quest that others depend on.
  let target = '';
  for (const q of doc.db.quests.values()) for (const p of readPrereqs(q)) target ||= doc.db.quests.has(p.id) ? p.id : '';
  const dependants = [...doc.db.quests].filter(([, q]) => readPrereqs(q).some((p) => p.id === target)).map(([id]) => id);
  assert.ok(target && dependants.length);
  assert.ok(deleteQuests(doc, [target]));
  assert.ok(!doc.db.quests.has(target));
  for (const id of dependants) assert.ok(!readPrereqs(doc.db.quests.get(id)!).some((p) => p.id === target));
  for (const l of doc.db.lines.values()) assert.ok(!l.entries.has(target));
  doc.undo();
  unchanged(doc);

  const lines = [...doc.db.lines.keys()];
  assert.ok(deleteLine(doc, lines[2]));
  assert.equal(doc.db.lines.size, lines.length - 1);
  doc.undo();
  assert.deepEqual([...doc.db.lines.keys()], lines);
  unchanged(doc);

  assert.ok(moveLineUp(doc, lines[3]));
  assert.deepEqual([...doc.db.lines.keys()].slice(2, 4), [lines[3], lines[2]]);
  assert.ok(!moveLineUp(doc, [...doc.db.lines.keys()][0]));
  doc.undo();
  unchanged(doc);

  // Autosave restores a deleted line and a reorder on fresh data.
  deleteLine(doc, lines[5]);
  moveLineUp(doc, lines[1]);
  const fresh = new EditDocument(bundle());
  fresh.restore(doc.edits());
  sameFiles(fresh, doc);
});

/** The same files (compared one by one: a failing deepEqual over every file runs out of memory). */
function sameFiles(a: EditDocument, b: EditDocument) {
  const fa = a.files(), fb = b.files();
  assert.deepEqual([...fa.keys()].sort(), [...fb.keys()].sort());
  for (const [p, t] of fb) assert.ok(fa.get(p) === t, `${p} differs:\n${fa.get(p)?.slice(0, 300)}\n---\n${t.slice(0, 300)}`);
}

test('prerequisite editing and the link tool', { skip }, () => {
  const doc = new EditDocument(bundle());
  const ids = [...doc.db.quests.keys()];
  const [a, b, c] = [ids[10], ids[20], ids[30]];
  const pre = (id: string) => readPrereqs(doc.db.quests.get(id)!);
  const before = pre(a).length;
  assert.ok(addPrereq(doc, a, b));
  assert.ok(!addPrereq(doc, a, b));
  assert.equal(pre(a).length, before + 1);
  assert.ok(cyclePrereqType(doc, a, b));
  assert.equal(pre(a).find((p) => p.id === b)!.type, 1);
  assert.ok(doc.files().get([...doc.fileChanges().changed][0])!.includes('"type:1": 1'));
  cyclePrereqType(doc, a, b);
  cyclePrereqType(doc, a, b);
  assert.equal(pre(a).find((p) => p.id === b)!.type, 0);
  assert.ok(removePrereq(doc, a, b));
  assert.equal(pre(a).length, before);

  // Linking c -> a adds c as a's prerequisite; linking again (either way) removes it.
  assert.ok(toggleLinks(doc, [c], a));
  assert.ok(pre(a).some((p) => p.id === c));
  assert.ok(toggleLinks(doc, [a], c));
  assert.ok(!pre(a).some((p) => p.id === c) && !pre(c).some((p) => p.id === a));
  while (doc.undo());
  unchanged(doc);
});

test('line placement: add, remove, copy', { skip }, () => {
  const doc = new EditDocument(bundle());
  const lineId = [...doc.db.lines.keys()][1];
  const line = doc.db.lines.get(lineId)!;
  const outside = [...doc.db.quests.keys()].find((id) => !line.entries.has(id))!;
  assert.ok(addToLine(doc, lineId, outside));
  const e = line.entries.get(outside)!;
  // The first free spot along the diagonal.
  for (const [id, o] of line.entries) {
    if (id === outside) continue;
    const x = Number(e['x:3']), y = Number(e['y:3']), ox = Number(o['x:3']), oy = Number(o['y:3']);
    const s = Math.max(Number(o['sizeX:3']), Number(o['sizeY:3']));
    assert.ok(!(x >= ox && x < ox + s && y >= oy && y < oy + s));
  }
  assert.ok(removeFromLine(doc, lineId, [outside]));
  assert.ok(!line.entries.has(outside));

  // Copy two quests where one requires the other: the copy requires the other's copy.
  let pair: [string, string] | null = null;
  for (const id of line.entries.keys()) {
    const p = readPrereqs(doc.db.quests.get(id)!).find((x) => line.entries.has(x.id));
    if (p) {
      pair = [p.id, id];
      break;
    }
  }
  assert.ok(pair);
  const [parent, child] = pair!;
  const made = copyQuests(doc, lineId, [
    { questId: parent, x: -500, y: -500, w: 24, h: 24 },
    { questId: child, x: -500, y: -450, w: 32, h: 32 },
  ]);
  assert.equal(made.length, 2);
  const childCopy = doc.db.quests.get(made[1])!;
  assert.ok(readPrereqs(childCopy).some((p) => p.id === made[0]));
  assert.ok(!readPrereqs(childCopy).some((p) => p.id === parent));
  assert.equal(getProp(childCopy, 'name:8'), getProp(doc.db.quests.get(child)!, 'name:8'));
  assert.equal(Number(line.entries.get(made[1])!['sizeX:3']), 32);
  while (doc.undo());
  unchanged(doc);
});

test('task and reward lists keep their ids', { skip }, () => {
  const doc = new EditDocument(bundle());
  const qid = [...doc.db.quests].find(([, q]) => readEntries(q, 'tasks').length >= 2)![0];
  const q = () => doc.db.quests.get(qid)!;
  const n = readEntries(q(), 'tasks').length;
  assert.ok(removeEntry(doc, qid, 'tasks', 0));
  assert.ok(addEntry(doc, qid, 'tasks', 'bq_standard:checkbox'));
  const list = readEntries(q(), 'tasks');
  assert.equal(list.length, n);
  // The new task takes the freed id 0 and goes first.
  assert.equal(entryType(list[0], 'tasks'), 'bq_standard:checkbox');
  assert.equal(entryIndex(list[0]), 0);
  // Edits keep the type and id, fill in missing keys and drop unknown ones.
  assert.ok(addEntry(doc, qid, 'rewards', 'bq_standard:xp'));
  const rewards = readEntries(q(), 'rewards');
  const pos = rewards.findIndex((r) => entryType(r, 'rewards') === 'bq_standard:xp');
  assert.ok(setEntry(doc, qid, 'rewards', pos, { 'amount:3': 5, 'junk:8': 'x', 'rewardID:8': 'bq_standard:item' }));
  const r = readEntries(q(), 'rewards')[pos];
  assert.equal(r['amount:3'], 5);
  assert.equal(r['isLevels:1'], 1);
  assert.equal(r['rewardID:8'], 'bq_standard:xp');
  assert.ok(!('junk:8' in r));
  while (doc.undo());
  unchanged(doc);
});

test('designer tools on many quests, raw line editing and the advanced quest editor', { skip }, () => {
  const doc = new EditDocument(bundle());
  const lineId = [...doc.db.lines.keys()][0];
  const ids = [...doc.db.lines.get(lineId)!.entries.keys()].slice(0, 3);
  assert.ok(setQuestsProperty(doc, ids, 'isMain:1', 1, 'Change frame'));
  for (const id of ids) assert.equal(getProp(doc.db.quests.get(id)!, 'isMain:1'), 1);
  doc.undo();

  // The raw line editor round trips.
  const raw = lineWithQuests(doc, lineId)!;
  assert.ok(!setLineWithQuests(doc, lineId, raw));
  unchanged(doc);
  const quests = raw['quests:9'] as BqObject;
  const first = quests[Object.keys(quests)[0]] as BqObject;
  first['x:3'] = Number(first['x:3']) + 4;
  assert.ok(setLineWithQuests(doc, lineId, raw));
  assert.equal(doc.fileChanges().changed.length, 1);
  doc.undo();

  // The advanced editor keeps the quest's id and fills in what readFromNBT would.
  const qid = ids[0];
  const tag = structuredClone(doc.db.quests.get(qid)!);
  delete (tag['properties:10'] as BqObject)['betterquesting:10'];
  tag['questIDLow:4'] = 1n;
  assert.ok(setQuestTag(doc, qid, tag));
  const after = doc.db.quests.get(qid)!;
  assert.equal(getProp(after, 'name:8'), 'New Quest');
  assert.equal(writeBq(saveDb(doc.db).size ? after : after).includes('questIDLow'), true);
  assert.equal(uuidToB64(after['questIDHigh:4'] as bigint, after['questIDLow:4'] as bigint), qid);
  for (const k of Object.keys(after)) assert.ok(splitKey(k)[1] > 0);
  doc.undo();
  unchanged(doc);
});
