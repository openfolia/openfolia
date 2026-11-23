import type { ImportDocument } from '@openfolia/content-model';
import { describe, expect, it } from 'vitest';
import { fixtureConfig } from '../testing/fixture.js';
import { convertDita } from './convert.js';
import { MAX_KEYED_TEXT_CHARS } from './keys.js';

/**
 * Hostile projects whose cost grows from what an attribute or a key says,
 * not from the size of the file: each would hang, exhaust the stack or the
 * memory without its bound (#432, the security review).
 */
const config = fixtureConfig();
const encode = (text: string) => new TextEncoder().encode(text);

const project = (body: string, keydefs = '') =>
  new Map([
    [
      'map.ditamap',
      encode(`<map><title>M</title>${keydefs}<topicref href="t.dita"/></map>`),
    ],
    [
      't.dita',
      encode(`<topic id="t"><title>T</title><body>${body}</body></topic>`),
    ],
  ]);

const keydef = (key: string, text: string) =>
  `<keydef keys="${key}"><topicmeta><keywords><keyword>${text}</keyword></keywords></topicmeta></keydef>`;

const codes = (document: ImportDocument) =>
  new Set(document.report.map((r) => /^\[([a-z-]+)\]/.exec(r.message)?.[1]));

/**
 * The conversion and the CPU time it took, in milliseconds (#734): the work done, which a
 * loaded machine does not stretch the way it stretches the wall-clock time.
 */
const timed = async (files: Map<string, Uint8Array>) => {
  const started = process.cpuUsage();
  const conversion = await convertDita(files, config);
  const { user, system } = process.cpuUsage(started);
  return { ...conversion, ms: (user + system) / 1000 };
};

describe('convertDita bounds what attributes and keys multiply', () => {
  it('cuts a key whose text names itself, or a cycle of keys', async () => {
    const { document } = await timed(
      project(
        '<p>A <ph keyref="self"/> and <ph keyref="ping"/>.</p><p><xref keyref="self"/></p>',
        keydef('self', 'me <ph keyref="self"/>') +
          keydef('ping', 'ping <ph keyref="pong"/>') +
          keydef('pong', 'pong <ph keyref="ping"/>'),
      ),
    );
    expect(codes(document)).toContain('key-cycle');
    expect(JSON.stringify(document.modules[0]?.blocks[0])).toContain(
      'ping pong',
    );
  });

  it('stops a fan-out of keys at the expansion bound', async () => {
    // Each key's text names the next ten times: 10^12 phrases if put in.
    const keys = Array.from({ length: 12 }, (_, i) =>
      keydef(`k${i}`, i === 11 ? 'x' : `<ph keyref="k${i + 1}"/>`.repeat(10)),
    ).join('');
    const { document, ms } = await timed(
      project('<p><ph keyref="k0"/></p>', keys),
    );
    expect(ms).toBeLessThan(10_000);
    expect(document.modules).toEqual([]);
    expect(codes(document)).toContain('expansion-limit');
  });

  it('caps a simple table’s columns and cells, however many rows it has', async () => {
    // More rows than a call takes arguments, and one row 2,000 cells wide.
    const rows = '<strow><stentry>x</stentry></strow>'.repeat(150_000);
    const wide = `<strow>${'<stentry>w</stentry>'.repeat(2_000)}</strow>`;
    const { document, ms } = await timed(
      project(`<simpletable id="s">${wide}${rows}</simpletable>`),
    );
    expect(ms).toBeLessThan(20_000);
    const table = document.modules[0]?.blocks[0] as {
      columns: unknown[];
      rows: { cells: unknown[] }[];
    };
    expect(table.columns).toHaveLength(1_000);
    expect(table.rows.length * table.columns.length).toBeLessThanOrEqual(
      50_000,
    );
    expect(codes(document)).toContain('table-layout');
  });

  it('caps a CALS table padded to the columns @cols declares', async () => {
    const rows = '<row><entry>x</entry></row>'.repeat(60_000);
    const { document, ms } = await timed(
      project(
        `<table id="c"><tgroup cols="1000"><tbody>${rows}</tbody></tgroup></table>`,
      ),
    );
    expect(ms).toBeLessThan(20_000);
    const table = document.modules[0]?.blocks[0] as {
      rows: { cells: unknown[] }[];
    };
    expect(table.rows).toHaveLength(50);
    expect(table.rows[0]?.cells).toHaveLength(1_000);
    expect(codes(document)).toContain('table-layout');
  });

  it('takes an element with more children than a call takes arguments', async () => {
    const { document, ms } = await timed(
      project(`<div>${'<p>x</p>'.repeat(130_000)}</div>`),
    );
    expect(ms).toBeLessThan(30_000);
    expect(document.modules[0]?.blocks).toHaveLength(130_000);
  });

  it('resolves many cross-references into many modules in linear time', async () => {
    // 10,000 topics in one <dita> file, and 40,000 links to their paragraphs.
    const topics = Array.from(
      { length: 10_000 },
      (_, i) =>
        `<topic id="t${i}"><title>T</title><body><p id="p">x</p></body></topic>`,
    ).join('');
    const links = Array.from(
      { length: 40_000 },
      (_, i) => `<xref href="#t${i % 10_000}/p">l</xref>`,
    ).join(' ');
    const files = new Map([
      [
        'map.ditamap',
        encode('<map><title>M</title><topicref href="t.dita"/></map>'),
      ],
      [
        't.dita',
        encode(
          `<dita><topic id="links"><title>L</title><body><p>${links}</p></body></topic>${topics}</dita>`,
        ),
      ],
    ]);
    const { document, ms } = await timed(files);
    expect(ms).toBeLessThan(8_000);
    expect(document.modules).toHaveLength(10_001);
    expect(JSON.stringify(document.modules[0])).toContain('"block":"p"');
  });

  it('charges text by its length: a large key text put in many times stops at the bound', async () => {
    const big = 'x'.repeat(1_000_000);
    const { document, ms } = await timed(
      project(
        `<p>${'<ph keyref="k"/><b><ph keyref="k"/></b>'.repeat(100)}</p>`,
        keydef('k', big),
      ),
    );
    expect(ms).toBeLessThan(10_000);
    expect(document.modules).toEqual([]);
    expect(codes(document)).toContain('expansion-limit');
  });

  it('charges text by its length: a large paragraph referenced many times stops at the bound', async () => {
    const { document, ms } = await timed(
      project(
        `<p id="big">${'x'.repeat(1_000_000)}</p>${'<p conref="#t/big"/>'.repeat(50)}`,
      ),
    );
    expect(ms).toBeLessThan(10_000);
    expect(document.modules).toEqual([]);
    expect(codes(document)).toContain('expansion-limit');
  });
});

describe('convertDita on keyed targets', () => {
  it('takes a key’s target as the path it is, never decoding it twice', async () => {
    const files = new Map([
      [
        'map.ditamap',
        encode(
          '<map><title>M</title><keydef keys="odd" href="100%25.dita"/><topicref keyref="odd"/></map>',
        ),
      ],
      [
        '100%.dita',
        encode('<topic id="o"><title>O</title><body><p>x</p></body></topic>'),
      ],
    ]);
    const { document } = await timed(files);
    expect(document.manuals[0]?.entries).toHaveLength(1);
    expect(codes(document).has('map-entry')).toBe(false);
  });
});

describe('convertDita on titles with keys', () => {
  it('cuts a title a large key text is put into many times', async () => {
    const big = 'x'.repeat(1_000_000);
    const title = '<ph keyref="k"/>'.repeat(64);
    const topics = Array.from(
      { length: 20 },
      (_, i) =>
        `<topic id="t${i}"><title>${title}</title><body><p>x</p></body></topic>`,
    ).join('');
    const refs = Array.from(
      { length: 20 },
      (_, i) => `<topicref href="t.dita#t${i}"/>`,
    ).join('');
    const files = new Map([
      [
        'map.ditamap',
        encode(
          `<map><title>M</title>${keydef('k', big)}<topicref href="t.dita"/>${refs.repeat(50)}</map>`,
        ),
      ],
      ['t.dita', encode(`<dita>${topics}</dita>`)],
    ]);
    const { document, ms } = await timed(files);
    expect(ms).toBeLessThan(10_000);
    const lengths = [
      ...document.modules.map((m) => m.meta?.title?.length ?? 0),
      ...(document.manuals[0]?.entries ?? []).map((e) =>
        'title' in e && typeof e.title === 'string' ? e.title.length : 0,
      ),
    ];
    expect(Math.max(...lengths)).toBe(MAX_KEYED_TEXT_CHARS);
  });
});

describe('convertDita on what the second security review found', () => {
  it('stops a fan-out of submaps at the manual bound', async () => {
    // Six levels of ten submap references each: ten million entries unbounded.
    const files = new Map<string, Uint8Array>([
      [
        't.dita',
        encode('<topic id="t"><title>T</title><body><p>x</p></body></topic>'),
      ],
    ]);
    const refs = (href: string) => `<mapref href="${href}"/>`.repeat(10);
    files.set(
      'map.ditamap',
      encode(`<map><title>M</title>${refs('m0.ditamap')}</map>`),
    );
    for (let i = 0; i < 5; i++) {
      files.set(
        `m${i}.ditamap`,
        encode(`<map>${refs(`m${i + 1}.ditamap`)}</map>`),
      );
    }
    files.set(
      'm5.ditamap',
      encode(`<map>${'<topicref href="t.dita"/>'.repeat(10)}</map>`),
    );
    const { document, ms } = await timed(files);
    expect(ms).toBeLessThan(5_000);
    expect(document.manuals).toEqual([]);
    expect(codes(document)).toContain('expansion-limit');
  });

  it('puts many blocks after a section in linear time', async () => {
    const { document, ms } = await timed(
      project(
        `<section><title>S</title></section>${'<p>x</p>'.repeat(160_000)}`,
      ),
    );
    expect(ms).toBeLessThan(8_000);
    const section = document.modules[0]?.blocks[0];
    expect(section?.type === 'section' && section.blocks.length).toBe(160_000);
  });

  it('finds a range’s end among many siblings in linear time', async () => {
    const files = project(
      '<p conref="lib.dita#l/a" conrefend="lib.dita#l/a"/>'.repeat(4_000),
    );
    files.set(
      'lib.dita',
      encode(
        `<topic id="l"><title>L</title><body><p id="a">a</p>${'<p/>'.repeat(200_000)}</body></topic>`,
      ),
    );
    const { document, ms } = await timed(files);
    expect(ms).toBeLessThan(5_000);
    expect(document.modules.find((m) => m.id === 't')?.blocks).toHaveLength(
      4_000,
    );
  });

  it('charges a key’s external address at every link naming it', async () => {
    const href = `https://a.example/${'x'.repeat(1_000_000)}`;
    const { document } = await timed(
      project(
        '<p><xref keyref="k"/></p>'.repeat(100),
        `<keydef keys="k" href="${href}" scope="external"/>`,
      ),
    );
    expect(document.modules).toEqual([]);
    expect(codes(document)).toContain('expansion-limit');
  });

  it('charges a copied element’s attributes, not only its text', async () => {
    const href = `https://a.example/${'x'.repeat(1_000_000)}`;
    const { document } = await timed(
      project(
        `<p id="a"><xref href="${href}" scope="external"/></p>${'<p conref="#t/a"/>'.repeat(150)}`,
      ),
    );
    expect(document.modules).toEqual([]);
    expect(codes(document)).toContain('expansion-limit');
  });

  it('charges a topic title written out with every entry that groups', async () => {
    const files = project('<p>x</p>');
    files.set(
      't.dita',
      encode(
        `<topic id="t"><title>${'x'.repeat(1_000_000)}</title><body><p>x</p></body></topic>`,
      ),
    );
    files.set(
      'u.dita',
      encode('<topic id="u"><title>U</title><body><p>u</p></body></topic>'),
    );
    files.set(
      'map.ditamap',
      encode(
        `<map><title>M</title>${'<topicref href="t.dita"><topicref href="u.dita"/></topicref>'.repeat(400)}</map>`,
      ),
    );
    const { document } = await timed(files);
    expect(document.manuals).toEqual([]);
    expect(codes(document)).toContain('expansion-limit');
  });
});

describe('convertDita on a lattice of submaps', () => {
  it('walks a submap reached by many paths once, and bounds the walk', async () => {
    // Twenty-four levels of two references each to the next: 33 million paths, no topic.
    const files = new Map<string, Uint8Array>();
    files.set(
      'map.ditamap',
      encode(
        '<map><title>M</title><mapref href="m0.ditamap"/><mapref href="m0.ditamap"/></map>',
      ),
    );
    for (let i = 0; i < 24; i++) {
      const next = `<mapref href="m${i + 1}.ditamap"/>`;
      files.set(`m${i}.ditamap`, encode(`<map>${next}${next}</map>`));
    }
    files.set('m24.ditamap', encode('<map><topicgroup/></map>'));
    const { document, ms } = await timed(files);
    expect(ms).toBeLessThan(2_000);
    expect(document.manuals).toEqual([]);
  });

  it('charges a wide submap at every reuse as if walked again', async () => {
    // A submap of 200,000 empty groups, named ten times: two million elements, past the bound.
    const files = new Map<string, Uint8Array>([
      [
        't.dita',
        encode('<topic id="t"><title>T</title><body><p>x</p></body></topic>'),
      ],
      ['wide.ditamap', encode(`<map>${'<topicgroup/>'.repeat(200_000)}</map>`)],
    ]);
    files.set(
      'map.ditamap',
      encode(
        `<map><title>M</title><topicref href="t.dita"/>${Array.from({ length: 10 }, (_, i) => `<mapref href="wide.ditamap" product="p${i}"/>`).join('')}</map>`,
      ),
    );
    const { document, ms } = await timed(files);
    expect(ms).toBeLessThan(5_000);
    expect(document.manuals).toEqual([]);
    expect(codes(document)).toContain('expansion-limit');
  });

  it('charges a reused submap its titles’ characters, as copies of it would be', async () => {
    // One group titled with a million characters, the submap named twenty times: 20 Mi of titles.
    const files = new Map<string, Uint8Array>([
      [
        't.dita',
        encode('<topic id="t"><title>T</title><body><p>x</p></body></topic>'),
      ],
      [
        'sub.ditamap',
        encode(
          `<map><topichead navtitle="${'x'.repeat(1_000_000)}"><topicref href="t.dita"/></topichead></map>`,
        ),
      ],
    ]);
    files.set(
      'map.ditamap',
      encode(
        `<map><title>M</title>${'<mapref href="sub.ditamap"/>'.repeat(20)}</map>`,
      ),
    );
    const { document } = await timed(files);
    expect(document.manuals).toEqual([]);
    expect(codes(document)).toContain('expansion-limit');
  });
});

describe('convertDita on what the third security review found', () => {
  it('trims text ending in many no-break spaces in linear time', async () => {
    const nbsp = ' '.repeat(200_000);
    const { document, ms } = await timed(
      project(
        `<p>a${nbsp}a</p><codeblock>x${' \n'.repeat(100_000)}y</codeblock>`,
      ),
    );
    expect(ms).toBeLessThan(5_000);
    expect(document.modules).toHaveLength(1);
  });

  it('drops blank lines and leading breaks in linear time', async () => {
    const { document, ms } = await timed(
      project(
        `<lines>${'\n'.repeat(100_000)}a\n${' \n'.repeat(100_000)}b</lines>`,
      ),
    );
    expect(ms).toBeLessThan(5_000);
    expect(JSON.stringify(document.modules[0]?.blocks)).toContain('"text":"b"');
  });

  it('narrows column spans in one scan', async () => {
    // 1,000 columns, every other one held by a row span, each cell asking to span to the last.
    const specs = Array.from(
      { length: 1_000 },
      (_, i) => `<colspec colname="c${i + 1}"/>`,
    ).join('');
    const first = `<row>${Array.from({ length: 500 }, (_, k) => `<entry colname="c${2 * k + 2}" morerows="50"/>`).join('')}</row>`;
    const rest = `<row>${'<entry nameend="c1000"/>'.repeat(500)}</row>`.repeat(
      49,
    );
    const table = `<table><tgroup cols="1000">${specs}<tbody>${first}${rest}</tbody></tgroup></table>`;
    const { document, ms } = await timed(project(table.repeat(4)));
    expect(ms).toBeLessThan(1_500);
    expect(document.modules).toHaveLength(1);
  });

  it('follows a chain of submaps only so deep', async () => {
    const files = new Map<string, Uint8Array>([
      [
        't.dita',
        encode('<topic id="t"><title>T</title><body><p>x</p></body></topic>'),
      ],
      [
        'map.ditamap',
        encode(
          '<map><title>M</title><topicref href="t.dita"/><mapref href="m0.ditamap"/></map>',
        ),
      ],
    ]);
    for (let i = 0; i < 3_000; i++) {
      files.set(
        `m${i}.ditamap`,
        encode(`<map><mapref href="m${i + 1}.ditamap"/></map>`),
      );
    }
    const { document } = await timed(files);
    expect(document.manuals).toHaveLength(1);
    expect(
      document.report.some((r) => r.message.includes('Submaps nest more than')),
    ).toBe(true);
  });

  it('writes one condition for a group repeated many times', async () => {
    const files = project('<p>x</p>');
    files.set(
      'map.ditamap',
      encode(
        `<map><title>M</title><topicgroup product="${'product(basic) '.repeat(10_000)}"><topicref href="t.dita"/></topicgroup></map>`,
      ),
    );
    const { document } = await timed(files);
    expect(JSON.stringify(document.manuals[0]?.entries).length).toBeLessThan(
      500,
    );
  });
});

describe('convertDita on what the fourth security review found', () => {
  it('reads a column width padded with many spaces in linear time', async () => {
    const table = `<table><tgroup cols="1"><colspec colname="c1" colwidth="${' '.repeat(256_000)}x"/><tbody><row><entry>a</entry></row></tbody></tgroup></table>`;
    const { document, ms } = await timed(project(table));
    expect(ms).toBeLessThan(2_000);
    expect(document.modules).toHaveLength(1);
  });

  it('takes a relative width past any number as no proportion, never failing', async () => {
    const table = `<table><tgroup cols="2"><colspec colname="c1" colwidth="${'9'.repeat(400)}*"/><colspec colname="c2" colwidth="1*"/><tbody><row><entry>a</entry><entry>b</entry></row></tbody></tgroup></table><simpletable relcolwidth="${'9'.repeat(400)}* 1*"><strow><stentry>a</stentry><stentry>b</stentry></strow></simpletable>`;
    const { document } = await timed(project(table));
    expect(document.modules).toHaveLength(1);
  });
});

describe('convertDita bounds the export’s module references (#433, the second security review)', () => {
  it('charges a marked reference to a whole topic as the elements it covers', async () => {
    const paragraphs = Array.from(
      { length: 1_000 },
      (_, n) => `<p id="p${n}">${n}</p>`,
    ).join('');
    const marked = `<p conref="s.dita#s/p0" conrefend="s.dita#s/p999" outputclass="openfolia-module-reference"/>`;
    const files = new Map([
      [
        'map.ditamap',
        encode(
          '<map><title>M</title><topicref href="t.dita"/><topicref href="s.dita"/></map>',
        ),
      ],
      [
        't.dita',
        encode(
          `<topic id="t"><title>T</title><body>${marked.repeat(400)}</body></topic>`,
        ),
      ],
      [
        's.dita',
        encode(
          `<topic id="s"><title>S</title><body>${paragraphs}</body></topic>`,
        ),
      ],
    ]);
    const { document } = await timed(files);
    expect(codes(document)).toContain('expansion-limit');
  });
});

describe('convertDita bounds the export’s module references (#433, the third review)', () => {
  it('looks at a target topic’s children once, however many marked references name it', async () => {
    const children = '<data/>'.repeat(40_000);
    const marked = `<p conref="s.dita#s/p0" outputclass="openfolia-module-reference"/>`;
    const files = new Map([
      [
        'map.ditamap',
        encode(
          '<map><title>M</title><topicref href="t.dita"/><topicref href="s.dita"/></map>',
        ),
      ],
      [
        't.dita',
        encode(
          `<topic id="t"><title>T</title><body>${marked.repeat(40_000)}</body></topic>`,
        ),
      ],
      [
        's.dita',
        encode(
          `<topic id="s"><title>S</title>${children}<body><p id="p0">0</p></body></topic>`,
        ),
      ],
    ]);
    const { ms } = await timed(files);
    expect(ms).toBeLessThan(15_000);
  }, 120_000);
});
