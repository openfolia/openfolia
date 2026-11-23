import {
  Manifest,
  Module,
  ProjectConfig,
  resolveManual,
  Term,
  type ResolvedManual,
  type ResolveIssue,
} from '@openfolia/content-model';

/** A small fictional manual using every block, inline and mark type of the model. */

const text = (t: string) => ({ type: 'text' as const, text: t });
const para = (id: string, t: string) => ({
  type: 'paragraph' as const,
  id,
  content: [text(t)],
});

export const HASH = 'ab'.repeat(32);

export const config = ProjectConfig.parse({
  languages: { source: 'en', targets: ['de', 'fr'] },
  moduleTypes: [
    { id: 'concept', label: 'Concept' },
    { id: 'procedure', label: 'Procedure' },
  ],
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
  textAttributes: [{ id: 'product-name', label: 'Product name' }],
  safetySymbols: [{ id: 'w001', label: 'General warning' }],
  calloutStyles: [{ id: 'square', label: 'Square' }],
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
            { type: 'link', href: 'https://example.com/help?a=1&b=2' },
            { type: 'strong' },
          ],
        },
        text('. The socket '),
        { type: 'calloutRef', block: 'photo', callout: 'socket' },
        text(' and the fan '),
        { type: 'calloutRef', block: 'photo', callout: 'fan' },
        text('.'),
        { type: 'hardBreak' },
        { type: 'text', text: 'H', marks: [{ type: 'emphasis' }] },
        { type: 'text', text: '2', marks: [{ type: 'sub' }] },
        text('O and m'),
        { type: 'text', text: '2', marks: [{ type: 'sup' }] },
        text(' with '),
        { type: 'text', text: 'config.yaml', marks: [{ type: 'code' }] },
        text('. Back to '),
        {
          type: 'xref',
          module: 'basics',
          text: [
            { type: 'text', text: 'the basics', marks: [{ type: 'emphasis' }] },
          ],
        },
        text('.'),
      ],
    },
    {
      type: 'paragraph',
      id: 'terms',
      content: [
        text('Plug the '),
        {
          type: 'text',
          text: 'charger',
          marks: [{ type: 'term', termId: 'charger' }],
        },
        text(' into the '),
        {
          type: 'text',
          text: 'charging ',
          marks: [{ type: 'term', termId: 'socket' }],
        },
        {
          type: 'text',
          text: 'socket',
          marks: [{ type: 'term', termId: 'socket' }, { type: 'strong' }],
        },
        text(', not the '),
        {
          type: 'text',
          text: 'dock',
          marks: [{ type: 'term', termId: 'no-such-term' }],
        },
        text('.'),
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
      type: 'list',
      id: 'checks',
      ordered: true,
      items: [{ id: 'c1', content: [text('Check the cable.')], blocks: [] }],
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
      columns: [{ width: 1 }, { width: 3, align: 'right' }],
      rows: [
        {
          cells: [
            { blocks: [para('h1', 'Light')] },
            { blocks: [para('h2', 'Meaning')] },
          ],
        },
        {
          cells: [
            { rowspan: 2, blocks: [para('r1', 'Green')] },
            { blocks: [para('r1b', 'Ready')] },
          ],
        },
        { cells: [{ blocks: [para('r2', 'Charging')] }] },
        { cells: [{ colspan: 2, blocks: [para('r3', 'Off: no power')] }] },
      ],
    },
    {
      type: 'image',
      id: 'photo',
      asset: `sha256:${HASH}`,
      alt: 'The charger, front view',
      title: [text('The charger')],
      width: 50,
      callouts: [
        {
          id: 'switch',
          anchor: { x: 0.2, y: 0.3 },
          legend: [text('Power switch')],
        },
        {
          id: 'fan',
          anchor: { x: 0.6, y: 0.5 },
          label: { x: 0.85, y: 0.1 },
          legend: [
            text('Fan, '),
            { ...text('large model'), marks: [{ type: 'strong' as const }] },
          ],
          when: { op: 'in', attr: 'model', values: ['large'] },
          style: 'square',
        },
        {
          id: 'socket',
          anchor: { x: 0.5, y: 0.9 },
          legend: [text('Socket')],
        },
      ],
    },
    {
      type: 'image',
      id: 'plain-photo',
      asset: `sha256:${HASH}`,
      alt: 'The plug',
      calloutLegend: 'beside',
      callouts: [
        { id: 'pins', anchor: { x: 0.5, y: 0.5 }, legend: [text('Pins')] },
      ],
    },
    {
      type: 'admonition',
      id: 'n',
      kind: 'tip',
      blocks: [para('n1', 'Charge overnight.')],
    },
    {
      type: 'faq',
      id: 'faq-overnight',
      question: [text('Can I charge overnight?')],
      blocks: [para('faq-overnight-a', 'Yes: the charger stops when full.')],
    },
    {
      type: 'literal',
      id: 'code',
      language: 'sh',
      text: 'echo "<hi>" & exit\n  done',
    },
    {
      type: 'passthrough',
      id: 'raw',
      format: 'html',
      raw: '<b onclick="x()">legacy</b>',
    },
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
        {
          type: 'section',
          id: 'deeper',
          title: [text('Blink codes')],
          blocks: [para('codes', 'Fast blinking means a fault.')],
        },
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

const basicsDe = Module.parse({
  ...basics,
  meta: { ...basics.meta, title: 'Grundlagen', lang: 'de' },
  blocks: [
    {
      type: 'section',
      id: 'lights',
      title: [text('Statusleuchten')],
      blocks: [para('p', 'Sie blinken.')],
    },
  ],
});

export const manifest = Manifest.parse({
  schemaVersion: 1,
  id: 'manual',
  title: 'Operating manual',
  glossary: true,
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

const modules: Record<string, Record<string, Module>> = {
  en: { charging, basics, 'charging-note': note },
  de: { basics: basicsDe },
};

/** The terms the modules link (`no-such-term` is none). */
export const terms: Record<string, Term> = {
  charger: Term.parse({
    schemaVersion: 1,
    id: 'charger',
    status: 'approved',
    languages: {
      en: {
        preferred: 'charger',
        definition: [
          text('The device that charges the '),
          { type: 'text', text: 'battery', marks: [{ type: 'strong' }] },
          text(' <safely>.'),
        ],
      },
    },
  }),
  socket: Term.parse({
    schemaVersion: 1,
    id: 'socket',
    status: 'approved',
    languages: {
      en: {
        preferred: 'charging socket',
        definition: [text('Where the cable plugs in.')],
      },
      de: { preferred: 'Ladebuchse' },
    },
  }),
};

export function resolve(
  model: string,
  lang = 'en',
): { manual: ResolvedManual; issues: ResolveIssue[] } {
  return resolveManual({
    manifest,
    variant: { model },
    lang,
    config,
    loadModule: (id, l) => modules[l]?.[id],
    loadTerm: (id) => (Object.hasOwn(terms, id) ? terms[id] : undefined),
  });
}
