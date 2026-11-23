import fc from 'fast-check';
import { sampleConfig } from '../../fixtures/config.js';
import {
  bundleOf,
  exampleBundle,
  exampleDocument,
} from '../../fixtures/import-example.js';
import { moduleArb } from '../../fixtures/module-arbitrary.js';
import { spannedTable } from '../../fixtures/wide-table.js';
import { ProjectConfig } from '../config.js';
import { Module } from '../module.js';
import {
  assetRefOf,
  validateImport,
  type ImportIssue,
  type ImportValidation,
} from './validate-import.js';

const config = ProjectConfig.parse(sampleConfig);
const PNG =
  'assets/497790947d4666760ce38f3c00e852c71fdb66cae849bae8e9ede352719e1581';
const JSON_FILE =
  'assets/105586f66f9086e6475e5cf9dc9eb74b3ba3b552556df7d3386d734a4d759cae';

/** Every issue of a validation, with the item it was found at. */
const allIssues = (result: ImportValidation) => [
  ...result.issues.map((issue) => ({ item: undefined, ...issue })),
  ...result.items.flatMap((item) =>
    item.issues.map((issue) => ({ item: item.id, ...issue })),
  ),
];
const errors = (result: ImportValidation) =>
  allIssues(result).filter((i) => i.severity === 'error');
const withCode = (result: ImportValidation, code: ImportIssue['code']) =>
  allIssues(result).filter((i) => i.code === code);

describe('validateImport', () => {
  it('reads the example bundle without errors', async () => {
    const result = await validateImport(exampleBundle(), config);
    expect(errors(result)).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.formatVersion).toBe(1);
    expect(result.source?.system).toBe('Example Wiki 4');
    expect(result.counts).toEqual({
      modules: 3,
      manuals: 1,
      assets: 2,
      passthrough: 1,
      clashes: 0,
      errors: 0,
      warnings: 1,
    });
    // The one warning: the passthrough block, content kept verbatim.
    expect(allIssues(result)).toEqual([
      expect.objectContaining({
        item: 'pressure-limits',
        code: 'passthrough',
        severity: 'warning',
        pointer: '/modules/2/blocks/2',
        at: 'limits-calculator',
      }),
    ]);
    expect(result.items.map((i) => [i.kind, i.id])).toEqual([
      ['module', 'tank-filling'],
      ['module', 'tank-filling'],
      ['module', 'pressure-limits'],
      ['manual', 'pump-guide'],
      [
        'asset',
        'sha256:105586f66f9086e6475e5cf9dc9eb74b3ba3b552556df7d3386d734a4d759cae',
      ],
      [
        'asset',
        'sha256:497790947d4666760ce38f3c00e852c71fdb66cae849bae8e9ede352719e1581',
      ],
    ]);
    const first = result.items[0];
    expect(first).toMatchObject({
      kind: 'module',
      lang: 'en',
      sourceId: 'PAGE-1042',
      exists: false,
      passthrough: 0,
    });
    expect(first?.kind === 'module' && first.module?.meta.title).toBe(
      'Filling the tank',
    );
    expect(result.report).toHaveLength(2);
    expect(result.report[0]).toMatchObject({
      sourceId: 'PAGE-1043',
      module: 'pressure-limits',
    });
  });

  it('gives exactly one issue, with its pointer, for an unknown module type', async () => {
    const document = exampleDocument();
    document['modules'][0].meta.type = 'brochure';
    const before = allIssues(await validateImport(exampleBundle(), config));
    const after = allIssues(await validateImport(bundleOf(document), config));
    expect(after.filter((i) => !before.some((b) => b.code === i.code))).toEqual(
      [
        {
          item: 'tank-filling',
          severity: 'error',
          code: 'unknown-module-type',
          message: 'module type "brochure" is not configured',
          pointer: '/modules/0/meta/type',
        },
      ],
    );
    expect(after).toHaveLength(before.length + 1);
  });

  it('refuses a table past the caps with table-too-large, at the table (#686)', async () => {
    const document = exampleDocument();
    // Few cells spanning a large area: 1,001 columns, one row.
    document['modules'][0].blocks.push(spannedTable(1, 10, 'wide'));
    const result = await validateImport(bundleOf(document), config);
    const index = document['modules'][0].blocks.length - 1;
    expect(withCode(result, 'table-too-large')).toEqual([
      expect.objectContaining({
        item: 'tank-filling',
        severity: 'error',
        pointer: `/modules/0/blocks/${index}`,
        message: expect.stringContaining('1,000 columns'),
      }),
    ]);
    expect(result.valid).toBe(false);
  });

  it('points configuration issues inside a module at their block', async () => {
    const document = exampleDocument();
    document['modules'][0].blocks[2].symbols = ['x999'];
    const result = await validateImport(bundleOf(document), config);
    expect(withCode(result, 'unknown-safety-symbol')).toEqual([
      expect.objectContaining({
        item: 'tank-filling',
        pointer: '/modules/0/blocks/2',
        at: 'warn-overpressure',
      }),
    ]);
  });

  it('reports a missing asset at the block that uses it', async () => {
    const bundle = exampleBundle();
    bundle.files.delete(PNG);
    const result = await validateImport(bundle, config);
    expect(result.valid).toBe(false);
    expect(errors(result)).toEqual([
      expect.objectContaining({
        item: 'tank-filling',
        code: 'missing-asset',
        pointer: '/modules/0/blocks/1/steps/0/blocks/0/asset',
        at: 'fig-connect',
      }),
    ]);
  });

  it('accepts an asset the bundle leaves out when it is stored already', async () => {
    const bundle = exampleBundle();
    bundle.files.delete(PNG);
    const stored = `sha256:${PNG.slice('assets/'.length)}`;
    const result = await validateImport(bundle, config, {
      existing: { assets: { has: async (ref) => ref === stored } },
    });
    expect(errors(result)).toEqual([]);
  });

  it('reports a file whose bytes do not match its name', async () => {
    const bundle = exampleBundle();
    const bytes = new Uint8Array(bundle.files.get(JSON_FILE) as Uint8Array);
    bytes[3] = (bytes[3] as number) ^ 1;
    bundle.files.set(JSON_FILE, bytes);
    const result = await validateImport(bundle, config);
    expect(errors(result)).toEqual([
      expect.objectContaining({
        item: `sha256:${JSON_FILE.slice('assets/'.length)}`,
        code: 'asset-hash-mismatch',
      }),
    ]);
    expect(result.items.at(-2)).toMatchObject({
      kind: 'asset',
      pointer: JSON_FILE,
      size: 46,
      used: true,
    });
  });

  it('warns when an attachment says another size than its file has', async () => {
    const document = exampleDocument();
    document['modules'][2].blocks[1].size = 45;
    const result = await validateImport(bundleOf(document), config);
    expect(withCode(result, 'attachment-size-mismatch')).toEqual([
      expect.objectContaining({
        severity: 'warning',
        pointer: '/modules/2/blocks/1/size',
      }),
    ]);
  });

  it('reports references that resolve neither in the bundle nor in the repository', async () => {
    const document = exampleDocument();
    const [module] = document['modules'];
    module.blocks[3].module = 'tank-draining';
    module.blocks[0].content[1].block = 'no-such-block';
    document['manuals'][0].entries[1].entries.push({ module: 'charging' });
    const result = await validateImport(bundleOf(document), config);
    expect(
      errors(result).map(({ item, code, pointer }) => ({
        item,
        code,
        pointer,
      })),
    ).toEqual([
      {
        item: 'tank-filling',
        code: 'dangling-block-reference',
        pointer: '/modules/0/blocks/0',
      },
      {
        item: 'tank-filling',
        code: 'dangling-module-reference',
        pointer: '/modules/0/blocks/3/module',
      },
      {
        item: 'pump-guide',
        code: 'dangling-module-reference',
        pointer: '/manuals/0/entries/1/entries/1/module',
      },
    ]);

    // Modules already in the repository resolve; their blocks aren't checked.
    const existing = new Set(['tank-draining', 'charging']);
    const again = await validateImport(bundleOf(document), config, {
      existing: { modules: existing },
    });
    expect(errors(again).map((i) => i.code)).toEqual([
      'dangling-block-reference',
    ]);
  });

  it('reports a reference to one block that the bundled module does not have (#223)', async () => {
    const document = exampleDocument();
    const [module] = document['modules'];
    expect(module.blocks[3].type).toBe('moduleRef');
    module.blocks[3].block = 'no-such-block';
    const result = await validateImport(bundleOf(document), config);
    expect(
      errors(result).map(({ code, pointer }) => ({ code, pointer })),
    ).toEqual([
      {
        code: 'dangling-block-reference',
        pointer: '/modules/0/blocks/3/module',
      },
    ]);
  });

  it('reports ID clashes as such, not as errors', async () => {
    const result = await validateImport(exampleBundle(), config, {
      existing: {
        modules: new Set(['pressure-limits']),
        manuals: new Set(['pump-guide']),
      },
    });
    expect(result.valid).toBe(true);
    expect(result.counts.clashes).toBe(2);
    expect(withCode(result, 'id-clash')).toEqual([
      expect.objectContaining({
        item: 'pressure-limits',
        severity: 'info',
        pointer: '/modules/2/id',
      }),
      expect.objectContaining({
        item: 'pump-guide',
        severity: 'info',
        pointer: '/manuals/0/id',
      }),
    ]);
    expect(result.items.filter((i) => 'exists' in i && i.exists)).toHaveLength(
      2,
    );
  });

  it('refuses an import.json larger than allowed before parsing it', async () => {
    const result = await validateImport(bundleOf(exampleDocument()), config, {
      maxDocumentBytes: 100,
    });
    expect(result.valid).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.issues.map((i) => i.code)).toEqual(['document-too-large']);
  });

  it('refuses more modules and manuals than allowed before checking any', async () => {
    const result = await validateImport(bundleOf(exampleDocument()), config, {
      maxItems: 3,
    });
    expect(result.valid).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.issues.map((i) => i.code)).toEqual(['too-many-items']);
    // Four is enough.
    const fits = await validateImport(bundleOf(exampleDocument()), config, {
      maxItems: 4,
    });
    expect(withCode(fits, 'too-many-items')).toEqual([]);
  });

  it('refuses a document with too many values before checking it', async () => {
    const result = await validateImport(bundleOf(exampleDocument()), config, {
      maxValues: 50,
    });
    expect(result.items).toEqual([]);
    expect(result.issues.map((i) => i.code)).toEqual(['too-many-values']);
  });

  it('refuses a converter report too long to read, and a module too large to check', async () => {
    const report = Array.from({ length: 10_001 }, () => ({}));
    const long = await validateImport(
      bundleOf({ ...exampleDocument(), report }),
      config,
    );
    expect(long.items).toEqual([]);
    expect(long.issues.map((i) => i.code)).toEqual(['report-too-large']);
    const document = exampleDocument();
    document['modules'][0].blocks = Array.from({ length: 50_001 }, () => 1);
    const large = await validateImport(bundleOf(document), config);
    expect(large.items[0]?.issues.map((i) => i.code)).toEqual([
      'item-too-large',
    ]);
  });

  it('stops checking malformed modules once they hold too many values', async () => {
    const malformed = (i: number) => ({
      schemaVersion: 1,
      id: `bad-${i}`,
      meta: { title: 'Bad', type: 'concept', lang: 'en', audience: 'public' },
      blocks: Array.from({ length: 40_000 }, () => ({})),
    });
    const result = await validateImport(
      bundleOf({ formatVersion: 1, modules: [0, 1, 2, 3].map(malformed) }),
      config,
    );
    expect(
      result.items
        .filter((item) => item.kind === 'module')
        .map((item) => item.issues[0]?.code),
    ).toEqual([
      'invalid-schema',
      'invalid-schema',
      'invalid-schema',
      'not-checked',
    ]);
  });

  it('refuses a newer format version with a clear message', async () => {
    const document = exampleDocument();
    document['formatVersion'] = 2;
    const result = await validateImport(bundleOf(document), config);
    expect(result.valid).toBe(false);
    expect(result.formatVersion).toBe(2);
    expect(result.items).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'unsupported-format-version',
        pointer: '/formatVersion',
        message: expect.stringContaining(
          'import format version 2, newer than the 1 this validator reads',
        ),
      }),
    ]);
  });

  it.each([0, 1.5, '1', null])(
    'refuses %j as a format version',
    async (formatVersion) => {
      const result = await validateImport(
        bundleOf({ ...exampleDocument(), formatVersion }),
        config,
      );
      expect(result.issues.map((i) => i.code)).toEqual([
        'invalid-format-version',
      ]);
    },
  );

  it('gives schema errors their JSON pointer and still checks the other modules', async () => {
    const document = exampleDocument();
    document['modules'][1].blocks[0].id = 'Not An Id';
    document['modules'][2].meta.type = 'brochure';
    const result = await validateImport(bundleOf(document), config);
    expect(errors(result)).toEqual([
      expect.objectContaining({
        item: 'tank-filling',
        code: 'invalid-schema',
        pointer: '/modules/1/blocks/0/id',
      }),
      expect.objectContaining({
        item: 'pressure-limits',
        code: 'unknown-module-type',
      }),
    ]);
    expect(result.items[1]).toMatchObject({ lang: 'de', passthrough: 0 });
    expect(result.items[1] && 'module' in result.items[1]).toBe(false);
  });

  it('refuses an unknown member of a manual at its own pointer', async () => {
    const document = exampleDocument();
    document['manuals'][0].entries[0].chapter = 1;
    const result = await validateImport(bundleOf(document), config);
    expect(errors(result)).toEqual([
      expect.objectContaining({
        item: 'pump-guide',
        code: 'invalid-schema',
        pointer: '/manuals/0/entries/0/chapter',
      }),
    ]);
  });

  it('does not call references to a module that did not parse dangling', async () => {
    const document = exampleDocument();
    document['modules'][2].meta.title = '';
    const result = await validateImport(bundleOf(document), config);
    expect(new Set(errors(result).map((i) => i.code))).toEqual(
      new Set(['invalid-schema']),
    );
  });

  it('names a module that did not parse by its index when it has no ID', async () => {
    const document = exampleDocument();
    document['modules'].push(42);
    const result = await validateImport(bundleOf(document), config);
    expect(result.items[3]).toMatchObject({
      kind: 'module',
      id: '#3',
      pointer: '/modules/3',
    });
  });

  it('checks the frame: source, report and unknown members', async () => {
    const document = exampleDocument();
    document['source'].vendor = 'x';
    document['report'][0].message = '';
    document['extra'] = true;
    const result = await validateImport(bundleOf(document), config);
    expect(
      result.issues.map(({ code, pointer }) => ({ code, pointer })),
    ).toEqual(
      expect.arrayContaining([
        { code: 'invalid-schema', pointer: '/report/0/message' },
        { code: 'invalid-schema', pointer: '/extra' },
        { code: 'invalid-schema', pointer: '/source/vendor' },
      ]),
    );
    // The modules are checked all the same.
    expect(result.counts.modules).toBe(3);
  });

  it('warns about fields the format does not have instead of dropping them silently', async () => {
    const document = exampleDocument();
    document['modules'][0].meta.audiance = 'service';
    document['modules'][0].blocks[0].content[0].colour = 'red';
    const result = await validateImport(bundleOf(document), config);
    expect(withCode(result, 'unknown-field').map((i) => i.pointer)).toEqual([
      '/modules/0/meta/audiance',
      '/modules/0/blocks/0/content/0/colour',
    ]);
    expect(result.valid).toBe(true);
  });

  it('reports the same module in the same language twice, and a manual twice', async () => {
    const document = exampleDocument();
    document['modules'].push(document['modules'][2]);
    document['manuals'].push(document['manuals'][0]);
    const result = await validateImport(bundleOf(document), config);
    expect(
      errors(result).map(({ code, pointer }) => ({ code, pointer })),
    ).toEqual([
      { code: 'duplicate-module', pointer: '/modules/3' },
      { code: 'duplicate-manual', pointer: '/manuals/1' },
    ]);
  });

  it('ignores, with a warning, files outside the format and unused files', async () => {
    const bundle = exampleBundle();
    bundle.files.set('assets/', new Uint8Array());
    bundle.files.set('readme.txt', new Uint8Array([1]));
    bundle.files.set('assets/logo.png', new Uint8Array([2]));
    const unused = new TextEncoder().encode('unused');
    const ref = await assetRefOf(unused);
    bundle.files.set(`assets/${ref.slice('sha256:'.length)}`, unused);
    const result = await validateImport(bundle, config);
    expect(result.valid).toBe(true);
    expect(result.issues.map((i) => [i.code, i.message])).toEqual([
      [
        'unexpected-file',
        expect.stringContaining('"readme.txt" is neither import.json'),
      ],
      [
        'invalid-asset-name',
        expect.stringContaining(
          '"assets/logo.png" is not named by its SHA-256',
        ),
      ],
    ]);
    expect(withCode(result, 'unused-asset')).toEqual([
      expect.objectContaining({ item: ref, severity: 'warning' }),
    ]);
  });

  it('quotes and cuts a hostile file name', async () => {
    const bundle = exampleBundle();
    bundle.files.set(`x\n${'y'.repeat(500)}`, new Uint8Array());
    const [issue] = (await validateImport(bundle, config)).issues;
    expect(issue?.message).not.toContain('\n');
    expect(issue?.message.length).toBeLessThan(300);
  });

  it('refuses a bundle without import.json, or with one that is not a JSON object', async () => {
    const codes = async (files: Map<string, Uint8Array>) =>
      (await validateImport({ files }, config)).issues.map((i) => i.code);
    const json = (text: string) =>
      new Map([['import.json', new TextEncoder().encode(text)]]);
    expect(await codes(new Map())).toEqual(['missing-import-document']);
    expect(await codes(json('{"formatVersion": 1,'))).toEqual(['invalid-json']);
    expect(
      await codes(
        new Map([['import.json', new Uint8Array([0x7b, 0xff, 0x7d])]]),
      ),
    ).toEqual(['invalid-json']);
    expect(await codes(json('[]'))).toEqual(['invalid-schema']);
  });

  it('reads import.json with a byte order mark', async () => {
    const text = new TextEncoder().encode(JSON.stringify(exampleDocument()));
    const bundle = exampleBundle();
    bundle.files.set(
      'import.json',
      new Uint8Array([0xef, 0xbb, 0xbf, ...text]),
    );
    expect((await validateImport(bundle, config)).valid).toBe(true);
  });

  it('refuses a document nested deeper than the limit, without recursing', async () => {
    const deep = '['.repeat(200_000) + ']'.repeat(200_000);
    const bundle = bundleOf({});
    bundle.files.set('import.json', new TextEncoder().encode(deep));
    const result = await validateImport(bundle, config);
    expect(result.issues.map((i) => i.code)).toEqual([
      expect.stringMatching(/^(too-deep|invalid-json)$/),
    ]);
    const shallow = await validateImport(exampleBundle(), config, {
      maxDepth: 5,
    });
    expect(shallow.issues.map((i) => i.code)).toEqual(['too-deep']);
  });

  it('reports, without throwing, on inputs with very many issues', async () => {
    const many = Array.from({ length: 150_000 }, () => ({}));
    const result = await validateImport(
      bundleOf({ formatVersion: 1, modules: many }),
      config,
      { maxItems: 200_000 },
    );
    expect(result.valid).toBe(false);
    expect(result.counts.modules).toBe(150_000);
  });

  it('looks up at most maxLookups distinct IDs, and says so once', async () => {
    const document = exampleDocument();
    const blocks = document['modules'][0].blocks;
    for (let i = 0; i < 20; i++)
      blocks.push({
        type: 'moduleRef',
        id: `ref-${i}`,
        module: `elsewhere-${i}`,
      });
    let calls = 0;
    const result = await validateImport(bundleOf(document), config, {
      maxLookups: 5,
      existing: { modules: { has: () => (calls++, true) } },
    });
    // Five references, plus the bundle's own two module IDs, looked up for clashes.
    expect(calls).toBe(7);
    expect(withCode(result, 'too-many-references')).toHaveLength(1);
    expect(withCode(result, 'dangling-module-reference')).toEqual([]);
  });

  it('does not count its own IDs against maxLookups, nor invent clashes past it', async () => {
    const document = exampleDocument();
    const template = document['modules'][2];
    for (let i = 0; i < 10; i++)
      document['modules'].push({ ...template, id: `extra-${i}` });
    const result = await validateImport(bundleOf(document), config, {
      maxLookups: 2,
      existing: { modules: new Set<string>() },
    });
    expect(withCode(result, 'too-many-references')).toEqual([]);
    expect(withCode(result, 'id-clash')).toEqual([]);
  });

  it('reports, without throwing, a condition with very many unknown values', async () => {
    const values = Array.from({ length: 20_000 }, (_, i) => `v${i}`);
    const document = exampleDocument();
    document['modules'][0].blocks.push({
      type: 'variant',
      id: 'many',
      when: { op: 'in', attr: 'model', values },
      blocks: [
        {
          type: 'paragraph',
          id: 'many-text',
          content: [{ type: 'text', text: 'x' }],
        },
      ],
    });
    document['manuals'][0].entries[0].when = {
      op: 'in',
      attr: 'model',
      values,
    };
    const result = await validateImport(bundleOf(document), config);
    // 100 kept per module and manual, the rest counted in one more each.
    const found = withCode(result, 'unknown-variant-value');
    expect(found).toHaveLength(202);
    expect(found.at(-1)?.message).toBe('and 19900 more like these');
  });

  it('points many manual issues at their entries in linear time', async () => {
    const document = exampleDocument();
    const when = { op: 'in', attr: 'colour', values: ['red'] };
    document['manuals'][0].entries = Array.from({ length: 5_000 }, () => ({
      module: 'pressure-limits',
      when,
    }));
    const started = Date.now();
    const result = await validateImport(bundleOf(document), config);
    expect(withCode(result, 'unknown-variant-attribute')).toHaveLength(101);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('escapes and cuts text from the bundle that it echoes', async () => {
    const document = exampleDocument();
    document['modules'][0].id = `ok‮${'x'.repeat(500)}`;
    const result = await validateImport(bundleOf(document), config);
    const id = result.items[0]?.id ?? '';
    expect(id).not.toContain('‮');
    expect(id).toContain('\\u202e');
    expect(id.length).toBeLessThan(220);
  });

  it('parses the deepest document the limit lets through without running out of stack', async () => {
    const document = exampleDocument();
    let when: unknown = { op: 'in', attr: 'model', values: ['l-200'] };
    // Each `not` is one level; the module, its blocks and the variant block take the rest.
    for (let i = 0; i < 120; i++) when = { op: 'not', of: when };
    document['modules'][0].blocks.push({
      type: 'variant',
      id: 'deep',
      when,
      blocks: [
        {
          type: 'paragraph',
          id: 'deep-text',
          content: [{ type: 'text', text: 'x' }],
        },
      ],
    });
    const result = await validateImport(bundleOf(document), config, {
      maxDepth: 256,
    });
    expect(errors(result)).toEqual([]);
  });

  it('keeps the default depth limit for a limit that is not a whole number', async () => {
    for (const maxDepth of [Number.NaN, Infinity, -1]) {
      const result = await validateImport(exampleBundle(), config, {
        maxDepth,
      });
      expect(result.valid).toBe(true);
    }
  });

  it('round-trips every valid module through the format', async () => {
    await fc.assert(
      fc.asyncProperty(moduleArb, async (module) => {
        const document = {
          formatVersion: 1,
          modules: [JSON.parse(JSON.stringify(module))],
        };
        const result = await validateImport(
          bundleOf(document, new Map()),
          config,
          {
            existing: {
              modules: { has: () => true },
              assets: { has: () => true },
            },
          },
        );
        const [item] = result.items;
        expect(
          allIssues(result).filter((i) =>
            ['invalid-schema', 'unknown-field'].includes(i.code),
          ),
        ).toEqual([]);
        expect(item?.kind === 'module' && item.module).toEqual(module);
        expect(Module.parse(item?.kind === 'module' && item.module)).toEqual(
          module,
        );
      }),
      { numRuns: 200 },
    );
  });
});
