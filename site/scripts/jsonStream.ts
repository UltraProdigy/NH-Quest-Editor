// Streaming JSON reader for files too big to hold as one string (the game-data export is several
// hundred MB, close to V8's string limit).
//
// The caller decides, container by container, what to build:
// - "keep": the container is built in full and attached to its parent.
// - "scan": only its scalar members and the children it keeps are collected; when it closes it is
//   handed to `onScan` and dropped (not attached to its parent).
// The root is always scanned and returned. Memory therefore stays at what the caller keeps plus
// one path of open containers.
//
// Values follow JSON.parse (numbers are doubles). Input is UTF-8 bytes in any chunking; `.gz`
// files are decompressed on the fly.

import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';

export type JsonPath = readonly (string | number)[];
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface StreamHandlers {
  /**
   * Mode of a container opening inside a scanned container. `path` is its location (reused between
   * calls; copy it to keep it) and `parent` the scalars and kept children its parent has so far.
   */
  mode?(path: JsonPath, parent: Record<string, Json> | Json[]): 'keep' | 'scan';
  /** Called with each scanned container (except the root) when it closes. */
  onScan?(path: JsonPath, value: Record<string, Json> | Json[]): void;
}

interface Frame {
  arr: boolean;
  keep: boolean;
  value: Record<string, Json> | Json[];
  key: string | null; // objects: key of the member being read
  index: number; // arrays: index of the next element
}

const B = {
  QUOTE: 0x22,
  BACKSLASH: 0x5c,
  COMMA: 0x2c,
  COLON: 0x3a,
  LBRACE: 0x7b,
  RBRACE: 0x7d,
  LBRACKET: 0x5b,
  RBRACKET: 0x5d,
} as const;

export class JsonStreamParser {
  private stack: Frame[] = [];
  private path: (string | number)[] = [];
  private carry: Buffer | null = null;
  private root: Json | undefined = undefined;
  private done = false;

  private readonly h: StreamHandlers;

  constructor(handlers: StreamHandlers = {}) {
    this.h = handlers;
  }

  /** Feed the next chunk of bytes. */
  write(chunk: Buffer) {
    const buf = this.carry ? Buffer.concat([this.carry, chunk]) : chunk;
    this.carry = null;
    const used = this.parse(buf, false);
    if (used < buf.length) this.carry = Buffer.from(buf.subarray(used));
  }

  /** Signal the end of input and return the root value. */
  end(): Json {
    if (this.carry) {
      const buf = this.carry;
      this.carry = null;
      const used = this.parse(buf, true);
      if (used < buf.length && buf.subarray(used).toString().trim()) throw new SyntaxError('JSON: unexpected trailing data');
    }
    if (this.stack.length || this.root === undefined) throw new SyntaxError('JSON: unexpected end of input');
    return this.root;
  }

  private open(arr: boolean) {
    const parent = this.stack[this.stack.length - 1];
    let keep = false;
    if (parent) {
      this.path.push(parent.arr ? parent.index : (parent.key as string));
      keep = parent.keep || (this.h.mode ? this.h.mode(this.path, parent.value) === 'keep' : false);
    }
    this.stack.push({ arr, keep, value: arr ? [] : {}, key: null, index: 0 });
  }

  private close(arr: boolean) {
    const f = this.stack.pop();
    if (!f || f.arr !== arr) throw new SyntaxError('JSON: mismatched bracket');
    const parent = this.stack[this.stack.length - 1];
    if (!parent) {
      this.root = f.value;
      this.done = true;
      return;
    }
    if (f.keep) this.attach(parent, f.value);
    else {
      this.h.onScan?.(this.path, f.value);
      this.skip(parent);
    }
    this.path.pop();
  }

  private attach(parent: Frame, v: Json) {
    if (parent.arr) {
      (parent.value as Json[]).push(v);
      parent.index++;
    } else {
      (parent.value as Record<string, Json>)[parent.key as string] = v;
      parent.key = null;
    }
  }

  private skip(parent: Frame) {
    if (parent.arr) {
      // Keep indexes stable for the caller's paths; scanned arrays hold only what was attached.
      parent.index++;
    } else parent.key = null;
  }

  private scalar(v: Json) {
    const parent = this.stack[this.stack.length - 1];
    if (!parent) {
      this.root = v;
      this.done = true;
      return;
    }
    if (parent.arr) {
      if (parent.keep) (parent.value as Json[]).push(v);
      parent.index++;
    } else this.attach(parent, v);
  }

  /** Parse as much of `buf` as forms complete tokens; returns the number of bytes consumed. */
  private parse(buf: Buffer, final: boolean): number {
    const n = buf.length;
    let i = 0;
    while (i < n) {
      const c = buf[i];
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === B.COMMA || c === B.COLON) {
        i++;
        continue;
      }
      if (this.done) throw new SyntaxError(`JSON: unexpected data after the root value`);
      switch (c) {
        case B.LBRACE:
          this.open(false);
          i++;
          continue;
        case B.LBRACKET:
          this.open(true);
          i++;
          continue;
        case B.RBRACE:
          this.close(false);
          i++;
          continue;
        case B.RBRACKET:
          this.close(true);
          i++;
          continue;
        case B.QUOTE: {
          let j = i + 1;
          let escaped = false;
          for (;;) {
            if (j >= n) return i; // incomplete string
            const d = buf[j];
            if (d === B.QUOTE) break;
            if (d === B.BACKSLASH) {
              escaped = true;
              j += 2;
            } else j++;
          }
          const s = escaped ? (JSON.parse(buf.toString('utf8', i, j + 1)) as string) : buf.toString('utf8', i + 1, j);
          i = j + 1;
          const top = this.stack[this.stack.length - 1];
          if (top && !top.arr && top.key === null) top.key = s;
          else this.scalar(s);
          continue;
        }
        case 0x74: // true
          if (i + 4 > n) return i;
          this.scalar(true);
          i += 4;
          continue;
        case 0x66: // false
          if (i + 5 > n) return i;
          this.scalar(false);
          i += 5;
          continue;
        case 0x6e: // null
          if (i + 4 > n) return i;
          this.scalar(null);
          i += 4;
          continue;
        default: {
          if (c !== 0x2d && (c < 0x30 || c > 0x39)) {
            throw new SyntaxError(`JSON: unexpected byte 0x${c.toString(16)} at ${i}`);
          }
          let j = i + 1;
          while (j < n) {
            const d = buf[j];
            if ((d >= 0x30 && d <= 0x39) || d === 0x2e || d === 0x65 || d === 0x45 || d === 0x2b || d === 0x2d) j++;
            else break;
          }
          if (j === n && !final) return i; // the number may continue in the next chunk
          const v = Number(buf.toString('latin1', i, j));
          if (Number.isNaN(v)) throw new SyntaxError(`JSON: bad number at ${i}`);
          this.scalar(v);
          i = j;
        }
      }
    }
    return i;
  }
}

/** Stream a JSON file (gzipped when it ends in `.gz`) through a parser; returns the root. */
export async function parseJsonFile(file: string, handlers: StreamHandlers = {}): Promise<Json> {
  const parser = new JsonStreamParser(handlers);
  let input: AsyncIterable<Buffer> = createReadStream(file, { highWaterMark: 4 << 20 });
  if (file.endsWith('.gz')) input = (input as NodeJS.ReadableStream).pipe(createGunzip({ chunkSize: 1 << 20 }));
  for await (const chunk of input) parser.write(chunk as Buffer);
  return parser.end();
}
