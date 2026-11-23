import { findUnused, SCAN_PAGE_SIZE, SCAN_PAGES } from './media-unused';

const HASH = 'a'.repeat(64);
const other = (n: number) => n.toString(16).padStart(64, '0');
const ids = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => other(from + i));

describe('finding a file on the unused list', () => {
  it('answers its position on the list', async () => {
    const pages = [ids(1, SCAN_PAGE_SIZE), [...ids(1000, 30), HASH]];
    const read = vi.fn(async (page: number) => ({
      ids: pages[page - 1] ?? [],
      lastPage: 2,
    }));
    expect(await findUnused(HASH, read)).toEqual({
      kind: 'listed',
      index: 230,
    });
    expect(await findUnused(other(1), read)).toEqual({
      kind: 'listed',
      index: 0,
    });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('is absent once the whole list is read without it', async () => {
    const read = vi.fn(async () => ({ ids: ids(1, 3), lastPage: 1 }));
    expect(await findUnused(HASH, read)).toEqual({ kind: 'absent' });
    expect(read).toHaveBeenCalledTimes(1);
    const empty = vi.fn(async () => ({ ids: [], lastPage: 0 }));
    expect(await findUnused(HASH, empty)).toEqual({ kind: 'absent' });
  });

  it('stops after its pages, unknown then', async () => {
    const read = vi.fn(async (page: number) => ({
      ids: ids(page * SCAN_PAGE_SIZE, SCAN_PAGE_SIZE),
      lastPage: 50,
    }));
    expect(await findUnused(HASH, read)).toEqual({ kind: 'unknown' });
    expect(read).toHaveBeenCalledTimes(SCAN_PAGES);
  });

  it('reads no further page once aborted', async () => {
    const abort = new AbortController();
    const read = vi.fn(async (page: number) => {
      abort.abort();
      return { ids: ids(page * SCAN_PAGE_SIZE, SCAN_PAGE_SIZE), lastPage: 50 };
    });
    await expect(findUnused(HASH, read, abort.signal)).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
