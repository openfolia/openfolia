import {
  normalizeModule,
  translatableUnits,
  type Block,
  type Inline,
  type Module,
  type TextNode,
} from '@openfolia/content-model';
import {
  MAX_READ_FILES,
  readXliff,
  XliffReadError,
  type ReadUnit,
} from './read.js';
import { MAX_PREFIXES, readXml, XmlReadError } from '@openfolia/xml';
import { targetParts } from './target.js';
import { xliffUnitsOf, type XliffUnit } from './units.js';
import { writeXliff } from './write.js';

const text = (value: string, marks?: TextNode['marks']): TextNode => ({
  type: 'text',
  text: value,
  ...(marks && { marks }),
});
const para = (id: string, content: Inline[]): Block => ({
  type: 'paragraph',
  id,
  content,
});
const module = (blocks: Block[], id = 'charging'): Module => ({
  schemaVersion: 1,
  id,
  meta: { title: 'Charging', type: 'procedure', lang: 'en', facets: {} },
  blocks,
});

/** Every inline kind there is, in one module. */
const rich = module([
  {
    type: 'section',
    id: 'intro',
    title: [text('Before you '), text('start', [{ type: 'emphasis' }])],
    blocks: [
      para('first', [
        text('Plug in the '),
        text('charger', [{ type: 'strong' }, { type: 'emphasis' }]),
        text(' at '),
        { type: 'attribute', name: 'product-name' },
        text(', press '),
        { type: 'kbd', keys: ['Ctrl', 'S'] },
        { type: 'hardBreak' },
        text('see '),
        { type: 'xref', module: 'safety', block: 'warning' },
        text(' and '),
        {
          type: 'xref',
          module: 'safety',
          text: [text('the '), text('notes', [{ type: 'code' }])],
        },
        text(' or '),
        text('the site', [
          { type: 'link', href: 'https://example.org/a?b=1&c=2' },
        ]),
        text(', with the '),
        text('quick', [{ type: 'term', termId: 'quick-charger' }]),
        text(' charger', [
          { type: 'term', termId: 'quick-charger' },
          { type: 'strong' },
        ]),
        text('.'),
      ]),
    ],
  },
  {
    type: 'image',
    id: 'photo',
    asset: `sha256:${'0'.repeat(64)}`,
    alt: 'The charger',
    title: [text('Figure '), text('one', [{ type: 'sub' }])],
  },
]);

const xliffOf = (m: Module) =>
  writeXliff({
    srcLang: 'en',
    trgLang: 'de',
    meta: { job: 'job-1', commit: 'a'.repeat(40) },
    modules: [{ moduleId: m.id, title: m.meta.title, units: xliffUnitsOf(m) }],
  });

/** The document with each `<source>` copied as its `<target>`, changed by `edit`. */
const translated = (xml: string, edit: (source: string) => string = (s) => s) =>
  xml.replace(
    /<source>(.*?)<\/source>/gs,
    (_, source: string) =>
      `<source>${source}</source><target>${edit(source)}</target>`,
  );

const unitOf = (xml: string, blockId: string): ReadUnit => {
  const read = readXliff(xml);
  const unit = read.files[0]?.units.find((u) => u.blockId === blockId);
  if (!unit) throw new Error(`no unit ${blockId}`);
  return unit;
};
const sent = (m: Module, blockId: string): XliffUnit =>
  xliffUnitsOf(m, new Set([blockId]))[0] as XliffUnit;

const reasonOf = (m: Module, xml: string, blockId: string) => {
  const result = targetParts(sent(m, blockId), unitOf(xml, blockId));
  return result.ok ? 'ok' : result.reason;
};

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof XliffReadError) return error.reason;
    throw error;
  }
  return 'read';
};

describe('readXliff', () => {
  it('reads back what writeXliff wrote: languages, meta, files and units', () => {
    const read = readXliff(xliffOf(rich));
    expect(read).toMatchObject({
      srcLang: 'en',
      trgLang: 'de',
      meta: { job: 'job-1', commit: 'a'.repeat(40) },
    });
    expect(read.files.map((f) => f.moduleId)).toEqual(['charging']);
    const units = read.files[0]?.units ?? [];
    expect(units.map((u) => u.blockId)).toEqual(['intro', 'first', 'photo']);
    const hashes = xliffUnitsOf(rich).map((u) => u.sourceHash);
    expect(units.map((u) => u.sourceHash)).toEqual(hashes);
    expect(units[2]?.segments.map((s) => s.id)).toEqual(['alt', 'title']);
    expect(units[2]?.segments[0]?.target).toBeUndefined();
  });

  it('reads units in groups, and skips notes and other namespaces', () => {
    const xml = xliffOf(module([para('p', [text('x')])]))
      .replace('<unit ', '<group id="g"><tool:x xmlns:tool="urn:tool"/><unit ')
      .replace('</unit>', '</unit></group>');
    expect(readXliff(xml).files[0]?.units.map((u) => u.blockId)).toEqual(['p']);
  });

  it('round-trips every inline kind: the target read back is the source sent', () => {
    const xml = translated(xliffOf(rich));
    const units = translatableUnits(normalizeModule(rich));
    for (const unit of units) {
      const result = targetParts(
        sent(rich, unit.blockId),
        unitOf(xml, unit.blockId),
      );
      expect(result).toEqual({ ok: true, parts: unit.parts });
    }
  });

  it('takes a translated callout legend with its marks and callout reference (#548)', () => {
    const pictured = module([
      {
        type: 'image',
        id: 'photo',
        asset: `sha256:${'0'.repeat(64)}`,
        alt: 'Photo',
        callouts: [
          {
            id: 'lid',
            anchor: { x: 0.5, y: 0.5 },
            legend: [
              text('The '),
              text('lid', [{ type: 'strong' }]),
              text(' over '),
              { type: 'calloutRef', block: 'photo', callout: 'seal' },
            ],
          },
          { id: 'seal', anchor: { x: 0.1, y: 0.9 }, legend: [text('Seal')] },
        ],
      },
    ]);
    const doc = translated(xliffOf(pictured), (source) =>
      source
        .replace('The ', 'Der ')
        .replace('>lid<', '>Deckel<')
        .replace(' over ', ' über ')
        .replace('Seal', 'Dichtung'),
    );
    const result = targetParts(sent(pictured, 'lid'), unitOf(doc, 'lid'));
    expect(result).toEqual({
      ok: true,
      parts: [
        {
          field: 'legend',
          content: [
            text('Der '),
            text('Deckel', [{ type: 'strong' }]),
            text(' über '),
            { type: 'calloutRef', block: 'photo', callout: 'seal' },
          ],
        },
      ],
    });
    expect(reasonOf(pictured, doc, 'seal')).toBe('ok');
  });

  it('takes a right-to-left translation, codes and bidi marks included (#458)', () => {
    const m = module([
      para('p', [
        text('If the display shows '),
        text('E-104', [{ type: 'code' }]),
        text(', restart the '),
        { type: 'attribute', name: 'product-name' },
        text(' at 230 V.'),
      ]),
    ]);
    const xml = writeXliff({
      srcLang: 'en',
      trgLang: 'ar',
      srcDir: 'ltr',
      trgDir: 'rtl',
      modules: [{ moduleId: m.id, title: 'Charging', units: xliffUnitsOf(m) }],
    });
    expect(xml).toContain('srcDir="ltr" trgDir="rtl"');
    // The Arabic words, an RLM after the number, the codes kept and moved.
    const target = translated(xml, (source) => {
      const codes = [
        ...source.matchAll(/<(pc|ph)\b[^>]*?(?:\/>|>.*?<\/pc>)/gs),
      ];
      expect(codes).toHaveLength(2);
      return `إذا ظهر الرمز ${codes[0]?.[0]} على الشاشة، فأعد تشغيل ${codes[1]?.[0]} عند 230‏ V.`;
    });
    expect(readXliff(target).trgLang).toBe('ar');
    const result = targetParts(sent(m, 'p'), unitOf(target, 'p'));
    expect(result.ok).toBe(true);
    const content = result.ok
      ? (result.parts[0] as unknown as { content: Inline[] }).content
      : [];
    expect(content).toEqual([
      text('إذا ظهر الرمز '),
      text('E-104', [{ type: 'code' }]),
      text(' على الشاشة، فأعد تشغيل '),
      { type: 'attribute', name: 'product-name' },
      text(' عند 230‏ V.'),
    ]);
  });

  it('takes a translation with its codes moved among their siblings', () => {
    const m = module([
      para('p', [
        text('Press '),
        { type: 'kbd', keys: ['Ctrl', 'S'] },
        text(' to save '),
        text('now', [{ type: 'strong' }]),
      ]),
    ]);
    const xml = translated(
      xliffOf(m),
      () =>
        '<pc id="2" type="fmt" subType="xlf:b">Jetzt</pc> mit <ph id="1"/> speichern',
    );
    const result = targetParts(sent(m, 'p'), unitOf(xml, 'p'));
    expect(result).toEqual({
      ok: true,
      parts: [
        {
          field: 'content',
          content: [
            text('Jetzt', [{ type: 'strong' }]),
            text(' mit '),
            { type: 'kbd', keys: ['Ctrl', 'S'] },
            text(' speichern'),
          ],
        },
      ],
    });
  });

  it('gives a code the meaning it had in the source, whatever the target says of it', () => {
    const m = module([
      para('p', [
        text('site', [{ type: 'link', href: 'https://example.org/' }]),
      ]),
    ]);
    const xml = translated(
      xliffOf(m),
      () =>
        '<pc id="1" subType="ccms:link" ccms:href="javascript:alert(1)">Seite</pc>',
    );
    const result = targetParts(sent(m, 'p'), unitOf(xml, 'p'));
    expect(result).toEqual({
      ok: true,
      parts: [
        {
          field: 'content',
          content: [
            text('Seite', [{ type: 'link', href: 'https://example.org/' }]),
          ],
        },
      ],
    });
  });

  it('keeps a term link’s term, whatever the target says of it (#245)', () => {
    const m = module([
      para('p', [
        text('Use the '),
        text('charger', [{ type: 'term', termId: 'charger' }]),
        text('.'),
      ]),
    ]);
    const xml = xliffOf(m);
    expect(xml).toContain(
      '<pc id="1" type="link" subType="ccms:term" ccms:term-id="charger">charger</pc>',
    );
    const target = translated(
      xml,
      () =>
        'Das <pc id="1" subType="ccms:term" ccms:term-id="other">Ladegerät</pc> benutzen.',
    );
    expect(targetParts(sent(m, 'p'), unitOf(target, 'p'))).toEqual({
      ok: true,
      parts: [
        {
          field: 'content',
          content: [
            text('Das '),
            text('Ladegerät', [{ type: 'term', termId: 'charger' }]),
            text(' benutzen.'),
          ],
        },
      ],
    });
  });

  describe('refuses a unit whose markup does not match its source, naming why', () => {
    const m = module([
      para('p', [
        text('a', [{ type: 'strong' }]),
        text(' '),
        text('b', [{ type: 'emphasis' }]),
        { type: 'hardBreak' },
      ]),
    ]);
    const xml = xliffOf(m);
    // The source: <pc 1>a</pc> <pc 2>b</pc><ph 3/>
    it.each([
      ['a code left out', '<pc id="1">a</pc> b<ph id="3"/>', 'missing-code'],
      [
        'a code given twice',
        '<pc id="1">a</pc><pc id="1">x</pc> <pc id="2">b</pc><ph id="3"/>',
        'extra-code',
      ],
      [
        'an unknown ID',
        '<pc id="1">a</pc> <pc id="2">b</pc><ph id="3"/><ph id="9"/>',
        'unknown-code',
      ],
      [
        'a code with no ID',
        '<pc id="1">a</pc> <pc>b</pc><ph id="3"/>',
        'unknown-code',
      ],
      [
        'a <pc> as a <ph>',
        '<ph id="1"/>a <pc id="2">b</pc><ph id="3"/>',
        'code-mismatch',
      ],
      [
        'codes reordered across nesting',
        '<pc id="1">a <pc id="2">b</pc></pc><ph id="3"/>',
        'nesting',
      ],
      [
        'an element that is no inline code',
        '<pc id="1">a</pc> <mrk id="m1">b</mrk><pc id="2">b</pc><ph id="3"/>',
        'unsupported-markup',
      ],
      [
        'a line break typed in',
        '<pc id="1">a</pc>\n<pc id="2">b</pc><ph id="3"/>',
        'line-break',
      ],
      [
        'a <ph> with content',
        '<pc id="1">a</pc> <pc id="2">b</pc><ph id="3">x</ph>',
        'unsupported-markup',
      ],
    ])('%s', (_, target, reason) => {
      expect(
        reasonOf(
          m,
          translated(xml, () => target),
          'p',
        ),
      ).toBe(reason);
    });

    it('a segment without a target, or an empty one', () => {
      expect(reasonOf(m, xml, 'p')).toBe('missing-target');
      expect(
        reasonOf(
          m,
          translated(xml, () => ''),
          'p',
        ),
      ).toBe('empty');
    });

    it('a code moved into another segment, and a segment that was not sent', () => {
      const image = module([
        {
          type: 'image',
          id: 'img',
          asset: `sha256:${'0'.repeat(64)}`,
          alt: 'Alt',
          title: [text('T', [{ type: 'strong' }])],
        },
      ]);
      const doc = translated(xliffOf(image));
      // The title's code in the alt text's target.
      const moved = doc.replace(
        '<target>Alt</target>',
        '<target><pc id="1">Alt</pc></target>',
      );
      expect(reasonOf(image, moved, 'img')).toBe('code-mismatch');
      const extra = doc.replace(
        '</unit>',
        '<segment id="name"><source>x</source><target>y</target></segment></unit>',
      );
      expect(reasonOf(image, extra, 'img')).toBe('extra-segment');
      const missing = doc.replace(/<segment id="title">.*?<\/segment>/s, '');
      expect(reasonOf(image, missing, 'img')).toBe('missing-segment');
    });

    it('a line break in a title', () => {
      const titled = module([
        {
          type: 'section',
          id: 's',
          title: [text('Title')],
          blocks: [],
        },
      ]);
      const doc = translated(xliffOf(titled), () => 'Ti<cp hex="000A"/>tle');
      expect(reasonOf(titled, doc, 's')).toBe('line-break');
    });

    it('a line break in a callout legend (#548)', () => {
      const pictured = module([
        {
          type: 'image',
          id: 'photo',
          asset: `sha256:${'0'.repeat(64)}`,
          alt: 'Photo',
          callouts: [
            { id: 'c1', anchor: { x: 0.5, y: 0.5 }, legend: [text('Lid')] },
          ],
        },
      ]);
      const doc = translated(xliffOf(pictured), (source) =>
        source === 'Lid' ? 'De<cp hex="000A"/>ckel' : source,
      );
      expect(reasonOf(pictured, doc, 'c1')).toBe('line-break');
    });

    it('a line break in an FAQ entry’s question', () => {
      const asked = module([
        {
          type: 'faq',
          id: 'q',
          question: [text('Why?')],
          blocks: [para('q-a', [text('Because.')])],
        },
      ]);
      const doc = translated(xliffOf(asked), (source) =>
        source === 'Why?' ? 'Wa<cp hex="000A"/>rum?' : source,
      );
      expect(reasonOf(asked, doc, 'q')).toBe('line-break');
    });
  });

  describe('refuses hostile and malformed documents whole', () => {
    const header = '<?xml version="1.0" encoding="UTF-8"?>';
    const body =
      '<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="en" trgLang="de"><file id="m"><unit id="u"><segment><source>&e;</source></segment></unit></file></xliff>';

    it('an external entity: the DTD is never read, nothing is fetched', () => {
      const xml = `${header}<!DOCTYPE xliff [<!ENTITY e SYSTEM "file:///etc/passwd">]>${body}`;
      expect(refusal(() => readXliff(xml))).toBe('dtd-forbidden');
    });

    it('a billion laughs: no entity is ever expanded', () => {
      const lol = [
        '<!ENTITY a "lol">',
        ...Array.from(
          { length: 9 },
          (_, i) =>
            `<!ENTITY ${String.fromCharCode(98 + i)} "${`&${String.fromCharCode(97 + i)};`.repeat(10)}">`,
        ),
      ].join('');
      const xml = `${header}<!DOCTYPE xliff [${lol}]>${body.replace('&e;', '&j;')}`;
      expect(refusal(() => readXliff(xml))).toBe('dtd-forbidden');
    });

    it('a reference to an entity no DTD declares, and a DOCTYPE in any case', () => {
      expect(refusal(() => readXliff(body))).toBe('dtd-forbidden');
      expect(refusal(() => readXliff(`<!doctype xliff>${body}`))).toBe(
        'dtd-forbidden',
      );
    });

    it('past the limits: length, depth, nodes, attributes', () => {
      const ok = body.replace('&e;', 'x');
      const limits = {
        maxLength: 10_000,
        maxDepth: 64,
        maxNodes: 10_000,
        maxAttributes: 64,
      };
      expect(refusal(() => readXliff(ok, { ...limits, maxLength: 100 }))).toBe(
        'too-large',
      );
      expect(refusal(() => readXliff(ok, { ...limits, maxDepth: 4 }))).toBe(
        'too-deep',
      );
      expect(refusal(() => readXliff(ok, { ...limits, maxNodes: 5 }))).toBe(
        'too-many-nodes',
      );
      expect(
        refusal(() => readXliff(ok, { ...limits, maxAttributes: 3 })),
      ).toBe('too-many-attributes');
      // Nesting far deeper than the stack would take, refused as it is read.
      const deep = `<a>${'<b>'.repeat(100_000)}`;
      expect(refusal(() => readXliff(deep))).toBe('too-deep');
    });

    it('another encoding, malformed XML, no XLIFF, an incomplete one', () => {
      const ok = body.replace('&e;', 'x');
      expect(
        refusal(() =>
          readXliff(`<?xml version="1.0" encoding="UTF-16"?>${ok}`),
        ),
      ).toBe('unsupported-encoding');
      for (const broken of [
        ok.replace('</file>', ''),
        ok.replace('id="m"', 'id="m" id="n"'),
        ok.replace('<file', '<x:file'),
        ok.replace('x</source>', 'a & b</source>'),
        `${ok}<second/>`,
        ok.replace('x</source>', '\u0001</source>'),
      ]) {
        expect(refusal(() => readXliff(broken))).toBe('not-well-formed');
      }
      expect(refusal(() => readXliff('<html/>'))).toBe('not-xliff');
      expect(
        refusal(() => readXliff(ok.replace('version="2.0"', 'version="1.2"'))),
      ).toBe('not-xliff');
      expect(refusal(() => readXliff(ok.replace(' trgLang="de"', '')))).toBe(
        'invalid-xliff',
      );
      expect(
        refusal(() =>
          readXliff(ok.replace('</file>', '<unit id="u"/></file>')),
        ),
      ).toBe('invalid-xliff');
    });
  });

  describe('review round 1', () => {
    const xmlRefusal = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        if (error instanceof XmlReadError) return error.reason;
        throw error;
      }
      return 'read';
    };

    it('reads units in groups in document order', () => {
      const xml = xliffOf(
        module([
          para('a', [text('x')]),
          para('b', [text('y')]),
          para('c', [text('z')]),
        ]),
      )
        .replace('<unit id="a"', '<group id="g"><group id="h"><unit id="a"')
        .replace(/(<unit id="a"[\s\S]*?<\/unit>)/, '$1</group></group>');
      expect(readXliff(xml).files[0]?.units.map((u) => u.blockId)).toEqual([
        'a',
        'b',
        'c',
      ]);
    });

    it('takes no entity named after a member of Object.prototype', () => {
      for (const name of ['constructor', '__proto__', 'toString', 'valueOf']) {
        expect(xmlRefusal(() => readXml(`<a>&${name};</a>`))).toBe(
          'dtd-forbidden',
        );
      }
      expect(readXml('<a>&amp;&lt;</a>').children).toEqual(['&<']);
    });

    it('bounds the namespace prefixes in scope, and shares them with elements declaring none', () => {
      const many = (n: number, from = 0) =>
        Array.from(
          { length: n },
          (_, i) => ` xmlns:p${from + i}="urn:x:${from + i}"`,
        ).join('');
      expect(
        xmlRefusal(() =>
          readXml(`<a${many(MAX_PREFIXES)}><b${many(1, MAX_PREFIXES)}/></a>`),
        ),
      ).toBe('too-many-attributes');
      const doc = readXml(
        `<a${many(MAX_PREFIXES)}>${'<b/>'.repeat(10_000)}</a>`,
      );
      expect(doc.children).toHaveLength(10_000);
    });

    it('refuses too many files, and a file without units', () => {
      const one = xliffOf(module([para('p', [text('x')])]));
      const file = /<file[\s\S]*<\/file>/.exec(one)?.[0] as string;
      const files = Array.from({ length: MAX_READ_FILES + 1 }, (_, i) =>
        file.replace(/<file id="[^"]+"/, `<file id="m${i}"`),
      ).join('');
      expect(refusal(() => readXliff(one.replace(file, files)))).toBe(
        'invalid-xliff',
      );
      expect(
        refusal(() => readXliff(one.replace(file, '<file id="empty"/>'))),
      ).toBe('invalid-xliff');
    });

    it('refuses a target of white space only, and a <cp> of NUL or a lone surrogate', () => {
      const m = module([para('p', [text('Words')])]);
      expect(
        reasonOf(
          m,
          translated(xliffOf(m), () => '   '),
          'p',
        ),
      ).toBe('empty');
      for (const hex of ['0', 'D800', 'DFFF']) {
        expect(
          reasonOf(
            m,
            translated(xliffOf(m), () => `a<cp hex="${hex}"/>`),
            'p',
          ),
        ).toBe('unsupported-markup');
      }
      expect(
        reasonOf(
          m,
          translated(xliffOf(m), () => 'a<cp hex="7"/>'),
          'p',
        ),
      ).toBe('ok');
    });

    it('reads a large flat or nested target in linear time', () => {
      const m = module([para('p', [text('Words')])]);
      const flat = translated(xliffOf(m), () =>
        '<cp hex="41"/>'.repeat(100_000),
      );
      const started = performance.now();
      expect(reasonOf(m, flat, 'p')).toBe('ok');
      // Generous: a quadratic read of 100,000 codes takes minutes.
      expect(performance.now() - started).toBeLessThan(30_000);
    });
  });
});
