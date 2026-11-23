import fc from 'fast-check';
import { sampleConfig } from '../fixtures/config.js';
import { calloutModuleArb } from '../fixtures/module-arbitrary.js';
import { parseModule } from './asciidoc/parse.js';
import { printModule } from './asciidoc/print.js';
import {
  Block as BlockSchema,
  type Block,
  type Callout,
  type Image,
} from './blocks.js';
import {
  calloutNumber,
  calloutNumbers,
  calloutRefs,
  numberCallouts,
  roundCoordinate,
} from './callouts.js';
import { ProjectConfig } from './config.js';
import type { Inline } from './inline.js';
import type { Manifest } from './manifest.js';
import { Module } from './module.js';
import { normalizeModule } from './normalize.js';
import { resolveManual, type ResolvedEntry } from './resolve.js';
import { linkedTermIds } from './term-links.js';
import { validateModule } from './validate.js';

const config = ProjectConfig.parse({
  ...sampleConfig,
  calloutStyles: [{ id: 'square', label: 'Square' }],
});
const t = (text: string): Inline => ({ type: 'text', text });
const ref = (block: string, callout: string): Inline => ({
  type: 'calloutRef',
  block,
  callout,
});
const callout = (
  id: string,
  x: number,
  y: number,
  extra: Partial<Callout> = {},
): Callout => ({ id, anchor: { x, y }, legend: [t(`Legend ${id}`)], ...extra });
const image = (id: string, callouts: Callout[], extra: Partial<Image> = {}) =>
  ({
    type: 'image',
    id,
    asset: `sha256:${'ab'.repeat(32)}`,
    alt: 'Front of the unit',
    callouts,
    ...extra,
  }) satisfies Image;
const moduleOf = (blocks: unknown[], id = 'front') =>
  Module.parse({
    schemaVersion: 1,
    id,
    meta: { title: 'Front panel', type: 'concept', lang: 'en' },
    blocks,
  });
const ids = (numbered: { callout: Callout }[]) =>
  numbered.map((n) => n.callout.id);

describe('numberCallouts', () => {
  it('counts in reading order: rows top to bottom, left to right in a row', () => {
    const img = image('img', [
      callout('bottom', 0.1, 0.9),
      callout('right', 0.8, 0.21),
      callout('left', 0.2, 0.23),
      callout('top', 0.9, 0.02),
    ]);
    expect(ids(numberCallouts(img))).toEqual([
      'top',
      'left',
      'right',
      'bottom',
    ]);
    expect(numberCallouts(img).map((n) => n.number)).toEqual([1, 2, 3, 4]);
  });

  it('reads a callout at its label, where the number is drawn', () => {
    const img = image('img', [
      callout('a', 0.5, 0.1, { label: { x: 0.5, y: 0.9 } }),
      callout('b', 0.5, 0.5),
    ]);
    expect(ids(numberCallouts(img))).toEqual(['b', 'a']);
  });

  it('keeps the stored order for ties, and the bottom edge in the last row', () => {
    const img = image('img', [
      callout('first', 0.5, 1),
      callout('second', 0.5, 1),
      callout('above', 0.9, 0.96),
    ]);
    expect(ids(numberCallouts(img))).toEqual(['first', 'second', 'above']);
  });

  it('starts a row at a band edge, as the author typed it (0.3, not 0.29999…)', () => {
    for (const edge of [0.15, 0.3, 0.35, 0.6, 0.7, 0.95]) {
      // At the edge: the row below the one just above it, so read after it, whatever x says.
      const img = image('img', [
        callout('edge', 0.1, edge),
        callout('above', 0.9, edge - 0.01),
      ]);
      expect(ids(numberCallouts(img)), String(edge)).toEqual(['above', 'edge']);
    }
  });

  it("counts in the author's order with calloutOrder manual", () => {
    const img = image('img', [callout('z', 0.9, 0.9), callout('a', 0.1, 0.1)], {
      calloutOrder: 'manual',
    });
    expect(ids(numberCallouts(img))).toEqual(['z', 'a']);
  });

  it('counts only the visible callouts, without gaps', () => {
    const img = image('img', [
      callout('a', 0.1, 0.1),
      callout('b', 0.2, 0.1, {
        when: { op: 'in', attr: 'model', values: ['l-400'] },
      }),
      callout('c', 0.3, 0.1),
    ]);
    const hides = () => false;
    expect([...calloutNumbers(img, hides)]).toEqual([
      ['a', 1],
      ['c', 2],
    ]);
    expect([...calloutNumbers(img)]).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
  });

  it('gives an image without callouts no numbers', () => {
    expect(numberCallouts({})).toEqual([]);
  });
});

describe('the callout model', () => {
  it('refuses a callout ID another block or callout of the module has', () => {
    const clash = moduleOf.bind(null, [
      image('img', [callout('img', 0.1, 0.1)]),
    ]);
    expect(clash).toThrow(/duplicate callout id \\"img\\"/);
    expect(() =>
      moduleOf([
        image('img', [callout('a', 0.1, 0.1), callout('a', 0.2, 0.2)]),
      ]),
    ).toThrow(/duplicate callout id \\"a\\"/);
    expect(() =>
      moduleOf([
        image('one', [callout('a', 0.1, 0.1)]),
        image('two', [callout('a', 0.2, 0.2)]),
      ]),
    ).toThrow(/duplicate callout id \\"a\\"/);
  });

  it('refuses coordinates outside the image, an empty legend and too many callouts', () => {
    expect(() => moduleOf([image('img', [callout('a', 1.01, 0)])])).toThrow();
    expect(() => moduleOf([image('img', [callout('a', 0, -0.1)])])).toThrow();
    expect(() =>
      moduleOf([image('img', [callout('a', 0, 0, { legend: [] })])]),
    ).toThrow();
    expect(() =>
      moduleOf([
        image('img', [
          callout('a', 0, 0, { legend: [t('a'), { type: 'hardBreak' }] }),
        ]),
      ]),
    ).toThrow();
    const many = Array.from({ length: 101 }, (_, i) => callout(`c${i}`, 0, 0));
    expect(() => moduleOf([image('img', many)])).toThrow(/at most 100/);
  });

  it('refuses an empty callout list: no callouts is no list', () => {
    expect(() => moduleOf([image('img', [])])).toThrow(/leave the list out/);
  });

  it('normalizes: coordinates rounded, no default order', () => {
    const module = moduleOf([
      image(
        'img',
        [callout('a', 0.123456, -0, { label: { x: 1, y: 0.00004 } })],
        {
          calloutOrder: 'reading',
        },
      ),
    ]);
    const [a] = normalizeModule(module).blocks as Image[];
    expect(a?.callouts?.[0]?.anchor).toEqual({ x: 0.1235, y: 0 });
    expect(Object.is(a?.callouts?.[0]?.anchor.y, -0)).toBe(false);
    expect(a?.callouts?.[0]?.label).toEqual({ x: 1, y: 0 });
    expect(a).not.toHaveProperty('calloutOrder');
    expect(roundCoordinate(0.99995)).toBe(1);
  });

  it("finds term links and callout references in an image's legends", () => {
    const module = moduleOf([
      image('img', [
        callout('a', 0.1, 0.1, {
          legend: [
            {
              type: 'text',
              text: 'charger',
              marks: [{ type: 'term', termId: 'charger' }],
            },
            t(', see '),
            ref('img', 'b'),
          ],
        }),
        callout('b', 0.2, 0.2),
      ]),
      { type: 'paragraph', id: 'p', content: [t('Press '), ref('img', 'a')] },
    ]);
    expect(linkedTermIds(module.blocks)).toEqual(['charger']);
    expect([...calloutRefs(module.blocks)]).toEqual([
      { image: 'img', callout: 'b', blockId: 'img' },
      { image: 'img', callout: 'a', blockId: 'p' },
    ]);
  });
});

describe('callouts in AsciiDoc', () => {
  const source = `= Front panel
:schema-version: 1
:module-type: concept
:lang: en

[#front-view]
.Front view
image::sha256:${'ab'.repeat(32)}["Front of the unit",width=50%,callout-order=manual]
<.> [callout#power-switch,x=0.25,y=0.4,label-x=0.1,label-y=0.05,style=square] **Power** switch
<.> [callout#filter,x=0.6,y=0.55,when="model in (l-400)"] Filter \\[behind the cover\\]

[#p]
Press the switch callout:front-view#power-switch[], then open the filter callout:front-view#filter[].
`;

  it('reads a callout list below the image macro, and writes it back byte for byte', () => {
    const module = parseModule(source, { id: 'front' });
    const [img, p] = module.blocks as [Image, Block];
    expect(img.calloutOrder).toBe('manual');
    expect(img.callouts).toEqual([
      {
        id: 'power-switch',
        anchor: { x: 0.25, y: 0.4 },
        label: { x: 0.1, y: 0.05 },
        legend: [
          { type: 'text', text: 'Power', marks: [{ type: 'strong' }] },
          t(' switch'),
        ],
        style: 'square',
      },
      {
        id: 'filter',
        anchor: { x: 0.6, y: 0.55 },
        legend: [t('Filter [behind the cover]')],
        when: { op: 'in', attr: 'model', values: ['l-400'] },
      },
    ]);
    expect(p).toEqual({
      type: 'paragraph',
      id: 'p',
      content: [
        t('Press the switch '),
        ref('front-view', 'power-switch'),
        t(', then open the filter '),
        ref('front-view', 'filter'),
        t('.'),
      ],
    });
    expect(printModule(module)).toBe(source);
  });

  it('escapes text that would read as a callout reference', () => {
    const module = moduleOf([
      {
        type: 'paragraph',
        id: 'p',
        content: [t('callout:a#b[] <.> [callout#x]')],
      },
    ]);
    const printed = printModule(module);
    expect(printed).toContain('\\callout:a\\#b\\[\\]');
    expect(parseModule(printed, { id: 'front' })).toEqual(module);
  });

  it.each([
    ['<1> [callout#a,x=0,y=0] A', /numbers are derived/],
    ['<.> A', /attribute list/],
    ['<.> [callout#a,x=0] A', /needs y=/],
    ['<.> [callout#a,x=0,y=0,label-x=1] A', /both label-x= and label-y=/],
    [
      '<.> [callout#a,x=0,y=0,colour=red] A',
      /unknown callout attribute "colour"/,
    ],
    ['<.> [callout#a,x=-1,y=0] A', /from 0 to 1/],
    ['<.> [callout#a,x=2,y=0] A', /invalid module/],
    ['<.> [callout#a,x=0,y=0]', /legend/],
    ['<.> [callout#a,x=0,y=0', /missing "]"/],
    ['<.> [#a,x=0,y=0] A', /expected \[callout#<id>/],
  ])('refuses the callout line %s', (line, error) => {
    const file = `= T\n:schema-version: 1\n:module-type: concept\n:lang: en\n\n[#img]\nimage::sha256:${'ab'.repeat(32)}["Alt"]\n${line}\n`;
    expect(() => parseModule(file, { id: 'x' })).toThrow(error);
  });

  it('refuses a malformed callout reference', () => {
    const file = `= T\n:schema-version: 1\n:module-type: concept\n:lang: en\n\n[#p]\nSee callout:img[].\n`;
    expect(() => parseModule(file, { id: 'x' })).toThrow(
      /invalid callout reference/,
    );
  });

  it('reads `callout:` in prose as text, as files from before callouts have it', () => {
    const file = `= About callout: 1\n:schema-version: 1\n:module-type: concept\n:lang: en\n\n[#p]\nCheck the callout: it is red, miscallout:x too.\n`;
    const module = parseModule(file, { id: 'x' });
    expect(module.meta.title).toBe('About callout: 1');
    expect(module.blocks[0]).toEqual({
      type: 'paragraph',
      id: 'p',
      content: [
        {
          type: 'text',
          text: 'Check the callout: it is red, miscallout:x too.',
        },
      ],
    });
    expect(parseModule(printModule(module), { id: 'x' })).toEqual(module);
    // Right before markup too: no ID, so no reference.
    const marked = parseModule(
      file.replace(
        'red, miscallout:x too.',
        'red: [.ui]##callout:## and callout:[.term.foo]##x##.',
      ),
      { id: 'x' },
    );
    expect(parseModule(printModule(marked), { id: 'x' })).toEqual(marked);
    expect(JSON.stringify(marked.blocks)).not.toContain('calloutRef');
  });

  it('round-trips modules of images with callouts', () => {
    fc.assert(
      fc.property(calloutModuleArb, (module) => {
        const printed = printModule(module);
        const parsed = parseModule(printed, { id: module.id });
        expect(parsed).toEqual(normalizeModule(module));
        expect(printModule(parsed)).toBe(printed);
        // Numbering reads the same from the file as from the model.
        const numbers = (m: Module) =>
          (m.blocks as Image[]).map((img) => [...calloutNumbers(img)]);
        expect(numbers(parsed)).toEqual(numbers(normalizeModule(module)));
      }),
      { numRuns: 300 },
    );
  });
});

describe('validateModule and callouts', () => {
  it('reports references to a missing image or callout, and unknown styles and conditions', () => {
    const module = moduleOf([
      image('img', [
        callout('a', 0.1, 0.1, { style: 'hexagon' }),
        callout('b', 0.2, 0.2, {
          when: { op: 'in', attr: 'colour', values: ['red'] },
          legend: [{ type: 'attribute', name: 'no-such' }],
        }),
      ]),
      {
        type: 'paragraph',
        id: 'p',
        content: [
          ref('img', 'a'),
          ref('img', 'z'),
          ref('p', 'a'),
          ref('nothing', 'a'),
        ],
      },
    ]);
    expect(validateModule(module, config).map((i) => [i.code, i.at])).toEqual([
      ['unknown-callout-style', 'img'],
      ['unknown-text-attribute', 'img'],
      ['unknown-variant-attribute', 'img'],
      ['unknown-callout', 'p'],
      ['unknown-callout', 'p'],
      ['unknown-callout', 'p'],
    ]);
  });

  it('takes a configured style and a reference to a callout inside a variant block', () => {
    const module = moduleOf([
      {
        type: 'variant',
        id: 'v',
        when: { op: 'in', attr: 'model', values: ['l-400'] },
        blocks: [image('img', [callout('a', 0.1, 0.1, { style: 'square' })])],
      },
      { type: 'paragraph', id: 'p', content: [ref('img', 'a')] },
    ]);
    expect(validateModule(module, config)).toEqual([]);
  });
});

describe('resolveManual and callouts', () => {
  const l400 = { op: 'in' as const, attr: 'model', values: ['l-400'] };
  const front = moduleOf([
    {
      type: 'paragraph',
      id: 'before',
      content: [
        t('Press '),
        ref('img', 'switch'),
        t(' and '),
        ref('img', 'pairing'),
      ],
    },
    image('img', [
      callout('pairing', 0.5, 0.5, { when: l400 }),
      callout('filter', 0.9, 0.9, {
        legend: [
          t('Filter of the '),
          { type: 'attribute', name: 'product-name' },
        ],
      }),
      callout('switch', 0.1, 0.1),
    ]),
    {
      type: 'variant',
      id: 'v',
      when: l400,
      blocks: [image('img-l400', [callout('lever', 0.5, 0.5)])],
    },
    {
      type: 'paragraph',
      id: 'after',
      content: [ref('img-l400', 'lever'), ref('img', 'gone')],
    },
  ]);
  const reuse = moduleOf(
    [{ type: 'moduleRef', id: 'again', module: 'front' }],
    'reuse',
  );
  const modules = new Map([front, reuse].map((m) => [m.id, m]));
  const manifest: Manifest = {
    id: 'manual',
    title: 'Manual',
    attributes: { 'product-name': 'Unit' },
    variants: [],
    entries: [{ module: 'front' }, { module: 'reuse' }],
  } as unknown as Manifest;
  const resolve = (model: string) =>
    resolveManual({
      manifest,
      variant: { model },
      lang: 'en',
      config,
      loadModule: (id) => modules.get(id),
    });
  const blocksOf = (entry: ResolvedEntry | undefined) =>
    entry?.kind === 'module' ? entry.blocks : [];

  it('numbers the callouts a variant shows, without gaps, and gives each reference its number', () => {
    const { manual, issues } = resolve('l-200');
    const [before, img, after] = blocksOf(manual.entries[0]) as [
      Block & { content: Inline[] },
      Image,
      Block & { content: Inline[] },
    ];
    expect(img.callouts?.map((c) => c.id)).toEqual(['switch', 'filter']);
    expect(img.calloutOrder).toBe('manual');
    expect(img.callouts?.[1]?.legend).toEqual([t('Filter of the Unit')]);
    expect(img.callouts?.every((c) => c.when === undefined)).toBe(true);
    expect(manual.callouts?.['front--img']).toEqual({ switch: 1, filter: 2 });
    expect(before.content[1]).toEqual(ref('front--img', 'switch'));
    expect(calloutNumber(manual, before.content[1] as never)).toBe(1);
    // Hidden in this variant: no image (`_`, never an output ID), so no number.
    expect(before.content[3]).toEqual(ref('_', 'pairing'));
    expect(calloutNumber(manual, before.content[3] as never)).toBeUndefined();
    expect(after.content).toEqual([ref('_', 'lever'), ref('_', 'gone')]);
    // Still blocks of the model's schema, as the API's OpenAPI publishes them.
    for (const block of blocksOf(manual.entries[0]))
      expect(BlockSchema.safeParse(block).success).toBe(true);
    expect(
      issues
        .filter((i) => i.module === 'front')
        .map((i) => [i.code, i.severity, i.at?.block]),
    ).toEqual([
      ['hidden-callout', 'warning', 'before'],
      ['hidden-callout', 'warning', 'after'],
      ['unknown-callout', 'error', 'after'],
    ]);
  });

  it('numbers the same image again in a variant that shows more', () => {
    const { manual } = resolve('l-400');
    expect(manual.callouts?.['front--img']).toEqual({
      switch: 1,
      pairing: 2,
      filter: 3,
    });
    expect(manual.callouts?.['front--img-l400']).toEqual({ lever: 1 });
    const after = blocksOf(manual.entries[0])[3] as { content: Inline[] };
    expect(after.content[0]).toEqual(ref('front--img-l400', 'lever'));
  });

  it("links a module's references to its own copy of the image when it is included twice", () => {
    const { manual } = resolve('l-200');
    const [before] = blocksOf(manual.entries[1]) as unknown as [
      { content: Inline[] },
    ];
    expect(before.content[1]).toEqual(ref('front--img--2', 'switch'));
    expect(manual.callouts?.['front--img--2']).toEqual({
      switch: 1,
      filter: 2,
    });
  });

  it('reads a callout ID like __proto__ as any other', () => {
    const module = moduleOf([
      image('img', [callout('__proto__', 0.1, 0.1)]),
      {
        type: 'paragraph',
        id: 'p',
        content: [ref('img', '__proto__'), ref('img', 'constructor')],
      },
    ]);
    const { manual } = resolveManual({
      manifest: { ...manifest, entries: [{ module: 'front' }] } as Manifest,
      variant: {},
      lang: 'en',
      config,
      loadModule: () => module,
    });
    const [, p] = blocksOf(manual.entries[0]) as [Image, { content: Inline[] }];
    expect(calloutNumber(manual, p.content[0] as never)).toBe(1);
    expect(calloutNumber(manual, p.content[1] as never)).toBeUndefined();
  });
});
