import {
  type Manifest,
  type Module,
  parseCondition,
  ProjectConfig,
  type Safety,
} from '@openfolia/content-model';
import { actorWith, READER } from '../../../tests/fakes/actors.js';
import {
  config as baseConfig,
  manifest,
  module,
} from '../../../tests/fakes/fake-content.js';
import { FakeHistory } from '../../../tests/fakes/fake-history.js';
import {
  fakeModuleIndex,
  referring,
} from '../../../tests/fakes/fake-module-index-store.js';
import type { Actor } from '../../access/core/actor.js';

const config = ProjectConfig.parse({
  ...baseConfig,
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
});
const internal = (m: Module): Module => ({
  ...m,
  meta: { ...m.meta, audience: 'internal' },
});
const internalManual = (m: Manifest): Manifest => ({
  ...m,
  audience: 'internal',
});

/**
 * `shared` is in manual `guide` directly and through `wrapper` (which the
 * manual includes and which refers to `shared`); `secret` (internal)
 * refers to `shared`, and the internal manual `hidden` includes `bridge`
 * (internal), which refers to `shared` too. `lonely` is used nowhere.
 */
const content = {
  config,
  modules: [
    module('shared'),
    module('shared', 'de'),
    referring(module('wrapper'), 'shared'),
    internal(referring(module('secret'), 'shared')),
    internal(referring(module('bridge'), 'shared')),
    module('lonely'),
    referring(module('loop'), 'loop'),
  ],
  manifests: [
    manifest('guide', ['wrapper', 'shared']),
    manifest('indirect', ['bridge']),
    internalManual(manifest('hidden', ['shared'])),
  ],
};

async function usage(actor: Actor, id: string) {
  const history = new FakeHistory(content);
  const { readable } = fakeModuleIndex(history);
  const snapshot = await history.openSnapshot.handle({ actor, ref: 'main' });
  return (await readable.of(snapshot)).usage(id);
}

const publicReader = actorWith(['content.read'], { maxAudience: 'public' });

describe('ReadableModuleIndex', () => {
  it('names the manuals including a module, directly or through references, and the modules referring to it', async () => {
    expect(await usage(READER, 'shared')).toEqual({
      manuals: 3,
      modules: 3,
      uses: [
        {
          kind: 'manual',
          id: 'guide',
          title: 'Manual guide',
          direct: true,
          deprecated: false,
        },
        {
          kind: 'manual',
          id: 'hidden',
          title: 'Manual hidden',
          direct: true,
          deprecated: false,
        },
        {
          kind: 'manual',
          id: 'indirect',
          title: 'Manual indirect',
          direct: false,
          deprecated: false,
        },
        {
          kind: 'module',
          id: 'bridge',
          title: 'Title of bridge',
          direct: true,
          deprecated: false,
        },
        {
          kind: 'module',
          id: 'secret',
          title: 'Title of secret',
          direct: true,
          deprecated: false,
        },
        {
          kind: 'module',
          id: 'wrapper',
          title: 'Title of wrapper',
          direct: true,
          deprecated: false,
        },
      ],
    });
  });

  it('says which manuals and modules using it are deprecated (#266)', async () => {
    const deprecated = { reason: 'Superseded.' };
    const history = new FakeHistory({
      ...content,
      modules: [
        module('shared'),
        {
          ...referring(module('wrapper'), 'shared'),
          meta: { ...module('wrapper').meta, deprecated },
        },
        // A translation's own deprecation is not the module's.
        {
          ...referring(module('wrapper', 'de'), 'shared'),
          meta: { ...module('wrapper', 'de').meta },
        },
      ],
      manifests: [
        { ...manifest('guide', ['shared']), deprecated },
        manifest('indirect', ['wrapper']),
      ],
    });
    const { readable } = fakeModuleIndex(history);
    const snapshot = await history.openSnapshot.handle({
      actor: READER,
      ref: 'main',
    });
    const uses = (await readable.of(snapshot)).usage('shared').uses;
    expect(uses.map((u) => [u.kind, u.id, u.deprecated])).toEqual([
      ['manual', 'guide', true],
      ['manual', 'indirect', false],
      ['module', 'wrapper', true],
    ]);
  });

  it('counts a manual once, as direct, when it also includes the module through a reference', async () => {
    const found = await usage(READER, 'shared');
    expect(found.uses.filter((u) => u.id === 'guide')).toHaveLength(1);
  });

  it('never names or counts a manual or module the reader may not see, nor a use through one', async () => {
    // Not `hidden` (an internal manual), not `secret` or `bridge` (internal
    // modules), and not `indirect`, which uses it only through `bridge`.
    expect(await usage(publicReader, 'shared')).toEqual({
      manuals: 1,
      modules: 1,
      uses: [
        {
          kind: 'manual',
          id: 'guide',
          title: 'Manual guide',
          direct: true,
          deprecated: false,
        },
        {
          kind: 'module',
          id: 'wrapper',
          title: 'Title of wrapper',
          direct: true,
          deprecated: false,
        },
      ],
    });
  });

  it('only judges by what the reader may see in each language', async () => {
    const germanReader = actorWith(['content.read'], { languages: ['de'] });
    // Only `shared` has a German file; every user is English.
    expect(await usage(germanReader, 'shared')).toMatchObject({
      modules: 0,
    });
  });

  it('gives an unused module, and a module referring to itself, no uses', async () => {
    expect(await usage(READER, 'lonely')).toEqual({
      manuals: 0,
      modules: 0,
      uses: [],
    });
    expect((await usage(READER, 'loop')).uses).toEqual([]);
  });

  it('lists only the module files the reader may see', async () => {
    const history = new FakeHistory(content);
    const { readable } = fakeModuleIndex(history);
    const snapshot = await history.openSnapshot.handle({
      actor: publicReader,
      ref: 'main',
    });
    const view = await readable.of(snapshot);
    expect(view.modules.map((m) => `${m.lang}/${m.id}`)).toEqual([
      'en/lonely',
      'en/loop',
      'de/shared',
      'en/shared',
      'en/wrapper',
    ]);
  });

  it('names an entry condition of a manual only where the entry covers a module the reader may see (#91)', async () => {
    const conditioned: Manifest = {
      ...manifest('conditioned', []),
      variants: [{ model: 'small' }],
      entries: [
        { module: 'shared', when: parseCondition('market in (eu)') },
        { module: 'secret', when: parseCondition('market in (us)') },
        {
          title: 'Hidden chapter',
          when: parseCondition('colour in (red)'),
          entries: [{ module: 'bridge' }],
        },
        {
          title: 'Mixed chapter',
          when: parseCondition('colour in (blue)'),
          entries: [{ module: 'bridge' }, { module: 'nowhere' }],
        },
      ],
    };
    const history = new FakeHistory({
      ...content,
      manifests: [...content.manifests, conditioned],
    });
    const { readable } = fakeModuleIndex(history);
    const variantsFor = async (actor: Actor) => {
      const snapshot = await history.openSnapshot.handle({
        actor,
        ref: 'main',
      });
      const view = await readable.of(snapshot);
      const found = view.manuals.find((m) => m.id === 'conditioned');
      expect(found).not.toHaveProperty('entryVariants');
      return found?.variants;
    };
    // `secret` and `bridge` are internal; `nowhere` has no file, so naming it hides nothing.
    expect(await variantsFor(publicReader)).toEqual({
      colour: ['blue'],
      market: ['eu'],
      model: ['small'],
    });
    expect(await variantsFor(READER)).toEqual({
      colour: ['blue', 'red'],
      market: ['eu', 'us'],
      model: ['small'],
    });
  });
});

describe('ReadableModuleIndex, a derived manual (#451)', () => {
  // For its source's audience: a derived manual is never for a wider one (it gathers nothing then).
  const leaflet: Manifest = {
    ...internalManual(manifest('leaflet', [])),
    kind: 'derived',
    rule: {
      source: 'hidden',
      moduleTypes: ['concept'],
      exclude: [],
      front: ['lonely'],
      back: [],
    },
  };
  const withLeaflet = {
    ...content,
    manifests: [...content.manifests, leaflet],
  };
  const uses = async (actor: Actor, id: string) => {
    const history = new FakeHistory(withLeaflet);
    const { readable } = fakeModuleIndex(history);
    const snapshot = await history.openSnapshot.handle({ actor, ref: 'main' });
    return (await readable.of(snapshot))
      .usage(id)
      .uses.filter((u) => u.kind === 'manual')
      .map((u) => u.id);
  };

  it('lists what it gathers for its readers, and nothing of it for anyone else', async () => {
    expect(await uses(READER, 'shared')).toContain('leaflet');
    expect(await uses(READER, 'lonely')).toEqual(['leaflet']);
    // The source is internal: a public reader learns nothing it holds.
    expect(await uses(publicReader, 'shared')).not.toContain('leaflet');
    expect(await uses(publicReader, 'lonely')).toEqual([]);
  });

  it('gathers nothing for a wider audience than its source’s', async () => {
    const wide = { ...leaflet, audience: 'public' };
    const history = new FakeHistory({
      ...content,
      manifests: [...content.manifests, wide],
    });
    const { readable } = fakeModuleIndex(history);
    const snapshot = await history.openSnapshot.handle({
      actor: publicReader,
      ref: 'main',
    });
    const view = await readable.of(snapshot);
    expect(view.usage('shared').uses.map((u) => u.id)).not.toContain('leaflet');
    expect(view.usage('lonely').uses.map((u) => u.id)).toEqual(['leaflet']);
  });
});

describe('ReadableModuleIndex, a derived manual gathering notices (#670)', () => {
  const noticed = (m: Module, severity: Safety['severity']): Module => ({
    ...m,
    blocks: [
      {
        type: 'safety',
        id: 'notice',
        severity,
        hazard: [{ type: 'text', text: 'Hazard' }],
        symbols: [],
        blocks: [],
      },
    ],
  });
  // `pointer` (public) holds no notice itself: only `hazard` (internal), which it refers to.
  const notices = {
    config,
    modules: [
      referring(module('pointer'), 'hazard'),
      internal(noticed(module('hazard'), 'danger')),
      noticed(module('own'), 'warning'),
    ],
    manifests: [
      {
        ...manifest('source', []),
        entries: [
          { module: 'pointer', when: parseCondition('market in (us)') },
          { module: 'own', when: parseCondition('market in (eu)') },
        ],
      },
      {
        ...manifest('notices', []),
        kind: 'derived',
        rule: {
          source: 'source',
          exclude: [],
          front: [],
          back: [],
          notices: { groupBy: 'level' },
        },
      } as Manifest,
    ],
  };
  const view = async (actor: Actor) => {
    const history = new FakeHistory(notices);
    const { readable } = fakeModuleIndex(history);
    const snapshot = await history.openSnapshot.handle({ actor, ref: 'main' });
    return readable.of(snapshot);
  };

  it('names its modules and their conditions as the reader gathers them, not as gathered for everyone', async () => {
    const theirs = (await view(publicReader)).manuals.find(
      (m) => m.id === 'notices',
    );
    // That `pointer` leads to a notice they may not see shows neither as a use nor as a condition.
    expect(theirs?.modules).toEqual(['own']);
    expect(theirs?.variants).toEqual({
      market: ['eu'],
      model: ['large', 'small'],
    });
    expect((await view(publicReader)).usage('pointer').uses).toEqual([
      expect.objectContaining({ id: 'source' }),
    ]);
    const all = (await view(READER)).manuals.find((m) => m.id === 'notices');
    expect(all?.modules).toEqual(['pointer', 'own']);
    expect(all?.variants).toEqual({
      market: ['eu', 'us'],
      model: ['large', 'small'],
    });
  });
});
