// Print what a modpack pull request changes in the questbook, as the review screen lists it.
// Usage: node scripts/review-pr.ts <number> [public/data/quests-raw.json]
// (Behind a proxy: NODE_USE_ENV_PROXY=1.)

import { readFileSync } from 'node:fs';
import type { RawBundle } from '../src/edit/document.ts';
import { pullRequest, rate } from '../src/review/github.ts';
import { loadPull } from '../src/review/load.ts';

const n = Number(process.argv[2]);
if (!n) {
  console.error('Usage: node scripts/review-pr.ts <number> [quests-raw.json]');
  process.exit(1);
}
const master = JSON.parse(readFileSync(process.argv[3] ?? 'public/data/quests-raw.json', 'utf8')) as RawBundle;
const pr = await pullRequest(n);
console.log(`#${pr.number} ${pr.title} (${pr.state}, by ${pr.author})`);
const t0 = performance.now();
const { files, result, items } = await loadPull(pr, master, (m) => process.stderr.write(`\r${m}\x1b[K`));
process.stderr.write('\n');
const name = (id?: string) => (id ? (result.after.quests[id] ?? result.before.quests[id])?.name ?? id : '');
const lineName = (id?: string) => (id ? (result.after.lines.find((l) => l.id === id) ?? result.before.lines.find((l) => l.id === id))?.name ?? id : '');
console.log(`${files.quests.length} quest files, ${files.other.length} other files, merge base ${files.mergeBase.slice(0, 7)}`);
for (const i of items) {
  const what = i.kind === 'q' ? `quest "${name(i.questId)}"` : i.kind === 'e' ? `"${name(i.questId)}" in "${lineName(i.lineId)}"` : i.kind === 'l' ? `line "${lineName(i.lineId)}"` : i.kind;
  console.log(`[${i.status}${i.master !== 'clean' ? `, ${i.master}` : ''}] ${what}`);
  for (const f of i.fields) {
    const v = (x: unknown) => (x === undefined ? '-' : JSON.stringify(x)).slice(0, 80);
    console.log(`    ${f.area}${f.index !== undefined ? ` ${f.index + 1}` : ''} ${f.what}: ${v(f.before)} -> ${v(f.after)}`);
  }
}
console.log(`${items.length} changes in ${Math.round(performance.now() - t0)} ms; API requests left: ${rate.remaining}`);
