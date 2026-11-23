import { sampleConfig } from '../fixtures/config.js';
import { batteryDisposal, chargingProcedure } from '../fixtures/modules.js';
import type { Block } from './blocks.js';
import { ProjectConfig } from './config.js';
import { Module } from './module.js';
import { parseCondition } from './asciidoc/condition-syntax.js';
import { conditionIssues, validateModule } from './validate.js';

const config = ProjectConfig.parse(sampleConfig);
const t = (text: string) => ({ type: 'text' as const, text });

const moduleWith = (blocks: Block[], meta: Partial<Module['meta']> = {}) =>
  Module.parse({
    ...batteryDisposal,
    meta: { ...batteryDisposal.meta, ...meta },
    blocks,
  });

const codes = (module: Module) =>
  validateModule(module, config).map((i) => i.code);

describe('validateModule', () => {
  it('finds no issues in the sample modules', () => {
    expect(validateModule(Module.parse(chargingProcedure), config)).toEqual([]);
    expect(validateModule(Module.parse(batteryDisposal), config)).toEqual([]);
  });

  it('needs no configuration for keywords, whatever they say', () => {
    expect(
      codes(moduleWith([], { keywords: ['unconfigured', 'Wärme'] })),
    ).toEqual([]);
  });

  it('accepts a deprecation, and warns at one naming the module itself', () => {
    expect(
      codes(
        moduleWith([], {
          deprecated: { reason: 'Superseded.', replacedBy: 'other' },
        }),
      ),
    ).toEqual([]);
    const self = moduleWith([], {
      deprecated: { reason: 'Superseded.', replacedBy: batteryDisposal.id },
    });
    expect(validateModule(self, config)).toEqual([
      expect.objectContaining({
        code: 'unknown-replacement',
        severity: 'warning',
      }),
    ]);
  });

  it('checks metadata against the configuration', () => {
    const module = moduleWith([], {
      type: 'tutorial',
      audience: 'partners',
      lang: 'it',
      facets: { 'product-line': ['boats'], colour: ['red'] },
    });
    expect(codes(module)).toEqual([
      'unknown-module-type',
      'unknown-audience',
      'unknown-language',
      'unknown-facet-value',
      'unknown-facet',
    ]);
  });

  it('checks safety symbols and text attributes, including inside list items', () => {
    const module = moduleWith([
      {
        type: 'safety',
        id: 's',
        severity: 'danger',
        hazard: [t('Crush hazard')],
        symbols: ['w999'],
        blocks: [],
      },
      {
        type: 'list',
        id: 'l',
        ordered: false,
        items: [
          {
            id: 'l1',
            content: [{ type: 'attribute', name: 'max-speed' }],
            blocks: [],
          },
        ],
      },
    ]);
    expect(validateModule(module, config)).toEqual([
      expect.objectContaining({ code: 'unknown-safety-symbol', at: 's' }),
      expect.objectContaining({ code: 'unknown-text-attribute', at: 'l1' }),
    ]);
  });

  it('checks variant conditions against the configured attributes', () => {
    const variant = (
      when: Extract<Block, { type: 'variant' }>['when'],
    ): Block => ({
      type: 'variant',
      id: 'v',
      when,
      blocks: [{ type: 'paragraph', id: 'vp', content: [t('x')] }],
    });
    expect(
      codes(
        moduleWith([variant({ op: 'in', attr: 'colour', values: ['red'] })]),
      ),
    ).toEqual(['unknown-variant-attribute']);
    expect(
      codes(
        moduleWith([variant({ op: 'in', attr: 'model', values: ['l-900'] })]),
      ),
    ).toEqual(['unknown-variant-value']);
    expect(
      codes(
        moduleWith([
          variant({ op: 'cmp', attr: 'model', cmp: '>', value: '2' }),
        ]),
      ),
    ).toEqual(['version-compare-on-enum']);
    expect(
      codes(
        moduleWith([
          variant({ op: 'in', attr: 'software', values: ['latest'] }),
        ]),
      ),
    ).toEqual(['invalid-version-value']);
    // The version a comparison names, in the evaluator's form (#225). A
    // module's schema refuses it already; a condition parsed from text
    // (`parseCondition`) reaches validation with it.
    for (const value of ['abc', '2.x', '', '2..3', 'v2']) {
      expect(
        conditionIssues(
          { op: 'cmp', attr: 'software', cmp: '>=', value },
          config,
          'v',
        ),
      ).toEqual([
        {
          severity: 'error',
          code: 'invalid-version-value',
          message: `"${value}" is not a version (variant attribute "software")`,
          at: 'v',
        },
      ]);
    }
    expect(
      conditionIssues(
        parseCondition('!(software < abc) && model in (l-400)'),
        config,
      ),
    ).toEqual([expect.objectContaining({ code: 'invalid-version-value' })]);
    expect(
      codes(
        moduleWith([
          variant({ op: 'cmp', attr: 'software', cmp: '>=', value: '2.3.1' }),
        ]),
      ),
    ).toEqual([]);
    expect(
      codes(
        moduleWith([
          variant({
            op: 'not',
            of: {
              op: 'any',
              of: [
                { op: 'in', attr: 'market', values: ['us'] },
                { op: 'in', attr: 'software', values: ['2.3'] },
              ],
            },
          }),
        ]),
      ),
    ).toEqual([]);
  });

  it('warns about passthrough blocks', () => {
    const issues = validateModule(
      moduleWith([
        { type: 'passthrough', id: 'raw', format: 'xml', raw: '<x/>' },
      ]),
      config,
    );
    expect(issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'passthrough',
        at: 'raw',
      }),
    ]);
  });
});

describe('review regressions', () => {
  const t = (text: string) => ({ type: 'text' as const, text });
  const cfg = ProjectConfig.parse(sampleConfig);
  const para = (id: string) => ({
    type: 'paragraph' as const,
    id,
    content: [t('x')],
  });

  it('treats language tags case-insensitively', () => {
    const module = Module.parse({
      ...batteryDisposal,
      meta: { ...batteryDisposal.meta, lang: 'pt-br' },
    });
    expect(module.meta.lang).toBe('pt-BR');
    expect(validateModule(module, cfg)).toEqual([]);
  });

  it('accepts an explicit span of 1', () => {
    const table = {
      type: 'table',
      id: 'tbl',
      columns: [{ width: 1 }],
      header: false,
      rows: [{ cells: [{ colspan: 1, rowspan: 1, blocks: [para('a')] }] }],
    };
    expect(
      Module.safeParse({ ...batteryDisposal, blocks: [table] }).error,
    ).toBeUndefined();
  });

  it('rejects duplicate facet values and duplicate target languages', () => {
    const meta = {
      ...batteryDisposal.meta,
      facets: { 'product-line': ['lifters', 'lifters'] },
    };
    expect(Module.safeParse({ ...batteryDisposal, meta }).success).toBe(false);
    const languages = { source: 'en', targets: ['de', 'DE'] };
    expect(
      ProjectConfig.safeParse({ ...sampleConfig, languages }).success,
    ).toBe(false);
  });
});
