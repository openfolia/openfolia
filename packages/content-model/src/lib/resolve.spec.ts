import { readFileSync } from 'node:fs';
import { sampleConfig } from '../fixtures/config.js';
import { batteryDisposal, chargingProcedure } from '../fixtures/modules.js';
import type { Block } from './blocks.js';
import { ProjectConfig } from './config.js';
import { parseManifest } from './manifest-yaml.js';
import { Module } from './module.js';
import { resolveManual, type ResolvedEntry } from './resolve.js';

const config = ProjectConfig.parse(sampleConfig);
const manifest = parseManifest(
  readFileSync(
    new URL('../fixtures/operating-manual.yaml', import.meta.url),
    'utf8',
  ),
  {
    id: 'operating-manual',
  },
);

const serviceInternals = Module.parse({
  schemaVersion: 1,
  id: 'service-internals',
  meta: {
    title: 'Service internals',
    type: 'concept',
    lang: 'en',
    audience: 'service',
  },
  blocks: [
    {
      type: 'paragraph',
      id: 'p',
      content: [{ type: 'text', text: 'Service only.' }],
    },
  ],
});
const modules = new Map(
  [chargingProcedure, batteryDisposal]
    .map((m) => Module.parse(m))
    .concat(serviceInternals)
    .map((m) => [`en/${m.id}`, m]),
);
const loadModule = (id: string, lang: string) => modules.get(`${lang}/${id}`);

const resolve = (variant: Record<string, string>, lang = 'en') =>
  resolveManual({ manifest, variant, lang, config, loadModule });

/** All text of a resolved manual, for quick assertions. */
function textOf(entries: readonly ResolvedEntry[]): string {
  return JSON.stringify(entries);
}
const moduleEntry = (
  entries: readonly ResolvedEntry[],
  id: string,
): Extract<ResolvedEntry, { kind: 'module' }> | undefined => {
  for (const e of entries) {
    if (e.kind === 'module' && e.module === id) return e;
    if (e.kind === 'group') {
      const found = moduleEntry(e.entries, id);
      if (found) return found;
    }
  }
  return undefined;
};

describe('resolveManual', () => {
  const l200 = { market: 'eu', model: 'l-200', software: '2.2' };
  const l400 = { market: 'eu', model: 'l-400', software: '2.3' };

  it('fills in text attributes per variant', () => {
    const intro = (variant: Record<string, string>) => {
      const charging = moduleEntry(
        resolve(variant).manual.entries,
        'battery-charging',
      );
      return charging?.blocks[0];
    };
    expect(intro(l200)).toEqual({
      type: 'paragraph',
      id: 'battery-charging--intro',
      content: [
        {
          type: 'text',
          text: 'The L-200 charges automatically at the charging station. Charge manually only after a deep discharge.',
        },
      ],
    });
    expect(textOf(resolve(l400).manual.entries)).toContain('The L-400 charges');
  });

  it('applies variant blocks', () => {
    expect(textOf(resolve(l400).manual.entries)).toContain(
      'The charging progress is also shown in the app.',
    );
    expect(textOf(resolve(l200).manual.entries)).not.toContain(
      'also shown in the app',
    );
    expect(
      textOf(resolve({ ...l400, software: '2.2' }).manual.entries),
    ).not.toContain('also shown in the app');
  });

  it('inlines module references and applies entry conditions', () => {
    const eu = resolve(l400).manual;
    const charging = moduleEntry(eu.entries, 'battery-charging');
    const inlined = charging?.blocks.find(
      (b: Block) => b.id === 'battery-disposal--notice-disposal',
    );
    expect(inlined?.type).toBe('safety');
    expect(eu.origins['battery-disposal--notice-disposal']).toEqual({
      module: 'battery-disposal',
      block: 'notice-disposal',
    });

    // Listed again at the end for the EU: the second copy gets its own ID.
    expect(moduleEntry(eu.entries, 'battery-disposal')?.blocks[0]?.id).toBe(
      'battery-disposal--notice-disposal--2',
    );
    expect(eu.anchors['battery-disposal#notice-disposal']).toBe(
      'battery-disposal--notice-disposal',
    );

    const us = resolve({
      market: 'us',
      model: 'l-400',
      software: '2.10.1',
    }).manual;
    expect(moduleEntry(us.entries, 'battery-disposal')).toBeUndefined();
  });

  it('leaves out modules above the manual audience and reports it', () => {
    const { manual, issues } = resolve(l400);
    expect(moduleEntry(manual.entries, 'service-internals')).toBeUndefined();
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'above-audience',
        module: 'service-internals',
      }),
    );
  });

  it('links a whole module to its first block that is not a page break', () => {
    const disposal = loadModule('battery-disposal', 'en') as Module;
    const broken = Module.parse({
      ...disposal,
      blocks: [{ type: 'pageBreak', id: 'break' }, ...disposal.blocks],
    });
    const { manual } = resolveManual({
      manifest: { ...manifest, entries: [{ module: 'battery-disposal' }] },
      variant: l400,
      lang: 'en',
      config,
      loadModule: (id, lang) =>
        id === 'battery-disposal' ? broken : loadModule(id, lang),
    });
    expect(manual.anchors['battery-disposal']).toBe(
      `battery-disposal--${disposal.blocks[0]?.id}`,
    );
    expect(manual.anchors['battery-disposal#break']).toBe(
      'battery-disposal--break',
    );
  });

  it('fails closed on audiences that are not configured', () => {
    const typo = Module.parse({
      ...serviceInternals,
      id: 'typo',
      meta: { ...serviceInternals.meta, audience: 'publc' },
    });
    const withTypo = (manifestAudience: string | undefined) =>
      resolveManual({
        manifest: {
          ...manifest,
          audience: manifestAudience,
          entries: [{ module: 'typo' }, { module: 'battery-disposal' }],
        },
        variant: l400,
        lang: 'en',
        config,
        loadModule: (id) => (id === 'typo' ? typo : loadModule(id, 'en')),
      });

    // A module with an unknown audience is left out, even from an unrestricted manual.
    const open = withTypo(undefined);
    expect(moduleEntry(open.manual.entries, 'typo')).toBeUndefined();
    expect(open.issues).toContainEqual(
      expect.objectContaining({
        code: 'unknown-audience',
        module: 'typo',
        severity: 'error',
      }),
    );

    // A manual with an unknown audience lets nothing through.
    const closed = withTypo('custmer');
    expect(closed.manual.entries).toEqual([]);
    expect(closed.issues).toContainEqual(
      expect.objectContaining({ code: 'unknown-audience', severity: 'error' }),
    );
  });

  it('leaves out modules the reader may not see, before anything else about them', () => {
    const visible = (m: Module) => m.id !== 'battery-disposal';
    const { manual, issues } = resolveManual({
      manifest,
      variant: l400,
      lang: 'de',
      config,
      loadModule,
      visible,
    });
    expect(moduleEntry(manual.entries, 'battery-disposal')).toBeUndefined();
    // Not inlined into the module that references it either.
    expect(textOf(manual.entries)).not.toContain('battery-disposal--');
    const about = issues.filter((i) => i.module === 'battery-disposal');
    // No fallback-language or audience issue: only that it was left out.
    expect(about.map((i) => i.code)).toEqual(['outside-scope']);
    expect(moduleEntry(manual.entries, 'battery-charging')).toBeDefined();

    // Hidden in front of the audience check, so its audience is not reported.
    const hiddenInternals = resolveManual({
      manifest,
      variant: l400,
      lang: 'en',
      config,
      loadModule,
      visible: (m) => m.id !== 'service-internals',
    });
    expect(
      hiddenInternals.issues.filter((i) => i.module === 'service-internals'),
    ).toEqual([expect.objectContaining({ code: 'outside-scope' })]);
  });

  it('falls back to a visible source module when the translation is hidden, as if missing', () => {
    const german = Module.parse({
      ...chargingProcedure,
      meta: { ...chargingProcedure.meta, lang: 'de', audience: 'internal' },
    });
    const withGerman = new Map(modules).set(`de/${german.id}`, german);
    const result = resolveManual({
      manifest,
      variant: l400,
      lang: 'de',
      config,
      loadModule: (id, l) => withGerman.get(`${l}/${id}`),
      visible: (m) => m.meta.lang === 'en',
    });
    expect(moduleEntry(result.manual.entries, german.id)?.lang).toBe('en');
    expect(
      result.issues
        .filter(
          (i) => i.module === german.id && i.code !== 'xref-outside-manual',
        )
        .map((i) => i.code),
    ).toEqual(['missing-translation']);
  });

  it('reports cross-references to modules outside the manual', () => {
    expect(resolve(l400).issues).toContainEqual(
      expect.objectContaining({
        code: 'xref-outside-manual',
        module: 'battery-charging',
        severity: 'warning',
      }),
    );
  });

  it('falls back to the source language and says so', () => {
    const { manual, issues } = resolve(l400, 'de');
    expect(moduleEntry(manual.entries, 'battery-charging')?.lang).toBe('en');
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'missing-translation',
        module: 'battery-charging',
      }),
    );
  });

  it('reports conditions on attributes the variant does not set', () => {
    const { issues } = resolve({ model: 'l-400' });
    expect(
      issues
        .filter((i) => i.code === 'missing-variant-attribute')
        .map((i) => i.message),
    ).toEqual(
      // In document order: the module's variant block comes before the entry condition.
      [
        expect.stringContaining('"software"'),
        expect.stringContaining('"market"'),
      ],
    );
  });

  describe('the titles of modules a cross-reference links to (#796)', () => {
    const page = (
      id: string,
      title: string,
      lang = 'en',
      extra: Record<string, unknown> = {},
      content: unknown[] = [{ type: 'text', text: 'Text.' }],
      more: unknown[] = [],
    ) =>
      Module.parse({
        schemaVersion: 1,
        id,
        meta: { title, type: 'concept', lang, audience: 'public', ...extra },
        blocks: [{ type: 'paragraph', id: 'p', content }, ...more],
      });
    // `shared` is included by a module reference: part of the manual, but no entry of it.
    const included = [{ type: 'moduleRef', id: 'r', module: 'shared' }];
    const links = [
      { type: 'text', text: 'See ' },
      { type: 'xref', module: 'pressures' },
      { type: 'xref', module: 'shared' },
      { type: 'xref', module: 'secret' },
      { type: 'xref', module: 'internals' },
      { type: 'xref', module: 'only-english' },
      { type: 'xref', module: 'nowhere' },
      { type: 'xref', module: 'checking' },
    ];
    const library = new Map(
      [
        page('checking', 'Checking the pressure', 'en', {}, links, included),
        page('checking', 'Den Druck prüfen', 'de', {}, links, included),
        page('pressures', 'Pressures'),
        page('pressures', 'Druckwerte', 'de'),
        page('only-english', 'Only in English'),
        page('secret', 'Secret', 'en'),
        page('secret', 'Geheim', 'de'),
        page('internals', 'Internals', 'en', { audience: 'internal' }),
        page('internals', 'Interna', 'de', { audience: 'internal' }),
        page('shared', 'Shared'),
        page('shared', 'Geteilt', 'de'),
      ].map((m) => [`${m.meta.lang}/${m.id}`, m]),
    );
    const titles = (lang: string) =>
      resolveManual({
        manifest: {
          ...manifest,
          audience: 'customer',
          entries: [{ module: 'checking' }],
        },
        variant: l400,
        lang,
        config,
        loadModule: (id, l) => library.get(`${l}/${id}`),
        visible: (m) => m.id !== 'secret',
      }).manual.xrefTitles;

    it('names each module outside the manual by its title, in the manual\u2019s language or its fallback', () => {
      expect(titles('en')).toEqual({
        pressures: 'Pressures',
        shared: 'Shared',
        'only-english': 'Only in English',
      });
      expect(titles('de')).toEqual({
        pressures: 'Druckwerte',
        shared: 'Geteilt',
        'only-english': 'Only in English',
      });
    });

    it('never names one the reader may not see, nor one above the manual\u2019s audience', () => {
      expect(titles('en')).not.toHaveProperty('secret');
      expect(titles('en')).not.toHaveProperty('internals');
      expect(titles('de')).not.toHaveProperty('nowhere');
    });
  });

  it('detects module reference cycles', () => {
    const a = Module.parse({
      schemaVersion: 1,
      id: 'a',
      meta: { title: 'A', type: 'concept', lang: 'en' },
      blocks: [{ type: 'moduleRef', id: 'to-b', module: 'b' }],
    });
    const b = Module.parse({
      ...a,
      id: 'b',
      blocks: [{ type: 'moduleRef', id: 'to-a', module: 'a' }],
    });
    const { issues } = resolveManual({
      manifest: {
        ...manifest,
        audience: undefined,
        entries: [{ module: 'a' }],
      },
      variant: l400,
      lang: 'en',
      config,
      loadModule: (id) => ({ a, b })[id as 'a'],
    });
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'module-cycle',
        message: 'module reference cycle: a → b → a',
      }),
    );
  });
  it('reports output labels missing in the manual language, once, as a warning', () => {
    const { issues } = resolveManual({
      manifest,
      variant: l400,
      lang: 'nl',
      config,
      loadModule,
    });
    const labels = issues.filter((i) => i.code === 'missing-label');
    expect(labels).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'missing-label' }),
    ]);
    expect(
      resolve(l400, 'de').issues.filter((i) => i.code === 'missing-label'),
    ).toEqual([]);
  });

  it('names the block an issue was found at', () => {
    const outer = Module.parse({
      schemaVersion: 1,
      id: 'outer',
      meta: { title: 'Outer', type: 'concept', lang: 'en', audience: 'public' },
      blocks: [
        {
          type: 'list',
          id: 'steps',
          ordered: false,
          items: [
            {
              id: 'one',
              content: [
                { type: 'attribute', name: 'rated-load' },
                {
                  type: 'xref',
                  module: 'outer',
                  block: 'nowhere',
                  text: [{ type: 'text', text: 'see' }],
                },
              ],
              blocks: [],
            },
          ],
        },
        { type: 'moduleRef', id: 'ref', module: 'gone' },
        {
          type: 'variant',
          id: 'colours',
          when: { op: 'in', attr: 'colour', values: ['red'] },
          blocks: [
            {
              type: 'paragraph',
              id: 'red',
              content: [{ type: 'text', text: 'Red.' }],
            },
          ],
        },
      ],
    });
    const { issues } = resolveManual({
      manifest: {
        ...manifest,
        attributes: {},
        entries: [{ module: 'outer' }],
      },
      variant: l400,
      lang: 'en',
      config,
      loadModule: (id, lang) =>
        id === 'outer' && lang === 'en' ? outer : undefined,
    });
    const at = (code: string) => issues.find((i) => i.code === code)?.at;
    expect(at('missing-text-attribute')).toEqual({
      module: 'outer',
      block: 'one',
    });
    expect(at('xref-unknown-block')).toEqual({ module: 'outer', block: 'one' });
    expect(issues.find((i) => i.code === 'xref-unknown-block')?.target).toEqual(
      { module: 'outer', block: 'nowhere' },
    );
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'missing-module',
        module: 'gone',
        at: { module: 'outer', block: 'ref' },
      }),
    );
    expect(at('missing-variant-attribute')).toEqual({
      module: 'outer',
      block: 'colours',
    });
  });

  describe('hidden content', () => {
    const us = { market: 'us', model: 'l-400', software: '2.10.1' };
    const brief = (hidden: ReturnType<typeof resolve>['hidden']) =>
      hidden.map((h) =>
        h.kind === 'block'
          ? `block ${h.module}#${h.block}`
          : `${h.kind} ${h.kind === 'module' ? h.module : h.title}`,
      );

    it('lists the variant blocks a variant leaves out, with their condition and content', () => {
      const { hidden } = resolve(l200);
      expect(brief(hidden)).toEqual(['block battery-charging#step-wait-l400']);
      const [block] = hidden;
      expect(block).toMatchObject({
        kind: 'block',
        when: { op: 'all' },
        blocks: [{ type: 'admonition', id: 'step-wait-l400-note' }],
      });
      expect(resolve(l400).hidden).toEqual([]);
    });

    it('lists a module entry its condition leaves out, with its title', () => {
      expect(resolve(us).hidden).toEqual([
        {
          kind: 'module',
          module: 'battery-disposal',
          title: 'Disposing of batteries',
          when: { op: 'in', attr: 'market', values: ['eu'] },
        },
      ]);
    });

    it('lists no module the reader could not read anyway', () => {
      const hiddenFrom = resolveManual({
        manifest,
        variant: us,
        lang: 'en',
        config,
        loadModule,
        visible: (m) => m.id !== 'battery-disposal',
      });
      expect(hiddenFrom.hidden).toEqual([]);
      const aboveAudience = resolveManual({
        manifest: {
          ...manifest,
          entries: [
            { module: 'battery-charging' },
            {
              module: 'service-internals',
              when: { op: 'in', attr: 'market', values: ['eu'] },
            },
          ],
        },
        variant: us,
        lang: 'en',
        config,
        loadModule,
      });
      expect(aboveAudience.hidden).toEqual([]);
    });

    it('lists a group once, not what is in it, and a module used twice once', () => {
      const { hidden } = resolveManual({
        manifest: {
          ...manifest,
          entries: [
            { module: 'battery-charging' },
            { module: 'battery-charging' },
            {
              title: 'EU only',
              when: { op: 'in', attr: 'market', values: ['eu'] },
              entries: [{ module: 'battery-disposal' }],
            },
          ],
        },
        variant: { ...us, model: 'l-200' },
        lang: 'en',
        config,
        loadModule,
      });
      expect(brief(hidden)).toEqual([
        'block battery-charging#step-wait-l400',
        'group EU only',
      ]);
    });
  });
});
