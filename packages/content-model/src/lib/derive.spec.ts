import { sampleConfig } from '../fixtures/config.js';
import { ProjectConfig } from './config.js';
import { printConfig } from './config-yaml.js';
import {
  deriveManifest,
  gatheredTypes,
  isDerived,
  safetyTypes,
  sourceModuleIds,
} from './derive.js';
import { Manifest, StoredManifest } from './manifest.js';
import {
  ManifestParseError,
  parseManifest,
  printManifest,
} from './manifest-yaml.js';
import { Module } from './module.js';
import { resolveManual } from './resolve.js';
import { validateManifest } from './validate.js';
import {
  manifestNamesModule,
  renameManifestModule,
} from './module-references.js';

const config = ProjectConfig.parse(sampleConfig);

const source = parseManifest(
  `schemaVersion: 1
title: Operating manual
variants:
  - model: l-200
  - model: l-400
attributes:
  product-name: L-200
  rated-load: 400 kg
entries:
  - module: general-safety
  - title: Operation
    when: model in (l-400)
    entries:
      - module: driving
      - module: pressure-hazards
      - module: general-safety
  - module: battery-hazards
    when: model in (l-200)
  - title: Service
    entries:
      - module: battery-hazards
        when: model in (l-400)
      - module: service-hazards
`,
  { id: 'operating-manual' },
);

const types: Record<string, string> = {
  'general-safety': 'safety',
  driving: 'procedure',
  'pressure-hazards': 'safety',
  'battery-hazards': 'safety',
  'service-hazards': 'safety',
  'leaflet-intro': 'concept',
  contacts: 'reference',
};
const moduleType = (id: string) => types[id];

const leafletYaml = `schemaVersion: 1
kind: derived
title: Safety leaflet
design: leaflet
variants:
  - model: l-200
  - model: l-400
attributes:
  product-name: L-200 safety
rule:
  source: operating-manual
  exclude:
    - service-hazards
  front:
    - leaflet-intro
  back:
    - contacts
`;
const leaflet = parseManifest(leafletYaml, { id: 'safety-leaflet' });

const derive = (manifest: Manifest = leaflet, from = source) =>
  deriveManifest({ manifest, source: from, config, moduleType });

describe('derived manuals: the manifest', () => {
  it('reads a derived manual with its rule and no entries, and prints it back exactly', () => {
    expect(leaflet.kind).toBe('derived');
    expect(isDerived(leaflet)).toBe(true);
    expect(isDerived(source)).toBe(false);
    expect(leaflet.rule).toEqual({
      source: 'operating-manual',
      exclude: ['service-hazards'],
      front: ['leaflet-intro'],
      back: ['contacts'],
    });
    expect(leaflet.entries).toEqual([]);
    expect(printManifest(leaflet)).toBe(leafletYaml);
  });

  it('never prints the gathered entries of a derived manual', () => {
    const { manifest } = derive();
    expect(manifest.entries.length).toBeGreaterThan(0);
    expect(printManifest(manifest)).toBe(leafletYaml);
  });

  it('refuses a derived manual file with entries, without a rule, and a rule on an assembled one', () => {
    expect(() =>
      parseManifest(`${leafletYaml}entries:\n  - module: a\n`, { id: 'x' }),
    ).toThrow(/a derived manual has none/);
    expect(() =>
      parseManifest(
        'schemaVersion: 1\nkind: derived\ntitle: T\nvariants: [{}]\n',
        { id: 'x' },
      ),
    ).toThrow(/rule: a derived manual needs its rule/);
    expect(() =>
      parseManifest(
        'schemaVersion: 1\ntitle: T\nvariants: [{}]\nrule: { source: a }\nentries:\n  - module: a\n',
        { id: 'x' },
      ),
    ).toThrow(/kind: a manual with a rule is a derived one/);
    expect(() =>
      parseManifest('schemaVersion: 1\ntitle: T\nvariants: [{}]\n', {
        id: 'x',
      }),
    ).toThrow(ManifestParseError);
    expect(() =>
      parseManifest(
        'schemaVersion: 1\nkind: derived\ntitle: T\nvariants: [{}]\nrule: { source: a, front: [b, b] }\n',
        { id: 'x' },
      ),
    ).toThrow(/a module listed twice/);
  });

  it('holds a stored assembled manifest to at least one entry, a working copy not', () => {
    const draft = { ...source, entries: [] };
    expect(Manifest.safeParse(draft).success).toBe(true);
    expect(StoredManifest.safeParse(draft).success).toBe(false);
    expect(StoredManifest.safeParse(leaflet).success).toBe(true);
  });

  it('reports a rule type the configuration does not have, and checks no gathered condition', () => {
    const manifest: Manifest = {
      ...leaflet,
      rule: { ...leaflet.rule!, moduleTypes: ['safety', 'warning-labels'] },
    };
    expect(
      validateManifest(manifest, config).map((i) => [i.code, i.at]),
    ).toEqual([['unknown-module-type', 'rule.moduleTypes']]);
  });

  it('names and renames modules in its rule, not in its gathered entries', () => {
    const { manifest } = derive();
    expect(manifestNamesModule(manifest, 'contacts')).toBe(true);
    expect(manifestNamesModule(manifest, 'service-hazards')).toBe(true);
    expect(manifestNamesModule(manifest, 'pressure-hazards')).toBe(false);
    expect(renameManifestModule(manifest, 'pressure-hazards', 'x')).toBe(
      manifest,
    );
    expect(
      renameManifestModule(manifest, 'contacts', 'contact-details').rule,
    ).toEqual({ ...leaflet.rule, back: ['contact-details'] });
  });
});

describe('derived manuals: the configuration', () => {
  it('marks safety types, false by default, and prints only a true one', () => {
    expect(safetyTypes(config)).toEqual(['safety']);
    expect(gatheredTypes({}, config)).toEqual(['safety']);
    expect(gatheredTypes({ moduleTypes: ['reference'] }, config)).toEqual([
      'reference',
    ]);
    expect(config.moduleTypes.map((t) => t.safety)).toEqual([
      undefined,
      undefined,
      undefined,
      true,
    ]);
    expect(printConfig(config)).toContain(
      '    restricted: true\n    safety: true\n',
    );
    expect(
      printConfig({
        ...config,
        moduleTypes: [
          {
            id: 'x',
            label: 'X',
            restricted: false,
            snippet: false,
            safety: false,
          },
        ],
      }),
    ).not.toMatch(/^ +safety:/m);
  });
});

describe('deriveManifest', () => {
  it('gathers the safety modules in the source order, each once, between its front and back matter', () => {
    const { manifest, gathered, issues } = derive();
    expect(manifest.entries).toEqual([
      { module: 'leaflet-intro' },
      { module: 'general-safety' },
      {
        module: 'pressure-hazards',
        when: { op: 'in', attr: 'model', values: ['l-400'] },
      },
      {
        module: 'battery-hazards',
        when: {
          op: 'any',
          of: [
            { op: 'in', attr: 'model', values: ['l-200'] },
            { op: 'in', attr: 'model', values: ['l-400'] },
          ],
        },
      },
      { module: 'contacts' },
    ]);
    expect(gathered.map((g) => [g.module, g.type])).toEqual([
      ['general-safety', 'safety'],
      ['pressure-hazards', 'safety'],
      ['battery-hazards', 'safety'],
    ]);
    // The excluded safety module is a warning.
    expect(issues.map((i) => [i.severity, i.code, i.at])).toEqual([
      ['warning', 'safety-module-excluded', 'service-hazards'],
    ]);
    expect(sourceModuleIds(source)).toEqual([
      'general-safety',
      'driving',
      'pressure-hazards',
      'battery-hazards',
      'service-hazards',
    ]);
  });

  it("keeps a module unconditional when the source includes it once without a condition, and combines a group's condition with an entry's", () => {
    const nested = parseManifest(
      `schemaVersion: 1
title: Nested
variants: [{ model: l-200 }]
entries:
  - title: A
    when: model in (l-400)
    entries:
      - module: pressure-hazards
        when: model in (l-200)
  - module: general-safety
    when: model in (l-400)
  - module: general-safety
`,
      { id: 'nested' },
    );
    const { manifest } = derive(
      { ...leaflet, rule: { ...leaflet.rule!, exclude: [] } },
      nested,
    );
    expect(manifest.entries).toEqual([
      { module: 'leaflet-intro' },
      {
        module: 'pressure-hazards',
        when: {
          op: 'all',
          of: [
            { op: 'in', attr: 'model', values: ['l-400'] },
            { op: 'in', attr: 'model', values: ['l-200'] },
          ],
        },
      },
      { module: 'general-safety' },
      { module: 'contacts' },
    ]);
  });

  it('takes the source text attributes, its own winning', () => {
    expect(derive().manifest.attributes).toEqual({
      'product-name': 'L-200 safety',
    });
    expect(derive().attributes).toEqual({
      'product-name': 'L-200 safety',
      'rated-load': '400 kg',
    });
  });

  it('gathers the rule types in place of the safety types, and warns about each safety module left out', () => {
    const { manifest, issues } = derive({
      ...leaflet,
      rule: { ...leaflet.rule!, moduleTypes: ['procedure'], exclude: [] },
    });
    expect(
      manifest.entries.map((e) => (e as { module: string }).module),
    ).toEqual(['leaflet-intro', 'driving', 'contacts']);
    expect(issues.map((i) => i.at)).toEqual([
      'general-safety',
      'pressure-hazards',
      'battery-hazards',
      'service-hazards',
    ]);
  });

  it('includes a front or back module once, even one of the source', () => {
    const { manifest, issues } = derive({
      ...leaflet,
      rule: {
        ...leaflet.rule!,
        exclude: [],
        front: ['general-safety'],
        back: ['general-safety', 'contacts'],
      },
    });
    expect(
      manifest.entries.map((e) => (e as { module: string }).module),
    ).toEqual([
      'general-safety',
      'pressure-hazards',
      'battery-hazards',
      'service-hazards',
      'contacts',
    ]);
    expect(issues).toEqual([]);
  });

  it('skips a module of the source that cannot be read', () => {
    const { gathered } = deriveManifest({
      manifest: leaflet,
      source,
      config,
      moduleType: (id) => (id === 'general-safety' ? undefined : types[id]),
    });
    expect(gathered.map((g) => g.module)).toEqual([
      'pressure-hazards',
      'battery-hazards',
    ]);
  });

  it('reports a missing or unreadable source, keeping the front and back matter', () => {
    for (const from of [undefined, 'unreadable'] as const) {
      const { manifest, issues } = deriveManifest({
        manifest: leaflet,
        source: from,
        config,
        moduleType,
      });
      expect(manifest.entries).toEqual([
        { module: 'leaflet-intro' },
        { module: 'contacts' },
      ]);
      expect(manifest.attributes).toEqual({ 'product-name': 'L-200 safety' });
      expect(
        deriveManifest({ manifest: leaflet, source: from, config, moduleType })
          .attributes,
      ).toEqual({ 'product-name': 'L-200 safety' });
      expect(issues.map((i) => [i.severity, i.code])).toEqual([
        ['error', 'unknown-source-manual'],
      ]);
    }
  });

  it('refuses a derived source and itself as the source', () => {
    expect(derive(leaflet, leaflet).issues.map((i) => i.code)).toEqual([
      'derived-source',
    ]);
    const other = { ...leaflet, id: 'other-leaflet' };
    const result = derive(leaflet, other);
    expect(result.issues.map((i) => i.code)).toEqual(['derived-source']);
    expect(result.gathered).toEqual([]);
  });

  it('gathers nothing for a wider audience than its source’s, not even its text attributes', () => {
    const derived = (audience: string | undefined, of: string | undefined) =>
      derive(
        { ...leaflet, ...(audience && { audience }) },
        { ...source, ...(of ? { audience: of } : { audience: undefined }) },
      );
    const wide = (audience: string | undefined, of: string | undefined) =>
      derived(audience, of)
        .issues.filter((i) => i.code === 'derived-audience-wider')
        .map((i) => i.severity);
    expect(wide('public', 'service')).toEqual(['error']);
    const nothing = derived('public', 'service');
    expect(nothing.gathered).toEqual([]);
    expect(nothing.attributes).toEqual(leaflet.attributes);
    expect(
      nothing.manifest.entries.map((e) => 'module' in e && e.module),
    ).toEqual(['leaflet-intro', 'contacts']);
    // No audience: the most restricted level.
    expect(wide('customer', undefined)).toEqual(['error']);
    expect(wide('service', 'service')).toEqual([]);
    expect(wide('internal', 'public')).toEqual([]);
    expect(wide(undefined, undefined)).toEqual([]);
    // No audience is the last level's readers; an audience the configuration lacks is past it.
    expect(wide('internal', undefined)).toEqual([]);
    expect(wide(undefined, 'internal')).toEqual([]);
    expect(wide(undefined, 'retired-level')).toEqual(['error']);
    expect(wide('internal', 'retired-level')).toEqual(['error']);
  });

  it('reports no types to gather, nothing gathered and an excluded module the source does not have', () => {
    const none = ProjectConfig.parse({
      ...sampleConfig,
      moduleTypes: sampleConfig.moduleTypes.map((t) => ({
        ...t,
        safety: false,
      })),
    });
    expect(
      deriveManifest({
        manifest: leaflet,
        source,
        config: none,
        moduleType,
      }).issues.map((i) => i.code),
    ).toEqual(['no-gathered-types']);
    const { issues } = derive({
      ...leaflet,
      rule: {
        ...leaflet.rule!,
        moduleTypes: ['reference'],
        exclude: ['no-such-module'],
      },
    });
    expect(issues.map((i) => [i.code, i.at])).toEqual([
      ['safety-module-excluded', 'general-safety'],
      ['safety-module-excluded', 'pressure-hazards'],
      ['safety-module-excluded', 'battery-hazards'],
      ['safety-module-excluded', 'service-hazards'],
      ['unknown-excluded-module', 'no-such-module'],
      ['empty-derived-manual', undefined],
    ]);
  });

  it('gives an assembled manifest back as it is', () => {
    expect(derive(source).manifest).toBe(source);
  });

  it('resolves for each variant as any manual: a module excluded by the variant is left out', () => {
    const { manifest, attributes } = derive();
    const module = (id: string, type: string) =>
      Module.parse({
        schemaVersion: 1,
        id,
        meta: { title: id, type, lang: 'en' },
        blocks: [
          {
            type: 'paragraph',
            id: 'p',
            content: [{ type: 'text', text: `${id} {product-name}` }],
          },
        ],
      });
    const modules = new Map(
      Object.entries(types).map(([id, type]) => [id, module(id, type)]),
    );
    const titles = (model: string) =>
      resolveManual({
        manifest: { ...manifest, attributes },
        variant: { model },
        lang: 'en',
        config,
        loadModule: (id) => modules.get(id),
      }).manual.entries.map((e) => (e.kind === 'module' ? e.module : e.title));
    expect(titles('l-200')).toEqual([
      'leaflet-intro',
      'general-safety',
      'battery-hazards',
      'contacts',
    ]);
    expect(titles('l-400')).toEqual([
      'leaflet-intro',
      'general-safety',
      'pressure-hazards',
      'battery-hazards',
      'contacts',
    ]);
  });
});
