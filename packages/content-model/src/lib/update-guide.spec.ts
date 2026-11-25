import { sampleConfig } from '../fixtures/config.js';
import { ProjectConfig } from './config.js';
import {
  ManifestParseError,
  parseManifest,
  printManifest,
} from './manifest-yaml.js';
import { Module } from './module.js';
import {
  manifestNamesModule,
  renameManifestModule,
} from './module-references.js';
import { resolveManual } from './resolve.js';
import {
  resolveUpdateGuide,
  type UpdateStepFacts,
  updateGuideEntries,
} from './update-guide.js';
import { validateManifest } from './validate.js';

const config = ProjectConfig.parse(sampleConfig);
const LEVELS = config.audiences.map((a) => a.id); // public, customer, service, internal

const GUIDE = `schemaVersion: 1
kind: update-guide
title: Update guide
variants:
  - model: l-200
guide:
  attribute: software
  versions: ["1.0", "2.0", "2.9", "2.10", "3.0"]
  steps:
    - { module: backup, version: "2.0", phase: before }
    - { module: install, version: "2.0", phase: during }
    - { module: migrate, version: "2.10", phase: after, level: service }
    - { module: check-cluster, version: "2.9", phase: after, when: market in (eu) }
    - { module: notes, version: "3.0", phase: before }
    - { module: backup, version: "3.0", phase: before }
`;
const manifest = parseManifest(GUIDE, { id: 'update' });
const guide = manifest.guide!;

const ids = (
  result: ReturnType<
    typeof resolveUpdateGuide<UpdateStepFacts & { module: string }>
  >,
) =>
  result.status === 'resolved'
    ? result.phases.map((p) => [
        p.phase,
        p.steps.map((s) => `${s.step.module}@${s.version}`),
      ])
    : result;

describe('resolveUpdateGuide (#906)', () => {
  it('excludes `from` and includes `to`', () => {
    expect(
      ids(resolveUpdateGuide(guide, { from: '2.0', to: '2.9' }, LEVELS)),
    ).toEqual([
      ['before', []],
      ['during', []],
      ['after', []],
    ]);
    // The step at 2.9 needs the market option; with it, it is crossed (`to` included).
    const eu = resolveUpdateGuide(
      guide,
      { from: '2.0', to: '2.9', options: { market: 'eu' } },
      LEVELS,
    );
    expect(ids(eu)).toEqual([
      ['before', []],
      ['during', []],
      ['after', ['check-cluster@2.9']],
    ]);
    // `from` excluded: nothing of 2.0 for a reader already on it.
    const from2 = resolveUpdateGuide(guide, { from: '2.0', to: '3.0' }, LEVELS);
    expect(JSON.stringify(ids(from2))).not.toContain('@2.0');
  });

  it('crosses several versions, grouped by phase, ordered by version then manifest order', () => {
    const result = resolveUpdateGuide(
      guide,
      { from: '1.0', to: '3.0', options: { market: 'eu' } },
      LEVELS,
    );
    expect(ids(result)).toEqual([
      ['before', ['backup@2.0', 'notes@3.0', 'backup@3.0']],
      ['during', ['install@2.0']],
      ['after', ['check-cluster@2.9', 'migrate@2.10']],
    ]);
    expect(result.status === 'resolved' && result.count).toBe(6);
  });

  it('compares versions numerically: 2.10 is after 2.9', () => {
    const result = resolveUpdateGuide(
      guide,
      { from: '2.9', to: '2.10' },
      LEVELS,
    );
    expect(ids(result)).toEqual([
      ['before', []],
      ['during', []],
      ['after', ['migrate@2.10']],
    ]);
    // 2.10 is no version 2.1: a jump to 2.9 does not cross it.
    expect(
      JSON.stringify(
        ids(resolveUpdateGuide(guide, { from: '1.0', to: '2.9' }, LEVELS)),
      ),
    ).not.toContain('migrate');
    // `3` is `3.0`.
    expect(
      resolveUpdateGuide(guide, { from: '2.10', to: '3' }, LEVELS).status,
    ).toBe('resolved');
  });

  it('filters by level: a step for a level is for it and the more restricted ones', () => {
    const at = (level: string) =>
      JSON.stringify(
        ids(
          resolveUpdateGuide(guide, { from: '2.9', to: '3.0', level }, LEVELS),
        ),
      );
    expect(at('public')).not.toContain('migrate');
    expect(at('customer')).not.toContain('migrate');
    expect(at('service')).toContain('migrate');
    expect(at('internal')).toContain('migrate');
    // No level picked: every level.
    expect(
      JSON.stringify(
        ids(resolveUpdateGuide(guide, { from: '2.9', to: '3.0' }, LEVELS)),
      ),
    ).toContain('migrate');
  });

  it('filters by options: a condition on an option not set is false', () => {
    const steps = (options?: Record<string, string>) =>
      JSON.stringify(
        ids(
          resolveUpdateGuide(
            guide,
            { from: '2.0', to: '3.0', options },
            LEVELS,
          ),
        ),
      );
    expect(steps()).not.toContain('check-cluster');
    expect(steps({ market: 'us' })).not.toContain('check-cluster');
    expect(steps({ market: 'eu' })).toContain('check-cluster');
  });

  it('resolves from >= to to no step, with a reason', () => {
    for (const [from, to] of [
      ['3.0', '2.0'],
      ['2.0', '2.0'],
      ['2.0', '2.0.0'],
    ] as const) {
      const result = resolveUpdateGuide(guide, { from, to }, LEVELS);
      expect(result).toMatchObject({
        status: 'resolved',
        count: 0,
        reason: 'not-forward',
      });
      expect(
        result.status === 'resolved' && result.phases.map((p) => p.phase),
      ).toEqual(['before', 'during', 'after']);
    }
  });

  it('refuses a version the guide does not offer, and an unknown level', () => {
    expect(
      resolveUpdateGuide(guide, { from: '1.5', to: '3.0' }, LEVELS),
    ).toEqual({
      status: 'refused',
      reason: 'unknown-version',
      value: '1.5',
    });
    expect(
      resolveUpdateGuide(guide, { from: '1.0', to: 'latest' }, LEVELS),
    ).toMatchObject({
      reason: 'unknown-version',
      value: 'latest',
    });
    expect(
      resolveUpdateGuide(
        guide,
        { from: '1.0', to: '3.0', level: 'expert' },
        LEVELS,
      ),
    ).toEqual({ status: 'refused', reason: 'unknown-level', value: 'expert' });
  });

  it('leaves out steps without a dotted version or with an unknown phase', () => {
    const result = resolveUpdateGuide(
      {
        versions: ['1.0', '2.0'],
        steps: [
          { module: 'a', phase: 'before' },
          { module: 'b', version: 'two', phase: 'before' },
          { module: 'c', version: '2.0', phase: 'later' },
          { module: 'd', version: '2.0', phase: 'during' },
        ],
      },
      { from: '1.0', to: '2.0' },
      LEVELS,
    );
    expect(ids(result)).toEqual([
      ['before', []],
      ['during', ['d@2.0']],
      ['after', []],
    ]);
  });
});

describe('an update guide manifest (#906)', () => {
  it('reads its steps as entries, in version and phase order, and prints back without them', () => {
    expect(manifest.kind).toBe('update-guide');
    expect(
      manifest.entries.map((e) => ('module' in e ? e.module : '')),
    ).toEqual([
      'backup',
      'install',
      'check-cluster',
      'migrate',
      'notes',
      'backup',
    ]);
    expect(guide.steps[3]?.when).toEqual({
      op: 'in',
      attr: 'market',
      values: ['eu'],
    });
    const printed = printManifest(manifest);
    expect(printed).not.toContain('entries');
    expect(printed).toContain('when: market in (eu)');
    // Versions stay text: "2.10" is not the number 2.1.
    expect(printed).toContain('"2.10"');
    expect(parseManifest(printed, { id: 'update' })).toEqual(manifest);
  });

  it('refuses entries of its own, a guide on another kind, and versions out of order', () => {
    expect(() =>
      parseManifest(`${GUIDE}entries:\n  - module: backup\n`, { id: 'u' }),
    ).toThrow(ManifestParseError);
    expect(() =>
      parseManifest(GUIDE.replace('kind: update-guide\n', ''), { id: 'u' }),
    ).toThrow(/update guide/);
    expect(() =>
      parseManifest(GUIDE.replace('guide:', 'other:'), { id: 'u' }),
    ).toThrow(ManifestParseError);
    expect(() =>
      parseManifest(GUIDE.replace('"2.9", "2.10"', '"2.10", "2.9"'), {
        id: 'u',
      }),
    ).toThrow(/oldest first/);
  });

  it('is named by and renames its steps’ modules', () => {
    expect(manifestNamesModule(manifest, 'migrate')).toBe(true);
    expect(manifestNamesModule(manifest, 'other')).toBe(false);
    const renamed = renameManifestModule(manifest, 'backup', 'save-data');
    expect(
      renamed.guide?.steps.filter((s) => s.module === 'save-data'),
    ).toHaveLength(2);
    expect(printManifest(renamed)).not.toContain('backup');
  });

  it('validates its steps with stable codes', () => {
    const draft = parseManifest(
      `schemaVersion: 1
kind: update-guide
title: Update guide
variants:
  - model: l-200
guide:
  attribute: model
  versions: ["1.0", "2.0"]
  steps:
    - { module: a, phase: before }
    - { module: b, version: "2.x", phase: before }
    - { module: c, version: "1.0", phase: before }
    - { module: d, version: "4.0", phase: during }
    - { module: e, version: "2.0", phase: later }
    - { module: f, version: "2.0", phase: after, level: expert }
    - { module: g, version: "2.0", phase: after, when: colour in (red) }
    - { module: h, version: "2.0", phase: after }
`,
      { id: 'draft' },
    );
    const issues = validateManifest(draft, config).map((i) => [
      i.severity,
      i.code,
      i.at,
    ]);
    expect(issues).toEqual([
      ['error', 'unknown-variant-attribute', 'guide.attribute'],
      ['error', 'update-step-version', 'guide.steps.0'],
      ['error', 'update-step-version', 'guide.steps.1'],
      ['warning', 'update-step-outside-versions', 'guide.steps.2'],
      ['warning', 'update-step-outside-versions', 'guide.steps.3'],
      ['error', 'update-step-phase', 'guide.steps.4'],
      ['error', 'unknown-audience', 'guide.steps.5'],
      ['error', 'unknown-variant-attribute', 'guide.steps.6'],
    ]);
    expect(validateManifest(manifest, config)).toEqual([]);
  });

  it('resolves to the whole guide, grouped by version, then by phase, with its steps', () => {
    const modules = new Map(
      ['backup', 'install', 'migrate', 'check-cluster', 'notes'].map((id) => [
        id,
        Module.parse({
          schemaVersion: 1,
          id,
          meta: { title: `Title of ${id}`, type: 'procedure', lang: 'en' },
          blocks: [
            {
              type: 'paragraph',
              id: 'p',
              content: [{ type: 'text', text: id }],
            },
          ],
        }),
      ]),
    );
    const { manual, issues } = resolveManual({
      manifest,
      variant: { model: 'l-200' },
      lang: 'de',
      config,
      loadModule: (id) => modules.get(id),
      // The reader may not see one step's module: it is left out, with its step.
      visible: (m) => m.id !== 'notes',
    });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    const outline = (entries: typeof manual.entries): unknown[] =>
      entries.map((e) =>
        e.kind === 'group' ? [e.title, outline(e.entries)] : e.module,
      );
    expect(outline(manual.entries)).toEqual([
      [
        'Version 2.0',
        [
          ['Vor dem Update', ['backup']],
          ['Während des Updates', ['install']],
        ],
      ],
      // Every step, whatever its condition or level.
      ['Version 2.9', [['Nach dem Update', ['check-cluster']]]],
      ['Version 2.10', [['Nach dem Update', ['migrate']]]],
      ['Version 3.0', [['Vor dem Update', ['backup']]]],
    ]);
    expect(
      manual.updateSteps?.map((s) => [
        s.index,
        s.version,
        s.phase,
        s.level,
        s.entry.module,
      ]),
    ).toEqual([
      [0, '2.0', 'before', undefined, 'backup'],
      [1, '2.0', 'during', undefined, 'install'],
      [3, '2.9', 'after', undefined, 'check-cluster'],
      [2, '2.10', 'after', 'service', 'migrate'],
      [5, '3.0', 'before', undefined, 'backup'],
    ]);
    // A module in two steps: two copies, each with its own IDs.
    const blockIds = manual.updateSteps
      ?.filter((s) => s.entry.module === 'backup')
      .map((s) => s.entry.blocks[0]?.id);
    expect(new Set(blockIds).size).toBe(2);
  });

  it('leaves out a step whose level is above the manual’s audience, or not configured', () => {
    const narrow = parseManifest(
      GUIDE.replace(
        'title: Update guide\n',
        'title: Update guide\naudience: customer\n',
      ).replace(
        '{ module: notes, version: "3.0", phase: before }',
        '{ module: notes, version: "3.0", phase: before, level: expert }',
      ),
      { id: 'update' },
    );
    const module = (id: string) =>
      Module.parse({
        schemaVersion: 1,
        id,
        meta: { title: id, type: 'procedure', lang: 'en', audience: 'public' },
        blocks: [
          { type: 'paragraph', id: 'p', content: [{ type: 'text', text: id }] },
        ],
      });
    const { manual } = resolveManual({
      manifest: narrow,
      variant: { model: 'l-200' },
      lang: 'en',
      config,
      loadModule: (id) => module(id),
    });
    const modules = manual.updateSteps?.map((s) => s.entry.module);
    // `migrate` is for `service`, after `customer`; `notes` for a level not configured.
    expect(modules).not.toContain('migrate');
    expect(modules).not.toContain('notes');
    expect(modules).toContain('install');
    // Nor does a client show a step of an unknown level, with no level picked.
    expect(
      JSON.stringify(
        ids(
          resolveUpdateGuide(
            narrow.guide!,
            { from: '2.10', to: '3.0' },
            LEVELS,
          ),
        ),
      ),
    ).not.toContain('notes');
  });

  it('makes entries of invalid steps last, in manifest order', () => {
    expect(
      updateGuideEntries([
        { module: 'x', phase: 'before' },
        { module: 'y', version: '2.0', phase: 'after' },
        { module: 'z', version: '1.0', phase: 'later' },
      ]),
    ).toEqual([{ module: 'y' }, { module: 'x' }, { module: 'z' }]);
  });
});
