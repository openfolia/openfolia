import { parseInline, printInline } from './asciidoc/inline.js';
import { parseModule } from './asciidoc/parse.js';
import { printModule } from './asciidoc/print.js';
import { AsciidocParseError } from './asciidoc/syntax.js';
import type { Block } from './blocks.js';
import { ProjectConfig } from './config.js';
import { Inline, type Mark, TextNode } from './inline.js';
import { Manifest } from './manifest.js';
import { parseManifest, printManifest } from './manifest-yaml.js';
import { Module } from './module.js';
import { resolveManual } from './resolve.js';
import { Term, TermDefinition } from './term.js';
import { linkedTermIds, termLinks } from './term-links.js';

/** Term links (#245): the `term` mark, its AsciiDoc form, and the linked terms of a manual. */

const term = (termId: string): Mark => ({ type: 'term', termId });
const run = (text: string, ...marks: Mark[]): Inline =>
  marks.length > 0 ? { type: 'text', text, marks } : { type: 'text', text };

const errorOf = (source: string): string => {
  try {
    parseInline(source);
  } catch (e) {
    if (e instanceof AsciidocParseError) return e.message;
    throw e;
  }
  throw new Error('expected a parse error');
};

describe('the term mark in AsciiDoc', () => {
  it('prints a term link as a span with the roles `term` and its ID, and reads it back', () => {
    const nodes = [
      run('Plug in the '),
      run('charger', term('charger')),
      run('.'),
    ];
    const printed = printInline(nodes, true);
    expect(printed).toBe('Plug in the [.term.charger]##charger##.');
    expect(parseInline(printed)).toEqual(nodes);
  });

  it('keeps other marks inside a term link, and a term link inside a UI label', () => {
    const nodes = [
      run('quick', term('quick-charger'), { type: 'strong' }),
      run(' charger', term('quick-charger')),
      run(' and '),
      run('Save', term('save'), { type: 'ui' }),
    ];
    const printed = printInline(nodes, false);
    expect(printed).toBe(
      '[.term.quick-charger]##**quick** charger## and [.term.save]##[.ui]##Save####',
    );
    expect(parseInline(printed)).toEqual(nodes);
  });

  it('reads `##` as text where no term link or UI label is open', () => {
    expect(parseInline('a \\## b')).toEqual([run('a ## b')]);
    expect(printInline([run('a ## b')], true)).not.toContain('[.term');
  });

  it('refuses a term link without a valid ID, nested, inside a link, or around one', () => {
    expect(errorOf('[.term.Charger]##x##')).toMatch(/invalid term link/);
    expect(errorOf('[.term.]##x##')).toMatch(/invalid term link/);
    expect(errorOf('[.term.export]##x##')).toMatch(/no term ID/);
    expect(errorOf('[.term.a]##[.term.b]##x####')).toMatch(/nested term link/);
    expect(errorOf('link:https://example.com[[.term.a]##x##]')).toMatch(
      /term link inside a link/,
    );
    expect(errorOf('[.term.a]##link:https://example.com[x]##')).toMatch(
      /link inside a term link/,
    );
    expect(errorOf('[.term.a]##open')).toMatch(/./);
  });

  it('round-trips a module with term links in a title, a list item and a table cell', () => {
    const module = Module.parse({
      schemaVersion: 1,
      id: 'charging',
      meta: { title: 'Charging', type: 'concept', lang: 'en' },
      blocks: [
        {
          type: 'section',
          id: 's',
          title: [run('The '), run('charger', term('charger'))],
          blocks: [
            {
              type: 'list',
              id: 'l',
              ordered: false,
              items: [
                {
                  id: 'i',
                  content: [
                    run('Use the '),
                    run('charging', term('socket'), { type: 'emphasis' }),
                    run(' socket', term('socket')),
                    run('.'),
                  ],
                  blocks: [],
                },
              ],
            },
            {
              type: 'table',
              id: 't',
              columns: [{ width: 1 }],
              header: false,
              rows: [
                {
                  cells: [
                    {
                      blocks: [
                        {
                          type: 'paragraph',
                          id: 'c',
                          content: [run('A '), run('charger', term('charger'))],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const printed = printModule(module);
    expect(printed).toContain('== The [.term.charger]##charger##');
    expect(printed).toContain('[.term.socket]##__charging__ socket##');
    const read = parseModule(printed, { id: 'charging' });
    expect(read).toEqual(module);
    expect(printModule(read)).toBe(printed);
    expect([...termLinks(read.blocks)]).toEqual([
      { termId: 'charger', blockId: 's' },
      { termId: 'socket', blockId: 'i' },
      { termId: 'charger', blockId: 'c' },
    ]);
    expect(linkedTermIds(read.blocks)).toEqual(['charger', 'socket']);
  });
});

describe('the term mark in the model', () => {
  it('takes a term ID, never a link on the same text', () => {
    expect(TextNode.safeParse(run('x', term('charger'))).success).toBe(true);
    expect(TextNode.safeParse(run('x', term('Not An ID'))).success).toBe(false);
    expect(
      TextNode.safeParse(
        run('x', term('charger'), {
          type: 'link',
          href: 'https://example.com',
        }),
      ).success,
    ).toBe(false);
  });

  it('is not allowed in cross-reference text or a term’s definition', () => {
    expect(
      Inline.safeParse({
        type: 'xref',
        module: 'charging',
        text: [run('the charger', term('charger'))],
      }).success,
    ).toBe(false);
    expect(
      TermDefinition.safeParse([run('see charger', term('charger'))]).success,
    ).toBe(false);
    expect(
      TermDefinition.safeParse([run('the device', { type: 'strong' })]).success,
    ).toBe(true);
  });

  it('counts neighbouring runs of one link once, and each link apart', () => {
    const blocks: Block[] = [
      {
        type: 'paragraph',
        id: 'p',
        content: [
          run('quick', term('charger'), { type: 'strong' }),
          run(' charger', term('charger')),
          run(' or a '),
          run('charger', term('charger')),
          run('socket', term('socket')),
        ],
      },
    ];
    expect([...termLinks(blocks)].map((l) => l.termId)).toEqual([
      'charger',
      'charger',
      'socket',
    ]);
  });
});

describe('the glossary of a manual', () => {
  const config = ProjectConfig.parse({
    languages: { source: 'en', targets: ['de'] },
    moduleTypes: [{ id: 'concept', label: 'Concept' }],
    audiences: [{ id: 'public', label: 'Public' }],
  });
  const linking = (id: string, lang: string, terms: string[]): Module =>
    Module.parse({
      schemaVersion: 1,
      id,
      meta: { title: id, type: 'concept', lang, audience: 'public' },
      blocks: [
        {
          type: 'paragraph',
          id: 'p',
          content: terms.map((t) => run(t, term(t))),
        },
      ],
    });
  const terms = new Map(
    [
      ['zebra', { en: 'Zebra crossing', de: 'Zebrastreifen' }],
      ['apple', { en: 'apple', de: 'Äpfel' }],
      ['bolt', { en: 'Bolt' }],
    ].map(([id, words]) => [
      id as string,
      Term.parse({
        schemaVersion: 1,
        id,
        status: 'approved',
        languages: Object.fromEntries(
          Object.entries(words as Record<string, string>).map(([l, w]) => [
            l,
            { preferred: w, definition: [run(`${w}.`)] },
          ]),
        ),
      }),
    ]),
  );
  const manifest = (glossary?: boolean) =>
    Manifest.parse({
      schemaVersion: 1,
      id: 'op',
      title: 'Operating manual',
      ...(glossary !== undefined && { glossary }),
      variants: [{}],
      entries: [{ module: 'a' }, { module: 'b' }],
    });
  const modules = [
    linking('a', 'en', ['zebra', 'apple']),
    linking('b', 'en', ['bolt', 'missing', 'zebra']),
    linking('a', 'de', ['zebra', 'apple']),
  ];
  const resolve = (lang: string, glossary?: boolean) =>
    resolveManual({
      manifest: manifest(glossary),
      variant: {},
      lang,
      config,
      loadModule: (id, l) =>
        modules.find((m) => m.id === id && m.meta.lang === l),
      loadTerm: (id) => terms.get(id),
    }).manual;

  it('lists the terms the manual links, each once, alphabetical in its language', () => {
    const manual = resolve('en', true);
    expect(manual.glossary).toBe(true);
    expect(manual.terms?.map((t) => [t.id, t.lang, t.preferred])).toEqual([
      ['apple', 'en', 'apple'],
      ['bolt', 'en', 'Bolt'],
      ['zebra', 'en', 'Zebra crossing'],
    ]);
  });

  it('falls back to the source language for a term not translated, and sorts by the manual’s', () => {
    // Module b has no German file: its English one stands in, its terms linked too.
    const manual = resolve('de');
    expect(manual.glossary).toBe(false);
    expect(manual.terms?.map((t) => [t.id, t.lang, t.preferred])).toEqual([
      ['apple', 'de', 'Äpfel'],
      ['bolt', 'en', 'Bolt'],
      ['zebra', 'de', 'Zebrastreifen'],
    ]);
  });

  it('reads and prints `glossary: true` in the manifest', () => {
    const text = printManifest(manifest(true));
    expect(text).toContain('glossary: true\n');
    expect(parseManifest(text, { id: 'op' }).glossary).toBe(true);
    expect(printManifest(manifest())).not.toContain('glossary');
  });
});
