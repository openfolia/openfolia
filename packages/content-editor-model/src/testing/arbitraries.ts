import {
  type Block,
  type Callout,
  type Condition,
  type Inline,
  type Item,
  MAX_LIST_DEPTH,
  MAX_SECTION_DEPTH,
  type Mark,
  Module,
  SingleLine,
  type TableCell,
  type TextNode,
} from '@openfolia/content-model';
import fc from 'fast-check';
import { must } from './must.js';

/**
 * Random valid modules, for the round-trip property tests. Each generator
 * table below is typed by the content model's own unions, so a new block,
 * inline, mark or condition type fails to compile here until it has a
 * generator (and then the round trip shows whether the converters cover it).
 *
 * The modules are valid but not in normal form: marks out of order, empty
 * mark lists, neighbouring runs with the same marks and spans of 1 all occur.
 */

type BlockOf<K extends Block['type']> = Extract<Block, { type: K }>;
type InlineOf<K extends Inline['type']> = Extract<Inline, { type: K }>;
type MarkOf<K extends Mark['type']> = Extract<Mark, { type: K }>;
type ConditionOf<K extends Condition['op']> = Extract<Condition, { op: K }>;

// ---------------------------------------------------------------------------
// Text

const PIECES = [
  ' ',
  '  ',
  '\t',
  'a',
  'Word',
  '42',
  '<b>',
  '&amp;',
  '"',
  "'",
  '{name}',
  '*',
  '_',
  '\\',
  ' ',
  '​',
  'é',
  'ß',
  '中文',
  'Ω',
  '😀',
  '👩‍🔧',
];

/** No line breaks or other control characters but tab. */
const plain = (s: string) =>
  [...s].every((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code === 0x09 || (code >= 0x20 && code !== 0x7f);
  });

const text: fc.Arbitrary<string> = fc.oneof(
  fc
    .array(fc.constantFrom(...PIECES), { minLength: 1, maxLength: 5 })
    .map((parts) => parts.join('')),
  fc.string({ unit: 'grapheme', minLength: 1, maxLength: 8 }).filter(plain),
);

const singleLine = text
  .map((s) => s.trim())
  .filter((s) => SingleLine.safeParse(s).success);

/** Multi-line text for literals and passthroughs: no carriage returns. */
const verbatim = fc
  .array(fc.oneof(text, fc.constantFrom('', '  indented', '<pre>', '----')), {
    maxLength: 4,
  })
  .map((lines) => lines.join('\n'));

const configKey = fc.constantFrom('a', 'model', 'rated-load', 'x-2');

// ---------------------------------------------------------------------------
// Marks and inline content

const markArbs: { [K in Mark['type']]: fc.Arbitrary<MarkOf<K>> } = {
  link: fc
    .constantFrom(
      'https://example.com/a?b=1',
      'http://example.org/x#y',
      'mailto:help@example.com',
    )
    .map((href) => ({ type: 'link' as const, href })),
  term: fc
    .constantFrom('charger', 'battery-pack', '2-step')
    .map((termId) => ({ type: 'term' as const, termId })),
  ui: fc.constant({ type: 'ui' as const }),
  strong: fc.constant({ type: 'strong' as const }),
  emphasis: fc.constant({ type: 'emphasis' as const }),
  code: fc.constant({ type: 'code' as const }),
  sub: fc.constant({ type: 'sub' as const }),
  sup: fc.constant({ type: 'sup' as const }),
};

const marks = (links: boolean) =>
  fc
    .uniqueArray(fc.oneof(...Object.values(markArbs)) as fc.Arbitrary<Mark>, {
      selector: (m) => m.type,
      maxLength: 3,
    })
    // A link and a term link never mark the same text: the link stays.
    .map((list) =>
      list.some((m) => m.type === 'link')
        ? list.filter((m) => m.type !== 'term')
        : list,
    )
    .map((list) =>
      links ? list : list.filter((m) => m.type !== 'link' && m.type !== 'term'),
    );

const textNode = (links: boolean): fc.Arbitrary<TextNode> =>
  fc
    .record({
      text,
      marks: fc.oneof(
        { weight: 3, arbitrary: fc.constant(undefined) },
        { weight: 1, arbitrary: fc.constant([] as Mark[]) },
        { weight: 4, arbitrary: marks(links) },
      ),
    })
    .map(({ text: t, marks: m }) =>
      m === undefined
        ? { type: 'text', text: t }
        : { type: 'text', text: t, marks: m },
    );

interface InlineCtx {
  breaks: boolean;
}

const inlineArbs: {
  [K in Inline['type']]: (ctx: InlineCtx) => fc.Arbitrary<InlineOf<K>> | null;
} = {
  text: () => textNode(true) as fc.Arbitrary<InlineOf<'text'>>,
  attribute: () =>
    configKey.map((name) => ({ type: 'attribute' as const, name })),
  xref: () =>
    fc
      .record(
        {
          module: fc.constantFrom('other-module', 'm1'),
          block: fc.constantFrom('target', '_t-1'),
          text: fc.array(textNode(false), { minLength: 1, maxLength: 2 }),
        },
        { requiredKeys: ['module'] },
      )
      .map((x) => ({ type: 'xref' as const, ...x })),
  kbd: () =>
    fc
      .array(fc.constantFrom('Ctrl', 'Shift', 'F1', '+', 'a b', '[x'), {
        minLength: 1,
        maxLength: 3,
      })
      .map((keys) => ({ type: 'kbd' as const, keys })),
  placeholder: () =>
    fc
      .constantFrom('title', 'page', 'document-number')
      .map((key) => ({ type: 'placeholder' as const, key })),
  calloutRef: () =>
    fc
      .record({
        block: fc.constantFrom('front-view', '_img-1'),
        callout: fc.constantFrom('power-switch', 'c1'),
      })
      .map((x) => ({ type: 'calloutRef' as const, ...x })),
  hardBreak: (ctx) =>
    ctx.breaks ? fc.constant({ type: 'hardBreak' as const }) : null,
};

function inlineContent(
  breaks: boolean,
  maxLength: number,
): fc.Arbitrary<Inline[]> {
  const options: { weight: number; arbitrary: fc.Arbitrary<Inline> }[] = [];
  for (const [type, make] of Object.entries(inlineArbs)) {
    const arbitrary = (make as (c: InlineCtx) => fc.Arbitrary<Inline> | null)({
      breaks,
    });
    if (arbitrary) options.push({ weight: type === 'text' ? 6 : 1, arbitrary });
  }
  return fc.array(fc.oneof(...options), { minLength: 1, maxLength });
}

const content = inlineContent(true, 6);
const titleContent = inlineContent(false, 4);

// ---------------------------------------------------------------------------
// Conditions

const conditionArbs: {
  [K in Condition['op']]: (
    depth: number,
  ) => fc.Arbitrary<ConditionOf<K>> | null;
} = {
  in: () =>
    fc.record({
      op: fc.constant('in' as const),
      attr: configKey,
      values: fc.array(fc.constantFrom('m-200', 'm-400', "odd value's", 'eu'), {
        minLength: 1,
        maxLength: 3,
      }),
    }),
  cmp: () =>
    fc.record({
      op: fc.constant('cmp' as const),
      attr: fc.constant('software'),
      cmp: fc.constantFrom(
        '<' as const,
        '<=' as const,
        '>' as const,
        '>=' as const,
      ),
      value: fc.constantFrom('2', '2.3', '10.0.1'),
    }),
  not: (depth) =>
    depth > 0
      ? condition(depth - 1).map((of) => ({ op: 'not' as const, of }))
      : null,
  all: (depth) =>
    depth > 0
      ? fc
          .array(condition(depth - 1), { minLength: 2, maxLength: 3 })
          .map((of) => ({ op: 'all' as const, of }))
      : null,
  any: (depth) =>
    depth > 0
      ? fc
          .array(condition(depth - 1), { minLength: 2, maxLength: 3 })
          .map((of) => ({ op: 'any' as const, of }))
      : null,
};

function condition(depth: number): fc.Arbitrary<Condition> {
  const options: fc.Arbitrary<Condition>[] = [];
  for (const make of Object.values(conditionArbs)) {
    const arbitrary = (make as (d: number) => fc.Arbitrary<Condition> | null)(
      depth,
    );
    if (arbitrary) options.push(arbitrary);
  }
  return fc.constant(null).chain(() => fc.oneof(...options));
}

// ---------------------------------------------------------------------------
// Blocks. IDs are filled in afterwards, so every module has unique ones.

const ID = '';

const point = fc.record({
  x: fc.oneof(fc.double({ min: 0, max: 1, noNaN: true }), fc.constant(1)),
  y: fc.oneof(fc.double({ min: 0, max: 1, noNaN: true }), fc.constant(0)),
});
const callout: fc.Arbitrary<Callout> = fc
  .record(
    {
      anchor: point,
      label: point,
      legend: titleContent,
      when: condition(1),
      style: configKey,
    },
    { requiredKeys: ['anchor', 'legend'] },
  )
  .map((x) => ({ id: ID, ...x }));

interface Ctx {
  /** Levels of container blocks still allowed below this one. */
  budget: number;
  listDepth: number;
  sectionDepth: number;
  inCell: boolean;
  /** Directly in the document or a section, where a page break may go. */
  flow?: boolean;
}

const sha = fc.constantFrom(
  `sha256:${'ab'.repeat(32)}`,
  `sha256:${'0f'.repeat(32)}`,
);

const blockArbs: {
  [K in Block['type']]: (ctx: Ctx) => fc.Arbitrary<BlockOf<K>> | null;
} = {
  paragraph: () =>
    content.map((c) => ({ type: 'paragraph' as const, id: ID, content: c })),
  section: (ctx) =>
    ctx.sectionDepth < MAX_SECTION_DEPTH && ctx.budget > 0 && !ctx.inCell
      ? fc.constant(null).chain(() =>
          fc
            .record({
              title: titleContent,
              blocks: blockList(
                {
                  ...ctx,
                  budget: ctx.budget - 1,
                  sectionDepth: ctx.sectionDepth + 1,
                },
                true,
              ),
            })
            .map((x) => ({ type: 'section' as const, id: ID, ...x })),
        )
      : null,
  list: (ctx) =>
    containerOk(ctx) && ctx.listDepth < MAX_LIST_DEPTH
      ? fc
          .record({ ordered: fc.boolean(), items: items(ctx) })
          .map((x) => ({ type: 'list' as const, id: ID, ...x }))
      : null,
  procedure: (ctx) =>
    containerOk(ctx) && ctx.listDepth < MAX_LIST_DEPTH
      ? fc
          .record(
            { title: titleContent, steps: items(ctx) },
            { requiredKeys: ['steps'] },
          )
          .map((x) => ({ type: 'procedure' as const, id: ID, ...x }))
      : null,
  table: (ctx) => (containerOk(ctx) && !ctx.inCell ? table(ctx) : null),
  image: () =>
    fc
      .record(
        {
          asset: sha,
          alt: singleLine,
          title: titleContent,
          width: fc.oneof(
            fc.integer({ min: 1, max: 100 }),
            fc.double({ min: 0.5, max: 100, noNaN: true }),
          ),
          callouts: fc.array(callout, { minLength: 1, maxLength: 3 }),
          calloutOrder: fc.constantFrom('reading' as const, 'manual' as const),
          calloutLegend: fc.constantFrom(
            'below' as const,
            'beside' as const,
            'none' as const,
          ),
        },
        { requiredKeys: ['asset', 'alt'] },
      )
      .map((x) => ({ type: 'image' as const, id: ID, ...x })),
  safety: (ctx) =>
    containerOk(ctx)
      ? fc
          .record({
            severity: fc.constantFrom(
              'danger' as const,
              'warning' as const,
              'caution' as const,
              'notice' as const,
            ),
            hazard: titleContent,
            symbols: fc.uniqueArray(fc.constantFrom('w001', 'm002', 'p-3'), {
              maxLength: 2,
            }),
            blocks: blockList(delimited(ctx), false),
          })
          .map((x) => ({ type: 'safety' as const, id: ID, ...x }))
      : null,
  admonition: (ctx) =>
    containerOk(ctx)
      ? fc
          .record({
            kind: fc.constantFrom(
              'note' as const,
              'tip' as const,
              'important' as const,
            ),
            blocks: blockList(delimited(ctx), false, 1),
          })
          .map((x) => ({ type: 'admonition' as const, id: ID, ...x }))
      : null,
  faq: (ctx) =>
    containerOk(ctx)
      ? fc
          .record({
            question: titleContent,
            blocks: blockList(delimited(ctx), false, 1),
          })
          .map((x) => ({ type: 'faq' as const, id: ID, ...x }))
      : null,
  variant: (ctx) =>
    containerOk(ctx)
      ? fc
          .record({
            when: condition(2),
            blocks: blockList(delimited(ctx), false, 1),
          })
          .map((x) => ({ type: 'variant' as const, id: ID, ...x }))
      : null,
  attachment: () =>
    fc
      .record(
        {
          asset: sha,
          name: singleLine,
          description: singleLine,
          fileName: fc.constantFrom('config.zip', 'Daten Übersicht.json', 'a'),
          mediaType: fc.constantFrom('application/zip', 'application/json'),
          size: fc.integer({ min: 0, max: 2 ** 40 }),
        },
        { requiredKeys: ['asset', 'name', 'fileName', 'mediaType', 'size'] },
      )
      .map((x) => ({ type: 'attachment' as const, id: ID, ...x })),
  moduleRef: () =>
    fc
      .record(
        {
          module: fc.constantFrom('shared-warnings', 'a1'),
          block: fc.constantFrom('acid-warning', 'p1'),
        },
        { requiredKeys: ['module'] },
      )
      .map((x) => ({ type: 'moduleRef' as const, id: ID, ...x })),
  literal: () =>
    fc
      .record(
        { text: verbatim, language: fc.constantFrom('yaml', 'c++', 'json') },
        { requiredKeys: ['text'] },
      )
      .map((x) => ({ type: 'literal' as const, id: ID, ...x })),
  passthrough: () =>
    fc
      .record({ format: fc.constantFrom('xml', 'asciidoc'), raw: verbatim })
      .map((x) => ({ type: 'passthrough' as const, id: ID, ...x })),
  pageBreak: (ctx) =>
    ctx.flow ? fc.constant({ type: 'pageBreak' as const, id: ID }) : null,
};

function containerOk(ctx: Ctx): boolean {
  return ctx.budget > 0;
}

/** Inside a delimited block (safety, admonition, FAQ answer, variant): no sections, lists start again. */
function delimited(ctx: Ctx): Ctx {
  return { ...ctx, budget: ctx.budget - 1, listDepth: 0 };
}

function items(ctx: Ctx): fc.Arbitrary<Item[]> {
  const inner: Ctx = {
    ...ctx,
    budget: ctx.budget - 1,
    listDepth: ctx.listDepth + 1,
  };
  return fc.array(
    fc
      .record({ content, blocks: blockList(inner, false) })
      .map((x) => ({ id: ID, ...x })),
    { minLength: 1, maxLength: 3 },
  );
}

/** Blocks, and when `sections`, sections after them (never before: the model's rule). */
function blockList(
  ctx: Ctx,
  sections: boolean,
  minLength = 0,
): fc.Arbitrary<Block[]> {
  const options: fc.Arbitrary<Block>[] = [];
  for (const [type, make] of Object.entries(blockArbs)) {
    if (type === 'section') continue;
    const arbitrary = (make as (c: Ctx) => fc.Arbitrary<Block> | null)({
      ...ctx,
      flow: sections,
    });
    if (arbitrary) options.push(arbitrary);
  }
  const lead = fc.array(fc.oneof(...options), { minLength, maxLength: 3 });
  const section = sections ? blockArbs.section(ctx) : null;
  if (section === null) return lead;
  return fc
    .tuple(lead, fc.array(section, { maxLength: 2 }))
    .map(([a, b]) => [...a, ...b]);
}

/** Splits `width` columns into colspans. */
function splitWidth(width: number): fc.Arbitrary<number[]> {
  return fc
    .array(fc.integer({ min: 1, max: width }), {
      minLength: 1,
      maxLength: width,
    })
    .map((spans) => {
      const out: number[] = [];
      let left = width;
      for (const s of spans) {
        if (left === 0) break;
        const take = Math.min(s, left);
        out.push(take);
        left -= take;
      }
      if (left > 0) out.push(left);
      return out;
    });
}

/** A span of 1 is written out now and then: the model allows it. */
function withSpan(
  cell: TableCell,
  key: 'colspan' | 'rowspan',
  span: number,
  one: boolean,
): TableCell {
  return span > 1 || one ? { ...cell, [key]: span } : cell;
}

function table(ctx: Ctx): fc.Arbitrary<BlockOf<'table'>> {
  const cellCtx: Ctx = {
    budget: ctx.budget - 1,
    listDepth: 0,
    sectionDepth: 0,
    inCell: true,
  };
  const simpleCell = must(blockArbs.paragraph(cellCtx)).map((p): TableCell => ({
    blocks: [p],
  }));
  const anyCell = fc.oneof(
    simpleCell,
    blockList(cellCtx, false, 1).map((blocks): TableCell => ({ blocks })),
  );
  const row = (width: number, cell: fc.Arbitrary<TableCell>) =>
    splitWidth(width).chain((spans) =>
      fc.tuple(
        ...spans.map((span) =>
          fc
            .tuple(cell, fc.boolean())
            .map(([c, one]) => withSpan(c, 'colspan', span, one)),
        ),
      ),
    );
  return fc.integer({ min: 1, max: 3 }).chain((width) =>
    fc
      .record({
        header: fc.boolean(),
        // A first cell spanning every row, the other rows then one column narrower.
        tall: width > 1 ? fc.boolean() : fc.constant(false),
        first: row(width, simpleCell),
        rest: fc.array(fc.boolean(), { maxLength: 2 }),
        columns: fc.array(
          fc.record(
            {
              width: fc.integer({ min: 1, max: 9 }),
              align: fc.constantFrom(
                'left' as const,
                'center' as const,
                'right' as const,
              ),
            },
            { requiredKeys: ['width'] },
          ),
          { minLength: width, maxLength: width },
        ),
        title: fc.option(titleContent, { nil: undefined }),
      })
      .chain(({ header, tall, first, rest, columns, title }) => {
        const spanning = tall && !header && rest.length > 0;
        const restWidth = spanning ? width - 1 : width;
        return fc
          .tuple(...rest.map(() => row(restWidth, anyCell)))
          .chain((others) =>
            simpleCell.map((tallCell) => {
              const firstRow = spanning
                ? [
                    { ...tallCell, rowspan: rest.length + 1 },
                    ...row1(first, width - 1),
                  ]
                : first;
              return {
                type: 'table' as const,
                id: ID,
                ...(title ? { title } : {}),
                columns,
                header,
                rows: [firstRow, ...others].map((cells) => ({ cells })),
              };
            }),
          );
      }),
  );
}

/** The first row's cells cut down to cover `width` columns. */
function row1(cells: TableCell[], width: number): TableCell[] {
  const out: TableCell[] = [];
  let left = width;
  for (const cell of cells) {
    if (left === 0) break;
    const span = Math.min(cell.colspan ?? 1, left);
    const rest: TableCell = { ...cell };
    delete rest.colspan;
    out.push(span > 1 ? { ...rest, colspan: span } : rest);
    left -= span;
  }
  return out;
}

// ---------------------------------------------------------------------------
// IDs and modules

/** Unique, valid IDs in document order, in a few shapes. */
export function assignIds(blocks: Block[]): Block[] {
  let n = 0;
  const shapes = [
    (i: number) => `b${i}`,
    (i: number) => `_x${i}`,
    (i: number) => `step-${i}`,
  ];
  const next = () => {
    n++;
    return must(shapes[n % shapes.length])(n);
  };
  const item = (i: Item): Item => ({
    ...i,
    id: next(),
    blocks: i.blocks.map(block),
  });
  const block = (b: Block): Block => {
    const id = next();
    switch (b.type) {
      case 'section':
      case 'safety':
      case 'admonition':
      case 'faq':
      case 'variant':
        return { ...b, id, blocks: b.blocks.map(block) } as Block;
      case 'list':
        return { ...b, id, items: b.items.map(item) };
      case 'procedure':
        return { ...b, id, steps: b.steps.map(item) };
      case 'image':
        return b.callouts
          ? {
              ...b,
              id,
              callouts: b.callouts.map((c) => ({ ...c, id: next() })),
            }
          : { ...b, id };
      case 'table':
        return {
          ...b,
          id,
          rows: b.rows.map((r) => ({
            cells: r.cells.map((c) => ({ ...c, blocks: c.blocks.map(block) })),
          })),
        };
      default:
        return { ...b, id };
    }
  };
  return blocks.map(block);
}

const TOP: Ctx = { budget: 3, listDepth: 0, sectionDepth: 0, inCell: false };

/** A random valid module (it went through `Module.parse`), not necessarily in normal form. */
export const moduleArb: fc.Arbitrary<Module> = fc
  .record({
    title: singleLine,
    type: configKey,
    lang: fc.constantFrom('en', 'pt-BR', 'zh-Hans'),
    audience: fc.option(configKey, { nil: undefined }),
    facets: fc.dictionary(
      fc.constantFrom('product-line', 'region'),
      fc.uniqueArray(fc.constantFrom('a', 'b-2'), { minLength: 1 }),
    ),
    keywords: fc.option(
      fc.uniqueArray(fc.constantFrom('battery', 'Wärme', 'deep discharge'), {
        minLength: 1,
      }),
      { nil: undefined },
    ),
    source: fc.option(fc.record({ system: singleLine, id: singleLine }), {
      nil: undefined,
    }),
    blocks: blockList(TOP, true),
  })
  .map(({ blocks, title, type, lang, audience, facets, keywords, source }) =>
    Module.parse({
      schemaVersion: 1,
      id: 'generated-module',
      meta: {
        title,
        type,
        lang,
        facets,
        ...(audience ? { audience } : {}),
        ...(keywords ? { keywords } : {}),
        ...(source ? { source } : {}),
      },
      blocks: assignIds(blocks),
    }),
  );

export const generatorTypes = {
  blocks: Object.keys(blockArbs) as Block['type'][],
  inlines: Object.keys(inlineArbs) as Inline['type'][],
  marks: Object.keys(markArbs) as Mark['type'][],
  conditions: Object.keys(conditionArbs) as Condition['op'][],
};
