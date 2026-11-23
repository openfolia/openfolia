import { readFileSync } from 'node:fs';
import { sampleConfig } from '../fixtures/config.js';
import { parseInline, printInline } from './asciidoc/inline.js';
import { ProjectConfig } from './config.js';
import type { Block } from './blocks.js';
import type { Inline } from './inline.js';
import { Manifest } from './manifest.js';
import { parseManifest, printManifest } from './manifest-yaml.js';
import { parseModule } from './asciidoc/parse.js';
import { printModule } from './asciidoc/print.js';
import {
  contrastRatio,
  DEFAULT_PAGE_DESIGN,
  designTemplatePath,
  pageDesignTemplateIssues,
  fontFormatOf,
  PageDesign,
  type PageDesignInput,
  pageDesignAssetIssues,
  pageDesignAssets,
  pageDesignShowsRelease,
  validatePageDesign,
} from './page-design.js';
import {
  PageDesignParseError,
  parsePageDesign,
  printPageDesign,
} from './page-design-yaml.js';
import {
  choosePageDesign,
  pageDesignIdFor,
  resolvePageDesign,
} from './page-design-resolve.js';
import { parseConfig, printConfig } from './config-yaml.js';
import { validateModule } from './validate.js';

/** Invented manufacturer details (#395), as the configuration holds them. */
const MANUFACTURER = {
  name: 'Example Works Ltd',
  address: ['1 Sample Street', '12345 Sample Town'],
  contact: 'info@example.com',
  website: 'https://example.com',
};

const config = ProjectConfig.parse({
  ...sampleConfig,
  textAttributes: [
    ...(sampleConfig.textAttributes ?? []),
    { id: 'product', label: 'Product' },
    { id: 'document-number', label: 'Document number' },
  ],
  manufacturer: MANUFACTURER,
});
/** The same configuration without manufacturer details. */
const { manufacturer: _none, ...withoutManufacturer } = config;
const noManufacturer = ProjectConfig.parse(withoutManufacturer);
const fixture = readFileSync(
  new URL('../fixtures/page-design.yaml', import.meta.url),
  'utf8',
);
const sample = () => parsePageDesign(fixture, { id: 'product-line' });

/** A design from the minimum a file needs, with `extra` on top. */
const design = (extra: Partial<PageDesignInput> = {}): PageDesign =>
  PageDesign.parse({
    schemaVersion: 1,
    id: 'plain',
    name: 'Plain',
    preset: 'classic',
    colours: { primary: '#1f4e79', accent: '#2563eb', text: '#1f2328' },
    ...extra,
  });

const manifest = Manifest.parse({
  schemaVersion: 1,
  id: 'operating',
  title: 'Operating manual',
  audience: 'customer',
  variants: [{ model: 'l-400', market: 'eu' }],
  attributes: {
    product: [
      { value: 'L-200', when: { op: 'in', attr: 'model', values: ['l-200'] } },
      { value: 'L-400' },
    ],
    'document-number': 'DOC-0042',
    'product-name': 'Lifter',
  },
  entries: [{ module: 'battery-charging' }],
});

const text = (nodes: readonly Inline[] | undefined) =>
  (nodes ?? [])
    .map((n) =>
      n.type === 'text'
        ? n.text
        : n.type === 'placeholder'
          ? `<${n.key}>`
          : `?${n.type}`,
    )
    .join('');

describe('placeholders in AsciiDoc', () => {
  it('round-trip as inline nodes', () => {
    const nodes = parseInline(
      'Page placeholder:page[] of placeholder:page-count[]',
    );
    expect(nodes).toEqual([
      { type: 'text', text: 'Page ' },
      { type: 'placeholder', key: 'page' },
      { type: 'text', text: ' of ' },
      { type: 'placeholder', key: 'page-count' },
    ]);
    expect(printInline(nodes, false)).toBe(
      'Page placeholder:page[] of placeholder:page-count[]',
    );
  });

  it('round-trip beside a callout reference, neither read as the other', () => {
    const source =
      'See callout:front-view#power-switch[] on placeholder:page[], not \\callout:x \\placeholder:y';
    const nodes = parseInline(source);
    expect(nodes).toEqual([
      { type: 'text', text: 'See ' },
      { type: 'calloutRef', block: 'front-view', callout: 'power-switch' },
      { type: 'text', text: ' on ' },
      { type: 'placeholder', key: 'page' },
      { type: 'text', text: ', not callout:x placeholder:y' },
    ]);
    expect(parseInline(printInline(nodes, false))).toEqual(nodes);
  });

  it('escapes the macro name in text, so text never reads as a placeholder', () => {
    const nodes: Inline[] = [{ type: 'text', text: 'placeholder:title[]' }];
    const printed = printInline(nodes, false);
    expect(printed).toBe('\\placeholder:title\\[\\]');
    expect(parseInline(printed)).toEqual(nodes);
  });

  it('reads text that only starts like one as text, as files written before placeholders hold it', () => {
    for (const text of [
      'placeholder:Title[]',
      'placeholder:title',
      'placeholder: none',
    ]) {
      const nodes = parseInline(text);
      expect(nodes).toEqual([{ type: 'text', text }]);
      // Printed escaped from then on, and read back alike.
      expect(parseInline(printInline(nodes, false))).toEqual(nodes);
    }
  });

  it('is a validation error in a module', () => {
    const module = parseModule(
      [
        '= Charging',
        ':schema-version: 1',
        ':module-type: procedure',
        ':lang: en',
        '',
        '[#p1]',
        'Release placeholder:release[]',
        '',
      ].join('\n'),
      { id: 'charging' },
    );
    expect(
      printModule(parseModule(printModule(module), { id: 'charging' })),
    ).toBe(printModule(module));
    expect(validateModule(module, config)).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'placeholder-in-module',
        at: 'p1',
      }),
    ]);
  });
});

describe('page design files', () => {
  it('read and print back byte for byte', () => {
    const parsed = sample();
    expect(printPageDesign(parsed)).toBe(fixture);
    expect(
      parsePageDesign(printPageDesign(parsed), { id: 'product-line' }),
    ).toEqual(parsed);
  });

  it('hold region text as blocks with placeholders, per language or for all', () => {
    const parsed = sample();
    expect(parsed.regions['footer']).toEqual([
      {
        type: 'paragraph',
        id: 'doc-number',
        content: [
          { type: 'placeholder', key: 'document-number' },
          { type: 'text', text: ' · ' },
          { type: 'placeholder', key: 'release' },
        ],
      },
    ]);
    const above = parsed.regions['above-title'] as Record<string, unknown>;
    expect(Object.keys(above)).toEqual(['de', 'en']);
  });

  it('fill in every default from a minimal file, and print them', () => {
    const minimal = [
      'schemaVersion: 1',
      'name: Plain',
      'preset: minimal',
      'colours:',
      '  primary: "#1F4E79"',
      '  accent: "#2563eb"',
      '  text: "#1f2328"',
      '',
    ].join('\n');
    const parsed = parsePageDesign(minimal, { id: 'plain' });
    expect(parsed.colours.primary).toBe('#1f4e79');
    expect(parsed.page).toEqual({
      size: 'a4',
      margins: { top: 26, right: 22, bottom: 24, left: 22 },
      doubleSided: false,
    });
    expect(parsed.safety.standard).toBe('ansi-z535');
    expect(parsed.footer.default.right).toEqual([
      { type: 'placeholder', key: 'page' },
    ]);
    const printed = printPageDesign(parsed);
    expect(printPageDesign(parsePageDesign(printed, { id: 'plain' }))).toBe(
      printed,
    );
  });

  it('name an own template by its folder (#396), print it after the preset, and refuse a path', () => {
    const file = [
      'schemaVersion: 1',
      'name: Own',
      'preset: classic',
      'template: house-style',
      'colours:',
      '  primary: "#1f4e79"',
      '  accent: "#2563eb"',
      '  text: "#1f2328"',
      '',
    ].join('\n');
    const parsed = parsePageDesign(file, { id: 'own' });
    expect(parsed.template).toBe('house-style');
    expect(designTemplatePath('house-style')).toBe(
      'templates/house-style/manual.typ',
    );
    const printed = printPageDesign(parsed);
    expect(printed).toContain('preset: classic\ntemplate: house-style\n');
    expect(printPageDesign(parsePageDesign(printed, { id: 'own' }))).toBe(
      printed,
    );
    // Without one, no key is printed.
    expect(
      printPageDesign(
        parsePageDesign(file.replace('template: house-style\n', ''), {
          id: 'own',
        }),
      ),
    ).not.toContain('template:');
    expect(pageDesignTemplateIssues(parsed, ['house-style'])).toEqual([]);
    expect(pageDesignTemplateIssues(parsed, ['other'])).toMatchObject([
      { severity: 'error', code: 'unknown-template', at: 'template' },
    ]);
    for (const bad of ['../etc', 'a/b', '/abs', 'House', 'x.typ', '']) {
      expect(() =>
        parsePageDesign(file.replace('house-style', JSON.stringify(bad)), {
          id: 'own',
        }),
      ).toThrow(PageDesignParseError);
    }
  });

  it('take A5 as a page size (#668), and print it back; refuse one not listed', () => {
    const a5 = [
      'schemaVersion: 1',
      'name: Leaflet',
      'preset: minimal',
      'page:',
      '  size: a5',
      'colours:',
      '  primary: "#1f4e79"',
      '  accent: "#2563eb"',
      '  text: "#1f2328"',
      '',
    ].join('\n');
    const parsed = parsePageDesign(a5, { id: 'leaflet' });
    expect(parsed.page.size).toBe('a5');
    expect(printPageDesign(parsed)).toContain('  size: a5\n');
    expect(() =>
      parsePageDesign(a5.replace('size: a5', 'size: a3'), { id: 'leaflet' }),
    ).toThrow(/page\.size/);
  });

  it('refuse what is no design', () => {
    expect(() => parsePageDesign('- a list', { id: 'x' })).toThrow(
      PageDesignParseError,
    );
    expect(() =>
      parsePageDesign(fixture.replace('name: Product line', 'name: ""'), {
        id: 'x',
      }),
    ).toThrow(/name/);
    expect(() =>
      parsePageDesign(`id: other\n${fixture}`, { id: 'product-line' }),
    ).toThrow(/names the design "other"/);
    expect(() =>
      parsePageDesign(fixture.replace('[#intro]', '[#intro'), {
        id: 'product-line',
      }),
    ).toThrow(/regions\.above-title\.de/);
    expect(() =>
      parsePageDesign(fixture.replace('"#b45309"', 'orange'), {
        id: 'product-line',
      }),
    ).toThrow(/colours\.accent/);
  });

  it('hold headings one level deep in a region (#393), and print them back', () => {
    const file = fixture.replace(
      '    [#doc-number]\n    placeholder:document-number[] · placeholder:release[]',
      '    [#contact]\n    == Contact\n\n    [#contact-text]\n    Version placeholder:product-version[]',
    );
    const parsed = parsePageDesign(file, { id: 'product-line' });
    expect(parsed.regions['footer']).toEqual([
      {
        type: 'section',
        id: 'contact',
        title: [{ type: 'text', text: 'Contact' }],
        blocks: [
          {
            type: 'paragraph',
            id: 'contact-text',
            content: [
              { type: 'text', text: 'Version ' },
              { type: 'placeholder', key: 'product-version' },
            ],
          },
        ],
      },
    ]);
    expect(
      parsePageDesign(printPageDesign(parsed), { id: 'product-line' }),
    ).toEqual(parsed);
  });

  it('refuse nested sections, page breaks, module references and cross-references in a region', () => {
    for (const body of [
      '== A section\n\n    [#inner]\n    === A subsection',
      '<<<',
      'module::other[]',
      'See xref:other.adoc[it].',
    ]) {
      const file = fixture.replace(
        '    [#doc-number]\n    placeholder:document-number[] · placeholder:release[]',
        `    [#bad]\n    ${body}`,
      );
      expect(() => parsePageDesign(file, { id: 'product-line' })).toThrow(
        PageDesignParseError,
      );
    }
  });
});

describe('the configuration and the manifest name designs', () => {
  it('a manifest names its design; it prints back', () => {
    const text = printManifest({ ...manifest, design: 'product-line' });
    expect(text).toContain('design: product-line');
    expect(parseManifest(text, { id: 'operating' }).design).toBe(
      'product-line',
    );
  });

  it('the configuration names the project default under pdf; it prints back', () => {
    const withDefault = ProjectConfig.parse({
      ...sampleConfig,
      pdf: { design: 'product-line' },
    });
    const printed = printConfig(withDefault);
    expect(printed).toContain('pdf:\n  design: product-line\n');
    expect(parseConfig(printed).pdf).toEqual({
      standard: 'ua-1',
      design: 'product-line',
    });
  });
});

describe('validatePageDesign', () => {
  const codes = (d: PageDesign) =>
    validatePageDesign(d, config).map((i) => i.code);

  it('finds nothing in the sample design or the built-in one', () => {
    expect(validatePageDesign(sample(), config)).toEqual([]);
    expect(validatePageDesign(DEFAULT_PAGE_DESIGN, config)).toEqual([]);
  });

  it('an unknown preset', () => {
    expect(validatePageDesign(design({ preset: 'poster' }), config)).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'unknown-preset',
        at: 'preset',
      }),
    ]);
  });

  it("a region the preset does not have (the back page's are every preset's)", () => {
    const blocks: Block[] = [
      { type: 'paragraph', id: 'p', content: [{ type: 'text', text: 'x' }] },
    ];
    expect(
      validatePageDesign(
        design({ preset: 'minimal', regions: { band: [...blocks] } }),
        config,
      ),
    ).toEqual([
      expect.objectContaining({ code: 'unknown-region', at: 'regions.band' }),
    ]);
    expect(
      codes(design({ preset: 'minimal', regions: { back: [...blocks] } })),
    ).toEqual([]);
  });

  it('an unknown placeholder, in a region and in a running header', () => {
    const d = design({
      regions: {
        footer: {
          en: [
            {
              type: 'paragraph',
              id: 'p',
              content: [{ type: 'placeholder', key: 'serial-number' }],
            },
          ],
        },
      },
      header: {
        default: { left: [{ type: 'placeholder', key: 'page-total' }] },
      },
    });
    expect(validatePageDesign(d, config)).toEqual([
      expect.objectContaining({
        code: 'unknown-placeholder',
        at: 'regions.footer.en',
        block: 'p',
      }),
      expect.objectContaining({
        code: 'unknown-placeholder',
        at: 'header.default.left',
      }),
    ]);
  });

  it("a language the configuration has not, and the region text's own rules", () => {
    const d = design({
      regions: {
        footer: {
          it: [
            {
              type: 'paragraph',
              id: 'p',
              content: [{ type: 'attribute', name: 'serial' }],
            },
          ],
        },
      },
    });
    expect(codes(d)).toEqual(['unknown-language', 'unknown-text-attribute']);
  });

  it("a region whose languages do not share block IDs, as a warning against the source's (#554)", () => {
    const p = (id: string): Block => ({
      type: 'paragraph',
      id,
      content: [{ type: 'text', text: id }],
    });
    const d = design({
      regions: {
        footer: {
          en: [p('a'), p('b')],
          de: [p('a'), p('c')],
          fr: [p('b'), p('a')],
        },
        'above-title': [p('x')],
      },
    });
    expect(validatePageDesign(d, config)).toEqual([
      {
        severity: 'warning',
        code: 'region-languages-differ',
        message:
          'the "de" text has blocks the "en" text has not (c) and lacks some it has (b)',
        at: 'regions.footer.de',
      },
    ]);
    // Without the source language's text, the first language's is compared with.
    const sourceless = design({
      regions: { footer: { de: [p('a')], fr: [p('a'), p('b')] } },
    });
    expect(validatePageDesign(sourceless, config)).toEqual([
      {
        severity: 'warning',
        code: 'region-languages-differ',
        message: 'the "fr" text has blocks the "de" text has not (b)',
        at: 'regions.footer.fr',
      },
    ]);
  });

  it('a colour below 4.5:1 against the page, as a warning', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21);
    expect(
      validatePageDesign(
        design({
          colours: { primary: '#1f4e79', accent: '#ffcc00', text: '#1f2328' },
        }),
        config,
      ),
    ).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'low-contrast',
        at: 'colours.accent',
      }),
    ]);
  });

  it('a cover image rule with an unknown condition, and an image-led design without one', () => {
    expect(
      codes(
        design({
          preset: 'image-led',
          coverImage: {
            variants: [
              {
                when: { op: 'in', attr: 'colour', values: ['red'] },
                asset: `sha256:${'a'.repeat(64)}`,
              },
            ],
          },
        }),
      ),
    ).toEqual(['unknown-variant-attribute']);
    expect(codes(design({ preset: 'image-led' }))).toEqual([
      'missing-cover-image',
    ]);
  });

  it('fonts whose licence nobody confirmed, and a back page while the configuration has no manufacturer (#395)', () => {
    const font = { family: 'Sample Sans', regular: `sha256:${'b'.repeat(64)}` };
    expect(codes(design({ fonts: { body: font } }))).toEqual([
      'fonts-not-confirmed',
    ]);
    expect(
      codes(design({ fonts: { body: font, embeddingAllowed: true } })),
    ).toEqual([]);
    expect(codes(design({ backPage: {} }))).toEqual([]);
    expect(
      validatePageDesign(design({ backPage: {} }), noManufacturer),
    ).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'missing-manufacturer',
        at: 'backPage',
      }),
    ]);
    // No back page: nothing to print the details on.
    expect(validatePageDesign(design(), noManufacturer)).toEqual([]);
  });

  it('knows the manufacturer placeholders on any page (#395)', () => {
    const name: Inline[] = [{ type: 'placeholder', key: 'manufacturer-name' }];
    expect(
      codes(
        design({
          header: { default: { left: name } },
          regions: {
            footer: [
              {
                type: 'paragraph',
                id: 'p',
                content: [
                  { type: 'placeholder', key: 'manufacturer-address' },
                  { type: 'placeholder', key: 'manufacturer-contact' },
                  { type: 'placeholder', key: 'manufacturer-website' },
                ],
              },
            ],
          },
        }),
      ),
    ).toEqual([]);
  });
});

describe('pageDesignAssetIssues', () => {
  const ttf = new Uint8Array([0, 1, 0, 0, 9]);
  const otf = new TextEncoder().encode('OTTO....');
  const woff2 = new TextEncoder().encode('wOF2....');
  const collection = new TextEncoder().encode('ttcf....');

  it('tells TrueType, OpenType, WOFF and WOFF2 from anything else', () => {
    expect(fontFormatOf(ttf)).toBe('ttf');
    expect(fontFormatOf(new TextEncoder().encode('true'))).toBe('ttf');
    expect(fontFormatOf(otf)).toBe('otf');
    expect(fontFormatOf(woff2)).toBe('woff2');
    expect(fontFormatOf(new TextEncoder().encode('wOFF'))).toBe('woff');
    expect(fontFormatOf(new TextEncoder().encode('ttcf'))).toBeUndefined();
    expect(fontFormatOf(new Uint8Array([0, 1]))).toBeUndefined();
  });

  it('a missing asset and a font file that is no TTF, OTF, WOFF or WOFF2', async () => {
    const [regular, bold, logo] = ['c', 'd', 'e'].map(
      (c) => `sha256:${c.repeat(64)}`,
    ) as [string, string, string];
    const d = design({
      logo: { light: logo },
      fonts: {
        body: { family: 'Sample Sans', regular, bold },
        heading: { family: 'Sample Sans', regular },
        embeddingAllowed: true,
      },
    });
    expect(pageDesignAssets(d).map((a) => a.path)).toEqual([
      'logo.light',
      'fonts.body.regular',
      'fonts.body.bold',
      'fonts.heading.regular',
    ]);
    const asked: string[] = [];
    const issues = await pageDesignAssetIssues(d, async (asset) => {
      asked.push(asset);
      if (asset === logo) return undefined;
      return { head: asset === bold ? collection : ttf };
    });
    expect(issues).toEqual([
      expect.objectContaining({ code: 'missing-asset', at: 'logo.light' }),
      expect.objectContaining({ code: 'invalid-font', at: 'fonts.body.bold' }),
    ]);
    // Each asset is asked for once, however often the design names it.
    expect(asked).toEqual([logo, regular, bold]);
  });
});

describe("choosing a manual's design", () => {
  const loadDesign = (id: string) =>
    id === 'product-line' ? sample() : undefined;

  it('the built-in design when neither the manual nor the configuration names one', () => {
    expect(pageDesignIdFor(manifest, config)).toBe('builtin');
    expect(choosePageDesign({ manifest, config, loadDesign })).toEqual({
      design: DEFAULT_PAGE_DESIGN,
      issues: [],
    });
  });

  it("the configuration's default, and the manual's own choice over it", () => {
    const withDefault = ProjectConfig.parse({
      ...sampleConfig,
      pdf: { design: 'product-line' },
    });
    expect(
      choosePageDesign({ manifest, config: withDefault, loadDesign }).design.id,
    ).toBe('product-line');
    expect(pageDesignIdFor({ design: 'other' }, withDefault)).toBe('other');
    expect(
      choosePageDesign({
        manifest: { design: 'product-line' },
        config,
        loadDesign,
      }).design.name,
    ).toBe('Product line');
  });

  it('a design that does not exist: an issue, and the built-in design', () => {
    expect(
      choosePageDesign({ manifest: { design: 'gone' }, config, loadDesign }),
    ).toEqual({
      design: DEFAULT_PAGE_DESIGN,
      issues: [expect.objectContaining({ code: 'unknown-page-design' })],
    });
  });
});

describe('resolvePageDesign', () => {
  const resolve = (
    lang: string,
    variant: Record<string, string> = { model: 'l-400', market: 'eu' },
    d: PageDesign = sample(),
  ) =>
    resolvePageDesign({
      design: d,
      manifest,
      variant,
      lang,
      config,
      release: 'v2.3',
      date: '2026-11-20',
    });

  it('fills placeholders in English and in German, keeping the page placeholders', () => {
    const en = resolve('en');
    const de = resolve('de');
    expect(
      text(
        en.design.regions['above-title']?.[0]?.type === 'paragraph'
          ? en.design.regions['above-title'][0].content
          : undefined,
      ),
    ).toBe('Original instructions for L-400');
    const deIntro = de.design.regions['above-title']?.[0];
    expect(deIntro?.type === 'paragraph' && text(deIntro.content)).toBe(
      'Originalbetriebsanleitung für L-400',
    );
    expect(text(en.design.footer.default.right)).toBe(
      'Page <page> of <page-count>',
    );
    expect(text(de.design.footer.default.right)).toBe(
      'Seite <page> von <page-count>',
    );
    expect(text(de.design.footer.default.centre)).toBe('Deutsch');
    expect(text(en.design.footer.default.centre)).toBe('English');
    expect(en.design.placeholders.date).toBe('November 20, 2026');
    expect(de.design.placeholders.date).toBe('20. November 2026');
    expect(en.design.titlePage.fields).toEqual([
      { field: 'title', value: 'Operating manual' },
      { field: 'product', value: 'L-400' },
      { field: 'variant', value: 'L-400 · EU' },
      { field: 'document-number', value: 'DOC-0042' },
      { field: 'release', value: 'v2.3' },
      { field: 'date', value: 'November 20, 2026' },
    ]);
    expect(en.issues).toEqual([]);
    expect(de.issues).toEqual([]);
  });

  it('falls back to the source language for a text without a translation', () => {
    const fr = resolve('fr');
    const intro = fr.design.regions['above-title']?.[0];
    expect(intro?.type === 'paragraph' && text(intro.content)).toBe(
      'Original instructions for L-400',
    );
    expect(fr.issues.map((i) => [i.code, i.at])).toEqual([
      ['missing-translation', 'regions.above-title'],
      ['missing-translation', 'coverImage.variants.0.alt'],
      ['missing-translation', 'backPage.copyright'],
      ['missing-translation', 'footer.default.right'],
    ]);
  });

  it('picks the cover image by variant, else the default', () => {
    expect(resolve('de').design.coverImage).toEqual({
      asset: `sha256:${'3'.repeat(64)}`,
      alt: 'Das Modell L-400',
    });
    expect(
      resolve('de', { model: 'l-200', market: 'eu' }).design.coverImage,
    ).toEqual({ asset: `sha256:${'2'.repeat(64)}` });
  });

  it('applies variant blocks and text attributes in region text', () => {
    const blocks = (variant: Record<string, string>) =>
      resolve('en', variant).design.regions['back'] ?? [];
    expect(blocks({ model: 'l-400', market: 'eu' })).toEqual([
      {
        type: 'paragraph',
        id: 'imprint',
        content: [{ type: 'text', text: 'Lifter · November 20, 2026' }],
      },
    ]);
    expect(blocks({ model: 'l-400', market: 'us' }).map((b) => b.id)).toEqual([
      'imprint',
      'us-note',
    ]);
  });

  it('keeps the left pages only for double-sided print', () => {
    expect(text(resolve('en').design.header.even?.left)).toBe('<chapter>');
    const single = sample();
    single.page = { ...single.page, doubleSided: false };
    expect(resolve('en', undefined, single).design.header.even).toBeUndefined();
  });

  it('reports a placeholder without a value, and leaves the field out', () => {
    const d = design({
      titlePage: { fields: ['title', 'subtitle'] },
      regions: {
        footer: [
          {
            type: 'paragraph',
            id: 'p',
            content: [{ type: 'placeholder', key: 'revision-number' }],
          },
        ],
      },
    });
    const { design: resolved, issues } = resolve('en', undefined, d);
    expect(resolved.titlePage.fields).toEqual([
      { field: 'title', value: 'Operating manual' },
    ]);
    expect(resolved.regions['footer']).toEqual([
      {
        type: 'paragraph',
        id: 'p',
        content: [{ type: 'placeholder', key: 'revision-number' }],
      },
    ]);
    expect(issues.map((i) => [i.code, i.at])).toEqual([
      ['missing-placeholder-value', 'regions.footer'],
      ['missing-placeholder-value', 'titlePage.fields'],
    ]);
  });

  it("reports a text in neither the manual's language nor the source language, which it leaves out (#554)", () => {
    const d = design({
      footer: {
        default: {
          left: { de: [{ type: 'text', text: 'Nur Deutsch' }] },
          right: [{ type: 'text', text: 'Every language' }],
        },
      },
      regions: {
        footer: {
          de: [
            {
              type: 'paragraph',
              id: 'p',
              content: [{ type: 'text', text: 'Fußzeile' }],
            },
          ],
        },
      },
    });
    const fr = resolve('fr', undefined, d);
    expect(fr.design.footer.default.left).toBeUndefined();
    expect(fr.design.regions['footer']).toBeUndefined();
    expect(
      fr.issues
        .filter((i) => i.code === 'dropped-text')
        .map((i) => [i.severity, i.at]),
    ).toEqual([
      ['warning', 'regions.footer'],
      ['warning', 'footer.default.left'],
    ]);
    // The source language itself has no version of it either.
    expect(resolve('en', undefined, d).issues.map((i) => i.code)).toContain(
      'dropped-text',
    );
    // In German it is there.
    expect(resolve('de', undefined, d).issues.map((i) => i.code)).not.toContain(
      'dropped-text',
    );
  });

  it("reports a region whose text in the manual's language has other blocks than the source's (#554)", () => {
    const p = (id: string): Block => ({
      type: 'paragraph',
      id,
      content: [{ type: 'text', text: id }],
    });
    const d = design({
      regions: { footer: { en: [p('a'), p('b')], de: [p('a')] } },
    });
    expect(
      resolve('de', undefined, d).issues.filter(
        (i) => i.code === 'region-languages-differ',
      ),
    ).toEqual([
      {
        severity: 'warning',
        code: 'region-languages-differ',
        message: 'the "de" text lacks blocks the "en" text has (b)',
        at: 'regions.footer',
        name: 'en',
      },
    ]);
    // The source language's own text, and a fallback to it, compare with nothing.
    for (const lang of ['en', 'fr']) {
      expect(
        resolve(lang, undefined, d).issues.map((i) => i.code),
      ).not.toContain('region-languages-differ');
    }
  });

  it('fills the manufacturer placeholders from the configuration, on any page (#395)', () => {
    const d = design({
      header: {
        default: { left: [{ type: 'placeholder', key: 'manufacturer-name' }] },
      },
      regions: {
        back: [
          {
            type: 'paragraph',
            id: 'who',
            content: [
              { type: 'placeholder', key: 'manufacturer-address' },
              { type: 'text', text: ' | ' },
              { type: 'placeholder', key: 'manufacturer-contact' },
              { type: 'text', text: ' | ' },
              { type: 'placeholder', key: 'manufacturer-website' },
            ],
          },
        ],
      },
      backPage: {},
    });
    const { design: resolved, issues } = resolve('en', undefined, d);
    expect(text(resolved.header.default.left)).toBe('Example Works Ltd');
    const who = resolved.regions['back']?.[0];
    expect(who?.type === 'paragraph' && text(who.content)).toBe(
      '1 Sample Street, 12345 Sample Town | info@example.com | https://example.com',
    );
    expect(resolved.backPage).toEqual({
      position: 'last',
      manufacturer: MANUFACTURER,
      documentNumber: 'DOC-0042',
      date: 'November 20, 2026',
    });
    expect(issues).toEqual([]);

    // Without details: the placeholders stay, reported; the back page prints no manufacturer.
    const none = resolvePageDesign({
      design: d,
      manifest,
      variant: { model: 'l-400', market: 'eu' },
      lang: 'en',
      config: noManufacturer,
    });
    expect(none.design.backPage).toEqual({
      position: 'last',
      documentNumber: 'DOC-0042',
    });
    expect(
      none.issues
        .filter(
          (i) =>
            i.code === 'missing-placeholder-value' &&
            i.name?.startsWith('manufacturer-'),
        )
        .map((i) => i.name),
    ).toEqual([
      'manufacturer-address',
      'manufacturer-contact',
      'manufacturer-website',
      'manufacturer-name',
    ]);
  });

  it('fills the release and its date, which only a release knows (#395)', () => {
    const d = design({
      regions: {
        back: [
          {
            type: 'paragraph',
            id: 'release',
            content: [
              { type: 'text', text: 'Release ' },
              { type: 'placeholder', key: 'release' },
              { type: 'text', text: ', ' },
              { type: 'placeholder', key: 'date' },
            ],
          },
        ],
      },
      backPage: { position: 'inside-cover' },
    });
    const released = resolve('de', undefined, d).design;
    const line = released.regions['back']?.[0];
    expect(line?.type === 'paragraph' && text(line.content)).toBe(
      'Release v2.3, 20. November 2026',
    );
    expect(released.backPage?.position).toBe('inside-cover');
    // A preview knows neither: they stay placeholders.
    const preview = resolvePageDesign({
      design: d,
      manifest,
      variant: { model: 'l-400', market: 'eu' },
      lang: 'en',
      config,
    });
    const kept = preview.design.regions['back']?.[0];
    expect(kept?.type === 'paragraph' && kept.content).toContainEqual({
      type: 'placeholder',
      key: 'release',
    });
  });

  it("uses the design's fonts only once their embedding is confirmed", () => {
    const font = { family: 'Sample Sans', regular: `sha256:${'b'.repeat(64)}` };
    expect(
      resolve('en', undefined, design({ fonts: { body: font } })).design.fonts,
    ).toEqual({});
    expect(
      resolve(
        'en',
        undefined,
        design({ fonts: { body: font, embeddingAllowed: true } }),
      ).design.fonts,
    ).toEqual({ body: font });
  });
});

describe('pageDesignShowsRelease (#395)', () => {
  const placeholder = (key: string): Inline[] => [{ type: 'placeholder', key }];
  it('tells a design that prints the release or its date', () => {
    expect(pageDesignShowsRelease(DEFAULT_PAGE_DESIGN)).toBe(true);
    expect(pageDesignShowsRelease(sample())).toBe(true);
    const plain = { titlePage: { fields: ['title' as const] } };
    expect(pageDesignShowsRelease(design(plain))).toBe(false);
    expect(
      pageDesignShowsRelease(design({ ...plain, backPage: { date: false } })),
    ).toBe(false);
    expect(pageDesignShowsRelease(design({ ...plain, backPage: {} }))).toBe(
      true,
    );
    expect(
      pageDesignShowsRelease(
        design({
          ...plain,
          footer: { default: { right: { de: placeholder('release') } } },
        }),
      ),
    ).toBe(true);
    expect(
      pageDesignShowsRelease(
        design({
          ...plain,
          regions: {
            footer: {
              en: [
                { type: 'paragraph', id: 'd', content: placeholder('date') },
              ],
            },
          },
        }),
      ),
    ).toBe(true);
    expect(
      pageDesignShowsRelease(
        design({
          ...plain,
          regions: {
            footer: [
              { type: 'paragraph', id: 'd', content: placeholder('title') },
            ],
          },
        }),
      ),
    ).toBe(false);
  });
});

describe('a design file from before #395', () => {
  it('still reads with the manufacturer on its back page, which is the configuration’s now', () => {
    const design = parsePageDesign(
      [
        'schemaVersion: 1',
        'name: Old',
        'preset: classic',
        'colours: { primary: "#1f4e79", accent: "#b45309", text: "#1f2328" }',
        'backPage:',
        '  manufacturer: { name: Example Works Ltd, address: [1 Sample Street] }',
        '  documentNumber: false',
      ].join('\n'),
      { id: 'old' },
    );
    expect(design.backPage).toEqual({
      position: 'last',
      documentNumber: false,
      date: true,
    });
  });
});
