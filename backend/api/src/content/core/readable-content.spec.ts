import {
  ProjectConfig,
  type Manifest,
  type Module,
  type ModuleMeta,
} from '@openfolia/content-model';
import type { Actor, Scope } from '../../access/core/actor.js';
import { actorWith, READER } from '../../../tests/fakes/actors.js';
import {
  FakeSnapshot,
  manifest,
  readable,
  type FakeContent,
} from '../../../tests/fakes/fake-content.js';
import { InvalidContentError } from '../../base/core/errors.js';
import type { ManualResolution } from './content.repository.js';
import { ReadableContent } from './readable-content.js';

const config = ProjectConfig.parse({
  languages: { source: 'en', targets: ['de'] },
  moduleTypes: [
    { id: 'concept', label: 'Concept' },
    { id: 'procedure', label: 'Procedure' },
  ],
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'partner', label: 'Partner' },
    { id: 'internal', label: 'Internal' },
  ],
  facets: [
    {
      id: 'region',
      label: 'Region',
      values: [
        { id: 'north', label: 'North' },
        { id: 'south', label: 'South' },
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
  ],
});

const mod = (
  id: string,
  meta: Partial<ModuleMeta> = {},
  blocks: Module['blocks'] = [],
): Module => ({
  schemaVersion: 1,
  id,
  meta: {
    title: id,
    type: 'concept',
    lang: 'en',
    audience: 'public',
    facets: {},
    ...meta,
  },
  blocks: blocks.length
    ? blocks
    : [{ type: 'paragraph', id: 'p', content: [{ type: 'text', text: id }] }],
});
const image = (hash: string): Module['blocks'][number] => ({
  type: 'image',
  id: `img-${hash}`,
  asset: `sha256:${hash}`,
  alt: 'Image',
});

const content: FakeContent = {
  config,
  modules: [
    mod('open'),
    mod('open', { lang: 'de' }),
    mod('steps', { type: 'procedure' }, [image('steps-image')]),
    mod('partner', { audience: 'partner' }),
    mod('internal', { audience: 'internal' }, [image('internal-image')]),
    mod('unlabelled', { audience: undefined }),
    mod('typo', { audience: 'publc' }),
    mod('north', { facets: { region: ['north'] } }),
    mod('south', { facets: { region: ['south'] } }),
  ],
  brokenModules: [{ id: 'broken', lang: 'en' }],
  manifests: [
    { ...manifest('public-manual', ['open', 'internal', 'gone']) },
    { ...manifest('partner-manual', ['partner']), audience: 'partner' },
    { ...manifest('unrestricted', ['open']), audience: undefined },
  ] as Manifest[],
  brokenManifests: ['broken-manual'],
  assets: {
    'steps-image': new Uint8Array([1]),
    'internal-image': new Uint8Array([2]),
  },
};

const reader = (scope: Scope, draft = false): Actor =>
  actorWith(
    draft ? ['content.read', 'content.read.draft'] : ['content.read'],
    scope,
  );
const as = (actor: Actor) => readable(content, actor);
const ids = async (actor: Actor, lang?: string) =>
  (await as(actor).modules(lang)).map((m) => `${m.lang}/${m.id}`);

describe('ReadableContent: modules', () => {
  it('lists everything, broken files with their error, to a reader of everything', async () => {
    const listed = await as(READER).modules();
    expect(listed).toHaveLength(10);
    expect(listed).toContainEqual({
      id: 'broken',
      lang: 'en',
      error: 'modules/en/broken.adoc: not a module',
    });
  });

  it('filters by language', async () => {
    expect(await ids(reader({ languages: ['de'] }))).toEqual(['de/open']);
  });

  it('filters by module type', async () => {
    expect(await ids(reader({ moduleTypes: ['procedure'] }))).toEqual([
      'en/steps',
    ]);
  });

  it('filters by audience level, each level including the less restricted ones', async () => {
    const at = (maxAudience: string) => ids(reader({ maxAudience }), 'en');
    expect(await at('public')).toEqual([
      'en/north',
      'en/open',
      'en/south',
      'en/steps',
    ]);
    expect(await at('partner')).toEqual([
      'en/north',
      'en/open',
      'en/partner',
      'en/south',
      'en/steps',
    ]);
    // Internal, the most restricted level: also the module without an audience.
    expect(await at('internal')).toEqual([
      'en/internal',
      'en/north',
      'en/open',
      'en/partner',
      'en/south',
      'en/steps',
      'en/unlabelled',
    ]);
  });

  it('hides a module without an audience from anyone limited below internal', async () => {
    for (const maxAudience of ['public', 'partner']) {
      expect(await ids(reader({ maxAudience }))).not.toContain('en/unlabelled');
      expect(
        await as(reader({ maxAudience })).module('unlabelled', 'en'),
      ).toBeUndefined();
    }
  });

  it('filters by facet: no value named applies to all', async () => {
    expect(
      await ids(
        reader({ facets: { region: ['north'] }, moduleTypes: ['concept'] }),
        'en',
      ),
    ).toEqual([
      'en/internal',
      'en/north',
      'en/open',
      'en/partner',
      'en/typo',
      'en/unlabelled',
    ]);
  });

  it('never lists a broken file to a reader of less than all of its language', async () => {
    for (const scope of [
      { maxAudience: 'internal' },
      { moduleTypes: ['concept'] },
      { facets: { region: ['north', 'south'] } },
    ]) {
      expect(await ids(reader(scope))).not.toContain('en/broken');
      expect(await as(reader(scope)).module('broken', 'en')).toBeUndefined();
    }
    await expect(
      as(reader({ languages: ['en'] })).module('broken', 'en'),
    ).rejects.toBeInstanceOf(InvalidContentError);
  });

  it('reads a single module only within the scope', async () => {
    const german = as(reader({ languages: ['de'] }));
    expect((await german.module('open', 'de'))?.meta.lang).toBe('de');
    expect(await german.module('open', 'en')).toBeUndefined();
  });

  it('combines no roles: each module must lie within one role', async () => {
    const twoRoles: Actor = {
      kind: 'user',
      id: 'two-roles',
      roles: [
        {
          id: 'german',
          name: 'German',
          permissions: ['content.read'],
          scope: { languages: ['de'] },
        },
        {
          id: 'procedures',
          name: 'Procedures',
          permissions: ['content.read'],
          scope: { moduleTypes: ['procedure'] },
        },
      ],
    };
    expect(await ids(twoRoles)).toEqual(['de/open', 'en/steps']);
  });
});

describe('ReadableContent: module revisions', () => {
  it('names a module’s file only where the reader may see it', async () => {
    const everything = as(READER);
    const revision = await everything.moduleRevision('open', 'en');
    expect(revision).toMatch(/^[0-9a-f]+$/);
    expect(await everything.moduleRevision('open', 'de')).not.toBe(revision);
    // The same file elsewhere has the same revision.
    expect(
      await readable({ ...content, modules: [mod('open')] }).moduleRevision(
        'open',
        'en',
      ),
    ).toBe(revision);
    expect(await everything.moduleRevision('gone', 'en')).toBeUndefined();
    const narrow = as(reader({ maxAudience: 'public' }));
    expect(await narrow.moduleRevision('open', 'en')).toBe(revision);
    expect(await narrow.moduleRevision('internal', 'en')).toBeUndefined();
  });

  it('names a broken file only to a reader of all of its language', async () => {
    expect(
      await as(reader({ languages: ['en'] })).moduleRevision('broken', 'en'),
    ).toBeDefined();
    expect(
      await as(reader({ moduleTypes: ['concept'] })).moduleRevision(
        'broken',
        'en',
      ),
    ).toBeUndefined();
  });
});

describe('ReadableContent: translation records', () => {
  const record = {
    schemaVersion: 1 as const,
    sourceCommit: 'c'.repeat(40),
    blocks: { p: '0'.repeat(64) },
  };
  const withRecords: FakeContent = {
    ...content,
    translationRecords: { 'de/open': record, 'en/broken': record },
    brokenTranslationRecords: ['de/north'],
    modules: [
      ...(content.modules ?? []),
      mod('north', { lang: 'de', facets: { region: ['north'] } }),
    ],
  };

  it('reads a record only where the reader sees the translated file', async () => {
    expect(await readable(withRecords).translationRecord('open', 'de')).toEqual(
      record,
    );
    expect(
      await readable(
        withRecords,
        reader({ languages: ['en'] }),
      ).translationRecord('open', 'de'),
    ).toBeUndefined();
    expect(
      await readable(withRecords).translationRecord('nope', 'de'),
    ).toBeUndefined();
    // A broken module file has none, for anyone.
    expect(
      await readable(
        withRecords,
        reader({ languages: ['en'] }),
      ).translationRecord('broken', 'en'),
    ).toBeUndefined();
  });

  it('reports a broken record only to a reader who sees its module', async () => {
    await expect(
      readable(withRecords).translationRecord('north', 'de'),
    ).rejects.toBeInstanceOf(InvalidContentError);
    expect(
      await readable(
        withRecords,
        reader({ facets: { region: ['south'] } }),
      ).translationRecord('north', 'de'),
    ).toBeUndefined();
  });
});

describe('ReadableContent: drafts', () => {
  it('filters by the roles holding content.read.draft on a draft', async () => {
    const actor: Actor = {
      kind: 'user',
      id: 'mixed',
      roles: [
        {
          id: 'released',
          name: 'Released',
          permissions: ['content.read'],
          scope: {},
        },
        {
          id: 'drafts',
          name: 'Drafts',
          permissions: ['content.read.draft'],
          scope: { languages: ['de'] },
        },
      ],
    };
    const draft = readable(content, actor, 'content.read.draft');
    expect((await draft.modules()).map((m) => `${m.lang}/${m.id}`)).toEqual([
      'de/open',
    ]);
    expect((await readable(content, actor).modules()).length).toBe(10);
  });
});

describe('ReadableContent: manuals', () => {
  const manualIds = async (actor: Actor) =>
    (await as(actor).manuals()).map((m) => m.id);

  it('lists the manuals whose audience the reader covers', async () => {
    expect(await manualIds(READER)).toEqual([
      'broken-manual',
      'partner-manual',
      'public-manual',
      'unrestricted',
    ]);
    // Without an audience: the most restricted level, like a module.
    expect(await manualIds(reader({ maxAudience: 'partner' }))).toEqual([
      'partner-manual',
      'public-manual',
    ]);
    expect(await manualIds(reader({ maxAudience: 'public' }))).toEqual([
      'public-manual',
    ]);
    // Language, type and facets decide the modules, not the manual.
    expect(await manualIds(reader({ languages: ['de'] }))).toHaveLength(4);
  });

  it('reads a manifest only within the scope; a broken one only for every audience', async () => {
    const publicOnly = as(reader({ maxAudience: 'public' }));
    expect(await publicOnly.manual('partner-manual')).toBeUndefined();
    expect((await publicOnly.manual('public-manual'))?.manifest.id).toBe(
      'public-manual',
    );
    expect(await publicOnly.manual('broken-manual')).toBeUndefined();
    await expect(
      as(reader({ languages: ['de'] })).manual('broken-manual'),
    ).rejects.toBeInstanceOf(InvalidContentError);
  });
});

describe('ReadableContent: what a manifest names', () => {
  // `internal` carries a condition on an attribute that is not configured:
  // a validation issue (and, when resolving, an issue) naming it.
  const colour = { op: 'in' as const, attr: 'colour', values: ['red'] };
  const raw: Manifest = {
    ...manifest('m', []),
    variants: [{ model: 'small' }],
    entries: [
      { module: 'open' },
      { module: 'internal', when: colour },
      { title: 'Steps', entries: [{ module: 'steps' }] },
      { title: 'Regions', entries: [{ module: 'north' }, { module: 'south' }] },
      { module: 'gone' },
      { module: 'broken' },
    ],
  };
  const scoped: FakeContent = {
    ...content,
    manifests: [
      raw,
      {
        ...manifest('hidden-only', ['internal']),
        variants: [{ model: 'small' }],
      },
    ],
  };
  const read = (actor: Actor, id = 'm') => readable(scoped, actor).manual(id);
  /** Every module a manifest names, groups as `title[…]`. */
  const named = (entries: Manifest['entries'] | undefined): string[] =>
    (entries ?? []).map((e) =>
      'module' in e ? e.module : `${e.title}[${named(e.entries).join(',')}]`,
    );
  const issues = async (actor: Actor) =>
    (await read(actor))?.issues.map((i) => `${i.code} ${i.at ?? ''}`);

  it('is unchanged for a reader of everything', async () => {
    const all = await read(READER);
    expect(all?.manifest).toEqual(raw);
    expect(await issues(READER)).toEqual([
      'unknown-variant-attribute internal',
    ]);
  });

  it('tells whether nothing is hidden from the reader', () => {
    expect(as(READER).seesEverything()).toBe(true);
    expect(as(reader({ maxAudience: 'public' })).seesEverything()).toBe(false);
    expect(as(reader({ languages: ['en'] })).seesEverything()).toBe(false);
    // Reading drafts with an unrestricted `content.read` only: hidden.
    expect(
      readable(content, READER, 'content.read.draft').seesEverything(),
    ).toBe(false);
  });

  it('reads no module to name them to a reader of everything (#478)', async () => {
    const snapshot = new FakeSnapshot(scoped);
    const reads = vi.spyOn(snapshot, 'module');
    const listed = await new ReadableContent(
      snapshot,
      READER,
      'content.read',
    ).manuals();
    expect(listed.map((m) => m.id).sort()).toEqual([
      'broken-manual',
      'hidden-only',
      'm',
    ]);
    expect(reads).not.toHaveBeenCalled();
    // A scoped reader's manifests are judged module by module.
    await new ReadableContent(
      snapshot,
      reader({ maxAudience: 'public' }),
      'content.read',
    ).manuals();
    expect(reads).toHaveBeenCalled();
  });

  it('leaves out references above the reader’s audience, and broken files they may not learn of', async () => {
    const result = await read(reader({ maxAudience: 'public' }));
    expect(named(result?.manifest.entries)).toEqual([
      'open',
      'Steps[steps]',
      'Regions[north,south]',
      'gone',
    ]);
    // Nothing about them in the validation issues either.
    expect(result?.issues).toEqual([]);
  });

  it('leaves out references outside the reader’s types and facets, and groups left empty', async () => {
    const result = await read(
      reader({ moduleTypes: ['concept'], facets: { region: ['north'] } }),
    );
    expect(named(result?.manifest.entries)).toEqual([
      'open',
      'internal',
      'Regions[north]',
      'gone',
    ]);
  });

  it('keeps a reference visible in one of the reader’s languages', async () => {
    // `open` has a German version; the others are English only.
    const result = await read(reader({ languages: ['de'] }));
    expect(named(result?.manifest.entries)).toEqual(['open', 'gone']);
  });

  it('can leave a manual with no entries', async () => {
    const result = await read(reader({ maxAudience: 'public' }), 'hidden-only');
    expect(result?.manifest.entries).toEqual([]);
  });

  it('notes what was left out only for content.read.draft holders', async () => {
    expect(await issues(reader({ maxAudience: 'public' }, true))).toEqual([
      'outside-scope internal',
      'outside-scope broken',
    ]);
    expect(await issues(reader({ maxAudience: 'public' }))).toEqual([]);
  });

  it('lists manuals filtered the same way', async () => {
    const actor = reader({ maxAudience: 'public' }, true);
    const listed = (await readable(scoped, actor).manuals()).find(
      (m) => m.id === 'm',
    );
    expect(listed).toEqual({ id: 'm', ...(await read(actor)) });
  });

  it('resolves without naming a reference left out', async () => {
    const resolveAs = (actor: Actor) =>
      readable(scoped, actor).resolve('m', { model: 'small' }, 'en');
    const names = (r: ManualResolution | undefined) =>
      r?.issues.map((i) => `${i.code} ${i.module ?? ''}`).sort();
    // What is resolved is the manifest the reader may see: the hidden
    // entry's condition is not evaluated, so nothing hints at it.
    expect(names(await resolveAs(reader({ maxAudience: 'public' })))).toEqual(
      [],
    );
    const draft = await resolveAs(reader({ maxAudience: 'public' }, true));
    expect(names(draft)).toEqual([
      'missing-module gone',
      'outside-scope broken',
      'outside-scope internal',
    ]);
    // A reader of everything resolves the entry, and its condition.
    expect(names(await resolveAs(reader({}, true)))).toContain(
      'missing-variant-attribute ',
    );
    expect(named(draft?.manifest.entries)).not.toContain('internal');
    // Nothing is left out for a reader of everything.
    expect(names(await resolveAs(reader({}, true)))).not.toContainEqual(
      expect.stringMatching(/^outside-scope/),
    );
  });
});

describe('ReadableContent: resolving', () => {
  const resolve = (actor: Actor, id = 'public-manual', lang = 'en') =>
    as(actor).resolve(id, { model: 'small' }, lang);
  const moduleIds = (resolution: ManualResolution | undefined) =>
    resolution?.manual.entries.map((e) =>
      e.kind === 'module' ? e.module : '',
    );

  it('leaves out modules the reader may not see', async () => {
    const all = await resolve(READER);
    // The manual's own audience (public) leaves out the internal module.
    expect(moduleIds(all)).toEqual(['open']);
    const procedures = await resolve(reader({ moduleTypes: ['procedure'] }));
    expect(moduleIds(procedures)).toEqual([]);
  });

  it('notes what was left out only for content.read.draft holders', async () => {
    const codes = async (actor: Actor) =>
      (await resolve(actor))?.issues.map((i) => `${i.code} ${i.module}`).sort();
    const scope = { moduleTypes: ['procedure'] };
    expect(await codes(reader(scope, true))).toEqual([
      'missing-module gone',
      'outside-scope internal',
      'outside-scope open',
    ]);
    // Without it: a module left out and a missing one look alike.
    expect(await codes(reader(scope))).toEqual([]);
    // Nothing about a hidden module but that it was left out: not its
    // audience being above the manual's.
    const all = await codes(reader({}, true));
    expect(all).toContain('above-audience internal');
  });

  it('reports a broken module only to a reader of everything in its languages', async () => {
    const broken: FakeContent = {
      ...content,
      manifests: [manifest('m', ['open', 'broken'])],
    };
    const issues = async (actor: Actor) =>
      (
        await readable(broken, actor).resolve('m', { model: 'small' }, 'en')
      )?.issues.map((i) => `${i.code} ${i.module}`);
    expect(await issues(reader({}, true))).toEqual(['invalid-module broken']);
    expect(await issues(reader({ maxAudience: 'internal' }, true))).toEqual([
      'outside-scope broken',
    ]);
    expect(await issues(reader({ maxAudience: 'internal' }))).toEqual([]);
  });

  it('keeps a module whose broken translation a visible source version stands in for', async () => {
    const brokenGerman: FakeContent = {
      ...content,
      brokenModules: [{ id: 'open', lang: 'de' }],
      modules: [mod('open')],
      manifests: [manifest('m', ['open'])],
    };
    const resolveDe = (actor: Actor) =>
      readable(brokenGerman, actor).resolve('m', { model: 'small' }, 'de');
    const scoped = await resolveDe(reader({ maxAudience: 'internal' }, true));
    expect(moduleIds(scoped)).toEqual(['open']);
    // Not "left out", and the broken file's error stays hidden.
    expect(scoped?.issues).toEqual([]);
    const all = await resolveDe(reader({}, true));
    expect(all?.issues.map((i) => i.code)).toEqual(['invalid-module']);
  });

  it('uses a visible source version when the translation is hidden, as if missing', async () => {
    const hiddenGerman: FakeContent = {
      ...content,
      modules: [
        mod('steps', { type: 'procedure' }),
        mod('steps', { lang: 'de', type: 'concept' }),
      ],
      manifests: [manifest('m', ['steps'])],
    };
    // Reads German procedures, and English of any type.
    const actor: Actor = {
      kind: 'user',
      id: 'split',
      roles: [
        {
          id: 'en',
          name: 'en',
          permissions: ['content.read'],
          scope: { languages: ['en'] },
        },
        {
          id: 'de',
          name: 'de',
          permissions: ['content.read'],
          scope: { languages: ['de'], moduleTypes: ['procedure'] },
        },
      ],
    };
    const result = await readable(hiddenGerman, actor).resolve(
      'm',
      { model: 'small' },
      'de',
    );
    expect(result?.manual.entries).toEqual([
      expect.objectContaining({ module: 'steps', lang: 'en' }),
    ]);
  });

  it('is not there for a manual or a language outside the scope', async () => {
    expect(
      await resolve(reader({ maxAudience: 'public' }), 'partner-manual'),
    ).toBeUndefined();
    expect(
      await resolve(reader({ languages: ['de'] }), 'public-manual', 'en'),
    ).toBeUndefined();
    expect(
      moduleIds(
        await resolve(reader({ languages: ['de'] }), 'public-manual', 'de'),
      ),
    ).toEqual(['open']);
  });

  it('does not fall back to a source-language module outside the scope', async () => {
    const onlyEnglishSource: FakeContent = {
      ...content,
      modules: [mod('steps', { type: 'procedure' })],
      manifests: [manifest('m', ['steps'])],
    };
    const german = reader({ languages: ['de'] });
    const result = await readable(onlyEnglishSource, german).resolve(
      'm',
      { model: 'small' },
      'de',
    );
    expect(result?.manual.entries).toEqual([]);
  });
});

describe('ReadableContent: assets', () => {
  it('serves an image only when a module the reader may see refers to it', async () => {
    expect(await as(READER).asset('internal-image')).toEqual(
      new Uint8Array([2]),
    );
    // Same commit, another reader: not served from the first one's findings.
    const publicOnly = as(reader({ maxAudience: 'public' }));
    expect(await publicOnly.asset('internal-image')).toBeUndefined();
    expect(await publicOnly.asset('steps-image')).toEqual(new Uint8Array([1]));
    expect(
      await as(reader({ moduleTypes: ['concept'] })).asset('steps-image'),
    ).toBeUndefined();
  });
});

describe('ReadableContent: rendering', () => {
  it('lets the renderer read only the images and symbols of a manual it resolved', async () => {
    const snapshot = new FakeSnapshot({
      ...content,
      manifests: [manifest('m', ['steps'])],
    });
    const symbols = new Map([['w001', 'symbols/w001.svg']]);
    snapshot.symbols = () => Promise.resolve(symbols);
    snapshot.file = (path: string) =>
      Promise.resolve(new TextEncoder().encode(path));
    const scoped = new ReadableContent(snapshot, READER, 'content.read');
    const resolution = await scoped.resolve('m', { model: 'small' }, 'en');
    if (!resolution) throw new Error('not resolved');
    const source = scoped.renderSource(resolution);
    expect(await source.asset('steps-image')).toEqual(new Uint8Array([1]));
    expect(await source.asset('internal-image')).toBeUndefined();
    expect(await source.file('symbols/w001.svg')).toBeDefined();
    expect(await source.file('openfolia.yaml')).toBeUndefined();
    expect(() => scoped.renderSource({ ...resolution })).toThrow();
    expect(() => as(READER).renderSource(resolution)).toThrow();
  });
});

describe('ReadableContent: readingKey', () => {
  it('is the same for the same scopes and differs for any other', () => {
    const key = (actor: Actor) => readable(content, actor).readingKey;
    expect(key(reader({ languages: ['de', 'en'] }))).toBe(
      key(reader({ languages: ['en', 'de'] })),
    );
    const keys = [
      READER,
      reader({ languages: ['de'] }),
      reader({ maxAudience: 'public' }),
      reader({ moduleTypes: ['concept'] }),
      reader({ facets: { region: ['north'] } }),
      reader({ facets: { region: ['south'] } }),
      reader({}, true),
    ].map(key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(readable(content, READER, 'content.read.draft').readingKey).not.toBe(
      key(READER),
    );
  });
});

describe('the configuration under its earlier name (#372)', () => {
  it('reads openfolia.yaml for a check, ccms.yaml where only that is there', async () => {
    const current = readable(content);
    const legacy = readable({ ...content, legacyConfigFile: true });
    expect(await current.configFileInEffect()).toBe('openfolia.yaml');
    expect(await legacy.configFileInEffect()).toBe('ccms.yaml');
    const bytes = await legacy.sourceForCheck('openfolia.yaml');
    expect(bytes).toEqual(await current.sourceForCheck('openfolia.yaml'));
    expect(await legacy.sourceForCheck('ccms.yaml')).toEqual(bytes);
    expect(await current.sourceForCheck('ccms.yaml')).toBeUndefined();
  });
});
