// Reader for BetterQuesting's NBT-as-JSON files.
//
// BetterQuesting writes every key as "name:<nbt type id>". Long values (type 4)
// are 64-bit and often exceed Number.MAX_SAFE_INTEGER (quest UUID halves, mod
// NBT), so a plain JSON.parse would silently corrupt them. This parser returns
// long values as bigint and everything else as ordinary JSON values. Key order
// is preserved as written.

export type BqValue = string | number | bigint | boolean | null | BqValue[] | BqObject;
export interface BqObject {
  [key: string]: BqValue;
}

export const NBT = {
  BYTE: 1,
  SHORT: 2,
  INT: 3,
  LONG: 4,
  FLOAT: 5,
  DOUBLE: 6,
  STRING: 8,
  LIST: 9,
  COMPOUND: 10,
  INT_ARRAY: 11,
} as const;

/** Split "name:8" into ["name", 8]. Keys without a type suffix return type -1. */
export function splitKey(key: string): [string, number] {
  const i = key.lastIndexOf(':');
  if (i < 0) return [key, -1];
  const t = Number(key.slice(i + 1));
  return Number.isInteger(t) ? [key.slice(0, i), t] : [key, -1];
}

export function parseBq(text: string): BqValue {
  let pos = 0;

  const fail = (msg: string): never => {
    throw new SyntaxError(`${msg} at offset ${pos}`);
  };
  const ws = () => {
    for (;;) {
      const c = text.charCodeAt(pos);
      if (c === 32 || c === 10 || c === 13 || c === 9) pos++;
      else break;
    }
  };

  const str = (): string => {
    // pos is on the opening quote
    pos++;
    let out = '';
    let start = pos;
    for (;;) {
      const c = text.charCodeAt(pos);
      if (Number.isNaN(c)) fail('Unterminated string');
      if (c === 34) {
        out += text.slice(start, pos);
        pos++;
        return out;
      }
      if (c === 92) {
        out += text.slice(start, pos);
        const e = text[pos + 1];
        pos += 2;
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const hex = text.slice(pos, pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('Bad unicode escape');
            out += String.fromCharCode(parseInt(hex, 16));
            pos += 4;
            break;
          }
          default: fail('Bad escape');
        }
        start = pos;
      } else {
        pos++;
      }
    }
  };

  const num = (asLong: boolean): number | bigint => {
    const m = /-?\d+(\.\d+)?([eE][+-]?\d+)?/y;
    m.lastIndex = pos;
    const r = m.exec(text);
    if (!r) return fail('Bad number');
    pos += r[0].length;
    if (asLong && r[1] === undefined && r[2] === undefined) return BigInt(r[0]);
    return Number(r[0]);
  };

  const value = (type: number): BqValue => {
    ws();
    const c = text[pos];
    if (c === '{') return obj();
    if (c === '[') return arr();
    if (c === '"') return str();
    if (c === 't' && text.startsWith('true', pos)) { pos += 4; return true; }
    if (c === 'f' && text.startsWith('false', pos)) { pos += 5; return false; }
    if (c === 'n' && text.startsWith('null', pos)) { pos += 4; return null; }
    return num(type === NBT.LONG);
  };

  const obj = (): BqObject => {
    pos++;
    const out: BqObject = {};
    ws();
    if (text[pos] === '}') { pos++; return out; }
    for (;;) {
      ws();
      if (text[pos] !== '"') fail('Expected key');
      const key = str();
      ws();
      if (text[pos] !== ':') fail('Expected ":"');
      pos++;
      out[key] = value(splitKey(key)[1]);
      ws();
      if (text[pos] === ',') { pos++; continue; }
      if (text[pos] === '}') { pos++; return out; }
      fail('Expected "," or "}"');
    }
  };

  const arr = (): BqValue[] => {
    pos++;
    const out: BqValue[] = [];
    ws();
    if (text[pos] === ']') { pos++; return out; }
    for (;;) {
      out.push(value(-1));
      ws();
      if (text[pos] === ',') { pos++; continue; }
      if (text[pos] === ']') { pos++; return out; }
      fail('Expected "," or "]"');
    }
  };

  const v = value(-1);
  ws();
  if (pos !== text.length) fail('Trailing data');
  return v;
}

/** Read an NBT list stored as {"0:10": ..., "1:10": ...} as an array in index order. */
export function bqList(v: BqValue | undefined): BqValue[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
  return Object.keys(v)
    .map((k) => [Number(splitKey(k)[0]), v[k]] as const)
    .sort((a, b) => a[0] - b[0])
    .map((e) => e[1]);
}

/** Encode a quest/questline UUID the way BetterQuesting names its files (URL-safe base64, padded). */
export function uuidToB64(high: bigint, low: bigint): string {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setBigInt64(0, BigInt.asIntN(64, high));
  view.setBigInt64(8, BigInt.asIntN(64, low));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_');
}
