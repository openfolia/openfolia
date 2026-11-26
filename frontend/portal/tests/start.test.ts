import type { Block, Inline } from '@openfolia/content-model';
import { parseSnapshot, SNAPSHOT_FORMAT } from '../src/lib/snapshot.ts';
import { ownAnchor, startPage } from '../src/lib/start.ts';

/**
 * The authored start page (#897): how its text becomes a heading, an introduction and featured
 * links, and that a link leads to a page of this build or is left out and reported.
 */
const ORIGIN = 'https://docs.example.com';

type Runs = Inline[];
const t = (text: string, href?: string): Inline => ({
  type: 'text',
  text,
  ...(href !== undefined && { marks: [{ type: 'link', href }] }),
});
const para = (id: string, content: Runs): Block => ({
  type: 'paragraph',
  id,
  content,
});
const list = (id: string, items: Runs[]): Block => ({
  type: 'list',
  id,
  ordered: false,
  items: items.map((content, i) => ({ id: `${id}-${i}`, content, blocks: [] })),
});
const entry = (module: string, title: string, blocks: Block[] = []) => ({
  kind: 'module',
  module,
  title,
  lang: 'en',
  blocks,
});

const manual = (
  id: string,
  title: string,
  entries: unknown[],
  slugs = ['model=small', 'model=large'],
  guide?: unknown,
) => ({
  id,
  title,
  audience: 'public',
  variants: slugs.map((slug) => ({
    slug,
    label: slug,
    values: {},
    resolved: {
      lang: 'en',
      entries,
      origins: { 'charging--steps': { module: 'charging', block: 'steps' } },
      anchors: { 'charging#steps': 'charging--steps' },
    },
    moduleAudiences: Object.fromEntries(
      [
        'charging',
        'step-one',
        'start-welcome',
        'start-more',
        'start-empty',
      ].map((m) => [m, 'public']),
    ),
    pdf: null,
  })),
  ...(guide !== undefined && { guide }),
});

const GUIDE = {
  attribute: { id: 'software', label: 'Software' },
  versions: ['1.0', '2.0'],
  levels: [],
  options: [],
  steps: [
    {
      id: 'step-one',
      module: 'step-one',
      title: 'Step one',
      version: '2.0',
      phase: 'before',
      level: null,
      when: null,
    },
  ],
};

const release = (product: string, over: Record<string, unknown> = {}) => ({
  id: product,
  product,
  productLabel: product.toUpperCase(),
  revision: '1.0',
  tag: product,
  publishedAt: '2026-01-01T00:00:00Z',
  notes: null,
  manuals: [
    manual('operating', 'Operating manual', [entry('charging', 'Charging')]),
    manual(
      'update',
      'Update guide',
      [entry('step-one', 'Step one')],
      ['all'],
      GUIDE,
    ),
  ],
  ...over,
});

const build = (
  entries: unknown[],
  over: Record<string, unknown> = {},
  start: Record<string, unknown> = {},
) =>
  parseSnapshot({
    format: SNAPSHOT_FORMAT,
    audience: 'public',
    audiences: [
      { id: 'public', label: 'Public' },
      { id: 'internal', label: 'Internal' },
    ],
    lang: 'en',
    dir: 'ltr',
    languages: ['en', 'de'],
    variantAttributes: [],
    safetySymbols: [],
    outputLabels: {},
    releases: [release('alpha')],
    older: [release('alpha', { id: 'old', revision: '0.9', segment: '0.9' })],
    assets: {},
    symbols: {},
    branding: null,
    start: {
      manual: manual('portal-start', 'Start page', entries, ['all']),
      origin: ORIGIN,
      basePath: '/',
      ...start,
    },
    ...over,
  });

/** The start page of one list of links. */
const linksOf = (
  items: Runs[],
  over: Record<string, unknown> = {},
  start: Record<string, unknown> = {},
) => {
  const page = startPage(
    build(
      [entry('start-welcome', 'Welcome', [list('start-welcome--l', items)])],
      over,
      start,
    ),
  )!;
  return { links: page.sections[0]!.links, problems: page.problems };
};
/** Where one address leads: its kind and page; undefined: left out. */
const at = (href: string, start: Record<string, unknown> = {}) => {
  const [link] = linksOf([[t('A link', href)]], {}, start).links;
  return link && [link.kind, link.to, link.context];
};

describe('the authored start page', () => {
  it('is undefined without one, and without a module in it', () => {
    expect(startPage(build([], { start: null }))).toBeUndefined();
    expect(startPage(build([]))).toBeUndefined();
  });

  it('takes the first module as heading and lead, its other text and its links; further modules as groups', () => {
    const lead = para('start-welcome--p', [t('The lead.')]);
    const more = para('start-welcome--q', [t('More text.')]);
    const page = startPage(
      build([
        entry('start-welcome', 'Welcome', [
          lead,
          list('start-welcome--l', [
            [t('Operating', `${ORIGIN}/en/alpha/operating/`), t(': Read it.')],
          ]),
          more,
        ]),
        {
          kind: 'group',
          title: 'Not shown',
          entries: [
            entry('start-more', 'More', [
              list('start-more--l', [[t('Elsewhere', 'https://example.org/')]]),
            ]),
          ],
        },
      ]),
    )!;
    expect(page.problems).toEqual([]);
    expect(page.sections).toMatchObject([
      {
        title: 'Welcome',
        lead: [lead],
        text: [more],
        links: [{ title: 'Operating', text: 'Read it.' }],
      },
      { title: 'More', lead: [], text: [], links: [{ title: 'Elsewhere' }] },
    ]);
  });

  it('leaves a list that is not of links alone as text', () => {
    const mixed = list('start-welcome--l', [
      [t('Elsewhere', 'https://example.org/')],
      [t('no link')],
    ]);
    const page = startPage(
      build([entry('start-welcome', 'Welcome', [mixed])]),
    )!;
    expect(page.sections[0]).toMatchObject({ text: [mixed], links: [] });
  });

  it('reads a title of several runs, and a line after a colon or a dash', () => {
    const href = 'https://example.org/';
    const { links } = linksOf([
      [t('Spare ', href), t('parts', href), t(' – order one')],
      [t('Support', href), t(': ask')],
      [t('Plain', href), t(' and simple')],
      [t(' '), t('Alone', href)],
    ]);
    expect(links.map((l) => [l.title, l.text])).toEqual([
      ['Spare parts', 'order one'],
      ['Support', 'ask'],
      ['Plain', 'and simple'],
      ['Alone', ''],
    ]);
  });

  it('leads an address of the portal to its page, in this build’s language', () => {
    expect(at(`${ORIGIN}/en/alpha/operating/model=large/`)).toEqual([
      'manual',
      'alpha/operating/model=large/',
      'ALPHA',
    ]);
    // Copied in another language, without its slash, escaped, as a file, or without its variant.
    for (const path of [
      'de/alpha/operating/model=large',
      'en/alpha/operating/model%3Dlarge/',
      'en/alpha/operating/model=large/index.html',
      'alpha/operating/model=large/?switched=model&changed=power',
    ])
      expect(at(`${ORIGIN}/${path}`)?.[1]).toBe('alpha/operating/model=large/');
    expect(at(`${ORIGIN}/en/alpha/operating/`)?.[1]).toBe(
      'alpha/operating/model=small/',
    );
    expect(at(`${ORIGIN}/en/alpha/update/?from=1.0&to=2.0`)?.[1]).toBe(
      'alpha/update/?from=1.0&to=2.0',
    );
    expect(at(`${ORIGIN}/de/search/?q=Akku`)).toEqual([
      'search',
      'search/?q=Akku',
      '',
    ]);
    expect(at(`${ORIGIN}/en/search/?q=x&release=alpha/0.9`)?.[1]).toBe(
      'search/?q=x&release=alpha/0.9',
    );
    expect(at(`${ORIGIN}/en/manuals/?product=alpha`)?.[1]).toBe(
      'manuals/?product=alpha',
    );
    expect(at(`${ORIGIN}/en/alpha/v/0.9/`)).toEqual([
      'release',
      'alpha/v/0.9/',
      'ALPHA 0.9',
    ]);
    expect(at(`${ORIGIN}/en/#product-alpha`)).toEqual([
      'list',
      '#product-alpha',
      'ALPHA',
    ]);
  });

  it('keeps a section an address names when its page has it, and reports one it has not', () => {
    const page = `${ORIGIN}/en/alpha/operating/model=small/`;
    expect(at(`${page}#of-charging`)).toEqual([
      'section',
      'alpha/operating/model=small/#of-charging',
      'Operating manual',
    ]);
    expect(at(`${page}#of-charging--steps`)?.[1]).toContain(
      '#of-charging--steps',
    );
    const { links, problems } = linksOf([[t('Gone', `${page}#of-gone`)]]);
    expect(links[0]).toMatchObject({
      kind: 'manual',
      to: 'alpha/operating/model=small/',
    });
    expect(problems).toEqual([expect.stringContaining('names a section')]);
  });

  it('leaves out a link to a page the build does not have, and reports it', () => {
    for (const path of [
      'en/alpha/gone/',
      'en/beta/operating/',
      'en/alpha/v/0.1/',
      'en/search/?q=x&release=alpha/0.1',
      'en/',
      'en/assets/0.pdf',
      'en/%E0%A4%A/',
    ]) {
      const { links, problems } = linksOf([
        [t('A title', `${ORIGIN}/${path}`)],
        [t('Elsewhere', 'https://example.org/')],
      ]);
      expect(links.map((l) => l.title)).toEqual(['Elsewhere']);
      expect(problems).toEqual([
        expect.stringMatching(/A title.*which no link can open/),
      ]);
    }
  });

  it('holds a portal under a path to that path: the rest of the host is elsewhere', () => {
    const under = { basePath: '/manuals/' };
    expect(at(`${ORIGIN}/manuals/en/alpha/operating/`, under)?.[1]).toBe(
      'alpha/operating/model=small/',
    );
    expect(at(`${ORIGIN}/manuals/en/gone/`, under)).toBeUndefined();
    expect(at(`${ORIGIN}/support/`, under)).toEqual([
      'external',
      `${ORIGIN}/support/`,
      'docs.example.com',
    ]);
  });

  it('without the portal’s address, only a cross-reference is checked; an address leads as written', () => {
    expect(at(`${ORIGIN}/en/alpha/gone/`, { origin: null })?.[0]).toBe(
      'external',
    );
    expect(at('https://www.example.org/a?b#c')).toEqual([
      'external',
      'https://www.example.org/a?b#c',
      'example.org',
    ]);
    expect(at('mailto:help@example.org')?.[2]).toBe('help@example.org');
  });

  it('leads a cross-reference to the first manual with the module, a guide’s step to the guide', () => {
    const { links, problems } = linksOf([
      [{ type: 'xref', module: 'charging' }, t(': at the dock')],
      [
        {
          type: 'xref',
          module: 'charging',
          block: 'steps',
          text: [t('Steps')] as never,
        },
      ],
      [{ type: 'xref', module: 'charging', block: 'gone' }],
      [{ type: 'xref', module: 'step-one' }],
      [{ type: 'xref', module: 'secret', text: [t('Secret')] as never }],
    ]);
    const operating = 'alpha/operating/model=small/';
    expect(links.map((l) => [l.title, l.to, l.guide])).toEqual([
      ['Charging', `${operating}#of-charging`, false],
      ['Steps', `${operating}#of-charging--steps`, false],
      ['Charging', `${operating}#of-charging`, false],
      ['Step one', 'alpha/update/#of-s0-step-one', true],
    ]);
    expect(problems).toEqual([expect.stringContaining('module secret')]);
  });

  it('reads a link in the text as a card’s, and reports one that opens nothing', () => {
    const page = startPage(
      build([
        entry('start-welcome', 'Welcome', [
          para('start-welcome--p', [
            t('gone', `${ORIGIN}/en/gone/`),
            t(' kept', `${ORIGIN}/de/alpha/operating/`),
            { type: 'xref', module: 'secret' },
            { type: 'xref', module: 'start-welcome' },
          ]),
        ]),
      ]),
    )!;
    // What the renderer asks for each address (`startHtml`): the page itself, in this language.
    expect(page.link(`${ORIGIN}/de/alpha/operating/`)?.to).toBe(
      'alpha/operating/model=small/',
    );
    expect(page.link(`${ORIGIN}/en/gone/`)).toBeUndefined();
    expect(page.problems).toEqual([
      expect.stringMatching(/\/en\/gone\/.*shown without/),
      expect.stringMatching(/module secret.*shown without/),
    ]);
  });

  it('leads a cross-reference to its own sections to where they show', () => {
    const card = (module: string): Runs => [{ type: 'xref', module }];
    const page = startPage(
      build([
        entry('start-welcome', 'Welcome', [
          para('start-welcome--p', [t('Lead')]),
          para('start-welcome--q', [t('Text')]),
          list('start-welcome--l', [
            card('start-more'),
            card('start-empty'),
            card('start-welcome'),
          ]),
          para('start-welcome--r', [{ type: 'xref', module: 'start-empty' }]),
        ]),
        entry('start-more', 'More', [
          list('start-more--l', [[t('Elsewhere', 'https://example.org/')]]),
        ]),
        // Nothing of it is left: it goes, and what leads to it is left out and reported.
        entry('start-empty', 'Empty', [
          list('start-empty--l', [[t('Gone', `${ORIGIN}/en/gone/`)]]),
        ]),
      ]),
    )!;
    expect(page.sections.map((s) => s.module)).toEqual([
      'start-welcome',
      'start-more',
    ]);
    expect(page.sections[0]!.links.map((l) => [l.title, l.to])).toEqual([
      ['More', '#of-at-start-more'],
      ['Welcome', '#of-at-start-welcome'],
    ]);
    expect(page.xref({ module: 'start-empty' })).toBeUndefined();
    expect(page.problems).toEqual([
      expect.stringContaining('“Empty” leads to module start-empty'),
      expect.stringContaining('“Gone” leads to'),
      expect.stringContaining('the text refers to module start-empty'),
    ]);
    const anchor = (module: string, block?: string) =>
      ownAnchor(page, {
        module,
        ...(block !== undefined && { block, id: `${module}--${block}` }),
      });
    expect(anchor('start-more')).toBe('#of-at-start-more');
    expect(anchor('start-welcome', 'p')).toBe('#of-lead-start-welcome--p');
    expect(anchor('start-welcome', 'q')).toBe('#of-start-0-start-welcome--q');
    // A list that became cards has no element of its own: its section stands in for it.
    expect(anchor('start-more', 'l')).toBe('#of-at-start-more');
    expect(anchor('charging')).toBeUndefined();
  });

  it('leads to a manual’s section where the page’s own of that module has nothing to show', () => {
    const page = startPage(
      build([
        entry('start-welcome', 'Welcome', [
          para('start-welcome--p', [{ type: 'xref', module: 'charging' }]),
        ]),
        entry('charging', 'Charging', [
          list('charging--l', [[t('Gone', `${ORIGIN}/en/gone/`)]]),
        ]),
      ]),
    )!;
    expect(page.xref({ module: 'charging' })?.to).toBe(
      'alpha/operating/model=small/#of-charging',
    );
  });

  it('names a section of an update guide only when the guide has it', () => {
    const guide = `${ORIGIN}/en/alpha/update/`;
    expect(at(`${guide}#of-s0-step-one`)?.[1]).toBe(
      'alpha/update/#of-s0-step-one',
    );
    expect(at(`${guide}#of-s0-nothing`)?.[1]).toBe('alpha/update/');
    expect(at(`${guide}#of-s7-step-one`)?.[1]).toBe('alpha/update/');
  });

  it('says a title’s own language, and reports without characters a terminal would act on', () => {
    const german = manual('operating', 'Betrieb', [
      { ...entry('charging', 'Laden'), lang: 'de' },
    ]);
    const { links, problems } = linksOf(
      [
        [{ type: 'xref', module: 'charging' }],
        [t('Named', 'mailto:$&%E2%80%AEmoc@example.com')],
        [t('Red \u001b[31m\u202e', `${ORIGIN}/en/gone/`)],
      ],
      { releases: [release('alpha', { manuals: [german] })] },
    );
    expect(links.map((l) => [l.title, l.lang, l.context])).toEqual([
      ['Laden', 'de', 'Betrieb'],
      // Decoded it would read as another address than it opens.
      ['Named', 'en', '$&%E2%80%AEmoc@example.com'],
    ]);
    expect(problems).toEqual([expect.stringContaining('“Red [31m”')]);
  });

  it('leaves out a group whose links all went, with its heading', () => {
    const page = startPage(
      build([
        entry('start-welcome', 'Welcome'),
        entry('start-more', 'More', [
          list('start-more--l', [[t('Gone', `${ORIGIN}/en/gone/`)]]),
        ]),
      ]),
    )!;
    expect(page.sections.map((s) => s.title)).toEqual(['Welcome']);
  });

  it('is refused above the build’s audience when the pages read it back, its modules too', () => {
    const start = (over: Record<string, unknown>) => ({
      manual: {
        ...manual(
          'portal-start',
          'Start',
          [entry('secret', 'Secret')],
          ['all'],
        ),
        ...over,
      },
      origin: null,
      basePath: '/',
    });
    expect(() => build([], { start: start({ audience: 'internal' }) })).toThrow(
      'manual portal-start is for "internal"',
    );
    expect(() => build([], { start: start({}) })).toThrow(
      'module secret in manual portal-start has no checked audience',
    );
    const [variant] = start({}).manual.variants;
    expect(() =>
      build([], {
        start: start({
          variants: [{ ...variant, moduleAudiences: { secret: 'internal' } }],
        }),
      }),
    ).toThrow('module secret in manual portal-start is for "internal"');
    expect(() =>
      build([], {
        start: {
          ...start({}),
          manual: manual('operating', 'Operating', []),
        },
      }),
    ).toThrow('is both the start page and a manual');
  });
});
