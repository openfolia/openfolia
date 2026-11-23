import type { Module, ProjectConfig } from '@openfolia/content-model';
import {
  config,
  manifest,
  module,
  readable,
} from '../../../tests/fakes/fake-content.js';
import { UnprocessableProblems } from '../../base/core/errors.js';
import {
  configUsages,
  MAX_USAGES,
  narrows,
  refuseUsages,
} from './config-usage.js';

const usingLarge = (id = 'charging', lang = 'en'): Module => ({
  ...module(id, lang),
  blocks: [
    {
      type: 'variant',
      id: 'big',
      when: { op: 'in', attr: 'model', values: ['large'] },
      blocks: [],
    },
  ],
});

const withModel = (
  values: { id: string; label: string; archived?: boolean }[],
): ProjectConfig => ({
  ...config,
  variantAttributes: [{ id: 'model', label: 'Model', kind: 'enum', values }],
});

const small = { id: 'small', label: 'Small' };
const large = { id: 'large', label: 'Large' };

describe('narrows', () => {
  it('is false for labels, order, archiving and additions', () => {
    expect(
      narrows(config, withModel([{ ...large, label: 'Big' }, small])),
    ).toBe(false);
    expect(
      narrows(config, withModel([small, { ...large, archived: true }])),
    ).toBe(false);
    expect(
      narrows(config, {
        ...config,
        audiences: [...config.audiences, { id: 'internal', label: 'Internal' }],
      }),
    ).toBe(false);
  });

  it('is true for anything taken away or changed in kind', () => {
    expect(narrows(config, withModel([small]))).toBe(true);
    expect(narrows(config, { ...config, variantAttributes: [] })).toBe(true);
    expect(
      narrows(config, {
        ...config,
        variantAttributes: [{ id: 'model', label: 'Model', kind: 'version' }],
      }),
    ).toBe(true);
    expect(
      narrows(config, {
        ...config,
        languages: { source: 'en', targets: [] },
      }),
    ).toBe(true);
    expect(
      narrows(config, {
        ...config,
        moduleTypes: [
          { id: 'task', label: 'Task', restricted: false, snippet: false },
        ],
      }),
    ).toBe(true);
    // A callout style taken away (#498): callouts naming it become invalid.
    const styled = {
      ...config,
      calloutStyles: [{ id: 'square', label: 'Square' }],
    };
    expect(narrows(config, styled)).toBe(false);
    expect(narrows(styled, config)).toBe(true);
  });
});

describe('configUsages', () => {
  it('lists every place a removed value is used, and nothing once it is archived', async () => {
    const content = readable({
      modules: [usingLarge(), usingLarge('charging', 'de'), module('other')],
      manifests: [manifest('operating', ['charging'])],
    });
    const usages = await configUsages(content, config, withModel([small]));
    expect(usages.map((u) => [u.subject, u.issue.code, u.issue.at])).toEqual([
      [
        { type: 'manual', manualId: 'operating' },
        'unknown-variant-value',
        'variant 2',
      ],
      [
        { type: 'module', lang: 'de', moduleId: 'charging' },
        'unknown-variant-value',
        'big',
      ],
      [
        { type: 'module', lang: 'en', moduleId: 'charging' },
        'unknown-variant-value',
        'big',
      ],
    ]);
    expect(
      await configUsages(
        content,
        config,
        withModel([small, { ...large, archived: true }]),
      ),
    ).toEqual([]);
  });

  it('finds a removed language with files and a removed module type in use', async () => {
    const content = readable({ modules: [module('a', 'de')] });
    const usages = await configUsages(content, config, {
      ...config,
      languages: { source: 'en', targets: [] },
      moduleTypes: [
        { id: 'task', label: 'Task', restricted: false, snippet: false },
      ],
    });
    expect(usages.map((u) => u.issue.code).sort()).toEqual([
      'unknown-language',
      'unknown-module-type',
    ]);
  });

  it('finds a removed language a term holds, and checks a term the save point writes', async () => {
    const content = readable({
      terms: {
        charger:
          'schemaVersion: 1\nstatus: approved\nlanguages:\n  de:\n    preferred: Ladegerät\n',
        broken: 'not: [a term',
      },
    });
    const english = { ...config, languages: { source: 'en', targets: [] } };
    expect(await configUsages(content, config, english)).toMatchObject([
      {
        subject: { type: 'term', termId: 'charger' },
        issue: { code: 'unknown-language', at: 'de' },
      },
    ]);
    expect(
      await configUsages(
        content,
        config,
        english,
        new Map([
          [
            'term/charger',
            {
              schemaVersion: 1,
              id: 'charger',
              status: 'approved',
              languages: {
                en: { preferred: 'charger', allowed: [], forbidden: [] },
              },
            },
          ],
        ]),
      ),
    ).toEqual([]);
  });

  it('checks the replaced files against their own configuration (a merge)', async () => {
    // The base's files are fine; the change set's file uses `large`,
    // valid under its configuration, gone in the one the merge keeps.
    const content = readable({ modules: [module('charging')] });
    const usages = await configUsages(
      content,
      withModel([small]),
      withModel([small]),
      new Map([['module/en/charging', usingLarge()]]),
      config,
    );
    expect(usages).toMatchObject([
      { subject: { moduleId: 'charging' }, issue: { at: 'big' } },
    ]);
  });

  it('lists only what the change breaks, not what was broken before', async () => {
    const broken: Module = {
      ...usingLarge(),
      meta: { ...module('x').meta, type: 'nope' },
    };
    const usages = await configUsages(
      readable({ modules: [broken] }),
      config,
      withModel([small]),
    );
    expect(usages.map((u) => u.issue.code)).toEqual(['unknown-variant-value']);
  });

  it('checks what the same save point writes in place of the files', async () => {
    const content = readable({ modules: [usingLarge()] });
    const to = withModel([small]);
    expect(
      await configUsages(
        content,
        config,
        to,
        new Map([['module/en/charging', null]]),
      ),
    ).toEqual([]);
    expect(
      await configUsages(
        content,
        config,
        to,
        new Map([
          ['module/en/charging', module('charging')],
          ['module/en/added', usingLarge('added')],
        ]),
      ),
    ).toMatchObject([
      { subject: { type: 'module', lang: 'en', moduleId: 'added' } },
    ]);
  });

  it('skips files that cannot be read', async () => {
    const content = readable({
      brokenModules: [{ id: 'broken', lang: 'en' }],
      brokenManifests: ['broken'],
    });
    expect(await configUsages(content, config, withModel([small]))).toEqual([]);
  });
});

describe('refuseUsages', () => {
  it('refuses with one problem per usage, at most MAX_USAGES', () => {
    expect(() => refuseUsages([])).not.toThrow();
    const usage = {
      subject: { type: 'module', lang: 'en', moduleId: 'a' } as const,
      issue: {
        severity: 'error' as const,
        code: 'unknown-variant-value' as const,
        message: 'gone',
        at: 'b',
      },
    };
    let thrown: unknown;
    try {
      refuseUsages(Array.from({ length: MAX_USAGES + 5 }, () => usage));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnprocessableProblems);
    const refused = thrown as UnprocessableProblems;
    expect(refused.code).toBe('config-in-use');
    expect(refused.problems).toHaveLength(MAX_USAGES);
    expect(refused.message).toContain(`${MAX_USAGES + 5} places`);
    expect(refused.problems[0]).toEqual({
      detail: 'gone',
      pointer: '/module/en/a/blocks/b',
      meta: { subject: usage.subject, issue: 'unknown-variant-value', at: 'b' },
    });
  });
});
