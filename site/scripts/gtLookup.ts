// The extra items GregTech's NEI handler looks up besides the one asked about
// (GTNEIDefaultHandler.loadCraftingRecipes / loadUsageRecipes), worked out from the "gtLookup"
// part of the export's nei domain. Only GregTech tabs use these; crafting and smelting match the
// item alone, as in game.
//
// Keys are base keys ("registryId@meta", "fluid:name"), like the recipe index.

/** The export's nei.gtLookup. */
export interface GtLookupExport {
  /** GTOreDictUnificator's associations, one group per prefix and material ("dustIron"). */
  unification?: {
    name: string;
    /** The item GT unifies the group to. */
    target?: string;
    /** Unified items of the prefix's familiar prefixes, same material (dust: small and tiny dust). */
    familiar?: string[];
    items: string[];
    /** Items on GT's unification blacklist. */
    blacklisted?: string[];
  }[];
  /** Forge's fluid containers: [filled item, fluid name, amount, empty item]. */
  fluidContainers?: [string, string, number, string?][];
  /** Nanochip components NEI also shows for an item (CCNEIRepresentation). */
  recipeAssociations?: Record<string, string[]>;
  usageAssociations?: Record<string, string[]>;
}

const WILDCARD = 32767;
const GT_ORES = 'gregtech:gt.blockores';

export interface GtLookup {
  /** Keys whose GT recipes also show for "R" on key (key itself not included). */
  recipes(key: string): string[];
  /** Keys whose GT usages also show for "U" on key (key itself not included). */
  usages(key: string): string[];
  /** Every key the lookup knows something about. */
  keys(): Iterable<string>;
}

type Group = NonNullable<GtLookupExport['unification']>[number];

export function gtLookup(data: GtLookupExport | undefined): GtLookup {
  const groupOf = new Map<string, Group>();
  for (const g of data?.unification ?? []) for (const k of g.items) if (!groupOf.has(k)) groupOf.set(k, g);
  const group = (key: string) => groupOf.get(key) ?? groupOf.get(key.replace(/@\d+$/, `@${WILDCARD}`));

  const fluidOf = new Map<string, string>();
  const containersOf = new Map<string, string[]>();
  for (const [filled, fluid] of data?.fluidContainers ?? []) {
    if (!fluidOf.has(filled)) fluidOf.set(filled, fluid);
    const list = containersOf.get(fluid);
    if (!list) containersOf.set(fluid, [filled]);
    else if (!list.includes(filled)) list.push(filled);
  }

  /** GTUtility.getFluidForFilledItem / StackInfo.getFluid, then the display stack and every container. */
  function fluidStacks(key: string, out: Set<string>) {
    const fluid = key.startsWith('fluid:') ? key.slice(6) : fluidOf.get(key);
    if (!fluid) return;
    out.add(`fluid:${fluid}`);
    for (const c of containersOf.get(fluid) ?? []) out.add(c);
  }

  /** GTOreDictUnificator.get(useBlackList, stack). */
  function unified(key: string, useBlackList: boolean): string {
    const g = group(key);
    if (!g?.target) return key;
    if (useBlackList && g.blacklisted?.includes(key)) return key;
    return g.target;
  }

  function finish(key: string, set: Set<string>): string[] {
    set.delete(key);
    return [...set];
  }

  return {
    recipes(key) {
      const s = new Set<string>([key, unified(key, true)]);
      const g = group(key);
      if (g && !g.blacklisted?.includes(key)) for (const f of g.familiar ?? []) s.add(f);
      for (const a of data?.recipeAssociations?.[key] ?? []) s.add(a);
      // Ore blocks: the same ore in every stone (meta % 1000 + stone * 1000).
      const m = /^(.*)@(\d+)$/.exec(key);
      if (m && m[1] === GT_ORES) for (let i = 0; i < 8; i++) s.add(`${GT_ORES}@${(Number(m[2]) % 1000) + i * 1000}`);
      fluidStacks(key, s);
      // A recipe's output slot also holds every item GT unifies to that output
      // (GTOreDictUnificator.getNonUnifiedStacks), so each looked-up item matches its target's recipes.
      for (const k of [...s]) s.add(unified(k, false));
      return finish(key, s);
    },
    usages(key) {
      const s = new Set<string>([key, unified(key, false)]);
      for (const f of group(key)?.familiar ?? []) s.add(f);
      for (const a of data?.usageAssociations?.[key] ?? []) s.add(a);
      fluidStacks(key, s);
      return finish(key, s);
    },
    *keys() {
      yield* groupOf.keys();
      yield* fluidOf.keys();
      for (const f of containersOf.keys()) yield `fluid:${f}`;
      yield* Object.keys(data?.recipeAssociations ?? {});
      yield* Object.keys(data?.usageAssociations ?? {});
    },
  };
}
