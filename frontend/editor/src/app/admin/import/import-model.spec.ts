import {
  applyPercent,
  importErrorText,
  looseNotes,
  notesFor,
  orderImporters,
  pageOf,
  type ImportReport,
  type Importer,
  type ReportItem,
} from './import-model';
const item = (over: Partial<ReportItem>): ReportItem => ({
  kind: 'module',
  id: 'tank-filling',
  lang: 'en',
  pointer: '/modules/0',
  action: 'create',
  reasons: [],
  issues: [],
  issueCount: 0,
  ...over,
});

const reportOf = (
  items: ReportItem[],
  over: Partial<ImportReport> = {},
): ImportReport => ({
  valid: true,
  applicable: items.every((i) => i.action !== 'refuse'),
  applicableWithoutRefused: true,
  issues: [],
  items,
  converterReport: [],
  counts: {
    modules: 0,
    manuals: 0,
    assets: 0,
    create: items.filter((i) => i.action === 'create').length,
    update: items.filter((i) => i.action === 'update').length,
    skip: items.filter((i) => i.action === 'skip').length,
    refuse: items.filter((i) => i.action === 'refuse').length,
    passthrough: 0,
    errors: 0,
    warnings: 0,
    converterReport: 0,
  },
  ...over,
});

describe('orderImporters', () => {
  it('puts the documented format first', () => {
    const of = (id: string) =>
      ({ id, type: 'Importer' }) as unknown as Importer;
    expect(
      orderImporters([of('dita'), of('bundle'), of('other')]).map((i) => i.id),
    ).toEqual(['bundle', 'dita', 'other']);
  });
});

describe('pageOf', () => {
  it('cuts a page and keeps a page past the end on the last one', () => {
    const items = Array.from({ length: 60 }, (_, i) => i);
    expect(pageOf(items, 2, 25).items).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 25),
    );
    expect(pageOf(items, 9, 25).page).toEqual({
      currentPage: 3,
      lastPage: 3,
      perPage: 25,
      total: 60,
    });
    expect(pageOf([], 1, 25).page.lastPage).toBe(1);
  });
});

describe('the converter’s notes', () => {
  it('belong to the module they name or the source item, the rest to the bundle', () => {
    const module = item({ sourceId: 'PAGE-1' });
    const report = reportOf([module], {
      converterReport: [
        { sourceId: 'PAGE-9', message: 'A widget.', module: 'tank-filling' },
        { sourceId: 'PAGE-1', message: 'A table.' },
        { sourceId: 'PAGE-2', message: 'Not converted.' },
      ],
    });
    expect(notesFor(report, module).map((n) => n.message)).toEqual([
      'A widget.',
      'A table.',
    ]);
    expect(looseNotes(report).map((n) => n.message)).toEqual([
      'Not converted.',
    ]);
  });
});

describe('applyPercent', () => {
  it('counts the files uploaded and the working copies saved', () => {
    expect(
      applyPercent({
        phase: 'files',
        assets: { done: 2, total: 2 },
        files: { done: 1, total: 2 },
        commits: [],
      }),
    ).toBe(75);
    expect(
      applyPercent({
        phase: 'queued',
        assets: { done: 0, total: 0 },
        files: { done: 0, total: 0 },
        commits: [],
      }),
    ).toBe(0);
    expect(
      applyPercent({
        phase: 'done',
        assets: { done: 0, total: 0 },
        files: { done: 0, total: 0 },
        commits: ['a'],
      }),
    ).toBe(100);
  });
});

describe('importErrorText', () => {
  it('names the size limit of a file too large, in MB', () => {
    expect(
      importErrorText({
        kind: 'invalid',
        status: 422,
        code: 'too-large',
        message: '',
        errors: [
          {
            status: '422',
            code: 'too-large',
            title: '',
            meta: { max: 64 * 1024 * 1024 },
          },
        ],
      } as never),
    ).toEqual({
      key: 'editor.admin.import.error.tooLarge',
      params: { max: 64 },
    });
  });
});
