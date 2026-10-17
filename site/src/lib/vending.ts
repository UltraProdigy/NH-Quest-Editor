// The Vending Machine's trades (GTNewHorizons/VendingMachine), from the modpack's
// config/vendingmachine/tradeDatabase.json, which is written in BetterQuesting's NBT-as-JSON format.
// Trade groups name the quests that unlock them; BetterQuesting lists a quest's groups under
// "Associated Vending Machine Exchanges" beside its rewards.

import { parseBq, bqList, uuidToB64, type BqObject, type BqValue } from './bqjson.ts';
import { stackReader, type QuestStack } from './questbook.ts';
import type { ItemRef, VendingData, VendingGroup, VendingTrade } from './model.ts';

const isObj = (v: BqValue | undefined): v is BqObject => !!v && typeof v === 'object' && !Array.isArray(v);
/** NBT lists are JSON arrays in this file; BetterQuesting's own {"0:10": ...} form is read too. */
const list = (v: BqValue | undefined): BqObject[] => (Array.isArray(v) ? v : bqList(v)).filter(isObj);
/** A UUID stored as {"<prefix>High:4", "<prefix>Low:4"}, as BetterQuesting names quests. */
const uuidOf = (v: BqValue | undefined, prefix: string): string | null =>
  isObj(v) ? uuidToB64(BigInt((v[`${prefix}High:4`] as bigint) ?? 0n), BigInt((v[`${prefix}Low:4`] as bigint) ?? 0n)) : null;

/** Coin type -> coin item (CurrencyType: id and itemPrefix). */
export const COIN_ITEMS: Record<string, string> = {
  adventure: 'dreamcraft:CoinAdventure',
  bees: 'dreamcraft:CoinBees',
  blood: 'dreamcraft:CoinBlood',
  chemist: 'dreamcraft:CoinChemist',
  cook: 'dreamcraft:CoinCook',
  darkWizard: 'dreamcraft:CoinDarkWizard',
  farmer: 'dreamcraft:CoinFarmer',
  flower: 'dreamcraft:CoinFlower',
  forestry: 'dreamcraft:CoinForestry',
  smith: 'dreamcraft:CoinSmith',
  space: 'dreamcraft:CoinSpace',
  survivor: 'dreamcraft:CoinSurvivor',
  technician: 'dreamcraft:CoinTechnician',
  witch: 'dreamcraft:CoinWitch',
};

/** Read tradeDatabase.json. `stacks` collects the item stacks shown, as for the questbook. */
export function buildVending(text: string, source: VendingData['source'], stacks?: Map<string, QuestStack>): VendingData {
  const { item } = stackReader(stacks);
  const root = parseBq(text);
  const groups: VendingGroup[] = [];
  for (const g of list(isObj(root) ? root['tradeGroups:9'] : undefined)) {
    const id = uuidOf(g['id:10'], 'tradeGroupID') ?? '';
    const quests: string[] = [];
    for (const r of list(g['requirements:9'])) {
      const q = r['name:8'] === 'betterquesting' ? uuidOf(r['quest:10'], 'questID') : null;
      if (q) quests.push(q);
    }
    const trades: VendingTrade[] = list(g['trades:9']).map((t) => ({
      // CurrencyItem.fromNBT drops unknown coin types.
      coins: list(t['fromCurrency:9']).flatMap((c): ItemRef[] => {
        const coin = COIN_ITEMS[String(c['type:8'] ?? '')];
        return coin ? [item({ 'id:8': coin, 'Damage:2': 0, 'Count:3': Number(c['value:3'] ?? 0) })] : [];
      }),
      from: list(t['fromItems:9']).map(item),
      keep: list(t['nonConsumedItems:9']).map(item),
      to: list(t['toItems:9']).map(item),
    }));
    groups.push({
      id,
      category: String(g['category:8'] ?? 'unknown'),
      cooldown: Number(g['cooldown:3'] ?? -1),
      maxTrades: Number(g['maxTrades:3'] ?? -1),
      quests,
      trades,
    });
  }
  return { format: 1, source, groups };
}

/** Trade groups by the quest that unlocks them, in database order. */
export function groupsByQuest(data: VendingData): Map<string, VendingGroup[]> {
  const m = new Map<string, VendingGroup[]>();
  for (const g of data.groups) {
    for (const q of new Set(g.quests)) {
      const l = m.get(q) ?? [];
      l.push(g);
      m.set(q, l);
    }
  }
  return m;
}
