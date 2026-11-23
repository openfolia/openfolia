import { describe, expect, it } from 'vitest';
import { parseConfig, printConfig } from './config-yaml.js';
import {
  DEFAULT_DITA_MAPPING,
  DitaMapping,
  ditaMappingIssues,
} from './dita.js';

const yaml = `languages:
  source: en
  targets: [de]
moduleTypes:
  - id: concept
    label: Concept
  - id: procedure
    label: Procedure
audiences:
  - id: operator
    label: Operator
variantAttributes:
  - id: model
    label: Model
    kind: enum
    values:
      - id: basic
        label: Basic
  - id: software
    label: Software
    kind: version
textAttributes:
  - id: product-name
    label: Product name
safetySymbols:
  - id: w017
    label: Hot surface
`;

describe('the DITA mapping', () => {
  it('defaults every map, and DITAVAL files no map names are not applied', () => {
    expect(DEFAULT_DITA_MAPPING).toEqual({
      moduleTypes: {},
      outputclasses: {},
      profiling: {},
      textKeys: {},
      hazardSymbols: {},
      ditavalDefault: 'none',
    });
    expect(parseConfig(yaml).dita).toBeUndefined();
  });

  it('reads `dita` in openfolia.yaml, and prints it back the same', () => {
    const config = parseConfig(`${yaml}dita:
  moduleTypes:
    task: procedure
  outputclasses:
    howto: procedure
  defaultModuleType: concept
  profiling:
    product:
      variantAttribute: model
      values:
        basic-model: basic
    audience:
      audience:
        user: operator
  textKeys:
    prodname: product-name
  hazardSymbols:
    hot.svg: w017
  ditavalDefault: all
`);
    expect(config.dita).toEqual({
      moduleTypes: { task: 'procedure' },
      outputclasses: { howto: 'procedure' },
      defaultModuleType: 'concept',
      profiling: {
        product: {
          variantAttribute: 'model',
          values: { 'basic-model': 'basic' },
        },
        audience: { audience: { user: 'operator' } },
      },
      textKeys: { prodname: 'product-name' },
      hazardSymbols: { 'hot.svg': 'w017' },
      ditavalDefault: 'all',
    });
    expect(parseConfig(printConfig(config)).dita).toEqual(config.dita);
    expect(ditaMappingIssues(config.dita as DitaMapping, config)).toEqual([]);
  });

  it('refuses a name that is no single token', () => {
    expect(
      DitaMapping.safeParse({ moduleTypes: { 'two words': 'concept' } })
        .success,
    ).toBe(false);
    expect(DitaMapping.safeParse({ textKeys: { 'a(b)': 'x' } }).success).toBe(
      false,
    );
    expect(DitaMapping.safeParse({ ditavalDefault: 'some' }).success).toBe(
      false,
    );
  });

  it('reports each value naming nothing configured, never refusing the file', () => {
    const config = parseConfig(`${yaml}dita:
  moduleTypes:
    task: howto
  defaultModuleType: gone
  profiling:
    product:
      variantAttribute: model
      values:
        x: nope
    platform:
      variantAttribute: os
    audience:
      audience:
        admin: root
  textKeys:
    prodname: brand
  hazardSymbols:
    hot.svg: w999
`);
    expect(
      ditaMappingIssues(config.dita as DitaMapping, config).map((i) => [
        i.code,
        i.path,
      ]),
    ).toEqual([
      ['unknown-module-type', 'moduleTypes.task'],
      ['unknown-module-type', 'defaultModuleType'],
      ['unknown-variant-value', 'profiling.product.values.x'],
      ['unknown-variant-attribute', 'profiling.platform.variantAttribute'],
      ['unknown-audience', 'profiling.audience.audience.admin'],
      ['unknown-text-attribute', 'textKeys.prodname'],
      ['unknown-safety-symbol', 'hazardSymbols.hot.svg'],
    ]);
  });
});
