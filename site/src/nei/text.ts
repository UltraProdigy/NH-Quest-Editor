// Text GregTech's NEI handler draws under a recipe, rebuilt from the recipe's numbers. Shared by
// the site and the data build (which keeps only the lines this does not reproduce).

const VN = ['ULV', 'LV', 'MV', 'HV', 'EV', 'IV', 'LuV', 'ZPM', 'UV', 'UHV', 'UEV', 'UIV', 'UMV', 'UXV', 'MAX', 'MAX+'];
const TIER_COLORS = ['§c', '§2', '§6', '§e', '§8', '§9', '§d', '§b', '§2§n', '§4§n', '§5§n', '§1§l§n', '§c§l§n', '§4§l§n', '§f§l§n', '§f§l§n§o'];

/** GTUtility.getTier: the lowest tier whose voltage (8 * 4^tier) covers v. */
function tierOf(v: number): number {
  let t = 0;
  while (t < 15 && 8 * 4 ** t < v) t++;
  return t;
}
const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
export const formatNumber = (n: number) => fmt.format(n);
const tierName = (v: number) => {
  const t = Math.max(1, tierOf(v));
  return `(${TIER_COLORS[t]}${VN[t]}§r)`;
};

/** EUNoOverclockDescriber.drawEnergyInfo and OverclockDescriber.drawDurationInfo: the standard lines. */
export function standardLines(e: number, d: number, amperage = 1): string[] {
  const out: string[] = [];
  if (d > 0 && e > 0) out.push(`Total: ${formatNumber(e * d)} EU`);
  if (e > 0) {
    if (amperage !== 1) {
      out.push(`Usage: ${formatNumber(e)} EU/t `);
      const v = Math.floor(e / amperage);
      out.push(`Voltage: ${formatNumber(v)} EU/t ${tierName(v)}`);
      out.push(`Amperage: ${formatNumber(amperage)} A`);
    } else out.push(`Usage: ${formatNumber(e)} EU/t ${tierName(e)}`);
  }
  if (d > 0) out.push(d / 20 > 1 ? `Time: ${formatNumber(d / 20)} seconds` : `Time: ${formatNumber(d)} ticks`);
  return out;
}

