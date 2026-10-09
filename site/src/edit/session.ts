// Edit mode: the site shows (and the editor screens change) an EditDocument instead of the
// published questbook. Switched on in Settings (in game: /bq_admin edit); remembered per browser.

import { fetchJson, siteUrl } from '../gui/assets.ts';
import { invalidate } from '../gui/frame.ts';
import type { QuestbookData } from '../lib/model.ts';
import { book, setQuestbook } from '../store.ts';
import { EditDocument, type RawBundle } from './document.ts';
import { loadWork, saveWork } from './storage.ts';

export const editing = {
  on: false,
  loading: false,
  error: '',
  doc: null as EditDocument | null,
  /** Objects the modpack also changed since the saved edits were made (their edited version was kept). */
  clashes: [] as string[],
  /** The edits are on a different modpack commit than the one they were saved on. */
  rebased: '',
  saveFailed: false,
};

let published: QuestbookData | null = null;
let onRefresh: () => void = () => {};
let saveTimer = 0;

/** Called with the host's refresh, so screens rebuild after a change. */
export function setRefresh(f: () => void) {
  onRefresh = f;
}

function showDoc() {
  if (editing.on && editing.doc) setQuestbook(editing.doc.questbook());
  else if (published) setQuestbook(published);
  onRefresh();
  invalidate();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveNow(), 500) as unknown as number;
}

export async function saveNow() {
  const doc = editing.doc;
  if (!doc) return;
  editing.saveFailed = !(await saveWork({ base: doc.source.commit, savedAt: new Date().toISOString(), edits: doc.edits() }));
}

/** Switch edit mode on: load the raw files, put back autosaved work, and show the edited questbook. */
export async function startEditing(): Promise<boolean> {
  editing.on = true;
  if (editing.doc) {
    showDoc();
    return true;
  }
  published ??= book;
  editing.loading = true;
  editing.error = '';
  invalidate();
  try {
    const bundle = await fetchJson<RawBundle>(siteUrl('data/quests-raw.json'));
    const doc = new EditDocument(bundle);
    const saved = await loadWork();
    if (saved?.edits.length) {
      if (saved.base !== bundle.source.commit) {
        editing.rebased = saved.base;
        editing.clashes = saved.edits.filter((e) => doc.read(e.key) !== e.base).map((e) => e.key);
      }
      doc.restore(saved.edits);
    }
    doc.onChange(() => {
      showDoc();
      scheduleSave();
    });
    editing.doc = doc;
  } catch (e) {
    editing.error = (e as Error).message || 'Could not load the quest files';
    editing.on = false;
  } finally {
    editing.loading = false;
  }
  showDoc();
  return editing.on;
}

/** Switch edit mode off: show the published questbook again (the edits stay saved). */
export function stopEditing() {
  editing.on = false;
  showDoc();
}

/** Throw away every edit (and the autosave). */
export async function discardEdits() {
  const doc = editing.doc;
  if (!doc) return;
  editing.doc = null;
  editing.clashes = [];
  editing.rebased = '';
  await saveWork(null);
  if (editing.on) {
    editing.on = false;
    await startEditing();
  } else showDoc();
}

/** Ctrl + Z / Ctrl + Y (or Ctrl + Shift + Z) while editing. */
export function editKey(e: KeyboardEvent): boolean {
  const doc = editing.on ? editing.doc : null;
  if (!doc || !(e.ctrlKey || e.metaKey) || e.altKey) return false;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) return doc.undo();
  if (k === 'y' || (k === 'z' && e.shiftKey)) return doc.redo();
  return false;
}
