import type { Module } from '@openfolia/content-model';
import { describe, expect, it } from 'vitest';
import {
  exportInput,
  importedFixture,
  packageFiles,
} from '../../testing/export-fixture.js';
import {
  SAMPLE_CONFIG,
  SAMPLE_MANUAL,
  SAMPLE_MODULES,
  sampleInput,
} from '../../testing/export-sample.js';
import { validateDita } from '../../testing/grammars.js';
import { convertDita } from '../convert.js';
import {
  type DitaExport,
  DitaExportTooLargeError,
  exportDita,
  topicTypeFor,
} from './export.js';

const texts = (out: DitaExport) =>
  new Map(
    out.files.flatMap((f) => ('text' in f ? [[f.path, f.text] as const] : [])),
  );
const text = (out: DitaExport, path: string) => {
  const found = texts(out).get(path);
  if (found === undefined) throw new Error(`No file ${path}`);
  return found;
};
const codes = (out: DitaExport) => new Set(out.warnings.map((w) => w.code));
/** A module without where it was read from, which an import of an export names differently. */
const unsourced = (m: Module) => ({
  ...m,
  meta: { ...m.meta, source: undefined },
});

describe('exportDita on the garden pump fixture: the round trip', async () => {
  const { config, conversion, document } = await importedFixture();

  for (const manual of ['maps-pump-manual', 'maps-quick-guide']) {
    for (const references of ['conref', 'resolved'] as const) {
      it(`imports again as the same content (${manual}, ${references})`, async () => {
        const out = exportDita(
          exportInput(config, conversion, manual, { references }),
        );
        const again = await convertDita(packageFiles(out, conversion), config);
        expect(again.document.manuals).toEqual(
          document.manuals.filter((m) => m.id === manual),
        );
        expect(again.document.modules.length).toBeGreaterThan(0);
        for (const module of again.document.modules) {
          const before = document.modules.find(
            (m) => m.id === module.id && m.meta.lang === module.meta.lang,
          );
          expect(before, `${module.meta.lang}/${module.id}`).toBeDefined();
          expect(unsourced(module as Module)).toEqual(
            unsourced(before as Module),
          );
        }
        expect(again.assets).toEqual(
          new Map(
            [...conversion.assets].filter(([ref]) => again.assets.has(ref)),
          ),
        );
      });
    }
  }

  it('is valid DITA 1.3 by the OASIS grammars', async () => {
    const out = exportDita(exportInput(config, conversion, 'maps-pump-manual'));
    const { errors, checked } = await validateDita(texts(out));
    expect(errors).toEqual([]);
    expect(checked.length).toBe(texts(out).size);
  }, 120_000);

  it('writes each topic as the topic type its module type maps back to', () => {
    const out = exportDita(exportInput(config, conversion, 'maps-pump-manual'));
    const root = (path: string) => /<!DOCTYPE (\w+)/.exec(text(out, path))?.[1];
    expect(root('en/topics-overview.dita')).toBe('concept');
    expect(root('en/topics-specs.dita')).toBe('reference');
    expect(root('en/topics-install.dita')).toBe('task');
    expect(root('en/topics-fault.dita')).toBe('troubleshooting');
    expect(root('de/topics-install.dita')).toBe('task');
  });
});

describe('exportDita on content of every kind', () => {
  for (const references of ['conref', 'resolved'] as const) {
    it(`is valid DITA 1.3 by the OASIS grammars (${references})`, async () => {
      const out = exportDita(sampleInput({ references }));
      const { errors } = await validateDita(texts(out));
      expect(errors).toEqual([]);
    }, 120_000);
  }

  it('is deterministic: the same input makes the same files', () => {
    expect(exportDita(sampleInput())).toEqual(exportDita(sampleInput()));
  });

  it('lays the package out by language, with filters, images, files and symbols', () => {
    const paths = exportDita(sampleInput()).files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain('en/kettle.ditamap');
    expect(paths).toContain('de/kettle.ditamap');
    expect(paths).toContain('en/everything.dita');
    expect(paths).toContain('de/steps.dita');
    expect(paths).toContain(`images/${'a'.repeat(64)}.png`);
    expect(paths).toContain(`files/${'b'.repeat(64)}.zip`);
    // A symbol keeps the file name the mapping reads it by.
    expect(paths).toContain('symbols/general-warning.svg');
    expect(paths).toContain('symbols/m002.png');
    expect(paths.filter((p) => p.startsWith('filters/'))).toEqual([
      'filters/market-eu-model-basic-software-2.0.ditaval',
      'filters/market-us-model-max-software-2.5.ditaval',
      'filters/market-us-model-pro-software-3.1.ditaval',
    ]);
    for (const path of paths) {
      expect(path).toMatch(
        /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/,
      );
    }
  });

  it('writes a DITAVAL file per variant, by the mapping read backwards', () => {
    const out = exportDita(sampleInput());
    expect(
      text(out, 'filters/market-eu-model-basic-software-2.0.ditaval'),
    ).toContain('<prop att="product" val="kettle-basic" action="include"/>');
    const map = text(out, 'en/kettle.ditamap');
    expect(map).toContain(
      '<ditavalref href="../filters/market-us-model-pro-software-3.1.ditaval"/>',
    );
    expect(map).toContain('<topicref href="steps.dita" product="max pro"/>');
    expect(map).toContain('<keydef keys="prodname">');
  });

  it('writes variant blocks with filter attributes', () => {
    const topic = text(exportDita(sampleInput()), 'en/everything.dita');
    expect(topic).toContain('<div id="pro-only" product="pro">');
    expect(topic).toContain('<div id="basic-only" product="kettle-basic">');
    expect(topic).toContain('<div id="not-basic" product="max pro">');
    expect(topic).toContain(
      '<div id="new-software" props="market(us) software(3.1)">',
    );
  });

  it('writes a module reference as a content reference, or its content where it must', () => {
    const out = exportDita(sampleInput());
    const topic = text(out, 'en/everything.dita');
    expect(topic).toContain(
      '<p conref="snippet.dita#snippet/snippet-1" conrefend="snippet.dita#snippet/snippet-2" outputclass="openfolia-module-reference" id="ref"/>',
    );
    // Sections cannot be referenced into a body: put in, with IDs of their own.
    expect(topic).toContain('<p id="ref-big--big-1">');
    // A note inside a note cannot be: put in too.
    expect(topic).toContain('<div id="ref-in-note--snippet-note">');
    expect(codes(out)).toContain('module-reference-resolved');
    // A module referenced is a topic of the package, out of the map.
    expect(texts(out).has('en/snippet.dita')).toBe(true);
    expect(text(out, 'en/kettle.ditamap')).not.toContain('snippet.dita');

    const resolved = text(
      exportDita(sampleInput({ references: 'resolved' })),
      'en/everything.dita',
    );
    expect(resolved).not.toContain('conref');
    expect(resolved).toContain('<p id="ref--snippet-1">');
  });

  it('writes safety notices as hazard statements with their symbols', () => {
    const out = exportDita(sampleInput());
    const topic = text(out, 'en/everything.dita');
    expect(topic).toContain('<hazardstatement id="hot" type="warning">');
    expect(topic).toContain('<typeofhazard>Hot surface</typeofhazard>');
    expect(topic).toContain(
      '<hazardsymbol href="../symbols/general-warning.svg"/>',
    );
    expect(codes(out)).toContain('missing-symbol');
    expect(codes(out)).toContain('safety-as-note');
  });

  it('writes a task of the steps, a reference of sections, troubleshooting of remedies', () => {
    const out = exportDita(sampleInput());
    const steps = text(out, 'en/steps.dita');
    expect(steps).toMatch(/<task id="steps"/);
    expect(steps).toContain('<step id="set-temperature" product="pro">');
    expect(steps).toContain('<substeps id="sub">');
    expect(text(out, 'en/reference-data.dita')).toMatch(
      /<reference id="reference-data"/,
    );
    const trouble = text(out, 'en/trouble.dita');
    expect(trouble.match(/<troubleSolution>/g)).toHaveLength(3);
    expect(trouble).toContain('<title>Second remedy</title>');
    // Two procedures apart are no task: a topic of ordered lists.
    expect(text(out, 'en/two-procedures.dita')).toMatch(
      /<topic id="two-procedures"/,
    );
  });

  it('names a module whose ID starts with a digit by a topic ID that may', () => {
    expect(text(exportDita(sampleInput()), 'en/2-intro.dita')).toContain(
      '<concept id="m-2-intro"',
    );
  });

  it('links cross-references into the package, and writes the others as text', () => {
    const out = exportDita(sampleInput());
    const topic = text(out, 'en/everything.dita');
    expect(topic).toContain('<xref href="steps.dita#steps/fill"/>');
    expect(topic).toContain(
      '<xref href="reference-data.dita#reference-data">the data</xref>',
    );
    expect(topic).toContain('<ph>elsewhere</ph>');
    expect(codes(out)).toContain('xref-outside');
  });

  it('falls back to the source language for a missing translation, and says so', () => {
    const out = exportDita(sampleInput());
    expect(text(out, 'de/steps.dita')).toContain('<title>Füllen</title>');
    expect(text(out, 'de/everything.dita')).toContain('xml:lang="en"');
    expect(
      out.warnings.some(
        (w) =>
          w.code === 'missing-translation' &&
          w.lang === 'de' &&
          w.module === 'everything',
      ),
    ).toBe(true);
    expect(
      out.warnings.some(
        (w) =>
          w.code === 'module-not-exported' && w.module === 'missing-module',
      ),
    ).toBe(true);
  });

  it('leaves out modules above the manual’s audience', () => {
    const out = exportDita(
      sampleInput({ manifest: { ...SAMPLE_MANUAL, audience: 'user' } }),
    );
    expect(texts(out).has('en/reference-data.dita')).toBe(false);
    expect(text(out, 'en/kettle.ditamap')).not.toContain('reference-data.dita');
    // A cross-reference to it is its text.
    expect(text(out, 'en/everything.dita')).toContain('<ph>the data</ph>');
  });

  it('exports only the languages asked for', () => {
    const out = exportDita(sampleInput({ languages: ['de'] }));
    expect(out.files.some((f) => f.path.startsWith('en/'))).toBe(false);
    expect(out.topics).toBeGreaterThan(0);
  });

  it('stops at its bounds', () => {
    expect(() => exportDita(sampleInput({ limits: { maxNodes: 50 } }))).toThrow(
      DitaExportTooLargeError,
    );
    expect(() =>
      exportDita(sampleInput({ limits: { maxChars: 1000 } })),
    ).toThrow(DitaExportTooLargeError);
  });

  it('puts in the one block a module reference names (#223)', () => {
    const host: Module = {
      ...(SAMPLE_MODULES[1] as Module),
      id: 'host',
      blocks: [
        { type: 'moduleRef', id: 'one', module: 'snippet', block: 'snippet-2' },
        { type: 'moduleRef', id: 'gone', module: 'snippet', block: 'nowhere' },
      ],
    };
    const base = sampleInput();
    for (const references of ['conref', 'resolved'] as const) {
      const out = exportDita(
        sampleInput({
          references,
          languages: ['en'],
          manifest: { ...SAMPLE_MANUAL, entries: [{ module: 'host' }] },
          module: (id, lang) => (id === 'host' ? host : base.module(id, lang)),
        }),
      );
      const topic = text(out, 'en/host.dita');
      expect(topic).toContain('<p id="one--snippet-2">');
      expect(topic).not.toContain('snippet-1');
      expect(topic).not.toContain('conref');
      expect(out.warnings).toContainEqual(
        expect.objectContaining({
          code: 'module-not-exported',
          module: 'host',
          block: 'gone',
        }),
      );
    }
  });

  it('follows module references in a cycle only once', () => {
    const loop = (id: string, to: string): Module => ({
      ...(SAMPLE_MODULES[1] as Module),
      id,
      blocks: [{ type: 'moduleRef', id: 'r', module: to }],
    });
    const modules = new Map([
      ['a', loop('a', 'b')],
      ['b', loop('b', 'a')],
    ]);
    const out = exportDita(
      sampleInput({
        languages: ['en'],
        manifest: { ...SAMPLE_MANUAL, entries: [{ module: 'a' }] },
        module: (id) => modules.get(id),
      }),
    );
    expect(codes(out)).toContain('module-reference-cycle');
  });
  it('bounds a long chain of references, whatever order the manual lists it in', () => {
    const length = 5_000;
    const modules = new Map<string, Module>();
    for (let n = 0; n < length; n++) {
      modules.set(`c${n}`, {
        ...(SAMPLE_MODULES[1] as Module),
        id: `c${n}`,
        blocks:
          n === length - 1
            ? [
                {
                  type: 'paragraph',
                  id: 'end',
                  content: [{ type: 'text', text: 'End.' }],
                },
              ]
            : [{ type: 'moduleRef', id: 'r', module: `c${n + 1}` }],
      });
    }
    for (const references of ['conref', 'resolved'] as const) {
      const out = exportDita(
        sampleInput({
          languages: ['en'],
          references,
          manifest: {
            ...SAMPLE_MANUAL,
            entries: [...modules.keys()]
              .reverse()
              .map((module) => ({ module })),
          },
          module: (id) => modules.get(id),
        }),
      );
      expect(out.topics).toBe(length);
    }
  });
});

describe('exportDita on hostile content', () => {
  const hostile =
    'a <b> & "c" \'d\' ]]> <!ENTITY x SYSTEM "file:///etc/passwd"> &x; \u0001';
  const module = (lang: string): Module => ({
    schemaVersion: 1,
    id: 'hostile',
    meta: {
      title: hostile,
      type: 'concept',
      lang,
      facets: {},
      keywords: [hostile],
    },
    blocks: [
      {
        type: 'paragraph',
        id: 'p',
        content: [{ type: 'text', text: hostile }],
      },
      {
        type: 'paragraph',
        id: 'link',
        content: [
          {
            type: 'text',
            text: 'x',
            marks: [{ type: 'link', href: 'https://example.com/"><script>' }],
          },
        ],
      },
      { type: 'literal', id: 'code', text: hostile },
    ],
  });
  const input = sampleInput({
    languages: ['en'],
    manifest: {
      ...SAMPLE_MANUAL,
      title: hostile,
      variants: [{ model: '../../evil' }],
      attributes: { 'product-name': hostile },
      entries: [
        {
          module: 'hostile',
          when: { op: 'in', attr: 'model', values: ['"><x'] },
        },
      ],
    },
    module: (id, lang) => (id === 'hostile' ? module(lang) : undefined),
  });

  it('escapes every text and attribute, and is still valid', async () => {
    const out = exportDita(input);
    const files = texts(out);
    for (const [, contents] of files) {
      expect(contents).not.toContain('<!ENTITY');
      expect(contents).not.toContain('<script>');
      expect(contents).not.toContain('<b>');
      expect(contents).not.toContain('\u0001');
    }
    const { errors } = await validateDita(files);
    expect(errors).toEqual([]);
  }, 120_000);

  it('reads back as the same text', async () => {
    const out = exportDita(input);
    const files = new Map(
      [...texts(out)].map(([p, t]) => [p, new TextEncoder().encode(t)]),
    );
    const { document } = await convertDita(files, SAMPLE_CONFIG);
    const back = document.modules.find((m) => m.id === 'hostile');
    // A control character, which XML cannot hold, is the replacement character.
    const expected = hostile.replace('\u0001', '\uFFFD');
    expect(back?.meta.title).toBe(expected);
    expect(document.manuals[0]?.title).toBe(expected);
  });

  it('names files only by safe paths, whatever the variant values', () => {
    const paths = exportDita(input).files.map((f) => f.path);
    for (const path of paths) {
      expect(path.split('/')).not.toContain('..');
      expect(path).toMatch(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
    }
    expect(paths.some((p) => p.startsWith('filters/'))).toBe(true);
  });

  it('never names a symbol file by an unsafe mapping key', () => {
    const out = exportDita(
      sampleInput({
        config: {
          ...SAMPLE_CONFIG,
          dita: {
            ...(SAMPLE_CONFIG.dita as NonNullable<typeof SAMPLE_CONFIG.dita>),
            hazardSymbols: { '../../escape.svg': 'w001' },
          },
        },
      }),
    );
    const paths = out.files.map((f) => f.path);
    expect(paths).toContain('symbols/w001.svg');
    expect(paths.some((p) => p.includes('escape'))).toBe(false);
  });
});

describe('topicTypeFor', () => {
  it('reads the mapping backwards, then the type’s name, then topic', () => {
    expect(topicTypeFor('procedure', SAMPLE_CONFIG)).toEqual({
      type: 'task',
      outputclass: undefined,
    });
    expect(topicTypeFor('concept', SAMPLE_CONFIG).type).toBe('concept');
    expect(topicTypeFor('snippet', SAMPLE_CONFIG)).toEqual({
      type: 'topic',
      outputclass: 'snippet',
    });
  });
});
