import { unzipSync } from 'fflate';
import {
  type LazyZipEntry,
  ZipLimitError,
  zipSize,
  zipStream,
  zipStreamOf,
  type ZipStreamEntry,
} from './zip-stream.js';

const MTIME = new Date('2026-03-01T10:00:00Z');

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const bytes = (length: number, seed: number) =>
  Uint8Array.from({ length }, (_, i) => (i * 31 + seed) % 256);

/** An entry whose bytes come in `chunks` pieces of `chunkSize`, counting each piece read in `pulled`. */
function counted(
  name: string,
  chunks: number,
  chunkSize: number,
  pulled: { count: number },
): ZipStreamEntry {
  return {
    name,
    size: chunks * chunkSize,
    open: async () =>
      (async function* () {
        for (let i = 0; i < chunks; i++) {
          pulled.count++;
          yield bytes(chunkSize, i);
        }
      })(),
  };
}

const data = new Map<string, Uint8Array>();
const entry = (name: string, content: Uint8Array): ZipStreamEntry => {
  data.set(name, content);
  return {
    name,
    size: content.length,
    open: async () =>
      (async function* () {
        yield content;
      })(),
  };
};

describe('zipStream', () => {
  it('writes a ZIP of the entries, stored, of exactly the length zipSize says', async () => {
    const entries = [
      entry('operating/en/model-small.pdf', bytes(5_000, 1)),
      entry('operating/de/model-small.pdf', bytes(70_000, 2)),
      entry('service/en/model-large.pdf', new Uint8Array(0)),
    ];
    const zip = await collect(zipStream(entries, MTIME));
    expect(zip.length).toBe(zipSize(entries));
    const files = unzipSync(zip);
    expect(Object.keys(files)).toEqual(entries.map((e) => e.name));
    for (const e of entries) {
      expect(
        Buffer.from(files[e.name] as Uint8Array).equals(
          Buffer.from(data.get(e.name) as Uint8Array),
        ),
      ).toBe(true);
    }
    // The same entries, the same bytes: the time is the one given.
    expect((await collect(zipStream(entries, MTIME))).equals(zip)).toBe(true);
  });

  it('reads a chunk only once the one before was taken, so memory stays bounded', async () => {
    const pulled = { count: 0 };
    // 3 files of 64 chunks of 64 KiB: 12 MiB in all.
    const entries = ['a.pdf', 'b.pdf', 'c.pdf'].map((name) =>
      counted(name, 64, 64 * 1024, pulled),
    );
    let taken = 0;
    let largest = 0;
    let length = 0;
    for await (const chunk of zipStream(entries, MTIME)) {
      // Never more than one chunk of the source ahead of what was taken.
      expect(pulled.count * 64 * 1024 - taken).toBeLessThanOrEqual(64 * 1024);
      taken += chunk.length;
      length += chunk.length;
      largest = Math.max(largest, chunk.length);
    }
    expect(pulled.count).toBe(3 * 64);
    expect(largest).toBeLessThanOrEqual(64 * 1024);
    expect(length).toBe(zipSize(entries));
  });

  it('fails when an entry is not as long as it said, or cannot be opened', async () => {
    const short = { ...entry('a.pdf', bytes(10, 0)), size: 11 };
    await expect(collect(zipStream([short], MTIME))).rejects.toThrow(
      /10 bytes, not 11/,
    );
    const long = { ...entry('a.pdf', bytes(10, 0)), size: 9 };
    await expect(collect(zipStream([long], MTIME))).rejects.toThrow(
      /longer than 9/,
    );
    const gone: ZipStreamEntry = {
      name: 'a.pdf',
      size: 1,
      open: () => Promise.reject(new Error('gone')),
    };
    await expect(collect(zipStream([gone], MTIME))).rejects.toThrow('gone');
  });

  it('refuses an archive past 4 GiB before reading anything', async () => {
    const pulled = { count: 0 };
    const huge = { ...counted('a.pdf', 1, 1, pulled), size: 2 ** 32 };
    await expect(collect(zipStream([huge], MTIME))).rejects.toThrow(RangeError);
    expect(pulled.count).toBe(0);
  });
});

describe('zipStreamOf (#59)', () => {
  async function* lazy(
    list: readonly { name: string; chunks: Uint8Array[] }[],
    opened: string[],
  ): AsyncGenerator<LazyZipEntry> {
    for (const item of list) {
      yield {
        name: item.name,
        open: async () => {
          opened.push(item.name);
          return (async function* () {
            yield* item.chunks;
          })();
        },
      };
    }
  }
  const files = [
    { name: 'index.html', chunks: [bytes(10, 1)] },
    { name: 'media/a.png', chunks: [bytes(4096, 2), bytes(100, 3)] },
    { name: 'pdf/m/en/v.pdf', chunks: [] },
  ];

  it('zips entries it learns of as it goes, each opened in its turn, with the bytes given', async () => {
    const opened: string[] = [];
    const zip = await collect(
      zipStreamOf(lazy(files, opened), MTIME, {
        maxBytes: 1_000_000,
        maxEntries: 10,
      }),
    );
    expect(opened).toEqual(files.map((f) => f.name));
    const read = unzipSync(new Uint8Array(zip));
    expect(Object.keys(read)).toEqual(files.map((f) => f.name));
    for (const f of files) {
      expect(Buffer.from(read[f.name] as Uint8Array)).toEqual(
        Buffer.concat(f.chunks),
      );
    }
  });

  it('stops past its size, the directory still to come counted, having written no more', async () => {
    const opened: string[] = [];
    const out: Uint8Array[] = [];
    const run = async () => {
      for await (const chunk of zipStreamOf(lazy(files, opened), MTIME, {
        maxBytes: 4_000,
        maxEntries: 10,
      })) {
        out.push(chunk);
      }
    };
    await expect(run()).rejects.toEqual(new ZipLimitError('bytes', 4_000));
    expect(Buffer.concat(out).length).toBeLessThanOrEqual(4_000);
    expect(opened).not.toContain('pdf/m/en/v.pdf');
  });

  it('stops at one entry past its count, before opening it', async () => {
    const opened: string[] = [];
    await expect(
      collect(
        zipStreamOf(lazy(files, opened), MTIME, {
          maxBytes: 1_000_000,
          maxEntries: 2,
        }),
      ),
    ).rejects.toEqual(new ZipLimitError('entries', 2));
    expect(opened).toEqual(['index.html', 'media/a.png']);
  });
});
