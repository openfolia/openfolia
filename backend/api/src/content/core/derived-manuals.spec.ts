import {
  type Manifest,
  type Module,
  ProjectConfig,
} from '@openfolia/content-model';
import { actorWith } from '../../../tests/fakes/actors.js';
import {
  config as baseConfig,
  FakeSnapshot,
  manifest,
  module,
  readable,
} from '../../../tests/fakes/fake-content.js';
import { DerivedManuals } from './derived-manuals.js';

const config = ProjectConfig.parse({
  ...baseConfig,
  moduleTypes: [
    { id: 'concept', label: 'Concept' },
    { id: 'safety', label: 'Safety', safety: true },
  ],
  textAttributes: [{ id: 'product-name', label: 'Product name' }],
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
});

const typed = (id: string, type: string, lang = 'en'): Module => {
  const m = module(id, lang);
  return {
    ...m,
    meta: { ...m.meta, type },
    blocks: [
      {
        type: 'paragraph',
        id: 'p',
        content: [
          { type: 'text', text: `${id} for ` },
          { type: 'attribute', name: 'product-name' },
        ],
      },
    ],
  };
};

const source: Manifest = {
  ...manifest('operating', ['intro', 'hazards', 'pinch']),
  attributes: { 'product-name': 'Machine' },
  entries: [
    { module: 'intro' },
    { module: 'hazards' },
    { module: 'pinch', when: { op: 'in', attr: 'model', values: ['large'] } },
  ],
};
const leaflet: Manifest = {
  ...manifest('leaflet', []),
  kind: 'derived',
  rule: { source: 'operating', exclude: [], front: ['cover'], back: [] },
};
const content = (manifests: Manifest[] = [source, leaflet]) =>
  new FakeSnapshot({
    config,
    manifests,
    modules: [
      typed('intro', 'concept'),
      typed('hazards', 'safety'),
      typed('hazards', 'safety', 'de'),
      typed('pinch', 'safety'),
      typed('cover', 'concept'),
    ],
  });

describe('DerivedManuals (#451)', () => {
  it('gathers a derived manual from its source, once per snapshot, and leaves an assembled one alone', async () => {
    const files = content();
    const reads = vi.spyOn(files, 'manifest');
    const derived = DerivedManuals.of(files);
    expect(DerivedManuals.of(derived)).toBe(derived);
    const got = await derived.manifest('leaflet');
    expect(got?.entries).toEqual([
      { module: 'cover' },
      { module: 'hazards' },
      {
        module: 'pinch',
        when: { op: 'in', attr: 'model', values: ['large'] },
      },
    ]);
    // Its stored attributes stay its own.
    expect(got?.attributes).toEqual({});
    expect(await derived.manifest('operating')).toBe(source);
    const before = reads.mock.calls.length;
    await derived.manifest('leaflet');
    await derived.derivationIssues('leaflet');
    // The leaflet's own file again, not its source.
    expect(reads.mock.calls.length - before).toBe(2);
    expect(await derived.isDerived('leaflet')).toBe(true);
    expect(await derived.isDerived('operating')).toBe(false);
    expect(await derived.isDerived('nope')).toBe(false);
  });

  it('resolves it per variant with its source’s text attributes', async () => {
    const reader = readable(content());
    const small = await reader.resolve('leaflet', { model: 'small' }, 'de');
    expect(
      small?.manual.entries.map((e) =>
        e.kind === 'module' ? `${e.module}:${e.lang}` : e.title,
      ),
    ).toEqual(['cover:en', 'hazards:de']);
    expect(JSON.stringify(small?.manual.entries)).toContain('Machine');
    const large = await reader.resolve('leaflet', { model: 'large' }, 'en');
    expect(
      large?.manual.entries.map((e) => e.kind === 'module' && e.module),
    ).toEqual(['cover', 'hazards', 'pinch']);
  });

  it('lists what deriving found as the manual’s issues, naming only modules the reader may see', async () => {
    const excluding: Manifest = {
      ...leaflet,
      rule: { ...leaflet.rule!, exclude: ['pinch', 'gone'] },
    };
    const everyone = await readable(content([source, excluding])).manual(
      'leaflet',
    );
    expect(everyone?.issues.map((i) => [i.code, i.at])).toEqual([
      ['safety-module-excluded', 'pinch'],
      ['unknown-excluded-module', 'gone'],
    ]);
    expect(everyone?.manifest.rule?.exclude).toEqual(['pinch', 'gone']);

    // A reader of concepts only: the safety modules are not named to them.
    const conceptsOnly = actorWith(['content.read'], {
      moduleTypes: ['concept'],
    });
    const scoped = await readable(
      content([source, excluding]),
      conceptsOnly,
    ).manual('leaflet');
    expect(JSON.stringify(scoped)).not.toContain('pinch');
    expect(JSON.stringify(scoped)).not.toContain('hazards');
    expect(scoped?.manifest.entries).toEqual([{ module: 'cover' }]);
    // A module with no file hides nothing.
    expect(scoped?.manifest.rule?.exclude).toEqual(['gone']);
  });

  it('reports a missing source', async () => {
    const got = await readable(content([leaflet])).manual('leaflet');
    expect(got?.manifest.entries).toEqual([{ module: 'cover' }]);
    expect(got?.issues.map((i) => [i.severity, i.code])).toEqual([
      ['error', 'unknown-source-manual'],
    ]);
  });

  it('treats a source the reader may not see as missing: no entries, attributes or issues from it', async () => {
    const internal: Manifest = { ...source, audience: 'internal' };
    const publicLeaflet: Manifest = {
      ...leaflet,
      audience: 'public',
      rule: { ...leaflet.rule!, exclude: ['pinch', 'gone'] },
    };
    const files = () => content([internal, publicLeaflet]);
    const publicOnly = actorWith(['content.read'], { maxAudience: 'public' });
    const reader = readable(files(), publicOnly);
    const got = await reader.manual('leaflet');
    expect(got?.manifest.entries).toEqual([{ module: 'cover' }]);
    // One issue, worded as for a source that does not exist.
    const missing = await readable(content([publicLeaflet])).manual('leaflet');
    expect(got?.issues).toEqual(missing?.issues);
    expect(got?.issues.map((i) => i.code)).toEqual(['unknown-source-manual']);
    const resolved = await reader.resolve('leaflet', { model: 'large' }, 'en');
    expect(resolved?.manifest.attributes).toEqual({});
    expect(JSON.stringify(resolved)).not.toContain('Machine');
    expect(JSON.stringify(resolved)).not.toContain('hazards');
    expect(await reader.textAttributesOf(publicLeaflet)).toEqual({});

    // A reader of every audience: for a wider audience than its source's, it gathers
    // nothing for anyone.
    const everyone = await readable(files()).manual('leaflet');
    expect(everyone?.manifest.entries).toEqual([{ module: 'cover' }]);
    expect(everyone?.issues.map((i) => [i.severity, i.code])).toEqual([
      ['error', 'derived-audience-wider'],
    ]);
    expect(
      (await readable(files()).resolve('leaflet', { model: 'large' }, 'en'))
        ?.manifest.attributes,
    ).toEqual({});

    // And whatever the audiences, a source the reader may not see is gathered from as none.
    const blind = DerivedManuals.of(content(), async () => false);
    expect((await blind.manifest('leaflet'))?.entries).toEqual([
      { module: 'cover' },
    ]);
    expect(await blind.textAttributes(leaflet)).toEqual({});
    expect(await blind.derivationIssues('leaflet')).toEqual(
      await DerivedManuals.of(content([leaflet])).derivationIssues('leaflet'),
    );
    // A gathering for one reader is never another's.
    const shared = DerivedManuals.of(content());
    expect(DerivedManuals.of(shared, async () => false)).not.toBe(shared);
  });

  it('warns that nothing is gathered when nothing gathered is one the reader may see', async () => {
    const conceptsOnly = actorWith(['content.read'], {
      moduleTypes: ['concept'],
    });
    const got = await readable(content(), conceptsOnly).manual('leaflet');
    expect(got?.manifest.entries).toEqual([{ module: 'cover' }]);
    expect(got?.issues.map((i) => i.code)).toEqual(['empty-derived-manual']);
    const empty = await readable(
      content([
        source,
        {
          ...leaflet,
          rule: {
            ...leaflet.rule!,
            moduleTypes: ['concept'],
            exclude: ['intro'],
          },
        },
      ]),
    ).manual('leaflet');
    expect(
      empty?.issues.find((i) => i.code === 'empty-derived-manual'),
    ).toEqual(got?.issues[0]);
  });
});

describe('a derived manual’s revision (#451)', () => {
  it('is its file’s, not what it gathers: a change to its source is no version of it', async () => {
    const before = await readable(content()).manualRevision('leaflet');
    const moved: Manifest = {
      ...source,
      entries: [{ module: 'pinch' }, { module: 'hazards' }],
    };
    expect(
      await readable(content([moved, leaflet])).manualRevision('leaflet'),
    ).toBe(before);
    const retitled: Manifest = { ...leaflet, title: 'Other' };
    expect(
      await readable(content([source, retitled])).manualRevision('leaflet'),
    ).not.toBe(before);
  });
});
