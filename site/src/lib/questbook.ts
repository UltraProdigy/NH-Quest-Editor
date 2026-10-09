// The site's questbook model (QuestbookData) from a BetterQuesting database. Used by the build
// (scripts/build-quests.ts writes it to public/data/questbook.json) and by the editor, which
// rebuilds it after every change so the screens show the edited questbook.

import { splitKey, bqList, uuidToB64, NBT } from './bqjson.ts';
import type { BqObject, BqValue } from './bqjson.ts';
import type { QuestDb } from './bqsave.ts';
import type { ItemRef, FluidRef, Quest, QuestLine, QuestbookData, TaskData, PrereqRef, Placement } from './model.ts';
import { sha1Hex } from './sha1.ts';

const isObj = (v: BqValue | undefined): v is BqObject => !!v && typeof v === 'object' && !Array.isArray(v);

const idOf = (o: BqObject, prefix: string): string =>
  uuidToB64(BigInt((o[`${prefix}High:4`] as bigint) ?? 0n), BigInt((o[`${prefix}Low:4`] as bigint) ?? 0n));

/** JSON text of a typed BQ value with longs written as plain numbers, as BetterQuesting writes them. */
export const typedJson = (v: BqValue): string =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `\u0000${x}` : x)).replace(/"\\u0000(-?\d+)"/g, '$1');

/** A stack the questbook shows, for the exporter to render ("tag" is BQ's typed NBT JSON text). */
export interface QuestStack {
  k: string;
  id: string;
  dmg: number;
  tag?: string;
}

/**
 * Build the questbook model. `stacks`, when given, collects every distinct item stack shown
 * (icons, task and reward items) keyed like the site looks them up.
 */
export function buildQuestbook(
  db: QuestDb,
  source: QuestbookData['source'],
  stacks?: Map<string, QuestStack>,
  generatedAt = new Date().toISOString(),
): QuestbookData {
  /**
   * Convert typed NBT JSON to plain JSON: strip suffixes, lists to arrays, longs to strings. Nested
   * values go through convert(), so item and fluid stacks anywhere inside become ItemRef/FluidRef.
   */
  function plain(v: BqValue, type = -1): unknown {
    if (typeof v === 'bigint') return v.toString();
    if (Array.isArray(v)) return v.map((x) => plain(x));
    if (!isObj(v)) return v;
    if (type === NBT.LIST) {
      return Object.entries(v)
        .map(([k, x]) => [splitKey(k), x] as const)
        .sort((a, b) => Number(a[0][0]) - Number(b[0][0]))
        .map(([[, t], x]) => convert(x, t));
    }
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const [name, t] = splitKey(k);
      o[name] = convert(x, t);
    }
    return o;
  }

  function item(v: BqObject): ItemRef {
    const ref: ItemRef = {
      id: String(v['id:8'] ?? ''),
      dmg: Number(v['Damage:2'] ?? 0),
      n: Number(v['Count:3'] ?? 1),
    };
    const ore = v['OreDict:8'];
    if (typeof ore === 'string' && ore) ref.ore = ore;
    let tag: string | undefined;
    if (isObj(v['tag:10'])) {
      ref.nbt = plain(v['tag:10'], NBT.COMPOUND) as Record<string, unknown>;
      tag = typedJson(v['tag:10']);
      ref.k = `${ref.id}@${ref.dmg}#${sha1Hex(tag).slice(0, 12)}`;
    }
    if (stacks && ref.id && ref.dmg !== 32767) {
      const k = ref.k ?? `${ref.id}@${ref.dmg}`;
      if (!stacks.has(k)) stacks.set(k, { k, id: ref.id, dmg: ref.dmg, ...(tag ? { tag } : {}) });
    }
    return ref;
  }

  const fluid = (v: BqObject): FluidRef => ({ fluid: String(v['FluidName:8'] ?? ''), n: Number(v['Amount:3'] ?? 0) });

  /** Like plain(), but recognises item and fluid stacks inside tasks and rewards. */
  function convert(v: BqValue, type: number): unknown {
    if (type === NBT.COMPOUND && isObj(v)) {
      if ('id:8' in v && 'Damage:2' in v) return item(v);
      if ('FluidName:8' in v && 'Amount:3' in v) return fluid(v);
    }
    return plain(v, type);
  }

  function taskData(v: BqValue, idKey: string): TaskData {
    const o = convert(v, NBT.COMPOUND) as Record<string, unknown>;
    const { [idKey]: type, index: _index, ...rest } = o;
    return { type: String(type), ...rest };
  }

  // ---------------------------------------------------------------- quests

  const quests: Record<string, Quest> = {};
  const rawProps: Record<string, Record<string, unknown>> = {};
  for (const [id, q] of db.quests) {
    const props = ((q['properties:10'] as BqObject | undefined)?.['betterquesting:10'] as BqObject | undefined) ?? {};
    const p = plain(props, NBT.COMPOUND) as Record<string, unknown>;
    const icon = isObj(props['icon:10']) ? item(props['icon:10']) : undefined;
    const { name, desc, icon: _icon, ...settings } = p;
    const pre: PrereqRef[] = bqList(q['preRequisites:9']).filter(isObj).map((r) => {
      const t = r['type:1'];
      return t === undefined || t === 0 ? [idOf(r, 'questID')] : [idOf(r, 'questID'), Number(t)];
    });
    quests[id] = {
      id,
      name: String(name ?? ''),
      desc: String(desc ?? ''),
      ...(icon ? { icon } : {}),
      pre,
      tasks: bqList(q['tasks:9']).map((t) => taskData(t, 'taskID')),
      rewards: bqList(q['rewards:9']).map((r) => taskData(r, 'rewardID')),
      props: {},
    };
    rawProps[id] = settings;
  }

  // Store only the properties that differ from the most common value.
  const counts = new Map<string, Map<string, { v: unknown; n: number }>>();
  for (const props of Object.values(rawProps)) {
    for (const [k, v] of Object.entries(props)) {
      const key = JSON.stringify(v);
      const m = counts.get(k) ?? new Map();
      const e = m.get(key) ?? { v, n: 0 };
      e.n++;
      m.set(key, e);
      counts.set(k, m);
    }
  }
  const total = Object.keys(rawProps).length;
  const defaults: Record<string, unknown> = {};
  for (const [k, m] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
    const best = [...m.values()].sort((a, b) => b.n - a.n)[0];
    // Keys missing from most quests (isGlobal, partySingleReward...) get no default.
    if (best.n * 2 > total) defaults[k] = best.v;
  }
  for (const [id, props] of Object.entries(rawProps)) {
    for (const [k, v] of Object.entries(props)) {
      if (!(k in defaults) || JSON.stringify(v) !== JSON.stringify(defaults[k])) quests[id].props[k] = v;
    }
  }

  // ---------------------------------------------------------------- questlines

  const lines: QuestLine[] = [];
  for (const [id, line] of db.lines) {
    const props = ((line.tag['properties:10'] as BqObject | undefined)?.['betterquesting:10'] as BqObject | undefined) ?? {};
    const placements: Placement[] = [...line.entries].map(([qid, e]) => [
      qid,
      Number(e['x:3'] ?? 0),
      Number(e['y:3'] ?? 0),
      Number(e['sizeX:3'] ?? 24),
      Number(e['sizeY:3'] ?? 24),
    ]);
    // Stable order: by position, then id.
    placements.sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0].localeCompare(b[0]));
    lines.push({
      id,
      name: String(props['name:8'] ?? ''),
      desc: String(props['desc:8'] ?? ''),
      ...(isObj(props['icon:10']) ? { icon: item(props['icon:10']) } : {}),
      visibility: String(props['visibility:8'] ?? 'NORMAL'),
      bgImage: String(props['bg_image:8'] ?? ''),
      bgSize: Number(props['bg_size:3'] ?? 256),
      quests: placements,
    });
  }

  return {
    format: 1,
    generatedAt,
    source,
    settings: plain(db.settings['betterquesting:10'] ?? {}, NBT.COMPOUND) as Record<string, unknown>,
    defaults,
    lines,
    quests,
  };
}
