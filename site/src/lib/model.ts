// Shapes of the generated site data (public/data/*.json).
// Produced by scripts/build-quests.ts and scripts/build-items.ts, read by the site.

/** An item stack as BetterQuesting stores it. */
export interface ItemRef {
  /** Registry name, e.g. "gregtech:gt.metaitem.01". */
  id: string;
  /** Damage / meta value. 32767 is the ore dictionary wildcard. */
  dmg: number;
  /** Stack size. */
  n: number;
  /** Ore dictionary name, when the task accepts any item of that name. */
  ore?: string;
  /** NBT tag with type suffixes removed (longs as strings). */
  nbt?: Record<string, unknown>;
  /** Stack key "<id>@<dmg>#<hash>" for stacks with NBT; their exact icon is indexed under it. */
  k?: string;
}

export interface FluidRef {
  fluid: string;
  /** Amount in mB. */
  n: number;
}

/** Prerequisite link. type: 0 normal, 1 implicit, 2 hidden (BQ's line visibility). */
export type PrereqRef = [id: string, type?: number];

/** A task or reward: its BetterQuesting type id plus its properties with suffixes removed. */
export interface TaskData {
  type: string;
  [key: string]: unknown;
}

export interface Quest {
  id: string;
  name: string;
  desc: string;
  icon?: ItemRef;
  pre: PrereqRef[];
  tasks: TaskData[];
  rewards: TaskData[];
  /** Quest properties that differ from QuestbookData.defaults. */
  props: Record<string, unknown>;
}

/** Placement of a quest on a questline: [questId, x, y, width, height]. */
export type Placement = [id: string, x: number, y: number, w: number, h: number];

export interface QuestLine {
  id: string;
  name: string;
  desc: string;
  icon?: ItemRef;
  visibility: string;
  bgImage: string;
  bgSize: number;
  quests: Placement[];
}

export interface QuestbookData {
  format: 1;
  generatedAt: string;
  source: { repo: string; commit: string; date: string };
  /** Global questbook settings (QuestSettings.json), suffixes removed. */
  settings: Record<string, unknown>;
  /** Most common value of each quest property; Quest.props only lists the differences. */
  defaults: Record<string, unknown>;
  lines: QuestLine[];
  quests: Record<string, Quest>;
}

/** Entry in the item index: display name and icon file. */
export interface ItemInfo {
  /** Display name. */
  n: string;
  /** Icon file name inside data/icons/, if one was rendered. */
  i?: string;
  /** Mod id. */
  m?: string;
}

export interface ItemIndex {
  format: 1;
  generatedAt: string;
  source: { dailyTag: string };
  /** Keyed by "registryId@meta" for items and "fluid:name" for fluids. */
  items: Record<string, ItemInfo>;
}

export const itemKey = (id: string, dmg: number) => `${id}@${dmg}`;
export const fluidKey = (name: string) => `fluid:${name}`;
