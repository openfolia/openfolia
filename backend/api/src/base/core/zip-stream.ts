import { Zip, ZipPassThrough } from 'fflate';

/** One file of a streamed ZIP: its name in the archive, its length and its bytes, opened when its turn comes. */
export interface ZipStreamEntry {
  /** The entry's path in the archive (`/` between folders); ASCII, so its length is its byte length. */
  readonly name: string;
  /** The bytes `open` yields, exactly: the archive's length is worked out from it. */
  readonly size: number;
  readonly open: () => Promise<AsyncIterable<Uint8Array>>;
}

/**
 * The largest ZIP `zipStream` writes: without ZIP64 (which fflate does not
 * write) every size and offset is 32 bits.
 */
export const MAX_ZIP_BYTES = 0xffff_ffff;

/** The most entries a ZIP without ZIP64 holds. */
export const MAX_ZIP_ENTRIES = 0xffff;

// A stored entry: its local header (30 bytes and the name), the bytes, the
// data descriptor (16: the CRC is known only once the bytes went by), and
// its central directory record (46 and the name); then the end record (22).
const LOCAL_HEADER = 30;
const DATA_DESCRIPTOR = 16;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;

/**
 * The exact length of the ZIP `zipStream` writes for `entries`, known
 * before any byte is read (so the answer carries `Content-Length`).
 */
export function zipSize(
  entries: readonly Pick<ZipStreamEntry, 'name' | 'size'>[],
): number {
  let total = END_RECORD;
  for (const { name, size } of entries) {
    const length = Buffer.byteLength(name, 'utf8');
    total +=
      LOCAL_HEADER + length + size + DATA_DESCRIPTOR + CENTRAL_HEADER + length;
  }
  return total;
}

/**
 * A ZIP of `entries`, stored (no compression: the files are PDFs, already
 * compressed), written while it is read: one entry open at a time, and a
 * chunk of it read only once the reader took the one before, so memory
 * stays at a few chunks (what the reader buffers) whatever the archive's
 * size. Every entry's time is `mtime` (in UTC), so the same entries make
 * the same bytes on any server. An entry whose
 * bytes are not exactly its `size` long fails the stream (the length
 * already promised would be wrong), as does an `open` that throws.
 */
export async function* zipStream(
  entries: readonly ZipStreamEntry[],
  mtime: Date,
): AsyncGenerator<Uint8Array> {
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new RangeError(`A ZIP holds at most ${MAX_ZIP_ENTRIES} entries.`);
  }
  if (zipSize(entries) > MAX_ZIP_BYTES) {
    throw new RangeError('The ZIP would be larger than 4 GiB.');
  }
  // fflate calls back synchronously for stored entries: what one push
  // gives is collected here and handed on before the next chunk is read.
  let out: Uint8Array[] = [];
  let failure: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) failure = error;
    else out.push(chunk);
  });
  const drain = function* () {
    if (failure) throw failure;
    const chunks = out;
    out = [];
    yield* chunks;
  };
  // A ZIP's time has no zone and fflate writes the local one: shifted so
  // the entries say `mtime` in UTC on any server.
  const utc = new Date(mtime.getTime() + mtime.getTimezoneOffset() * 60_000);
  for (const entry of entries) {
    const file = new ZipPassThrough(entry.name);
    file.mtime = utc;
    zip.add(file);
    let length = 0;
    for await (const chunk of await entry.open()) {
      length += chunk.length;
      if (length > entry.size) {
        throw new Error(`"${entry.name}" is longer than ${entry.size} bytes.`);
      }
      file.push(chunk);
      yield* drain();
    }
    if (length !== entry.size) {
      throw new Error(`"${entry.name}" is ${length} bytes, not ${entry.size}.`);
    }
    file.push(new Uint8Array(0), true);
    yield* drain();
  }
  zip.end();
  yield* drain();
}

/** A ZIP `zipStreamOf` writes would pass its bounds: more bytes or entries than it may hold. */
export class ZipLimitError extends RangeError {
  constructor(
    readonly limit: 'bytes' | 'entries',
    readonly max: number,
  ) {
    super(
      limit === 'bytes'
        ? `The ZIP would be larger than ${max} bytes.`
        : `The ZIP would hold more than ${max} entries.`,
    );
  }
}

/** One file of a ZIP whose entries are made while it is written: its name and its bytes, opened when its turn comes. */
export interface LazyZipEntry {
  /** The entry's path in the archive (`/` between folders), ASCII. */
  readonly name: string;
  readonly open: () => Promise<AsyncIterable<Uint8Array>>;
}

/**
 * A ZIP of `entries`, stored (no compression), made while it is read, for a
 * ZIP whose entries are not known beforehand (#59: an offline package's pages
 * are rendered as their turn comes): one entry open at a time and one chunk of
 * it held, as `zipStream`, but no length promised up front. Bounded as it goes:
 * past `maxBytes` written or `maxEntries` entries it throws `ZipLimitError`
 * (never more than a ZIP without ZIP64 holds), so a reader stops at the limit
 * instead of holding or storing more. Every entry's time is `mtime` (UTC).
 */
export async function* zipStreamOf(
  entries: AsyncIterable<LazyZipEntry>,
  mtime: Date,
  bounds: { readonly maxBytes: number; readonly maxEntries: number },
): AsyncGenerator<Uint8Array> {
  const maxBytes = Math.min(bounds.maxBytes, MAX_ZIP_BYTES);
  const maxEntries = Math.min(bounds.maxEntries, MAX_ZIP_ENTRIES);
  let out: Uint8Array[] = [];
  let failure: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) failure = error;
    else out.push(chunk);
  });
  let written = 0;
  // The central directory still to come: its records and the end record.
  let directory = END_RECORD;
  const drain = function* () {
    if (failure) throw failure;
    const chunks = out;
    out = [];
    for (const chunk of chunks) {
      written += chunk.length;
      if (written + directory > maxBytes) {
        throw new ZipLimitError('bytes', maxBytes);
      }
      yield chunk;
    }
  };
  const utc = new Date(mtime.getTime() + mtime.getTimezoneOffset() * 60_000);
  let count = 0;
  for await (const entry of entries) {
    if (++count > maxEntries) throw new ZipLimitError('entries', maxEntries);
    directory += CENTRAL_HEADER + Buffer.byteLength(entry.name, 'utf8');
    const file = new ZipPassThrough(entry.name);
    file.mtime = utc;
    zip.add(file);
    for await (const chunk of await entry.open()) {
      file.push(chunk);
      yield* drain();
    }
    file.push(new Uint8Array(0), true);
    yield* drain();
  }
  zip.end();
  // The directory is counted already: what it adds now is written, not new.
  directory = 0;
  yield* drain();
}
