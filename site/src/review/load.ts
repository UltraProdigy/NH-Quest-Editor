// Load a pull request: its changed quest files at the merge base and at its head, then the diff.

import type { RawBundle } from '../edit/document.ts';
import { diffPullRequest, reviewItems, type FileVersions, type PrResult, type ReviewItem } from './diff.ts';
import { pullFiles, rawFile, pool, type PullRequest, type PullFiles } from './github.ts';

export interface LoadedPull {
  pr: PullRequest;
  files: PullFiles;
  result: PrResult;
  items: ReviewItem[];
}

export async function loadPull(pr: PullRequest, master: RawBundle, progress: (msg: string) => void = () => {}): Promise<LoadedPull> {
  progress('Asking GitHub what the pull request changes...');
  const files = await pullFiles(pr);
  const base: FileVersions = new Map(), head: FileVersions = new Map();
  let done = 0;
  const total = files.quests.reduce((n, f) => n + (f.base ? 1 : 0) + (f.head ? 1 : 0), 0);
  const step = () => progress(`Downloading quest files: ${++done} / ${total}`);
  await pool(files.quests, 8, async (f) => {
    const [b, h] = await Promise.all([
      f.base ? rawFile(files.mergeBase, f.base).finally(step) : Promise.resolve(null),
      f.head ? rawFile(pr.headSha, f.head).finally(step) : Promise.resolve(null),
    ]);
    if (f.base) {
      base.set(f.base, b);
      if (!head.has(f.base)) head.set(f.base, null);
    }
    if (f.head) {
      head.set(f.head, h);
      if (!base.has(f.head)) base.set(f.head, null);
    }
  });
  progress('Comparing the questbooks...');
  // Let the message show before the work blocks the page.
  await new Promise((r) => setTimeout(r, 0));
  const result = diffPullRequest(master, base, head);
  return { pr, files, result, items: reviewItems(result) };
}
