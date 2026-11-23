import {
  Manifest,
  Module,
  ProjectConfig,
  resolveManual,
  type Block,
  type Inline,
  type ResolvedManual,
} from '@openfolia/content-model';
import { compilePdf } from './compile.js';
import { renderTypst } from './render.js';
import { DEFAULT_TEMPLATE } from './template.js';

// Right-to-left languages (#458): the direction from the configuration, the
// fonts for Arabic and Hebrew, mirrored tables, mixed-direction text.

const text = (
  t: string,
  marks?: Extract<Inline, { type: 'text' }>['marks'],
): Inline =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };
const para = (id: string, ...content: Inline[]): Block => ({
  type: 'paragraph',
  id,
  content,
});
const cell = (id: string, t: string) => ({ blocks: [para(id, text(t))] });

const config = (direction?: Record<string, 'ltr' | 'rtl'>) =>
  ProjectConfig.parse({
    languages: { source: 'en', targets: ['ar', 'he'], direction },
    moduleTypes: [{ id: 'concept', label: 'Concept' }],
    audiences: [{ id: 'public', label: 'Public' }],
    textAttributes: [{ id: 'product-name', label: 'Product name' }],
  });

/** A module in `lang`: a mixed-direction sentence, a list, a table with an aligned column. */
const display = (
  lang: string,
  title: string,
  sentence: [string, string, string],
  item: string,
  head: [string, string],
): Module =>
  Module.parse({
    schemaVersion: 1,
    id: 'display',
    meta: { title, type: 'concept', lang, audience: 'public', facets: {} },
    blocks: [
      para(
        'code',
        ...(sentence[0] ? [text(sentence[0])] : []),
        { type: 'attribute', name: 'product-name' },
        text(sentence[1]),
        text('E-104', [{ type: 'code' }]),
        text(sentence[2]),
      ),
      {
        type: 'list',
        id: 'items',
        ordered: false,
        items: [{ id: 'i1', content: [text(item)], blocks: [] }],
      },
      {
        type: 'table',
        id: 'codes',
        columns: [
          { width: 1, align: 'left' },
          { width: 3, align: 'right' },
        ],
        header: true,
        rows: [
          { cells: [cell('h1', head[0]), cell('h2', head[1])] },
          { cells: [cell('c1', 'E-104'), cell('c2', '230 V')] },
        ],
      },
      // Code that bidi would reorder in right-to-left text: punctuation at its ends.
      para('call', text(item), text('foo();', [{ type: 'code' }])),
      { type: 'literal', id: 'lit', text: 'a / b ();' },
    ],
  });

const modules: Record<string, Module> = {
  en: display(
    'en',
    'Display',
    ['The ', ' shows the code ', ' at 20 %.'],
    'Press the button.',
    ['Code', 'Meaning'],
  ),
  ar: display(
    'ar',
    'الشاشة',
    ['يعرض ', ' الرمز ', ' عند 20 %.'],
    'اضغط على الزر.',
    ['الرمز', 'المعنى'],
  ),
  he: display(
    'he',
    'תצוגה',
    ['', ' מציג את הקוד ', ' ב־20 %.'],
    'לחצו על הלחצן.',
    ['קוד', 'משמעות'],
  ),
};

const manifest = Manifest.parse({
  schemaVersion: 1,
  id: 'quick-start',
  title: 'Quick start',
  variants: [{}],
  attributes: { 'product-name': 'Model A' },
  entries: [{ module: 'display' }],
});

const resolve = (
  lang: string,
  options: { direction?: Record<string, 'ltr' | 'rtl'>; only?: string[] } = {},
): ResolvedManual => {
  const { manual, issues } = resolveManual({
    manifest,
    variant: {},
    lang,
    config: config(options.direction),
    loadModule: (id, l) =>
      id === 'display' && (options.only ?? Object.keys(modules)).includes(l)
        ? modules[l]
        : undefined,
  });
  expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  return manual;
};

/** The fonts a PDF embeds, by name (subset prefix removed). */
const fonts = (pdf: Buffer) =>
  new Set(
    [
      ...pdf
        .toString('latin1')
        .matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([\w-]+)/g),
    ].map((m) => m[1] as string),
  );

describe('right-to-left languages', () => {
  it.each([
    ['ar', 'NotoSansArabic-'],
    ['he', 'NotoSansHebrew-'],
  ])(
    'sets %s right to left and compiles it under PDF/UA-1, in its script’s font',
    { timeout: 60_000 },
    (lang, font) => {
      const { source } = renderTypst(resolve(lang));
      // Before the template and after it, as the language.
      expect(
        source.split(`#set text(lang: "${lang}", region: none, dir: rtl)`)
          .length - 1,
      ).toBe(2);
      const pdf = compilePdf({ source });
      expect(pdf.toString('latin1')).toMatch(new RegExp(`/Lang \\(${lang}\\)`));
      const used = [...fonts(pdf)];
      expect(used.some((f) => f.startsWith(font))).toBe(true);
      // The Latin product name, the numbers and the code keep the theme's fonts.
      expect(used.some((f) => f.startsWith('Geist-'))).toBe(true);
      expect(used.some((f) => f.startsWith('GeistMono-'))).toBe(true);
    },
  );

  it('takes the configured direction over the script’s', () => {
    const { source } = renderTypst(resolve('ar', { direction: { ar: 'ltr' } }));
    expect(source).toContain('#set text(lang: "ar", region: none, dir: ltr)');
    expect(source).not.toContain('dir: rtl');
  });

  it('sets a module that fell back to the source language left to right', () => {
    const { source } = renderTypst(resolve('ar', { only: ['en'] }));
    expect(source).toContain('#set text(lang: "ar", region: none, dir: rtl)');
    expect(source).toContain(
      '#[\n#set text(lang: "en", region: none, dir: ltr)',
    );
  });

  it('aligns a column’s left and right to the start and end of the text', () => {
    const { source } = renderTypst(resolve('ar'));
    expect(source).toContain('align: (start, end,)');
    expect(renderTypst(resolve('en')).source).toContain('align: (start, end,)');
  });

  it(
    'sets code left to right in right-to-left text, inline and as a block',
    { timeout: 60_000 },
    () => {
      const { source } = renderTypst(resolve('ar'));
      const rule = '#show raw: set text(dir: ltr)';
      expect(source).toContain(rule);
      // Every line of code is set left to right: the document fails to compile otherwise.
      const check =
        '#show raw.line: it => { context assert(text.dir == ltr, message: "code set right to left"); it }';
      expect(() =>
        compilePdf({ source: source.replace(rule, `${rule}\n${check}`) }),
      ).not.toThrow();
      // Without the rule (before the template's own `manual` rule as well, #396), it would not be.
      expect(() =>
        compilePdf({ source: source.replaceAll(rule, check) }),
      ).toThrow(/code set right to left/);
    },
  );

  it('keeps a key combination in its order in right-to-left text', () => {
    expect(DEFAULT_TEMPLATE).toContain('#let kbd(..keys) = box(text(dir: ltr,');
  });

  it('indents a glossary definition from the start of the line', () => {
    expect(DEFAULT_TEMPLATE).toContain(
      'pad(..if text.dir == rtl { (right: 1.2em) } else { (left: 1.2em) }, body)',
    );
  });
});
