import { promisify } from 'node:util';
import { crc32, inflateRaw } from 'node:zlib';
import { UnprocessableError } from '../../base/core/errors.js';

const inflate = promisify(inflateRaw);

/** What a ZIP archive may hold before it is refused, all of it checked before a byte is inflated. */
export interface ZipLimits {
  /** The most entries (files and folders) in the archive. */
  readonly maxFiles: number;
  /** The most bytes all its files hold together, unpacked. */
  readonly maxUnpackedBytes: number;
  /** The most folders a path may lie in (`assets/<hash>` lies in one). */
  readonly maxPathDepth: number;
}

/** Why an archive is refused (`meta.reason` of 422 `invalid-archive`). */
export type ArchiveRefusal =
  | 'not-a-zip'
  | 'corrupt'
  | 'zip64'
  | 'multi-disk'
  | 'encrypted'
  | 'unsupported-compression'
  | 'too-many-files'
  | 'too-large'
  | 'too-compressed'
  | 'unsafe-path'
  | 'path-too-deep'
  | 'duplicate-path'
  | 'link';

/**
 * The most an archive may unpack to per byte it holds packed, all its files
 * together (a zip bomb's ratio is far above it: deflate reaches about
 * 1,000), once it unpacks to more than `COMPRESSION_RATIO_FLOOR`; text and
 * images compress far less.
 */
export const MAX_COMPRESSION_RATIO = 100;

/** Below this many bytes unpacked an archive's ratio is not checked. */
export const COMPRESSION_RATIO_FLOOR = 1024 * 1024;

/** The longest path an entry may have, in bytes. */
export const MAX_PATH_BYTES = 1024;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The end-of-central-directory record without its comment. */
const EOCD_SIZE = 22;
/** Its comment's longest length. */
const MAX_COMMENT = 0xffff;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const STORED = 0;
const DEFLATED = 8;
/** General purpose flags: encrypted (bit 0), strong encryption (bit 6), names in UTF-8 (bit 11). */
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
/** A Unix file type in the upper half of the external attributes, when made on Unix. */
const UNIX = 3;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

const refuse = (
  reason: ArchiveRefusal,
  detail: string,
  meta: Record<string, unknown> = {},
) => new UnprocessableError('invalid-archive', detail, { reason, ...meta });

interface Entry {
  readonly path: string;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

/**
 * Reads a ZIP archive into its files, by path, refusing anything hostile
 * or ambiguous before it is unpacked (422 `invalid-archive` with
 * `meta.reason`): the central directory is read and checked whole first,
 * then each file inflated with its declared size as the hard limit.
 *
 * - **Paths** (zip slip): only relative paths of plain segments, `/` as
 *   the separator; no `..` or `.` segment, no empty one, no backslash, no
 *   drive letter or colon, no control character, at most `MAX_PATH_BYTES`
 *   and `maxPathDepth` folders deep; the same path twice (also once as a
 *   folder and once as a file) is refused, as is an entry that is a
 *   symbolic link or another special file. Nothing is ever written to the
 *   file system: the paths are keys of the returned map.
 * - **Bombs**: at most `maxFiles` entries and `maxUnpackedBytes` all
 *   together, by the sizes the directory declares, summed before a byte
 *   is inflated, and at most `MAX_COMPRESSION_RATIO` times their packed
 *   size once past `COMPRESSION_RATIO_FLOOR` (`too-compressed`); inflating a file stops at its declared size (a file
 *   that holds more is refused, `corrupt`), and its CRC-32 must match.
 *   Entries whose data overlap are refused (one compressed stream unpacked
 *   many times over). An archive in an archive is a file like any other,
 *   never opened.
 * - Only stored and deflated files, no encryption, no ZIP64 (no archive
 *   within these limits needs it), no archive spanning disks.
 *
 * Folder entries (a path ending in `/`) are checked and left out.
 */
export async function readZip(
  bytes: Uint8Array,
  limits: ZipLimits,
): Promise<Map<string, Uint8Array>> {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { entries, directoryOffset } = centralDirectory(data, limits);
  checkOverlaps(entries, data, directoryOffset);
  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (entry.path.endsWith('/')) continue;
    files.set(entry.path, await unpack(data, entry));
  }
  return files;
}

/** Whether `bytes` start as a ZIP archive does (a local file header, or the end record of an empty one). */
export function looksLikeZip(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  const signature =
    (bytes[0] ?? 0) |
    ((bytes[1] ?? 0) << 8) |
    ((bytes[2] ?? 0) << 16) |
    ((bytes[3] ?? 0) << 24);
  return (
    signature >>> 0 === LOCAL_SIGNATURE || signature >>> 0 === EOCD_SIGNATURE
  );
}

function centralDirectory(
  data: Buffer,
  limits: ZipLimits,
): { entries: Entry[]; directoryOffset: number } {
  const end = findEnd(data);
  const disk = data.readUInt16LE(end + 4);
  const directoryDisk = data.readUInt16LE(end + 6);
  const onDisk = data.readUInt16LE(end + 8);
  const count = data.readUInt16LE(end + 10);
  const directorySize = data.readUInt32LE(end + 12);
  const directoryOffset = data.readUInt32LE(end + 16);
  if (
    count === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    throw refuse('zip64', 'ZIP64 archives are not read.');
  }
  if (disk !== 0 || directoryDisk !== 0 || onDisk !== count) {
    throw refuse('multi-disk', 'Archives spanning several disks are not read.');
  }
  if (count > limits.maxFiles) {
    throw refuse(
      'too-many-files',
      `The archive holds ${count} entries; at most ${limits.maxFiles} are read.`,
      { max: limits.maxFiles },
    );
  }
  if (directoryOffset + directorySize > end) {
    throw refuse('corrupt', 'The archive’s directory lies outside it.');
  }
  const entries: Entry[] = [];
  const paths = new Set<string>();
  let unpacked = 0;
  let packed = 0;
  let at = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_SIZE > directoryOffset + directorySize) {
      throw refuse('corrupt', 'The archive’s directory is cut off.');
    }
    if (data.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw refuse('corrupt', 'The archive’s directory is malformed.');
    }
    const madeBy = data.readUInt8(at + 5);
    const flags = data.readUInt16LE(at + 8);
    const method = data.readUInt16LE(at + 10);
    const crc = data.readUInt32LE(at + 16);
    const compressedSize = data.readUInt32LE(at + 20);
    const size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const diskStart = data.readUInt16LE(at + 34);
    const external = data.readUInt32LE(at + 38);
    const localOffset = data.readUInt32LE(at + 42);
    const nameStart = at + CENTRAL_SIZE;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > directoryOffset + directorySize) {
      throw refuse('corrupt', 'The archive’s directory is cut off.');
    }
    if (
      compressedSize === 0xffffffff ||
      size === 0xffffffff ||
      localOffset === 0xffffffff ||
      diskStart === 0xffff
    ) {
      throw refuse('zip64', 'ZIP64 archives are not read.');
    }
    if (diskStart !== 0) {
      throw refuse(
        'multi-disk',
        'Archives spanning several disks are not read.',
      );
    }
    const path = entryPath(data.subarray(nameStart, nameStart + nameLength));
    checkPath(path, limits);
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
      throw refuse('encrypted', `${path} is encrypted.`, { path });
    }
    if (method !== STORED && method !== DEFLATED) {
      throw refuse(
        'unsupported-compression',
        `${path} is compressed with a method other than deflate.`,
        { path },
      );
    }
    if (madeBy === UNIX) {
      const type = (external >>> 16) & S_IFMT;
      const folder = path.endsWith('/');
      if (type !== 0 && type !== (folder ? S_IFDIR : S_IFREG)) {
        throw refuse('link', `${path} is a link or another special file.`, {
          path,
        });
      }
    }
    // A path and a folder of the same name, or either twice: the archive
    // says two things about one place.
    const key = path.endsWith('/') ? path.slice(0, -1) : path;
    if (paths.has(key)) {
      throw refuse('duplicate-path', `${key} is in the archive twice.`, {
        path: key,
      });
    }
    paths.add(key);
    // Some tools deflate a folder's empty stream: a few bytes, nothing unpacked.
    if (path.endsWith('/') && (size !== 0 || compressedSize > 16)) {
      throw refuse('corrupt', `The folder ${path} holds data.`, { path });
    }
    unpacked += size;
    packed += compressedSize;
    if (unpacked > limits.maxUnpackedBytes) {
      throw refuse(
        'too-large',
        `The archive’s files hold more than ${limits.maxUnpackedBytes} bytes unpacked.`,
        { max: limits.maxUnpackedBytes },
      );
    }
    entries.push({ path, method, crc, compressedSize, size, localOffset });
    at = next;
  }
  if (
    unpacked > COMPRESSION_RATIO_FLOOR &&
    unpacked > packed * MAX_COMPRESSION_RATIO
  ) {
    throw refuse(
      'too-compressed',
      `The archive’s files unpack to more than ${MAX_COMPRESSION_RATIO} times their packed size.`,
      { max: MAX_COMPRESSION_RATIO },
    );
  }
  // A file is never also a folder another entry lies in.
  const files = new Set(
    entries.filter((e) => !e.path.endsWith('/')).map((e) => e.path),
  );
  for (const { path } of entries) {
    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth++) {
      const folder = segments.slice(0, depth).join('/');
      if (files.has(folder)) {
        throw refuse(
          'duplicate-path',
          `${folder} is in the archive as a file and as a folder.`,
          { path: folder },
        );
      }
    }
  }
  return { entries, directoryOffset };
}

function findEnd(data: Buffer): number {
  if (data.byteLength < EOCD_SIZE) {
    throw refuse('not-a-zip', 'The file is no ZIP archive.');
  }
  const earliest = Math.max(0, data.byteLength - EOCD_SIZE - MAX_COMMENT);
  for (let at = data.byteLength - EOCD_SIZE; at >= earliest; at--) {
    if (
      data.readUInt32LE(at) === EOCD_SIGNATURE &&
      at + EOCD_SIZE + data.readUInt16LE(at + 20) === data.byteLength
    ) {
      return at;
    }
  }
  throw refuse('not-a-zip', 'The file is no ZIP archive.');
}

const DECODER = new TextDecoder('utf-8', { fatal: true });

function entryPath(name: Buffer): string {
  try {
    return DECODER.decode(name);
  } catch {
    throw refuse('unsafe-path', 'An entry’s path is not UTF-8.');
  }
}

/** Anything but a plain relative path of ordinary names is refused, whatever the platform would make of it. */
function checkPath(path: string, limits: ZipLimits): void {
  const unsafe = (why: string) =>
    refuse('unsafe-path', `The entry path ${JSON.stringify(path)} ${why}.`, {
      path,
    });
  if (path.length === 0) throw unsafe('is empty');
  if (Buffer.byteLength(path) > MAX_PATH_BYTES) {
    throw unsafe(`is longer than ${MAX_PATH_BYTES} bytes`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw unsafe('holds a control character');
  }
  if (path.includes('\\')) throw unsafe('holds a backslash');
  if (path.includes(':')) throw unsafe('holds a colon (a drive or a stream)');
  if (path.startsWith('/')) throw unsafe('is absolute');
  const segments = (path.endsWith('/') ? path.slice(0, -1) : path).split('/');
  for (const segment of segments) {
    if (segment === '') throw unsafe('holds an empty segment');
    if (segment === '.' || segment === '..') {
      throw unsafe('leaves its folder');
    }
  }
  const folders = path.endsWith('/') ? segments.length : segments.length - 1;
  if (folders > limits.maxPathDepth) {
    throw refuse(
      'path-too-deep',
      `The entry ${JSON.stringify(path)} lies ${folders} folders deep; at most ${limits.maxPathDepth} are read.`,
      { path, max: limits.maxPathDepth },
    );
  }
}

/** Where an entry's data starts and ends, from its local header (which must agree with the directory). */
function dataRange(data: Buffer, entry: Entry): [number, number] {
  const at = entry.localOffset;
  if (at + LOCAL_SIZE > data.byteLength) {
    throw refuse(
      'corrupt',
      `${entry.path}: its header lies outside the archive.`,
    );
  }
  if (data.readUInt32LE(at) !== LOCAL_SIGNATURE) {
    throw refuse('corrupt', `${entry.path}: its header is malformed.`);
  }
  const flags = data.readUInt16LE(at + 6);
  const method = data.readUInt16LE(at + 8);
  const nameLength = data.readUInt16LE(at + 26);
  const extraLength = data.readUInt16LE(at + 28);
  const name = data.subarray(at + LOCAL_SIZE, at + LOCAL_SIZE + nameLength);
  if (
    method !== entry.method ||
    flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION) ||
    !name.equals(Buffer.from(entry.path))
  ) {
    throw refuse(
      'corrupt',
      `${entry.path}: its header does not match the archive’s directory.`,
      { path: entry.path },
    );
  }
  const start = at + LOCAL_SIZE + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > data.byteLength) {
    throw refuse(
      'corrupt',
      `${entry.path}: its data lies outside the archive.`,
    );
  }
  return [start, end];
}

/** Entries share no bytes: overlapping ones unpack one stream many times. */
function checkOverlaps(
  entries: readonly Entry[],
  data: Buffer,
  directoryOffset: number,
): void {
  const ranges = entries
    .map((entry) => {
      const [, end] = dataRange(data, entry);
      if (end > directoryOffset) {
        throw refuse(
          'corrupt',
          `${entry.path} overlaps the archive’s directory.`,
          { path: entry.path },
        );
      }
      return { path: entry.path, start: entry.localOffset, end };
    })
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    const previous = ranges[i - 1];
    const current = ranges[i];
    if (previous && current && current.start < previous.end) {
      throw refuse(
        'corrupt',
        `${current.path} overlaps ${previous.path} in the archive.`,
        { path: current.path },
      );
    }
  }
}

async function unpack(data: Buffer, entry: Entry): Promise<Uint8Array> {
  const [start, end] = dataRange(data, entry);
  const packed = data.subarray(start, end);
  let bytes: Buffer;
  if (entry.method === STORED) {
    if (entry.compressedSize !== entry.size) {
      throw refuse('corrupt', `${entry.path}: its sizes disagree.`, {
        path: entry.path,
      });
    }
    bytes = Buffer.from(packed);
  } else {
    try {
      // The declared size is the limit: a stream holding more stops there.
      bytes = await inflate(packed, {
        maxOutputLength: Math.max(1, entry.size),
      });
    } catch {
      throw refuse(
        'corrupt',
        `${entry.path} cannot be unpacked, or holds more than its declared size.`,
        { path: entry.path },
      );
    }
  }
  if (bytes.byteLength !== entry.size || crc32(bytes) !== entry.crc) {
    throw refuse(
      'corrupt',
      `${entry.path} does not match its declared size and checksum.`,
      { path: entry.path },
    );
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
