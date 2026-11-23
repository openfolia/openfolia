// @vitest-environment jsdom
/// <reference lib="dom" />
import type {
  Block,
  Inline,
  Item,
  Mark,
  ResolvedEntry,
  ResolvedManual,
  TextNode,
} from '@openfolia/content-model';
import fc from 'fast-check';
import {
  renderManualHtml,
  renderModuleHtml,
  type HtmlRenderOptions,
} from './render.js';

// The renderer's promise: whatever the content holds, valid or not, the
// output never carries markup the renderer did not write itself. Random
// manuals full of hostile strings are rendered, parsed the way a browser
// parses them, and every element and attribute checked against what the
// renderer may produce.

const PAYLOADS = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "'><svg onload=alert(1)>",
  '</p><iframe srcdoc="<script>alert(1)</script>"></iframe>',
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  ' javascript:alert(1)',
  'java\tscript:alert(1)',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'vbscript:msgbox(1)',
  '<!--',
  '-->',
  '<![CDATA[',
  '</pre><script>',
  '</code></pre><style>*{}</style>',
  '&lt;script&gt;',
  '&#x3C;script&#x3E;',
  '<a href="javascript:alert(1)">x</a>',
  '<math><mi xlink:href="javascript:alert(1)">',
  '<template><script>',
  '`${alert(1)}`',
  '\u0000',
  '\r\n',
  ' ',
  'x" style="background:url(javascript:alert(1))',
  "x' onmouseover='alert(1)",
  'https://example.com/"onmouseover="alert(1)',
  '#"><script>',
  '/assets/x"><script>',
  'javascript&colon;alert(1)',
  '&#106;avascript:alert(1)',
  'javascript&#58;alert(1)',
  '\\\\evil.example/x',
  '\u00a0javascript:alert(1)',
  '\ufeffjavascript:alert(1)',
  'java\u0001script:alert(1)',
  '//evil.example/x',
  'constructor',
  '__proto__',
  'toString',
];

const hostile: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...PAYLOADS),
  fc.string({ unit: 'binary', maxLength: 12 }),
  fc
    .array(fc.constantFrom(...PAYLOADS, 'a', ' ', '<', '>', '"', "'", '&'), {
      maxLength: 4,
    })
    .map((parts) => parts.join('')),
);

const markArb: fc.Arbitrary<Mark> = fc.oneof(
  fc.constantFrom<Mark>(
    { type: 'strong' },
    { type: 'emphasis' },
    { type: 'code' },
    { type: 'sub' },
    { type: 'sup' },
    { type: 'ui' },
  ),
  fc
    .oneof(hostile, fc.constant('https://example.com/ok'))
    .map((href): Mark => ({ type: 'link', href })),
);

const textArb: fc.Arbitrary<TextNode> = fc.record(
  {
    type: fc.constant('text' as const),
    text: hostile,
    marks: fc.array(markArb, { maxLength: 3 }),
  },
  { requiredKeys: ['type', 'text'] },
);

const inlineArb: fc.Arbitrary<Inline> = fc.oneof(
  { weight: 5, arbitrary: textArb },
  fc.record({ type: fc.constant('attribute' as const), name: hostile }),
  fc.record(
    {
      type: fc.constant('xref' as const),
      module: fc.oneof(hostile, fc.constant('mod')),
      block: fc.oneof(hostile, fc.constant('b')),
      text: fc.array(textArb, { minLength: 1, maxLength: 2 }),
    },
    { requiredKeys: ['type', 'module'] },
  ),
  fc.record({
    type: fc.constant('kbd' as const),
    keys: fc.array(hostile, { minLength: 1, maxLength: 3 }),
  }),
  fc.constant({ type: 'hardBreak' as const }),
  fc.record({
    type: fc.constant('calloutRef' as const),
    block: fc.oneof(hostile, fc.constant('img')),
    callout: fc.oneof(hostile, fc.constant('c')),
  }),
);

const inlines = fc.array(inlineArb, { minLength: 1, maxLength: 4 });
const number = fc.oneof(
  fc.integer({ min: -5, max: 200 }),
  fc.double(),
  fc.constantFrom(NaN, Infinity, -Infinity),
);

/** A point anywhere, in range or not. */
const pointArb = fc.record({ x: number, y: number });

/** A callout with hostile texts and keys, and points out of range (#546). */
const calloutArb = fc.record(
  {
    id: hostile,
    anchor: pointArb,
    label: pointArb,
    legend: inlines,
    style: fc.oneof(hostile, fc.constant('square')),
  },
  { requiredKeys: ['id', 'anchor', 'legend'] },
);

const { block: blockArb } = fc.letrec<{
  block: Block;
  blocks: Block[];
  item: Item;
}>((tie) => ({
  blocks: fc.array(tie('block'), { maxLength: 3 }),
  item: fc.record({ id: hostile, content: inlines, blocks: tie('blocks') }),
  block: fc.oneof(
    // Three levels of nesting reach every container in a container; deeper only made a few
    // runs ten times the size of the rest (#615).
    { depthSize: 'small', withCrossShrink: true, maxDepth: 3 },
    fc.record({
      type: fc.constant('paragraph' as const),
      id: hostile,
      content: inlines,
    }),
    fc.record({
      type: fc.constant('section' as const),
      id: hostile,
      title: inlines,
      blocks: tie('blocks'),
    }),
    fc.record({
      type: fc.constant('list' as const),
      id: hostile,
      ordered: fc.boolean(),
      items: fc.array(tie('item'), { minLength: 1, maxLength: 2 }),
    }),
    fc.record(
      {
        type: fc.constant('procedure' as const),
        id: hostile,
        title: inlines,
        steps: fc.array(tie('item'), { minLength: 1, maxLength: 2 }),
      },
      { requiredKeys: ['type', 'id', 'steps'] },
    ),
    fc.record(
      {
        type: fc.constant('table' as const),
        id: hostile,
        title: inlines,
        columns: fc.array(
          fc.record(
            {
              width: number,
              align: fc.constantFrom(
                'left',
                'center',
                'right',
                'x" onclick="y',
              ) as fc.Arbitrary<'left' | 'center' | 'right'>,
            },
            { requiredKeys: ['width'] },
          ),
          { minLength: 1, maxLength: 3 },
        ),
        header: fc.boolean(),
        rows: fc.array(
          fc.record({
            cells: fc.array(
              fc.record(
                { colspan: number, rowspan: number, blocks: tie('blocks') },
                { requiredKeys: ['blocks'] },
              ),
              { minLength: 1, maxLength: 3 },
            ),
          }),
          { minLength: 1, maxLength: 3 },
        ),
      },
      { requiredKeys: ['type', 'id', 'columns', 'header', 'rows'] },
    ),
    fc.record(
      {
        type: fc.constant('image' as const),
        id: hostile,
        asset: fc.oneof(hostile, fc.constant(`sha256:${'ab'.repeat(32)}`)),
        alt: hostile,
        title: inlines,
        width: number,
        callouts: fc.array(calloutArb, { minLength: 1, maxLength: 3 }),
        calloutLegend: fc.oneof(
          hostile,
          fc.constantFrom('below', 'beside', 'none'),
        ) as fc.Arbitrary<'below'>,
      },
      { requiredKeys: ['type', 'id', 'asset', 'alt'] },
    ),
    fc.record(
      {
        type: fc.constant('attachment' as const),
        id: hostile,
        asset: fc.oneof(hostile, fc.constant(`sha256:${'cd'.repeat(32)}`)),
        name: hostile,
        description: hostile,
        fileName: hostile,
        mediaType: fc.oneof(hostile, fc.constant('application/zip')),
        size: fc.oneof(fc.integer(), fc.double()),
      },
      {
        requiredKeys: [
          'type',
          'id',
          'asset',
          'name',
          'fileName',
          'mediaType',
          'size',
        ],
      },
    ),
    fc.record({
      type: fc.constant('safety' as const),
      id: hostile,
      severity: fc.constantFrom(
        'danger',
        'warning',
        'caution',
        'notice',
        '"><x',
      ) as fc.Arbitrary<'danger'>,
      hazard: inlines,
      symbols: fc.array(hostile, { maxLength: 2 }),
      blocks: tie('blocks'),
    }),
    fc.record({
      type: fc.constant('faq' as const),
      id: hostile,
      question: inlines,
      blocks: tie('blocks'),
    }),
    fc.record({
      type: fc.constant('admonition' as const),
      id: hostile,
      kind: fc.constantFrom(
        'note',
        'tip',
        'important',
        '"><x',
      ) as fc.Arbitrary<'note'>,
      blocks: tie('blocks'),
    }),
    fc.record(
      {
        type: fc.constant('literal' as const),
        id: hostile,
        text: hostile,
        language: hostile,
      },
      { requiredKeys: ['type', 'id', 'text'] },
    ),
    fc.record({
      type: fc.constant('passthrough' as const),
      id: hostile,
      format: hostile,
      raw: hostile,
    }),
    fc.record({ type: fc.constant('pageBreak' as const), id: hostile }),
  ),
}));

const entryArb: fc.Arbitrary<ResolvedEntry> = fc.oneof(
  fc.record({
    kind: fc.constant('module' as const),
    module: fc.oneof(hostile, fc.constant('mod')),
    title: hostile,
    lang: fc.oneof(hostile, fc.constant('en')),
    blocks: fc.array(blockArb, { maxLength: 4 }),
  }),
  fc.record({
    kind: fc.constant('group' as const),
    title: hostile,
    entries: fc.array(
      fc.record({
        kind: fc.constant('module' as const),
        module: hostile,
        title: hostile,
        lang: hostile,
        blocks: fc.array(blockArb, { maxLength: 2 }),
      }),
      { maxLength: 2 },
    ),
  }),
);

const manualArb: fc.Arbitrary<ResolvedManual> = fc.record({
  // Callout numbers from elsewhere: anything, under any key (#546).
  callouts: fc.dictionary(
    fc.oneof(hostile, fc.constant('img')),
    fc.dictionary(
      fc.oneof(hostile, fc.constant('c')),
      fc.oneof(number, hostile),
      { maxKeys: 3 },
    ),
    { maxKeys: 3 },
  ) as fc.Arbitrary<Record<string, Record<string, number>>>,
  id: hostile,
  title: hostile,
  lang: fc.oneof(hostile, fc.constant('de')),
  variant: fc.constant({}),
  entries: fc.array(entryArb, { minLength: 1, maxLength: 3 }),
  origins: fc.constant({}),
  anchors: fc.dictionary(
    fc.oneof(hostile, fc.constantFrom('mod', 'mod#b')),
    hostile,
    { maxKeys: 3 },
  ),
  // Directions from elsewhere: any string, for any tag (#458).
  directions: fc.dictionary(
    fc.oneof(hostile, fc.constantFrom('de', 'en', 'ar')),
    fc.oneof(hostile, fc.constantFrom('ltr', 'rtl')),
    { maxKeys: 3 },
  ) as fc.Arbitrary<ResolvedManual['directions']>,
});

/** Callbacks returning hostile values too: the renderer checks what the caller hands back. */
const optionsArb: fc.Arbitrary<HtmlRenderOptions> = fc
  .record({
    asset: fc.oneof(hostile, fc.constant('/assets/')),
    /** Whether assetUrl ignores the hash and hands back its value as is. */
    assetAsIs: fc.boolean(),
    idPrefix: fc.constantFrom(undefined, 'of-', 'doc_', 'x-'),
    symbol: fc.option(hostile, { nil: undefined }),
    label: fc.option(hostile, { nil: undefined }),
    xref: fc.option(hostile, { nil: undefined }),
    subtitle: fc.option(hostile, { nil: undefined }),
    preview: fc.option(fc.option(hostile, { nil: undefined }), {
      nil: null,
    }),
    outputLabels: fc.option(
      fc.record({
        warning: hostile,
        note: hostile,
        contents: hostile,
        figure: hostile,
      }),
      { nil: undefined },
    ),
  })
  .map(
    ({
      asset,
      assetAsIs,
      idPrefix,
      symbol,
      label,
      xref,
      subtitle,
      preview,
      outputLabels,
    }) => ({
      assetUrl: (hash: string) => (assetAsIs ? asset : asset + hash),
      ...(idPrefix !== undefined ? { idPrefix } : {}),
      symbolUrl: () => symbol,
      symbolLabel: () => label,
      xrefHref: () => xref,
      ...(subtitle !== undefined ? { subtitle } : {}),
      ...(preview !== null
        ? { preview: { attributeLabel: () => preview } }
        : {}),
      ...(outputLabels
        ? { outputLabels: { de: outputLabels, en: outputLabels } }
        : {}),
    }),
  );

/** The elements of the callouts' SVG (#546), only inside it. */
const SVG_TAGS = new Set(['svg', 'line', 'circle', 'g', 'text']);
/** Its attributes, each with the values the renderer writes. */
const SVG_ATTRIBUTES: Record<string, RegExp> = {
  class: /^of-callouts__(?:overlay|leader|anchor|marker)$/,
  width: /^100%$/,
  height: /^100%$/,
  'aria-hidden': /^true$/,
  focusable: /^false$/,
  x1: /^\d+\.\d\d%$/,
  y1: /^\d+\.\d\d%$/,
  x2: /^\d+\.\d\d%$/,
  y2: /^\d+\.\d\d%$/,
  cx: /^\d+\.\d\d%$/,
  cy: /^\d+\.\d\d%$/,
  x: /^\d+\.\d\d%$/,
  y: /^\d+\.\d\d%$/,
  r: /^\d+(?:\.\d+)?$/,
  'text-anchor': /^middle$/,
  'dominant-baseline': /^central$/,
  'data-callout-style': /^[a-z][a-z0-9-]*$/,
  'data-callout': /^[a-z0-9_-]{1,200}:[a-z_][a-z0-9_-]{0,63}$/,
};
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Every element and attribute the renderer writes. Anything else came from the content. */
const TAGS = new Set(
  'article header h1 h2 h3 h4 h5 h6 p nav ol ul li a span section div kbd strong em code sub sup br table caption colgroup col thead tbody tr th td figure figcaption img pre details summary'.split(
    ' ',
  ),
);
const ATTRIBUTES = new Set(
  'class id lang dir href src alt style rel role aria-label aria-level aria-hidden title scope colspan rowspan loading decoding data-language data-callout download type'.split(
    ' ',
  ),
);
const URL_ATTRIBUTES = new Set(['href', 'src']);
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function violations(html: string, idPrefix = 'of-'): string[] {
  const doc = new DOMParser().parseFromString(
    `<!doctype html><body>${html}`,
    'text/html',
  );
  const found: string[] = [];
  const top = doc.body.children;
  if (top.length !== 1 || top[0]?.tagName !== 'ARTICLE')
    found.push('not one <article> at the top');
  for (const el of doc.body.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    if (el.namespaceURI === SVG_NS) {
      // Only the callouts' overlay, and only what it is made of.
      const overlay = el.closest('svg');
      if (
        !SVG_TAGS.has(tag) ||
        overlay?.getAttribute('class') !== 'of-callouts__overlay' ||
        overlay.parentElement?.closest('svg') ||
        overlay.parentElement?.getAttribute('class') !== 'of-callouts__picture'
      )
        found.push(`element <${tag}>`);
      for (const attr of el.attributes) {
        if (!SVG_ATTRIBUTES[attr.name]?.test(attr.value))
          found.push(
            `attribute ${attr.name}=${JSON.stringify(attr.value)} on <${tag}>`,
          );
      }
      // A marker's text is its number, or "?".
      if (tag === 'text' && !/^(?:\d+|\?)$/.test(el.textContent ?? ''))
        found.push(`text ${JSON.stringify(el.textContent)}`);
      continue;
    }
    if (!TAGS.has(tag) || el.namespaceURI !== 'http://www.w3.org/1999/xhtml')
      found.push(`element <${tag}>`);
    for (const attr of el.attributes) {
      const name = attr.name.toLowerCase();
      if (!ATTRIBUTES.has(name) || name.startsWith('on'))
        found.push(`attribute ${name} on <${tag}>`);
      if (URL_ATTRIBUTES.has(name)) {
        let protocol: string;
        try {
          protocol = new URL(attr.value, 'https://host.invalid/page').protocol;
        } catch {
          protocol = 'unparseable';
        }
        if (!SAFE_PROTOCOLS.has(protocol))
          found.push(`${name}=${JSON.stringify(attr.value)}`);
      }
      if (name === 'style' && !/^width:\d+(\.\d+)?%$/.test(attr.value))
        found.push(`style=${attr.value}`);
      if (
        name === 'class' &&
        !attr.value.split(' ').every((c) => /^of-[a-z0-9_-]+$/.test(c))
      )
        found.push(`class=${attr.value}`);
      if (
        name === 'data-callout' &&
        !/^[a-z0-9_-]{1,200}:[a-z_][a-z0-9_-]{0,63}$/.test(attr.value)
      )
        found.push(`data-callout=${attr.value}`);
      if (name === 'dir' && attr.value !== 'ltr' && attr.value !== 'rtl')
        found.push(`dir=${attr.value}`);
      if (name === 'id' && !attr.value.startsWith(idPrefix))
        found.push(`id=${attr.value}`);
    }
  }
  return found;
}

describe('no generated document yields markup from its content', () => {
  it('holds for random manuals full of hostile strings', () => {
    fc.assert(
      fc.property(manualArb, optionsArb, (manual, options) => {
        expect(
          violations(renderManualHtml(manual, options).html, options.idPrefix),
        ).toEqual([]);
        const first = manual.entries.find((e) => e.kind === 'module');
        if (first?.kind === 'module') {
          const result = renderModuleHtml(manual, first.module, options);
          expect(violations(result?.html ?? '', options.idPrefix)).toEqual([]);
        }
      }),
      // Bounded work, not time: with the sizes above, 150 runs take under a tenth of the test's time
      // on an idle machine, so a loaded one (load 90 on 16 cores) still fits (#615). Every
      // check runs a new seed.
      { numRuns: 150 },
    );
  });

  it('reads random text back exactly as given, in text and in attributes', () => {
    const text = fc
      .oneof(fc.string({ unit: 'binary', minLength: 1 }), hostile)
      .filter((s) => s.length > 0 && !s.includes('\0'));
    fc.assert(
      fc.property(text, (s) => {
        const manual: ResolvedManual = {
          id: 'm',
          title: s,
          lang: 'en',
          variant: {},
          entries: [
            {
              kind: 'module',
              module: 'mod',
              title: 'Mod',
              lang: 'en',
              blocks: [
                {
                  type: 'paragraph',
                  id: 'p',
                  content: [{ type: 'text', text: s }],
                },
                {
                  type: 'image',
                  id: 'i',
                  asset: `sha256:${'ab'.repeat(32)}`,
                  alt: s,
                },
                { type: 'literal', id: 'l', text: s },
              ],
            },
          ],
          origins: {},
          anchors: {},
        };
        const doc = new DOMParser().parseFromString(
          renderManualHtml(manual, { assetUrl: (h) => `/a/${h}` }).html,
          'text/html',
        );
        const p = doc.getElementById('of-p');
        expect(p?.childNodes).toHaveLength(1);
        expect(p?.firstChild?.nodeType).toBe(3);
        expect(p?.textContent).toBe(s);
        expect(doc.querySelector('.of-manual__title')?.textContent).toBe(s);
        expect(doc.querySelector('#of-i img')?.getAttribute('alt')).toBe(s);
        expect(doc.querySelector('#of-l code')?.textContent).toBe(s);
      }),
      { numRuns: 500 },
    );
  });

  it('catches markup the renderer did not write (the check itself works)', () => {
    expect(
      violations('<article class="of-content"><script>x</script></article>'),
    ).toEqual(['element <script>']);
    expect(
      violations(
        '<article class="of-content"><a href="javascript:x">y</a></article>',
      ),
    ).toEqual(['href="javascript:x"']);
    expect(
      violations('<article class="of-content" onclick="x"></article>'),
    ).toEqual(['attribute onclick on <article>']);
    expect(
      violations('<article class="of-content"><svg></svg></article>'),
    ).toEqual(['element <svg>']);
    expect(
      violations(
        '<article class="of-content"><div class="of-callouts__picture"><svg class="of-callouts__overlay" onload="x"><text x="1.00%">a</text></svg></div></article>',
      ),
    ).toEqual(['attribute onload="x" on <svg>', 'text "a"']);
  });
});
