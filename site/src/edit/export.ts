// Exports of the edited questbook, for a pull request to the modpack by hand:
// - a zip of only the added and changed files at their repo paths, with DELETED.txt (files to
//   remove) and BASE.txt (the modpack commit the edits start from);
// - a git patch (`git apply --3way` in the modpack repo).
// Neither holds the untouched files, so applying them over a newer modpack keeps other people's
// changes.

import { zipSync, strToU8 } from 'fflate';
import { createTwoFilesPatch } from 'diff';
import type { EditDocument } from './document.ts';
import { sha1Hex } from '../lib/sha1.ts';

/** Git's id of a file's contents (a blob), so `git apply --3way` can merge with newer files. */
const blobId = (text: string) => sha1Hex(`blob ${new TextEncoder().encode(text).length}\0${text}`);
const NO_BLOB = '0'.repeat(40);

/** The files the edits add, change and delete, at their paths in the modpack repo. */
export function exportedFiles(doc: EditDocument) {
  const { changed, added, deleted } = doc.fileChanges();
  const files = doc.files();
  const root = doc.bundle.root.replace(/\/+$/, '');
  return {
    root,
    write: [...changed, ...added].sort().map((p) => ({ path: `${root}/${p}`, rel: p, text: files.get(p)!, added: added.includes(p) })),
    deleted: deleted.map((p) => ({ path: `${root}/${p}`, rel: p })),
  };
}

export function exportZip(doc: EditDocument): Uint8Array {
  const { write, deleted } = exportedFiles(doc);
  const s = doc.source;
  const entries: Record<string, Uint8Array> = {};
  for (const f of write) entries[f.path] = strToU8(f.text);
  entries['BASE.txt'] = strToU8(
    `Edited from ${s.repo} at ${s.commit}${s.date ? ` (${s.date})` : ''}.\n` +
      'Copy the files over a checkout of the modpack and delete the files in DELETED.txt.\n',
  );
  entries['DELETED.txt'] = strToU8(deleted.map((d) => d.path).join('\n') + (deleted.length ? '\n' : ''));
  return zipSync(entries, { level: 6 });
}

/** A git-style patch of the edits against the base files. */
export function exportPatch(doc: EditDocument): string {
  const { write, deleted } = exportedFiles(doc);
  const out: string[] = [];
  // jsdiff's hunks (it marks a missing final newline, which BetterQuesting's files all lack).
  const body = (oldText: string, newText: string) => {
    const lines = createTwoFilesPatch('a', 'b', oldText, newText, '', '', { context: 3 }).split('\n');
    const first = lines.findIndex((l) => l.startsWith('@@'));
    return first < 0 ? [] : lines.slice(first, lines[lines.length - 1] === '' ? -1 : undefined);
  };
  for (const f of write) {
    const base = f.added ? '' : (doc.base.get(f.rel) ?? '');
    out.push(`diff --git a/${f.path} b/${f.path}`);
    if (f.added) out.push('new file mode 100644', `index ${NO_BLOB}..${blobId(f.text)}`, '--- /dev/null');
    else out.push(`index ${blobId(base)}..${blobId(f.text)} 100644`, `--- a/${f.path}`);
    out.push(`+++ b/${f.path}`);
    out.push(...body(base, f.text));
  }
  for (const d of deleted) {
    const old = doc.base.get(d.rel) ?? '';
    out.push(`diff --git a/${d.path} b/${d.path}`, 'deleted file mode 100644', `index ${blobId(old)}..${NO_BLOB}`, `--- a/${d.path}`, '+++ /dev/null');
    out.push(...body(old, ''));
  }
  return out.length ? out.join('\n') + '\n' : '';
}
