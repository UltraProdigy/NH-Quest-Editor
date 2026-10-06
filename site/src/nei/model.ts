// Shapes of the recipe data in public/data/nei/ (written by scripts/build-recipes.ts).

/**
 * One slot of a recipe. A plain number is one item (its index in NeiItems.keys) with amount 1.
 * -1 marks a slot whose item is unknown.
 */
export type Slot = number | SlotObj;
export interface SlotObj {
  /** Item index, or the items the slot cycles through (alternatives, wildcard metas). */
  i?: number | number[];
  /** Ore dictionary entry (index into NeiItems.ore): the slot cycles through its members. */
  o?: number;
  /** Amount (absent: 1). Fluids are in mB. */
  n?: number;
  /** Chance out of 10000 (absent: always). */
  c?: number;
  /** Not consumed. */
  nc?: 1;
  /** GT: the recipe slot this stack is in, when it differs from its place in the list. */
  p?: number;
}

/**
 * A recipe. Which fields are set depends on the handler kind:
 * - shaped: w (grid width), g (grid slots by index, null = empty), o (output)
 * - shapeless: g (ingredients), o
 * - smelting: i (ingredient), o
 * - gt: e (EU/t), d (ticks), s (special value), ii/io (items in/out), fi/fo (fluids in/out),
 *   sp (special slot items), f (fusion start-up EU)
 */
export interface NeiRecipe {
  w?: number;
  g?: (Slot | null)[];
  o?: Slot;
  i?: Slot;
  e?: number;
  d?: number;
  s?: number;
  ii?: Slot[];
  io?: Slot[];
  fi?: Slot[];
  fo?: Slot[];
  sp?: Slot[];
  f?: number;
  /** GT description lines as the exporter recorded them, when they are not the standard ones. */
  t?: string[];
  /** GT description lines after the standard ones (heat, coil, cleanroom...). */
  x?: string[];
}

export interface NeiItems {
  format: 1;
  generatedAt: string;
  source: { dailyTag: string };
  /** Item keys: "registryId@meta", "registryId@meta#nbtHash", or "fluid:name". */
  keys: string[];
  names: string[];
  /** Index into modNames, -1 for fluids. */
  mods: number[];
  modNames: string[];
  /** Icon of each item: sheet * 256 + cell, or -1. */
  icons: number[];
  /** Icon size of each sheet (icons/<n>.png): 32, 64, 128 or 256 px; sheets are 512 px wide. */
  sheets: number[];
  /** Ore dictionary entries the recipes use: [name, member item indexes]. */
  ore: [name: string, members: number[]][];
}

/** A ModularUI drawable the exporter read: a texture (or part of one), or just its class. */
export interface GtDrawable {
  type: string;
  /** Resource location, e.g. "gregtech:textures/gui/progressbar/arrow.png". */
  location?: string;
  /** The part of the texture used, as fractions of its size. */
  u0?: number;
  v0?: number;
  u1?: number;
  v1?: number;
  /** AdaptableUITexture: the part's size in GUI pixels and its border, drawn as a nine-slice. */
  imageWidth?: number;
  imageHeight?: number;
  borderU?: number;
  borderV?: number;
  /** A wrapper's drawable. */
  inner?: GtDrawable;
}

/** A widget of GregTech's NEI template, positioned relative to the recipe (window offset included). */
export interface GtWidget {
  type: string;
  pos: [number, number];
  size: [number, number];
  background?: GtDrawable[];
  /** Slot widgets: which stacks they hold, and the slot number. */
  slot?: 'itemIn' | 'itemOut' | 'special' | 'fluidIn' | 'fluidOut';
  index?: number;
  /** DrawableWidget: the picture (logo, extra textures). */
  drawable?: GtDrawable;
  /** ProgressBar: the empty and full textures, the direction it fills and its step count. */
  empty?: GtDrawable;
  full?: GtDrawable;
  direction?: string;
  imageSize?: number;
}

export interface GtTemplate {
  size: [number, number];
  background: GtDrawable[];
  widgets: GtWidget[];
}

/** GregTech's NEI view of one recipe map tab, as the exporter recorded it. */
export interface GtLayout {
  /** Slot counts of the template: item in, item out, fluid in, fluid out. */
  max?: [number, number, number, number];
  amperage?: number;
  useSpecialSlot?: boolean;
  /** NEIRecipeProperties.recipeBackgroundSize and recipeBackgroundOffset. */
  bgSize?: [number, number];
  bgOffset?: [number, number];
  /** GTNEIDefaultHandler.WINDOW_OFFSET. */
  offset?: [number, number];
  template?: GtTemplate;
  /** Positions (slot frames, without the offset) for recipes with more stacks than the template, by count. */
  itemIn?: Record<string, [number, number][]>;
  itemOut?: Record<string, [number, number][]>;
  fluidIn?: Record<string, [number, number][]>;
  fluidOut?: Record<string, [number, number][]>;
}

export interface NeiHandler {
  id: string;
  name: string;
  kind: 'shaped' | 'shapeless' | 'smelting' | 'gt';
  count: number;
  /** Recipe chunks: [file number, recipe count], in recipe order. */
  chunks: [number, number][];
  catalysts: Slot[];
  icon?: Slot;
  /** Tab tooltip (getRecipeTabName) and mod name, when they differ from name / the default. */
  tab?: string;
  mod?: string;
  /** NEI shows chance and "not consumed" badges on stacks. */
  badges?: boolean;
  /** HandlerInfo: recipe height and the gap above each recipe. */
  height: number;
  yShift: number;
  layout?: GtLayout;
  /** GT: the most item/fluid inputs/outputs any recipe has, for when the layout was not recorded. */
  max?: [number, number, number, number];
}

export interface NeiHandlers {
  format: 1;
  handlers: NeiHandler[];
  /** The fuels the smelting handler shows in turn (item indexes). */
  fuels?: number[];
}

export interface NeiRecipeChunk {
  /** Handler index. */
  h: number;
  r: NeiRecipe[];
}

/**
 * Index entry of one key (an item's base key "registryId@meta", "fluid:name" or "ore:name"):
 * m = recipes that make it, u = recipes that use it, as [handler, recipe numbers] pairs;
 * c = handlers it is a catalyst of; gm / gu = other keys whose GregTech recipes / usages GregTech's
 * tabs show for this one too (unified and familiar items, a fluid and its containers).
 */
export type NeiIndexShard = Record<
  string,
  { m?: [number, number[]][]; u?: [number, number[]][]; c?: number[]; gm?: string[]; gu?: string[] }
>;

export const INDEX_SHARDS = 256;

/** FNV-1a hash of a key, to pick its index shard. */
export function shardOf(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % INDEX_SHARDS;
}
