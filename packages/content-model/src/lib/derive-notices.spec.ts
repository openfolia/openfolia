import { sampleConfig } from '../fixtures/config.js';
import type { Block, Safety, SafetySeverity } from './blocks.js';
import { ProjectConfig } from './config.js';
import {
  DEFAULT_NOTICE_GROUPING,
  DEFAULT_NOTICE_RULE,
  deriveManifest,
  noticeLevels,
  noticeLevelsIn,
  noticeRuleOf,
  readGatheringModules,
  referencedModuleIds,
  sourceModuleIds,
} from './derive.js';
import { Manifest, type NoticeRule } from './manifest.js';
import { parseManifest, printManifest } from './manifest-yaml.js';
import { Module } from './module.js';
import { resolveManual, type ResolvedEntry } from './resolve.js';
import { SAFETY_SEVERITIES } from './safety.js';

/**
 * #670: a derived manual gathering the safety notices of its source manual's modules, whatever
 * their type, grouped by source module or by hazard level, per variant and language.
 */
const config = ProjectConfig.parse(sampleConfig);

const source = parseManifest(
  `schemaVersion: 1
title: Operating manual
variants:
  - model: l-200
  - model: l-400
attributes:
  product-name: L-200
entries:
  - module: general-safety
  - title: Operation
    entries:
      - module: driving
      - module: general-safety
  - module: charging
    when: model in (l-200)
  - module: service
  - module: plain
  - module: secret
`,
  { id: 'operating-manual' },
);

const text = (t: string) => [{ type: 'text' as const, text: t }];
const notice = (
  id: string,
  severity: SafetySeverity,
  hazard: string,
  blocks: Block[] = [],
): Safety => ({
  type: 'safety',
  id,
  severity,
  hazard: text(hazard),
  symbols: [],
  blocks: [
    { type: 'paragraph', id: `${id}-text`, content: text(hazard) },
    ...blocks,
  ],
});
const paragraph = (id: string, t: string): Block => ({
  type: 'paragraph',
  id,
  content: text(t),
});

/** The modules, `[title, type, blocks]` per language (the German ones translate the titles and hazards). */
const contents = (de: boolean): Record<string, [string, string, Block[]]> => ({
  'general-safety': [
    de ? 'Allgemeine Sicherheit' : 'General safety',
    'safety',
    [
      {
        type: 'variant',
        id: 'large',
        when: { op: 'in', attr: 'model', values: ['l-400'] },
        blocks: [notice('crush', 'danger', de ? 'Quetschgefahr' : 'Crushing')],
      },
      notice('general', 'warning', de ? 'Allgemein' : 'General'),
    ],
  ],
  driving: [
    de ? 'Fahren' : 'Driving',
    'procedure',
    [
      paragraph('intro', 'Drive carefully.'),
      {
        type: 'procedure',
        id: 'steps',
        steps: [
          {
            id: 'step-1',
            content: text('Release the brake.'),
            blocks: [
              notice('tip-over', 'caution', de ? 'Kippen' : 'Tipping over', [
                {
                  type: 'paragraph',
                  id: 'see',
                  content: [
                    {
                      type: 'xref',
                      module: 'driving',
                      block: 'intro',
                      text: text('intro'),
                    },
                  ],
                },
              ]),
            ],
          },
        ],
      },
      { type: 'moduleRef', id: 'acid-ref', module: 'battery-snippet' },
    ],
  ],
  charging: [
    de ? 'Laden' : 'Charging',
    'procedure',
    [
      { type: 'moduleRef', id: 'acid-ref', module: 'battery-snippet' },
      notice('care', 'notice', de ? 'Ladegerät' : 'Charger'),
    ],
  ],
  'battery-snippet': [
    de ? 'Batteriesäure' : 'Battery acid',
    'reference',
    [notice('acid', 'warning', de ? 'Säure' : 'Acid')],
  ],
  service: [
    'Service',
    'procedure',
    [notice('shock', 'danger', de ? 'Stromschlag' : 'Electric shock')],
  ],
  plain: [de ? 'Schlicht' : 'Plain', 'concept', [paragraph('p', 'Nothing.')]],
  secret: [
    de ? 'Geheim' : 'Secret',
    'concept',
    [notice('hidden', 'warning', de ? 'Verborgen' : 'Hidden')],
  ],
  'leaflet-intro': [
    de ? 'Über dieses Blatt' : 'About this leaflet',
    'concept',
    [paragraph('about', 'Read this first.'), notice('own', 'notice', 'Own')],
  ],
});
const modules = new Map<string, Module>();
for (const lang of ['en', 'de']) {
  for (const [id, [title, type, blocks]] of Object.entries(
    contents(lang === 'de'),
  )) {
    modules.set(
      `${lang}/${id}`,
      Module.parse({
        schemaVersion: 1,
        id,
        meta: { title, type, lang, audience: 'public', facets: {} },
        blocks,
      }),
    );
  }
}
const loadModule = (id: string, lang: string) => modules.get(`${lang}/${id}`);
const sourceModule = (id: string) => loadModule(id, 'en');

const leafletYaml = `schemaVersion: 1
kind: derived
title: Safety notices
variants:
  - model: l-200
  - model: l-400
rule:
  source: operating-manual
  exclude:
    - service
  front:
    - leaflet-intro
  notices:
    groupBy: module
`;
const leaflet = parseManifest(leafletYaml, { id: 'safety-notices' });

const withNotices = (
  notices: NoticeRule,
  rest: Partial<Manifest['rule']> = {},
) =>
  ({
    ...leaflet,
    rule: { ...leaflet.rule!, ...rest, notices },
  }) as Manifest;

const derive = (manifest: Manifest = leaflet) =>
  deriveManifest({
    manifest,
    source,
    config,
    moduleType: (id) => sourceModule(id)?.meta.type,
    module: sourceModule,
  });

const resolve = (
  manifest: Manifest,
  model: string,
  lang = 'en',
  visible?: (m: Module) => boolean,
) => {
  const derived = derive(manifest);
  return resolveManual({
    manifest: { ...derived.manifest, attributes: derived.attributes },
    variant: { model },
    lang,
    config,
    loadModule,
    ...(visible && { visible }),
  });
};

/** Each entry as `title: block IDs`, a group as `title > …`. */
const outline = (entries: readonly ResolvedEntry[]): unknown[] =>
  entries.map((e) =>
    e.kind === 'group'
      ? { [e.title]: outline(e.entries) }
      : `${e.title}: ${e.blocks.map((b) => b.id).join(' ')}`,
  );

describe('derived manuals gathering notices: the rule (#670)', () => {
  it('reads and prints the notice gathering, and leaves a rule without it as before', () => {
    expect(leaflet.rule?.notices).toEqual({ groupBy: 'module' });
    expect(printManifest(leaflet)).toBe(leafletYaml);
    const byLevel = parseManifest(
      leafletYaml.replace(
        '    groupBy: module\n',
        '    groupBy: level\n    levels:\n      - warning\n      - danger\n',
      ),
      { id: 'x' },
    );
    expect(byLevel.rule?.notices).toEqual({
      groupBy: 'level',
      levels: ['warning', 'danger'],
    });
    expect(printManifest(byLevel)).toContain(
      '  notices:\n    groupBy: level\n    levels:\n      - warning\n      - danger\n',
    );
    // Nothing set: the default grouping, every level.
    const bare = parseManifest(
      leafletYaml.replace(
        '  notices:\n    groupBy: module\n',
        '  notices: {}\n',
      ),
      { id: 'x' },
    );
    expect(bare.rule?.notices).toEqual(DEFAULT_NOTICE_RULE);
    expect(DEFAULT_NOTICE_GROUPING).toBe('module');
    expect(noticeLevels(DEFAULT_NOTICE_RULE)).toEqual([...SAFETY_SEVERITIES]);
    expect(SAFETY_SEVERITIES).toEqual([
      'danger',
      'warning',
      'caution',
      'notice',
    ]);
    // Without it, a rule is as it was: no `notices` member, and whole modules.
    const whole = parseManifest(
      leafletYaml.replace('  notices:\n    groupBy: module\n', ''),
      { id: 'x' },
    );
    expect(whole.rule).not.toHaveProperty('notices');
    expect(noticeRuleOf(whole)).toBeUndefined();
    expect(noticeRuleOf(leaflet)).toEqual({ groupBy: 'module' });
    expect(noticeRuleOf(source)).toBeUndefined();
  });

  it('refuses an unknown grouping or level, a level twice and no levels', () => {
    for (const notices of [
      'notices: { groupBy: chapter }',
      'notices: { levels: [fatal] }',
      'notices: { levels: [danger, danger] }',
      'notices: { levels: [] }',
      'notices: { groupBy: module, extra: 1 }',
    ]) {
      expect(() =>
        parseManifest(
          leafletYaml.replace(
            '  notices:\n    groupBy: module\n',
            `  ${notices}\n`,
          ),
          { id: 'x' },
        ),
      ).toThrow();
    }
  });

  it('names the modules a module refers to and the levels of its own notices', () => {
    const driving = sourceModule('driving')!;
    expect(referencedModuleIds(driving.blocks)).toEqual(['battery-snippet']);
    expect([...noticeLevelsIn(driving.blocks)]).toEqual(['caution']);
    // Inside a variant block, whatever its condition.
    expect([...noticeLevelsIn(sourceModule('general-safety')!.blocks)]).toEqual(
      ['danger', 'warning'],
    );
  });

  it('reads the source’s modules, and for notices the ones they refer to, each once', async () => {
    const read: string[] = [];
    const found = await readGatheringModules(
      sourceModuleIds(source),
      async (id) => {
        read.push(id);
        return sourceModule(id);
      },
      { followReferences: true, atOnce: 2 },
    );
    expect(read.sort()).toEqual(
      [...sourceModuleIds(source), 'battery-snippet'].sort(),
    );
    expect(found.has('battery-snippet')).toBe(true);
    const whole = await readGatheringModules(
      sourceModuleIds(source),
      async (id) => sourceModule(id),
      { followReferences: false, atOnce: 32 },
    );
    expect(whole.has('battery-snippet')).toBe(false);
  });
});

describe('derived manuals gathering notices: what is gathered (#670)', () => {
  it('gathers each module holding a notice, itself or through a reference, once, with the source’s conditions', () => {
    const { manifest, gathered, issues } = derive();
    expect(manifest.entries).toEqual([
      { module: 'leaflet-intro' },
      { module: 'general-safety' },
      { module: 'driving' },
      {
        module: 'charging',
        when: { op: 'in', attr: 'model', values: ['l-200'] },
      },
      { module: 'secret' },
    ]);
    // Whatever their type; a module without a notice (`plain`) is not gathered.
    expect(gathered.map((g) => g.type)).toEqual([
      'safety',
      'procedure',
      'procedure',
      'concept',
    ]);
    expect(issues.map((i) => [i.severity, i.code, i.at])).toEqual([
      ['warning', 'safety-notice-excluded', 'service'],
    ]);
  });

  it('reports a notice of a level it does not gather, at the module holding it', () => {
    const { manifest, issues } = derive(
      withNotices({ groupBy: 'level', levels: ['danger', 'warning'] }),
    );
    // `driving` and `charging` still hold the snippet's warning.
    expect(manifest.entries.map((e) => 'module' in e && e.module)).toEqual([
      'leaflet-intro',
      'general-safety',
      'driving',
      'charging',
      'secret',
    ]);
    expect(issues.map((i) => [i.code, i.at])).toEqual([
      ['safety-notice-excluded', 'service'],
      ['safety-notice-excluded', 'driving'],
      ['safety-notice-excluded', 'charging'],
    ]);
  });

  it('searches only the rule’s module types when it names some, and says whose notices that leaves out', () => {
    const { manifest, issues } = derive(
      withNotices({ groupBy: 'module' }, { moduleTypes: ['safety'] }),
    );
    expect(manifest.entries.map((e) => 'module' in e && e.module)).toEqual([
      'leaflet-intro',
      'general-safety',
    ]);
    expect(issues.map((i) => [i.code, i.at]).sort()).toEqual(
      [
        ['safety-notice-excluded', 'battery-snippet'],
        ['safety-notice-excluded', 'charging'],
        ['safety-notice-excluded', 'driving'],
        ['safety-notice-excluded', 'secret'],
        ['safety-notice-excluded', 'service'],
      ].sort(),
    );
    // No module named in a message but the one it is at.
    for (const issue of issues) {
      const names = [...issue.message.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      expect(names).toEqual([issue.at]);
    }
  });

  it('says it gathers nothing when no module holds a notice it takes', () => {
    const { issues, gathered } = deriveManifest({
      manifest: leaflet,
      source,
      config,
      moduleType: (id) => sourceModule(id)?.meta.type,
      // Without the modules' content, no notice is found.
    });
    expect(gathered).toEqual([]);
    expect(issues.find((i) => i.code === 'empty-derived-manual')?.message).toBe(
      'the rule gathers no safety notice from the source manual "operating-manual"',
    );
  });

  it('prints the rule, never the gathered entries', () => {
    expect(printManifest(derive().manifest)).toBe(leafletYaml);
  });
});

describe('derived manuals gathering notices: resolved (#670)', () => {
  it('groups by source module: its title, then its notices, per variant', () => {
    const large = resolve(leaflet, 'l-400');
    expect(outline(large.manual.entries)).toEqual([
      // The front matter whole.
      'About this leaflet: leaflet-intro--about leaflet-intro--own',
      'General safety: general-safety--crush general-safety--general',
      // From a step, and through a module reference (its own module's ID).
      'Driving: driving--tip-over battery-snippet--acid',
      'Secret: secret--hidden',
    ]);
    const small = resolve(leaflet, 'l-200');
    expect(outline(small.manual.entries)).toEqual([
      'About this leaflet: leaflet-intro--about leaflet-intro--own',
      // The danger notice's variant block is for the large model only.
      'General safety: general-safety--general',
      'Driving: driving--tip-over battery-snippet--acid',
      // The snippet's notice once: `driving` gathered it already.
      'Charging: charging--care',
      'Secret: secret--hidden',
    ]);
    expect(small.hidden).toContainEqual(
      expect.objectContaining({
        kind: 'block',
        module: 'general-safety',
        block: 'large',
      }),
    );
    expect(small.manual.origins['battery-snippet--acid']).toEqual({
      module: 'battery-snippet',
      block: 'acid',
    });
  });

  it('keeps the same IDs in every language, with the translated titles and text', () => {
    const en = resolve(leaflet, 'l-400', 'en');
    const de = resolve(leaflet, 'l-400', 'de');
    expect(Object.keys(de.manual.origins).sort()).toEqual(
      Object.keys(en.manual.origins).sort(),
    );
    expect(outline(de.manual.entries)).toEqual([
      'Über dieses Blatt: leaflet-intro--about leaflet-intro--own',
      'Allgemeine Sicherheit: general-safety--crush general-safety--general',
      'Fahren: driving--tip-over battery-snippet--acid',
      'Geheim: secret--hidden',
    ]);
    const first = de.manual.entries[1];
    expect(first?.kind === 'module' && first.blocks[0]).toMatchObject({
      type: 'safety',
      hazard: [{ type: 'text', text: 'Quetschgefahr' }],
    });
  });

  it('groups by level: a group per level, most severe first, titled with its output label, then per module', () => {
    const byLevel = withNotices({ groupBy: 'level' });
    expect(outline(resolve(byLevel, 'l-200').manual.entries)).toEqual([
      'About this leaflet: leaflet-intro--about leaflet-intro--own',
      {
        WARNING: [
          'General safety: general-safety--general',
          'Driving: battery-snippet--acid',
          'Secret: secret--hidden',
        ],
      },
      { CAUTION: ['Driving: driving--tip-over'] },
      { NOTICE: ['Charging: charging--care'] },
    ]);
    expect(outline(resolve(byLevel, 'l-400', 'de').manual.entries)).toEqual([
      'Über dieses Blatt: leaflet-intro--about leaflet-intro--own',
      { GEFAHR: ['Allgemeine Sicherheit: general-safety--crush'] },
      {
        WARNUNG: [
          'Allgemeine Sicherheit: general-safety--general',
          'Fahren: battery-snippet--acid',
          'Geheim: secret--hidden',
        ],
      },
      { VORSICHT: ['Fahren: driving--tip-over'] },
    ]);
  });

  it('takes the levels the rule names, in its order, and group titles from the configured labels', () => {
    const labelled = ProjectConfig.parse({
      ...sampleConfig,
      outputLabels: { en: { caution: 'Take care' } },
    });
    const derived = derive(
      withNotices({ groupBy: 'level', levels: ['caution', 'danger'] }),
    );
    const { manual } = resolveManual({
      manifest: { ...derived.manifest, attributes: derived.attributes },
      variant: { model: 'l-400' },
      lang: 'en',
      config: labelled,
      loadModule,
    });
    expect(outline(manual.entries)).toEqual([
      'About this leaflet: leaflet-intro--about leaflet-intro--own',
      { 'Take care': ['Driving: driving--tip-over'] },
      { DANGER: ['General safety: general-safety--crush'] },
    ]);
  });

  it('never shows a notice of a module the reader may not see, gathered or referred to', () => {
    const hidden = new Set(['secret', 'battery-snippet']);
    const { manual, issues } = resolve(
      leaflet,
      'l-200',
      'en',
      (m) => !hidden.has(m.id),
    );
    expect(outline(manual.entries)).toEqual([
      'About this leaflet: leaflet-intro--about leaflet-intro--own',
      'General safety: general-safety--general',
      'Driving: driving--tip-over',
      'Charging: charging--care',
    ]);
    expect(JSON.stringify(manual)).not.toMatch(
      /secret|battery-snippet|Hidden|Acid/,
    );
    expect(
      issues.filter((i) => i.code === 'outside-scope').map((i) => i.module),
    ).toEqual(['battery-snippet', 'secret']);
  });

  it('reports a link from a notice to a block it does not gather as outside the manual, not as missing', () => {
    const { issues } = resolve(leaflet, 'l-400');
    expect(
      issues
        .filter((i) => i.code.startsWith('xref'))
        .map((i) => [i.severity, i.code, i.target]),
    ).toEqual([
      ['warning', 'xref-outside-manual', { module: 'driving', block: 'intro' }],
    ]);
  });

  it('resolves a rule without notices as before: whole modules', () => {
    const whole = parseManifest(
      leafletYaml.replace('  notices:\n    groupBy: module\n', ''),
      { id: 'x' },
    );
    const derived = deriveManifest({
      manifest: whole,
      source,
      config,
      moduleType: (id) => sourceModule(id)?.meta.type,
      module: sourceModule,
    });
    expect(derived.manifest.entries).toEqual([
      { module: 'leaflet-intro' },
      { module: 'general-safety' },
    ]);
    const { manual } = resolveManual({
      manifest: { ...derived.manifest, attributes: derived.attributes },
      variant: { model: 'l-200' },
      lang: 'en',
      config,
      loadModule,
    });
    expect(outline(manual.entries)).toEqual([
      'About this leaflet: leaflet-intro--about leaflet-intro--own',
      'General safety: general-safety--general',
    ]);
  });
});
