// Builds public/data/questbook.json from a BetterQuesting DefaultQuests folder.
//
// Usage: node scripts/build-quests.ts <DefaultQuests dir> [out file] [--stacks <file>]
// Optional env: QUESTS_REPO, QUESTS_COMMIT, QUESTS_DATE (recorded as the data source).
//
// --stacks writes every distinct item stack the questbook shows (icons, task and reward items),
// with its NBT exactly as BetterQuesting stores it, for the exporter to render one by one.
// Stacks with NBT get a key "<id>@<dmg>#<hash>" (ItemRef.k) so the site can find their icon.
//
// If the DefaultQuests folder has a sibling "resources" folder (config/betterquesting/resources,
// where modpacks put custom themes and pictures), its contents are copied to public/assets and
// its themes are listed in public/data/themes.json.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync, cpSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { loadDb } from '../src/lib/bqsave.ts';
import { buildQuestbook, type QuestStack } from '../src/lib/questbook.ts';

const argv = process.argv.slice(2);
const stacksAt = argv.indexOf('--stacks');
const stacksArg = stacksAt >= 0 ? argv.splice(stacksAt, 2)[1] : undefined;
const [srcArg, outArg] = argv;
if (!srcArg || (stacksAt >= 0 && !stacksArg)) {
  console.error('Usage: node scripts/build-quests.ts <DefaultQuests dir> [out file] [--stacks <file>]');
  process.exit(2);
}
const src = resolve(srcArg);
const out = resolve(outArg ?? 'public/data/questbook.json');

// Every file of the DefaultQuests folder, by path relative to it ("/" separated).
const allFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
const files = new Map<string, string>();
for (const p of allFiles(src).sort()) files.set(relative(src, p).split(sep).join('/'), readFileSync(p, 'utf8'));

const source = {
  repo: process.env.QUESTS_REPO ?? 'GTNewHorizons/GT-New-Horizons-Modpack',
  commit: process.env.QUESTS_COMMIT ?? '',
  date: process.env.QUESTS_DATE ?? '',
};
const db = loadDb(files);
const stacks = new Map<string, QuestStack>();
const data = buildQuestbook(db, source, stacks);

mkdirSync(dirname(out), { recursive: true });
const json = JSON.stringify(data);
writeFileSync(out, json);

// ---------------------------------------------------------------- raw files for the editor

// Every file of the DefaultQuests folder exactly as it is in the modpack, so the editor can load
// it losslessly and export changes as files and diffs against this commit. About 17 MB, but it
// compresses to under 2 MB and only loads when edit mode is switched on.
writeFileSync(
  join(dirname(out), 'quests-raw.json'),
  JSON.stringify({ format: 1, source, root: 'config/betterquesting/DefaultQuests', files: Object.fromEntries(files) }),
);

// ---------------------------------------------------------------- modpack resources

const resources = join(src, '..', 'resources');
const themes: unknown[] = [];
if (existsSync(resources)) {
  const assets = resolve(dirname(out), '..', 'assets');
  for (const domain of readdirSync(resources)) {
    const dir = join(resources, domain);
    if (!statSync(dir).isDirectory()) continue;
    const target = join(assets, domain.toLowerCase());
    if (['minecraft', 'betterquesting', 'bq_standard'].includes(domain.toLowerCase())) continue;
    rmSync(target, { recursive: true, force: true });
    cpSync(dir, target, { recursive: true, filter: (f) => !f.endsWith('bq_themes.json') });
    const themeFile = join(dir, 'bq_themes.json');
    if (existsSync(themeFile)) {
      const t = JSON.parse(readFileSync(themeFile, 'utf8'));
      themes.push(...(Array.isArray(t) ? t : [t]));
    }
  }
}
writeFileSync(join(dirname(out), 'themes.json'), JSON.stringify(themes));

if (stacksArg) {
  // One stack per line; "tag" is BQ's typed NBT JSON text, kept as text so longs stay exact.
  const list = [...stacks.values()].sort((a, b) => a.k.localeCompare(b.k));
  mkdirSync(dirname(resolve(stacksArg)), { recursive: true });
  writeFileSync(resolve(stacksArg), list.map((x) => JSON.stringify(x)).join('\n') + '\n');
  console.log(`quest stacks: ${list.length} (${list.filter((x) => x.tag).length} with NBT) -> ${resolve(stacksArg)}`);
}

const { quests, lines } = data;
const missing = lines.flatMap((l) => l.quests.filter((p) => !quests[p[0]]).map((p) => `${l.name}: ${p[0]}`));
const placed = new Set(lines.flatMap((l) => l.quests.map((p) => p[0])));
console.log(
  `questbook: ${Object.keys(quests).length} quests, ${lines.length} questlines, ` +
    `${lines.reduce((n, l) => n + l.quests.length, 0)} placements, ` +
    `${Object.keys(quests).length - placed.size} unplaced, ${themes.length} extra themes, ` +
    `${(json.length / 1e6).toFixed(1)} MB -> ${out}`,
);
if (missing.length) console.warn(`placements without a quest file (${missing.length}):\n  ${missing.slice(0, 20).join('\n  ')}`);
