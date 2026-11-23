import { newReleaseId, type Release } from '../../releases/core/release.js';
import {
  type DownloadFile,
  downloadId,
  isForProduct,
  parseDownloadId,
  versionsOf,
} from './download.js';

const release = (n: number, extra: Partial<Release> = {}): Release => ({
  id: newReleaseId(Date.parse('2026-01-01T00:00:00Z') + n * 1000),
  product: 'tuggers',
  productFacet: 'line',
  revision: `${n}.0`,
  tag: `release/tuggers/${n}.0`,
  tagObject: 'e'.repeat(40),
  commit: String(n).repeat(40).slice(0, 40),
  notes: `Notes ${n}`,
  notesByLanguage: { de: `Hinweise ${n}` },
  major: false,
  publishedBy: { kind: 'user', id: 'p' },
  publishedAt: new Date(Date.parse('2026-01-01T00:00:00Z') + n * 1000),
  withdrawal: null,
  ...extra,
});

const file = (
  hash: string,
  description: string | null = null,
): DownloadFile => ({
  sha256: hash.repeat(64),
  size: 10,
  mediaType: 'application/zip',
  fileName: 'a.zip',
  description,
});

const withdrawn = {
  withdrawal: {
    by: { kind: 'user' as const, id: 'p' },
    at: new Date(),
    reason: 'Wrong',
  },
};

describe('download IDs', () => {
  it('names an attachment or a manual and reads back', () => {
    const attachment = {
      kind: 'attachment',
      product: 'tuggers',
      moduleId: 'datasheet',
      blockId: 'file-1',
      lang: 'de',
    } as const;
    const manual = {
      kind: 'manual',
      product: 'tuggers',
      manualId: 'operating',
      lang: 'pt-BR',
      variant: 'market=eu,model=l-400,software=2.3',
    } as const;
    expect(downloadId(attachment)).toBe(
      'attachment:tuggers:datasheet:file-1:de',
    );
    expect(parseDownloadId(downloadId(attachment))).toEqual(attachment);
    expect(parseDownloadId(downloadId(manual))).toEqual(manual);
    expect(parseDownloadId('manual:tuggers:operating:en:')).toMatchObject({
      variant: '',
    });
  });

  it('refuses anything that is not one', () => {
    for (const id of [
      '',
      'attachment',
      'attachment:tuggers:datasheet:file-1',
      'attachment:tuggers:datasheet:file-1:de:x',
      'attachment:Tuggers:datasheet:file-1:de',
      'attachment:tuggers:../x:file-1:de',
      'attachment:tuggers:datasheet:1file:de',
      'manual:tuggers:operating:en:model=a/b',
      'image:tuggers:a:b:en',
    ]) {
      expect(parseDownloadId(id)).toBeUndefined();
    }
  });
});

describe('isForProduct', () => {
  it('takes a module naming the product or no product', () => {
    expect(isForProduct({}, 'line', 'tuggers')).toBe(true);
    expect(isForProduct({ line: [] }, 'line', 'tuggers')).toBe(true);
    expect(isForProduct({ line: ['tuggers'] }, 'line', 'tuggers')).toBe(true);
    expect(isForProduct({ line: ['lifts'] }, 'line', 'tuggers')).toBe(false);
    expect(isForProduct({ other: ['x'] }, 'line', 'tuggers')).toBe(true);
  });
});

describe('versionsOf', () => {
  it('lists a version only where the hash changed, newest first, with its notes', () => {
    const [r1, r2, r3, r4] = [release(1), release(2), release(3), release(4)];
    const versions = versionsOf(
      [
        { release: r4, file: file('b', 'New') },
        { release: r3, file: file('b') },
        { release: r2, file: file('a', 'Old') },
        { release: r1, file: file('a') },
      ],
      r4.id,
      'en',
    );
    expect(
      versions.map((v) => [
        v.release.revision,
        v.state,
        v.notes,
        v.description,
      ]),
    ).toEqual([
      ['3.0', 'current', 'Notes 3', null],
      ['1.0', 'superseded', 'Notes 1', null],
    ]);
  });

  it('takes the notes in the language, passes over releases without the file', () => {
    const [r1, r2, r3] = [release(1), release(2), release(3)];
    const versions = versionsOf(
      [
        { release: r3, file: file('a') },
        { release: r2, file: undefined },
        { release: r1, file: file('a') },
      ],
      r3.id,
      'de',
    );
    expect(versions.map((v) => [v.release.revision, v.notes])).toEqual([
      ['1.0', 'Hinweise 1'],
    ]);
    expect(versions[0]?.state).toBe('current');
  });

  it('marks a version only withdrawn releases held, and none current when the latest has no file', () => {
    const r1 = release(1);
    const r2 = release(2, withdrawn);
    const r3 = release(3);
    const versions = versionsOf(
      [
        { release: r3, file: undefined },
        { release: r2, file: file('b') },
        { release: r1, file: file('a') },
      ],
      r3.id,
      'en',
    );
    expect(versions.map((v) => [v.release.revision, v.state])).toEqual([
      ['2.0', 'withdrawn'],
      ['1.0', 'superseded'],
    ]);
  });
});
