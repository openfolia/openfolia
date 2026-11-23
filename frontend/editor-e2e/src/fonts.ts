/**
 * Font files for tests (#555), made from the theme's fonts (Geist, SIL Open Font License 1.1,
 * `frontend/theme/src/fonts/LICENSE.txt`; it reserves no font name, so a renamed copy may be
 * made). A copy of `backend/api/tests/fonts.ts` for the browser flows, which import no other project.
 */
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const THEME_FONTS = new URL('../../theme/src/fonts/', import.meta.url);

/** A theme font's bytes: `ttf/Geist-Regular.ttf`, `Geist-Variable.woff2`, … */
export function themeFont(path: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(path, THEME_FONTS)));
}

interface Table {
  readonly tag: string;
  readonly data: Uint8Array;
}

/** The tables of an sfnt (TrueType/OpenType), in directory order, and its flavour. */
export function sfntTables(sfnt: Uint8Array): {
  flavor: number;
  tables: Table[];
} {
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const count = view.getUint16(4);
  const tables: Table[] = [];
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(...sfnt.subarray(at, at + 4));
    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    tables.push({ tag, data: sfnt.subarray(offset, offset + length) });
  }
  return { flavor: view.getUint32(0), tables };
}

/** The sfnt checksum of `data` (big-endian 32-bit words, zero-padded). */
export function tableChecksum(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.byteLength; i += 4) {
    const word =
      ((data[i] ?? 0) << 24) | ((data[i + 1] ?? 0) << 16) | ((data[i + 2] ?? 0) << 8) | (data[i + 3] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  } // prettier-ignore
  return sum;
}

const pad4 = (n: number) => (n + 3) & ~3;

/** An sfnt of `tables` (sorted by tag, 4-byte aligned, checksums and `head.checkSumAdjustment` set). */
export function buildSfnt(
  flavor: number,
  tables: readonly Table[],
): Uint8Array {
  const sorted = [...tables].sort((a, b) =>
    a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0,
  );
  const n = sorted.length;
  const dirLength = 12 + 16 * n;
  const total = sorted.reduce(
    (sum, t) => sum + pad4(t.data.byteLength),
    dirLength,
  );
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let power = 1;
  let log = 0;
  while (power * 2 <= n) {
    power *= 2;
    log++;
  }
  view.setUint32(0, flavor);
  view.setUint16(4, n);
  view.setUint16(6, power * 16);
  view.setUint16(8, log);
  view.setUint16(10, n * 16 - power * 16);
  let offset = dirLength;
  let headAt = -1;
  for (const [i, { tag, data }] of sorted.entries()) {
    const copy = new Uint8Array(data);
    if (tag === 'head' && copy.byteLength >= 12) {
      new DataView(copy.buffer).setUint32(8, 0);
      headAt = offset;
    }
    out.set(copy, offset);
    const at = 12 + i * 16;
    for (let c = 0; c < 4; c++) out[at + c] = tag.charCodeAt(c);
    view.setUint32(at + 4, tableChecksum(copy));
    view.setUint32(at + 8, offset);
    view.setUint32(at + 12, copy.byteLength);
    offset += pad4(copy.byteLength);
  }
  if (headAt >= 0)
    view.setUint32(headAt + 8, (0xb1b0afba - tableChecksum(out)) >>> 0);
  return out;
}

/** `sfnt` as a WOFF 1.0 file, each table zlib-compressed where that makes it smaller. */
export function woffFromSfnt(sfnt: Uint8Array): Uint8Array {
  const { flavor, tables } = sfntTables(sfnt);
  const sorted = [...tables].sort((a, b) =>
    a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0,
  );
  const packed = sorted.map(({ tag, data }) => {
    const deflated = new Uint8Array(deflateSync(data));
    return {
      tag,
      data,
      stored: deflated.byteLength < data.byteLength ? deflated : data,
    };
  });
  const dirLength = 44 + 20 * packed.length;
  const total = packed.reduce(
    (sum, t) => sum + pad4(t.stored.byteLength),
    dirLength,
  );
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x774f4646);
  view.setUint32(4, flavor);
  view.setUint32(8, total);
  view.setUint16(12, packed.length);
  view.setUint32(
    16,
    12 +
      16 * packed.length +
      packed.reduce((s, t) => s + pad4(t.data.byteLength), 0),
  );
  view.setUint16(20, 1);
  let offset = dirLength;
  for (const [i, { tag, data, stored }] of packed.entries()) {
    const at = 44 + i * 20;
    for (let c = 0; c < 4; c++) out[at + c] = tag.charCodeAt(c);
    view.setUint32(at + 4, offset);
    view.setUint32(at + 8, stored.byteLength);
    view.setUint32(at + 12, data.byteLength);
    view.setUint32(at + 16, tableChecksum(data));
    out.set(stored, offset);
    offset += pad4(stored.byteLength);
  }
  return out;
}

/** What a renamed font says of itself besides its family. */
export interface RenameOptions {
  readonly subfamily?: string;
  readonly copyright?: string;
  readonly licence?: string;
  readonly licenceUrl?: string;
}

/**
 * `sfnt` (a TrueType or OpenType font) with a new `name` table: `family` as its family and
 * typographic family (name IDs 1 and 16), its full and PostScript names (4, 6) and unique ID
 * (3) made from it, so a test can use a font whose family nothing else has. The subfamily is
 * `Regular` unless given; copyright and licence (0, 13, 14) only where given.
 */
export function renamedFont(
  sfnt: Uint8Array,
  family: string,
  { subfamily = 'Regular', copyright, licence, licenceUrl }: RenameOptions = {},
): Uint8Array {
  const { flavor, tables } = sfntTables(sfnt);
  const postscript = `${family.replace(/[^A-Za-z0-9]/g, '')}-${subfamily.replace(/[^A-Za-z0-9]/g, '')}`;
  const names: [number, string][] = [
    ...(copyright !== undefined
      ? ([[0, copyright]] as [number, string][])
      : []),
    [1, family],
    [2, subfamily],
    [3, postscript],
    [4, subfamily === 'Regular' ? family : `${family} ${subfamily}`],
    [6, postscript],
    ...(licence !== undefined ? ([[13, licence]] as [number, string][]) : []),
    ...(licenceUrl !== undefined
      ? ([[14, licenceUrl]] as [number, string][])
      : []),
    [16, family],
    [17, subfamily],
  ];
  return buildSfnt(flavor, [
    ...tables.filter((t) => t.tag !== 'name'),
    { tag: 'name', data: nameTable(names) },
  ]);
}

/** A format 0 `name` table of Windows Unicode (3, 1, en-US) records. */
export function nameTable(
  names: readonly (readonly [number, string])[],
): Uint8Array {
  const strings = names.map(([, text]) => {
    const bytes = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      bytes[i * 2] = text.charCodeAt(i) >> 8;
      bytes[i * 2 + 1] = text.charCodeAt(i) & 0xff;
    }
    return bytes;
  });
  const storage = 6 + 12 * names.length;
  const out = new Uint8Array(
    storage + strings.reduce((s, b) => s + b.byteLength, 0),
  );
  const view = new DataView(out.buffer);
  view.setUint16(2, names.length);
  view.setUint16(4, storage);
  let offset = 0;
  for (const [i, [id]] of names.entries()) {
    const at = 6 + i * 12;
    const bytes = strings[i] as Uint8Array;
    view.setUint16(at, 3);
    view.setUint16(at + 2, 1);
    view.setUint16(at + 4, 0x0409);
    view.setUint16(at + 6, id);
    view.setUint16(at + 8, bytes.byteLength);
    view.setUint16(at + 10, offset);
    out.set(bytes, storage + offset);
    offset += bytes.byteLength;
  }
  return out;
}
