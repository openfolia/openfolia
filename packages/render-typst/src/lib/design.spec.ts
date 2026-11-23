import { mkdirSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { join } from 'node:path';
import {
  Manifest,
  Module,
  parsePageDesign,
  ProjectConfig,
  resolveManual,
  resolvePageDesign,
  type Block,
  type ResolvedManual,
  type ResolvedPageDesign,
} from '@openfolia/content-model';
import {
  closeWorkerPool,
  compilePagePngInWorker,
  compilePdfReportInWorker,
  type CompileInput,
  TypstAccessibilityError,
} from './compile.js';
import jsQRModule from 'jsqr';
import {
  designData,
  designFontFamily,
  designTemplate,
  layoutWarnings,
  MAX_LAYOUT_WARNINGS,
} from './design.js';
import { qrCodeSvg } from './qr.js';
import { renderTypst } from './render.js';
import { renamedFont, themeFont, woffFromSfnt } from '../testing/fonts.js';
import { pageRatio, sketch } from '../testing/page-image.js';

// jsqr is CommonJS typed as an ES module: at run time its default import is the function.
const jsQR = jsQRModule as unknown as typeof jsQRModule.default;

afterAll(() => closeWorkerPool());

/** Set to a directory to write each test's PDF and page images there (for the PR's pictures). */
const DUMP = process.env['CCMS_DESIGN_DUMP'];

const text = (t: string) => ({ type: 'text' as const, text: t });
const para = (id: string, t: string): Block => ({
  type: 'paragraph',
  id,
  content: [text(t)],
});

const config = ProjectConfig.parse({
  languages: { source: 'en', targets: ['de'] },
  moduleTypes: [{ id: 'concept', label: 'Concept' }],
  audiences: [{ id: 'public', label: 'Public' }],
  variantAttributes: [
    {
      id: 'model',
      label: 'Model',
      kind: 'enum',
      values: [{ id: 'large', label: 'Large' }],
    },
  ],
  textAttributes: [
    { id: 'product', label: 'Product' },
    { id: 'subtitle', label: 'Subtitle' },
    { id: 'product-version', label: 'Product version' },
    { id: 'document-number', label: 'Document number' },
    { id: 'revision-number', label: 'Revision number' },
  ],
  safetySymbols: [{ id: 'w001', label: 'General warning' }],
  // Invented details (#395): what the back page prints and the placeholders show.
  manufacturer: {
    name: 'Example Works Ltd',
    address: ['1 Sample Street', '12345 Sample Town'],
    contact: 'info@example.com',
    website: 'https://example.com',
  },
});

const TITLES = {
  en: {
    manual: 'Operating manual',
    long: 'Operating and maintenance manual for the garden pump with pressure tank',
    chapters: ['Safety', 'Operation and daily maintenance of the pump'],
  },
  de: {
    manual: 'Betriebsanleitung',
    long: 'Betriebs- und Wartungsanleitung für die Gartenpumpe mit Druckbehälter',
    chapters: [
      'Sicherheit',
      'Inbetriebnahme, Bedienung und tägliche Instandhaltung der Gartenpumpe mit Druckbehälter und Ansaugschlauch',
    ],
  },
} as const;

/** A module in one language: running text, a table, steps, a note and a safety notice. */
function chapter(
  id: string,
  title: string,
  lang: 'en' | 'de',
  more = false,
): Module {
  const filler = Array.from({ length: more ? 14 : 3 }, (_, i) =>
    para(
      `p${i}`,
      lang === 'de'
        ? 'Die Pumpe fördert selbstständig Wasser aus der Regentonne. Halten Sie den Ansaugschlauch frei und beachten Sie die Hinweise in diesem Kapitel, bevor Sie die Pumpe in Betrieb nehmen.'
        : 'The pump draws water from the rain barrel by itself. Keep its suction hose clear and read the notes in this chapter before you start the pump.',
    ),
  );
  const blocks: Block[] = [
    ...filler,
    {
      type: 'safety',
      id: 'crush',
      severity: 'warning',
      hazard: [
        text(
          lang === 'de'
            ? 'Quetschgefahr am Druckbehälter'
            : 'Crushing at the pressure tank',
        ),
      ],
      symbols: ['w001'],
      blocks: [para('keep', lang === 'de' ? 'Abstand halten.' : 'Keep clear.')],
    },
    {
      type: 'admonition',
      id: 'tip',
      kind: 'note',
      blocks: [para('n', lang === 'de' ? 'Ein Hinweis.' : 'A note.')],
    },
    {
      type: 'procedure',
      id: 'steps',
      steps: [1, 2, 3].map((n) => ({
        id: `s${n}`,
        content: [text(lang === 'de' ? `Schritt ${n}.` : `Step ${n}.`)],
        blocks: [],
      })),
    },
    {
      type: 'table',
      id: 'data',
      header: true,
      columns: [{ width: 1 }, { width: 2 }],
      rows: [
        ['Value', 'Meaning'],
        ['A', 'One'],
        ['B', 'Two'],
        ['C', 'Three'],
      ].map((cells, r) => ({
        id: `r${r}`,
        cells: cells.map((c, i) => ({ blocks: [para(`c${r}-${i}`, c)] })),
      })),
    },
  ];
  return Module.parse({
    schemaVersion: 1,
    id,
    meta: { title, type: 'concept', lang, audience: 'public' },
    blocks,
  });
}

function manualIn(lang: 'en' | 'de', long = false): ResolvedManual {
  const t = TITLES[lang];
  const modules: Record<string, Module> = {
    safety: chapter('safety', t.chapters[0], lang),
    operation: chapter('operation', t.chapters[1], lang, true),
  };
  const manifest = Manifest.parse({
    schemaVersion: 1,
    id: 'operating',
    title: long ? t.long : t.manual,
    variants: [{ model: 'large' }],
    attributes: {
      product: 'Pump 400',
      subtitle:
        lang === 'de' ? 'Originalbetriebsanleitung' : 'Original instructions',
      'product-version': '2.3',
      'document-number': 'DOC-0042',
      'revision-number': '7',
    },
    entries: [{ module: 'safety' }, { module: 'operation' }],
  });
  const { manual } = resolveManual({
    manifest,
    variant: { model: 'large' },
    lang,
    config,
    loadModule: (id) => modules[id],
  });
  return manual;
}

const LOGO = 'sha256:' + '1'.repeat(64);
const COVER = 'sha256:' + '2'.repeat(64);
const files: Record<string, Uint8Array> = {
  [`assets/${'1'.repeat(64)}`]: new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect width="40" height="40" rx="8" fill="#1f4e79"/><rect x="50" y="10" width="70" height="20" fill="#b45309"/></svg>',
  ),
  [`assets/${'2'.repeat(64)}`]: new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#9fb8cf"/><circle cx="300" cy="90" r="50" fill="#f2d16b"/><path d="M0 300 L140 150 L260 260 L330 200 L400 260 V300 Z" fill="#41617f"/></svg>',
  ),
  'symbols/w001.svg': new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 8 L95 90 H5 Z" fill="#f9a800" stroke="#000" stroke-width="5"/></svg>',
  ),
};

/** A design with every field on, in a preset, over the settings given. */
function designYaml(preset: string, settings = ''): string {
  return `schemaVersion: 1
name: Test design
preset: ${preset}
page:
  size: a4
  doubleSided: true
colours:
  primary: "#1f4e79"
  accent: "#b45309"
  text: "#1f2328"
logo:
  light: ${LOGO}
titlePage:
  fields: [title, subtitle, product, variant, product-version, language, release, date, document-number, revision-number, audience]
regions:
  above-title:
    en: |-
      [#intro]
      Original instructions for placeholder:product[]
    de: |-
      [#intro]
      Originalbetriebsanleitung für placeholder:product[]
  below-fields: |-
    [#numbers]
    placeholder:document-number[] · Rev. placeholder:revision-number[]
  band: |-
    [#band]
    placeholder:product[] · placeholder:product-version[]
  footer:
    en: |-
      [#keep]
      Keep this manual with the pump.
    de: |-
      [#keep]
      Bewahren Sie diese Anleitung bei der Pumpe auf.
  back: |-
    [#imprint]
    placeholder:product[] placeholder:product-version[]
  back-footer: |-
    [#number]
    placeholder:document-number[]
coverImage:
  default:
    asset: ${COVER}
    alt:
      en: The pump in a garden shed
      de: Die Pumpe in einem Gartenhaus
backPage:
  copyright:
    en: © Example Works. All rights reserved.
    de: © Example Works. Alle Rechte vorbehalten.
header:
  default:
    left: placeholder:title[]
    right: placeholder:chapter[]
  even:
    left: placeholder:chapter[]
    right: placeholder:title[]
footer:
  default:
    left: placeholder:document-number[]
    centre: placeholder:language[]
    right:
      en: Page placeholder:page[] of placeholder:page-count[]
      de: Seite placeholder:page[] von placeholder:page-count[]
${settings}`;
}

function resolved(
  yaml: string,
  manual: ResolvedManual,
  lang: 'en' | 'de',
  projectConfig: ProjectConfig = config,
): ResolvedPageDesign {
  const design = parsePageDesign(yaml, { id: 'test' });
  const manifest = Manifest.parse({
    schemaVersion: 1,
    id: 'operating',
    title: manual.title,
    variants: [{ model: 'large' }],
    attributes: {
      product: 'Pump 400',
      subtitle:
        lang === 'de' ? 'Originalbetriebsanleitung' : 'Original instructions',
      'product-version': '2.3',
      'document-number': 'DOC-0042',
      'revision-number': '7',
    },
    audience: 'public',
    entries: [{ module: 'safety' }],
  });
  return resolvePageDesign({
    design,
    manifest,
    variant: { model: 'large' },
    lang,
    config: projectConfig,
    release: '2.3.0',
    date: '2026-11-20',
  }).design;
}

function input(
  manual: ResolvedManual,
  design: ResolvedPageDesign,
): CompileInput {
  const { source, inputs } = renderTypst(manual, {
    design,
    symbolPath: (id) => `symbols/${id}.svg`,
  });
  return {
    source,
    files,
    inputs,
    template: designTemplate(design.preset),
    creationTimestamp: 1_700_000_000,
  };
}

async function dump(name: string, compile: CompileInput, pdf: Uint8Array) {
  if (!DUMP) return;
  mkdirSync(DUMP, { recursive: true });
  writeFileSync(join(DUMP, `${name}.pdf`), pdf);
  for (let page = 1; page <= 12; page++) {
    try {
      const png = await compilePagePngInWorker(compile, {
        number: page,
        width: 900,
      });
      writeFileSync(join(DUMP, `${name}-p${page}.png`), png);
    } catch {
      break;
    }
  }
}

describe('page designs in print (#391)', () => {
  for (const preset of ['classic', 'image-led', 'minimal']) {
    for (const lang of ['en', 'de'] as const) {
      it(
        `renders the ${preset} preset in ${lang}, with a long title and every field on`,
        { timeout: 120_000 },
        async () => {
          const manual = manualIn(lang, true);
          const design = resolved(designYaml(preset), manual, lang);
          const compile = input(manual, design);
          const { pdf, warnings } = await compilePdfReportInWorker(compile);
          await dump(`${preset}-${lang}`, compile, pdf);
          expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
          expect(
            warnings.filter((w) => w.code !== 'running-head-truncated'),
          ).toEqual([]);
          // The title page and the first content page, as where their ink is.
          expect(await sketch(compile, 1)).toMatchSnapshot('title page');
          expect(await sketch(compile, 3)).toMatchSnapshot(
            'first content page',
          );
        },
      );
    }
  }
});

describe('a manual’s cover image (#394)', () => {
  const MANUAL_COVER = 'sha256:' + '3'.repeat(64);
  const VARIANT_COVER = 'sha256:' + '4'.repeat(64);
  const withCovers: Record<string, Uint8Array> = {
    ...files,
    [`assets/${'3'.repeat(64)}`]: new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#e7d8c4"/><rect x="120" y="80" width="160" height="160" fill="#7a4b2a"/></svg>',
    ),
    [`assets/${'4'.repeat(64)}`]: new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400"><rect width="300" height="400" fill="#c9e3d2"/><circle cx="150" cy="200" r="110" fill="#2f6b4a"/></svg>',
    ),
  };
  /** The design without its own cover image. */
  const noDesignCover = (preset: string) =>
    designYaml(preset).replace(
      /coverImage:\n {2}default:\n(?: {4}.*\n)+(?: {6}.*\n)+/,
      '',
    );
  const covers = {
    default: {
      asset: MANUAL_COVER,
      alt: { en: 'The pump', de: 'Die Pumpe' },
    },
    variants: [
      {
        variant: { model: 'large' },
        asset: VARIANT_COVER,
        alt: 'The large pump',
      },
    ],
  };
  function compileFor(
    preset: string,
    variant: Record<string, string>,
    coverImage?: typeof covers,
  ): CompileInput {
    const manual = manualIn('en');
    const manifest = Manifest.parse({
      schemaVersion: 1,
      id: 'operating',
      title: manual.title,
      variants: [{ model: 'large' }, { model: 'small' }],
      ...(coverImage && { coverImage }),
      entries: [{ module: 'safety' }],
    });
    const design = resolvePageDesign({
      design: parsePageDesign(noDesignCover(preset), { id: 'test' }),
      manifest,
      variant,
      lang: 'en',
      config,
    }).design;
    return { ...input(manual, design), files: withCovers };
  }

  it('leaves the design without a cover image of its own', () => {
    expect(noDesignCover('classic')).not.toContain('coverImage');
    expect(noDesignCover('classic')).toContain('backPage:');
  });

  for (const preset of ['classic', 'image-led', 'minimal']) {
    it(
      `shows the variant’s own, the manual’s or none on the ${preset} title page`,
      { timeout: 120_000 },
      async () => {
        const own = compileFor(preset, { model: 'large' }, covers);
        const manuals = compileFor(preset, { model: 'small' }, covers);
        const none = compileFor(preset, { model: 'small' });
        expect(own.source.length).toBeGreaterThan(0);
        expect(
          JSON.parse(own.inputs?.['openfolia-design'] ?? '{}').cover,
        ).toEqual({
          path: `/assets/${'4'.repeat(64)}`,
          alt: 'The large pump',
        });
        const pdf = (await compilePdfReportInWorker(own)).pdf.toString(
          'latin1',
        );
        expect(pdf).toMatch(/\/S \/Figure[\s\S]*?\/Alt \(The large pump\)/);
        await dump(`cover-${preset}-variant`, own, Buffer.from(pdf, 'latin1'));
        await dump(
          `cover-${preset}-manual`,
          manuals,
          (await compilePdfReportInWorker(manuals)).pdf,
        );
        await dump(
          `cover-${preset}-none`,
          none,
          (await compilePdfReportInWorker(none)).pdf,
        );
        const pages = {
          variant: await sketch(own, 1),
          manual: await sketch(manuals, 1),
          none: await sketch(none, 1),
        };
        expect(pages.variant).not.toEqual(pages.manual);
        expect(pages.manual).not.toEqual(pages.none);
        expect(pages).toMatchSnapshot('title pages');
      },
    );
  }
});

const ADDRESS = 'https://docs.example.com/d/north/operating/model=large/en';

/** A designed manual with the stable address's QR code where `placement` says (#450). */
function withQr(
  manual: ResolvedManual,
  design: ResolvedPageDesign,
  placement: 'title-page' | 'back-cover',
): CompileInput {
  const { source, inputs } = renderTypst(manual, {
    design,
    symbolPath: (id) => `symbols/${id}.svg`,
    qrCode: { path: 'qr/address.svg', url: ADDRESS, placement },
  });
  return {
    source,
    files: {
      ...files,
      'qr/address.svg': new TextEncoder().encode(qrCodeSvg(ADDRESS)),
    },
    inputs,
    template: designTemplate(design.preset),
    creationTimestamp: 1_700_000_000,
  };
}

/** The QR code a page shows, read from its image; undefined for none. */
async function decodedOn(
  compile: CompileInput,
  page: number,
): Promise<string | undefined> {
  const width = 1400;
  const png = await compilePagePngInWorker(compile, { number: page, width });
  const height = Math.round((width * 297) / 210);
  const image = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<image width="${width}" height="${height}" href="data:image/png;base64,${Buffer.from(png).toString('base64')}"/></svg>`,
    { background: '#ffffff' },
  ).render();
  return (
    jsQR(new Uint8ClampedArray(image.pixels), image.width, image.height, {
      inversionAttempts: 'dontInvert',
    })?.data ?? undefined
  );
}

/**
 * The widest run of blank columns, in millimetres, between the first and the last inked column
 * of a page's band from `top` to `bottom` (fractions of its height).
 */
async function widestGap(
  compile: CompileInput,
  page: number,
  top: number,
  bottom: number,
): Promise<number> {
  const width = 1050;
  const png = await compilePagePngInWorker(compile, { number: page, width });
  const height = Math.round((width * 297) / 210);
  const image = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<image width="${width}" height="${height}" href="data:image/png;base64,${Buffer.from(png).toString('base64')}"/></svg>`,
    { background: '#ffffff' },
  ).render();
  const pixels = image.pixels;
  const inked: boolean[] = [];
  for (let x = 0; x < image.width; x++) {
    let ink = false;
    for (
      let y = Math.floor(image.height * top);
      y < image.height * bottom;
      y++
    ) {
      const i = (y * image.width + x) * 4;
      if (
        (pixels[i] ?? 255) + (pixels[i + 1] ?? 255) + (pixels[i + 2] ?? 255) <
        450
      ) {
        ink = true;
        break;
      }
    }
    inked.push(ink);
  }
  const first = inked.indexOf(true);
  const last = inked.lastIndexOf(true);
  let widest = 0;
  let run = 0;
  for (let x = first; x <= last; x++) {
    run = inked[x] ? 0 : run + 1;
    widest = Math.max(widest, run);
  }
  return (widest * 210) / image.width;
}

/** A PDF's page count. */
const pageCount = (pdf: Uint8Array) =>
  Buffer.from(pdf)
    .toString('latin1')
    .match(/\/Type\s*\/Page(?!s)/g)?.length ?? 0;

describe('the stable address QR code in a designed manual (#450)', () => {
  for (const preset of ['classic', 'image-led', 'minimal']) {
    it(
      `${preset}: on the title page beside the footer region, and on the design's own back page`,
      { timeout: 180_000 },
      async () => {
        const manual = manualIn('en', true);
        const design = resolved(designYaml(preset), manual, 'en');
        const plain = await compilePdfReportInWorker(input(manual, design));
        const pages = pageCount(plain.pdf);

        const title = withQr(manual, design, 'title-page');
        const titled = await compilePdfReportInWorker(title);
        await dump(`${preset}-qr-title`, title, titled.pdf);
        // On the title page, readable, and nothing the layout had to clip for it.
        expect(await decodedOn(title, 1)).toBe(ADDRESS);
        expect(pageCount(titled.pdf)).toBe(pages);
        expect(titled.warnings.map((w) => w.code)).toEqual(
          plain.warnings.map((w) => w.code),
        );

        const back = withQr(manual, design, 'back-cover');
        const backed = await compilePdfReportInWorker(back);
        await dump(`${preset}-qr-back`, back, backed.pdf);
        // On the design's back page: no page of its own, none on the title page.
        expect(pageCount(backed.pdf)).toBe(pages);
        expect(await decodedOn(back, pages)).toBe(ADDRESS);
        expect(await decodedOn(back, 1)).toBeUndefined();
      },
    );
  }

  it(
    "keeps the code's own back page under a repository template that ignores the design",
    { timeout: 120_000 },
    async () => {
      const manual = manualIn('en');
      const design = resolved(designYaml('classic'), manual, 'en');
      // The repository's own template (here the default one): it never reads the QR input.
      const own = { ...input(manual, design), template: undefined };
      const pages = pageCount((await compilePdfReportInWorker(own)).pdf);
      const back = {
        ...withQr(manual, design, 'back-cover'),
        template: undefined,
      };
      const { pdf } = await compilePdfReportInWorker(back);
      expect(pageCount(pdf)).toBe(pages + 1);
      expect(await decodedOn(back, pages + 1)).toBe(ADDRESS);
    },
  );

  for (const preset of ['classic', 'image-led', 'minimal']) {
    it(
      `${preset}: keeps a long footer clear of the address under the title page's code`,
      { timeout: 120_000 },
      async () => {
        const manual = manualIn('en', true);
        const long = designYaml(preset).replace(
          'Keep this manual with the pump.',
          'Keep this manual with the pump at all times, within reach of every operator, and hand it on with the pump when it changes owner.',
        );
        const title = withQr(
          manual,
          resolved(long, manual, 'en'),
          'title-page',
        );
        expect(await decodedOn(title, 1)).toBe(ADDRESS);
        // Across the foot of the page, the footer's ink and the code's (the address included)
        // keep a gap of white columns between them, at least the 8 mm the layer leaves.
        const gap = await widestGap(
          title,
          1,
          preset === 'image-led' ? 0.87 : 0.8,
          0.97,
        );
        expect(gap).toBeGreaterThanOrEqual(6);
      },
    );
  }

  it(
    'gives a design without a back page one for the code',
    { timeout: 120_000 },
    async () => {
      const manual = manualIn('en');
      const bare = resolved(
        `schemaVersion: 1
name: Bare
preset: minimal
colours:
  primary: "#1f4e79"
  accent: "#b45309"
  text: "#1f2328"
`,
        manual,
        'en',
      );
      const pages = pageCount(
        (await compilePdfReportInWorker(input(manual, bare))).pdf,
      );
      const back = withQr(manual, bare, 'back-cover');
      const { pdf } = await compilePdfReportInWorker(back);
      expect(pageCount(pdf)).toBe(pages + 1);
      expect(await decodedOn(back, pages + 1)).toBe(ADDRESS);
    },
  );
});

describe('the back page, last or on the inside of the title page (#395)', () => {
  /** The sample design with its back page at `position`, the release and its date on it. */
  const atPosition = (position: 'last' | 'inside-cover') =>
    designYaml('classic')
      .replace('backPage:\n', `backPage:\n  position: ${position}\n`)
      .replace(
        '  back: |-\n    [#imprint]\n    placeholder:product[] placeholder:product-version[]',
        '  back: |-\n    [#imprint]\n    placeholder:product[] placeholder:product-version[]\n\n    [#release]\n    Release placeholder:release[], placeholder:date[]',
      );

  it(
    'prints it last, or as the second page, before the contents, with the same imprint',
    { timeout: 180_000 },
    async () => {
      const manual = manualIn('en');
      const last = input(manual, resolved(atPosition('last'), manual, 'en'));
      const inside = input(
        manual,
        resolved(atPosition('inside-cover'), manual, 'en'),
      );
      expect(
        JSON.parse(inside.inputs?.['openfolia-design'] ?? '{}'),
      ).toMatchObject({
        'back-page': {
          position: 'inside-cover',
          manufacturer: { name: 'Example Works Ltd' },
        },
      });
      expect(inside.source).toContain('"Release 2.3.0, November 20, 2026"');
      const lastPdf = await compilePdfReportInWorker(last);
      const insidePdf = await compilePdfReportInWorker(inside);
      await dump('back-page-last', last, lastPdf.pdf);
      await dump('back-page-inside-cover', inside, insidePdf.pdf);
      for (const { warnings } of [lastPdf, insidePdf]) {
        expect(
          warnings.filter((w) => w.code !== 'running-head-truncated'),
        ).toEqual([]);
      }
      const lastPages = pageCount(lastPdf.pdf);
      const back = await sketch(last, lastPages);
      expect(back).toMatchSnapshot('back page, last');
      // The same page, on the inside of the title page; the contents follow it, on page 3.
      expect(await sketch(inside, 2)).toEqual(back);
      expect(await sketch(inside, 3)).toMatchSnapshot(
        'contents, after the inside cover',
      );
      // Nothing is printed twice: no back page at the end any more.
      expect(await sketch(inside, pageCount(insidePdf.pdf))).not.toEqual(back);
      expect(insidePdf.pdf.toString('latin1')).toContain(
        '<pdfuaid:part>1</pdfuaid:part>',
      );
    },
  );

  it(
    'keeps a back-cover QR code on the last page when the back page is inside the cover',
    { timeout: 120_000 },
    async () => {
      const manual = manualIn('en');
      const design = resolved(atPosition('inside-cover'), manual, 'en');
      const pages = pageCount(
        (await compilePdfReportInWorker(input(manual, design))).pdf,
      );
      const back = withQr(manual, design, 'back-cover');
      const { pdf } = await compilePdfReportInWorker(back);
      expect(pageCount(pdf)).toBe(pages + 1);
      expect(await decodedOn(back, pages + 1)).toBe(ADDRESS);
      expect(await decodedOn(back, 2)).toBeUndefined();
    },
  );
});

/** Every inner-page setting away from its default. */
const OTHER_SETTINGS = `headings:
  numbering: [decimal, none]
  sizes: [2xl, xl, lg]
  colour: primary
  pageBreakBeforeLevel1: false
body:
  fontSize: 11
  lineHeight: 1.6
  paragraphSpacing: 10
  columns: 2
tables:
  headerTint: false
  borders: grid
  zebra: true
steps:
  marker: number
notes:
  style: framed
safety:
  standard: iso-3864
`;

describe('a design in print, accessible and reproducible (#391)', () => {
  it(
    'gives the cover image and the logo their alternative text, and stays PDF/UA-1',
    { timeout: 120_000 },
    async () => {
      const manual = manualIn('de');
      const design = resolved(designYaml('image-led'), manual, 'de');
      const pdf = (
        await compilePdfReportInWorker(input(manual, design))
      ).pdf.toString('latin1');
      expect(pdf).toContain('<pdfuaid:part>1</pdfuaid:part>');
      expect(pdf).toMatch(
        /\/S \/Figure[\s\S]*?\/Alt \(Die Pumpe in einem Gartenhaus\)/,
      );
      expect(pdf).toMatch(/\/S \/Figure[\s\S]*?\/Alt \(Example Works Ltd\)/);
    },
  );

  it(
    "prints a region's heading (#393) unnumbered, outside the contents and the bookmarks, on the title page",
    { timeout: 120_000 },
    async () => {
      const manual = manualIn('en');
      const pages = (pdf: string) =>
        (pdf.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
      const plain = resolved(designYaml('classic'), manual, 'en');
      const withHeading = resolved(
        designYaml('classic').replace(
          '  below-fields: |-\n    [#numbers]\n',
          '  below-fields: |-\n    [#contact]\n    == Contact us\n\n    [#numbers]\n',
        ),
        manual,
        'en',
      );
      const compile = input(manual, withHeading);
      expect(compile.source).toContain(
        '#heading(level: 1, numbering: none, outlined: false, bookmarked: false)[#"Contact us"]',
      );
      const before = (
        await compilePdfReportInWorker(input(manual, plain))
      ).pdf.toString('latin1');
      const after = (await compilePdfReportInWorker(compile)).pdf.toString(
        'latin1',
      );
      // No page break before it; the chapters keep their numbers and bookmarks, it has none.
      expect(pages(after)).toBe(pages(before));
      expect(after).toContain('<pdfuaid:part>1</pdfuaid:part>');
      expect(after).toContain('/Title (1 Safety)');
      expect(after).not.toMatch(/\/Title \((\d+ )?Contact us\)/);
    },
  );

  it(
    'makes the same bytes from the same input',
    { timeout: 120_000 },
    async () => {
      const manual = manualIn('en', true);
      const design = resolved(designYaml('classic'), manual, 'en');
      const first = await compilePdfReportInWorker(input(manual, design));
      const second = await compilePdfReportInWorker(input(manual, design));
      expect(second.pdf.equals(first.pdf)).toBe(true);
    },
  );

  it('passes the settings as data and the texts as string literals, never as markup', () => {
    const manual = manualIn('en');
    const design = resolved(designYaml('classic'), manual, 'en', {
      ...config,
      manufacturer: {
        name: 'Evil"); #panic("x") //',
        address: [],
      },
    });
    const { source, inputs } = renderTypst(manual, { design });
    // The settings are JSON the template parses; nothing in it is Typst code.
    const data = JSON.parse(inputs['openfolia-design'] ?? '{}');
    expect(data['back-page'].manufacturer.name).toBe('Evil"); #panic("x") //');
    expect(source).not.toContain('Evil');
    // The texts are string literals in content blocks.
    expect(source).toContain(
      '#state("openfolia-design", (:)).update((regions: ("above-title": [#"Original instructions for Pump 400"]',
    );
    expect(source).toContain(
      'right: ([#"Page "], (field: "page"), [#" of "], (field: "page-count"),)',
    );
  });

  it('writes a region’s translated text (#568, from an XLIFF import) as a string literal too', () => {
    const manual = manualIn('en');
    const design = resolved(
      designYaml('classic').replace(
        'Original instructions for',
        '"]; #read("/etc/passwd") \\\\ *x* //',
      ),
      manual,
      'en',
    );
    const { source } = renderTypst(manual, { design });
    expect(source).not.toContain('#read("/etc/passwd")');
    expect(source).toContain(
      '[#"\\"]; #read(\\"/etc/passwd\\") \\\\ *x* // Pump 400"]',
    );
  });

  it('leaves a document without a design as it was: no design state, no inputs', () => {
    const { source, inputs, fonts } = renderTypst(manualIn('en'));
    expect(source).not.toContain('openfolia-design');
    expect(inputs).toEqual({});
    expect(fonts).toEqual([]);
  });
});

describe('inner-page settings (#388)', () => {
  it(
    'apply on the first content page: headings, body, tables, steps, notes and ISO 3864 safety notices',
    { timeout: 120_000 },
    async () => {
      const manual = manualIn('en');
      const design = resolved(
        designYaml('classic', OTHER_SETTINGS)
          .replace('doubleSided: true', 'doubleSided: false\n  size: us-letter')
          .replace('  size: a4\n', ''),
        manual,
        'en',
      );
      const compile = input(manual, design);
      const { pdf, warnings } = await compilePdfReportInWorker(compile);
      await dump('settings-en', compile, pdf);
      expect(warnings).toEqual([]);
      expect(await sketch(compile, 3)).toMatchSnapshot('first content page');
      const data = JSON.parse(compile.inputs?.['openfolia-design'] ?? '{}');
      expect(data).toMatchObject({
        paper: 'us-letter',
        headings: {
          numbering: ['decimal', 'none'],
          sizes: [1.5, 1.25, 1.125],
          colour: '#1f4e79',
        },
        body: { 'font-size': 11, columns: 2 },
        tables: { 'header-tint': false, borders: 'grid', zebra: true },
        steps: { marker: 'number' },
        notes: { style: 'framed' },
        safety: { standard: 'iso-3864' },
      });
    },
  );
});

/** A leaflet's design (#668): A5, the minimal preset, small type and margins, modules run on. */
const LEAFLET_SETTINGS = `headings:
  numbering: [none]
  sizes: [xl, lg, base]
  colour: primary
  pageBreakBeforeLevel1: false
body:
  fontSize: 8.5
  lineHeight: 1.35
  paragraphSpacing: 4
`;
const leafletYaml = (preset = 'minimal') =>
  designYaml(preset, LEAFLET_SETTINGS)
    .replace(
      '  size: a4\n  doubleSided: true\n',
      '  size: a5\n  margins: { top: 14, right: 12, bottom: 14, left: 12 }\n',
    )
    .replace(
      /^header:\n(?: {2}.*\n)+?(?=footer:)/m,
      'header:\n  default:\n    left: placeholder:title[]\n',
    );

/** A manual of one module whose safety message holds `paragraphs` paragraphs. */
function safetyManual(
  lang: 'en' | 'de',
  paragraphs: number,
  before = 8,
): ResolvedManual {
  const words =
    lang === 'de'
      ? 'Halten Sie Hände und Kleidung vom laufenden Lüfterrad fern und sichern Sie die Pumpe gegen Umkippen.'
      : 'Keep hands and clothing clear of the running fan and secure the pump against tipping over.';
  const module = Module.parse({
    schemaVersion: 1,
    id: 'crush-hazard',
    meta: {
      title: lang === 'de' ? 'Quetschgefahr' : 'Crush hazard',
      type: 'concept',
      lang,
      audience: 'public',
    },
    blocks: [
      ...Array.from({ length: before }, (_, i) => para(`p${i}`, words)),
      {
        type: 'safety',
        id: 'notice',
        severity: 'danger',
        hazard: [text(lang === 'de' ? 'Quetschgefahr' : 'Crushing')],
        symbols: ['w001'],
        blocks: Array.from({ length: paragraphs }, (_, i) =>
          para(`t${i}`, words),
        ),
      },
    ],
  });
  const manifest = Manifest.parse({
    schemaVersion: 1,
    id: 'leaflet',
    title: lang === 'de' ? 'Sicherheitsblatt' : 'Safety leaflet',
    variants: [{ model: 'large' }],
    entries: [{ module: 'crush-hazard' }],
  });
  return resolveManual({
    manifest,
    variant: { model: 'large' },
    lang,
    config,
    loadModule: () => module,
  }).manual;
}

/** A PNG's height over its width, from its header. */
function pngRatio(png: Uint8Array): number {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return view.getUint32(20) / view.getUint32(16);
}

describe('A5 and the leaflet design (#668)', () => {
  for (const lang of ['en', 'de'] as const) {
    it(
      `lays a leaflet out on A5 pages in ${lang}`,
      { timeout: 120_000 },
      async () => {
        const manual = manualIn(lang);
        const design = resolved(leafletYaml(), manual, lang);
        const compile = input(manual, design);
        const { pdf, warnings } = await compilePdfReportInWorker(compile);
        await dump(`leaflet-${lang}`, compile, pdf);
        expect(
          JSON.parse(compile.inputs?.['openfolia-design'] ?? '{}').paper,
        ).toBe('a5');
        expect(warnings).toEqual([]);
        // A5 is 148 × 210 mm: 419.53 × 595.28 pt.
        const boxes = [
          ...new TextDecoder('latin1')
            .decode(pdf)
            .matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g),
        ];
        expect(boxes.length).toBeGreaterThan(0);
        for (const [, width, height] of boxes) {
          expect(Number(width)).toBeCloseTo(419.53, 0);
          expect(Number(height)).toBeCloseTo(595.28, 0);
        }
        const png = await compilePagePngInWorker(compile, {
          number: 3,
          width: 296,
        });
        expect(pngRatio(png)).toBeCloseTo(210 / 148, 3);
        expect(pageRatio(compile)).toBeCloseTo(210 / 148, 5);
        expect(await sketch(compile, 1)).toMatchSnapshot('title page');
        expect(await sketch(compile, 3)).toMatchSnapshot('first content page');
      },
    );
  }

  it(
    'keeps a safety message whole on a page, and breaks one taller than a page across pages, reported',
    { timeout: 120_000 },
    async () => {
      for (const standard of ['ansi-z535', 'iso-3864']) {
        const yaml = `${leafletYaml()}safety:\n  standard: ${standard}\n`;
        // Twenty paragraphs before it: it does not fit the rest of the first page.
        const short = safetyManual('en', 6, 20);
        const keptInput = input(short, resolved(yaml, short, 'en'));
        const kept = await compilePdfReportInWorker(keptInput);
        await dump(`leaflet-kept-${standard}`, keptInput, kept.pdf);
        expect(kept.warnings).toEqual([]);
        // The page it would have started on ends with the text before it; it starts the next.
        expect(await sketch(keptInput, 4)).toMatchSnapshot(
          `kept whole, ${standard}`,
        );

        const long = safetyManual('de', 70);
        const compile = input(long, resolved(yaml, long, 'de'));
        expect(compile.source).toContain(
          '#metadata("safety.crush-hazard.notice")<openfolia-safety-at>#safety(',
        );
        const { pdf, warnings } = await compilePdfReportInWorker(compile);
        await dump(`leaflet-split-${standard}`, compile, pdf);
        expect(warnings).toEqual([
          {
            code: 'safety-message-split',
            at: 'safety.crush-hazard.notice',
            page: 3,
            pages: 1,
            text: 'Quetschgefahr',
          },
        ]);
        // It goes on over the next pages instead of running off the first.
        expect(
          pngRatio(
            await compilePagePngInWorker(compile, { number: 5, width: 148 }),
          ),
        ).toBeCloseTo(210 / 148, 1);
      }
    },
  );

  it('leaves the safety messages of a document without a design unmarked', () => {
    const { source } = renderTypst(safetyManual('en', 1), {
      symbolPath: (id) => `symbols/${id}.svg`,
    });
    expect(source).not.toContain('openfolia-safety-at');
    expect(source).toContain('#safety(severity: "danger"');
  });
});

describe('overflow (#391)', () => {
  it(
    'shortens a long German running head to one line with an ellipsis, and reports it',
    { timeout: 120_000 },
    async () => {
      const manual = manualIn('de', true);
      const design = resolved(designYaml('classic'), manual, 'de');
      const { warnings } = await compilePdfReportInWorker(
        input(manual, design),
      );
      // The chapter stands left on even pages, right on odd ones (double-sided).
      expect(warnings).toEqual(
        ['header.even.left', 'header.default.right'].map((at) =>
          expect.objectContaining({
            code: 'running-head-truncated',
            at,
            text: TITLES.de.chapters[1],
          }),
        ),
      );
    },
  );

  it(
    'puts the first running head on the first content page only, not on the contents page',
    { timeout: 120_000 },
    async () => {
      const manual = manualIn('en');
      const long =
        'A first-page running head far too long to stand on one line '.repeat(
          4,
        );
      const yaml = designYaml('classic').replace(
        'header:\n  default:',
        `header:\n  first:\n    left: ${long.trim()}\n  default:`,
      );
      const design = resolved(yaml, manual, 'en');
      const { warnings } = await compilePdfReportInWorker(
        input(manual, design),
      );
      // Title page 1, contents page 2, the body from page 3: the "first" set there, once.
      expect(warnings).toContainEqual(
        expect.objectContaining({
          code: 'running-head-truncated',
          at: 'header.first.left',
          page: 3,
          pages: 1,
        }),
      );
    },
  );

  it(
    'clips a region that overflows its slot, and reports it',
    { timeout: 120_000 },
    async () => {
      const manual = manualIn('en');
      const long = Array.from(
        { length: 12 },
        (_, i) =>
          `      [#p${i}]\n      A long footer paragraph that takes its line.`,
      ).join('\n\n');
      const yaml = designYaml('minimal').replace(
        '  footer:\n    en: |-\n      [#keep]\n      Keep this manual with the pump.',
        `  footer:\n    en: |-\n${long}`,
      );
      const design = resolved(yaml, manual, 'en');
      const compile = input(manual, design);
      const { pdf, warnings } = await compilePdfReportInWorker(compile);
      await dump('overflow-en', compile, pdf);
      expect(warnings).toEqual([
        {
          code: 'page-design-overflow',
          at: 'regions.footer',
          page: 1,
          pages: 1,
        },
      ]);
    },
  );
});

describe('a refused PDF keeps its layout warnings (#554)', () => {
  it(
    'gives them with the reasons when PDF/UA-1 refuses the document',
    { timeout: 120_000 },
    async () => {
      const manual = manualIn('en');
      const long = Array.from(
        { length: 12 },
        (_, i) =>
          `      [#p${i}]\n      A long footer paragraph that takes its line.`,
      ).join('\n\n');
      const yaml = designYaml('minimal').replace(
        '  footer:\n    en: |-\n      [#keep]\n      Keep this manual with the pump.',
        `  footer:\n    en: |-\n${long}`,
      );
      const design = resolved(yaml, manual, 'en');
      // A character no font shows, which PDF/UA-1 refuses.
      const compile = input(
        { ...manual, title: `${manual.title} \u{7}` },
        design,
      );
      let error: unknown;
      try {
        await compilePdfReportInWorker(compile);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(TypstAccessibilityError);
      expect(
        (error as TypstAccessibilityError).problems.length,
      ).toBeGreaterThan(0);
      expect((error as TypstAccessibilityError).warnings).toEqual([
        {
          code: 'page-design-overflow',
          at: 'regions.footer',
          page: 1,
          pages: 1,
        },
      ]);
    },
  );
});

describe('layoutWarnings', () => {
  it('keeps one warning per code and place, with its first page and count', () => {
    expect(
      layoutWarnings([
        {
          code: 'running-head-truncated',
          at: 'header.default.right',
          page: 5,
          text: 'x',
        },
        {
          code: 'running-head-truncated',
          at: 'header.default.right',
          page: 3,
          text: 'x',
        },
        { code: 'page-design-overflow', at: 'regions.footer', page: 1 },
        { code: 'something-else', at: 'x', page: 1 },
        { code: 'page-design-overflow', at: 'x\n[forged] log line', page: 1 },
        { code: 'page-design-overflow', at: '', page: 1 },
        'nonsense',
      ]),
    ).toEqual([
      { code: 'page-design-overflow', at: 'regions.footer', page: 1, pages: 1 },
      {
        code: 'running-head-truncated',
        at: 'header.default.right',
        page: 3,
        pages: 2,
        text: 'x',
      },
    ]);
  });

  it('takes a safety message split only at a safety message’s place, counted apart (#668)', () => {
    const split = (at: string) => ({
      code: 'safety-message-split',
      at,
      page: 4,
      text: 'Crushing',
    });
    expect(
      layoutWarnings([
        split('safety.crush-hazard.notice'),
        split('safety.crush-hazard'),
        split('safety'),
        split('regions.footer'),
        split('callouts.parts.photo.lid'),
        {
          code: 'page-design-overflow',
          at: 'safety.crush-hazard.notice',
          page: 1,
        },
      ]),
    ).toEqual([
      {
        code: 'safety-message-split',
        at: 'safety.crush-hazard.notice',
        page: 4,
        pages: 1,
        text: 'Crushing',
      },
    ]);
    const many = layoutWarnings([
      ...Array.from({ length: MAX_LAYOUT_WARNINGS + 5 }, (_, i) =>
        split(`safety.m${i}.notice`),
      ),
      { code: 'page-design-overflow', at: 'regions.footer', page: 2 },
    ]);
    expect(many.filter((w) => w.code === 'safety-message-split')).toHaveLength(
      MAX_LAYOUT_WARNINGS,
    );
    expect(many.map((w) => w.code)).toContain('page-design-overflow');
  });

  it('takes a callout legend cut off only at a callout’s place, counted apart from the design’s (#548)', () => {
    const callout = (at: string, page = 3) => ({
      code: 'callout-label-overflow',
      at,
      page,
    });
    expect(
      layoutWarnings([
        callout('callouts.parts.photo.lid'),
        callout('callouts.parts.photo'),
        callout('regions.footer'),
        callout('callouts.parts.photo.lid.extra'),
        callout('callouts.Parts.photo.lid'),
        {
          code: 'page-design-overflow',
          at: 'callouts.parts.photo.lid',
          page: 1,
        },
      ]),
    ).toEqual([
      {
        code: 'callout-label-overflow',
        at: 'callouts.parts.photo.lid',
        page: 3,
        pages: 1,
      },
    ]);
    const many = layoutWarnings([
      ...Array.from({ length: MAX_LAYOUT_WARNINGS + 5 }, (_, i) =>
        callout(`callouts.parts.photo.c${i}`, 1),
      ),
      { code: 'page-design-overflow', at: 'regions.footer', page: 2 },
    ]);
    expect(
      many.filter((w) => w.code === 'callout-label-overflow'),
    ).toHaveLength(MAX_LAYOUT_WARNINGS);
    expect(many.map((w) => w.code)).toContain('page-design-overflow');
  });
});

void designData;

describe('an uploaded font (#555)', () => {
  it(
    'sets the headings in the design’s font, from its file alone, as WOFF too',
    { timeout: 120_000 },
    async () => {
      const manual = manualIn('en');
      // A family no other font has: the theme's Geist Mono (SIL OFL 1.1), renamed. Typst
      // would know it as "Sketch Mono" (a style word cut off): loaded as the role's own family.
      const ttf = renamedFont(
        themeFont('ttf/GeistMono-Bold.ttf'),
        'Sketch Mono Black',
      );
      const reference = `sha256:${'5'.repeat(64)}`;
      const designed = (fonts: string) =>
        resolved(designYaml('classic', fonts), manual, 'en');
      const fonts = [
        'fonts:',
        '  heading:',
        '    family: Sketch Mono Black',
        `    regular: ${reference}`,
        '  embeddingAllowed: true',
      ].join('\n');
      const plain = input(manual, designed(''));
      const design = designed(fonts);
      const family = designFontFamily('heading');
      expect(renderTypst(manual, { design }).fonts).toEqual([
        { file: reference, family },
      ]);
      const withFont = {
        ...input(manual, design),
        fonts: [{ data: ttf, family }],
      };
      const { pdf } = await compilePdfReportInWorker(withFont);
      await dump('uploaded-font-en', withFont, pdf);
      expect(Buffer.from(pdf).toString('latin1')).toMatch(
        /\/BaseFont\s*\/[A-Z]{6}\+SketchMonoBlack-Regular/,
      );
      const page = await sketch(withFont, 3);
      const fallback = await sketch(plain, 3);
      expect(page).not.toEqual(fallback);
      // Under its own name Typst would not find it for the family the design names.
      const designFamily = {
        ...withFont,
        inputs: {
          ...withFont.inputs,
          'openfolia-design': (
            withFont.inputs?.['openfolia-design'] ?? ''
          ).replace(family, 'Sketch Mono Black'),
        },
        fonts: [ttf],
      };
      expect(await sketch(designFamily, 3)).toEqual(fallback);
      expect(page).toMatchSnapshot('first content page, headings in the font');
      // The same font as WOFF: decoded in the compiling process, the same page.
      expect(
        await sketch(
          { ...withFont, fonts: [{ data: woffFromSfnt(ttf), family }] },
          3,
        ),
      ).toEqual(page);
    },
  );
});
