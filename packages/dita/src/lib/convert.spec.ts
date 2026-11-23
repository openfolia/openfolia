import {
  type Block,
  type ImportDocument,
  type Module,
  parseConfig,
  printConfig,
  validateImport,
  walk,
} from '@openfolia/content-model';
import { describe, expect, it } from 'vitest';
import { fixtureConfig, fixtureFiles, withFile } from '../testing/fixture.js';
import { bundleFiles, convertDita } from './convert.js';

const config = fixtureConfig();

/** The report's codes (each message starts with `[code]`). */
const codes = (document: ImportDocument) =>
  new Set(document.report.map((r) => /^\[([a-z-]+)\]/.exec(r.message)?.[1]));

const entries = (document: ImportDocument, code: string) =>
  document.report.filter((r) => r.message.startsWith(`[${code}]`));

const moduleOf = (document: ImportDocument, id: string, lang = 'en') => {
  const module = document.modules.find(
    (m) => m.id === id && m.meta.lang === lang,
  );
  if (!module) throw new Error(`No module ${lang}/${id}`);
  return module;
};

const blocks = (module: Module): Block[] =>
  [...walk(module.blocks)].map((n) => n.node as Block);

const topic = (body: string, attributes = '') =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN" "topic.dtd">
<topic id="t" xml:lang="en"${attributes}><title>T</title><body>${body}</body></topic>`;

/** A project of one map referencing `topics/t.dita`, holding `body`. */
const single = (body: string, extra: Record<string, string> = {}) => {
  const files = new Map<string, Uint8Array>();
  const encode = (text: string) => new TextEncoder().encode(text);
  files.set(
    'map.ditamap',
    encode('<map><title>M</title><topicref href="topics/t.dita"/></map>'),
  );
  files.set('topics/t.dita', encode(topic(body)));
  for (const [path, text] of Object.entries(extra))
    files.set(path, encode(text));
  return files;
};

describe('convertDita on the garden pump fixture', async () => {
  const conversion = await convertDita(fixtureFiles(), config);
  const { document } = conversion;

  it('is a valid import bundle for the target configuration', async () => {
    const validation = await validateImport(
      { files: bundleFiles(conversion) },
      config,
    );
    expect(validation.issues).toEqual([]);
    expect(
      validation.items.flatMap((i) =>
        i.issues.filter((x) => x.severity === 'error'),
      ),
    ).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(validation.counts).toMatchObject({
      modules: 10,
      manuals: 2,
      assets: 1,
    });
  });

  it('makes a module of each topic, its ID from its path, its type from the mapping', () => {
    expect(
      document.modules
        .filter((m) => m.meta.lang === 'en')
        .map((m) => [m.id, m.meta.type, m.meta.audience]),
    ).toEqual([
      ['topics-fault', 'troubleshooting', undefined],
      ['topics-install', 'procedure', undefined],
      ['topics-overview', 'concept', 'operator'],
      ['topics-specs', 'reference', 'technician'],
      ['topics-warehouse', 'concept', undefined],
    ]);
    const overview = moduleOf(document, 'topics-overview');
    expect(overview.meta.title).toBe('About the Garden Pump GP-2');
    expect(overview.meta.keywords).toEqual(['pump', 'garden water']);
    expect(overview.meta.source).toEqual({
      system: 'DITA',
      id: 'en/topics/overview.dita#overview',
    });
  });

  it('reads the translation in de/ as the same modules, with the same block IDs', () => {
    for (const m of document.modules.filter((m) => m.meta.lang === 'en')) {
      const de = moduleOf(document, m.id, 'de');
      expect(blocks(de).map((b) => b.id)).toEqual(blocks(m).map((b) => b.id));
    }
    expect(moduleOf(document, 'topics-overview', 'de').meta.title).toBe(
      'Über die Gartenpumpe GP-2',
    );
    expect(codes(document).has('translation-structure')).toBe(false);
  });

  it('turns a key naming a text attribute into the attribute, and the manual takes its value', () => {
    const [first] = moduleOf(document, 'topics-overview').blocks;
    expect(first).toMatchObject({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'The ' },
        { type: 'attribute', name: 'product-name' },
        {
          type: 'text',
          text: ' moves water from a rain barrel to the garden.',
        },
      ],
    });
    for (const manual of document.manuals) {
      // The first definition wins (DITA 1.3, 2.3.4.1).
      expect(manual.attributes).toEqual({ 'product-name': 'Garden Pump GP-2' });
    }
  });

  it('resolves a content reference, a hazard statement, an image and a cross-reference', () => {
    const install = moduleOf(document, 'topics-install');
    const all = blocks(install);
    expect(all.find((b) => b.id === 'unplug')).toMatchObject({
      type: 'admonition',
      kind: 'important',
    });
    expect(all.find((b) => b.id === 'hot')).toMatchObject({
      type: 'safety',
      severity: 'caution',
      hazard: [{ type: 'text', text: 'Hot surface.' }],
      symbols: ['w017'],
    });
    const overview = moduleOf(document, 'topics-overview');
    const image = blocks(overview).find((b) => b.type === 'image');
    expect(image).toMatchObject({
      id: 'fig-pump',
      alt: 'Side view of the pump',
      title: [{ type: 'text', text: 'The pump' }],
    });
    expect(image).not.toHaveProperty('width');
    expect(conversion.assets.has((image as { asset: string }).asset)).toBe(
      true,
    );
    expect(JSON.stringify(overview.blocks)).toContain(
      '{"type":"xref","module":"topics-install","text":[{"type":"text","text":"connecting the hose"}],"block":"connect"}',
    );
  });

  it('makes profiled content variant blocks, and splits a procedure at a conditional step', () => {
    const install = moduleOf(document, 'topics-install');
    const variant = install.blocks.find((b) => b.type === 'variant');
    expect(variant).toMatchObject({
      when: { op: 'in', attr: 'model', values: ['pro'] },
      blocks: [{ type: 'procedure', steps: [{ id: 'timer' }] }],
    });
    expect(entries(document, 'item-condition')).toHaveLength(2);
  });

  it('converts CALS tables with spans and relative widths, and property tables', () => {
    const specs = moduleOf(document, 'topics-specs');
    const models = specs.blocks.find((b) => b.id === 'models');
    expect(models).toMatchObject({
      type: 'table',
      columns: [{ width: 2 }, { width: 1 }, { width: 1 }],
      header: true,
    });
    const rows = (
      models as { rows: { cells: { colspan?: number; rowspan?: number }[] }[] }
    ).rows;
    expect(rows.map((r) => r.cells.length)).toEqual([3, 3, 2, 1]);
    expect(rows[1]?.cells[1]?.rowspan).toBe(2);
    expect(rows[3]?.cells[0]?.colspan).toBe(3);
    expect(specs.blocks.find((b) => b.id === 'data')).toMatchObject({
      type: 'table',
      header: true,
      columns: [{ width: 1 }, { width: 1 }],
    });
  });

  it('makes a manual of each root map in the source language, with its DITAVAL files as variants', () => {
    expect(document.manuals).toEqual([
      expect.objectContaining({
        id: 'maps-pump-manual',
        title: 'Garden pump operating manual',
        variants: [{}],
        entries: [
          {
            title: 'About the Garden Pump GP-2',
            entries: [
              { module: 'topics-overview' },
              { module: 'topics-specs' },
            ],
          },
          { module: 'topics-install' },
          {
            module: 'topics-fault',
            when: { op: 'in', attr: 'model', values: ['pro'] },
          },
        ],
      }),
      expect.objectContaining({
        id: 'maps-quick-guide',
        title: 'Garden pump quick guide',
        variants: [{ model: 'basic' }, { model: 'pro' }],
        entries: [
          {
            title: 'Getting started',
            entries: [
              { module: 'topics-overview' },
              { module: 'topics-install' },
            ],
          },
        ],
      }),
    ]);
  });

  it('reports what it could not map, and a DITAVAL file no map names is not applied', () => {
    const found = codes(document);
    for (const code of [
      'translated-map',
      'dropped-element',
      'footnote',
      'generated-list',
      'ditaval-unreferenced',
      'item-condition',
      'unsupported-attribute',
    ]) {
      expect(found).toContain(code);
    }
    expect(entries(document, 'ditaval-unreferenced')[0]?.sourceId).toBe(
      'filters/unused.ditaval',
    );
    // The hazard symbol's image is read (a symbol), so not "unused"; nothing else is left over.
    expect(found.has('unused-file')).toBe(false);
  });

  it('is deterministic: the same project gives the same bundle', async () => {
    const again = await convertDita(fixtureFiles(), config);
    expect(JSON.stringify(again.document)).toBe(JSON.stringify(document));
  });

  it('changes only the changed topic’s module when a topic changes', async () => {
    const path = 'en/topics/fault.dita';
    const text = new TextDecoder()
      .decode(fixtureFiles().get(path))
      .replace('The filter is blocked.', 'The filter is clogged.');
    const changed = await convertDita(
      withFile(fixtureFiles(), path, text),
      config,
    );
    const differ = changed.document.modules
      .filter(
        (m, i) => JSON.stringify(m) !== JSON.stringify(document.modules[i]),
      )
      .map((m) => `${m.meta.lang}/${m.id}`);
    expect(differ).toEqual(['en/topics-fault']);
  });

  it('applies an unnamed DITAVAL file to every manual with ditavalDefault: all', async () => {
    const all = parseConfig(
      printConfig({
        ...config,
        dita: {
          ...(config.dita as NonNullable<typeof config.dita>),
          ditavalDefault: 'all',
        },
      }),
    );
    const { document: d } = await convertDita(fixtureFiles(), all);
    expect(d.manuals.map((m) => m.variants)).toEqual([
      [{}],
      [{ model: 'basic' }, { model: 'pro' }, {}],
    ]);
    expect(codes(d).has('ditaval-unreferenced')).toBe(false);
  });
});

describe('convertDita on what it cannot map', () => {
  it('imports an unknown element as a paragraph of its text, and reports it', async () => {
    const { document } = await convertDita(
      single('<p>Before</p><gizmo>Its <b>text</b></gizmo>'),
      config,
    );
    expect(document.modules[0]?.blocks).toMatchObject([
      { type: 'paragraph', content: [{ text: 'Before' }] },
      {
        type: 'paragraph',
        content: [
          { text: 'Its ' },
          { text: 'text', marks: [{ type: 'strong' }] },
        ],
      },
    ]);
    expect(entries(document, 'unknown-element')[0]?.message).toContain(
      '<gizmo>',
    );
  });

  it('generalises a specialisation by the @class it carries, and reports it', async () => {
    const { document } = await convertDita(
      single(
        '<warn class="- topic/note acme-d/warn " type="tip">Careful</warn>',
      ),
      config,
    );
    expect(document.modules[0]?.blocks).toMatchObject([
      { type: 'admonition', kind: 'tip' },
    ]);
    expect(codes(document)).toContain('specialization');
  });

  it('reports unresolved content references, keys and missing images', async () => {
    const { document } = await convertDita(
      single(
        '<p conref="nowhere.dita#x/y"/><p>A <ph keyref="nokey"/> b.</p><image href="gone.png" placement="break"/>',
      ),
      config,
    );
    for (const code of [
      'unresolved-conref',
      'unresolved-key',
      'missing-asset',
    ]) {
      expect(codes(document)).toContain(code);
    }
  });

  it('reads a file declaring DITA 2.0 as 1.3, with a warning', async () => {
    const files = single('<p>x</p>');
    files.set(
      'topics/t.dita',
      new TextEncoder().encode(
        topic(
          '<p>x</p>',
          ' xmlns:ditaarch="http://dita.oasis-open.org/architecture/2005/" ditaarch:DITAArchVersion="2.0"',
        ),
      ),
    );
    const { document } = await convertDita(files, config);
    expect(document.modules).toHaveLength(1);
    expect(codes(document)).toContain('dita-version');
  });

  it('reports a mapping value naming nothing configured, and uses its default there', async () => {
    const wrong = parseConfig(
      printConfig({
        ...config,
        dita: {
          ...(config.dita as NonNullable<typeof config.dita>),
          moduleTypes: { task: 'no-such-type' },
        },
      }),
    );
    const { document } = await convertDita(fixtureFiles(), wrong);
    expect(entries(document, 'mapping')[0]?.message).toContain('no-such-type');
    expect(moduleOf(document, 'topics-install').meta.type).toBe('concept');
  });
});

describe('convertDita on what the review found (#432)', () => {
  const valid = async (files: Map<string, Uint8Array>) => {
    const conversion = await convertDita(files, config);
    const validation = await validateImport(
      { files: bundleFiles(conversion) },
      config,
    );
    expect(
      validation.items.flatMap((i) =>
        i.issues.filter((x) => x.severity === 'error'),
      ),
    ).toEqual([]);
    return conversion.document;
  };

  it('keeps a conditional section a section, its condition on its content', async () => {
    const document = await valid(
      single(
        '<p>x</p><section id="s" product="pro"><title>Pro only</title><p>y</p></section>',
      ),
    );
    expect(document.modules[0]?.blocks).toMatchObject([
      { type: 'paragraph' },
      {
        type: 'section',
        id: 's',
        blocks: [
          {
            type: 'variant',
            when: { op: 'in', attr: 'model', values: ['pro'] },
            blocks: [{ type: 'paragraph' }],
          },
        ],
      },
    ]);
    expect(codes(document)).toContain('section-condition');
  });

  it('makes a valid module of a conditional topic with nested topics', async () => {
    const files = single('<p>x</p>');
    files.set(
      'topics/t.dita',
      new TextEncoder().encode(
        '<topic id="t" product="pro"><title>T</title><body><p>x</p></body><topic id="n"><title>N</title><body><p>y</p></body></topic><topic id="m"><title>M</title><body><p>z</p></body></topic></topic>',
      ),
    );
    const document = await valid(files);
    expect(document.modules[0]?.blocks.map((b) => [b.type, b.id])).toEqual([
      ['variant', 'variant-1'],
      ['section', 'n'],
      ['section', 'm'],
    ]);
  });

  it('resolves a conref chain across folders against each target’s own file', async () => {
    const encode = (t: string) => new TextEncoder().encode(t);
    const files = single('<section conref="../lib/common.dita#c/sec"/>', {
      'lib/common.dita':
        '<topic id="c"><title>C</title><body><section id="sec"><title>S</title><image conref="icons/lib.dita#i/hot"/></section></body></topic>',
      'lib/icons/lib.dita':
        '<topic id="i"><title>I</title><body><image id="hot" href="hot.png" placement="break"><alt>Hot</alt></image></body></topic>',
    });
    files.set('lib/icons/hot.png', encode('png'));
    const { document, assets } = await convertDita(files, config);
    expect(codes(document).has('missing-asset')).toBe(false);
    expect(assets.size).toBe(1);
  });

  it('reports a table row’s condition', async () => {
    const { document } = await convertDita(
      single(
        '<simpletable><strow product="pro"><stentry>a</stentry></strow></simpletable><table><tgroup cols="1"><tbody><row product="pro"><entry>b</entry></row></tbody></tgroup></table>',
      ),
      config,
    );
    expect(
      entries(document, 'item-condition').filter((e) =>
        e.message.includes('table row'),
      ),
    ).toHaveLength(2);
  });

  it('reports a submap’s DITAVAL reference as branch filtering', async () => {
    const encode = (t: string) => new TextEncoder().encode(t);
    const files = single('<p>x</p>', {
      'sub.ditamap':
        '<map><ditavalref href="pro.ditaval"/><topicref href="topics/t.dita"/></map>',
      'pro.ditaval':
        '<val><prop att="product" val="basic" action="exclude"/></val>',
    });
    files.set(
      'map.ditamap',
      encode('<map><title>M</title><mapref href="sub.ditamap"/></map>'),
    );
    const { document } = await convertDita(files, config);
    expect(document.manuals[0]?.variants).toEqual([{}]);
    expect(codes(document)).toContain('ditaval-branch');
  });

  it('keeps what a definition list holds besides its entries', async () => {
    const { document } = await convertDita(
      single('<dl><dlentry><dt>T</dt><dd>D</dd></dlentry><p>stray</p></dl>'),
      config,
    );
    expect(JSON.stringify(document.modules[0]?.blocks)).toContain('stray');
  });
});

describe('convertDita on hostile input', () => {
  it('leaves out a file with an internal DTD subset (entities), never expanding one', async () => {
    const laughs = `<?xml version="1.0"?>
<!DOCTYPE topic [
  <!ENTITY a "aaaaaaaaaa">
  <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
  <!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
]>
<topic id="t"><title>&c;</title><body/></topic>`;
    const xxe = `<?xml version="1.0"?>
<!DOCTYPE topic SYSTEM "topic.dtd" [<!ENTITY x SYSTEM "file:///etc/passwd">]>
<topic id="u"><title>&x;</title><body/></topic>`;
    const files = single('<p>x</p>', {
      'topics/laughs.dita': laughs,
      'topics/xxe.dita': xxe,
    });
    const { document } = await convertDita(files, config);
    expect(document.modules.map((m) => m.id)).toEqual(['topics-t']);
    expect(
      entries(document, 'dtd-subset')
        .map((e) => e.sourceId)
        .sort(),
    ).toEqual(['topics/laughs.dita', 'topics/xxe.dita']);
  });

  it('stops a content reference bomb at the expansion bound, leaving the topic out', async () => {
    // Each level references the one below ten times: 10^7 paragraphs if expanded.
    const levels = Array.from(
      { length: 7 },
      (_, i) =>
        `<div id="l${i}">${Array.from({ length: 10 }, () => (i === 6 ? '<p>x</p>' : `<div conref="#t/l${i + 1}"/>`)).join('')}</div>`,
    ).join('');
    const started = Date.now();
    const { document } = await convertDita(single(levels), config);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(document.modules).toEqual([]);
    expect(codes(document)).toContain('expansion-limit');
  });

  it('cuts a content reference cycle', async () => {
    const { document } = await convertDita(
      single('<p id="a" conref="#t/b"/><p id="b" conref="#t/a"/>'),
      config,
    );
    expect(codes(document)).toContain('conref-cycle');
  });

  it('never reads a file outside the archive, nor fetches one', async () => {
    const { document, assets } = await convertDita(
      single(
        '<image href="../../../../etc/passwd" placement="break"/><image href="https://example.invalid/x.png" placement="break"/><p conref="../../outside.dita#o/p"/><p><xref href="file:///etc/passwd">x</xref></p>',
      ),
      config,
    );
    expect(assets.size).toBe(0);
    for (const code of ['outside-archive', 'external-reference']) {
      expect(codes(document)).toContain(code);
    }
  });
});

describe('convertDita on repeated topic IDs', () => {
  it('finds the top-level topic a fragment names, past a nested one of the same ID', async () => {
    const encode = (t: string) => new TextEncoder().encode(t);
    const files = new Map([
      [
        'map.ditamap',
        encode('<map><title>M</title><topicref href="f.dita#x"/></map>'),
      ],
      [
        'f.dita',
        encode(
          '<dita><topic id="a"><title>A</title><body><p>a</p></body><topic id="x"><title>N</title><body><p>n</p></body></topic></topic><topic id="x"><title>X</title><body><p>x</p></body></topic></dita>',
        ),
      ],
    ]);
    const { document } = await convertDita(files, config);
    const entry = document.manuals[0]?.entries[0];
    const module = document.modules.find(
      (m) => entry && 'module' in entry && m.id === entry.module,
    );
    expect(module?.meta?.title).toBe('X');
  });
});

describe('convertDita on submaps reached by several paths', () => {
  it('walks a submap a cycle cut short again from another path', async () => {
    const encode = (t: string) => new TextEncoder().encode(t);
    const files = new Map([
      [
        'map.ditamap',
        encode(
          '<map><title>M</title><mapref href="a.ditamap"/><mapref href="b.ditamap"/></map>',
        ),
      ],
      [
        'a.ditamap',
        encode(
          '<map><topicref href="a.dita"/><mapref href="b.ditamap"/></map>',
        ),
      ],
      [
        'b.ditamap',
        encode(
          '<map><topicref href="b.dita"/><mapref href="a.ditamap"/></map>',
        ),
      ],
      [
        'a.dita',
        encode('<topic id="a"><title>A</title><body><p>a</p></body></topic>'),
      ],
      [
        'b.dita',
        encode('<topic id="b"><title>B</title><body><p>b</p></body></topic>'),
      ],
    ]);
    const { document } = await convertDita(files, config);
    // Through a: a, b (its a cut); through b: b, a (its b cut), as a fresh walk has it.
    expect(
      document.manuals[0]?.entries.map((e) => ('module' in e ? e.module : '')),
    ).toEqual(['a', 'b', 'b', 'a']);
  });
});
