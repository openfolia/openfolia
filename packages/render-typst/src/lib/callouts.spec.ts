import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Manifest,
  Module,
  parsePageDesign,
  ProjectConfig,
  resolveManual,
  resolvePageDesign,
  type Block,
  type Callout,
  type CalloutLegend,
  type Inline,
  type ResolvedManual,
} from '@openfolia/content-model';
import {
  closeWorkerPool,
  compilePagePngInWorker,
  compilePdf,
  compilePdfReport,
  type CompileInput,
} from './compile.js';
import { CALLOUT_MIN_SIZE_INPUT, calloutFunctions } from './callouts.js';
import { designTemplate, type LayoutWarning } from './design.js';
import { DEFAULT_TEMPLATE } from './template.js';
import { renderTypst } from './render.js';
import { pagePixels, sketch } from '../testing/page-image.js';

// Image callouts in print (#546): markers and leader lines over the image, the legend under or
// beside it, references as the marker's number.

afterAll(() => closeWorkerPool());

/** Set to a directory to write each picture test's page there (for the PR's pictures). */
const DUMP = process.env['CCMS_CALLOUT_DUMP'];

const ASSET = `sha256:${'c'.repeat(64)}`;
/** A 400 × 300 picture in one flat light blue, so the tests find it on the page and the markers show on it. */
const PICTURE = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#cce0ff"/></svg>',
);
const files = { [`assets/${'c'.repeat(64)}`]: PICTURE };

const text = (t: string): Inline => ({ type: 'text', text: t });
const ref = (callout: string): Inline => ({
  type: 'calloutRef',
  block: 'machine',
  callout,
});

const config = ProjectConfig.parse({
  languages: { source: 'en', targets: ['ar'] },
  moduleTypes: [{ id: 'concept', label: 'Concept' }],
  audiences: [{ id: 'public', label: 'Public' }],
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
  calloutStyles: [{ id: 'square', label: 'Square' }],
});

/** Three callouts, the filter only on the large model. */
const CALLOUTS: Callout[] = [
  {
    id: 'switch',
    anchor: { x: 0.2, y: 0.25 },
    legend: [text('Power switch')],
  },
  {
    id: 'filter',
    anchor: { x: 0.5, y: 0.5 },
    label: { x: 0.8, y: 0.15 },
    legend: [
      text('Filter, '),
      { type: 'text', text: 'cleaned daily', marks: [{ type: 'strong' }] },
    ],
    when: { op: 'in', attr: 'model', values: ['large'] },
    style: 'square',
  },
  {
    id: 'lamp',
    anchor: { x: 0.7, y: 0.8 },
    legend: [text('Status lamp')],
  },
];

function moduleWith(
  lang: string,
  image: {
    callouts?: Callout[];
    calloutLegend?: CalloutLegend;
    width?: number;
  },
): Module {
  const blocks: Block[] = [
    {
      type: 'paragraph',
      id: 'intro',
      content: [
        text('Switch on with '),
        ref('switch'),
        text(', check the lamp '),
        ref('lamp'),
        text(' and the filter '),
        ref('filter'),
        text('.'),
      ],
    },
    {
      type: 'image',
      id: 'machine',
      asset: ASSET,
      alt: 'The machine from the front',
      title: [text('The machine')],
      callouts: image.callouts ?? CALLOUTS,
      ...(image.calloutLegend ? { calloutLegend: image.calloutLegend } : {}),
      ...(image.width ? { width: image.width } : {}),
    },
  ];
  return Module.parse({
    schemaVersion: 1,
    id: 'machine',
    meta: {
      title: 'The machine',
      type: 'concept',
      lang,
      audience: 'public',
      facets: {},
    },
    blocks,
  });
}

const manifest = Manifest.parse({
  schemaVersion: 1,
  id: 'operating',
  title: 'Operating manual',
  variants: [{ model: 'small' }, { model: 'large' }],
  entries: [{ module: 'machine' }],
});

function resolved(
  model: 'small' | 'large',
  image: Parameters<typeof moduleWith>[1] = {},
  lang = 'en',
): ResolvedManual {
  const module = moduleWith(lang, image);
  return resolveManual({
    manifest,
    variant: { model },
    lang,
    config,
    loadModule: () => module,
  }).manual;
}

/** The generated document's image call. */
const imageCall = (source: string) =>
  /#figure\(kind: image, callout-image\(.*\), caption: /.exec(source)?.[0] ??
  '';

describe('callouts in the generated document', () => {
  it('numbers the markers, the legend and the references by the variant, with no gaps', () => {
    const large = renderTypst(resolved('large')).source;
    const small = renderTypst(resolved('small')).source;
    // Reading order: the switch (top), the filter (its label, higher still), the lamp.
    expect(imageCall(large)).toContain(
      'markers: ((n: 1, x: 0.5000, y: 0.5000, label: (x: 0.8000, y: 0.1500), style: "square"), (n: 2, x: 0.2000, y: 0.2500, label: none, style: ""), (n: 3, x: 0.7000, y: 0.8000, label: none, style: ""),)',
    );
    expect(imageCall(large)).toContain(
      'legend: ((n: 1, body: [#"Filter, "#strong[#"cleaned daily"]], at: "callouts.machine.machine.filter"), (n: 2, body: [#"Power switch"], at: "callouts.machine.machine.switch"), (n: 3, body: [#"Status lamp"], at: "callouts.machine.machine.lamp"),)',
    );
    expect(large).toContain(
      '#"Switch on with "#callout-ref(2)#", check the lamp "#callout-ref(3)#" and the filter "#callout-ref(1)',
    );
    // The small model leaves the filter out: 1 and 2, and its reference reads "?".
    expect(imageCall(small)).toContain(
      'markers: ((n: 1, x: 0.2000, y: 0.2500, label: none, style: ""), (n: 2, x: 0.7000, y: 0.8000, label: none, style: ""),)',
    );
    expect(small).toContain(
      '#callout-ref(1)#", check the lamp "#callout-ref(2)#" and the filter "#callout-ref(none)',
    );
  });

  it('passes the legend placement and the width, below by default', () => {
    expect(imageCall(renderTypst(resolved('large')).source)).toContain(
      'width: auto, markers:',
    );
    expect(imageCall(renderTypst(resolved('large')).source)).toContain(
      'placement: "below")',
    );
    const beside = renderTypst(
      resolved('large', { calloutLegend: 'beside', width: 50 }),
    ).source;
    expect(imageCall(beside)).toContain('width: 50%, markers:');
    expect(imageCall(beside)).toContain('placement: "beside")');
  });

  it('defines the callout functions for a template without them, only where it draws callouts', () => {
    expect(renderTypst(resolved('large')).source).toContain(
      '#let callout-image(',
    );
    const plain = resolveManual({
      manifest: Manifest.parse({ ...manifest, entries: [{ module: 'other' }] }),
      variant: { model: 'large' },
      lang: 'en',
      config,
      loadModule: () =>
        Module.parse({
          schemaVersion: 1,
          id: 'other',
          meta: {
            title: 'Other',
            type: 'concept',
            lang: 'en',
            audience: 'public',
            facets: {},
          },
          blocks: [{ type: 'paragraph', id: 'p', content: [text('Text')] }],
        }),
    }).manual;
    expect(renderTypst(plain).source).not.toContain('callout-');
  });

  it('writes every text as a string literal and every number itself', () => {
    const hostile = '"]) #eval("1") \\ ] [';
    const manual = resolved('large', {
      callouts: [
        {
          id: 'x',
          anchor: { x: 0.1, y: 0.2 },
          legend: [text(hostile)],
          style: 'square',
        },
      ],
    });
    // An unvalidated manual: values the renderer must not write as they are.
    const image =
      manual.entries[0]?.kind === 'module'
        ? manual.entries[0].blocks[1]
        : undefined;
    if (image?.type !== 'image') throw new Error('no image');
    const [callout] = image.callouts ?? [];
    Object.assign(callout as object, {
      anchor: { x: Number.NaN, y: 5 },
      style: '") + eval("1',
    });
    Object.assign(image, {
      width: '1%) #eval("2") (',
      calloutLegend: '") #eval("3',
    });
    const call = imageCall(renderTypst(manual).source);
    expect(call).toContain('#"\\"]) #eval(\\"1\\") \\\\ ] ["');
    expect(call).toContain('x: 0.0000, y: 1.0000');
    expect(call).toContain('style: "\\") + eval(\\"1"');
    expect(call).toContain('width: auto,');
    expect(call).toContain('placement: "below")');
    expect(() =>
      compilePdf({ source: renderTypst(manual).source, files }),
    ).not.toThrow();
  });
});

describe('callouts in print', () => {
  it('compiles with a template that defines no callout functions: the document’s own stand in', () => {
    const before = DEFAULT_TEMPLATE.replace(calloutFunctions('theme'), '');
    expect(before).not.toContain('callout-');
    const pdf = compilePdf({
      source: renderTypst(resolved('large')).source,
      files,
      template: before,
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('compiles to PDF/UA-1 in both variants', () => {
    for (const model of ['small', 'large'] as const) {
      const pdf = compilePdf({
        source: renderTypst(resolved(model)).source,
        files,
      });
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    }
  });

  const compileOf = (
    manual: ResolvedManual,
    template?: string,
  ): CompileInput => ({
    source: renderTypst(manual).source,
    files,
    ...(template ? { template } : {}),
  });

  async function dump(name: string, compile: CompileInput) {
    if (!DUMP) return;
    mkdirSync(DUMP, { recursive: true });
    writeFileSync(
      join(DUMP, `${name}.png`),
      await compilePagePngInWorker(compile, { number: 3, width: 900 }),
    );
  }

  // The content starts on page 3, after the title page and the contents.
  for (const [name, image, lang] of [
    ['the legend below', {}, 'en'],
    ['the legend beside', { calloutLegend: 'beside' }, 'en'],
    ['no legend', { calloutLegend: 'none' }, 'en'],
    ['a scaled image', { width: 40 }, 'en'],
    [
      'a full-width image beside its legend',
      { calloutLegend: 'beside', width: 100 },
      'en',
    ],
    ['right to left, the legend beside', { calloutLegend: 'beside' }, 'ar'],
    ['right to left, the legend below', {}, 'ar'],
  ] as const) {
    it(`lays out ${name}`, { timeout: 120_000 }, async () => {
      const compile = compileOf(resolved('large', image, lang));
      await dump(name.replaceAll(' ', '-').replaceAll(',', ''), compile);
      expect(await sketch(compile, 3)).toMatchSnapshot();
    });
  }

  it(
    'lays out the callouts in a page design',
    { timeout: 120_000 },
    async () => {
      const manual = resolved('large', { calloutLegend: 'beside' });
      const design = resolvePageDesign({
        design: parsePageDesign(
          'schemaVersion: 1\nname: Test\npreset: classic\npage:\n  size: a4\ncolours:\n  primary: "#7a1f4e"\n  accent: "#b45309"\n  text: "#1f2328"\n',
          { id: 'test' },
        ),
        manifest,
        variant: { model: 'large' },
        lang: 'en',
        config,
      }).design;
      const { source, inputs } = renderTypst(manual, { design });
      const compile: CompileInput = {
        source,
        files,
        inputs,
        template: designTemplate(design.preset),
      };
      await dump('page-design', compile);
      expect(await sketch(compile, 3)).toMatchSnapshot();
    },
  );

  /** Where the picture is on page 3 and the centre of the marker ink on it, in pixels. */
  async function markerOnPicture(compile: CompileInput) {
    const { pixels, width, height } = await pagePixels(compile, 3, 1200);
    const at = (x: number, y: number) => {
      const i = (y * width + x) * 4;
      return [pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0] as const;
    };
    let left = width;
    let right = -1;
    let top = height;
    let bottom = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = at(x, y);
        if (b > 245 && r > 190 && r < 215 && g > 212 && g < 236) {
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    }
    // The marker: the theme's primary colour, a green, where the picture is light blue.
    let sx = 0;
    let sy = 0;
    let count = 0;
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        const [r, g, b] = at(x, y);
        if (g > b + 20 && g > r) {
          sx += x;
          sy += y;
          count++;
        }
      }
    }
    expect(count).toBeGreaterThan(0);
    return {
      x: (sx / count - left) / (right - left + 1),
      y: (sy / count - top) / (bottom - top + 1),
      pageX: (left + right) / 2 / width,
    };
  }

  for (const lang of ['en', 'ar']) {
    it(
      `draws a marker at its anchor, never mirrored (${lang})`,
      { timeout: 120_000 },
      async () => {
        const manual = resolved(
          'large',
          {
            callouts: [
              {
                id: 'switch',
                anchor: { x: 0.25, y: 0.3 },
                legend: [text('Switch')],
              },
            ],
            width: 60,
          },
          lang,
        );
        const found = await markerOnPicture(compileOf(manual));
        expect(found.x).toBeCloseTo(0.25, 1);
        expect(Math.abs(found.x - 0.25)).toBeLessThan(0.015);
        expect(Math.abs(found.y - 0.3)).toBeLessThan(0.015);
        // The picture itself follows the text: at the start of the line, the right in Arabic.
        expect(found.pageX < 0.5).toBe(lang === 'en');
      },
    );
  }
  describe('a legend beside its image that does not fit (#548)', () => {
    /** `count` callouts down the image, each legend `words` words of a long German text. */
    const crowded = (count: number, words: number): Callout[] =>
      Array.from({ length: count }, (_, i) => ({
        id: `c${i + 1}`,
        anchor: { x: 0.5, y: (i + 0.5) / count },
        legend: [
          text(
            Array.from(
              { length: words },
              (_, w) =>
                [
                  'Sicherheitsabschaltvorrichtung',
                  'des',
                  'Hauptschalters',
                  'prüfen',
                  'und',
                  'Wartungsklappe',
                ][(w + i) % 6],
            ).join(' '),
          ),
        ],
      }));
    const report = (
      callouts: Callout[],
      calloutLabelMinSize?: number,
    ): { warnings: LayoutWarning[]; compile: CompileInput } => {
      const manual = resolved('large', {
        callouts,
        calloutLegend: 'beside',
      });
      const { source, inputs } = renderTypst(manual, {
        ...(calloutLabelMinSize !== undefined && { calloutLabelMinSize }),
      });
      const compile: CompileInput = { source, files, inputs };
      return { warnings: compilePdfReport(compile).warnings, compile };
    };

    it('passes the smallest size only to a document with a legend beside an image', () => {
      expect(
        renderTypst(resolved('large', { calloutLegend: 'beside' })).inputs,
      ).toEqual({ [CALLOUT_MIN_SIZE_INPUT]: '6' });
      expect(
        renderTypst(resolved('large', { calloutLegend: 'beside' }), {
          calloutLabelMinSize: 30,
        }).inputs,
      ).toEqual({ [CALLOUT_MIN_SIZE_INPUT]: '12' });
      expect(renderTypst(resolved('large')).inputs).toEqual({});
    });

    it(
      'fits a legend that shrinks into the image’s height: nothing reported',
      { timeout: 120_000 },
      () => {
        // Too tall at the text's size (a smallest size of 12 pt shrinks nothing), it fits smaller.
        expect(report(crowded(5, 12), 12).warnings).not.toEqual([]);
        expect(report(crowded(5, 12)).warnings).toEqual([]);
      },
    );

    it(
      'cuts off what still does not fit at the smallest size and reports each callout cut',
      { timeout: 120_000 },
      async () => {
        const { warnings, compile } = report(crowded(8, 16), 8);
        await dump('a-legend-beside-cut-off', compile);
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings.length).toBeLessThan(8);
        for (const w of warnings) {
          expect(w).toMatchObject({
            code: 'callout-label-overflow',
            page: 3,
            pages: 1,
          });
          expect(w.at).toMatch(/^callouts\.machine\.machine\.c[0-9]$/);
        }
        // The last callout is among them, the first is not.
        const at = warnings.map((w) => w.at);
        expect(at).toContain('callouts.machine.machine.c8');
        expect(at).not.toContain('callouts.machine.machine.c1');
        expect(await sketch(compile, 3)).toMatchSnapshot();
      },
    );

    it(
      'reports nothing for the same legend below the image: it only wraps',
      { timeout: 120_000 },
      () => {
        const manual = resolved('large', { callouts: crowded(8, 40) });
        const { source, inputs } = renderTypst(manual);
        expect(compilePdfReport({ source, files, inputs }).warnings).toEqual(
          [],
        );
      },
    );
  });
});
