import {
  displayName,
  inUsePlaces,
  listQuery,
  shortType,
  uploadKind,
  type MediaItem,
  type MediaView,
} from './media-model';

const HASH = 'a'.repeat(64);

const item = (
  overrides: {
    fileName?: string | null;
    contentType?: string | null;
    usedIn?: { moduleId: string; lang: string; title: string }[];
    usedAs?: ('image' | 'attachment')[];
  } = {},
): MediaItem => ({
  type: 'Asset',
  id: HASH,
  attributes: {
    reference: `sha256:${HASH}`,
    fileName: overrides.fileName ?? null,
    contentType:
      overrides.contentType === undefined ? 'image/png' : overrides.contentType,
    size: 10,
    width: null,
    height: null,
    font: null,
  },
  meta: {
    usedIn: overrides.usedIn ?? [],
    usedInCount: overrides.usedIn?.length ?? 0,
    usedInManuals: [],
    languages: [],
    usedAs: overrides.usedAs ?? ['image'],
    uploaded: false,
    missing: false,
  },
});

const view = (change: Partial<MediaView> = {}): MediaView => ({
  view: 'grid',
  type: undefined,
  usage: 'all',
  lang: undefined,
  q: '',
  page: 1,
  size: 24,
  file: undefined,
  ...change,
});

describe('the media model', () => {
  it('asks for the view’s page with its filters, the change set’s uploads first', () => {
    expect(
      listQuery(view({ type: 'image', lang: 'de', q: 'pump', page: 2 }), 'cs1'),
    ).toEqual({
      'filter[type]': 'image',
      'filter[q]': 'pump',
      'filter[lang]': 'de',
      'filter[changeSet]': 'cs1',
      'page[number]': 2,
      'page[size]': 24,
    });
  });

  it('lists the unused files without a language or the change set, which narrow it to nothing', () => {
    expect(listQuery(view({ usage: 'unused', lang: 'de' }), 'cs1')).toEqual({
      'filter[unused]': 'true',
      'page[number]': 1,
      'page[size]': 24,
    });
  });

  it('names a file by its file name, else the module using it, else its hash', () => {
    expect(displayName(item({ fileName: 'manual.pdf' }))).toBe('manual.pdf');
    expect(
      displayName(
        item({
          usedIn: [
            { moduleId: 'pump', lang: 'en', title: 'Pump' },
            { moduleId: 'pump', lang: 'de', title: 'Pumpe' },
          ],
        }),
        'de',
      ),
    ).toBe('Pumpe');
    expect(displayName(item())).toBe(HASH.slice(0, 12));
  });

  it('gives a short type for images and attached files', () => {
    expect(shortType(item())).toBe('PNG');
    expect(
      shortType(
        item({ contentType: 'application/zip', usedAs: ['attachment'] }),
      ),
    ).toBe('ZIP');
    expect(shortType(item({ contentType: null, usedAs: ['image'] }))).toBe(
      null,
    );
  });

  it('reads the places a 409 names, once each and at most three', () => {
    expect(
      inUsePlaces({
        usedIn: [
          { in: 'main', ref: 'main' },
          { in: 'main', ref: 'main' },
          { in: 'working-copy' },
          { nothing: true },
          { in: 'release', ref: 'v1' },
          { in: 'branch' },
        ],
      }),
    ).toEqual([
      { in: 'main', ref: 'main' },
      { in: 'working-copy' },
      { in: 'release', ref: 'v1' },
    ]);
    expect(inUsePlaces(undefined)).toEqual([]);
    expect(inUsePlaces({ usedIn: 'x' })).toEqual([]);
  });

  it('uploads PNG and JPEG as images and anything else as attachments', () => {
    expect(uploadKind(new File([''], 'a.png', { type: 'image/png' }))).toBe(
      'image',
    );
    expect(uploadKind(new File([''], 'a.svg', { type: 'image/svg+xml' }))).toBe(
      'attachment',
    );
    expect(uploadKind(new File([''], 'a.zip'))).toBe('attachment');
  });
});
