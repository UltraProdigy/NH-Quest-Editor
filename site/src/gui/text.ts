// BetterQuesting's text handling: [tag] formatting (PanelTextBox/FormattingTag), line wrapping
// (RenderUtils.splitString) and format carry-over between lines.

import { SECTION, stringWidth, sizeStringToWidth } from './font.ts';
import { currentTheme } from './theme.ts';

const isFormatColor = (c: string) => /^[0-9a-fA-F]$/.test(c);
const isFormatSpecial = (c: string) => /^[k-oK-OrR]$/.test(c);
const isHex = (c: string) => /^[0-9a-fA-F]$/.test(c);
const isHex6 = (s: string, i: number) => i + 6 <= s.length && /^[0-9a-fA-F]{6}$/.test(s.slice(i, i + 6));
const isValidSectionX = (s: string, p: number) => {
  if (p + 14 > s.length || s[p] !== SECTION || s[p + 1].toLowerCase() !== 'x') return false;
  for (let k = 0; k < 6; k++) {
    const q = p + 2 + k * 2;
    if (s[q] !== SECTION || !isHex(s[q + 1])) return false;
  }
  return true;
};

/** Length of the formatting token at pos, 0 for text (RenderUtils.getFormattingTokenLength). */
export function formattingTokenLength(t: string, pos: number): number {
  if (pos < 0 || pos >= t.length) return 0;
  const m = t[pos];
  if (m === SECTION && pos + 1 < t.length) {
    const c = t[pos + 1], lc = c.toLowerCase();
    if (lc === 'g' && pos + 30 <= t.length && isValidSectionX(t, pos + 2) && isValidSectionX(t, pos + 16)) return 30;
    if (lc === 'x' && isValidSectionX(t, pos)) return 14;
    if (lc === 'r' || isFormatColor(c) || isFormatSpecial(c) || lc === 'q' || lc === 'z' || lc === 'v') return 2;
    return 0;
  }
  if (m !== '&' || pos + 1 >= t.length) return 0;
  const c = t[pos + 1], lc = c.toLowerCase();
  if (lc === 'g' && pos + 18 <= t.length && t[pos + 2] === '&' && t[pos + 3] === '#' && isHex6(t, pos + 4) &&
      t[pos + 10] === '&' && t[pos + 11] === '#' && isHex6(t, pos + 12)) return 18;
  if (c === '#' && isHex6(t, pos + 2)) return 8;
  if (lc === 'r' || isFormatColor(c) || isFormatSpecial(c) || lc === 'q' || lc === 'z' || lc === 'v') return 2;
  return 0;
}

export function resetsTextFormatting(t: string, pos: number) {
  if (!formattingTokenLength(t, pos)) return false;
  const m = t[pos], c = t[pos + 1], lc = c.toLowerCase();
  if (m === '&' && (c === '#' || lc === 'g')) return true;
  return lc === 'r' || isFormatColor(c) || lc === 'x' || lc === 'g' || lc === 'q';
}

/** RenderUtils.getFormatFromString: the formatting that carries over to the next line. */
export function getFormatFromString(s: string): string {
  let out = '';
  const len = s.length;
  for (let i = 0; i < len; i++) {
    const ch = s[i];
    if (ch === SECTION && i + 1 < len) {
      const c = s[i + 1], cl = c.toLowerCase();
      if (cl === 'g' && i + 30 <= len && isValidSectionX(s, i + 2) && isValidSectionX(s, i + 16)) {
        out = s.slice(i, i + 30);
        i += 29;
      } else if (cl === 'x' && isValidSectionX(s, i)) {
        out = s.slice(i, i + 14);
        i += 13;
      } else if (cl === 'q' || cl === 'z' || cl === 'v') {
        out += SECTION + c;
        i++;
      } else if (isFormatColor(c)) {
        out = SECTION + c;
        i++;
      } else if (isFormatSpecial(c)) {
        out += SECTION + c;
        i++;
      } else i++;
    } else if (ch === '&' && i + 1 < len) {
      const c = s[i + 1], cl = c.toLowerCase();
      if (cl === 'g' && i + 18 <= len && s[i + 2] === '&' && s[i + 3] === '#' && isHex6(s, i + 4) &&
          s[i + 10] === '&' && s[i + 11] === '#' && isHex6(s, i + 12)) {
        out = s.slice(i, i + 18);
        i += 17;
      } else if (c === '#' && isHex6(s, i + 2)) {
        out = s.slice(i, i + 8);
        i += 7;
      } else if (cl === 'q' || cl === 'z' || cl === 'v') {
        out += '&' + c;
        i++;
      } else if (isFormatColor(c)) {
        out = '&' + c;
        i++;
      } else if (isFormatSpecial(c)) {
        out += '&' + c;
        i++;
      }
    }
  }
  if (!out) return '';
  const last = out[out.length - 1];
  return last === 'r' || last === 'R' ? '' : out;
}

/** Expand &g&#RRGGBB&#RRGGBB gradients into per-character &#RRGGBB colours (RenderUtils.expandAmpGradients). */
function expandAmpGradients(text: string): string {
  let gIdx = text.indexOf('&g&#');
  if (gIdx === -1) return text;
  const hex = (n: number) => '&#' + (n & 0xffffff).toString(16).toUpperCase().padStart(6, '0');
  const lerp = (a: number, b: number, t: number) => {
    const ch = (c: number, s: number) => (c >> s) & 255;
    const m = (s: number) => Math.floor(ch(a, s) * (1 - t) + ch(b, s) * t);
    return (m(16) << 16) | (m(8) << 8) | m(0);
  };
  const isTerminator = (s: string, i: number) => {
    if (s[i] === '&' && i + 1 < s.length) {
      const nx = s[i + 1], lo = nx.toLowerCase();
      if (lo === 'g' && s.startsWith('&#', i + 2)) return true;
      if (nx === '#' && isHex6(s, i + 2)) return true;
      if (lo === 'q' || lo === 'r' || isFormatColor(nx)) return true;
    }
    if (s[i] === SECTION && i + 1 < s.length) {
      const c = s[i + 1].toLowerCase();
      if (c === 'r' || isFormatColor(s[i + 1]) || c === 'x' || c === 'q' || c === 'g') return true;
    }
    return false;
  };
  let out = '';
  let last = 0;
  while (gIdx !== -1 && gIdx + 17 < text.length) {
    if (!(text[gIdx + 2] === '&' && text[gIdx + 3] === '#' && isHex6(text, gIdx + 4) && text[gIdx + 10] === '&' &&
          text[gIdx + 11] === '#' && isHex6(text, gIdx + 12))) {
      gIdx = text.indexOf('&g&#', gIdx + 2);
      continue;
    }
    const a = parseInt(text.slice(gIdx + 4, gIdx + 10), 16);
    const b = parseInt(text.slice(gIdx + 12, gIdx + 18), 16);
    const start = gIdx + 18;
    // Count visible characters under this gradient.
    let total = 0;
    for (let i = start; i < text.length; i++) {
      if (isTerminator(text, i)) break;
      if ((text[i] === '&' || text[i] === SECTION) && formattingTokenLength(text, i) === 2) i++;
      else total++;
    }
    if (total <= 0) {
      gIdx = text.indexOf('&g&#', gIdx + 2);
      continue;
    }
    out += text.slice(last, gIdx);
    let v = 0;
    let i = start;
    for (; i < text.length; i++) {
      if (isTerminator(text, i)) break;
      if ((text[i] === '&' || text[i] === SECTION) && formattingTokenLength(text, i) === 2) {
        out += text[i] + text[i + 1];
        i++;
        continue;
      }
      out += hex(lerp(a, b, Math.min(total > 1 ? v / (total - 1) : 0, 1))) + text[i];
      v++;
      if (v >= total) {
        i++;
        break;
      }
    }
    last = i;
    gIdx = text.indexOf('&g&#', last);
  }
  return out + text.slice(last);
}

// ---------------------------------------------------------------- line breaking

const isCJK = (c: number) =>
  (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) ||
  (c >= 0xff00 && c <= 0xffef);

/**
 * Break opportunities, approximating java.text.BreakIterator.getLineInstance(): after runs of
 * spaces, after a hyphen between letters, and around CJK characters. Returns segment end offsets.
 */
function breakPoints(line: string): number[] {
  const ends: number[] = [];
  const n = line.length;
  let i = 0;
  while (i < n) {
    let j = i;
    // Leading spaces stick to the segment.
    while (j < n && line[j] === ' ') j++;
    for (; j < n; j++) {
      const c = line.charCodeAt(j);
      if (line[j] === ' ') break;
      if (isCJK(c) && j > i) break;
      if (isCJK(c)) {
        j++;
        break;
      }
      if (line[j] === '-' && j > i && /[A-Za-z]/.test(line[j - 1] ?? '') && /[A-Za-z]/.test(line[j + 1] ?? '')) {
        j++;
        break;
      }
    }
    while (j < n && line[j] === ' ') j++;
    if (j === i) j++;
    ends.push(j);
    i = j;
  }
  return ends;
}

const stripTrailing = (s: string) => s.replace(/\s+$/, '');

/**
 * RenderUtils.splitString. withFormat=true carries formatting to continuation lines (for drawing);
 * false keeps the exact characters (for hit-testing link positions).
 */
export function splitString(str: string, wrapWidth: number, withFormat = true): string[] {
  if (!str) return [];
  if (withFormat) str = expandAmpGradients(str);
  const lines = str.split('\n');
  const wraps: string[] = [];
  let format = '';
  lines.forEach((line, li) => {
    const ends = breakPoints(line);
    let start = 0;
    let width = 0;
    let buf = format;
    let k = 0;
    let end = ends[k] ?? -1;
    while (end !== -1) {
      const candidate = line.slice(start, end);
      const need = stringWidth(stripTrailing(candidate));
      const real = stringWidth(candidate);
      if (width + need <= wrapWidth) {
        buf += candidate;
        width += real;
        format = withFormat ? getFormatFromString(format + candidate) : '';
        start = end;
        end = ends[++k] ?? -1;
      } else if (need > wrapWidth) {
        const i = Math.max(1, sizeStringToWidth(candidate, wrapWidth));
        buf += candidate.slice(0, i);
        wraps.push(buf);
        if (withFormat) format = getFormatFromString(format + candidate.slice(0, i));
        buf = format;
        width = 0;
        start += i;
        if (start >= end) end = ends[++k] ?? -1;
      } else {
        wraps.push(buf);
        buf = format;
        width = 0;
      }
    }
    if (!withFormat && li !== lines.length - 1) buf += '\n';
    wraps.push(buf.length === 0 ? format : buf);
  });
  return wraps;
}

// ---------------------------------------------------------------- [tags]

const TAG_COLOUR: Record<string, string> = { note: '§3', warn: '§4', quest: '§2', url: '§1', questlink: '§1' };
const TAG_COLOUR_THEMED: Record<string, Record<string, string>> = {
  note: { 'betterquesting:ender': '§b', 'betterquesting:overworld': '§b', 'betterquesting:stronghold': '§b' },
  warn: { 'betterquesting:dark': '§c', 'betterquesting:overworld': '§c', 'betterquesting:stronghold': '§c' },
  quest: { 'betterquesting:dark': '§a', 'betterquesting:overworld': '§a', 'betterquesting:stronghold': '§a' },
  url: { 'betterquesting:dark': '§9', 'betterquesting:overworld': '§9', 'betterquesting:stronghold': '§9' },
  questlink: { 'betterquesting:dark': '§9', 'betterquesting:overworld': '§9', 'betterquesting:stronghold': '§9' },
};
const TAG_TEXT: Record<string, string> = {
  bold: '§l', italic: '§o', underline: '§n', strikethrough: '§m', obfuscated: '§k', quest: '§n', url: '§n', questlink: '§n',
};
const TAGS = new Set(['note', 'warn', 'quest', 'bold', 'italic', 'underline', 'strikethrough', 'obfuscated', 'url', 'questlink']);

export let forceMonochrome = false;
export const setForceMonochrome = (v: boolean) => (forceMonochrome = v);

const tagColour = (tag: string) => {
  if (forceMonochrome && (tag === 'url' || tag === 'questlink')) return '';
  return TAG_COLOUR_THEMED[tag]?.[currentTheme()] ?? TAG_COLOUR[tag] ?? '';
};
const tagText = (tag: string) => TAG_TEXT[tag] ?? '';

/** Quest link target: the quest id, resolved by the caller. */
export interface LinkRange {
  start: number;
  end: number;
  url?: string;
  quest?: string;
}

/** Resolves a [questlink] id to its display name, or null if it does not exist. */
export type QuestNameLookup = (id: string) => string | null;

/**
 * PanelTextBox.setText with hyperlinkAware=true: expand [tags] into formatting codes and record
 * link ranges (offsets into the returned text).
 */
export function processTags(text: string, questName: QuestNameLookup): { text: string; links: LinkRange[] } {
  const tokens = text.split(/(?=\[)|(?=§.)|(?<=\])|(?<=§.)/u);
  let out = '';
  const links: LinkRange[] = [];
  const stack: { tag: string; params: Record<string, string> }[] = [];
  let linkStart = -1;
  const reapplyAll = () => {
    for (let i = stack.length - 1; i >= 0; i--) out += tagColour(stack[i].tag);
    for (let i = stack.length - 1; i >= 0; i--) out += tagText(stack[i].tag);
  };
  // Note: java's Scanner yields the same tokens; empty tokens are dropped.
  for (const token of tokens) {
    if (!token) continue;
    if (token === '§r') {
      out += '§r';
      reapplyAll();
      continue;
    }
    if (/^§[0-9a-fxgq]$/.test(token)) {
      out += token;
      for (let i = stack.length - 1; i >= 0; i--) out += tagText(stack[i].tag);
      continue;
    }
    const open = /^\[([0-9a-zA-Z]+)((?: [0-9a-zA-Z]+=[^ ]+)*)\]$/.exec(token);
    if (open && TAGS.has(open[1])) {
      const params: Record<string, string> = {};
      for (const m of open[2].matchAll(/ ([0-9a-zA-Z]+)=([^ ]+)/g)) params[m[1]] = m[2];
      stack.push({ tag: open[1], params });
      out += tagColour(open[1]);
      for (let i = stack.length - 1; i >= 0; i--) out += tagText(stack[i].tag);
      if (open[1] === 'url' || open[1] === 'questlink') linkStart = out.length;
      continue;
    }
    const close = /^\[\/([0-9a-zA-Z]+)\]$/.exec(token);
    if (close && TAGS.has(close[1])) {
      const top = stack[stack.length - 1];
      if (top && top.tag === close[1]) {
        stack.pop();
        if (close[1] === 'url' && linkStart >= 0) {
          links.push({ start: linkStart, end: out.length, url: top.params.link ?? out.slice(linkStart) });
          linkStart = -1;
        } else if (close[1] === 'questlink' && linkStart >= 0) {
          const linkText = out.slice(linkStart);
          const sp = linkText.indexOf(' ');
          const id = sp < 0 ? linkText : linkText.slice(0, sp);
          const name = questName(id);
          let display: string;
          let ok = false;
          if (name !== null) {
            display = sp >= 0 ? linkText.slice(sp + 1) : name;
            ok = true;
          } else {
            display = '§4§lQuest Not Found§4§l';
          }
          const formatted = applyUnderline(display);
          out = out.slice(0, linkStart) + formatted;
          if (ok) links.push({ start: linkStart, end: linkStart + formatted.length, quest: id });
          linkStart = -1;
        }
        out += '§r';
        reapplyAll();
      }
      continue;
    }
    out += token;
  }
  return { text: out, links };
}

function applyUnderline(text: string): string {
  const u = '§n';
  let out = u;
  for (let i = 0; i < text.length; ) {
    const n = formattingTokenLength(text, i);
    if (n <= 0) {
      out += text[i++];
      continue;
    }
    out += text.slice(i, i + n);
    if (resetsTextFormatting(text, i)) out += u;
    i += n;
  }
  return out;
}

/** Text with all formatting removed, for search and copying (PanelTextBox.getPlainText). */
export function plainText(text: string, questName: QuestNameLookup = () => null): string {
  const processed = processTags(text.replace(/\[img height=[1-9]\d*\] *.*?:.*? *\[\/img\]/g, ''), questName).text;
  let out = '';
  for (let i = 0; i < processed.length; ) {
    const n = formattingTokenLength(processed, i);
    if (n <= 0) out += processed[i++];
    else i += n;
  }
  return out;
}
