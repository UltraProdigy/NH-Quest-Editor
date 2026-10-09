// NEI's item search (SearchTokenParser, SearchToken, SearchField.getPattern) with GTNH's settings
// (config/NEI/client.cfg): "extended" patterns (? and *, r/regex/), space works like AND, and the
// providers' modes:
// - the name, ore dictionary ($), tooltip (#) and identifier (&) are always searched: a plain word
//   matches any of them;
// - the mod name (@) and subsets (%) only with their prefix.
// Tokens are separated by spaces, "|" separates alternatives, "-" or "!" negates a token and
// quotes keep spaces in one.

/** What the search reads of an item. */
export interface SearchItem {
  name: string;
  mod: string;
  /** Tooltip lines under the name, joined with newlines, formatting removed. */
  tooltip: string;
  ores: string[];
  /**
   * What the identifier search (&) matches (IdentifierFilter): "registry name\nid:damage", or for a
   * fluid "fluid name\nfluid id"; just the registry name when the data has no numeric ids.
   */
  id: string;
  /** Position in NEI's item list, for the subset search (%). */
  pos: number;
}

export type ItemFilter = (item: SearchItem) => boolean;

const everything: ItemFilter = () => true;
const nothing: ItemFilter = () => false;

/** SearchTokenParser.SearchMode. */
const Mode = { ALWAYS: 0, PREFIX: 1, NEVER: 2 } as const;
type Mode = (typeof Mode)[keyof typeof Mode];

interface Provider {
  prefix: string;
  /** EnumChatFormatting code of the search field's highlight. */
  color: string;
  mode: Mode;
  filter: (p: RegExp) => ItemFilter;
  /** Providers that read the token's text rather than a pattern (subsets). */
  text?: (word: string) => ItemFilter;
}

/** ItemInfo.addSearchProviders and SubsetWidget's provider, in registration order. */
const PROVIDERS: Provider[] = [
  { prefix: '\0', color: 'r', mode: Mode.ALWAYS, filter: (p) => (i) => p.test(i.name) },
  { prefix: '@', color: 'd', mode: Mode.PREFIX, filter: (p) => (i) => p.test(i.mod) },
  { prefix: '$', color: 'b', mode: Mode.ALWAYS, filter: (p) => (i) => i.ores.some((o) => p.test(o)) },
  { prefix: '#', color: 'e', mode: Mode.ALWAYS, filter: (p) => (i) => p.test(i.tooltip) },
  { prefix: '&', color: '6', mode: Mode.ALWAYS, filter: (p) => (i) => p.test(i.id) },
  // SubsetWidget.DefaultParserProvider with GTNH's pattern mode: every subset whose name (spaces
  // removed, lower case) contains the text, without spaces.
  { prefix: '%', color: '5', mode: Mode.PREFIX, filter: () => nothing, text: (w) => subsetFilter(w) },
];

/** NEI's item subsets: [full name, [start, length] runs of item list positions]. */
let subsetTags: [string, number[]][] = [];
export function setSubsets(tags: [string, number[]][]) {
  subsetTags = tags;
  cache.clear();
}

function subsetFilter(word: string): ItemFilter {
  const text = word.replace(/\s+/g, '').toLowerCase();
  const runs: number[][] = [];
  for (const [name, r] of subsetTags) if (name.replace(/\s+/g, '').toLowerCase().includes(text)) runs.push(r);
  if (!runs.length) return nothing;
  const set = new Set<number>();
  for (const r of runs) for (let i = 0; i + 1 < r.length; i += 2) for (let p = r[i]; p < r[i] + r[i + 1]; p++) set.add(p);
  return (i) => set.has(i.pos);
}

/**
 * getProviders: the "always" ones in reverse registration order, then one per prefix. The prefix
 * ones come out of a HashMap keyed by their character, so in the order of the character's bucket.
 */
const providers: Provider[] = [
  ...PROVIDERS.filter((p) => p.mode === Mode.ALWAYS).reverse(),
  ...PROVIDERS.filter((p) => p.mode === Mode.PREFIX).sort((a, b) => (a.prefix.charCodeAt(0) % 16) - (b.prefix.charCodeAt(0) % 16)),
];
const PREFIXES = providers.filter((p) => p.mode === Mode.PREFIX).map((p) => p.prefix).join('');
const providerOf = (ch: string) => providers.find((p) => p.mode === Mode.PREFIX && p.prefix === ch);

/** EnumChatFormatting.getTextWithoutFormattingCodes. */
export const stripFormatting = (s: string) => s.replace(/§[0-9a-fk-or]/gi, '');

const quote = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** SearchField.getPattern, "extended" mode: ? is any character, * any run, r/.../ a regex. */
export function getPattern(search: string): RegExp | null {
  let src: string;
  if (search.length >= 3 && search.startsWith('r/') && search.endsWith('/')) {
    src = search.slice(2, -1);
  } else {
    src = '';
    let last = 0;
    for (const m of search.matchAll(/[?*]/g)) {
      src += quote(search.slice(last, m.index));
      src += m[0] === '?' ? '.' : '.+?';
      last = m.index! + 1;
    }
    src += quote(search.slice(last));
  }
  if (!src) return null;
  try {
    return new RegExp(src, 'im');
  } catch {
    return null;
  }
}

/** SearchTokenParser.splitByDelimiters: [delimiters before, text] pairs. */
export function splitByDelimiters(input: string, delimiters: string, space: boolean): [string, string][] {
  if (!delimiters) return [['', input]];
  const tokens: [string, string][] = [];
  let insideQuotes = false;
  let token = '';
  let lastEnd = 0;
  for (let index = 0; index < input.length; index++) {
    const ch = input[index];
    if (!insideQuotes && delimiters.includes(ch) && (!space || index === 0 || input[index - 1] === ' ')) {
      if (lastEnd === index) token += ch;
      else {
        tokens.push([token, input.slice(lastEnd, index)]);
        token = ch;
      }
      lastEnd = index + 1;
    } else if (!insideQuotes && space && ch !== ' ' && index > 0 && input[index - 1] === ' ') {
      tokens.push([token, input.slice(lastEnd, index)]);
      token = '';
      lastEnd = index;
    }
    if (ch === '"' && (index === 0 || input[index - 1] !== '\\')) insideQuotes = !insideQuotes;
  }
  tokens.push([token, input.slice(lastEnd)]);
  return tokens;
}

export interface SearchToken {
  ignore: string | null;
  quotes: boolean;
  firstChar: string | null;
  words: string[];
  rawText: string;
  start: number;
  end: number;
}

const isSimple = (t: SearchToken) => t.firstChar === null && !t.quotes && t.ignore === null;

function createToken(lastEnd: number, part: [string, string]): SearchToken {
  let pref = part[0];
  const query = part[1].trim();
  const t: SearchToken = {
    ignore: null, quotes: false, firstChar: null, words: [], rawText: '',
    start: lastEnd, end: lastEnd + pref.length + query.length,
  };
  if (pref.startsWith('-') || pref.startsWith('!')) {
    t.ignore = pref[0];
    pref = pref.slice(1);
  }
  if (pref && PREFIXES.includes(pref[0])) {
    t.firstChar = pref[0];
    pref = pref.slice(1);
  }
  let text = pref + query;
  t.quotes = text.length > 1 && text.startsWith('"') && text.endsWith('"');
  if (t.quotes) text = text.slice(1, -1);
  t.rawText = text;
  t.words = [t.quotes ? text.replace(/\\"/g, '"') : text];
  return t;
}

/** splitSearchText with space mode "AND": one token per word, prefixed or quoted. */
export function splitSearchText(filterText: string): SearchToken[] {
  if (!filterText) return [];
  const tokens: SearchToken[] = [];
  let lastEnd = 0;
  for (const part of splitByDelimiters(filterText, '-!' + PREFIXES, true)) {
    const token = createToken(lastEnd, part);
    const length = part[0].length + part[1].length;
    lastEnd += length;
    if (isSimple(token) && !token.rawText) continue;
    tokens.push(token);
  }
  return tokens;
}

function generateFilters(t: SearchToken, p: Provider): ItemFilter[] {
  return t.words.map((w) => {
    if (p.text) return p.text(w);
    const pattern = getPattern(w);
    return pattern ? p.filter(pattern) : nothing;
  });
}

const all = (fs: ItemFilter[]): ItemFilter => (fs.length === 1 ? fs[0] : (i) => fs.every((f) => f(i)));
const any = (fs: ItemFilter[]): ItemFilter => (fs.length === 1 ? fs[0] : (i) => fs.some((f) => f(i)));

function tokenFilter(t: SearchToken): ItemFilter | null {
  if (!t.words.length) return null;
  if (t.rawText) {
    const p = t.firstChar === null ? undefined : providerOf(t.firstChar);
    let f: ItemFilter;
    if (!p || p.mode === Mode.NEVER) {
      const fs = providers.filter((q) => q.mode === Mode.ALWAYS).map((q) => generateFilters(t, q)).filter((x) => x.length).map(all);
      f = fs.length ? any(fs) : nothing;
    } else f = all(generateFilters(t, p));
    return t.ignore !== null ? (i) => !f(i) : f;
  }
  return t.ignore === null ? nothing : null;
}

const cache = new Map<string, ItemFilter>();

/** SearchTokenParser.getFilter: the filter the search field's text stands for. */
export function getFilter(raw: string): ItemFilter {
  const text = stripFormatting(raw).toLowerCase();
  if (!text) return everything;
  let f = cache.get(text);
  if (f) return f;
  const alternatives: ItemFilter[] = [];
  for (const [, sub] of splitByDelimiters(text, '|', false)) {
    if (!sub) continue;
    const tokens = splitSearchText(sub).map(tokenFilter).filter((x): x is ItemFilter => !!x);
    if (tokens.length) alternatives.push(all(tokens));
  }
  f = alternatives.length ? any(alternatives) : everything;
  if (cache.size > 20) cache.clear();
  cache.set(text, f);
  return f;
}

/**
 * SearchTextFormatter: the search text with its parts coloured (alternatives gray, negation blue,
 * prefixed words in their provider's colour, quotes gold).
 */
export function formatSearch(text: string): string {
  let out = '';
  for (const [delims, filterText] of splitByDelimiters(text, '|', false)) {
    out += '§7' + delims;
    let start = 0;
    for (const token of splitSearchText(filterText)) {
      out += filterText.slice(start, token.start);
      const color = token.firstChar !== null ? `§${providerOf(token.firstChar)?.color ?? 'r'}` : '§r';
      if (token.ignore !== null) out += '§9' + token.ignore;
      if (token.firstChar !== null) out += color + token.firstChar;
      if (token.quotes) out += '§6"';
      if (token.rawText) out += color + token.rawText;
      if (token.quotes) out += '§6"';
      start = token.end;
    }
    out += filterText.slice(start);
  }
  return out;
}
