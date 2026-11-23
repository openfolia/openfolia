import {
  Manifest,
  Module,
  ProjectConfig,
  resolveManual,
  Term,
  type ResolvedManual,
} from '@openfolia/content-model';
import {
  closeWorkerPool,
  compilePagePngInWorker,
  compilePdf,
} from './compile.js';
import { renderTypst } from './render.js';
import { DEFAULT_TEMPLATE } from './template.js';

/** Term links and the generated glossary in the PDF (#245). */

afterAll(() => closeWorkerPool());

const text = (t: string) => ({ type: 'text' as const, text: t });

const config = ProjectConfig.parse({
  languages: { source: 'en', targets: ['de'] },
  moduleTypes: [{ id: 'concept', label: 'Concept' }],
  audiences: [{ id: 'public', label: 'Public' }],
});

const charging = (lang: string, words: [string, string, string]) =>
  Module.parse({
    schemaVersion: 1,
    id: 'charging',
    meta: { title: words[0], type: 'concept', lang, audience: 'public' },
    blocks: [
      {
        type: 'paragraph',
        id: 'p',
        content: [
          text(words[1]),
          {
            type: 'text',
            text: words[2],
            marks: [{ type: 'term', termId: 'charger' }],
          },
          text(', '),
          {
            type: 'text',
            text: 'socket',
            marks: [{ type: 'term', termId: 'socket' }, { type: 'strong' }],
          },
          text(' and '),
          {
            type: 'text',
            text: 'dock',
            marks: [{ type: 'term', termId: 'no-such-term' }],
          },
          text('.'),
        ],
      },
    ],
  });

const modules: Record<string, Module> = {
  en: charging('en', ['Charging', 'Use the ', 'charger']),
  de: charging('de', ['Laden', 'Das ', 'Ladegerät']),
};

const terms: Record<string, Term> = {
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
          text('.'),
        ],
      },
      de: {
        preferred: 'Ladegerät',
        definition: [text('Das Gerät, das die Batterie lädt.')],
      },
    },
  }),
  socket: Term.parse({
    schemaVersion: 1,
    id: 'socket',
    status: 'approved',
    languages: {
      en: {
        preferred: 'Charging socket',
        definition: [text('Where the cable plugs in "safely" #here.')],
      },
    },
  }),
};

const resolve = (lang: string, glossary = true): ResolvedManual =>
  resolveManual({
    manifest: Manifest.parse({
      schemaVersion: 1,
      id: 'operating',
      title: 'Operating manual',
      glossary,
      variants: [{}],
      entries: [{ module: 'charging' }],
    }),
    variant: {},
    lang,
    config,
    loadModule: (id, l) => (id === 'charging' ? modules[l] : undefined),
    loadTerm: (id) => (Object.hasOwn(terms, id) ? terms[id] : undefined),
  }).manual;

/** The generated document from the glossary's heading on: what the glossary page holds. */
const glossaryOf = (source: string) =>
  source.slice(source.indexOf('#heading(level: 1, numbering: none'));

describe('the glossary in the PDF', () => {
  it('links each term to its entry; a term the manual has not is plain text', () => {
    const { source } = renderTypst(resolve('en'));
    expect(source).toContain(
      '#"Use the "#term("_term-charger")[#"charger"]#", "#term("_term-socket")[#strong[#"socket"]]#" and "#[#"dock"]#"."',
    );
  });

  it('ends the manual with the glossary: alphabetical, each term with its definition (snapshot)', () => {
    expect(glossaryOf(renderTypst(resolve('en')).source)).toMatchSnapshot();
  });

  it('is in the manual’s language, a term without a translation in the source language', () => {
    const { source } = renderTypst(resolve('de'));
    const glossary = glossaryOf(source);
    expect(
      glossary.startsWith('#heading(level: 1, numbering: none, "Glossar")'),
    ).toBe(true);
    // Ladegerät (de) before Charging socket (en, set in English): by the German collation.
    expect(glossary.indexOf('"Charging socket"')).toBeLessThan(
      glossary.indexOf('"Ladegerät"'),
    );
    expect(glossary).toMatch(
      /#\[\n#set text\(lang: "en", region: none, dir: ltr\)\n#anchor\("_term-socket"\)#glossary-entry\(term: "Charging socket"\)/,
    );
  });

  it('compiles under PDF/UA-1, the glossary a heading and its terms links', () => {
    const { source } = renderTypst(resolve('en'));
    const pdf = compilePdf({ source }).toString('latin1');
    expect(pdf).toContain('<pdfuaid:part>1</pdfuaid:part>');
    expect(pdf).toMatch(/\/S \/Link\b/);
    // A template without term() and glossary-entry() gets the built-in ones.
    const before = DEFAULT_TEMPLATE.replace(
      /\/\/ A term link: the text[\s\S]*?\n\]\n/,
      '',
    );
    expect(before).not.toContain('#let term');
    expect(before).not.toContain('#let glossary-entry');
    expect(
      compilePdf({ source, template: before }).subarray(0, 5).toString(),
    ).toBe('%PDF-');
  });

  it('has none without `glossary: true`: a term link is the term on its own', () => {
    const { source } = renderTypst(resolve('en', false));
    expect(source).not.toContain('numbering: none');
    expect(source).toContain('#term(none)[#"charger"]');
    expect(compilePdf({ source }).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('renders the glossary page', { timeout: 60_000 }, async () => {
    const { source } = renderTypst(resolve('en'));
    // Title page, contents, the module, the glossary.
    const png = await compilePagePngInWorker(
      { source },
      { number: 4, width: 400 },
    );
    expect(Buffer.from(png.subarray(1, 4)).toString()).toBe('PNG');
  });
});
