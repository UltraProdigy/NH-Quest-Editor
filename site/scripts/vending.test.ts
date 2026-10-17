import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildVending, groupsByQuest } from '../src/lib/vending.ts';
import type { QuestStack } from '../src/lib/questbook.ts';

const source = { repo: 'test', commit: '', date: '' };

// One trade group as tradeDatabase.json writes it (NBT lists as JSON arrays).
const DB = `{
  "tradeGroups:9": [
    {
      "category:8": "raw",
      "cooldown:3": 3600,
      "id:10": { "tradeGroupIDHigh:4": -9178793868474562574, "tradeGroupIDLow:4": -8321622777038284087 },
      "maxTrades:3": -1,
      "requirements:9": [
        { "name:8": "betterquesting", "quest:10": { "questIDHigh:4": 0, "questIDLow:4": 1148 } },
        { "name:8": "somethingelse" }
      ],
      "trades:9": [
        {
          "displayItem:10": { "Count:3": 1, "Damage:2": 0, "OreDict:8": "", "id:8": "vendingmachine:placeholder" },
          "fromCurrency:9": [ { "type:8": "smith", "value:3": 50 }, { "type:8": "nosuchcoin", "value:3": 1 } ],
          "fromItems:9": [ { "Count:3": 64, "Damage:2": 8538, "OreDict:8": "", "id:8": "gregtech:gt.metaitem.01" } ],
          "nonConsumedItems:9": [ { "Count:3": 1, "Damage:2": 0, "OreDict:8": "", "id:8": "minecraft:shears" } ],
          "toItems:9": [
            { "Count:3": 16, "Damage:2": 11305, "OreDict:8": "", "id:8": "gregtech:gt.metaitem.01",
              "tag:10": { "Charge:4": 12345678901234567 } }
          ]
        }
      ]
    }
  ],
  "version:3": 1
}`;

test('reads trade groups, their quests and items', () => {
  const stacks = new Map<string, QuestStack>();
  const v = buildVending(DB, source, stacks);
  assert.equal(v.groups.length, 1);
  const g = v.groups[0];
  assert.deepEqual(
    { category: g.category, cooldown: g.cooldown, maxTrades: g.maxTrades, quests: g.quests },
    { category: 'raw', cooldown: 3600, maxTrades: -1, quests: ['AAAAAAAAAAAAAAAAAAAEfA=='] },
  );
  const t = g.trades[0];
  assert.deepEqual(t.coins, [{ id: 'dreamcraft:CoinSmith', dmg: 0, n: 50 }]);
  assert.deepEqual(t.from, [{ id: 'gregtech:gt.metaitem.01', dmg: 8538, n: 64 }]);
  assert.deepEqual(t.keep, [{ id: 'minecraft:shears', dmg: 0, n: 1 }]);
  assert.equal(t.to[0].n, 16);
  assert.deepEqual(t.to[0].nbt, { Charge: '12345678901234567' });
  assert.match(t.to[0].k ?? '', /^gregtech:gt\.metaitem\.01@11305#[0-9a-f]{12}$/);
  // Every stack shown goes to the exporter's list; the display placeholder is not shown.
  assert.ok(stacks.has('dreamcraft:CoinSmith@0'));
  assert.ok(stacks.has(t.to[0].k!));
  assert.ok(![...stacks.keys()].some((k) => k.startsWith('vendingmachine:')));
  assert.deepEqual([...groupsByQuest(v).keys()], ['AAAAAAAAAAAAAAAAAAAEfA==']);
});

// With the modpack checked out (QUESTS_DIR), every trade group must unlock from a real quest.
const questsDir = process.env.QUESTS_DIR;
const tradesFile = questsDir && join(questsDir, '..', '..', 'vendingmachine', 'tradeDatabase.json');
test('the modpack trade database reads', { skip: !tradesFile || !existsSync(tradesFile) ? 'QUESTS_DIR not set' : false }, () => {
  const v = buildVending(readFileSync(tradesFile!, 'utf8'), source);
  // Quest files are named "<name>-<id>.json"; ids are 24 characters (and may hold "-" themselves).
  const ids = new Set(
    (readdirSync(join(questsDir!, 'Quests'), { recursive: true }) as string[])
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(-'.json'.length - 24, -'.json'.length)),
  );
  assert.ok(v.groups.length > 0);
  for (const g of v.groups) {
    assert.ok(g.quests.length > 0, `${g.id} has no quest`);
    for (const q of g.quests) assert.ok(ids.has(q), `${g.id} needs quest ${q}, which does not exist`);
    for (const t of g.trades) assert.ok(t.to.length > 0, `${g.id} has a trade with nothing out`);
  }
});
