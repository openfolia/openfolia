import { brotliDecompressSync, inflateSync } from 'node:zlib';

/**
 * Font files (#555): what an uploaded font is, told by its structure, never by its name or a
 * client's claim, and the facts a font picker shows (family, style, copyright, licence). Only
 * what validating needs is parsed: the table directory, and the `head`, `name` and `OS/2`
 * tables (inflated from WOFF, brotli-decompressed from WOFF2, within a bound). Outlines are
 * never read here; the compiling child turns WOFF and WOFF2 into TrueType/OpenType for Typst.
 * Never throws on any input, and every loop is bounded by a checked count.
 */

/** The font formats an upload may be. */
export type FontFileFormat = 'ttf' | 'otf' | 'woff' | 'woff2';

/** The media type a font is stored and served as, fixed by its format. */
export const FONT_MEDIA_TYPES: Readonly<Record<FontFileFormat, string>> = {
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

/** How many of a file's first bytes `fontFileFormat` reads. */
export const FONT_SNIFF_BYTES = 4;

/** The most tables a font may have (real fonts have about 10 to 30). */
const MAX_TABLES = 64;

/** The most bytes the tables of a WOFF or WOFF2 file are decoded to, at all. */
export const MAX_DECODED_FONT_BYTES = 64 * 1024 * 1024;
/**
 * By default a file's tables may decode to at most this many times its own size (and 1 MiB
 * for a small one), so a few compressed bytes never become 64 MiB: real fonts compress about
 * two to four times.
 */
const DECODE_RATIO = 8;
const MIN_DECODED_BYTES = 1024 * 1024;
/** A backstop: the most name records decoded per font (one per name ID and rank, 35, already). */
const MAX_NAMES_DECODED = 64;

const SFNT_TRUETYPE = 0x00010000;
const SFNT_TRUE = 0x74727565; // 'true'
const SFNT_OTTO = 0x4f54544f; // 'OTTO'
const WOFF = 0x774f4646; // 'wOFF'
const WOFF2 = 0x774f4632; // 'wOF2'
const HEAD_MAGIC = 0x5f0f3cf5;

/** A font's format by its first 4 bytes only; `undefined` for anything else (a collection too). */
export function fontFileFormat(head: Uint8Array): FontFileFormat | undefined {
  if (head.byteLength < 4) return undefined;
  switch (u32(head, 0)) {
    case SFNT_TRUETYPE:
    case SFNT_TRUE:
      return 'ttf';
    case SFNT_OTTO:
      return 'otf';
    case WOFF:
      return 'woff';
    case WOFF2:
      return 'woff2';
    default:
      return undefined;
  }
}

/** What a font file says of itself, for the picker. */
export interface FontFacts {
  readonly format: FontFileFormat;
  /** The typographic family (name ID 16), else the family (1). */
  readonly family: string;
  /** The typographic subfamily (17), else the subfamily (2): `Regular`, `Bold Italic`, … */
  readonly subfamily: string;
  /** `OS/2` `usWeightClass` (1 to 1000), else 700 or 400 by `head.macStyle`. */
  readonly weight: number;
  readonly italic: boolean;
  /** Name ID 0. */
  readonly copyright: string | null;
  /** Name ID 13, the licence description. */
  readonly licence: string | null;
  /** Name ID 14, the licence's URL. */
  readonly licenceUrl: string | null;
}

export type FontInspection =
  | { readonly ok: true; readonly facts: FontFacts }
  | {
      readonly ok: false;
      /** `not-a-font`: no font signature; `malformed`: a font signature, but broken. */
      readonly reason: 'not-a-font' | 'malformed';
      readonly detail: string;
    };

/** Thrown inside the parser only; `inspectFont` turns it into `malformed`. */
class Malformed extends Error {}

const fail = (detail: string): never => {
  throw new Malformed(detail);
};

/**
 * Whether `bytes` is a TrueType, OpenType, WOFF or WOFF2 font, checked by its structure
 * (signature, table directory within the file, the tables a font needs, `head`'s magic
 * number, a family name), and its facts. A collection (`ttcf`) is no font here.
 */
export function inspectFont(
  bytes: Uint8Array,
  {
    maxDecodedBytes = Math.min(
      MAX_DECODED_FONT_BYTES,
      Math.max(MIN_DECODED_BYTES, bytes.byteLength * DECODE_RATIO),
    ),
  }: { maxDecodedBytes?: number } = {},
): FontInspection {
  const format = fontFileFormat(bytes);
  if (!format) {
    return {
      ok: false,
      reason: 'not-a-font',
      detail: 'The file is no TrueType, OpenType, WOFF or WOFF2 font.',
    };
  }
  try {
    const tables =
      format === 'woff'
        ? woffTables(bytes, maxDecodedBytes)
        : format === 'woff2'
          ? woff2Tables(bytes, maxDecodedBytes)
          : sfntTables(bytes);
    return { ok: true, facts: { format, ...facts(tables) } };
  } catch (error) {
    if (error instanceof Malformed) {
      return { ok: false, reason: 'malformed', detail: error.message };
    }
    // A bound of zlib or brotli (output too large, corrupt stream), or anything unforeseen.
    return {
      ok: false,
      reason: 'malformed',
      detail: 'The font file cannot be decoded.',
    };
  }
}

/** A table's bytes by tag; `undefined` for one only the WOFF2 transform holds. */
type Tables = Map<string, Uint8Array | undefined>;

function sfntTables(bytes: Uint8Array): Tables {
  if (bytes.byteLength < 12) fail('The font is shorter than its header.');
  const flavor = u32(bytes, 0);
  const numTables = u16(bytes, 4);
  if (numTables < 1 || numTables > MAX_TABLES) {
    fail(`The font names ${numTables} tables.`);
  }
  if (12 + numTables * 16 > bytes.byteLength) {
    fail('The table directory runs past the file.');
  }
  const tables: Tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16;
    const tag = tagAt(bytes, at);
    const offset = u32(bytes, at + 8);
    const length = u32(bytes, at + 12);
    if (offset + length > bytes.byteLength) {
      fail(`The table ${quoted(tag)} runs past the file.`);
    }
    if (tables.has(tag)) fail(`The table ${quoted(tag)} is there twice.`);
    tables.set(tag, bytes.subarray(offset, offset + length));
  }
  requireTables(tables, flavor);
  return tables;
}

function woffTables(bytes: Uint8Array, maxDecoded: number): Tables {
  if (bytes.byteLength < 44) fail('The WOFF file is shorter than its header.');
  const flavor = u32(bytes, 4);
  if (u32(bytes, 8) !== bytes.byteLength) {
    fail('The WOFF header gives another length than the file has.');
  }
  const numTables = u16(bytes, 12);
  if (numTables < 1 || numTables > MAX_TABLES) {
    fail(`The font names ${numTables} tables.`);
  }
  if (44 + numTables * 20 > bytes.byteLength) {
    fail('The table directory runs past the file.');
  }
  const tables: Tables = new Map();
  let decoded = 0;
  for (let i = 0; i < numTables; i++) {
    const at = 44 + i * 20;
    const tag = tagAt(bytes, at);
    const offset = u32(bytes, at + 4);
    const compLength = u32(bytes, at + 8);
    const origLength = u32(bytes, at + 12);
    if (offset + compLength > bytes.byteLength) {
      fail(`The table ${quoted(tag)} runs past the file.`);
    }
    if (compLength > origLength) {
      fail(`The table ${quoted(tag)} is longer compressed than its length.`);
    }
    decoded += origLength;
    if (decoded > maxDecoded) fail('The font decodes to too many bytes.');
    if (tables.has(tag)) fail(`The table ${quoted(tag)} is there twice.`);
    const data = bytes.subarray(offset, offset + compLength);
    if (!READ_TABLES.has(tag)) {
      // Only bounds-checked: `facts` never reads it.
      tables.set(tag, undefined);
      continue;
    }
    if (compLength === origLength) {
      tables.set(tag, data);
      continue;
    }
    const inflated = inflateSync(data, { maxOutputLength: origLength || 1 });
    if (inflated.byteLength !== origLength) {
      fail(`The table ${quoted(tag)} inflates to another length.`);
    }
    tables.set(tag, new Uint8Array(inflated));
  }
  requireTables(tables, flavor);
  return tables;
}

/** The tables `facts` reads; WOFF's other tables are only bounds-checked. */
const READ_TABLES = new Set(['head', 'name', 'OS/2']);

/** WOFF2's known tags, by their index in a table directory entry's flags. */
export const WOFF2_TAGS: readonly string[] = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf',
  'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT',
  'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT',
  'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar',
  'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd',
  'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
]; // prettier-ignore

function woff2Tables(bytes: Uint8Array, maxDecoded: number): Tables {
  if (bytes.byteLength < 48) fail('The WOFF2 file is shorter than its header.');
  const flavor = u32(bytes, 4);
  if (flavor === 0x74746366) fail('A font collection is not taken.'); // 'ttcf'
  if (u32(bytes, 8) !== bytes.byteLength) {
    fail('The WOFF2 header gives another length than the file has.');
  }
  const numTables = u16(bytes, 12);
  if (numTables < 1 || numTables > MAX_TABLES) {
    fail(`The font names ${numTables} tables.`);
  }
  const totalCompressed = u32(bytes, 20);
  const reader = { at: 48 };
  const entries: { tag: string; length: number; transformed: boolean }[] = [];
  let total = 0;
  for (let i = 0; i < numTables; i++) {
    const flags = byteAt(bytes, reader);
    const index = flags & 0x3f;
    const version = flags >> 6;
    let tag: string;
    if (index === 63) {
      if (reader.at + 4 > bytes.byteLength)
        fail('The table directory runs past the file.');
      tag = tagAt(bytes, reader.at);
      reader.at += 4;
    } else {
      tag =
        WOFF2_TAGS[index] ?? fail('The table directory names an unknown tag.');
    }
    const origLength = base128(bytes, reader);
    const glyfOrLoca = tag === 'glyf' || tag === 'loca';
    const transformed = glyfOrLoca ? version !== 3 : version !== 0;
    if (transformed && !glyfOrLoca && !(tag === 'hmtx' && version === 1)) {
      fail(`The table ${quoted(tag)} has an unknown transform.`);
    }
    if (glyfOrLoca && version !== 0 && version !== 3) {
      fail(`The table ${quoted(tag)} has an unknown transform.`);
    }
    const length = transformed ? base128(bytes, reader) : origLength;
    if (tag === 'loca' && transformed && length !== 0) {
      fail('A transformed loca table must be empty.');
    }
    if (entries.some((e) => e.tag === tag)) {
      fail(`The table ${quoted(tag)} is there twice.`);
    }
    entries.push({ tag, length, transformed });
    total += length;
    if (total > maxDecoded) fail('The font decodes to too many bytes.');
  }
  const glyf = entries.find((e) => e.tag === 'glyf');
  const loca = entries.find((e) => e.tag === 'loca');
  if (
    (glyf === undefined) !== (loca === undefined) ||
    (glyf && loca && glyf.transformed !== loca.transformed)
  ) {
    fail('The glyf and loca tables do not go together.');
  }
  if (reader.at + totalCompressed > bytes.byteLength) {
    fail('The compressed data runs past the file.');
  }
  const stream = brotliDecompressSync(
    bytes.subarray(reader.at, reader.at + totalCompressed),
    { maxOutputLength: Math.max(total, 1) },
  );
  if (stream.byteLength !== total) {
    fail('The compressed data decodes to another length than its tables.');
  }
  const tables: Tables = new Map();
  let at = 0;
  for (const { tag, length, transformed } of entries) {
    tables.set(
      tag,
      // Only the tables the facts read are copied; the others are only there.
      transformed || !READ_TABLES.has(tag)
        ? undefined
        : new Uint8Array(stream.subarray(at, at + length)),
    );
    at += length;
  }
  // A transformed glyf/loca/hmtx is only known to be there; the rest is read as an sfnt's.
  requireTables(tables, flavor);
  return tables;
}

function requireTables(tables: Tables, flavor: number): void {
  if (
    flavor !== SFNT_TRUETYPE &&
    flavor !== SFNT_TRUE &&
    flavor !== SFNT_OTTO
  ) {
    fail('The font has an unknown flavour.');
  }
  for (const tag of ['head', 'name', 'cmap', 'maxp', 'hhea', 'hmtx']) {
    if (!tables.has(tag)) fail(`The font has no ${quoted(tag)} table.`);
  }
  const truetype = tables.has('glyf') && tables.has('loca');
  const cff = tables.has('CFF ') || tables.has('CFF2');
  if (!truetype && !cff) fail('The font has no outlines (glyf or CFF).');
  const head = tables.get('head');
  if (!head || head.byteLength < 54 || u32(head, 12) !== HEAD_MAGIC) {
    fail('The head table is broken.');
  }
}

function facts(tables: Tables): Omit<FontFacts, 'format'> {
  const head = tables.get('head') as Uint8Array;
  const name = tables.get('name') ?? fail('The name table cannot be read.');
  const names = nameStrings(name);
  const family = names.get(16) ?? names.get(1);
  if (family === undefined) fail('The font has no family name.');
  const macStyle = u16(head, 44);
  const os2 = tables.get('OS/2');
  const os2Weight = os2 && os2.byteLength >= 64 ? u16(os2, 4) : 0;
  const weight =
    os2Weight >= 1 && os2Weight <= 1000 ? os2Weight : macStyle & 1 ? 700 : 400;
  const italic =
    (os2 !== undefined && os2.byteLength >= 64 && (u16(os2, 62) & 1) === 1) ||
    (macStyle & 2) === 2;
  return {
    family: family as string,
    subfamily: names.get(17) ?? names.get(2) ?? 'Regular',
    weight,
    italic,
    copyright: names.get(0) ?? null,
    licence: names.get(13) ?? null,
    licenceUrl: names.get(14) ?? null,
  };
}

/** The most characters kept of a name: long ones for the copyright and licence. */
const NAME_CAP: Readonly<Record<number, number>> = {
  0: 1000,
  13: 2000,
  14: 500,
};
const DEFAULT_NAME_CAP = 200;
const WANTED = [0, 1, 2, 13, 14, 16, 17];

/** The name IDs `facts` reads, each from the best platform record that has it. */
function nameStrings(table: Uint8Array): Map<number, string> {
  if (table.byteLength < 6) fail('The name table is broken.');
  const count = u16(table, 2);
  const storage = u16(table, 4);
  if (6 + count * 12 > table.byteLength) fail('The name table is broken.');
  const best = new Map<number, { rank: number; text: string }>();
  // A name ID and rank is decoded once, even when it came out empty, and only so many
  // records at all: a table of thousands of records sharing one long string costs no more.
  const tried = new Set<string>();
  let decoded = 0;
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    const platform = u16(table, at);
    const encoding = u16(table, at + 2);
    const language = u16(table, at + 4);
    const id = u16(table, at + 6);
    if (!WANTED.includes(id)) continue;
    const length = u16(table, at + 8);
    const offset = storage + u16(table, at + 10);
    if (offset + length > table.byteLength) continue;
    const rank =
      platform === 3 && (encoding === 1 || encoding === 10)
        ? language === 0x0409
          ? 0
          : 1
        : platform === 3
          ? 2
          : platform === 0
            ? 3
            : platform === 1 && encoding === 0
              ? 4
              : -1;
    if (rank < 0) continue;
    const known = best.get(id);
    if (known && known.rank <= rank) continue;
    if (tried.has(`${id}:${rank}`)) continue;
    tried.add(`${id}:${rank}`);
    if (++decoded > MAX_NAMES_DECODED)
      fail('The name table has too many names.');
    const cap = NAME_CAP[id] ?? DEFAULT_NAME_CAP;
    // Never more than twice the characters kept (some are cleaned away): two bytes each.
    const raw = table.subarray(offset, offset + Math.min(length, cap * 4));
    const text = cleaned(
      platform === 1
        ? Buffer.from(raw).toString('latin1')
        : new TextDecoder('utf-16be').decode(raw),
      cap,
      id === 13,
    );
    if (text !== '') best.set(id, { rank, text });
  }
  return new Map([...best].map(([id, { text }]) => [id, text]));
}

/**
 * `text` without control and bidi-override characters (line breaks kept, as `\n`, only where
 * `lines`), runs of spaces as one, trimmed, at most `cap` characters.
 */
/** Control characters, bidi marks and overrides, a byte order mark, the replacement character. */
function invisible(code: number): boolean {
  return (
    (code <= 0x1f && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff ||
    (code >= 0xfffd && code <= 0xffff)
  );
}

function cleaned(text: string, cap: number, lines: boolean): string {
  const spaced = text
    .replace(/\r\n?/g, '\n')
    .replace(lines ? /[^\S\n]+/g : /\s+/g, ' ');
  let out = [...spaced]
    .filter((c) => !invisible(c.codePointAt(0) as number))
    .join('')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (out.length > cap) out = `${[...out].slice(0, cap - 1).join('')}…`;
  return out;
}

/** WOFF2's UIntBase128: at most 5 bytes, no leading zero byte, fits 32 bits. */
function base128(bytes: Uint8Array, reader: { at: number }): number {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = byteAt(bytes, reader);
    if (i === 0 && byte === 0x80)
      fail('A number in the directory is malformed.');
    if (value > 0x01ffffff) fail('A number in the directory overflows.');
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return value;
  }
  return fail('A number in the directory is malformed.');
}

function byteAt(bytes: Uint8Array, reader: { at: number }): number {
  if (reader.at >= bytes.byteLength)
    fail('The table directory runs past the file.');
  return bytes[reader.at++] as number;
}

const u16 = (b: Uint8Array, at: number): number =>
  ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u32 = (b: Uint8Array, at: number): number =>
  (((b[at] ?? 0) << 24) >>> 0) +
  (((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0));
const tagAt = (b: Uint8Array, at: number): string =>
  String.fromCharCode(
    b[at] ?? 0,
    b[at + 1] ?? 0,
    b[at + 2] ?? 0,
    b[at + 3] ?? 0,
  );
/** A tag for a message: printable ASCII only. */
const quoted = (tag: string): string =>
  `"${tag.replace(/[^\x20-\x7e]/g, '?')}"`;
