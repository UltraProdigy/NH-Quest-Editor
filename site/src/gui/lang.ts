// Translation strings from Minecraft .lang files (QuestTranslation.translate / I18n.format).

import { resourceUrl } from './assets.ts';

const strings = new Map<string, string>();

export async function loadLang(domains: string[], locale = 'en_US') {
  await Promise.all(
    domains.map(async (d) => {
      const r = await fetch(resourceUrl(`${d}:lang/${locale}.lang`));
      if (!r.ok) return;
      for (const raw of (await r.text()).split(/\r?\n/)) {
        if (!raw || raw.startsWith('#')) continue;
        const i = raw.indexOf('=');
        if (i > 0) strings.set(raw.slice(0, i), raw.slice(i + 1));
      }
    }),
  );
}

// A few vanilla strings used by the questbook.
const VANILLA: Record<string, string> = {
  'gui.back': 'Back',
  'gui.yes': 'Yes',
  'gui.no': 'No',
  'gui.done': 'Done',
  'gui.cancel': 'Cancel',
};

/** java.lang.String.format subset: %s, %d, %n$s, %%. */
export function format(pattern: string, args: unknown[]): string {
  let auto = 0;
  return pattern.replace(/%(?:(\d+)\$)?([sdfn%])/g, (m, pos: string | undefined, kind: string) => {
    if (kind === '%') return '%';
    if (kind === 'n') return '\n';
    const idx = pos ? Number(pos) - 1 : auto++;
    if (idx >= args.length) return m;
    const v = args[idx];
    return kind === 'd' ? String(Math.trunc(Number(v))) : String(v);
  });
}

export function tr(key: string, ...args: unknown[]): string {
  const s = strings.get(key) ?? VANILLA[key];
  if (s === undefined) return key;
  return format(s, args);
}

export const hasTr = (key: string) => strings.has(key) || key in VANILLA;
