import { csvCell, escapeXml, termsToCsv, termsToTbx } from './term-export.js';
import { parseTerm, type Term } from './term.js';

const charger = parseTerm(
  [
    'schemaVersion: 1',
    'status: approved',
    'domain: charging',
    'languages:',
    '  de:',
    '    preferred: Ladegerät',
    '  en:',
    '    preferred: charger',
    '    allowed:',
    '      - term: charging unit',
    '    forbidden:',
    '      - term: loader',
    '        note: means a <machine> & more',
    '    definition: The **device** that charges the battery.',
    '    usage: Write it in full.',
    '',
  ].join('\n'),
  { id: 'charger' },
);

const old = parseTerm(
  [
    'schemaVersion: 1',
    'status: deprecated',
    'replacedBy: charger',
    'languages:',
    '  en:',
    '    preferred: power pack',
    '',
  ].join('\n'),
  { id: '2-pin' },
);

const terms: Term[] = [old, charger];

/** The TBX `termsToTbx` writes for `terms`: also the fixture checked against the TBX-Basic schemas. */
const SAMPLE_TBX = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<tbx type="TBX-Basic" style="dca" xml:lang="en" xmlns="urn:iso:std:iso:30042:ed-2">',
  '  <tbxHeader>',
  '    <fileDesc>',
  '      <sourceDesc>',
  '        <p>Terminology exported from the content repository.</p>',
  '      </sourceDesc>',
  '    </fileDesc>',
  '  </tbxHeader>',
  '  <text>',
  '    <body>',
  '      <conceptEntry id="term-2-pin">',
  '        <ref type="crossReference" target="term-charger">charger</ref>',
  '        <langSec xml:lang="en">',
  '          <termSec>',
  '            <term>power pack</term>',
  '            <termNote type="administrativeStatus">supersededTerm-admn-sts</termNote>',
  '          </termSec>',
  '        </langSec>',
  '      </conceptEntry>',
  '      <conceptEntry id="term-charger">',
  '        <descrip type="subjectField">charging</descrip>',
  '        <langSec xml:lang="de">',
  '          <termSec>',
  '            <term>Ladegerät</term>',
  '            <termNote type="administrativeStatus">preferredTerm-admn-sts</termNote>',
  '          </termSec>',
  '        </langSec>',
  '        <langSec xml:lang="en">',
  '          <descrip type="definition">The device that charges the battery.</descrip>',
  '          <note>Write it in full.</note>',
  '          <termSec>',
  '            <term>charger</term>',
  '            <termNote type="administrativeStatus">preferredTerm-admn-sts</termNote>',
  '          </termSec>',
  '          <termSec>',
  '            <term>charging unit</term>',
  '            <termNote type="administrativeStatus">admittedTerm-admn-sts</termNote>',
  '          </termSec>',
  '          <termSec>',
  '            <term>loader</term>',
  '            <termNote type="administrativeStatus">deprecatedTerm-admn-sts</termNote>',
  '            <note>means a &lt;machine&gt; &amp; more</note>',
  '          </termSec>',
  '        </langSec>',
  '      </conceptEntry>',
  '    </body>',
  '  </text>',
  '</tbx>',
  '',
].join('\n');

describe('term export', () => {
  it('writes TBX-Basic', () => {
    expect(termsToTbx(terms, { sourceLang: 'en' })).toBe(SAMPLE_TBX);
  });

  it('writes only the languages asked for, and cross-references only what it writes', () => {
    const tbx = termsToTbx(terms, { sourceLang: 'en', langs: ['de'] });
    expect(tbx).toContain('<conceptEntry id="term-charger">');
    expect(tbx).not.toContain('term-2-pin');
    expect(tbx).not.toContain('xml:lang="en">');
    expect(termsToTbx([old], { sourceLang: 'en' })).not.toContain(
      'crossReference',
    );
  });

  // The rules of the TBX-Basic schematron (DCA style) that bear on what the export writes.
  it('uses only the data categories, values and levels TBX-Basic permits', () => {
    const tbx = termsToTbx(terms, { sourceLang: 'en' });
    const types = [...tbx.matchAll(/<(\w+) type="([^"]+)"/g)].map(
      ([, element, type]) => `${element}:${type}`,
    );
    const permitted = new Set([
      'descrip:subjectField',
      'descrip:definition',
      'termNote:administrativeStatus',
      'ref:crossReference',
      'tbx:TBX-Basic',
    ]);
    expect(types.filter((t) => !permitted.has(t))).toEqual([]);
    const statuses = [
      ...tbx.matchAll(
        /<termNote type="administrativeStatus">([^<]+)<\/termNote>/g,
      ),
    ].map(([, status]) => status as string);
    expect(
      statuses.filter(
        (s) =>
          ![
            'preferredTerm-admn-sts',
            'admittedTerm-admn-sts',
            'deprecatedTerm-admn-sts',
            'supersededTerm-admn-sts',
          ].includes(s),
      ),
    ).toEqual([]);
    // subjectField and crossReference on the concept, definition on the language, termNote in a termSec.
    expect(tbx).toMatch(/ {8}<descrip type="subjectField">/);
    expect(tbx).toMatch(/ {8}<ref type="crossReference"/);
    expect(tbx).toMatch(/ {10}<descrip type="definition">/);
    expect(tbx).not.toMatch(/^ {0,11}<termNote/m);
    // Every cross-reference names an ID of the file.
    const ids = new Set(
      [...tbx.matchAll(/ id="([^"]+)"/g)].map(([, id]) => id),
    );
    for (const [, target] of tbx.matchAll(/ target="([^"]+)"/g)) {
      expect(ids.has(target)).toBe(true);
    }
  });

  it('escapes what XML cannot hold as text', () => {
    expect(escapeXml(`<a href="x">&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;',
    );
    expect(escapeXml('a\u0001b￾c\uD800d\te\nf')).toBe('a�b�c�d\te\nf');
  });

  it('writes CSV, one row per term and language', () => {
    expect(termsToCsv(terms, {})).toBe(
      [
        'id,lang,status,domain,replacedBy,preferred,allowed,forbidden,definition,usage',
        '2-pin,en,deprecated,,charger,power pack,,,,',
        'charger,de,approved,charging,,Ladegerät,,,,',
        'charger,en,approved,charging,,charger,charging unit,loader,The device that charges the battery.,Write it in full.',
        '',
      ].join('\r\n'),
    );
    expect(termsToCsv(terms, { langs: ['de'] })).toBe(
      'id,lang,status,domain,replacedBy,preferred,allowed,forbidden,definition,usage\r\ncharger,de,approved,charging,,Ladegerät,,,,\r\n',
    );
  });

  it('quotes CSV cells and keeps spreadsheets from running formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('one\ntwo')).toBe('"one\ntwo"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    for (const start of ['+', '-', '@', '\t', '\r']) {
      expect(csvCell(`${start}1`).replace(/^"/, '')).toMatch(/^'/);
    }
    expect(csvCell('plain')).toBe('plain');
  });

  describe('csvCell formula guard', () => {
    it.each(['=', '+', '-', '@'])('escapes a cell starting with %s', (sign) => {
      expect(csvCell(`${sign}1+1`)).toBe(`'${sign}1+1`);
    });

    it.each(['\uFF1D', '\uFF0B', '\uFF0D', '\uFF20'])(
      'escapes a cell starting with the full-width %s',
      (sign) => {
        expect(csvCell(`${sign}SUM(A1)`)).toBe(`'${sign}SUM(A1)`);
      },
    );

    it.each([
      ['a space', ' =1'],
      ['several spaces', '   +1'],
      ['a no-break space', '\u00A0@SUM(A1)'],
      ['a byte order mark', '\uFEFF=1'],
      ['a line feed', '\n=1'],
      ['a space and a full-width sign', ' \uFF1D1'],
      ['a zero-width space', '\u200B=1'],
      ['a word joiner', '\u2060+1'],
    ])('escapes a formula sign after %s', (_name, value) => {
      // A line feed also makes the cell quoted.
      expect(csvCell(value)).toBe(
        value.includes('\n') ? `"'${value}"` : `'${value}`,
      );
    });

    it('escapes a cell starting with a tab or a carriage return', () => {
      // Both also make the cell quoted.
      expect(csvCell('\tplain')).toBe(`"'\tplain"`);
      expect(csvCell('\rplain')).toBe(`"'\rplain"`);
    });

    it.each(['\uFE66', '\uFE62', '\uFE63', '\uFE6B'])(
      'escapes a cell starting with the small form %s',
      (sign) => {
        expect(csvCell(`${sign}1`)).toBe(`'${sign}1`);
      },
    );

    it('quotes a cell holding a semicolon or a tab, so it stays one cell', () => {
      expect(csvCell('a;b')).toBe('"a;b"');
      expect(csvCell('foo;=HYPERLINK("x")')).toBe('"foo;=HYPERLINK(""x"")"');
      expect(csvCell('a\tb')).toBe('"a\tb"');
    });

    it('escapes a negative number, so it reads as text', () => {
      expect(csvCell('-5')).toBe("'-5");
    });

    it('leaves a sign later in the cell, and plain whitespace, alone', () => {
      expect(csvCell('a=b')).toBe('a=b');
      expect(csvCell('1+1')).toBe('1+1');
      expect(csvCell(' plain')).toBe(' plain');
      expect(csvCell('')).toBe('');
      expect(csvCell('user@example.org')).toBe('user@example.org');
    });

    it('quotes an escaped cell that also needs quoting', () => {
      expect(csvCell(' =1,2')).toBe(`"' =1,2"`);
      expect(csvCell('\r=1')).toBe(`"'\r=1"`);
    });
  });
});
