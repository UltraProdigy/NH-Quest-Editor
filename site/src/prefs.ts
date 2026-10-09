// Per-viewer preferences, kept in localStorage when it is available.

export interface Prefs {
  theme: string;
  scale: number;
  state: string;
  markHidden: boolean;
  arrows: boolean;
  implicit: boolean;
  mono: boolean;
  /** The questline list stays open (BQ's lock button); on by default here. */
  trayLock: boolean;
  /** Edit mode (the site's editor) is on. */
  editMode: boolean;
}

const KEY = 'nhqe.prefs.v1';
const defaults: Prefs = {
  theme: 'betterquesting:light',
  scale: 0,
  state: 'UNLOCKED',
  markHidden: true,
  arrows: true,
  implicit: false,
  mono: false,
  trayLock: true,
  editMode: false,
};

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaults, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    // storage unavailable (private mode, blocked): use defaults
  }
  return { ...defaults };
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // ignore
  }
}
