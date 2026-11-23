import {
  Manifest,
  MAX_TABLE_COLUMNS,
  Module,
  ProjectConfig,
  resolveManual,
  TableTooLargeError,
  type Block,
  type ResolvedManual,
  type Table,
} from '@openfolia/content-model';
import {
  closeWorkerPool,
  compilePdf,
  compilePdfInWorker,
  TypstAccessibilityError,
  TypstCompileError,
  TypstTimeoutError,
} from './compile.js';
import { renderTypst, str } from './render.js';
import { DEFAULT_TEMPLATE } from './template.js';
import { assertSafeWorkspace, standardProblems } from './compile-core.js';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const text = (t: string) => ({ type: 'text' as const, text: t });
const para = (id: string, t: string) => ({
  type: 'paragraph' as const,
  id,
  content: [text(t)],
});

const config = ProjectConfig.parse({
  languages: { source: 'en', targets: ['de'] },
  moduleTypes: [
    { id: 'concept', label: 'Concept' },
    { id: 'procedure', label: 'Procedure' },
  ],
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
  variantAttributes: [
    {
      id: 'model',
      label: 'Model',
      kind: 'enum',
      values: [
        { id: 'small', label: 'Small' },
        { id: 'large', label: 'Large' },
      ],
    },
  ],
  textAttributes: [{ id: 'product-name', label: 'Product name' }],
  safetySymbols: [{ id: 'w001', label: 'General warning' }],
});

const charging = Module.parse({
  schemaVersion: 1,
  id: 'charging',
  meta: {
    title: 'Charging the battery',
    type: 'procedure',
    lang: 'en',
    audience: 'public',
  },
  blocks: [
    {
      type: 'paragraph',
      id: 'intro',
      content: [
        text('The '),
        { type: 'attribute', name: 'product-name' },
        text(' charges itself. Press '),
        { type: 'kbd', keys: ['Ctrl', 'S'] },
        text(', tap '),
        { type: 'text', text: 'Park', marks: [{ type: 'ui' }] },
        text(', see '),
        { type: 'xref', module: 'basics', block: 'lights' },
        text(' or '),
        {
          type: 'text',
          text: 'the website',
          marks: [
            { type: 'link', href: 'https://example.com' },
            { type: 'strong' },
          ],
        },
        text('.'),
        { type: 'hardBreak' },
        { type: 'text', text: 'H', marks: [{ type: 'code' }] },
        { type: 'text', text: '2', marks: [{ type: 'code' }, { type: 'sub' }] },
      ],
    },
    {
      type: 'safety',
      id: 'hot',
      severity: 'warning',
      hazard: [text('Hot surface')],
      symbols: ['w001'],
      blocks: [para('hot-p', 'Let it cool down.')],
    },
    {
      type: 'procedure',
      id: 'steps',
      title: [text('Charge manually')],
      steps: [
        { id: 's1', content: [text('Park the vehicle.')], blocks: [] },
        {
          id: 's2',
          content: [text('Connect the cable.')],
          blocks: [
            {
              type: 'list',
              id: 'l',
              ordered: false,
              items: [{ id: 'l1', content: [text('Red to +')], blocks: [] }],
            },
          ],
        },
      ],
    },
    {
      type: 'variant',
      id: 'v',
      when: { op: 'in', attr: 'model', values: ['large'] },
      blocks: [
        para('large-only', 'Large models also show the charge in the app.'),
      ],
    },
    {
      type: 'table',
      id: 't',
      title: [text('Status lights')],
      header: true,
      columns: [{ width: 1 }, { width: 3, align: 'left' }],
      rows: [
        {
          cells: [
            { blocks: [para('h1', 'Light')] },
            { blocks: [para('h2', 'Meaning')] },
          ],
        },
        {
          cells: [
            { blocks: [para('r1', 'Green')] },
            { rowspan: 2, blocks: [para('r1b', 'Ready')] },
          ],
        },
        { cells: [{ blocks: [para('r2', 'Blue')] }] },
        { cells: [{ colspan: 2, blocks: [para('r3', 'Off: no power')] }] },
      ],
    },
    {
      type: 'admonition',
      id: 'n',
      kind: 'tip',
      blocks: [para('n1', 'Charge overnight.')],
    },
    {
      type: 'literal',
      id: 'code',
      language: 'sh',
      text: 'echo "hi" # not a heading\n]',
    },
    { type: 'passthrough', id: 'raw', format: 'html', raw: '<b>legacy</b>' },
  ],
});

const basics = Module.parse({
  schemaVersion: 1,
  id: 'basics',
  meta: { title: 'Basics', type: 'concept', lang: 'en', audience: 'public' },
  blocks: [
    {
      type: 'section',
      id: 'lights',
      title: [text('Status lights')],
      blocks: [
        para('p', 'They blink.'),
        { type: 'moduleRef', id: 'ref', module: 'charging-note' },
      ],
    },
  ],
});
const note = Module.parse({
  schemaVersion: 1,
  id: 'charging-note',
  meta: { title: 'Note', type: 'concept', lang: 'en' },
  blocks: [para('only', 'Inlined from another module.')],
});

const manifest = Manifest.parse({
  schemaVersion: 1,
  id: 'manual',
  title: 'Operating manual',
  variants: [{ model: 'small' }, { model: 'large' }],
  attributes: {
    'product-name': [
      {
        value: 'Model A',
        when: { op: 'in', attr: 'model', values: ['large'] },
      },
      { value: 'Model B' },
    ],
  },
  entries: [
    { title: 'Getting started', entries: [{ module: 'basics' }] },
    { module: 'charging' },
  ],
});

const modules: Record<string, Module> = {
  charging,
  basics,
  'charging-note': note,
};
const resolve = (model: string, lang = 'en'): ResolvedManual => {
  const { manual, issues } = resolveManual({
    manifest,
    variant: { model },
    lang,
    config,
    loadModule: (id, l) => (l === 'en' ? modules[id] : undefined),
  });
  expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  return manual;
};

// A 1×1 transparent PNG, standing in for real images and symbols.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const isPdf = (pdf: Buffer) => pdf.subarray(0, 5).toString() === '%PDF-';
/** The number of pages, from the page objects' `/Type /Page` entries. */
const pageCount = (pdf: Buffer) =>
  (pdf.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;

/**
 * A table past the column cap (#686), its columns behind a proxy counting how many are read:
 * laying out its grid starts with them, walking its blocks never reads one.
 */
function countingWideTable(): { table: Table; reads: () => number } {
  const columns = Array.from({ length: MAX_TABLE_COLUMNS + 1 }, () => ({
    width: 1,
  }));
  let reads = 0;
  const counted = new Proxy(columns, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  return {
    table: {
      type: 'table',
      id: 'wide',
      columns: counted,
      header: false,
      rows: Array.from({ length: 3 }, () => ({
        cells: columns.map(() => ({ blocks: [] })),
      })),
    },
    reads: () => reads,
  };
}

describe('a table past the caps (#686)', () => {
  it('is refused before its grid is written for Typst to lay out', () => {
    const { table, reads } = countingWideTable();
    const manual: ResolvedManual = {
      ...resolve('large'),
      entries: [
        {
          kind: 'module',
          module: 'wide',
          title: 'Wide',
          lang: 'en',
          blocks: [table],
        },
      ],
    };
    expect(() => renderTypst(manual)).toThrow(TableTooLargeError);
    expect(reads()).toBe(0);
  });
});

describe('renderTypst', () => {
  it('renders a manual that compiles to PDF', () => {
    const { source, symbols } = renderTypst(resolve('large'), {
      symbolPath: (s) => `symbols/${s}.png`,
      subtitle: 'Large',
    });
    expect(source).toContain('#heading(level: 1, "Getting started")');
    expect(source).toContain('#"The Model A charges itself. Press "');
    expect(source).toContain('#xref("basics--lights")[#"Status lights"]');
    expect(source).toContain('#anchor("basics--lights")');
    expect(source).toContain('Large models also show the charge in the app.');
    expect(symbols).toEqual(['symbols/w001.png']);
    expect(
      isPdf(compilePdf({ source, files: { 'symbols/w001.png': PNG } })),
    ).toBe(true);
  });

  it('leaves out blocks of other variants and fills in their values', () => {
    const { source } = renderTypst(resolve('small'));
    expect(source).toContain('The Model B charges itself.');
    expect(source).not.toContain('Large models');
    expect(isPdf(compilePdf({ source }))).toBe(true);
  });

  it('switches the language for modules that fell back to the source language', () => {
    const { manual } = resolveManual({
      manifest,
      variant: { model: 'small' },
      lang: 'de',
      config,
      loadModule: (id, l) => (l === 'en' ? modules[id] : undefined),
    });
    const { source } = renderTypst(manual);
    expect(source).toContain('lang: "de"');
    expect(source).toContain('#set text(lang: "en", region: none, dir: ltr)');
    expect(isPdf(compilePdf({ source }))).toBe(true);
  });

  it('prints the fixed labels in the manual language', () => {
    const { manual } = resolveManual({
      manifest,
      variant: { model: 'small' },
      lang: 'de',
      config,
      loadModule: (id, l) => (l === 'en' ? modules[id] : undefined),
    });
    const { source } = renderTypst(manual);
    expect(source).toContain(
      '#state("openfolia-labels", (:)).update((danger: "GEFAHR"',
    );
    expect(source).toContain('warning: "WARNUNG"');
    expect(source).toContain('contents: "Inhalt"');
    expect(source).toContain('figure: "Abbildung", table: "Tabelle"');
    expect(
      isPdf(compilePdf({ source, files: { 'symbols/w001.png': PNG } })),
    ).toBe(true);
  });

  it('takes labels from the configuration and falls back to English', () => {
    const manual = { ...resolve('small'), lang: 'nl' };
    const { source } = renderTypst(manual, {
      outputLabels: { nl: { danger: 'GE"VAAR"); #panic("x")' } },
    });
    expect(source).toContain('danger: "GE\\"VAAR\\"); #panic(\\"x\\")"');
    expect(source).toContain('warning: "WARNING"');
    expect(isPdf(compilePdf({ source }))).toBe(true);
  });

  it('includes images and reports the assets it needs', () => {
    const asset = `sha256:${'a'.repeat(64)}`;
    const manual = resolve('small');
    const withImage: ResolvedManual = {
      ...manual,
      entries: [
        {
          kind: 'module',
          module: 'img',
          title: 'Image',
          lang: 'en',
          blocks: [
            {
              type: 'image',
              id: 'img--i',
              asset,
              alt: 'A charger',
              title: [text('The charger')],
              width: 50,
            },
          ],
        },
      ],
    };
    const { source, assets } = renderTypst(withImage);
    expect(assets).toEqual([asset]);
    expect(
      isPdf(
        compilePdf({ source, files: { [`assets/${'a'.repeat(64)}`]: PNG } }),
      ),
    ).toBe(true);
  });

  it('prints a step’s image indented under its step, the numbering going on, the text kept with it', () => {
    const asset = `sha256:${'a'.repeat(64)}`;
    const manual = resolve('small');
    const withStepImage: ResolvedManual = {
      ...manual,
      entries: [
        {
          kind: 'module',
          module: 'img',
          title: 'Image',
          lang: 'en',
          blocks: [
            {
              type: 'procedure',
              id: 'img--p',
              steps: [
                {
                  id: 'img--s1',
                  content: [text('Open the cover.')],
                  blocks: [
                    {
                      type: 'image',
                      id: 'img--i',
                      asset,
                      alt: 'The open cover',
                      width: 50,
                    },
                  ],
                },
                { id: 'img--s2', content: [text('Plug in.')], blocks: [] },
              ],
            },
          ],
        },
      ],
    };
    const { source, assets } = renderTypst(withStepImage);
    expect(assets).toEqual([asset]);
    // One procedure, two steps: the image is in the first step's body, after its sticky text.
    const procedure = source.slice(source.indexOf('#procedure('));
    expect(procedure).toMatch(
      /^#procedure\(\n {2}\[#block\(sticky: true\)\[[^\]]*Open the cover\.[^\]]*\]\n\n#image\([^)]*width: 50%\)\],\n {2}\[[^\]]*Plug in\./,
    );
    expect(
      isPdf(
        compilePdf({ source, files: { [`assets/${'a'.repeat(64)}`]: PNG } }),
      ),
    ).toBe(true);
  });

  it('prints an attachment with its facts and a note, and needs no file for it', () => {
    const manual = resolve('small');
    const withAttachment: ResolvedManual = {
      ...manual,
      lang: 'de',
      entries: [
        {
          kind: 'module',
          module: 'files',
          title: 'Dateien',
          lang: 'de',
          blocks: [
            {
              type: 'attachment',
              id: 'files--cfg',
              asset: `sha256:${'b'.repeat(64)}`,
              name: 'Konfiguration',
              description: 'Die Einstellungen als ZIP.',
              fileName: 'config.zip',
              mediaType: 'application/zip',
              size: 12_345_678,
            },
            {
              type: 'attachment',
              id: 'files--log',
              asset: `sha256:${'d'.repeat(64)}`,
              name: 'Protokoll',
              description: '',
              fileName: 'log.txt',
              mediaType: 'text/plain',
              size: 10,
            },
          ],
        },
      ],
    };
    const { source, assets } = renderTypst(withAttachment);
    expect(source).toMatch(/name: "Protokoll", [^\n]*, description: none\)/);
    expect(assets).toEqual([]);
    expect(source).toContain(
      '#attachment(name: "Konfiguration", file-name: "config.zip", media-type: "application/zip", size: "12,3 MB", description: "Die Einstellungen als ZIP.")',
    );
    expect(source).toContain('attachment: "Anhang"');
    expect(source).toContain('"Die Einstellungen als ZIP."');
    expect(source).toContain('zum Herunterladen bereit.');
    expect(isPdf(compilePdf({ source }))).toBe(true);
    // A template written before attachment() was part of the contract gets the built-in box.
    const before = DEFAULT_TEMPLATE.replace(/#let attachment\(.*?\n\]\n/s, '');
    expect(before).not.toContain('#let attachment');
    expect(isPdf(compilePdf({ source, template: before }))).toBe(true);
  });

  it('prints an FAQ entry as its question in bold, then its answer, under PDF/UA-1', () => {
    const manual = resolve('small');
    const withFaq: ResolvedManual = {
      ...manual,
      entries: [
        {
          kind: 'module',
          module: 'faq',
          title: 'Questions',
          lang: 'en',
          blocks: [
            {
              type: 'faq',
              id: 'faq--overnight',
              question: [
                text('Can I charge '),
                {
                  type: 'text',
                  text: 'overnight',
                  marks: [{ type: 'emphasis' }],
                },
                text('?'),
              ],
              blocks: [
                para('faq--a', 'Yes: the charger stops when full.'),
                {
                  type: 'list',
                  id: 'faq--l',
                  ordered: false,
                  items: [
                    {
                      id: 'faq--i',
                      content: [text('Keep it ventilated.')],
                      blocks: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const { source } = renderTypst(withFaq);
    expect(source).toContain(
      '#faq(question: [#"Can I charge "#emph[#"overnight"]#"?"])[',
    );
    expect(source).toContain('#"Yes: the charger stops when full."');
    const pdf = compilePdf({ source }).toString('latin1');
    expect(pdf).toContain('<pdfuaid:part>1</pdfuaid:part>');
    // A template written before faq() was part of the contract gets the built-in one.
    const before = DEFAULT_TEMPLATE.replace(/#let faq\(.*?\n\]\n/s, '');
    expect(before).not.toContain('#let faq');
    expect(isPdf(compilePdf({ source, template: before }))).toBe(true);
  });

  it(
    'breaks the page at a page break, never into an empty page, and only where a page can break',
    { timeout: 60_000 },
    () => {
      const manual = resolve('small');
      const pageBreak = (id: string) => ({ type: 'pageBreak' as const, id });
      const withBreaks = (blocks: Block[]): ResolvedManual => ({
        ...manual,
        entries: [
          { kind: 'module', module: 'm', title: 'Breaks', lang: 'en', blocks },
        ],
      });
      const pages = (m: ResolvedManual) =>
        pageCount(compilePdf({ source: renderTypst(m).source }));

      const none = withBreaks([para('m--a', 'One.'), para('m--b', 'Two.')]);
      const one = withBreaks([
        para('m--a', 'One.'),
        pageBreak('m--x'),
        pageBreak('m--y'),
        para('m--b', 'Two.'),
        pageBreak('m--z'),
      ]);
      const { source } = renderTypst(one);
      expect(source).toContain('#pagebreak(weak: true)');
      expect(pages(one)).toBe(pages(none) + 1);

      // In a module that fell back to another language (its own `#[…]` block), and in a section.
      const fallback: ResolvedManual = {
        ...one,
        lang: 'de',
        entries: [
          {
            kind: 'module',
            module: 'm',
            title: 'Breaks',
            lang: 'en',
            blocks: [
              para('m--a', 'One.'),
              pageBreak('m--x'),
              {
                type: 'section',
                id: 'm--s',
                title: [text('Section')],
                blocks: [
                  para('m--b', 'Two.'),
                  pageBreak('m--y'),
                  para('m--c', 'Three.'),
                ],
              },
            ],
          },
        ],
      };
      expect(pages(fallback)).toBe(pages(none) + 2);

      // Brought into a notice by a module reference: left out, so the PDF still compiles.
      const inNote = withBreaks([
        {
          type: 'admonition',
          id: 'm--n',
          kind: 'note',
          blocks: [
            para('m--a', 'One.'),
            pageBreak('m--x'),
            para('m--b', 'Two.'),
          ],
        },
      ]);
      expect(renderTypst(inNote).source).not.toContain('#pagebreak');
      expect(isPdf(compilePdf({ source: renderTypst(inNote).source }))).toBe(
        true,
      );

      // A link to a page break still finds its anchor, where it breaks and where it is left out.
      const linked = withBreaks([
        {
          type: 'paragraph',
          id: 'm--link',
          content: [
            { type: 'xref', module: 'm', block: 'x' },
            { type: 'xref', module: 'm', block: 'in' },
          ],
        },
        pageBreak('m--x'),
        {
          type: 'admonition',
          id: 'm--n',
          kind: 'note',
          blocks: [para('m--a', 'One.'), pageBreak('m--in')],
        },
      ]);
      const anchored = {
        ...linked,
        anchors: { 'm#x': 'm--x', 'm#in': 'm--in' },
      };
      expect(renderTypst(anchored).source).toContain(
        '#anchor("m--x")#pagebreak(weak: true)',
      );
      expect(isPdf(compilePdf({ source: renderTypst(anchored).source }))).toBe(
        true,
      );

      // A section a module reference brought into a notice: its page break is left out too.
      const sectionInNote = withBreaks([
        {
          type: 'admonition',
          id: 'm--n',
          kind: 'note',
          blocks: [
            {
              type: 'section',
              id: 'm--s',
              title: [text('Inner')],
              blocks: [para('m--a', 'One.'), pageBreak('m--x')],
            },
          ],
        },
      ]);
      expect(renderTypst(sectionInNote).source).not.toContain('#pagebreak');
      expect(
        isPdf(compilePdf({ source: renderTypst(sectionInNote).source })),
      ).toBe(true);
    },
  );

  it('cannot be broken or scripted through content', () => {
    const hostile = [
      '#import "/etc/passwd"',
      ']] #panic("x") [[',
      '"); #panic("x"); ("',
      '\\"; #panic("x") //',
      '/* unterminated',
      '$ math $ `raw` <label> @ref * _ = - + / ~',
      'tab\tbell\u0007 null\u0000 line sep',
    ].join(' ');
    const manual: ResolvedManual = {
      id: 'm',
      title: hostile,
      lang: 'en',
      variant: {},
      origins: {},
      anchors: {},
      entries: [
        {
          kind: 'module',
          module: 'x',
          title: hostile,
          lang: 'en',
          blocks: [
            {
              type: 'paragraph',
              id: 'x--p',
              content: [text(hostile), { type: 'kbd', keys: [hostile] }],
            },
            { type: 'literal', id: 'x--l', text: hostile },
            { type: 'passthrough', id: 'x--r', format: 'html', raw: hostile },
            {
              type: 'attachment',
              id: 'x--a',
              asset: `sha256:${'c'.repeat(64)}`,
              name: hostile,
              description: hostile,
              fileName: hostile,
              mediaType: hostile,
              size: 1,
            },
          ],
        },
      ],
    };
    const { source } = renderTypst(manual, { subtitle: hostile });
    expect(isPdf(compilePdf({ source, standard: 'none' }))).toBe(true);
    // PDF/UA-1 refuses the control characters (no font shows them): a refusal, never a script.
    expect(() => compilePdf({ source })).toThrow(TypstAccessibilityError);
  });

  it('links only an absolute http, https or mailto address, keeping the text of any other', () => {
    const linked = (href: string) =>
      renderTypst({
        id: 'm',
        title: 'M',
        lang: 'en',
        variant: {},
        origins: {},
        anchors: {},
        entries: [
          {
            kind: 'module',
            module: 'x',
            title: 'X',
            lang: 'en',
            blocks: [
              {
                type: 'paragraph',
                id: 'x--p',
                content: [
                  { type: 'text', text: 'go', marks: [{ type: 'link', href }] },
                ],
              },
            ],
          },
        ],
      }).source;
    expect(linked('https://example.com/a')).toContain(
      '#link("https://example.com/a")[#"go"]',
    );
    expect(linked('mailto:a@example.com')).toContain(
      '#link("mailto:a@example.com")[#"go"]',
    );
    for (const href of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      '/relative',
      'data:,x',
    ]) {
      const source = linked(href);
      expect(source, href).not.toContain('#link(');
      expect(source, href).toContain('#[#"go"]');
    }
    expect(isPdf(compilePdf({ source: linked('javascript:alert(1)') }))).toBe(
      true,
    );
  });

  it('rejects unresolved manuals', () => {
    const manual = resolve('small');
    const broken: ResolvedManual = {
      ...manual,
      entries: [
        {
          kind: 'module',
          module: 'x',
          title: 'X',
          lang: 'en',
          blocks: [{ type: 'moduleRef', id: 'r', module: 'y' }],
        },
      ],
    };
    expect(() => renderTypst(broken)).toThrow(/expects a resolved manual/);
  });
});

describe('str', () => {
  it('escapes quotes, backslashes and control characters', () => {
    expect(str('a"b\\c\nd\u0001')).toBe('"a\\"b\\\\c\\nd\\u{1}"');
  });
});

describe('compilePdf', () => {
  it(
    'gives the same bytes at another time for the same input and creation timestamp',
    { timeout: 60_000 },
    async () => {
      // A template may date its document (`date: auto`): the timestamp is that date.
      const source = `${renderTypst(resolve('small')).source}\n#set document(date: auto)`;
      // 2024-01-01T00:00:00Z
      const input = { source, creationTimestamp: 1_704_067_200 };
      const first = compilePdf(input);
      // Into the next second: the time of rendering differs.
      await new Promise((done) => setTimeout(done, 1_100));
      const second = await compilePdfInWorker(input);
      expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
      expect(Buffer.from(first).toString('latin1')).toContain('D:20240101');
      expect(() => compilePdf({ source, creationTimestamp: 1.5 })).toThrow(
        RangeError,
      );
    },
  );

  it(
    'compiles in a worker process, with a timeout',
    { timeout: 60_000 },
    async () => {
      const { source } = renderTypst(resolve('small'));
      const pdf = await compilePdfInWorker({ source });
      expect(isPdf(pdf)).toBe(true);
      await expect(
        compilePdfInWorker({ source: '#nope()' }),
      ).rejects.toBeInstanceOf(TypstCompileError);
      // Misses a 50 ms deadline; the follow-up jobs below may wait for the killed worker to exit.
      const slow =
        '#for i in range(1500) { for j in range(1500) { let x = i * j } }';
      await expect(
        compilePdfInWorker({ source: slow }, { timeoutMs: 50 }),
      ).rejects.toBeInstanceOf(TypstTimeoutError);
      // The pool recovers after a timeout and runs jobs concurrently.
      const many = await Promise.all(
        Array.from({ length: 4 }, () => compilePdfInWorker({ source })),
      );
      expect(many.every(isPdf)).toBe(true);
      await expect(
        compilePdfInWorker({ source, files: { '../x': new Uint8Array() } }),
      ).rejects.toThrow(/invalid file path/);
    },
  );

  it('uses the module title for module links and section titles for section links', () => {
    const manual = resolve('small');
    const { source } = renderTypst({
      ...manual,
      entries: [
        {
          kind: 'module',
          module: 'a',
          title: 'Module A',
          lang: 'en',
          blocks: [
            {
              type: 'section',
              id: 'a--s',
              title: [text('First section')],
              blocks: [
                {
                  type: 'paragraph',
                  id: 'a--p',
                  content: [
                    { type: 'xref', module: 'a' },
                    text(' / '),
                    { type: 'xref', module: 'a', block: 's' },
                  ],
                },
              ],
            },
          ],
        },
      ],
      anchors: { a: 'a--s', 'a#s': 'a--s', 'a#p': 'a--p' },
    });
    expect(source).toContain('#xref("a--s")[#"Module A"]');
    expect(source).toContain('#xref("a--s")[#"First section"]');
  });

  it('names a module that is no entry by the title the resolution gives, else by its ID (#796)', () => {
    const manual = resolve('small');
    const linking = (xrefTitles?: Record<string, string>) =>
      renderTypst({
        ...manual,
        entries: [
          {
            kind: 'module',
            module: 'a',
            title: 'Module A',
            lang: 'en',
            blocks: [
              {
                type: 'paragraph',
                id: 'a--p',
                content: [
                  { type: 'xref', module: 'elsewhere' },
                  text(' / '),
                  { type: 'xref', module: 'constructor' },
                ],
              },
            ],
          },
        ],
        anchors: { a: 'a--p', 'a#p': 'a--p' },
        ...(xrefTitles ? { xrefTitles } : {}),
      }).source;
    const titled = linking({ elsewhere: 'Tyre pressures' });
    expect(titled).toContain('#xref(none)[#"Tyre pressures"]');
    // Only the manual's own titles count, not a property every object has.
    expect(titled).toContain('#xref(none)[#"constructor"]');
    expect(linking()).toContain('#xref(none)[#"elsewhere"]');
  });

  it('keeps the template contract and sets regions separately', () => {
    const { source } = renderTypst({ ...resolve('small'), lang: 'pt-BR' });
    expect(source).toContain(
      '#show: manual.with(title: "Operating manual", subtitle: "", lang: "pt")',
    );
    // Before the template (title page, contents) and after it (body).
    expect(
      source.split('#set text(lang: "pt", region: "BR", dir: ltr)').length - 1,
    ).toBe(2);
    expect(DEFAULT_TEMPLATE).toContain(
      '#let manual(title: none, subtitle: none, lang: "en", body)',
    );
    expect(isPdf(compilePdf({ source }))).toBe(true);
  });

  it('passes language and region of a fallback language to Typst', () => {
    const manual = resolve('small');
    const { source } = renderTypst({
      ...manual,
      lang: 'de',
      entries: [
        { kind: 'module', module: 'x', title: 'X', lang: 'pt-BR', blocks: [] },
      ],
    });
    expect(source).toContain('#set text(lang: "pt", region: "BR", dir: ltr)');
    expect(isPdf(compilePdf({ source }))).toBe(true);
  });

  it('refuses workspaces others could write to', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openfolia-ws-test-'));
    try {
      writeFileSync(join(dir, 'planted.txt'), 'x');
      expect(() => assertSafeWorkspace(dir)).toThrow(/not empty/);
      rmSync(join(dir, 'planted.txt'));
      // Windows has no POSIX modes; the mode check applies elsewhere.
      if (process.platform !== 'win32') {
        chmodSync(dir, 0o777);
        expect(() => assertSafeWorkspace(dir)).toThrow(
          /accessible to other users/,
        );
      }
      chmodSync(dir, 0o700);
      expect(() => assertSafeWorkspace(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cannot read files from the host', () => {
    for (const path of ['/etc/hosts', '../../../../../../../../etc/hosts']) {
      expect(() => compilePdf({ source: `#read(${str(path)})` })).toThrow(
        TypstCompileError,
      );
    }
    expect(() => compilePdf({ source: '', files: { '../x': PNG } })).toThrow(
      /invalid file path/,
    );
  });

  it('reports Typst errors', () => {
    expect(() =>
      compilePdf({ source: '#import "template.typ": *\n#nope()' }),
    ).toThrow(TypstCompileError);
  });
});

describe('the default design', () => {
  /** The fonts a PDF embeds, by name (subset prefix removed). */
  const fonts = (pdf: Buffer) =>
    new Set(
      [
        ...pdf
          .toString('latin1')
          .matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/g),
      ].map((m) => m[1] as string),
    );
  const manualWith = (
    blocks: ResolvedManual['entries'][number],
  ): ResolvedManual => ({
    ...resolve('large'),
    entries: [...resolve('large').entries, blocks],
  });

  it("embeds the theme's fonts, Geist and Geist Mono, and no other", () => {
    const manual = manualWith({
      kind: 'module',
      module: 'code',
      title: 'Code',
      lang: 'en',
      blocks: [
        {
          type: 'paragraph',
          id: 'code--p',
          content: [
            text('Run '),
            {
              type: 'text',
              text: 'openfolia check',
              marks: [{ type: 'code' }],
            },
          ],
        },
        {
          type: 'literal',
          id: 'code--l',
          language: 'sh',
          text: 'openfolia check --all',
        },
      ],
    });
    const { source } = renderTypst(manual, {
      symbolPath: (s) => `symbols/${s}.png`,
    });
    const used = fonts(
      compilePdf({ source, files: { 'symbols/w001.png': PNG } }),
    );
    expect([...used].some((f) => f.startsWith('Geist-'))).toBe(true);
    expect([...used].some((f) => f.startsWith('GeistMono-'))).toBe(true);
    expect([...used].filter((f) => !/^Geist(Mono)?-/.test(f))).toEqual([]);
  });

  it('keeps a symbol without artwork in place, as the neutral sign the compiler has', () => {
    const { source, symbols } = renderTypst(resolve('large'));
    expect(source).toContain('symbols: ("openfolia/missing-symbol.svg",)');
    expect(symbols).toEqual([]);
    expect(isPdf(compilePdf({ source }))).toBe(true);
    // A template written for paths only (the contract before) still works.
    const pathsOnly = DEFAULT_TEMPLATE.replace(
      '..symbols.map(s => image(s, width: 3em))',
      '..symbols.map(s => image(s, width: 1cm))',
    );
    expect(pathsOnly).not.toBe(DEFAULT_TEMPLATE);
    expect(isPdf(compilePdf({ source, template: pathsOnly }))).toBe(true);
  });

  it(
    "embeds the theme's fonts on the worker path too",
    { timeout: 60_000 },
    async () => {
      const { source } = renderTypst(resolve('large'));
      const used = fonts(await compilePdfInWorker({ source }));
      expect([...used].some((f) => f.startsWith('Geist-'))).toBe(true);
      expect([...used].filter((f) => !/^Geist(Mono)?-/.test(f))).toEqual([]);
    },
  );

  it('gives the title page the language, variant, release and date, as strings', () => {
    const { source } = renderTypst(
      { ...resolve('small'), lang: 'de' },
      {
        subtitle: 'Small',
        release: 'v1"); #panic("x',
        date: '18. November 2026',
      },
    );
    expect(source).toContain(
      '#state("openfolia-document", (:)).update((language: "Deutsch", variant: "Small", release: "v1\\"); #panic(\\"x", date: "18. November 2026"))',
    );
    expect(isPdf(compilePdf({ source }))).toBe(true);
    const { source: bare } = renderTypst(resolve('small'));
    expect(bare).toContain(
      '(language: "English", variant: none, release: none, date: none)',
    );
  });

  it('names a language it does not know by its tag', () => {
    const { source } = renderTypst({ ...resolve('small'), lang: 'x-klingon' });
    expect(source).toContain('(language: "x-klingon",');
  });

  it("keeps the compiler's own files from being replaced", () => {
    for (const path of [
      'tokens.typ',
      'template.typ',
      './main.typ',
      'openfolia/missing-symbol.svg',
      'openfolia/other.svg',
    ]) {
      expect(() => compilePdf({ source: '', files: { [path]: PNG } })).toThrow(
        /reserved/,
      );
    }
  });

  it('styles header tables, labelled, nested or with a taller header, and wraps code', () => {
    const source = [
      '#import "template.typ": *',
      '#show: manual.with(title: "T", subtitle: "")',
      '= A',
      '#table(columns: 2, table.header([a], [b]), [c], [d]) <tab>',
      '#context locate(<tab>).page()',
      '#table(columns: 2, table.header(table.cell(rowspan: 2)[a], [b], [b2], table.hline()), [c], [d])',
      '#table(columns: 2, table.header([a], [b]), table(columns: 1, [x], [y]), [d])',
      '#table(columns: 2, table.header(repeat: false, [a], table.vline(), [b]), [c], [d])',
      `Run #code-span[${'x '.repeat(80)}] here.`,
    ].join('\n');
    expect(isPdf(compilePdf({ source }))).toBe(true);
  });

  it("lets a custom template use the theme's tokens", () => {
    const { source } = renderTypst(resolve('small'));
    const template = DEFAULT_TEMPLATE.replace(
      '#let ui(body) = text(weight: 600, body)',
      '#let ui(body) = text(fill: theme.safety-notice, body)',
    );
    expect(template).not.toBe(DEFAULT_TEMPLATE);
    expect(isPdf(compilePdf({ source, template }))).toBe(true);
  });
});

describe('PDF/UA-1', () => {
  const asset = `sha256:${'a'.repeat(64)}`;
  const files = {
    'symbols/w001.png': PNG,
    [`assets/${'a'.repeat(64)}`]: PNG,
  };
  /** The test manual, its charging module ending with an image (alt text `alt`). */
  const withImage = (alt: string): ResolvedManual => {
    const manual = resolve('large');
    return {
      ...manual,
      entries: [
        ...manual.entries,
        {
          kind: 'module',
          module: 'img',
          title: 'Image',
          lang: 'en',
          blocks: [
            {
              type: 'section',
              id: 'img--s',
              title: [text('The charger')],
              blocks: [
                {
                  type: 'image',
                  id: 'img--i',
                  asset,
                  alt,
                  title: [text('Charger')],
                },
              ],
            },
          ],
        },
      ],
    };
  };
  const render = (manual: ResolvedManual) =>
    renderTypst(manual, { symbolPath: (s) => `symbols/${s}.png` }).source;

  it('tags the manual and declares PDF/UA-1: title, language, headings, figures, tables, lists, links, contents', () => {
    const source = render({
      ...withImage('A charger on the wall'),
      lang: 'de',
    });
    const pdf = compilePdf({ source, files }).toString('latin1');
    expect(pdf).toContain('<pdfuaid:part>1</pdfuaid:part>');
    expect(pdf).toMatch(/\/Type \/StructTreeRoot/);
    expect(pdf).toMatch(/\/Lang \(de\)/);
    expect(pdf).toContain('/Title (Operating manual)');
    expect(pdf).toMatch(/\/DisplayDocTitle true/);
    for (const tag of [
      'H1',
      'H2',
      'H3',
      'Figure',
      'Caption',
      'THead',
      'TH',
      'TD',
      'L',
      'LI',
      'Link',
      'TOC',
      'TOCI',
    ]) {
      expect(pdf, tag).toMatch(new RegExp(`/S /${tag}\\b`));
    }
    expect(pdf).toMatch(/\/S \/Figure[\s\S]*?\/Alt \(A charger on the wall\)/);
  });

  it('makes the same PDF every time: no date in its metadata', async () => {
    const source = render(withImage('A charger'));
    const first = compilePdf({ source, files });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = compilePdf({ source, files });
    expect(first.toString('latin1')).not.toMatch(/ModifyDate|CreationDate/);
    expect(second.equals(first)).toBe(true);
  });

  it('sets the title itself, for a template that does not', () => {
    const template = DEFAULT_TEMPLATE.replace(
      '  set document(title: title)\n',
      '',
    );
    expect(template).not.toBe(DEFAULT_TEMPLATE);
    const pdf = compilePdf({
      source: render(withImage('A charger')),
      files,
      template,
    });
    expect(pdf.toString('latin1')).toContain('/Title (Operating manual)');
  });

  it('refuses a document that cannot meet it, with the reasons', () => {
    const source = render(withImage(''));
    let error: unknown;
    try {
      compilePdf({ source, files });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TypstAccessibilityError);
    expect((error as TypstAccessibilityError).problems).toEqual([
      {
        message: 'PDF/UA-1 error: missing alt text',
        hints: ['make sure your images and equations have alt text'],
      },
    ]);
  });

  it('refuses a template whose decorative images are neither described nor artifacts, as one written before', () => {
    const before = DEFAULT_TEMPLATE.replace(
      '(pdf.artifact(stack(spacing: 0.5em, ..symbols.map(s => image(s, width: 3em)))),)',
      '(stack(spacing: 0.5em, ..symbols.map(s => image(s, width: 3em))),)',
    );
    expect(before).not.toBe(DEFAULT_TEMPLATE);
    const source = render(withImage('A charger'));
    expect(() => compilePdf({ source, files, template: before })).toThrow(
      TypstAccessibilityError,
    );
    expect(
      isPdf(compilePdf({ source, files, template: before, standard: 'none' })),
    ).toBe(true);
  });

  it('makes a plain PDF with pdf.standard none, refusing nothing', () => {
    const source = render(withImage(''));
    const pdf = compilePdf({ source, files, standard: 'none' });
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.toString('latin1')).not.toContain('pdfuaid');
  });

  it('reads the reasons from the compiler’s error text, and nothing else', () => {
    const refusal = new Error(
      '[SourceDiagnostic { severity: Error, span: Span(1), message: "PDF/UA-1 error: the text `\\"\\\\u{7}\\"` could not be displayed", trace: [], hints: ["one \\"hint\\"", "two"] }, ' +
        'SourceDiagnostic { severity: Error, span: Span(2), message: "PDF/UA-1 error: heading title is empty", trace: [], hints: [] }]',
    );
    expect(standardProblems(refusal)).toEqual([
      {
        message: 'PDF/UA-1 error: the text `"\\u{7}"` could not be displayed',
        hints: ['one "hint"', 'two'],
      },
      { message: 'PDF/UA-1 error: heading title is empty', hints: [] },
    ]);
    expect(standardProblems(new Error('out of memory'))).toBeUndefined();
    // Decided on the parsed messages only: the prefix quoted elsewhere is no refusal.
    expect(
      standardProblems(new Error('PDF/UA-1 error: garbled')),
    ).toBeUndefined();
    expect(
      standardProblems(
        new Error(
          '[SourceDiagnostic { message: "font failed: \\"PDF/UA-1 error: x\\"", hints: [] }]',
        ),
      ),
    ).toBeUndefined();
  });
});

afterAll(() => closeWorkerPool());

describe('empty table cells', () => {
  const tableModule = Module.parse({
    schemaVersion: 1,
    id: 'charging',
    meta: { title: 'Grid', type: 'concept', lang: 'en', audience: 'public' },
    blocks: [
      {
        type: 'table',
        id: 'filled',
        header: true,
        columns: [{ width: 1 }, { width: 1 }],
        rows: [
          { cells: [{ blocks: [para('h', 'Item')] }, { blocks: [] }] },
          { cells: [{ blocks: [para('a', 'Cable')] }, { blocks: [] }] },
        ],
      },
      {
        type: 'table',
        id: 'blank',
        header: false,
        columns: [{ width: 1 }, { width: 1 }],
        rows: [{ cells: [{ blocks: [] }, { blocks: [] }] }],
      },
    ],
  });

  it('render as empty cells, an empty column and an all-empty table included', () => {
    const { manual } = resolveManual({
      manifest: { ...manifest, entries: [{ module: 'charging' }] },
      variant: { model: 'small' },
      lang: 'en',
      config,
      loadModule: () => tableModule,
    });
    const { source } = renderTypst(manual);
    expect(source).toContain('Cable');
    expect(source).toMatch(/\[\s*\]/);
    expect(isPdf(compilePdf({ source }))).toBe(true);
  });
});
