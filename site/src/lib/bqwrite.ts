// Writer for BetterQuesting's NBT-as-JSON files: the inverse of parseBq.
//
// BetterQuesting saves through NBTConverter.NBTtoJSON_Compound(tag, new JsonObject(), true) and a
// Gson with setPrettyPrinting(). To give byte-identical files this writer copies what those do:
// - compound keys sorted like Java's TreeSet<String> on the name without the ":type" suffix
//   (UTF-16 code unit order);
// - lists (type 9) written as objects with "<index>:<type>" keys, in index order;
// - empty objects and arrays as {} and [];
// - Gson's pretty printing: two-space indent, ": " after keys, no trailing newline;
// - Gson's HTML-safe string escapes (< > & = ' as < etc.);
// - floats (type 5) as Java's Float.toString and doubles (type 6) as Double.toString;
// - longs (type 4) from bigint, so 64-bit values survive.

import { splitKey, NBT } from './bqjson.ts';
import type { BqObject, BqValue } from './bqjson.ts';

const HEX = '0123456789abcdef';

/** A JSON string as Gson writes it with HTML-safe escaping on. */
export function gsonString(s: string): string {
  let out = '"';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep: string | undefined;
    if (c < 0x20) {
      switch (c) {
        case 0x09: rep = '\\t'; break;
        case 0x08: rep = '\\b'; break;
        case 0x0a: rep = '\\n'; break;
        case 0x0d: rep = '\\r'; break;
        case 0x0c: rep = '\\f'; break;
        default: rep = '\\u00' + HEX[c >> 4] + HEX[c & 15];
      }
    } else {
      switch (c) {
        case 0x22: rep = '\\"'; break;
        case 0x5c: rep = '\\\\'; break;
        case 0x3c: rep = '\\u003c'; break;
        case 0x3e: rep = '\\u003e'; break;
        case 0x26: rep = '\\u0026'; break;
        case 0x3d: rep = '\\u003d'; break;
        case 0x27: rep = '\\u0027'; break;
        case 0x2028: rep = '\\u2028'; break;
        case 0x2029: rep = '\\u2029'; break;
      }
    }
    if (rep !== undefined) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return out + s.slice(start) + '"';
}

/**
 * Format shortest round-trip digits the way Java's Double.toString / Float.toString do:
 * plain notation with at least one decimal for 1e-3 <= |x| < 1e7, otherwise "d.dddE<exp>".
 * `digits` are the significant digits (no dot, no leading zeros), `exp` the decimal exponent of
 * the first digit (x = 0.d1d2... * 10^(exp+1)).
 */
function javaDecimal(neg: boolean, digits: string, exp: number, magnitude: number): string {
  const sign = neg ? '-' : '';
  if (magnitude >= 1e-3 && magnitude < 1e7) {
    let s: string;
    if (exp >= 0) {
      const int = digits.length > exp + 1 ? digits.slice(0, exp + 1) : digits.padEnd(exp + 1, '0');
      const frac = digits.length > exp + 1 ? digits.slice(exp + 1) : '0';
      s = `${int}.${frac}`;
    } else {
      s = `0.${'0'.repeat(-exp - 1)}${digits}`;
    }
    return sign + s;
  }
  const mant = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : `${digits}.0`;
  return `${sign}${mant}E${exp}`;
}

/** Split a toExponential() string ("1.2345e-7") into digits and exponent. */
function expParts(s: string): [string, number] {
  const [m, e] = s.split('e');
  return [m.replace('.', '').replace(/0+$/, '') || '0', Number(e)];
}

/** Java's Double.toString. */
export function javaDouble(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const a = Math.abs(x);
  let [digits, exp] = expParts(a.toExponential());
  // Java always prints two significant digits when one would do, choosing the closer pair
  // (4.9E-324 for Double.MIN_VALUE, where the shortest form is 5e-324).
  if (digits.length === 1) {
    const two = a.toExponential(1);
    if (Number(two) === a) [digits, exp] = expParts(two);
  }
  return javaDecimal(x < 0, digits, exp, a);
}

/** Java's Float.toString for a value already rounded to float precision. */
export function javaFloat(x: number): string {
  const f = Math.fround(x);
  if (Number.isNaN(f)) return 'NaN';
  if (f === Infinity) return 'Infinity';
  if (f === -Infinity) return '-Infinity';
  if (f === 0) return Object.is(f, -0) ? '-0.0' : '0.0';
  const a = Math.abs(f);
  let best = a.toExponential(8);
  for (let p = 0; p < 9; p++) {
    let s = a.toExponential(p);
    if (Math.fround(Number(s)) !== a) continue;
    // toExponential rounds an exact half up; Java takes the even neighbour on a tie.
    const [full] = a.toExponential(100).split('e');
    const fd = full.replace('.', '');
    if (fd[p + 1] === '5' && /^0*$/.test(fd.slice(p + 2)) && Number(s.split('e')[0].slice(-1)) % 2 === 1) {
      const down = `${fd[0]}${p > 0 ? '.' + fd.slice(1, p + 1) : ''}e${s.split('e')[1]}`;
      if (Math.fround(Number(down)) === a) s = down;
    }
    best = s;
    break;
  }
  if (expParts(best)[0].length === 1) {
    const two = a.toExponential(1);
    if (Math.fround(Number(two)) === a) best = two;
  }
  const [digits, exp] = expParts(best);
  return javaDecimal(f < 0, digits, exp, a);
}

/** Java String.compareTo order (UTF-16 code units), the order of a TreeSet<String>. */
const javaCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isObject = (v: BqValue): v is BqObject => !!v && typeof v === 'object' && !Array.isArray(v);

function numberText(v: number | bigint, type: number): string {
  if (typeof v === 'bigint') return v.toString();
  if (type === NBT.FLOAT) return javaFloat(v);
  if (type === NBT.DOUBLE) return javaDouble(v);
  if (Number.isInteger(v)) return String(v);
  // An untyped or integer-typed value that isn't whole: Gson writes the Number's toString.
  return javaDouble(v);
}

function write(v: BqValue, type: number, indent: string): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return gsonString(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' || typeof v === 'bigint') return numberText(v, type);
  const inner = indent + '  ';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    // Byte and int arrays (types 7 and 11) hold plain whole numbers.
    return `[\n${v.map((x) => inner + write(x, -1, inner)).join(',\n')}\n${indent}]`;
  }
  const keys = Object.keys(v);
  if (keys.length === 0) return '{}';
  const parts = keys.map((k) => {
    const [name, t] = splitKey(k);
    return { k, name, t };
  });
  if (type === NBT.LIST) parts.sort((a, b) => Number(a.name) - Number(b.name));
  else parts.sort((a, b) => javaCompare(a.name, b.name));
  return `{\n${parts.map((p) => `${inner}${gsonString(p.k)}: ${write(v[p.k], p.t, inner)}`).join(',\n')}\n${indent}}`;
}

/** Serialize a BetterQuesting compound exactly as BetterQuesting saves it. */
export function writeBq(v: BqObject): string {
  if (!isObject(v)) throw new TypeError('writeBq expects a compound');
  return write(v, NBT.COMPOUND, '');
}
