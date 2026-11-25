import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Block,
  MAX_ITEM_VALUES,
  Module,
  parseConfig,
  validateImport,
} from '@openfolia/content-model';
import fc from 'fast-check';
import { unzipSync } from 'fflate';
import { parse as parseYaml } from 'yaml';
import { bundleFiles } from './bundle.js';
import { DEFAULT_MAX_DOCUMENT_BYTES, runCli } from './cli.js';
import { convertMarkup, convertWikiPages, type WikiPage } from './convert.js';
import { readExportFolder } from './export-folder.js';
import { ConversionReport } from './report.js';
import { WikiMapping } from './mapping.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const config = parseConfig(
  readFileSync(join(FIXTURES, 'openfolia.yaml'), 'utf8'),
);
const mapping = WikiMapping.parse(
  parseYaml(readFileSync(join(FIXTURES, 'mapping.yaml'), 'utf8')),
);
const plainMapping = WikiMapping.parse({
  language: 'en',
  moduleType: 'concept',
});

const page = (markup: string, over: Partial<WikiPage> = {}): WikiPage => ({
  id: 'p1',
  title: 'Page one',
  markup,
  ...over,
});

/** One page's blocks, and the codes of its findings with their blocks. */
function convert(
  markup: string,
  over: Partial<WikiPage> = {},
  using: WikiMapping = plainMapping,
) {
  const result = convertWikiPages([page(markup, over)], using);
  const module = result.document.modules[0] as Module;
  const findings = (result.document.report ?? []).map((entry) => ({
    code: /^\[([a-z-]+)\]/.exec(entry.message)?.[1],
    block: entry.block,
    message: entry.message,
  }));
  return { module, blocks: module.blocks, findings, result };
}

/** The values (array elements and object members, at any depth) `value` holds, as the import counts them. */
function valuesIn(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0;
  const children = Object.values(value);
  return children.reduce((n: number, c) => n + valuesIn(c), children.length);
}

const codes = (findings: { code?: string }[]) => findings.map((f) => f.code);

/** The errors `validateImport` finds in a conversion, against the fixture configuration. */
async function errorsOf(conversion: Parameters<typeof bundleFiles>[0]) {
  const validation = await validateImport(
    { files: bundleFiles(conversion) },
    config,
  );
  return [
    ...validation.issues,
    ...validation.items.flatMap((i) => i.issues),
  ].filter((i) => i.severity === 'error');
}

describe('convertWikiPages on the example export', () => {
  it('gives a bundle that validates against the target configuration, without an error', async () => {
    const { pages } = await readExportFolder(join(FIXTURES, 'export'));
    const conversion = convertWikiPages(pages, mapping);
    const validation = await validateImport(
      { files: bundleFiles(conversion) },
      config,
    );
    const errors = [
      ...validation.issues,
      ...validation.items.flatMap((i) => i.issues),
    ].filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(validation.counts).toMatchObject({
      modules: 2,
      manuals: 1,
      assets: 2,
    });
  });

  it('maps the pages, their labels and their links onto modules', async () => {
    const { pages } = await readExportFolder(join(FIXTURES, 'export'));
    const { document } = convertWikiPages(pages, mapping);
    const [filling, limits] = document.modules as Module[];
    expect(filling?.id).toBe('1042');
    expect(filling?.meta).toEqual({
      title: 'Filling the tank',
      type: 'concept',
      lang: 'en',
      audience: 'public',
      facets: { region: ['north'] },
      source: { system: 'Example wiki', id: '1042' },
    });
    // A link to a page of the export is a cross-reference to its module.
    expect(JSON.stringify(filling?.blocks)).toContain(
      '{"type":"xref","module":"1043"}',
    );
    expect(JSON.stringify(limits?.blocks)).toContain(
      '{"type":"xref","module":"1042"}',
    );
    expect(document.manuals).toEqual([
      expect.objectContaining({
        id: 'pump-guide',
        entries: [{ module: '1042' }, { module: '1043' }],
        variants: [{ model: 'small' }],
      }),
    ]);
  });

  it('reports every construct it could not convert, block by block', async () => {
    const { pages } = await readExportFolder(join(FIXTURES, 'export'));
    const { document } = convertWikiPages(pages, mapping);
    const report = document.report ?? [];
    const found = report.map(
      (e) => `${e.sourceId} ${/^\[([a-z-]+)\]/.exec(e.message)?.[1]}`,
    );
    expect(found).toEqual(
      expect.arrayContaining([
        '1042 unmapped-label',
        '1042 unknown-macro',
        '1042 strikethrough',
        '1042 row-padded',
        '1042 macro-frame',
        '1042 colour',
        '1042 mention',
        '1042 rule',
        '1043 underline',
        '1043 unknown-macro',
        '1043 page-link-outside',
        '1043 missing-file',
      ]),
    );
    for (const entry of report) {
      expect(entry.module).toBeDefined();
      expect(entry.message).toMatch(/^\[[a-z-]+\] /);
    }
    // Each finding names the block it is about, where there is one.
    const toc = report.find((e) => e.message.includes('{toc}'));
    const filling = document.modules[0] as Module;
    expect(JSON.stringify(filling.blocks)).toContain(
      `{"type":"passthrough","id":"${toc?.block}","format":"wiki","raw":"{toc}"}`,
    );
  });

  it('keeps every word of the pages: in a block, or verbatim in a passthrough', async () => {
    const { pages } = await readExportFolder(join(FIXTURES, 'export'));
    const { document } = convertWikiPages(pages, mapping);
    pages.forEach((source, index) => {
      const kept = JSON.stringify(document.modules[index]);
      const words = source.markup
        // A link to an exported page is a cross-reference, shown with that page's title.
        .replace(/\[(Pressure limits|Filling the tank)\]/g, ' ')
        // Files are kept by their bytes, not their names.
        .replace(/![^!\s]+\.png[^!]*!/g, (m) =>
          m.includes('missing') ? m : ' ',
        )
        .replace(/\^[\w.]+\.pdf/g, ' ')
        // A link with its own text keeps that text; where it went is in the report.
        .replace(/\|[^\]|]*\]/g, ']')
        // Markup, not content: heading markers, macro names, settings.
        .replace(/\{[A-Za-z][\w-]*(:[^}]*)?\}/g, ' ')
        .replace(/\bh[1-6]\./g, ' ')
        .replace(/\b(alt|width|title|language)=/g, ' ')
        .match(/[\p{L}\p{N}]{2,}/gu);
      for (const word of words ?? []) expect(kept).toContain(word);
    });
  });
});

describe('blocks', () => {
  it('nests sections by heading level, within the depth the model allows', () => {
    const { blocks, findings } = convert(
      [
        'h1. A',
        'one',
        'h3. B',
        'two',
        'h2. C',
        'h1. D',
        'h2. E',
        'h3. F',
        'h4. G',
        'h5. H',
        'h6. I',
        'deep',
      ].join('\n'),
    );
    const shape = (list: Block[]): unknown[] =>
      list.map((b) =>
        b.type === 'section' ? { [b.id]: shape(b.blocks) } : b.type,
      );
    expect(shape(blocks)).toEqual([
      { a: ['paragraph', { b: ['paragraph'] }, { c: [] }] },
      { d: [{ e: [{ f: [{ g: [{ h: [] }, { i: ['paragraph'] }] }] }] }] },
    ]);
    expect(codes(findings)).toEqual(['too-deep']);
    expect(Module.safeParse(convert('h1. A\nh6. B\nx').module).success).toBe(
      true,
    );
  });

  it('turns lists into nested lists, and numbered lists into procedures when mapped so', () => {
    const markup = '# One\n#* inner\n#* more\n# Two\ncontinued\n* other';
    const { blocks } = convert(markup);
    expect(blocks.map((b) => b.type)).toEqual(['list', 'list']);
    const [steps] = blocks as [Extract<Block, { type: 'list' }>];
    expect(steps.ordered).toBe(true);
    expect(steps.items[0]?.blocks[0]).toMatchObject({
      type: 'list',
      ordered: false,
      items: [
        { content: [{ text: 'inner' }] },
        { content: [{ text: 'more' }] },
      ],
    });
    expect(steps.items[1]?.content).toEqual([
      { type: 'text', text: 'Two' },
      { type: 'hardBreak' },
      { type: 'text', text: 'continued' },
    ]);
    const procedure = convert(
      markup,
      {},
      { ...plainMapping, orderedLists: 'procedure' },
    );
    expect(procedure.blocks.map((b) => b.type)).toEqual(['procedure', 'list']);
  });

  it('reads tables with a header row, links holding "|" and short rows padded', () => {
    const { blocks, findings } = convert(
      '||Name||Link||\n|a|[site|https://example.com/a]|\n||b|c|\n|d|',
    );
    const [table] = blocks as [Extract<Block, { type: 'table' }>];
    expect(table.header).toBe(true);
    expect(table.columns).toHaveLength(2);
    expect(table.rows).toHaveLength(4);
    expect(JSON.stringify(table.rows[1])).toContain(
      '"marks":[{"type":"link","href":"https://example.com/a"}]',
    );
    expect(table.rows[3]?.cells[1]).toEqual({ blocks: [] });
    expect(codes(findings).sort()).toEqual(['header-cell', 'row-padded']);
    expect(Module.safeParse(convert('||a||b||\n|c|d|').module).success).toBe(
      true,
    );
  });

  it('keeps code verbatim, with its language', () => {
    const { blocks } = convert(
      '{code:java}\nint *a* = [1|2];\n{code}\n{noformat}\nh1. not a heading\n{noformat}',
    );
    expect(blocks).toEqual([
      expect.objectContaining({
        type: 'literal',
        text: 'int *a* = [1|2];',
        language: 'java',
      }),
      expect.objectContaining({ type: 'literal', text: 'h1. not a heading' }),
    ]);
  });

  it('maps admonition and safety macros, and keeps unknown macros verbatim', () => {
    const { blocks, findings } = convert(
      '{tip}\nA hint.\n{tip}\n{warning}\nHot surface\n\nWear gloves.\n{warning}\n{gadget:x=1}\ninside\n{gadget}\n{toc}',
      {},
      {
        ...plainMapping,
        safety: { warning: { severity: 'caution', symbols: [] } },
      },
    );
    expect(blocks.map((b) => b.type)).toEqual([
      'admonition',
      'safety',
      'passthrough',
      'passthrough',
    ]);
    expect(blocks[1]).toMatchObject({
      severity: 'caution',
      hazard: [{ type: 'text', text: 'Hot surface' }],
      blocks: [{ type: 'paragraph', content: [{ text: 'Wear gloves.' }] }],
    });
    expect(blocks[2]).toMatchObject({ raw: '{gadget:x=1}\ninside\n{gadget}' });
    expect(codes(findings)).toEqual(['unknown-macro', 'unknown-macro']);
    expect(findings.map((f) => f.block)).toEqual([
      blocks[2]?.id,
      blocks[3]?.id,
    ]);
  });

  it('places images and attachments as blocks, after the text they stood in', () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const { blocks, findings, result } = convert(
      'See !a.png|alt=An A! here and [the file|^b.txt].\n\n!a.png|thumbnail!',
      {
        attachments: new Map([
          ['a.png', png],
          ['b.txt', new Uint8Array([104, 105])],
        ]),
      },
    );
    expect(blocks.map((b) => b.type)).toEqual([
      'paragraph',
      'image',
      'attachment',
      'image',
    ]);
    expect(blocks[2]).toMatchObject({
      name: 'the file',
      fileName: 'b.txt',
      mediaType: 'text/plain',
      size: 2,
    });
    expect(codes(findings)).toEqual([
      'moved-out-of-text',
      'moved-out-of-text',
      'no-alt',
      'image-setting',
    ]);
    expect(result.assets.size).toBe(2);
  });
});

describe('inline', () => {
  const content = (markup: string) => {
    const { blocks, findings } = convert(markup);
    return {
      content: (blocks[0] as Extract<Block, { type: 'paragraph' }>).content,
      findings,
    };
  };

  it("converts formatting to marks, in the model's order", () => {
    expect(
      content('*bold _both_* {{code}} x^2^ H~2~O ??cited??').content,
    ).toEqual([
      { type: 'text', text: 'bold ', marks: [{ type: 'strong' }] },
      {
        type: 'text',
        text: 'both',
        marks: [{ type: 'strong' }, { type: 'emphasis' }],
      },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'code', marks: [{ type: 'code' }] },
      { type: 'text', text: ' x' },
      { type: 'text', text: '2', marks: [{ type: 'sup' }] },
      { type: 'text', text: ' H' },
      { type: 'text', text: '2', marks: [{ type: 'sub' }] },
      { type: 'text', text: 'O ' },
      { type: 'text', text: 'cited', marks: [{ type: 'emphasis' }] },
    ]);
  });

  it('leaves delimiters inside words, escapes and lone ones as text', () => {
    expect(
      content('a*b*c well-known 2 * 3 \\*not\\* snake_case_name').content,
    ).toEqual([
      { type: 'text', text: 'a*b*c well-known 2 * 3 *not* snake_case_name' },
    ]);
  });

  it('reads hostile markup in linear time', () => {
    const hostile = [
      ...['*', '-', '_', '^', '??', '[', '{{'].map((d) =>
        ` ${d}ж`.repeat(50_000),
      ),
      '{color:red}ж'.repeat(20_000),
      // A closer far away that the open emphasis refuses, for every opener.
      `_a ${'??ж '.repeat(30_000)}y?? z_`,
      // Table rows of openers without a close.
      `|${'[ж'.repeat(200_000)}`,
      `|${'{{ж'.repeat(200_000)}`,
      // A macro whose closing tag stands in a long line, again and again.
      `{foo}\n${'ж{foo}'.repeat(100_000)}`,
      // A container of very many blocks, a cell of very many images.
      `{panel}\n${'ж\n\n'.repeat(150_000)}{panel}`,
      `||${'!ж.png!'.repeat(150_000)}|`,
      // Very many rows; very many equal headings.
      '|ж\n'.repeat(150_000),
      'h2. ж\n'.repeat(50_000),
    ];
    const xs = (text: string) => text.split('ж').length - 1;
    for (const markup of hostile) {
      const started = performance.now();
      const { blocks } = convert(markup);
      expect(performance.now() - started).toBeLessThan(5_000);
      // Every ж is still there, as text or verbatim.
      expect(xs(JSON.stringify(blocks))).toBe(xs(markup));
    }
    // Unknown macros with settings and no close, one per line.
    const started = performance.now();
    const { blocks } = convert('{foo:ж}\n'.repeat(25_000));
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(xs(JSON.stringify(blocks))).toBe(25_000);
    // Thousands of unknown macros of different names, none closed: each
    // search would read the rest of the page.
    const names = Array.from(
      { length: 50_000 },
      (_, n) => `{m${n}}\nж ${'y'.repeat(40)}\n`,
    ).join('');
    const start2 = performance.now();
    const many = convert(names).blocks;
    expect(performance.now() - start2).toBeLessThan(5_000);
    expect(xs(JSON.stringify(many))).toBe(50_000);
  }, 60_000);

  it('keeps a table too large to pad verbatim, and reports it', async () => {
    // 1,000 columns by 51 rows: just past the 50,000 places a table may cover.
    const markup = `|${'a|'.repeat(1_000)}\n${'|b|\n'.repeat(50)}`;
    const { blocks, findings } = convert(markup);
    expect(blocks).toMatchObject([{ type: 'passthrough', format: 'wiki' }]);
    expect(codes(findings)).toEqual(['table-too-large']);
    expect(JSON.stringify(blocks).split('b').length - 1).toBe(50);
    // Tables within one module's cap are kept, those past it stay as written,
    // and the module validates.
    const table = `|${'a|'.repeat(10)}\n${'|b|\n'.repeat(99)}\n`;
    const many = convert(table.repeat(20));
    const keptHere = many.blocks.filter((b) => b.type === 'table').length;
    expect(keptHere).toBeGreaterThan(5);
    expect(keptHere).toBeLessThan(20);
    expect(
      codes(many.findings).filter((c) => c === 'table-too-large'),
    ).toHaveLength(20 - keptHere);
    expect(await errorsOf(many.result)).toEqual([]);
    // Across the pages of a bundle, at most 800,000 values (about 258 of these
    // tables): 60 pages of 5 pass it.
    const pages = Array.from({ length: 60 }, (_, n) =>
      page(table.repeat(5), { id: `p${n}`, title: `P${n}` }),
    );
    const bundle = convertWikiPages(pages, plainMapping);
    const kept = bundle.document.modules.flatMap((m) =>
      m.blocks.filter((b) => b.type === 'table'),
    );
    expect(kept.length).toBeGreaterThan(100);
    expect(kept.length).toBeLessThan(300);
    // Not validated whole: that reads about 800,000 values, most of this
    // test's time, and the cap is counted as `validateImport` counts. One
    // module, validated above, is the same check on 40,000.
  });

  it('keeps a page too large for one module verbatim, and reports it', async () => {
    for (const markup of ['|a|\n\n'.repeat(12_000), 'ж\n\n'.repeat(30_000)]) {
      const { blocks, findings, result } = convert(markup);
      expect(blocks).toEqual([
        expect.objectContaining({ type: 'passthrough', raw: markup }),
      ]);
      expect(codes(findings)).toEqual(['page-too-large']);
      expect(await errorsOf(result)).toEqual([]);
    }
  });

  it('forgets the files of a page too large, but keeps those an earlier page used', () => {
    const files = new Map([
      ['a.png', new Uint8Array([1])],
      ['b.png', new Uint8Array([2])],
    ]);
    const { document, assets } = convertWikiPages(
      [
        page('!a.png|alt=A!', { attachments: files }),
        page(`!a.png|alt=A!\n\n!b.png|alt=B!\n\n${'ж\n\n'.repeat(30_000)}`, {
          id: 'p2',
          title: 'Page two',
          attachments: files,
        }),
      ],
      plainMapping,
    );
    expect(document.modules[1]?.blocks).toMatchObject([
      { type: 'passthrough' },
    ]);
    expect([...assets.keys()]).toEqual([
      (document.modules[0]?.blocks[0] as { asset: string }).asset,
    ]);
  });

  it('converts many pages with a file each in linear time', () => {
    const pages = Array.from({ length: 20_000 }, (_, n) =>
      page(`!f${n}.png|alt=F!`, {
        id: `p${n}`,
        title: `P${n}`,
        attachments: new Map([
          [`f${n}.png`, new Uint8Array([n & 255, n >> 8])],
        ]),
      }),
    );
    const started = performance.now();
    const { assets } = convertWikiPages(pages, plainMapping);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(assets.size).toBe(20_000);
  }, 60_000);

  it('leaves room in a module for its own meta, however many facet values it has', () => {
    const facets = {
      region: Array.from({ length: 3_000 }, (_, n) => `r${n}`),
    };
    const many = WikiMapping.parse({ ...plainMapping, facets });
    // Blocks within the old headroom of 1,000 values, but not with this meta.
    const { module, findings } = convert('ж\n\n'.repeat(6_800), {}, many);
    expect(codes(findings)).toEqual(['page-too-large']);
    expect(valuesIn(module)).toBeLessThanOrEqual(MAX_ITEM_VALUES);
    // Without the facets, the same page fits.
    expect(codes(convert('ж\n\n'.repeat(6_800)).findings)).toEqual([]);
  });

  it('validates whatever tables it keeps', async () => {
    // Formatted cells cost more values than plain ones.
    for (const cell of [
      '*bold* text',
      'a\\\\b',
      '[x|https://example.com] y',
      `[*_^~${'a\\\\'.repeat(100)}a~^_*|https://e.com]`,
      `a${'\nb'.repeat(50)}`,
    ]) {
      for (const rows of [100, 350, 1_000]) {
        const table = `|${`${cell}|`.repeat(10)}\n`.repeat(rows);
        expect(await errorsOf(convert(table).result)).toEqual([]);
      }
    }
    expect(
      await errorsOf(
        convert(`|${'a|'.repeat(999)}\n${'|b|\n'.repeat(4)}`).result,
      ),
    ).toEqual([]);
  });

  it('reports a label named like a built-in property as unmapped', () => {
    const { findings } = convert('Text.', {
      labels: ['constructor', '__proto__'],
    });
    expect(codes(findings)).toEqual(['unmapped-label', 'unmapped-label']);
  });

  it('keeps the text of what has no mark, and reports it', () => {
    const { content: nodes, findings } = content(
      '-gone- +under+ {color:#f00}red{color} {status:ok}',
    );
    expect(nodes).toEqual([
      { type: 'text', text: 'gone under red {status:ok}' },
    ]);
    expect(codes(findings)).toEqual([
      'strikethrough',
      'underline',
      'colour',
      'inline-macro',
    ]);
  });

  it('links addresses, and refuses what the model does not link', () => {
    const { content: nodes, findings } = content(
      '[a|https://example.com] [ftp://x.org/f] [mail|mailto:a@example.com] [#top] [Nowhere]',
    );
    expect(nodes.filter((n) => n.type === 'text' && n.marks)).toEqual([
      {
        type: 'text',
        text: 'a',
        marks: [{ type: 'link', href: 'https://example.com' }],
      },
      {
        type: 'text',
        text: 'mail',
        marks: [{ type: 'link', href: 'mailto:a@example.com' }],
      },
    ]);
    expect(codes(findings)).toEqual([
      'invalid-link',
      'anchor-link',
      'page-link-outside',
    ]);
  });

  it('turns a line break and a forced one into hard breaks', () => {
    expect(content('one\\\\two\nthree').content.map((n) => n.type)).toEqual([
      'text',
      'hardBreak',
      'text',
      'hardBreak',
      'text',
    ]);
  });
});

describe('any markup', () => {
  it('never throws, and always gives modules the content model accepts', () => {
    const piece = fc.constantFrom(
      'h1. ',
      'h3. ',
      '\n',
      '\n\n',
      '* ',
      '# ',
      '- ',
      '|',
      '||',
      '*',
      '_',
      '-',
      '+',
      '^',
      '~',
      '{{',
      '}}',
      '[',
      ']',
      '!',
      '{info}',
      '{code}',
      '{panel}',
      '{toc}',
      '{color:red}',
      '{color}',
      'bq. ',
      '----',
      '\\',
      'word',
      ' ',
      'x.png',
      '[Page one]',
      'https://example.com',
      '{anchor:a}',
      '[^x.png]',
      '** ',
      'C:\\Users',
    );
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 60 }), (pieces) => {
        const { module } = convert(pieces.join(''));
        const parsed = Module.safeParse(module);
        if (!parsed.success)
          throw new Error(JSON.stringify(parsed.error.issues.slice(0, 3)));
      }),
      { numRuns: 1000 },
    );
  });

  it('stops a page only once its blocks pass the limit, exactly where a full conversion would', () => {
    const piece = fc.constantFrom(
      'h1. ',
      'h2. ',
      '\n',
      '\n\n',
      '* ',
      '** ',
      '# ',
      '|',
      '||',
      '*',
      '_',
      '??',
      '-',
      '+',
      '^',
      '{{',
      '}}',
      '\\\\',
      '{info}',
      '{warning}',
      '{panel}',
      '{code}',
      '{toc}',
      '{color:red}',
      '{color}',
      'bq. ',
      'word',
      ' ',
      '!x.png!',
      '!y.png!',
      '[^x.png]',
      '[a|^x.png]',
      '[Page one]',
      '[a\\\\b *c*|Page one]',
      '[x|https://example.com]',
      '[*x* !x.png!|https://example.com]',
      '[Elsewhere]',
      '~',
      '!https://example.com/a.png!',
      '[mailto:a@example.com]',
      '[#anchor]',
      '[~someone]',
      '[x|https://example.com]\n',
    );
    const run = (markup: string, maxValues: number) => {
      const report = new ConversionReport();
      const blocks = convertMarkup(
        markup,
        {
          sourceId: 'p1',
          moduleId: 'm',
          mapping,
          attachments: new Map([['x.png', new Uint8Array([1])]]),
          reserve: MAX_ITEM_VALUES - maxValues,
        },
        {
          report,
          assets: new Map(),
          pageByTitle: (t) => (t === 'Page one' ? 'm' : undefined),
        },
      );
      const tooLarge = report
        .list()
        .some((e) => e.message.startsWith('[page-too-large]'));
      return { blocks, tooLarge };
    };
    const agrees = (markup: string) => {
      const full = run(markup, MAX_ITEM_VALUES);
      const values = valuesIn(full.blocks);
      // Just enough room: the same blocks; one value less: verbatim.
      const fits = run(markup, values);
      expect(fits.tooLarge).toBe(false);
      expect(fits.blocks).toEqual(full.blocks);
      if (values > 0) expect(run(markup, values - 1).tooLarge).toBe(true);
    };
    // Two links to one address merge into one text node.
    agrees('[x|https://example.com][x|https://example.com]');
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 80 }), (pieces) =>
        agrees(pieces.join('')),
      ),
      { numRuns: 1000 },
    );
  });

  it('gives bundles the import accepts, whatever the markup', async () => {
    const piece = fc.constantFrom(
      ...[
        'h2. ',
        '\n',
        '* ',
        '** ',
        '# ',
        '|',
        '||',
        '*',
        '_',
        '-',
        '[',
        ']',
        '!',
      ],
      ...[
        '{anchor:a}',
        '[^x.png]',
        '[Page one]',
        '[x|https://example.com]',
        '\\',
      ],
      ...['{warning}', '{panel}', 'word', ' ', 'x.png'],
    );
    await fc.assert(
      fc.asyncProperty(fc.array(piece, { maxLength: 40 }), async (pieces) => {
        const conversion = convertWikiPages(
          [page(pieces.join(''), { attachments: new Map() })],
          plainMapping,
        );
        const validation = await validateImport(
          { files: bundleFiles(conversion) },
          config,
        );
        // Each run checks the page's module.
        if (validation.items.length === 0) throw new Error('nothing checked');
        const errors = [
          ...validation.issues,
          ...validation.items.flatMap((i) => i.issues),
        ].filter((i) => i.severity === 'error');
        if (errors.length > 0)
          throw new Error(JSON.stringify(errors.slice(0, 3)));
      }),
      { numRuns: 200 },
    );
  });

  it('keeps long module IDs valid, also when two pages clash', () => {
    const title = `${'a'.repeat(89)}-b`;
    const result = convertWikiPages(
      [page('One.', { id: '1', title }), page('Two.', { id: '2', title })],
      WikiMapping.parse({ ...plainMapping, moduleIds: { from: 'title' } }),
    );
    expect(result.document.modules.map((m) => m.id)).toEqual([
      'a'.repeat(89),
      `${'a'.repeat(89)}-2`,
    ]);
    expect(
      (result.document.report ?? []).map(
        (e) => /^\[([a-z-]+)\]/.exec(e.message)?.[1],
      ),
    ).toEqual(['duplicate-id']);
  });

  it('keeps the address of a link around an image, and backslashes before other characters', () => {
    const { blocks, findings } = convert('[!x.png!|https://example.com]', {
      attachments: new Map([['x.png', new Uint8Array([1])]]),
    });
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'image']);
    expect(blocks[0]).toMatchObject({
      content: [
        {
          text: 'https://example.com',
          marks: [{ type: 'link', href: 'https://example.com' }],
        },
      ],
    });
    expect(codes(findings)).toEqual(['no-alt', 'moved-out-of-text']);
    expect(convert('C:\\Users\\x and \\*star\\*').blocks[0]).toMatchObject({
      content: [{ type: 'text', text: 'C:\\Users\\x and *star*' }],
    });
  });

  it('leaves out a nested list whose items came out empty', () => {
    const { blocks } = convert('* a\n** {anchor:x}\n* b');
    expect(blocks).toMatchObject([
      { type: 'list', items: [{ blocks: [] }, { blocks: [] }] },
    ]);
  });
});

describe('the command line', () => {
  it('writes the bundle, lists the findings and validates against the configuration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiki-markup-'));
    try {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli(
        [
          join(FIXTURES, 'export'),
          '--mapping',
          join(FIXTURES, 'mapping.yaml'),
          '--config',
          join(FIXTURES, 'openfolia.yaml'),
          '--out',
          join(dir, 'bundle.zip'),
        ],
        { out: (l) => out.push(l), err: (l) => err.push(l) },
      );
      expect(err.filter((l) => l.startsWith('error'))).toEqual([]);
      expect(code).toBe(0);
      expect(
        out.some((l) => l.startsWith('1042') && l.includes('[unknown-macro]')),
      ).toBe(true);
      const files = unzipSync(
        new Uint8Array(readFileSync(join(dir, 'bundle.zip'))),
      );
      expect(
        Object.keys(files).filter((k) => k.startsWith('assets/')),
      ).toHaveLength(2);
      expect(files['import.json']).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a mapping that is not valid, naming the field', async () => {
    const err: string[] = [];
    const code = await runCli(
      [
        join(FIXTURES, 'export'),
        '--mapping',
        join(FIXTURES, 'openfolia.yaml'),
        '--out',
        '/dev/null',
      ],
      { out: () => undefined, err: (l) => err.push(l) },
    );
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/language/);
  });
  it('warns before it writes an import.json larger than the import reads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiki-markup-'));
    try {
      const run = async (...extra: string[]) => {
        const err: string[] = [];
        const code = await runCli(
          [
            join(FIXTURES, 'export'),
            '--mapping',
            join(FIXTURES, 'mapping.yaml'),
            '--out',
            join(dir, 'bundle.zip'),
            ...extra,
          ],
          { out: () => undefined, err: (l) => err.push(l) },
        );
        return { code, warnings: err.filter((l) => l.startsWith('warning')) };
      };
      // The example's import.json is a few KiB: within the default, past 1,000 bytes.
      expect(DEFAULT_MAX_DOCUMENT_BYTES).toBe(8 * 1024 * 1024);
      expect(await run()).toEqual({ code: 0, warnings: [] });
      const small = await run('--max-document-bytes', '1000');
      expect(small.code).toBe(0);
      expect(small.warnings).toEqual([
        expect.stringMatching(
          /^warning: the bundle's import\.json holds [\d,]+ bytes, more than the 1,000 the import reads .*document-too-large/,
        ),
      ]);
      // The bundle is still written, as before.
      expect(
        unzipSync(new Uint8Array(readFileSync(join(dir, 'bundle.zip'))))[
          'import.json'
        ],
      ).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a limit on import.json that is no number of bytes', async () => {
    for (const value of ['0', '-1', '1.5', '1e3', 'lots']) {
      const err: string[] = [];
      const code = await runCli(
        [
          join(FIXTURES, 'export'),
          '--mapping',
          join(FIXTURES, 'mapping.yaml'),
          '--out',
          '/dev/null',
          `--max-document-bytes=${value}`,
        ],
        { out: () => undefined, err: (l) => err.push(l) },
      );
      expect(code).toBe(2);
      expect(err.join('\n')).toMatch(/--max-document-bytes/);
    }
  });
});
