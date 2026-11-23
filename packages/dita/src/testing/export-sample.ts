import {
  type Block,
  type Inline,
  type Manifest,
  type Mark,
  Module,
  parseConfig,
  type ProjectConfig,
} from '@openfolia/content-model';
import type { DitaExportInput } from '../lib/export/export.js';

/**
 * An invented project for the export's tests (#433): a kettle in two models,
 * two markets and two software versions, with a module of every block type,
 * a task, a reference, a troubleshooting topic, snippets referenced, and a
 * German translation of some of it.
 */
export const SAMPLE_CONFIG: ProjectConfig = parseConfig(`
languages:
  source: en
  targets: [de]
moduleTypes:
  - id: concept
    label: Concept
  - id: procedure
    label: Procedure
  - id: reference
    label: Reference
  - id: troubleshooting
    label: Troubleshooting
  - id: snippet
    label: Snippet
    snippet: true
audiences:
  - id: user
    label: User
  - id: service
    label: Service
variantAttributes:
  - id: model
    label: Model
    kind: enum
    values:
      - id: basic
        label: Basic
      - id: pro
        label: Pro
      - id: max
        label: Max
  - id: market
    label: Market
    kind: enum
    values:
      - id: eu
        label: EU
      - id: us
        label: US
  - id: software
    label: Software
    kind: version
textAttributes:
  - id: product-name
    label: Product name
safetySymbols:
  - id: w001
    label: Warning
  - id: m002
    label: Read the manual
dita:
  moduleTypes:
    task: procedure
  profiling:
    product:
      variantAttribute: model
      values:
        kettle-basic: basic
  textKeys:
    prodname: product-name
  hazardSymbols:
    general-warning.svg: w001
`);

const IMAGE = `sha256:${'a'.repeat(64)}`;
const FILE = `sha256:${'b'.repeat(64)}`;
const MISSING = `sha256:${'c'.repeat(64)}`;

const t = (text: string, marks?: Mark[]): Inline & { type: 'text' } =>
  marks ? { type: 'text', text, marks } : { type: 'text', text };
const p = (id: string, ...content: Inline[]): Block => ({
  type: 'paragraph',
  id,
  content: content.length > 0 ? content : [t(`Paragraph ${id}.`)],
});

const module = (
  id: string,
  type: string,
  blocks: Block[],
  meta: Partial<Module['meta']> = {},
  lang = 'en',
): Module =>
  Module.parse({
    schemaVersion: 1,
    id,
    meta: { title: `Title of ${id}`, type, lang, facets: {}, ...meta },
    blocks,
  });

const everything = module(
  'everything',
  'concept',
  [
    p(
      'marks',
      t('Plain <text> & "quotes" '),
      t('bold', [{ type: 'strong' }]),
      t(' '),
      t('ui and code', [{ type: 'ui' }, { type: 'code' }]),
      t(' '),
      t('linked', [
        { type: 'link', href: 'https://example.com/a?b=1&c=2' },
        { type: 'emphasis' },
      ]),
      t(' H'),
      t('2', [{ type: 'sub' }]),
      t('O x'),
      t('2', [{ type: 'sup' }]),
      t(' '),
      t('kettle', [{ type: 'term', termId: 'kettle' }]),
      t(' for the '),
      { type: 'attribute', name: 'product-name' },
      t(', press '),
      { type: 'kbd', keys: ['Ctrl', 'S'] },
      t(', see '),
      { type: 'xref', module: 'steps', block: 'fill' },
      t(' and '),
      { type: 'xref', module: 'reference-data', text: [t('the data')] },
      t(' and '),
      { type: 'xref', module: 'not-in-manual', text: [t('elsewhere')] },
      t('.'),
    ),
    p('lines', t('First line'), { type: 'hardBreak' }, t('second line')),
    {
      type: 'list',
      id: 'list',
      ordered: false,
      items: [
        { id: 'item-a', content: [t('Item A')], blocks: [] },
        {
          id: 'item-b',
          content: [t('Item B')],
          blocks: [
            p('item-b-more'),
            {
              type: 'list',
              id: 'inner-list',
              ordered: true,
              items: [{ id: 'inner-item', content: [t('Inner')], blocks: [] }],
            },
          ],
        },
      ],
    },
    {
      type: 'procedure',
      id: 'loose-steps',
      title: [t('Steps outside a task')],
      steps: [{ id: 'loose-1', content: [t('Do this.')], blocks: [] }],
    },
    {
      type: 'table',
      id: 'table',
      title: [t('A table')],
      columns: [{ width: 2 }, { width: 1, align: 'center' }, { width: 1 }],
      header: true,
      rows: [
        {
          cells: [
            { blocks: [p('h1')] },
            { blocks: [p('h2')] },
            { blocks: [p('h3')] },
          ],
        },
        {
          cells: [
            { blocks: [p('c1')] },
            { rowspan: 2, blocks: [p('c2')] },
            { blocks: [] },
          ],
        },
        { cells: [{ blocks: [p('c3')] }, { blocks: [p('c4')] }] },
        { cells: [{ colspan: 3, blocks: [p('c5')] }] },
      ],
    },
    {
      type: 'image',
      id: 'figure',
      asset: IMAGE,
      alt: 'A kettle',
      title: [t('The kettle')],
      width: 50,
      callouts: [{ id: 'lid', anchor: { x: 0.5, y: 0.1 }, legend: [t('Lid')] }],
    },
    { type: 'image', id: 'plain-image', asset: IMAGE, alt: 'Plain' },
    { type: 'image', id: 'gone-image', asset: MISSING, alt: 'Gone' },
    {
      type: 'attachment',
      id: 'attachment',
      asset: FILE,
      name: 'Settings',
      description: 'The default settings',
      fileName: 'settings.zip',
      mediaType: 'application/zip',
      size: 10,
    },
    {
      type: 'safety',
      id: 'hot',
      severity: 'warning',
      hazard: [t('Hot surface')],
      symbols: ['w001', 'm002', 'unknown'],
      blocks: [
        p('hot-1'),
        {
          type: 'list',
          id: 'hot-list',
          ordered: false,
          items: [{ id: 'hot-item', content: [t('Wear gloves.')], blocks: [] }],
        },
      ],
    },
    {
      type: 'safety',
      id: 'shock',
      severity: 'danger',
      hazard: [t('Electric shock')],
      symbols: ['w001'],
      blocks: [
        {
          type: 'list',
          id: 'shock-list',
          ordered: true,
          items: [{ id: 'shock-item', content: [t('Unplug it.')], blocks: [] }],
        },
      ],
    },
    {
      type: 'admonition',
      id: 'tip',
      kind: 'tip',
      blocks: [
        p('tip-1'),
        {
          type: 'safety',
          id: 'inner-safety',
          severity: 'caution',
          hazard: [t('Steam')],
          symbols: [],
          blocks: [p('inner-safety-1')],
        },
        { type: 'moduleRef', id: 'ref-in-note', module: 'note-snippet' },
      ],
    },
    {
      type: 'faq',
      id: 'faq',
      question: [t('Why does it click?')],
      blocks: [p('faq-1')],
    },
    {
      type: 'variant',
      id: 'pro-only',
      when: { op: 'in', attr: 'model', values: ['pro'] },
      blocks: [p('pro-1')],
    },
    {
      type: 'variant',
      id: 'basic-only',
      when: { op: 'in', attr: 'model', values: ['basic'] },
      blocks: [p('basic-1')],
    },
    {
      type: 'variant',
      id: 'not-basic',
      when: { op: 'not', of: { op: 'in', attr: 'model', values: ['basic'] } },
      blocks: [p('not-basic-1')],
    },
    {
      type: 'variant',
      id: 'new-software',
      when: {
        op: 'all',
        of: [
          { op: 'cmp', attr: 'software', cmp: '>=', value: '3' },
          { op: 'in', attr: 'market', values: ['us'] },
        ],
      },
      blocks: [p('new-software-1')],
    },
    { type: 'moduleRef', id: 'ref', module: 'snippet' },
    { type: 'moduleRef', id: 'ref-big', module: 'big-snippet' },
    {
      type: 'literal',
      id: 'code',
      text: 'if (a < b && c) {\n  go();\n}',
      language: 'js',
    },
    { type: 'passthrough', id: 'raw', format: 'html', raw: '<b>raw</b>' },
    { type: 'pageBreak', id: 'break' },
    {
      type: 'section',
      id: 'outer',
      title: [t('Outer section')],
      blocks: [
        p('outer-1'),
        {
          type: 'section',
          id: 'inner',
          title: [t('Inner '), t('section', [{ type: 'emphasis' }])],
          blocks: [p('inner-1')],
        },
      ],
    },
    {
      type: 'section',
      id: 'second',
      title: [t('Second section')],
      blocks: [p('second-1')],
    },
  ],
  {
    audience: 'user',
    keywords: ['kettle', 'water'],
    facets: { area: ['kitchen'] },
  },
);

const snippet = module('snippet', 'snippet', [p('snippet-1'), p('snippet-2')]);
const noteSnippet = module('note-snippet', 'snippet', [
  {
    type: 'admonition',
    id: 'snippet-note',
    kind: 'note',
    blocks: [p('snippet-note-1')],
  },
]);
const bigSnippet = module('big-snippet', 'snippet', [
  p('big-1'),
  {
    type: 'section',
    id: 'big-section',
    title: [t('In a snippet')],
    blocks: [p('big-2')],
  },
]);

const steps = module('steps', 'procedure', [
  p('before'),
  {
    type: 'procedure',
    id: 'main',
    title: [t('Filling')],
    steps: [
      {
        id: 'fill',
        content: [t('Fill the kettle.')],
        blocks: [
          p('fill-info'),
          {
            type: 'procedure',
            id: 'sub',
            steps: [{ id: 'sub-1', content: [t('Open the lid.')], blocks: [] }],
          },
        ],
      },
    ],
  },
  {
    type: 'variant',
    id: 'pro-steps',
    when: { op: 'in', attr: 'model', values: ['pro'] },
    blocks: [
      {
        type: 'procedure',
        id: 'pro-procedure',
        steps: [
          {
            id: 'set-temperature',
            content: [t('Set the temperature.')],
            blocks: [],
          },
        ],
      },
    ],
  },
  p('after'),
]);

const referenceData = module(
  'reference-data',
  'reference',
  [
    p('ref-1'),
    {
      type: 'table',
      id: 'ref-table',
      columns: [{ width: 1 }],
      header: false,
      rows: [{ cells: [{ blocks: [p('ref-cell')] }] }],
    },
    {
      type: 'section',
      id: 'ref-section',
      title: [t('More')],
      blocks: [p('ref-2')],
    },
  ],
  { audience: 'service' },
);

const twoProcedures = module('two-procedures', 'procedure', [
  {
    type: 'procedure',
    id: 'first',
    steps: [{ id: 'first-1', content: [t('One')], blocks: [] }],
  },
  p('between'),
  {
    type: 'procedure',
    id: 'second-procedure',
    steps: [{ id: 'second-1', content: [t('Two')], blocks: [] }],
  },
]);

const trouble = module('trouble', 'troubleshooting', [
  p('symptom'),
  {
    type: 'procedure',
    id: 'fix-1',
    steps: [{ id: 'fix-1-1', content: [t('Descale.')], blocks: [] }],
  },
  p('cause-2'),
  {
    type: 'procedure',
    id: 'fix-2',
    title: [t('Second remedy')],
    steps: [{ id: 'fix-2-1', content: [t('Call service.')], blocks: [] }],
  },
  p('after-all'),
]);

const digits = module('2-intro', 'concept', [p('intro')]);

const approximate = module('approximate', 'concept', [
  {
    type: 'variant',
    id: 'either',
    when: {
      op: 'any',
      of: [
        { op: 'in', attr: 'model', values: ['basic'] },
        { op: 'in', attr: 'market', values: ['us'] },
      ],
    },
    blocks: [p('either-1')],
  },
]);

const german = module(
  'steps',
  'procedure',
  steps.blocks,
  { title: 'Füllen' },
  'de',
);

export const SAMPLE_MODULES: readonly Module[] = [
  everything,
  snippet,
  noteSnippet,
  bigSnippet,
  steps,
  referenceData,
  twoProcedures,
  trouble,
  digits,
  approximate,
  german,
];

export const SAMPLE_MANUAL: Manifest = {
  schemaVersion: 1,
  id: 'kettle',
  title: 'Kettle manual',
  audience: 'service',
  variants: [
    { model: 'basic', market: 'eu', software: '2.0' },
    { model: 'pro', market: 'us', software: '3.1' },
    { model: 'max', market: 'us', software: '2.5' },
  ],
  attributes: {
    'product-name': [
      {
        value: 'Kettle Pro',
        when: { op: 'in', attr: 'model', values: ['pro'] },
      },
      { value: 'Kettle' },
    ],
  },
  entries: [
    { module: '2-intro' },
    {
      title: 'Using it',
      entries: [
        { module: 'everything' },
        {
          module: 'steps',
          when: { op: 'in', attr: 'model', values: ['pro', 'max'] },
        },
      ],
    },
    { module: 'reference-data' },
    { module: 'two-procedures' },
    { module: 'trouble' },
    { module: 'missing-module' },
  ],
};

/** The export's input for the sample manual (every language, every variant). */
export function sampleInput(
  overrides: Partial<DitaExportInput> = {},
): DitaExportInput {
  const modules = new Map(
    SAMPLE_MODULES.map((m) => [`${m.meta.lang}/${m.id}`, m]),
  );
  return {
    config: SAMPLE_CONFIG,
    manifest: SAMPLE_MANUAL,
    languages: ['en', 'de'],
    variants: SAMPLE_MANUAL.variants,
    module: (id, lang) => modules.get(`${lang}/${id}`),
    asset: (ref) =>
      ref === IMAGE
        ? { extension: '.png' }
        : ref === FILE
          ? { extension: '.zip' }
          : undefined,
    symbol: (id) =>
      id === 'w001'
        ? { extension: '.svg' }
        : id === 'm002'
          ? { extension: '.png' }
          : undefined,
    ...overrides,
  };
}

export const SAMPLE_ASSETS = { IMAGE, FILE, MISSING };
