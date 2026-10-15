import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { EditDocument, type RawBundle, questKey } from '../src/edit/document.ts';
import { setQuestProperty, setLineProperty, placeQuest } from '../src/edit/ops.ts';
import { diffPullRequest, identityOf, overlay, reviewItems, type FileVersions } from '../src/review/diff.ts';

test('files map to the objects they hold', () => {
  assert.equal(identityOf('QuestSettings.json'), 's');
  assert.equal(identityOf('QuestLinesOrder.txt'), 'o');
  assert.equal(identityOf('QuestLines/Tier1LV-AAAAAAAAAAAAAAAAAAAAAw==/QuestLine.json'), 'l:AAAAAAAAAAAAAAAAAAAAAw==');
  assert.equal(
    identityOf('QuestLines/BuildingBetterBa-AAAAAAAAAAAAAAAAAAAADQ==/GottaGoFast-Whl2BVaRSlaTf-ky0Ih96A==.json'),
    'e:AAAAAAAAAAAAAAAAAAAADQ==:Whl2BVaRSlaTf-ky0Ih96A==',
  );
  assert.equal(identityOf('Quests/MultipleQuestLine/SuperdenseCastin-EWAWhpFvQY6nvgVeXSZoNQ==.json'), 'q:EWAWhpFvQY6nvgVeXSZoNQ==');
  assert.equal(identityOf('Quests/NoQuestLine/-AAAAAAAAAAAAAAAAAAAEmg==.json'), 'q:AAAAAAAAAAAAAAAAAAAEmg==');
  assert.equal(identityOf('README.md'), null);
});

test('overlay replaces objects, not paths', () => {
  const master = new Map([
    ['Quests/A-AAAAAAAAAAAAAAAAAAAAAQ==/Old-AAAAAAAAAAAAAAAAAAAAAg==.json', 'master'],
    ['Quests/A-AAAAAAAAAAAAAAAAAAAAAQ==/Other-AAAAAAAAAAAAAAAAAAAAAw==.json', 'other'],
  ]);
  const out = overlay(master, new Map([['Quests/B-AAAAAAAAAAAAAAAAAAAABQ==/New-AAAAAAAAAAAAAAAAAAAAAg==.json', 'branch']]));
  assert.deepEqual([...out.values()].sort(), ['branch', 'other']);
});

// The rest needs the modpack's DefaultQuests (QUESTS_DIR, as for the round trip test).
const questsDir = process.env.QUESTS_DIR;
const skip = !questsDir || !existsSync(questsDir) ? 'QUESTS_DIR not set' : false;

let cached: RawBundle | null = null;
function bundle(): RawBundle {
  if (cached) return { ...cached, files: { ...cached.files } };
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(questsDir!, p).split('\\').join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(questsDir!);
  cached = { format: 1, source: { repo: 'test', commit: 'master', date: '' }, root: 'config/betterquesting/DefaultQuests', files };
  return bundle();
}

/** A "pull request" made with the editor on top of `from`: the touched files before and after. */
function branch(from: RawBundle, edit: (doc: EditDocument) => void): { base: FileVersions; head: FileVersions } {
  const doc = new EditDocument(from);
  edit(doc);
  const { changed, added, deleted } = doc.fileChanges();
  const files = doc.files();
  const base: FileVersions = new Map(), head: FileVersions = new Map();
  for (const p of [...changed, ...added, ...deleted]) {
    base.set(p, from.files[p] ?? null);
    head.set(p, files.get(p) ?? null);
  }
  return { base, head };
}

const withFiles = (b: RawBundle, edit: (doc: EditDocument) => void): RawBundle => {
  const doc = new EditDocument(b);
  edit(doc);
  return { ...b, files: Object.fromEntries(doc.files()) };
};

test('a pull request\'s changes, field by field', { skip }, () => {
  const master = bundle();
  const probe = new EditDocument(master);
  const line = [...probe.db.lines.keys()][0];
  const [questId, entry] = [...probe.db.lines.get(line)!.entries][0];
  const book = probe.questbook();
  const pr = branch(master, (doc) => {
    setQuestProperty(doc, questId, 'desc:8', 'A new description');
    setQuestProperty(doc, questId, 'name:8', 'Renamed In Branch');
    placeQuest(doc, line, questId, Number(entry['x:3']) + 48, Number(entry['y:3']));
  });
  const r = diffPullRequest(master, pr.base, pr.head);
  assert.deepEqual(r.changes.map((c) => c.key).sort(), [`e:${line}:${questId}`, questKey(questId)].sort());
  assert.ok(r.changes.every((c) => c.master === 'clean'));
  assert.equal(r.after.quests[questId].name, 'Renamed In Branch');
  assert.equal(r.before.quests[questId].name, book.quests[questId].name);

  const items = reviewItems(r);
  const q = items.find((i) => i.kind === 'q')!;
  assert.equal(q.status, 'changed');
  assert.deepEqual(q.fields.map((f) => f.area).sort(), ['desc', 'name']);
  const e = items.find((i) => i.kind === 'e')!;
  assert.equal(e.status, 'moved');
  assert.deepEqual(e.fields[0].after, [Number(entry['x:3']) + 48, Number(entry['y:3'])]);
});

test('changes to tasks and rewards are found per item', { skip }, () => {
  const master = bundle();
  const probe = new EditDocument(master);
  const book = probe.questbook();
  const id = Object.keys(book.quests).find((k) =>
    (book.quests[k].tasks[0]?.requiredItems as unknown[] | undefined)?.length && book.quests[k].rewards.length)!;
  const pr = branch(master, (doc) =>
    doc.transact('t', (tx) => {
      const q = tx.quest(id)!;
      const tasks = q['tasks:9'] as Record<string, Record<string, unknown>>;
      const items = tasks['0:10']['requiredItems:9'] as Record<string, Record<string, unknown>>;
      items['0:10']['Count:3'] = 12345;
      tx.set(questKey(id), q);
    }),
  );
  const items = reviewItems(diffPullRequest(master, pr.base, pr.head));
  assert.equal(items.length, 1);
  const f = items[0].fields;
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.equal(f[0].area, 'task');
  assert.equal(f[0].index, 0);
  assert.equal(f[0].what, 'requiredItems 1');
  assert.equal((f[0].after as { n: number }).n, 12345);
});

test('master changes since the branch started: clashes and merged changes', { skip }, () => {
  const master = bundle();
  const probe = new EditDocument(master);
  const [qa, qb] = Object.keys(probe.questbook().quests);
  const pr = branch(master, (doc) => {
    setQuestProperty(doc, qa, 'desc:8', 'Branch text');
    setQuestProperty(doc, qb, 'desc:8', 'Same on both');
  });
  // Master moved on: changed qa another way, and got qb's change on its own.
  const newer = withFiles(master, (doc) => {
    setQuestProperty(doc, qa, 'desc:8', 'Master text');
    setQuestProperty(doc, qb, 'desc:8', 'Same on both');
  });
  const r = diffPullRequest(newer, pr.base, pr.head);
  const state = Object.fromEntries(r.changes.map((c) => [c.key, c.master]));
  assert.equal(state[questKey(qa)], 'clash');
  assert.equal(state[questKey(qb)], 'merged');
  assert.equal(r.after.quests[qa].desc, 'Branch text');
  assert.equal(r.before.quests[qa].desc, 'Master text');
});

test('placements follow a quest line that master renamed', { skip }, () => {
  const master = bundle();
  const probe = new EditDocument(master);
  const line = [...probe.db.lines.keys()][1];
  const [questId, entry] = [...probe.db.lines.get(line)!.entries][0];
  const pr = branch(master, (doc) => placeQuest(doc, line, questId, Number(entry['x:3']) + 24, Number(entry['y:3'])));
  const newer = withFiles(master, (doc) => setLineProperty(doc, line, 'name:8', 'A Renamed Line'));
  const r = diffPullRequest(newer, pr.base, pr.head);
  assert.deepEqual(r.changes.map((c) => [c.key, c.master]), [[`e:${line}:${questId}`, 'clean']]);
  const after = r.after.lines.find((l) => l.id === line)!;
  assert.equal(after.name, 'A Renamed Line');
  assert.equal(after.quests.find((p) => p[0] === questId)![1], Number(entry['x:3']) + 24);
});

test('added and removed quests', { skip }, () => {
  const master = bundle();
  const probe = new EditDocument(master);
  const line = [...probe.db.lines.keys()][0];
  const [gone] = [...probe.db.lines.get(line)!.entries][0];
  const newId = 'AAAAAAAAAAAAAAAAAAB4Dw==';
  const pr = branch(master, (doc) =>
    doc.transact('t', (tx) => {
      const q = tx.quest(gone)!;
      q['questIDLow:4'] = 30735;
      q['questIDHigh:4'] = 0;
      tx.set(questKey(newId), q);
      const e = tx.entry(line, gone)!;
      e['questIDLow:4'] = 30735;
      e['questIDHigh:4'] = 0;
      tx.set(`e:${line}:${newId}`, e);
      tx.set(questKey(gone), null);
      tx.set(`e:${line}:${gone}`, null);
    }),
  );
  const items = reviewItems(diffPullRequest(master, pr.base, pr.head));
  const st = Object.fromEntries(items.map((i) => [i.key, i.status]));
  assert.equal(st[questKey(newId)], 'added');
  assert.equal(st[questKey(gone)], 'removed');
  assert.equal(st[`e:${line}:${newId}`], 'added');
  assert.equal(st[`e:${line}:${gone}`], 'removed');
});
