import {
  sourceHashes,
  type Block,
  type Inline,
  type Module,
  type TextNode,
} from '@openfolia/content-model';
import { xliffSchemaErrors } from '../testing/validate.js';
import { wordCount, xliffUnitsOf } from './units.js';
import {
  writeXliff,
  XliffWriteError,
  type XliffDocument,
  type XliffModule,
} from './write.js';

const module = (blocks: Block[], id = 'charging'): Module => ({
  schemaVersion: 1,
  id,
  meta: {
    title: 'Charging & care',
    type: 'procedure',
    lang: 'en',
    facets: {},
  },
  blocks,
});

const para = (id: string, content: Inline[]): Block => ({
  type: 'paragraph',
  id,
  content,
});

const text = (value: string, marks?: TextNode['marks']): TextNode => ({
  type: 'text',
  text: value,
  ...(marks && { marks }),
});

const doc = (m: Module, include?: Set<string>): XliffDocument => ({
  srcLang: 'en',
  trgLang: 'de',
  meta: { job: 'job-1', commit: 'a'.repeat(40) },
  modules: [
    {
      moduleId: m.id,
      title: m.meta.title,
      original: `modules/en/${m.id}.adoc`,
      units: xliffUnitsOf(m, include),
    },
  ],
});

/** The `<source>` of the first unit's first segment. */
const firstSource = (xml: string) => /<source>(.*?)<\/source>/s.exec(xml)?.[1];

describe('writeXliff', () => {
  it('names the directions on each file, schema-valid, only when given (#458)', async () => {
    const m = module([para('p', [text('Text')])]);
    const xml = writeXliff({
      ...doc(m),
      trgLang: 'he',
      srcDir: 'ltr',
      trgDir: 'rtl',
    });
    expect(await xliffSchemaErrors(xml)).toEqual([]);
    expect(xml).toContain(
      '<file id="charging" original="modules/en/charging.adoc" srcDir="ltr" trgDir="rtl">',
    );
    expect(writeXliff(doc(m))).not.toContain('Dir=');
    expect(writeXliff({ ...doc(m), trgDir: 'auto' as never })).not.toContain(
      'Dir=',
    );
  });

  it('is checked by a schema check that does refuse an invalid document', async () => {
    // No <file>, and a <unit> where none may be: the check is no rubber stamp.
    expect(
      await xliffSchemaErrors(
        '<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="en"><unit id="x"/></xliff>',
      ),
    ).not.toEqual([]);
  });

  it('writes one file per module and one unit per block, valid against the XLIFF 2.0 core schema', async () => {
    const m = module([
      {
        type: 'section',
        id: 'intro',
        title: [text('Before you start')],
        blocks: [
          para('first', [
            text('Plug in the '),
            text('charger', [{ type: 'strong' }]),
            text('.'),
          ]),
          {
            type: 'list',
            id: 'steps',
            ordered: true,
            items: [
              { id: 'step-1', content: [text('Open the lid.')], blocks: [] },
            ],
          },
        ],
      },
      {
        type: 'image',
        id: 'photo',
        asset: `sha256:${'0'.repeat(64)}`,
        alt: 'The charger',
        title: [text('Figure title')],
      },
    ]);
    const xml = writeXliff(doc(m));
    expect(await xliffSchemaErrors(xml)).toEqual([]);
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<xliff /);
    expect(xml).toContain('xmlns="urn:oasis:names:tc:xliff:document:2.0"');
    expect(xml).toContain('srcLang="en" trgLang="de"');
    expect(xml).toContain(`ccms:job="job-1" ccms:commit="${'a'.repeat(40)}"`);
    expect(xml).toContain(
      '<file id="charging" original="modules/en/charging.adoc">',
    );
    const units = [...xml.matchAll(/<unit id="([^"]+)"/g)].map((u) => u[1]);
    expect(units).toEqual(['intro', 'first', 'step-1', 'photo']);
    const hashes = sourceHashes(m);
    expect(xml).toContain(
      `<unit id="first" canResegment="no" xml:space="preserve" ccms:sourceHash="${hashes.get('first')}" ccms:kind="paragraph">`,
    );
    expect(xml).toContain(
      '<note category="ccms:module">Charging &amp; care</note>',
    );
    expect(xml).toContain(
      '<note category="ccms:path">section#intro &gt; list#steps &gt; item#step-1</note>',
    );
    // An image: its alt text and its title, one segment each.
    expect(xml).toMatch(
      /<segment id="alt">\s*<source>The charger<\/source>\s*<\/segment>\s*<segment id="title">\s*<source>Figure title<\/source>/,
    );
    expect(xml).not.toContain('<target');
  });

  it('writes each callout legend as a unit of its own, by the callout and its image, schema-valid (#548)', async () => {
    const m = module([
      {
        type: 'section',
        id: 'parts',
        title: [text('Parts')],
        blocks: [
          {
            type: 'image',
            id: 'photo',
            asset: `sha256:${'0'.repeat(64)}`,
            alt: 'The charger',
            callouts: [
              {
                id: 'switch',
                anchor: { x: 0.5, y: 0.5 },
                legend: [
                  text('Power '),
                  text('switch', [{ type: 'strong' }]),
                  text(', see '),
                  { type: 'calloutRef', block: 'photo', callout: 'filter' },
                ],
              },
              {
                id: 'filter',
                anchor: { x: 0.2, y: 0.2 },
                legend: [text('Filter')],
                when: { op: 'in', attr: 'model', values: ['large'] },
              },
            ],
          },
        ],
      },
    ]);
    const xml = writeXliff(doc(m));
    expect(await xliffSchemaErrors(xml)).toEqual([]);
    expect(xml).toMatch(
      /<unit id="switch" [^>]*ccms:kind="callout" ccms:image="photo">/,
    );
    // Hidden in some variants, shown in others: sent all the same.
    expect(xml).toMatch(/<unit id="filter" [^>]*ccms:image="photo">/);
    expect(xml).toContain(
      '<note category="ccms:path">section#parts &gt; image#photo &gt; callout#switch</note>',
    );
    expect(xml).toContain(
      '<segment id="legend">\n        <source>Power <pc id="1" type="fmt" subType="xlf:b">switch</pc>, see <ph id="2" type="other" subType="ccms:callout"',
    );
    // The image's own unit names no image.
    expect(xml).toMatch(/<unit id="photo" [^>]*ccms:kind="image">/);
    expect(xliffUnitsOf(m, new Set(['filter'])).map((u) => u.blockId)).toEqual([
      'filter',
    ]);
  });

  it('writes only the units asked for', () => {
    const m = module([
      para('one', [text('One.')]),
      para('two', [text('Two.')]),
    ]);
    const xml = writeXliff(doc(m, new Set(['two'])));
    expect([...xml.matchAll(/<unit id="([^"]+)"/g)].map((u) => u[1])).toEqual([
      'two',
    ]);
  });

  it('writes marks as nested <pc> in canonical order, sharing them between runs', async () => {
    const m = module([
      para('p', [
        text('a', [{ type: 'emphasis' }, { type: 'strong' }]),
        text('b', [{ type: 'strong' }]),
        text('c', [
          { type: 'link', href: 'https://example.org/?a=1&b="2"' },
          { type: 'code' },
        ]),
        text('d', [{ type: 'ui' }, { type: 'sub' }, { type: 'sup' }]),
      ]),
    ]);
    const xml = writeXliff(doc(m));
    expect(await xliffSchemaErrors(xml)).toEqual([]);
    expect(firstSource(xml)).toBe(
      '<pc id="1" type="fmt" subType="xlf:b"><pc id="2" type="fmt" subType="xlf:i">a</pc>b</pc>' +
        '<pc id="3" type="link" subType="ccms:link" ccms:href="https://example.org/?a=1&amp;b=&quot;2&quot;"><pc id="4" type="fmt" subType="ccms:code">c</pc></pc>' +
        '<pc id="5" type="ui" subType="ccms:ui"><pc id="6" type="fmt" subType="ccms:sub"><pc id="7" type="fmt" subType="ccms:sup">d</pc></pc></pc>',
    );
  });

  it('writes attribute references, keys and hard breaks as <ph>, cross-references with text as <pc>', async () => {
    const m = module([
      para('p', [
        text('Charge the '),
        { type: 'attribute', name: 'product' },
        text(' with '),
        { type: 'kbd', keys: ['Ctrl', '"S"'] },
        { type: 'hardBreak' },
        { type: 'xref', module: 'safety', block: 'warning' },
        text(' and '),
        {
          type: 'xref',
          module: 'safety',
          text: [text('the '), text('notes', [{ type: 'emphasis' }])],
        },
      ]),
    ]);
    const xml = writeXliff(doc(m));
    expect(await xliffSchemaErrors(xml)).toEqual([]);
    expect(firstSource(xml)).toBe(
      'Charge the <ph id="1" type="other" subType="ccms:attribute" disp="{product}" ccms:name="product"/>' +
        ' with <ph id="2" type="ui" subType="ccms:kbd" disp="Ctrl+&quot;S&quot;" ccms:keys="[&quot;Ctrl&quot;,&quot;\\&quot;S\\&quot;&quot;]"/>' +
        '<ph id="3" type="fmt" subType="xlf:lb" equiv="&#10;"/>' +
        '<ph id="4" type="link" subType="ccms:xref" disp="[safety#warning]" ccms:module="safety" ccms:block="warning"/>' +
        ' and <pc id="5" type="link" subType="ccms:xref" ccms:module="safety">the <pc id="6" type="fmt" subType="xlf:i">notes</pc></pc>',
    );
  });

  it('gives inline codes IDs unique within the unit, across its segments', () => {
    const m = module([
      {
        type: 'attachment',
        id: 'file',
        asset: `sha256:${'0'.repeat(64)}`,
        name: 'Config',
        description: 'Settings',
        fileName: 'config.zip',
        mediaType: 'application/zip',
        size: 10,
      },
      {
        type: 'safety',
        id: 'hot',
        severity: 'warning',
        hazard: [text('Hot', [{ type: 'strong' }])],
        symbols: [],
        blocks: [para('inside', [text('x', [{ type: 'strong' }])])],
      },
      {
        type: 'faq',
        id: 'ask',
        question: [text('Why?')],
        blocks: [para('answer', [text('Because.')])],
      },
    ]);
    const xml = writeXliff(doc(m));
    expect(xml).toContain('<segment id="question">');
    expect(xml).toContain(
      '<note category="ccms:path">faq#ask &gt; paragraph#answer</note>',
    );
    expect(xml).toContain('<unit id="hot"');
    // Each unit starts its own numbering.
    expect([...xml.matchAll(/<pc id="(\d+)"/g)].map((c) => c[1])).toEqual([
      '1',
      '1',
    ]);
    expect(xml).toContain(
      '<note category="ccms:path">safety#hot &gt; paragraph#inside</note>',
    );
  });

  it('escapes markup and carries characters XML cannot hold as <cp>', async () => {
    const m = module([
      para('p', [text('a < b && c > d ]]> \u0001 ￿ \uD800 end')]),
    ]);
    const xml = writeXliff({
      ...doc(m),
      modules: [
        { ...(doc(m).modules[0] as XliffModule), title: 'Bad \u0002 <title>' },
      ],
    });
    expect(await xliffSchemaErrors(xml)).toEqual([]);
    expect(firstSource(xml)).toBe(
      'a &lt; b &amp;&amp; c &gt; d ]]&gt; <cp hex="0001"/> <cp hex="FFFF"/> <cp hex="D800"/> end',
    );
    expect(xml).toContain(
      '<note category="ccms:module">Bad � &lt;title&gt;</note>',
    );
  });

  it('never writes a DOCTYPE or an entity, whatever the content', () => {
    const m = module([
      para('p', [text('<!DOCTYPE x [<!ENTITY e "boom">]>&e;')]),
    ]);
    const xml = writeXliff(doc(m));
    expect(xml).not.toContain('<!');
    expect(xml).not.toMatch(/&e;/);
  });

  it('refuses what XLIFF cannot express', () => {
    expect(() =>
      writeXliff({ srcLang: 'en', trgLang: 'de', modules: [] }),
    ).toThrow(XliffWriteError);
    expect(() =>
      writeXliff({
        srcLang: 'en',
        trgLang: 'de',
        modules: [{ moduleId: 'm', title: 'M', units: [] }],
      }),
    ).toThrow(XliffWriteError);
    const m = module([para('p', [text('x')])]);
    expect(() => writeXliff({ ...doc(m), meta: { 'a b': 'x' } })).toThrow(
      XliffWriteError,
    );
  });
});

describe('wordCount', () => {
  it('counts the word-like segments of every part', () => {
    expect(
      wordCount(
        {
          parts: [
            { field: 'alt', content: [text('Plug in the charger.')] },
            { field: 'title', content: [text('Figure — two')] },
          ],
        },
        'en',
      ),
    ).toBe(6);
  });
});
