import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { unzipSync, strFromU8 } from 'fflate';
import { EditDocument, type RawBundle } from '../src/edit/document.ts';
import { setQuestProperty, placeQuest } from '../src/edit/ops.ts';
import { exportZip, exportPatch } from '../src/edit/export.ts';
import { buildQuestbook } from '../src/lib/questbook.ts';
import { loadDb } from '../src/lib/bqsave.ts';
import { sha1Hex } from '../src/lib/sha1.ts';
import { createHash } from 'node:crypto';

test('sha1 matches node:crypto', () => {
  for (const s of ['', 'abc', '{"a:8": "§6é"}', 'x'.repeat(1000)]) {
    assert.equal(sha1Hex(s), createHash('sha1').update(s).digest('hex'));
  }
});

// Editing tests need the modpack's DefaultQuests (QUESTS_DIR, as for the round trip test).
const questsDir = process.env.QUESTS_DIR;
const skip = !questsDir || !existsSync(questsDir) ? 'QUESTS_DIR not set' : false;

function bundle(): RawBundle {
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(questsDir!, p).split('\\').join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(questsDir!);
  return { format: 1, source: { repo: 'test', commit: 'base', date: '' }, root: 'config/betterquesting/DefaultQuests', files };
}

test('edits, undo, redo, restore and exports', { skip }, () => {
  const doc = new EditDocument(bundle());
  assert.deepEqual(doc.fileChanges(), { changed: [], added: [], deleted: [] });

  const line = [...doc.db.lines.keys()][0];
  const [questId, entry] = [...doc.db.lines.get(line)!.entries][0];
  const oldName = String((doc.db.quests.get(questId)!['properties:10'] as Record<string, Record<string, unknown>>)['betterquesting:10']['name:8']);

  // Renaming a quest renames its file and its placement files.
  assert.ok(setQuestProperty(doc, questId, 'name:8', 'Renamed By Test', 'Rename'));
  assert.ok(placeQuest(doc, line, questId, Number(entry['x:3']) + 24, Number(entry['y:3'])));
  const ch = doc.fileChanges();
  assert.ok(ch.added.some((p) => p.includes('RenamedByTest-')), JSON.stringify(ch));
  assert.ok(ch.deleted.length >= 2);
  assert.equal(doc.questbook().quests[questId].name, 'Renamed By Test');

  // The site model of an unedited document equals the build's.
  const fresh = new EditDocument(bundle());
  assert.deepEqual(fresh.questbook().quests[questId].name, oldName);

  // Autosave: the edits applied to fresh data give the same files.
  const saved = doc.edits();
  fresh.restore(saved);
  assert.deepEqual(fresh.fileChanges(), ch);
  assert.deepEqual([...fresh.files()], [...doc.files()]);

  // Undo all, then redo.
  assert.ok(doc.undo());
  assert.ok(doc.undo());
  assert.ok(!doc.canUndo);
  assert.deepEqual(doc.fileChanges(), { changed: [], added: [], deleted: [] });
  assert.ok(doc.redo() && doc.redo());
  assert.deepEqual(doc.fileChanges(), ch);

  // The zip holds the new and changed files and lists the deleted ones.
  const zip = unzipSync(exportZip(doc));
  for (const p of [...ch.added, ...ch.changed]) assert.equal(strFromU8(zip[`config/betterquesting/DefaultQuests/${p}`]), doc.files().get(p));
  assert.equal(strFromU8(zip['DELETED.txt']).trim().split('\n').length, ch.deleted.length);

  // The patch applies to a git checkout of the base files and gives exactly the edited files.
  const dir = mkdtempSync(join(tmpdir(), 'nhqe-patch-'));
  try {
    const root = join(dir, 'config/betterquesting/DefaultQuests');
    for (const [p, t] of doc.base) {
      const f = join(root, p);
      execFileSync('mkdir', ['-p', join(f, '..')]);
      writeFileSync(f, t);
    }
    writeFileSync(join(dir, 'edit.patch'), exportPatch(doc));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['apply', 'edit.patch'], { cwd: dir });
    const after = loadDb(new Map([...doc.files()].map(([p]) => [p, readFileSync(join(root, p), 'utf8')])));
    assert.equal(after.quests.size, doc.db.quests.size);
    for (const [p, t] of doc.files()) assert.equal(readFileSync(join(root, p), 'utf8'), t, p);
    for (const p of ch.deleted) assert.ok(!existsSync(join(root, p)), p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // buildQuestbook is what the build writes.
  assert.equal(buildQuestbook(loadDb(doc.base), doc.source).lines.length, doc.db.lines.size);
});
