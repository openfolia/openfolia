import { parseInline, printInline } from './inline.js';
import { formatCondition, parseCondition } from './condition-syntax.js';
import { parseModule } from './parse.js';
import { printModule } from './print.js';
import { AsciidocParseError } from './syntax.js';

const header =
  '= Title\n:schema-version: 1\n:module-type: concept\n:lang: en\n';
const parse = (body: string) =>
  parseModule(`${header}\n${body}\n`, { id: 'm' });
const errorOf = (body: string) => {
  try {
    parse(body);
  } catch (e) {
    if (e instanceof AsciidocParseError) return e.message;
    throw e;
  }
  throw new Error('expected a parse error');
};

describe('parseModule keywords', () => {
  const withKeywords = (line: string) =>
    parseModule(`${header}${line}\n\n[#p]\nText.\n`, { id: 'm' });

  it('reads :keywords: as a comma-separated list', () => {
    expect(
      withKeywords(':keywords: maintenance,  deep  discharge , Wartung').meta
        .keywords,
    ).toEqual(['maintenance', 'deep discharge', 'Wartung']);
  });

  it('reads an empty :keywords: as none', () => {
    expect(withKeywords(':keywords:').meta.keywords).toBeUndefined();
  });

  it('refuses an empty keyword between commas', () => {
    expect(() => withKeywords(':keywords: a,, b')).toThrow(
      /a keyword needs at least one character/,
    );
  });
});

describe('parseModule deprecation', () => {
  const withHeader = (lines: string) =>
    parseModule(`${header}${lines}\n\n[#p]\nText.\n`, { id: 'm' });

  it('reads :deprecated: and :replaced-by: and prints them back', () => {
    const module = withHeader(
      ':deprecated: Superseded by the new procedure.\n:replaced-by: charging-v2',
    );
    expect(module.meta.deprecated).toEqual({
      reason: 'Superseded by the new procedure.',
      replacedBy: 'charging-v2',
    });
    expect(printModule(module)).toContain(
      ':deprecated: Superseded by the new procedure.\n:replaced-by: charging-v2\n',
    );
    expect(parseModule(printModule(module), { id: 'm' })).toEqual(module);
  });

  it('reads a deprecation without a replacement', () => {
    expect(withHeader(':deprecated: Withdrawn.').meta.deprecated).toEqual({
      reason: 'Withdrawn.',
    });
  });

  it('refuses a replacement without a reason, and an empty reason', () => {
    expect(() => withHeader(':replaced-by: other')).toThrow(
      /:replaced-by: needs :deprecated:/,
    );
    expect(() => withHeader(':deprecated:')).toThrow(/invalid module/);
    expect(() =>
      withHeader(':deprecated: Old.\n:replaced-by: Not A Slug'),
    ).toThrow(/invalid module/);
  });

  it('refuses a reason past the limit', () => {
    expect(() => withHeader(`:deprecated: ${'x'.repeat(501)}`)).toThrow(
      /at most 500/,
    );
  });
});

describe('parseModule errors', () => {
  it('points at the line of a block without an id', () => {
    expect(errorOf('Just text.')).toBe(
      'line 6: expected a block attribute line such as [#my-id]',
    );
    expect(errorOf('[]\nText.')).toBe(
      'line 6: block has no id; add one like [#my-id]',
    );
  });

  it('rejects unclosed blocks, unknown styles and bad headings', () => {
    expect(errorOf('[NOTE#n]\n====\n[#p]\nText.')).toMatch(
      /line 7.*not closed with "===="/,
    );
    expect(errorOf('[sidebar#s]\n****')).toMatch(
      /unknown block style "sidebar"/,
    );
    expect(errorOf('[#s]\n=== Too deep')).toMatch(/expected a level 1 heading/);
  });

  it('rejects unclosed inline marks and stray braces', () => {
    expect(errorOf('[#p]\n**bold')).toMatch(/line 7: unclosed strong/);
    expect(errorOf('[#p]\nA {Bad} ref')).toMatch(
      /must start an attribute reference/,
    );
  });

  it('reports schema problems from the parsed result', () => {
    expect(errorOf('[#p]\nOne.\n\n[#p]\nTwo.')).toMatch(
      /duplicate block id "p"/,
    );
    // A comparison with something that is not a version (#225).
    expect(
      errorOf('[variant#v,when="software >= abc"]\n====\n[#p]\nHi.\n===='),
    ).toMatch(/dotted version/);
  });

  it('accepts soft-wrapped paragraphs as single lines', () => {
    const module = parse('[#p]\nOne\ntwo.');
    expect(module.blocks[0]).toEqual({
      type: 'paragraph',
      id: 'p',
      content: [{ type: 'text', text: 'One two.' }],
    });
  });
});

describe('condition syntax', () => {
  it('reads precedence and keeps explicit groups', () => {
    expect(parseCondition('a in (x) || b in (y) && c >= 2')).toEqual({
      op: 'any',
      of: [
        { op: 'in', attr: 'a', values: ['x'] },
        {
          op: 'all',
          of: [
            { op: 'in', attr: 'b', values: ['y'] },
            { op: 'cmp', attr: 'c', cmp: '>=', value: '2' },
          ],
        },
      ],
    });
    const grouped = parseCondition('(a in (x) && b in (y)) && c in (z)');
    expect(grouped.op).toBe('all');
    expect(formatCondition(grouped)).toBe('(a in (x) && b in (y)) && c in (z)');
  });

  it('quotes values that are not plain words', () => {
    const condition = {
      op: 'in' as const,
      attr: 'market',
      values: ["it's", 'eu'],
    };
    expect(formatCondition(condition)).toBe("market in ('it\\'s', eu)");
    expect(parseCondition(formatCondition(condition))).toEqual(condition);
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCondition('model in l-200')).toThrow(/expected "\("/);
    expect(() => parseCondition('model == 2')).toThrow(/unexpected "="/);
    expect(() => parseCondition('a in (x) b')).toThrow(
      /unexpected text at the end/,
    );
  });
});

describe('inline round trip edge cases', () => {
  it('reads back keyboard keys containing brackets, plus signs and backslashes', () => {
    const keys = ['Ctrl', '[', '+', '\\', 'Alt'];
    const nodes = [{ type: 'kbd' as const, keys }];
    const printed = printInline(nodes, false);
    expect(parseInline(`${printed} and [.ui]##more##`)).toEqual([
      { type: 'kbd', keys },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'more', marks: [{ type: 'ui' }] },
    ]);
  });
});

describe('images in procedure steps', () => {
  const asset = `sha256:${'ab'.repeat(32)}`;

  it('reads and prints a step’s images under its text, the steps after it going on', () => {
    const source = [
      '[procedure#p]',
      '. [[s1]]Open the cover.',
      '+',
      '[#i1]',
      `image::${asset}["The cover",width=50%]`,
      '+',
      '[#i2]',
      `image::${asset}["The latch"]`,
      '. [[s2]]Plug in.',
    ].join('\n');
    const module = parse(source);
    expect(module.blocks).toEqual([
      {
        type: 'procedure',
        id: 'p',
        steps: [
          {
            id: 's1',
            content: [{ type: 'text', text: 'Open the cover.' }],
            blocks: [
              { type: 'image', id: 'i1', asset, alt: 'The cover', width: 50 },
              { type: 'image', id: 'i2', asset, alt: 'The latch' },
            ],
          },
          {
            id: 's2',
            content: [{ type: 'text', text: 'Plug in.' }],
            blocks: [],
          },
        ],
      },
    ]);
    expect(printModule(module)).toContain(`\n${source}\n`);
    expect(parseModule(printModule(module), { id: 'm' })).toEqual(module);
  });
});

describe('attachment blocks', () => {
  const asset = `sha256:${'ab'.repeat(32)}`;

  it('reads and prints the attachment macro', () => {
    const source = `[#cfg]\nattachment::${asset}["Configuration files, \\"v2\\"",file=config-v2.zip,type="application/zip",size=12345,description="ZIP with the settings."]`;
    const module = parse(source);
    expect(module.blocks).toEqual([
      {
        type: 'attachment',
        id: 'cfg',
        asset,
        name: 'Configuration files, "v2"',
        description: 'ZIP with the settings.',
        fileName: 'config-v2.zip',
        mediaType: 'application/zip',
        size: 12345,
      },
    ]);
    expect(printModule(module)).toContain(`\n${source}\n`);
  });

  it('needs its name, file, type and size, and takes no title', () => {
    expect(errorOf(`[#a]\nattachment::${asset}[]`)).toMatch(
      /an attachment needs its name/,
    );
    expect(
      errorOf(`[#a]\nattachment::${asset}["N",type=application/zip,size=1]`),
    ).toMatch(/needs file=, type= and size=/);
    expect(
      errorOf(
        `[#a]\nattachment::${asset}["N",file=a.zip,type=application/zip,size=1.5]`,
      ),
    ).toMatch(/whole number of bytes/);
    expect(
      errorOf(
        `[#a]\n.Title\nattachment::${asset}["N",file=a.zip,type=application/zip,size=1]`,
      ),
    ).toMatch(/cannot have a title/);
  });

  it('refuses a file name that is a path, and a media type in capitals', () => {
    expect(
      errorOf(
        `[#a]\nattachment::${asset}["N",file="../etc/passwd",type=application/zip,size=1]`,
      ),
    ).toMatch(/a file name without path separators/);
    expect(
      errorOf(
        `[#a]\nattachment::${asset}["N",file=a.zip,type=Application/Zip,size=1]`,
      ),
    ).toMatch(/lowercase media type/);
  });
});

describe('page breaks', () => {
  it("reads and prints AsciiDoc's page break", () => {
    const source = '[#p]\nBefore.\n\n[#break]\n<<<\n\n[#q]\nAfter.';
    const module = parse(source);
    expect(module.blocks).toEqual([
      {
        type: 'paragraph',
        id: 'p',
        content: [{ type: 'text', text: 'Before.' }],
      },
      { type: 'pageBreak', id: 'break' },
      {
        type: 'paragraph',
        id: 'q',
        content: [{ type: 'text', text: 'After.' }],
      },
    ]);
    expect(printModule(module)).toContain(`\n${source}\n`);
  });

  it('keeps a paragraph that reads "<<<" a paragraph', () => {
    const module = parse('[#p]\n{empty}<<<');
    expect(module.blocks).toEqual([
      { type: 'paragraph', id: 'p', content: [{ type: 'text', text: '<<<' }] },
    ]);
    expect(printModule(module)).toContain('\n[#p]\n{empty}<<<\n');
  });

  it('takes no title, and only goes where a page can break', () => {
    expect(errorOf('[#b]\n.Title\n<<<')).toMatch(
      /a page break cannot have a title/,
    );
    expect(errorOf('[NOTE#n]\n====\n[#b]\n<<<\n====')).toMatch(
      /page break "b" must be at module level/,
    );
  });
});

describe('module references', () => {
  it('reads and prints a whole module and one block of it (#223)', () => {
    const source =
      '[#whole]\nmodule::battery-safety[]\n\n[#one]\nmodule::battery-safety[block=acid-warning]';
    const module = parse(source);
    expect(module.blocks).toEqual([
      { type: 'moduleRef', id: 'whole', module: 'battery-safety' },
      {
        type: 'moduleRef',
        id: 'one',
        module: 'battery-safety',
        block: 'acid-warning',
      },
    ]);
    expect(printModule(module)).toContain(`\n${source}\n`);
    expect(parseModule(printModule(module), { id: 'm' })).toEqual(module);
  });

  it('refuses anything but a block ID in its brackets', () => {
    for (const macro of [
      'module::battery-safety[block=]',
      'module::battery-safety[block=Acid]',
      'module::battery-safety[acid-warning]',
      'module::battery-safety[block=a,block=b]',
      'module::battery-safety[block="a"]',
    ]) {
      expect(errorOf(`[#one]\n${macro}`)).toMatch(
        /expected module::<module-id>\[\]/,
      );
    }
  });
});
