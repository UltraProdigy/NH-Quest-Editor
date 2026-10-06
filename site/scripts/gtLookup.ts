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
  /** GT++ components: the same material's items of the familiar prefixes. */
  componentFamiliar?: Record<string, string[]>;
  /** Assembly line data sticks: [stick, its NBT as exported, the recipe's output]. */
  dataSticks?: [string, string, string][];
  /** GT's fluid display item; its damage is the Forge fluid id (fluidIds). */
  fluidDisplay?: string;
  fluidIds?: Record<string, number>;
}

/** What the build knows besides the export's gtLookup. */
export interface GtLookupOptions {
  /**
   * The recipes' stacks with NBT ("registryId@meta#hash") and their NBT: fluid containers that
   * keep their fluid in it, and the data sticks.
   */
  nbt?: Iterable<[key: string, nbt: string]>;
}

/**
 * NBT as NBTBase.toString writes it (1.7.10: {a:1b,b:"x",c:[0:1s,]}), with compound keys sorted.
 * A copied stack's tag can list its keys in another order (NBTTagCompound is a HashMap), so the
 * same tag is compared in this form.
 */
export function canonicalNbt(nbt: string): string {
  let i = 0;
  const ws = () => {
    while (i < nbt.length && /\s/.test(nbt[i])) i++;
  };
  const value = (): string => {
    ws();
    const c = nbt[i];
    if (c === '{') {
      i++;
      const entries: string[] = [];
      for (ws(); i < nbt.length && nbt[i] !== '}'; ws()) {
        const k = token(':');
        i++; // ':'
        entries.push(`${k}:${value()}`);
        ws();
        if (nbt[i] === ',') i++;
      }
      i++;
      return `{${entries.sort().join(',')}}`;
    }
    if (c === '[') {
      i++;
      const items: string[] = [];
      for (ws(); i < nbt.length && nbt[i] !== ']'; ws()) {
        // Lists are written "index:value"; arrays ([B;...]) and older forms may not be.
        const start = i;
        const k = token(':,]');
        if (nbt[i] === ':' && /^\d+$/.test(k)) i++;
        else i = start;
        items.push(value());
        ws();
        if (nbt[i] === ',') i++;
      }
      i++;
      return `[${items.join(',')}]`;
    }
    if (c === '"') {
      const start = i++;
      while (i < nbt.length && nbt[i] !== '"') i += nbt[i] === '\\' ? 2 : 1;
      i++;
      return nbt.slice(start, i);
    }
    return token(',}]');
  };
  const token = (stops: string) => {
    const start = i;
    while (i < nbt.length && !stops.includes(nbt[i])) i++;
    return nbt.slice(start, i).trim();
  };
  return value();
}

/** The fluid an item's NBT holds (FluidStack.writeToNBT under "Fluid", as IFluidContainerItems keep it). */
export function nbtFluid(nbt: string): string | undefined {
  return /(?:^|[{,])\s*"?Fluid"?\s*:\s*\{[^{}]*?"?FluidName"?\s*:\s*"([^"]+)"/.exec(nbt)?.[1];
}

const WILDCARD = 32767;
/** GT's ore blocks: gt.blockores, and gt.blockores2 to 7 in newer GT. */
const GT_ORES = /^(gregtech:gt\.blockores\d*)@(\d+)$/;

export interface GtLookup {
  /** Keys whose GT recipes also show for "R" on key (key itself not included). */
  recipes(key: string): string[];
  /** Keys whose GT usages also show for "U" on key (key itself not included). */
  usages(key: string): string[];
  /** Every key the lookup knows something about. */
  keys(): Iterable<string>;
}

type Group = NonNullable<GtLookupExport['unification']>[number];

export function gtLookup(data: GtLookupExport | undefined, opts: GtLookupOptions = {}): GtLookup {
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
  // Fluid display stacks (StackInfo.getFluid) and containers holding their fluid in NBT
  // (GTUtility.getFluidForFilledItem with IFluidContainerItem).
  if (data?.fluidDisplay) {
    for (const [name, id] of Object.entries(data.fluidIds ?? {})) fluidOf.set(`${data.fluidDisplay}@${id}`, name);
  }
  for (const [key, nbt] of opts.nbt ?? []) {
    const f = nbtFluid(nbt);
    if (f && !fluidOf.has(key)) fluidOf.set(key, f);
  }
  // AssemblyLineUtils.getDataStickOutput: a data stick also looks up the recipe it holds.
  const stickByNbt = new Map<string, string>();
  for (const [stick, nbt, out] of data?.dataSticks ?? []) stickByNbt.set(`${stick}|${canonicalNbt(nbt)}`, out);
  const stickOutput = new Map<string, string>();
  if (stickByNbt.size) {
    for (const [key, nbt] of opts.nbt ?? []) {
      const out = stickByNbt.get(`${key.replace(/#.*$/, '')}|${canonicalNbt(nbt)}`);
      if (out) stickOutput.set(key, out);
    }
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
      for (const f of data?.componentFamiliar?.[key] ?? []) s.add(f);
      const stick = stickOutput.get(key);
      if (stick) s.add(stick);
      for (const a of data?.recipeAssociations?.[key] ?? []) s.add(a);
      // Ore blocks: the same ore in every stone (meta % 1000 + stone * 1000).
      const ore = GT_ORES.exec(key);
      if (ore) for (let n = 0; n < 8; n++) s.add(`${ore[1]}@${(Number(ore[2]) % 1000) + n * 1000}`);
      fluidStacks(key, s);
      // A recipe's output slot also holds every item GT unifies to that output
      // (GTOreDictUnificator.getNonUnifiedStacks), so each looked-up item matches its target's recipes.
      for (const k of [...s]) s.add(unified(k, false));
      return finish(key, s);
    },
    usages(key) {
      const s = new Set<string>([key, unified(key, false)]);
      for (const f of group(key)?.familiar ?? []) s.add(f);
      const stick = stickOutput.get(key);
      if (stick) s.add(stick);
      for (const a of data?.usageAssociations?.[key] ?? []) s.add(a);
      fluidStacks(key, s);
      return finish(key, s);
    },
    *keys() {
      yield* groupOf.keys();
      yield* fluidOf.keys();
      for (const f of containersOf.keys()) yield `fluid:${f}`;
      yield* stickOutput.keys();
      yield* Object.keys(data?.componentFamiliar ?? {});
      yield* Object.keys(data?.recipeAssociations ?? {});
      yield* Object.keys(data?.usageAssociations ?? {});
    },
  };
}
