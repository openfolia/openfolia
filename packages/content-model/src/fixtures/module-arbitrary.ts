import fc from 'fast-check';
import type { Block, Callout, Item, TableCell } from '../lib/blocks.js';
import type { Condition } from '../lib/condition.js';
import type { Inline, Mark, TextNode } from '../lib/inline.js';
import { toFileName } from '../lib/ids.js';
import { Module } from '../lib/module.js';
import { MAX_LIST_DEPTH } from '../lib/structure.js';

/*
 * fast-check arbitraries for valid modules full of markup-like text, for
 * property tests (the AsciiDoc round trip, the import format).
 */

// ---------------------------------------------------------------------------
// Text that tries hard to look like markup.

const TRICKY = [
  '*',
  '**',
  '_',
  '__',
  '`',
  '``',
  '#',
  '##',
  '~',
  '^',
  '{',
  '}',
  '[',
  ']',
  '[[',
  ']]',
  '+',
  ' +',
  '|',
  '|===',
  '\\',
  '\\\\',
  '.',
  ':',
  '::',
  '//',
  '-',
  '----',
  '====',
  '++++',
  '<<',
  '>>',
  '"',
  "'",
  '(',
  ')',
  '=',
  '== ',
  '!',
  ',',
  ' ',
  '  ',
  '\t',
  'https://',
  'http://x.y',
  'mailto:',
  'link:',
  'xref:',
  'kbd:[',
  'placeholder:',
  'placeholder:title[]',
  'callout:',
  'callout:a#b[]',
  '<.> ',
  '[callout#x]',
  'image::',
  'attachment::',
  '<<<',
  'footnote:',
  '{empty}',
  '{product-name}',
  '[.ui]##',
  '1. ',
  'a) ',
  '* ',
  '. ',
  'NOTE: ',
  'é',
  'ß',
  '中文',
  'Ω',
];
const WORDS = ['a', 'Park', 'L-200', 'x1', 'the', '42', 'Z'];

const text = fc
  .array(fc.oneof(fc.constantFrom(...TRICKY), fc.constantFrom(...WORDS)), {
    minLength: 1,
    maxLength: 6,
  })
  .map((parts) => parts.join(''));

/** Single-line strings without leading or trailing whitespace. */
const singleLine = text.map((s) => s.trim()).filter((s) => s !== '');
/** Valid file names only: what `toFileName` keeps of the generated text. */
const fileName = fc
  .tuple(text, fc.constantFrom('.zip', '.json', '', '.tar.gz'))
  .map(([base, ext]) => toFileName(base + ext))
  .filter((name): name is string => name !== undefined);

const mark: fc.Arbitrary<Mark> = fc.oneof(
  fc.constantFrom<Mark>(
    { type: 'strong' },
    { type: 'emphasis' },
    { type: 'code' },
    { type: 'sub' },
    { type: 'sup' },
    { type: 'ui' },
  ),
  fc
    .constantFrom('https://example.com/a?b=1', 'mailto:help@example.com')
    .map((href): Mark => ({ type: 'link', href })),
  fc
    .constantFrom('charger', 'battery-pack', 'x1')
    .map((termId): Mark => ({ type: 'term', termId })),
);
// A link and a term link never mark the same text: the first one kept.
const marks = fc
  .uniqueArray(mark, { selector: (m) => m.type, maxLength: 3 })
  .map((list) => {
    const linking = list.find((m) => m.type === 'link' || m.type === 'term');
    return list.filter(
      (m) => (m.type !== 'link' && m.type !== 'term') || m === linking,
    );
  });

const textNode = (allowLinks: boolean): fc.Arbitrary<TextNode> =>
  fc.record({ text, marks }).map(({ text: t, marks: m }) => {
    const kept = allowLinks
      ? m
      : m.filter((x) => x.type !== 'link' && x.type !== 'term');
    return kept.length > 0
      ? { type: 'text', text: t, marks: kept }
      : { type: 'text', text: t };
  });

const inlineNode = (allowBreaks: boolean): fc.Arbitrary<Inline> =>
  fc.oneof(
    { weight: 6, arbitrary: textNode(true) },
    {
      weight: 1,
      arbitrary: fc
        .constantFrom('product-name', 'rated-load')
        .map((name): Inline => ({ type: 'attribute', name })),
    },
    {
      weight: 1,
      arbitrary: fc
        .record(
          {
            module: fc.constantFrom('charging-station', 'x'),
            block: fc.constantFrom('status-lights', '_a-1'),
            text: fc.array(textNode(false), { minLength: 1, maxLength: 2 }),
          },
          { requiredKeys: ['module'] },
        )
        .map((x): Inline => ({ type: 'xref', ...x })),
    },
    {
      weight: 1,
      arbitrary: fc
        .array(
          fc.constantFrom('Ctrl', 'Shift', '+', 'F1', 'a\\b', '[', 'x[['),
          {
            minLength: 1,
            maxLength: 3,
          },
        )
        .map((keys): Inline => ({ type: 'kbd', keys })),
    },
    {
      weight: 1,
      arbitrary: fc
        .constantFrom('title', 'page-count', 'x')
        .map((key): Inline => ({ type: 'placeholder', key })),
    },
    {
      weight: 1,
      arbitrary: fc
        .record({
          block: fc.constantFrom('front-view', '_a-1'),
          callout: fc.constantFrom('power-switch', 'b2'),
        })
        .map((x): Inline => ({ type: 'calloutRef', ...x })),
    },
    {
      weight: allowBreaks ? 1 : 0,
      arbitrary: fc.constant<Inline>({ type: 'hardBreak' }),
    },
  );

const content = fc.array(inlineNode(true), { minLength: 1, maxLength: 6 });
const titleContent = fc.array(inlineNode(false), {
  minLength: 1,
  maxLength: 4,
});

// ---------------------------------------------------------------------------
// Blocks. IDs are filled in afterwards, so every generated module has unique ones.

const condition: fc.Arbitrary<Condition> = fc.letrec<{ c: Condition }>(
  (tie) => ({
    c: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      fc.record({
        op: fc.constant('in' as const),
        attr: fc.constantFrom('model', 'market'),
        values: fc.array(
          fc.constantFrom('l-200', 'l-400', "odd value's", 'us'),
          { minLength: 1, maxLength: 3 },
        ),
      }),
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
      fc.record({ op: fc.constant('not' as const), of: tie('c') }),
      fc.record({
        op: fc.constantFrom('all' as const, 'any' as const),
        of: fc.array(tie('c'), { minLength: 2, maxLength: 3 }),
      }),
    ),
  }),
).c;

const verbatimText = (fence: string) =>
  fc
    .array(
      fc.constantFrom(
        'a',
        fence,
        fence + fence.charAt(0),
        '',
        '  x',
        '|===',
        '+',
        '[#x]',
      ),
      { maxLength: 5 },
    )
    .map((l) => l.join('\n'));

const coordinate = fc.oneof(
  fc.double({ min: 0, max: 1, noNaN: true }),
  fc.constantFrom(0, 1, 0.5, 0.25),
);
const point = fc.record({ x: coordinate, y: coordinate });
const calloutArb: fc.Arbitrary<Callout> = fc
  .record(
    {
      anchor: point,
      label: point,
      legend: titleContent,
      when: condition,
      style: fc.constantFrom('square', 'ring-2'),
    },
    { requiredKeys: ['anchor', 'legend'] },
  )
  .map((x) => ({ id: '', ...x }));

const ID = '';
const paragraph: fc.Arbitrary<Block> = content.map((c) => ({
  type: 'paragraph',
  id: ID,
  content: c,
}));

interface Ctx {
  budget: number;
  listDepth: number;
  inCell: boolean;
  /** Directly in the module or a section, where a page break may go. */
  flow?: boolean;
}

function blockArb(ctx: Ctx): fc.Arbitrary<Block> {
  const leaves: fc.Arbitrary<Block>[] = [
    paragraph,
    fc
      .record(
        {
          alt: singleLine,
          title: titleContent,
          width: fc.integer({ min: 1, max: 100 }),
          callouts: fc.array(calloutArb, { minLength: 1, maxLength: 4 }),
          calloutOrder: fc.constantFrom('reading' as const, 'manual' as const),
          calloutLegend: fc.constantFrom(
            'below' as const,
            'beside' as const,
            'none' as const,
          ),
        },
        { requiredKeys: ['alt'] },
      )
      .map((x): Block => ({
        type: 'image',
        id: ID,
        asset: `sha256:${'ab'.repeat(32)}`,
        ...x,
      })),
    fc
      .record(
        {
          name: singleLine,
          description: singleLine,
          fileName: fileName,
          mediaType: fc.constantFrom('application/zip', 'application/json'),
          size: fc.integer({ min: 0, max: 2 ** 40 }),
        },
        {
          requiredKeys: ['name', 'fileName', 'mediaType', 'size'],
        },
      )
      .map((x): Block => ({
        type: 'attachment',
        id: ID,
        asset: `sha256:${'cd'.repeat(32)}`,
        ...x,
      })),
    fc.constant<Block>({
      type: 'moduleRef',
      id: ID,
      module: 'battery-disposal',
    }),
    fc.constant<Block>({
      type: 'moduleRef',
      id: ID,
      module: 'battery-disposal',
      block: 'disposal-warning',
    }),
    fc
      .record(
        {
          text: verbatimText('----'),
          language: fc.constantFrom('yaml', 'c++', 'json'),
        },
        { requiredKeys: ['text'] },
      )
      .map((x): Block => ({ type: 'literal', id: ID, ...x })),
    verbatimText('++++').map((raw): Block => ({
      type: 'passthrough',
      id: ID,
      format: 'xml',
      raw,
    })),
    ...(ctx.flow ? [fc.constant<Block>({ type: 'pageBreak', id: ID })] : []),
  ];
  if (ctx.budget <= 0) return fc.oneof(...leaves);

  const inner = { ...ctx, budget: ctx.budget - 1, flow: false };
  const delimited = {
    budget: ctx.budget - 1,
    listDepth: 0,
    inCell: ctx.inCell,
  };
  // Two children at most (#734): every nesting the budget allows, without the few modules
  // ten times the median one that three made, which a loaded machine timed out on.
  const children = (c: Ctx, min = 0) =>
    fc.array(blockArb(c), { minLength: min, maxLength: 2 });
  const items = (c: Ctx) =>
    fc.array(
      fc
        .record({
          content,
          blocks: children({ ...c, listDepth: c.listDepth + 1 }),
        })
        .map((x): Item => ({ id: ID, ...x })),
      { minLength: 1, maxLength: 3 },
    );

  const containers: fc.Arbitrary<Block>[] = [
    fc
      .record({
        severity: fc.constantFrom(
          'danger' as const,
          'warning' as const,
          'caution' as const,
          'notice' as const,
        ),
        hazard: titleContent,
        symbols: fc.uniqueArray(fc.constantFrom('w012', 'm002'), {
          maxLength: 2,
        }),
        blocks: children(delimited),
      })
      .map((x): Block => ({ type: 'safety', id: ID, ...x })),
    fc
      .record({
        kind: fc.constantFrom(
          'note' as const,
          'tip' as const,
          'important' as const,
        ),
        blocks: children(delimited, 1),
      })
      .map((x): Block => ({ type: 'admonition', id: ID, ...x })),
    fc
      .record({ question: titleContent, blocks: children(delimited, 1) })
      .map((x): Block => ({ type: 'faq', id: ID, ...x })),
    fc
      .record({ when: condition, blocks: children(delimited, 1) })
      .map((x): Block => ({ type: 'variant', id: ID, ...x })),
  ];
  if (ctx.listDepth < MAX_LIST_DEPTH) {
    containers.push(
      fc
        .record({ ordered: fc.boolean(), items: items(inner) })
        .map((x): Block => ({ type: 'list', id: ID, ...x })),
      fc
        .record(
          { title: titleContent, steps: items(inner) },
          { requiredKeys: ['steps'] },
        )
        .map((x): Block => ({ type: 'procedure', id: ID, ...x })),
    );
  }
  if (!ctx.inCell)
    containers.push(
      tableArb({ budget: ctx.budget - 1, listDepth: 0, inCell: true }),
    );
  return fc.oneof(...leaves, ...containers);
}

function tableArb(cellCtx: Ctx): fc.Arbitrary<Block> {
  const simpleCell = paragraph.map((p): TableCell => ({ blocks: [p] }));
  const anyCell = fc.oneof(
    simpleCell,
    fc
      .array(blockArb(cellCtx), { minLength: 1, maxLength: 2 })
      .map((blocks) => ({ blocks })),
  );
  return fc.integer({ min: 1, max: 3 }).chain((width) => {
    /** A row as a split of the width into colspans. */
    const row = (cell: fc.Arbitrary<TableCell>) =>
      fc
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
        })
        .chain((spans) =>
          fc.tuple(
            ...spans.map((span) =>
              cell.map((c) => (span > 1 ? { ...c, colspan: span } : c)),
            ),
          ),
        );
    return fc
      .record({
        header: fc.boolean(),
        first: row(simpleCell),
        rest: fc.array(row(anyCell), { maxLength: 2 }),
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
      .map(({ header, first, rest, columns, title }): Block => ({
        type: 'table',
        id: ID,
        ...(title ? { title } : {}),
        columns,
        header,
        rows: [first, ...rest].map((cells) => ({ cells })),
      }));
  });
}

function sectionArb(depth: number): fc.Arbitrary<Block> {
  const sub =
    depth < 3
      ? fc.array(
          fc.constant(null).chain(() => sectionArb(depth + 1)),
          // Siblings at the top only (#734): every heading level, at most 8 sections.
          { maxLength: depth === 0 ? 2 : 1 },
        )
      : fc.constant([]);
  return fc
    .record({
      title: titleContent,
      lead: fc.array(
        blockArb({ budget: 1, listDepth: 0, inCell: false, flow: true }),
        {
          maxLength: 2,
        },
      ),
      sub,
    })
    .map(({ title, lead, sub: subs }) => ({
      type: 'section',
      id: ID,
      title,
      blocks: [...lead, ...subs],
    }));
}

/** Assigns unique, valid IDs in document order. */
function assignIds(blocks: Block[]): Block[] {
  let n = 0;
  const next = () => `b${++n}`;
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

export const moduleArb = fc
  .record({
    title: singleLine,
    lang: fc.constantFrom('en', 'pt-BR', 'zh-Hans'),
    audience: fc.option(fc.constantFrom('public', 'internal'), {
      nil: undefined,
    }),
    facets: fc.dictionary(
      fc.constantFrom('product-line', 'region'),
      fc.uniqueArray(fc.constantFrom('a', 'b-2'), { minLength: 1 }),
    ),
    // Raw, so the schema's own trimming, spacing and deduplication are exercised too.
    keywords: fc.option(
      fc.array(
        text.filter(
          (k) => !k.includes(',') && k.trim() !== '' && k.trim().length <= 64,
        ),
        { maxLength: 6 },
      ),
      { nil: undefined },
    ),
    source: fc.option(fc.record({ system: singleLine, id: singleLine }), {
      nil: undefined,
    }),
    deprecated: fc.option(
      fc.record(
        {
          reason: singleLine.filter((r) => r.length <= 500),
          replacedBy: fc.constantFrom('charging-v2', 'b'),
        },
        { requiredKeys: ['reason'] },
      ),
      { nil: undefined },
    ),
    lead: fc.array(
      blockArb({ budget: 3, listDepth: 0, inCell: false, flow: true }),
      {
        maxLength: 4,
      },
    ),
    sections: fc.array(sectionArb(0), { maxLength: 2 }),
  })
  .map(
    ({
      lead,
      sections,
      title,
      lang,
      audience,
      facets,
      keywords,
      source,
      deprecated,
    }) =>
      Module.parse({
        schemaVersion: 1,
        id: 'generated',
        meta: {
          title,
          type: 'procedure',
          lang,
          facets,
          ...(audience ? { audience } : {}),
          ...(keywords ? { keywords } : {}),
          ...(source ? { source } : {}),
          ...(deprecated ? { deprecated } : {}),
        },
        blocks: assignIds([...lead, ...sections]),
      }),
  );

/**
 * A module of images with callouts (and references to them) only: the
 * callout syntax exercised far more often than `moduleArb` does.
 */
export const calloutModuleArb = fc
  .array(
    fc.record(
      {
        alt: singleLine,
        title: titleContent,
        callouts: fc.array(calloutArb, { minLength: 1, maxLength: 6 }),
        calloutOrder: fc.constantFrom('reading' as const, 'manual' as const),
        calloutLegend: fc.constantFrom(
          'below' as const,
          'beside' as const,
          'none' as const,
        ),
      },
      { requiredKeys: ['alt', 'callouts'] },
    ),
    { minLength: 1, maxLength: 3 },
  )
  .map((images) => {
    let n = 0;
    const blocks: Block[] = images.map((x) => ({
      type: 'image',
      id: `img${++n}`,
      asset: `sha256:${'ab'.repeat(32)}`,
      ...x,
      callouts: x.callouts.map((c) => ({ ...c, id: `c${++n}` })),
    }));
    return Module.parse({
      schemaVersion: 1,
      id: 'callouts',
      meta: { title: 'Callouts', type: 'procedure', lang: 'en' },
      blocks,
    });
  });
