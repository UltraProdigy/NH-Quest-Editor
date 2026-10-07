// Downloads the Minecraft 1.7.10 client jar from Mojang and extracts the few vanilla assets the
// site draws with (the bitmap font, the enchantment glint, the button, crafting table and furnace
// textures of the recipe views, and the inventory NEI's item panel opens over). They are not
// stored in this repository.
//
// Usage: node scripts/fetch-vanilla.ts [out dir]   (default: public/assets/minecraft)
// Needs `unzip` on the PATH.

import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const out = resolve(process.argv[2] ?? 'public/assets/minecraft');
const VERSION = '1.7.10';
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

async function json<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

const manifest = await json<{ versions: { id: string; url: string }[] }>(MANIFEST);
const entry = manifest.versions.find((v) => v.id === VERSION);
if (!entry) throw new Error(`Minecraft ${VERSION} is not in the version manifest`);
const version = await json<{ downloads: { client: { url: string; sha1: string } } }>(entry.url);
const { url, sha1 } = version.downloads.client;

const r = await fetch(url);
if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
const jar = Buffer.from(await r.arrayBuffer());
const got = createHash('sha1').update(jar).digest('hex');
if (got !== sha1) throw new Error(`client.jar checksum mismatch: ${got} != ${sha1}`);

const tmp = mkdtempSync(join(tmpdir(), 'mc-'));
const jarPath = join(tmp, 'client.jar');
writeFileSync(jarPath, jar);
mkdirSync(out, { recursive: true });
execFileSync('unzip', [
  '-o', '-q', jarPath,
  'assets/minecraft/textures/font/*', 'assets/minecraft/font/*', 'assets/minecraft/textures/misc/enchanted_item_glint.png',
  'assets/minecraft/textures/gui/widgets.png', 'assets/minecraft/textures/gui/container/crafting_table.png',
  'assets/minecraft/textures/gui/container/furnace.png', 'assets/minecraft/textures/gui/container/inventory.png',
  '-d', tmp,
]);
execFileSync('cp', ['-r', join(tmp, 'assets/minecraft/textures'), join(tmp, 'assets/minecraft/font'), out]);
rmSync(tmp, { recursive: true, force: true });
console.log(`vanilla font, glint and GUI textures from Minecraft ${VERSION} -> ${out}`);
