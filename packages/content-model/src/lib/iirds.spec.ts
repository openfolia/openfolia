import { ProjectConfig, StrictProjectConfig } from './config.js';
import { parseConfig, printConfig } from './config-yaml.js';
import {
  iirdsMappingIssues,
  isIirdsBaseIri,
  moduleTypeMapping,
} from './iirds.js';

const base = {
  languages: { source: 'en', targets: [] },
  moduleTypes: [
    { id: 'task', label: 'Task' },
    { id: 'safety', label: 'Safety' },
    { id: 'concept', label: 'Concept' },
  ],
  audiences: [
    { id: 'operator', label: 'Operator' },
    { id: 'technician', label: 'Technician' },
  ],
  facets: [
    {
      id: 'line',
      label: 'Product line',
      values: [{ id: 'alpha', label: 'Alpha' }],
    },
    {
      id: 'phase',
      label: 'Phase',
      values: [
        { id: 'use', label: 'Use' },
        { id: 'care', label: 'Care' },
      ],
    },
  ],
  variantAttributes: [
    {
      id: 'model',
      label: 'Model',
      kind: 'enum',
      values: [{ id: 'small', label: 'Small' }],
    },
    { id: 'software', label: 'Software', kind: 'version' },
  ],
};

const mapping = {
  baseIri: 'https://docs.example.com/iirds/',
  documentTypes: ['OperatingInstructions'],
  manualDocumentTypes: {
    service: ['MaintenanceInstructions', 'RepairInstructions'],
  },
  moduleTypes: {
    task: 'GenericTask',
    safety: { topicType: 'GenericConcept', subjects: ['SafetyInstruction'] },
  },
  audiences: { operator: 'Role', technician: 'SkillLevel' },
  facets: { line: 'ProductVariant' },
  variantAttributes: { model: 'ProductVariant', software: 'ProductProperty' },
  lifecyclePhases: { facet: 'phase', values: { use: 'Operation' } },
};

describe('the iiRDS mapping in the configuration', () => {
  it('is optional, and taken with the standard’s names', () => {
    expect(ProjectConfig.parse(base).iirds).toBeUndefined();
    const config = ProjectConfig.parse({ ...base, iirds: mapping });
    const iirds = config.iirds;
    if (!iirds) throw new Error('no mapping');
    expect(iirds.moduleTypes['task']).toBe('GenericTask');
    expect(moduleTypeMapping(iirds, 'safety')).toEqual({
      topicType: 'GenericConcept',
      subjects: ['SafetyInstruction'],
    });
    expect(moduleTypeMapping(iirds, 'task')).toEqual({
      topicType: 'GenericTask',
      subjects: [],
    });
    expect(moduleTypeMapping(iirds, 'concept')).toBeUndefined();
    expect(moduleTypeMapping(iirds, 'constructor')).toBeUndefined();
    expect(StrictProjectConfig.parse({ ...base, iirds: mapping })).toEqual(
      config,
    );
  });

  it('refuses a name the standard does not have, a bad base IRI and a document without a type', () => {
    const refused = (iirds: unknown) =>
      ProjectConfig.safeParse({ ...base, iirds }).success;
    expect(refused({ ...mapping, moduleTypes: { task: 'Task' } })).toBe(false);
    expect(
      refused({ ...mapping, audiences: { operator: 'Qualification' } }),
    ).toBe(false);
    expect(refused({ ...mapping, facets: { line: 'Product' } })).toBe(false);
    expect(refused({ ...mapping, documentTypes: [] })).toBe(false);
    expect(
      refused({ ...mapping, documentTypes: ['QuickGuide', 'QuickGuide'] }),
    ).toBe(false);
    expect(refused({ ...mapping, baseIri: 'ftp://example.com/' })).toBe(false);
    expect(refused({ ...mapping, moduleTypes: { task: {} } })).toBe(false);
    expect(
      refused({
        ...mapping,
        facets: { phase: 'Component' },
      }),
    ).toBe(false);
    // Unknown members: dropped when reading, refused when stored.
    expect(
      StrictProjectConfig.safeParse({
        ...base,
        iirds: { ...mapping, extra: 1 },
      }).success,
    ).toBe(false);
  });

  it('takes only an absolute http(s) base IRI ending in "/", as the URL parser writes it', () => {
    expect(isIirdsBaseIri('https://docs.example.com/iirds/')).toBe(true);
    expect(isIirdsBaseIri('http://example.com/')).toBe(true);
    for (const bad of [
      'https://docs.example.com/iirds',
      'https://docs.example.com/a?b/',
      'https://docs.example.com/a#/',
      'https://user@docs.example.com/',
      'https://docs.example.com/a b/',
      'https://docs.example.com/"x"/',
      'https://docs.example.com/<x>/',
      'https://docs.example.com/a/../',
      'HTTPS://docs.example.com/',
      'https://docs.example.com:443/',
      'urn:example:',
      '/relative/',
      `https://example.com/${'a'.repeat(200)}/`,
    ]) {
      expect(isIirdsBaseIri(bad), bad).toBe(false);
    }
  });

  it('round-trips through openfolia.yaml canonically', () => {
    const text = printConfig(ProjectConfig.parse({ ...base, iirds: mapping }));
    expect(text).toContain(
      'iirds:\n  baseIri: https://docs.example.com/iirds/',
    );
    expect(printConfig(parseConfig(text))).toBe(text);
    expect(parseConfig(text).iirds).toEqual(
      ProjectConfig.parse({ ...base, iirds: mapping }).iirds,
    );
    const minimal = printConfig(
      ProjectConfig.parse({
        ...base,
        iirds: {
          baseIri: 'https://docs.example.com/',
          documentTypes: ['QuickGuide'],
        },
      }),
    );
    expect(minimal).toContain(
      'iirds:\n  baseIri: https://docs.example.com/\n  documentTypes:\n    - QuickGuide\n',
    );
    expect(printConfig(parseConfig(minimal))).toBe(minimal);
  });

  it('reports what it leaves out and keys naming nothing, never refusing them', () => {
    const config = ProjectConfig.parse({
      ...base,
      iirds: {
        ...mapping,
        moduleTypes: { ...mapping.moduleTypes, gone: 'GenericReference' },
        lifecyclePhases: {
          facet: 'phase',
          values: { use: 'Operation', old: 'Repair' },
        },
      },
    });
    expect(
      iirdsMappingIssues(config).map((i) => `${i.code} ${i.path}`),
    ).toEqual([
      'unmapped-module-type moduleTypes.concept',
      'unmapped-lifecycle-phase lifecyclePhases.values.care',
      'unknown-mapping-key moduleTypes.gone',
      'unknown-mapping-key lifecyclePhases.values.old',
    ]);
    expect(iirdsMappingIssues(ProjectConfig.parse(base))).toEqual([]);
    const bare = ProjectConfig.parse({
      ...base,
      iirds: { baseIri: mapping.baseIri, documentTypes: ['QuickGuide'] },
    });
    expect(iirdsMappingIssues(bare).map((i) => i.code)).toEqual([
      'unmapped-module-type',
      'unmapped-module-type',
      'unmapped-module-type',
      'unmapped-audience',
      'unmapped-audience',
      'unmapped-facet',
      'unmapped-facet',
      'unmapped-variant-attribute',
      'unmapped-variant-attribute',
    ]);
  });
});
