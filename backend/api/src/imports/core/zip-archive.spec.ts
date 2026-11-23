import { crc32, deflateRawSync } from 'node:zlib';
import { strToU8, zipSync } from 'fflate';
import { UnprocessableError } from '../../base/core/errors.js';
import { looksLikeZip, readZip, type ZipLimits } from './zip-archive.js';

const LIMITS: ZipLimits = {
  maxFiles: 10,
  maxUnpackedBytes: 1024 * 1024,
  maxPathDepth: 3,
};

interface RawEntry {
  readonly name: string;
  readonly data?: Uint8Array;
  readonly deflate?: boolean;
  /** Overrides what the directory and the local header declare. */
  readonly size?: number;
  readonly flags?: number;
  readonly method?: number;
  readonly madeBy?: number;
  readonly external?: number;
  /** Points the directory at another entry's local header. */
  readonly localOffsetOf?: number;
}

/** A ZIP archive, written byte by byte so it can say what a tool would not. */
function rawZip(entries: RawEntry[], eocd: { count?: number } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? new Uint8Array());
    const packed = entry.deflate ? deflateRawSync(data) : data;
    const name = Buffer.from(entry.name);
    const method = entry.method ?? (entry.deflate ? 8 : 0);
    const size = entry.size ?? data.byteLength;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.byteLength, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.byteLength, 26);
    offsets.push(offset);
    const record = Buffer.concat([local, name, packed]);
    locals.push(record);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt8(20, 4);
    central.writeUInt8(entry.madeBy ?? 0, 5);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.byteLength, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(entry.external ?? 0, 38);
    central.writeUInt32LE(
      entry.localOffsetOf === undefined
        ? offset
        : (offsets[entry.localOffsetOf] ?? 0),
      42,
    );
    centrals.push(Buffer.concat([central, name]));
    offset += record.byteLength;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(eocd.count ?? entries.length, 8);
  end.writeUInt16LE(eocd.count ?? entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function reasonOf(bytes: Uint8Array, limits = LIMITS) {
  try {
    await readZip(bytes, limits);
  } catch (error) {
    expect(error).toBeInstanceOf(UnprocessableError);
    const refused = error as UnprocessableError;
    expect(refused.code).toBe('invalid-archive');
    return (refused.meta as { reason: string }).reason;
  }
  throw new Error('read the archive');
}

const text = (value: string) => strToU8(value);

describe('readZip', () => {
  it('reads stored and deflated files by path, leaving folders out', async () => {
    const files = await readZip(
      zipSync({
        'import.json': text('{}'),
        assets: { a: text('x'.repeat(1000)) },
      }),
      LIMITS,
    );
    expect([...files.keys()].sort()).toEqual(['assets/a', 'import.json']);
    expect(Buffer.from(files.get('assets/a') ?? []).toString()).toBe(
      'x'.repeat(1000),
    );
    const raw = await readZip(
      rawZip([
        { name: 'dir/' },
        { name: 'dir/a', data: text('stored') },
        { name: 'dir/b', data: text('deflated'), deflate: true },
      ]),
      LIMITS,
    );
    expect([...raw.keys()]).toEqual(['dir/a', 'dir/b']);
  });

  it.each([
    ['../escape', 'unsafe-path'],
    ['a/../../escape', 'unsafe-path'],
    ['./a', 'unsafe-path'],
    ['/etc/passwd', 'unsafe-path'],
    ['a\\..\\b', 'unsafe-path'],
    ['C:/windows', 'unsafe-path'],
    ['a//b', 'unsafe-path'],
    ['a\u0000b', 'unsafe-path'],
    ['a/b/c/d/e', 'path-too-deep'],
  ])('refuses the path %j: %s', async (name, reason) => {
    expect(await reasonOf(rawZip([{ name, data: text('x') }]))).toBe(reason);
  });

  it('refuses a path that is not UTF-8, or too long', async () => {
    const latin = rawZip([{ name: 'a', data: text('x') }]);
    // The name's byte in the directory and the local header: 0xff.
    latin[30] = 0xff;
    latin[latin.byteLength - 22 - 1] = 0xff;
    expect(await reasonOf(latin)).toBe('unsafe-path');
    expect(
      await reasonOf(rawZip([{ name: 'a'.repeat(1025), data: text('x') }])),
    ).toBe('unsafe-path');
  });

  it('refuses the same path twice, and a path both a file and a folder', async () => {
    expect(
      await reasonOf(
        rawZip([
          { name: 'a', data: text('1') },
          { name: 'a', data: text('2') },
        ]),
      ),
    ).toBe('duplicate-path');
    expect(
      await reasonOf(
        rawZip([
          { name: 'a', data: text('1') },
          { name: 'a/b', data: text('2') },
        ]),
      ),
    ).toBe('duplicate-path');
    expect(
      await reasonOf(rawZip([{ name: 'a/' }, { name: 'a', data: text('2') }])),
    ).toBe('duplicate-path');
  });

  it('refuses a symbolic link and other special files made on Unix', async () => {
    const link = (0o120777 << 16) >>> 0;
    expect(
      await reasonOf(
        rawZip([{ name: 'a', data: text('/etc'), madeBy: 3, external: link }]),
      ),
    ).toBe('link');
    const regular = (0o100644 << 16) >>> 0;
    await expect(
      readZip(
        rawZip([{ name: 'a', data: text('x'), madeBy: 3, external: regular }]),
        LIMITS,
      ),
    ).resolves.toHaveProperty('size', 1);
  });

  it('refuses more entries than the limit, before reading them', async () => {
    const many = rawZip(
      Array.from({ length: 11 }, (_, i) => ({
        name: `f${i}`,
        data: text('x'),
      })),
    );
    expect(await reasonOf(many)).toBe('too-many-files');
  });

  it('refuses more declared bytes than the limit, before inflating any', async () => {
    const bomb = rawZip([
      { name: 'a', data: new Uint8Array(600_000), deflate: true },
      { name: 'b', data: new Uint8Array(600_000), deflate: true },
    ]);
    expect(await reasonOf(bomb)).toBe('too-large');
  });

  it('refuses an archive that unpacks to more than 100 times its packed size, past 1 MiB', async () => {
    // 2 MiB of zeros deflate to about 2 KiB: a ratio near 1,000.
    const zeros = rawZip([
      { name: 'a', data: new Uint8Array(2 * 1024 * 1024), deflate: true },
    ]);
    expect(
      await reasonOf(zeros, { ...LIMITS, maxUnpackedBytes: 4 * 1024 * 1024 }),
    ).toBe('too-compressed');
    // As much unpacked, stored: a ratio of 1.
    const stored = rawZip([
      { name: 'a', data: new Uint8Array(2 * 1024 * 1024) },
    ]);
    const files = await readZip(stored, {
      ...LIMITS,
      maxUnpackedBytes: 4 * 1024 * 1024,
    });
    expect(files.get('a')?.byteLength).toBe(2 * 1024 * 1024);
    // Below the floor, any ratio.
    const small = rawZip([
      { name: 'a', data: new Uint8Array(512 * 1024), deflate: true },
    ]);
    expect((await readZip(small, LIMITS)).get('a')?.byteLength).toBe(
      512 * 1024,
    );
  });

  it('stops inflating at the declared size: a file holding more is refused', async () => {
    // 10 MB of zeros declared as 100 bytes.
    const bomb = rawZip([
      {
        name: 'a',
        data: new Uint8Array(10 * 1024 * 1024),
        deflate: true,
        size: 100,
      },
    ]);
    expect(await reasonOf(bomb, { ...LIMITS, maxUnpackedBytes: 1000 })).toBe(
      'corrupt',
    );
  });

  it('refuses entries that share their data (one stream unpacked many times)', async () => {
    const overlap = rawZip([
      { name: 'a', data: text('x'.repeat(100)), deflate: true },
      { name: 'a', data: text('x'.repeat(100)), deflate: true },
    ]);
    // Point the second entry's directory record at the first local header,
    // under another name: caught as a header mismatch or an overlap.
    const shared = rawZip([
      { name: 'a', data: text('x'.repeat(100)), deflate: true },
      {
        name: 'b',
        data: text('x'.repeat(100)),
        deflate: true,
        localOffsetOf: 0,
      },
    ]);
    expect(await reasonOf(overlap)).toBe('duplicate-path');
    expect(await reasonOf(shared)).toBe('corrupt');
  });

  it('refuses a checksum or a stored size that does not match', async () => {
    const bad = rawZip([{ name: 'a', data: text('hello') }]);
    // The data's first byte, after the 30-byte header and the name.
    bad[31] = (bad[31] ?? 0) ^ 0xff;
    expect(await reasonOf(bad)).toBe('corrupt');
    expect(
      await reasonOf(rawZip([{ name: 'a', data: text('hello'), size: 4 }])),
    ).toBe('corrupt');
  });

  it('refuses encryption, other methods, ZIP64 and what is no ZIP', async () => {
    expect(
      await reasonOf(rawZip([{ name: 'a', data: text('x'), flags: 1 }])),
    ).toBe('encrypted');
    expect(
      await reasonOf(rawZip([{ name: 'a', data: text('x'), method: 12 }])),
    ).toBe('unsupported-compression');
    expect(
      await reasonOf(
        rawZip([{ name: 'a', data: text('x') }], { count: 0xffff }),
      ),
    ).toBe('zip64');
    expect(await reasonOf(text('<?xml version="1.0"?><a/>'))).toBe('not-a-zip');
    expect(await reasonOf(new Uint8Array())).toBe('not-a-zip');
    const cut = rawZip([{ name: 'a', data: text('x') }]);
    expect(await reasonOf(cut.subarray(10))).toBe('corrupt');
  });

  it('refuses a directory that points outside the archive', async () => {
    const zip = rawZip([{ name: 'a', data: text('x') }]);
    zip.writeUInt32LE(0x7fffffff, zip.byteLength - 22 + 16);
    expect(await reasonOf(zip)).toBe('corrupt');
  });
});

describe('looksLikeZip', () => {
  it('knows a ZIP by its first bytes', () => {
    expect(looksLikeZip(zipSync({ a: text('x') }))).toBe(true);
    expect(looksLikeZip(zipSync({}))).toBe(true);
    expect(looksLikeZip(text('PK'))).toBe(false);
    expect(looksLikeZip(text('{"formatVersion":1}'))).toBe(false);
  });
});
