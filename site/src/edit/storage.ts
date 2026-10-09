// Autosave of the edits in this browser (IndexedDB). Only the changed objects are kept, with what
// they were in the base data, so they can be put back on top of the questbook after a reload,
// even when the site has moved on to a newer modpack commit.

import type { ObjectKey } from './document.ts';

export interface SavedWork {
  /** Modpack commit the edits were made on. */
  base: string;
  savedAt: string;
  edits: { key: ObjectKey; text: string | null; base: string | null }[];
}

const DB = 'nhqe-editor';
const STORE = 'work';
const KEY = 'current';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<unknown> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = f(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadWork(): Promise<SavedWork | null> {
  try {
    return ((await run('readonly', (s) => s.get(KEY))) as SavedWork | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function saveWork(w: SavedWork | null): Promise<boolean> {
  try {
    await run('readwrite', (s) => (w && w.edits.length ? s.put(w, KEY) : s.delete(KEY)));
    return true;
  } catch {
    return false;
  }
}
