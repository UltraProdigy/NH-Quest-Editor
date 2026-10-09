// BetterQuesting's DefaultQuests folder as a database, read and written the way BetterQuesting
// does it (QuestCommandDefaults.load / save in GTNewHorizons/BetterQuesting, MIT).
//
// Layout:
//   QuestSettings.json
//   QuestLinesOrder.txt                  "<base64 id>: <name without formatting>" per line, in order
//   QuestLines/<name>-<id>/QuestLine.json
//   QuestLines/<name>-<id>/<quest name>-<quest id>.json   one placement per quest in the line
//   Quests/<line name>-<line id>/<quest name>-<quest id>.json   quests in exactly one line
//   Quests/MultipleQuestLine/...         quests in two or more lines
//   Quests/NoQuestLine/...               quests in no line
//
// The database keeps every file's NBT tree exactly as read (unknown keys included), so saving an
// unchanged database gives back the same files byte for byte.

import { parseBq, uuidToB64 } from './bqjson.ts';
import type { BqObject, BqValue } from './bqjson.ts';
import { writeBq } from './bqwrite.ts';

export const SETTINGS_FILE = 'QuestSettings.json';
export const QUEST_LINE_ORDER_FILE = 'QuestLinesOrder.txt';
export const QUEST_LINE_DIR = 'QuestLines';
export const QUEST_DIR = 'Quests';
export const QUEST_LINE_FILE = 'QuestLine.json';
export const MULTI_QUEST_LINE_DIRECTORY = 'MultipleQuestLine';
export const NO_QUEST_LINE_DIRECTORY = 'NoQuestLine';
export const FILE_NAME_MAX_LENGTH = 16;

export interface QuestLineRecord {
  /** QuestLine.json: properties plus questLineIDHigh/Low. */
  tag: BqObject;
  /** Placements by quest id (x, y, sizeX, sizeY plus questIDHigh/Low), in file-read order. */
  entries: Map<string, BqObject>;
}

export interface QuestDb {
  settings: BqObject;
  /** Quest lines by id, in QuestLinesOrder.txt order. */
  lines: Map<string, QuestLineRecord>;
  /** Quests by id. */
  quests: Map<string, BqObject>;
}

const isObj = (v: BqValue | undefined): v is BqObject => !!v && typeof v === 'object' && !Array.isArray(v);

const long = (v: BqValue | undefined): bigint => (typeof v === 'bigint' ? v : BigInt((v as number) ?? 0));

/** The base64 id BetterQuesting writes for "<prefix>IDHigh:4" / "<prefix>IDLow:4". */
export const tagId = (tag: BqObject, prefix: 'quest' | 'questLine'): string =>
  uuidToB64(long(tag[`${prefix}IDHigh:4`]), long(tag[`${prefix}IDLow:4`]));

/** NativeProps.NAME of a quest or quest line tag. */
export function tagName(tag: BqObject): string {
  const props = tag['properties:10'];
  const bq = isObj(props) ? props['betterquesting:10'] : undefined;
  const name = isObj(bq) ? bq['name:8'] : undefined;
  return typeof name === 'string' ? name : '';
}

const isHexChar = (c: string): boolean => /^[0-9a-fA-F]$/.test(c);
const isFormatColor = (c: string): boolean => isHexChar(c);

function isValidSectionX(t: string, pos: number): boolean {
  if (pos + 14 > t.length || t[pos] !== '§' || t[pos + 1].toLowerCase() !== 'x') return false;
  for (let i = 0; i < 6; i++) {
    const p = pos + 2 + i * 2;
    if (t[p] !== '§' || !isHexChar(t[p + 1])) return false;
  }
  return true;
}

const isHex6 = (t: string, start: number): boolean =>
  start + 6 <= t.length && /^[0-9a-fA-F]{6}$/.test(t.slice(start, start + 6));

function isSingleCode(c: string): boolean {
  const l = c.toLowerCase();
  return isFormatColor(c) || (l >= 'k' && l <= 'o') || l === 'r' || l === 'q' || l === 'z' || l === 'v';
}

function isStrippableSingleCode(c: string): boolean {
  const l = c.toLowerCase();
  return isSingleCode(c) || l === 'u' || l === 'x' || l === 'g';
}

function formattingTokenLength(t: string, pos: number): number {
  const marker = t[pos];
  if (marker === '§' && pos + 1 < t.length) {
    const code = t[pos + 1];
    const l = code.toLowerCase();
    if (l === 'g' && pos + 30 <= t.length && isValidSectionX(t, pos + 2) && isValidSectionX(t, pos + 16)) return 30;
    if (l === 'x' && isValidSectionX(t, pos)) return 14;
    return isSingleCode(code) ? 2 : 0;
  }
  if (marker !== '&' || pos + 1 >= t.length) return 0;
  const code = t[pos + 1];
  if (
    code.toLowerCase() === 'g' && pos + 18 <= t.length &&
    t[pos + 2] === '&' && t[pos + 3] === '#' && isHex6(t, pos + 4) &&
    t[pos + 10] === '&' && t[pos + 11] === '#' && isHex6(t, pos + 12)
  ) return 18;
  if (code === '#' && pos + 8 <= t.length && isHex6(t, pos + 2)) return 8;
  return isSingleCode(code) ? 2 : 0;
}

/** BetterQuesting's TextFormattingUtils.stripFormatting: drops § and & formatting codes. */
export function stripFormatting(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length && text[i + 1] === '&') {
      out += '&';
      i += 2;
      continue;
    }
    let n = formattingTokenLength(text, i);
    if (n === 0 && (ch === '§' || ch === '&') && i + 1 < text.length && isStrippableSingleCode(text[i + 1])) n = 2;
    if (n > 0) i += n;
    else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** File and folder names: the name without formatting, letters and digits only, 16 at most, "-" and the id. */
export function buildFileName(name: string, id: string): string {
  return `${stripFormatting(name).replace(/[^a-zA-Z0-9]/g, '').slice(0, FILE_NAME_MAX_LENGTH)}-${id}`;
}

/** Read a DefaultQuests folder given as relative path ("/" separated) → file text. */
export function loadDb(files: ReadonlyMap<string, string>): QuestDb {
  const read = (path: string): BqObject => {
    try {
      return parseBq(files.get(path)!) as BqObject;
    } catch (e) {
      throw new Error(`${path}: ${(e as Error).message}`);
    }
  };
  if (!files.has(SETTINGS_FILE)) throw new Error(`No ${SETTINGS_FILE}: not a BetterQuesting database`);
  const settings = read(SETTINGS_FILE);

  const found = new Map<string, QuestLineRecord>();
  const lineDirs = new Map<string, string[]>();
  for (const path of [...files.keys()].sort()) {
    const parts = path.split('/');
    if (parts[0] !== QUEST_LINE_DIR || parts.length !== 3 || !parts[2].endsWith('.json')) continue;
    let list = lineDirs.get(parts[1]);
    if (!list) lineDirs.set(parts[1], (list = []));
    list.push(path);
  }
  for (const [dir, paths] of lineDirs) {
    const linePath = `${QUEST_LINE_DIR}/${dir}/${QUEST_LINE_FILE}`;
    if (!files.has(linePath)) throw new Error(`Missing quest line file in ${QUEST_LINE_DIR}/${dir}`);
    const tag = read(linePath);
    const entries = new Map<string, BqObject>();
    for (const p of paths) {
      if (p === linePath) continue;
      const entry = read(p);
      entries.set(tagId(entry, 'quest'), entry);
    }
    found.set(tagId(tag, 'questLine'), { tag, entries });
  }

  // Lines are ordered by QuestLinesOrder.txt; like BetterQuesting, lines missing from it are dropped.
  const lines = new Map<string, QuestLineRecord>();
  for (const row of (files.get(QUEST_LINE_ORDER_FILE) ?? '').split(/\r?\n/)) {
    if (!row) continue;
    const id = row.split(':')[0];
    const line = found.get(id);
    if (line) lines.set(id, line);
  }

  const quests = new Map<string, BqObject>();
  for (const path of files.keys()) {
    if (!path.startsWith(`${QUEST_DIR}/`)) continue;
    const tag = read(path);
    quests.set(tagId(tag, 'quest'), tag);
  }
  return { settings, lines, quests };
}

/** Write the database as BetterQuesting's "/bq_admin default save" would: relative path → file text. */
export function saveDb(db: QuestDb): Map<string, string> {
  const out = new Map<string, string>();
  out.set(SETTINGS_FILE, writeBq(db.settings));

  const questLinesOf = new Map<string, string[]>();
  const order: string[] = [];
  for (const [lineId, line] of db.lines) {
    const lineName = tagName(line.tag);
    order.push(`${lineId}: ${stripFormatting(lineName)}`);
    const dir = `${QUEST_LINE_DIR}/${buildFileName(lineName, lineId)}`;
    out.set(`${dir}/${QUEST_LINE_FILE}`, writeBq(line.tag));
    for (const [questId, entry] of line.entries) {
      let list = questLinesOf.get(questId);
      if (!list) questLinesOf.set(questId, (list = []));
      list.push(lineId);
      const quest = db.quests.get(questId);
      out.set(`${dir}/${buildFileName(quest ? tagName(quest) : '', questId)}.json`, writeBq(entry));
    }
  }
  // Files.write(path, lines): every line ends with a line separator (LF in the repo).
  out.set(QUEST_LINE_ORDER_FILE, order.map((l) => l + '\n').join(''));

  for (const [questId, quest] of db.quests) {
    const lineIds = questLinesOf.get(questId) ?? [];
    let dir: string;
    if (lineIds.length === 0) dir = NO_QUEST_LINE_DIRECTORY;
    else if (lineIds.length === 1) dir = buildFileName(tagName(db.lines.get(lineIds[0])!.tag), lineIds[0]);
    else dir = MULTI_QUEST_LINE_DIRECTORY;
    out.set(`${QUEST_DIR}/${dir}/${buildFileName(tagName(quest), questId)}.json`, writeBq(quest));
  }
  return out;
}

/**
 * Keep the base folder's spelling for paths that differ from it only in letter case.
 *
 * BetterQuesting's file names change case when a quest is renamed ("Densecables" → "DenseCables"),
 * but on Windows git keeps the old spelling of a file that already exists, so the repo holds a mix.
 * Writing the old spelling back for those files avoids a delete-and-add of the same file in a diff
 * (and two files that clash on Windows).
 */
export function matchBaseCase(files: Map<string, string>, basePaths: Iterable<string>): Map<string, string> {
  const byLower = new Map<string, string>();
  for (const p of basePaths) byLower.set(p.toLowerCase(), p);
  const out = new Map<string, string>();
  for (const [p, text] of files) out.set(byLower.get(p.toLowerCase()) ?? p, text);
  return out;
}
