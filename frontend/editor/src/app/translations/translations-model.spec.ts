import {
  blockTexts,
  cellKey,
  chosenExportText,
  chosenText,
  coverTexts,
  designBlockTexts,
  exportBody,
  initialChoice,
  matrixLanguages,
  matrixRows,
  openBlocks,
  pageRows,
  parseCell,
  subjectOf,
  validDueDate,
  type StatusDetail,
  type StatusItem,
} from './translations-model';
import type { ModuleContent } from '../module-editor/module-model';

const status = (
  moduleId: string,
  lang: string,
  state: StatusItem['attributes']['state'],
  title = moduleId,
): StatusItem => ({
  type: 'TranslationStatus',
  id: `${lang}/${moduleId}`,
  attributes: { kind: 'module', moduleId, lang, state },
  meta: {
    title,
    totalBlocks: 4,
    outdatedBlocks: state === 'outdated' ? 2 : 0,
    atProviderBlocks: state === 'at-provider' ? 4 : 0,
    sourceCommit: null,
  },
});

describe('matrixRows', () => {
  it('groups the statuses into one row per module, in the order they come', () => {
    const rows = matrixRows([
      status('battery', 'de', 'outdated', 'Battery'),
      status('battery', 'fr', 'missing', 'Battery'),
      status('safety', 'de', 'up-to-date', 'Safety'),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['battery', 'safety']);
    expect([...rows[0]!.cells.keys()]).toEqual(['de', 'fr']);
    expect(rows[1]!.title).toBe('Safety');
  });
});

describe('a page design’s rows (#568)', () => {
  const design: StatusItem = {
    type: 'TranslationStatus',
    id: 'de/designs/house',
    attributes: {
      kind: 'design',
      designId: 'house',
      lang: 'de',
      state: 'missing',
    },
    meta: {
      title: 'House style',
      totalBlocks: 2,
      outdatedBlocks: 2,
      atProviderBlocks: 0,
      sourceCommit: null,
    },
  };

  it('is a row of its own, by the design', () => {
    const rows = matrixRows([design, status('battery', 'de', 'missing')]);
    expect(rows.map((r) => [r.id, r.kind, r.ref, r.title])).toEqual([
      ['designs/house', 'design', 'house', 'House style'],
      ['battery', 'module', 'battery', 'battery'],
    ]);
  });

  it('chooses one kind of row on a page: the kind chosen, else modules', () => {
    const rows = matrixRows([design, status('battery', 'de', 'missing')]);
    const ids = (chosen: string[]) => pageRows(rows, chosen).map((r) => r.id);
    expect(ids([])).toEqual(['battery']);
    expect(ids(['designs/other'])).toEqual(['designs/house']);
    expect(ids(['safety'])).toEqual(['battery']);
    expect(pageRows(rows.slice(0, 1), []).map((r) => r.id)).toEqual([
      'designs/house',
    ]);
  });

  it('exports chosen designs as designs, and no mix of designs and modules', () => {
    const values = { manual: '', folder: '' };
    expect(
      subjectOf('selection', { ...values, selection: ['designs/house'] }),
    ).toEqual({ type: 'designs', designIds: ['house'] });
    expect(
      subjectOf('selection', {
        ...values,
        selection: ['designs/house', 'battery'],
      }),
    ).toBeNull();
  });

  it('reads each region’s text per unit, a translation only where the language has its own', () => {
    const p = (id: string, text: string) => ({
      type: 'paragraph' as const,
      id,
      content: [{ type: 'text' as const, text }],
    });
    const regions = {
      back: { en: [p('imprint', 'Made by us')], de: [p('imprint', 'Von uns')] },
      footer: [p('note', 'Same everywhere')],
    };
    expect([...designBlockTexts(regions, 'en', 'en', false)]).toEqual([
      ['back.imprint', 'Made by us'],
      ['footer.note', 'Same everywhere'],
    ]);
    expect([...designBlockTexts(regions, 'de', 'en', true)]).toEqual([
      ['back.imprint', 'Von uns'],
    ]);
  });
});

describe('a manual’s cover image text rows (#656)', () => {
  const manual: StatusItem = {
    type: 'TranslationStatus',
    id: 'de/manuals/operating',
    attributes: {
      kind: 'manual',
      manualId: 'operating',
      lang: 'de',
      state: 'missing',
    },
    meta: {
      title: 'Operating manual',
      totalBlocks: 2,
      outdatedBlocks: 2,
      atProviderBlocks: 0,
      sourceCommit: null,
    },
  };

  it('is a row of its own, by the manual, and its cell parses', () => {
    const rows = matrixRows([manual, status('battery', 'de', 'missing')]);
    expect(rows.map((r) => [r.id, r.kind, r.ref, r.title])).toEqual([
      ['manuals/operating', 'manual', 'operating', 'Operating manual'],
      ['battery', 'module', 'battery', 'battery'],
    ]);
    expect(parseCell('de/manuals/operating')).toEqual({
      lang: 'de',
      kind: 'manual',
      manualId: 'operating',
    });
    expect(parseCell('de/manuals/../x')).toBeNull();
  });

  it('chooses manuals on a page only once one is chosen, or when the page has nothing else', () => {
    const rows = matrixRows([manual, status('battery', 'de', 'missing')]);
    const ids = (chosen: string[]) => pageRows(rows, chosen).map((r) => r.id);
    expect(ids([])).toEqual(['battery']);
    expect(ids(['manuals/other'])).toEqual(['manuals/operating']);
    expect(pageRows(rows.slice(0, 1), []).map((r) => r.id)).toEqual([
      'manuals/operating',
    ]);
  });

  it('exports chosen manuals as manuals, and no mix', () => {
    const values = { manual: '', folder: '' };
    expect(
      subjectOf('selection', { ...values, selection: ['manuals/operating'] }),
    ).toEqual({ type: 'manuals', manualIds: ['operating'] });
    expect(
      subjectOf('selection', {
        ...values,
        selection: ['manuals/operating', 'designs/house'],
      }),
    ).toBeNull();
  });

  it('names what was chosen: modules, page designs, cover image texts, or a mix', () => {
    expect(chosenText([])).toEqual({
      key: 'editor.translations.selection.count',
      params: { count: 0 },
    });
    expect(chosenText(['battery']).key).toBe(
      'editor.translations.selection.count',
    );
    expect(chosenText(['designs/house', 'designs/x'])).toEqual({
      key: 'editor.translations.selection.countDesigns',
      params: { count: 2 },
    });
    expect(chosenText(['manuals/operating']).key).toBe(
      'editor.translations.selection.countManuals',
    );
    expect(chosenText(['manuals/operating', 'battery']).key).toBe(
      'editor.translations.selection.countMixed',
    );
    expect(chosenExportText(['manuals/operating']).key).toBe(
      'editor.translations.export.selectionManuals',
    );
  });

  it('reads each cover image’s text per unit, a translation only where the language has its own', () => {
    const manifest = {
      coverImage: {
        default: {
          asset: 'sha256:' + 'a'.repeat(64),
          alt: { en: 'The vehicle', de: 'Das Fahrzeug' },
        },
        variants: [
          {
            variant: { model: 'l-400' },
            asset: 'sha256:' + 'a'.repeat(64),
            alt: 'The L-400 <b>',
          },
        ],
      },
    };
    const en = [...coverTexts(manifest, 'en', 'en', false)];
    expect(en[0]).toEqual(['coverImage.default', 'The vehicle']);
    expect(en[1]?.[1]).toBe('The L-400 <b>');
    expect([...coverTexts(manifest, 'de', 'en', true)]).toEqual([
      ['coverImage.default', 'Das Fahrzeug'],
    ]);
  });
});

describe('matrixLanguages', () => {
  const targets = ['de', 'fr', 'it'];

  it('is the filtered language alone', () => {
    expect(matrixLanguages(targets, [], 'fr')).toEqual(['fr']);
  });

  it('keeps the configured order of the languages the page shows', () => {
    const items = [status('a', 'it', 'missing'), status('a', 'de', 'missing')];
    expect(matrixLanguages(targets, items, undefined)).toEqual(['de', 'it']);
  });

  it('shows every target while the page shows none', () => {
    expect(matrixLanguages(targets, [], undefined)).toEqual(targets);
  });
});

describe('cells', () => {
  it('reads a cell key back', () => {
    expect(parseCell(cellKey('pt-BR', 'battery-faq'))).toEqual({
      lang: 'pt-BR',
      kind: 'module',
      moduleId: 'battery-faq',
    });
    expect(parseCell('de/designs/house')).toEqual({
      lang: 'de',
      kind: 'design',
      designId: 'house',
    });
    expect(parseCell('de/designs/../x')).toBeNull();
    expect(parseCell('../etc')).toBeNull();
    expect(parseCell('de/Bad Id')).toBeNull();
  });
});

describe('the export', () => {
  it('starts from the chosen rows, else the filtered manual or folder', () => {
    expect(
      initialChoice({ selection: ['a'], manual: 'm', folder: undefined }),
    ).toBe('selection');
    expect(
      initialChoice({ selection: [], manual: undefined, folder: 'task' }),
    ).toBe('folder');
    expect(initialChoice({ selection: [], manual: 'm', folder: 'task' })).toBe(
      'manual',
    );
  });

  it('names a subject only once it is complete', () => {
    const values = { selection: ['a', 'b'], manual: '', folder: 'task/x' };
    expect(subjectOf('selection', values)).toEqual({
      type: 'modules',
      moduleIds: ['a', 'b'],
    });
    expect(subjectOf('manual', values)).toBeNull();
    expect(subjectOf('folder', values)).toEqual({
      type: 'folder',
      folder: 'task/x',
    });
  });

  it('builds the request, with a dry run only when asked', () => {
    const request = {
      languages: ['de'],
      subject: { type: 'manual' as const, manualId: 'operating' },
      ref: 'change-sets/abc',
      dueDate: '',
    };
    expect(exportBody(request, true)).toEqual({
      data: {
        type: 'TranslationJob',
        attributes: {
          languages: ['de'],
          subject: { type: 'manual', manualId: 'operating' },
          ref: 'change-sets/abc',
        },
      },
      meta: { dryRun: true },
    });
    const real = exportBody(
      { ...request, ref: undefined, dueDate: '2026-12-01' },
      false,
    );
    expect(real.meta).toBeUndefined();
    expect(real.data.attributes).toEqual({
      languages: ['de'],
      subject: { type: 'manual', manualId: 'operating' },
      dueDate: '2026-12-01',
    });
  });

  it('takes a real day or none as the due date', () => {
    expect(validDueDate('')).toBe(true);
    expect(validDueDate('2026-12-01')).toBe(true);
    expect(validDueDate('2026-02-30')).toBe(false);
    expect(validDueDate('tomorrow')).toBe(false);
  });
});

describe('blocks', () => {
  it('gives each translatable block its plain text', () => {
    const content = {
      schemaVersion: 1,
      id: 'battery',
      meta: { title: 'Battery', type: 'concept', lang: 'en', facets: {} },
      blocks: [
        {
          type: 'section',
          id: 's1',
          title: [{ type: 'text', text: 'Charging' }],
          blocks: [
            {
              type: 'paragraph',
              id: 'p1',
              content: [
                { type: 'text', text: 'Plug ' },
                { type: 'text', text: 'it in', marks: [{ type: 'strong' }] },
              ],
            },
          ],
        },
      ],
    } as unknown as ModuleContent;
    expect([...blockTexts(content)]).toEqual([
      ['s1', 'Charging'],
      ['p1', 'Plug it in'],
    ]);
  });

  it('lists the blocks that need work', () => {
    const detail = {
      meta: {
        blocks: [
          { blockId: 'a', state: 'up-to-date' },
          { blockId: 'b', state: 'outdated' },
          { blockId: 'c', state: 'at-provider' },
        ],
      },
    } as unknown as StatusDetail;
    expect(openBlocks(detail).map((b) => b.blockId)).toEqual(['b', 'c']);
  });
});
