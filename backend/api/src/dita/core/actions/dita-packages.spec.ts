import { createHash } from 'node:crypto';
import { type Module, ProjectConfig } from '@openfolia/content-model';
import { unzipSync } from 'fflate';
import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import { FakeBlobStore } from '../../../../tests/fakes/fake-blob-store.js';
import {
  config as baseConfig,
  manifest,
  module,
} from '../../../../tests/fakes/fake-content.js';
import { FakeHistory } from '../../../../tests/fakes/fake-history.js';
import { FakeReleaseOutputStore } from '../../../../tests/fakes/fake-release-output-store.js';
import { FakeReleaseStore } from '../../../../tests/fakes/fake-release-store.js';
import {
  NotFoundError,
  TooManyRequestsError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { newReleaseId, type Release } from '../../../releases/core/release.js';
import type { ReleaseOutput } from '../../../releases/core/release-output.js';
import type { DitaOptions } from '../dita-package.js';
import {
  DitaPlans,
  GetDitaPackageAction,
  ListDitaPackagesAction,
  PLANS_MADE_AT_ONCE,
  PLANS_WAITING,
} from './dita-packages.action.js';

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
/** Stored in the blob store (its hash), and an image of the old layout, in the repository. */
const HASH = createHash('sha256').update(PNG).digest('hex');
const OLD = 'c'.repeat(64);
const GONE = 'b'.repeat(64);
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"/>',
);

const config = ProjectConfig.parse({
  ...baseConfig,
  moduleTypes: [
    { id: 'concept', label: 'Concept' },
    { id: 'snippet', label: 'Snippet', snippet: true },
  ],
  safetySymbols: [{ id: 'w001', label: 'Warning' }],
});

const withMedia: Module = {
  ...module('a'),
  blocks: [
    { type: 'paragraph', id: 'p', content: [{ type: 'text', text: 'A <&>.' }] },
    { type: 'image', id: 'i', asset: `sha256:${HASH}`, alt: 'Stored' },
    {
      type: 'image',
      id: 'o',
      asset: `sha256:${OLD}`,
      alt: 'In the repository',
    },
    { type: 'image', id: 'g', asset: `sha256:${GONE}`, alt: 'Gone' },
    {
      type: 'safety',
      id: 's',
      severity: 'warning',
      hazard: [{ type: 'text', text: 'Hot' }],
      symbols: ['w001'],
      blocks: [],
    },
    {
      type: 'variant',
      id: 'v',
      when: { op: 'in', attr: 'model', values: ['large'] },
      blocks: [
        {
          type: 'paragraph',
          id: 'vp',
          content: [{ type: 'text', text: 'Large.' }],
        },
      ],
    },
    { type: 'moduleRef', id: 'r', module: 'snippet' },
  ],
} as Module;
const snippet: Module = {
  ...module('snippet'),
  meta: { ...module('snippet').meta, type: 'snippet' },
};

function setup() {
  const history = new FakeHistory({
    config,
    modules: [withMedia, module('b'), module('b', 'de', 'Hallo.'), snippet],
    manifests: [manifest('m', ['a', 'b'])],
    assets: { [OLD]: PNG },
    symbols: { 'symbols/w001.svg': SVG },
  });
  const store = new FakeReleaseStore();
  const outputs = new FakeReleaseOutputStore();
  const blobs = new FakeBlobStore();
  const commit = history.heads.get('main') as string;
  history.tag('release/one/1.0', commit);
  const release: Release = {
    id: newReleaseId(Date.parse('2026-03-01T10:00:00Z')),
    product: 'one',
    productFacet: 'line',
    revision: '1.0',
    tag: 'release/one/1.0',
    tagObject: 'e'.repeat(40),
    commit,
    notes: null,
    notesByLanguage: {},
    major: false,
    publishedBy: { kind: 'user', id: 'sample-publisher' },
    publishedAt: new Date('2026-03-01T10:00:00Z'),
    withdrawal: null,
  };
  store.rows.push(release);
  const output = (over: Partial<ReleaseOutput> = {}): ReleaseOutput => {
    const row: ReleaseOutput = {
      id: crypto.randomUUID(),
      releaseId: release.id,
      manualId: 'm',
      variant: 'model=large',
      lang: 'en',
      kind: 'pdf',
      audience: 'public',
      state: 'queued',
      sha256: null,
      size: null,
      error: null,
      reusedFrom: null,
      attempts: 0,
      retries: 0,
      createdAt: release.publishedAt,
      updatedAt: release.publishedAt,
      finishedAt: null,
      scheduledAt: null,
      reuseGroup: null,
      promotedAt: null,
      qrCode: null,
      ...over,
    };
    outputs.rows.push(row);
    return row;
  };
  const plans = new DitaPlans(history.openSnapshot, blobs);
  const settings = { maxBytes: 2 ** 31 };
  return {
    history,
    store,
    outputs,
    blobs,
    release,
    output,
    plans,
    settings,
    list: new ListDitaPackagesAction(store, outputs, history.openSnapshot),
    get: new GetDitaPackageAction(
      store,
      outputs,
      history.openSnapshot,
      plans,
      settings,
      blobs,
    ),
  };
}

const DEFAULTS: DitaOptions = { languages: 'output', references: 'conref' };

async function bytesOf(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const text = (files: Record<string, Uint8Array>, name: string) =>
  Buffer.from(files[name] as Uint8Array).toString('utf8');

describe('GetDitaPackageAction', () => {
  it('packs the map, the topics, the media they show and the variant’s DITAVAL file', async () => {
    const t = setup();
    const stored = await t.blobs.put(
      (async function* () {
        yield PNG;
      })(),
      { contentType: 'image/png', maxBytes: 1_000 },
    );
    expect(stored.sha256).toBe(HASH);

    const out = t.output();
    const made = await t.get.handle({
      actor: READER,
      releaseId: t.release.id,
      packageId: out.id,
      options: DEFAULTS,
    });
    expect(made.fileName).toBe('m_model-large_en_1.0-dita.zip');
    const zip = await bytesOf(made.stream());
    expect(zip.length).toBe(made.size);
    const files = unzipSync(zip);
    expect(Object.keys(files)).toEqual([
      'en/a.dita',
      'en/b.dita',
      'en/m.ditamap',
      'en/snippet.dita',
      'filters/model-large.ditaval',
      `images/${HASH}.png`,
      `images/${OLD}.png`,
      'symbols/w001.svg',
    ]);
    expect(Buffer.from(files[`images/${OLD}.png`] as Uint8Array)).toEqual(
      Buffer.from(PNG),
    );
    expect(Buffer.from(files['symbols/w001.svg'] as Uint8Array)).toEqual(
      Buffer.from(SVG),
    );
    const topic = text(files, 'en/a.dita');
    expect(topic).toContain('A &lt;&amp;&gt;.');
    expect(topic).toContain('<div id="v" props="model(large)">');
    expect(topic).toContain('conref="snippet.dita#snippet/p"');
    expect(text(files, 'en/m.ditamap')).toContain(
      '<ditavalref href="../filters/model-large.ditaval"/>',
    );
    expect(text(files, 'filters/model-large.ditaval')).toContain(
      '<prop att="model" val="large" action="include"/>',
    );
    expect(made.plan.warnings.map((w) => w.code)).toContain('missing-asset');
    expect(made.plan.topics).toBe(3);
    expect(made.plan.media).toBe(3);
  });

  it('packs a derived manual (#451) as the modules it gathers, with its source’s text attributes as keys', async () => {
    const t = setup();
    const safety = (id: string): Module => ({
      ...module(id),
      meta: { ...module(id).meta, type: 'safety' },
    });
    const commit = t.history.onMain({
      config: ProjectConfig.parse({
        ...config,
        moduleTypes: [
          ...config.moduleTypes,
          { id: 'safety', label: 'Safety', safety: true },
        ],
        textAttributes: [{ id: 'product-name', label: 'Product name' }],
      }),
      modules: [module('a'), safety('s')],
      manifests: [
        {
          ...manifest('m', ['a', 's']),
          attributes: { 'product-name': 'Machine' },
        },
        {
          ...manifest('leaflet', []),
          kind: 'derived',
          rule: { source: 'm', exclude: [], front: [], back: [] },
        },
      ],
    }).commit;
    t.history.tag('release/one/1.1', commit);
    const release = {
      ...t.release,
      id: newReleaseId(),
      commit,
      revision: '1.1',
      tag: 'release/one/1.1',
    };
    t.store.rows.push(release);
    const out = t.output({ releaseId: release.id, manualId: 'leaflet' });
    const made = await t.get.handle({
      actor: READER,
      releaseId: release.id,
      packageId: out.id,
      options: DEFAULTS,
    });
    const files = unzipSync(await bytesOf(made.stream()));
    expect(Object.keys(files)).toEqual([
      'en/leaflet.ditamap',
      'en/s.dita',
      'filters/model-large.ditaval',
    ]);
    const map = text(files, 'en/leaflet.ditamap');
    expect(map).toContain('<keydef keys="product-name">');
    expect(map).toContain('<keyword>Machine</keyword>');
  });

  it('makes the same bytes for the same output and options', async () => {
    const t = setup();
    const out = t.output();
    const ask = async (options: DitaOptions) =>
      bytesOf(
        (
          await t.get.handle({
            actor: READER,
            releaseId: t.release.id,
            packageId: out.id,
            options,
          })
        ).stream(),
      );
    expect(await ask(DEFAULTS)).toEqual(await ask(DEFAULTS));
    const resolved = unzipSync(
      await ask({ languages: 'output', references: 'resolved' }),
    );
    expect(text(resolved, 'en/a.dita')).not.toContain('conref');
  });

  it('holds every language the reader may read with languages=all, falling back to the source', async () => {
    const t = setup();
    const out = t.output();
    const made = await t.get.handle({
      actor: READER,
      releaseId: t.release.id,
      packageId: out.id,
      options: { languages: 'all', references: 'conref' },
    });
    expect(made.fileName).toBe('m_model-large_all_1.0-dita.zip');
    expect(made.plan.languages).toEqual(['en', 'de']);
    const files = unzipSync(await bytesOf(made.stream()));
    expect(text(files, 'de/b.dita')).toContain('Hallo.');
    expect(text(files, 'de/a.dita')).toContain('xml:lang="en"');
    expect(
      made.plan.warnings.some(
        (w) => w.code === 'missing-translation' && w.lang === 'de',
      ),
    ).toBe(true);

    // A reader of English only gets English only.
    const english = actorWith(['content.read'], { languages: ['en'] });
    const theirs = await t.get.handle({
      actor: english,
      releaseId: t.release.id,
      packageId: out.id,
      options: { languages: 'all', references: 'conref' },
    });
    expect(theirs.plan.languages).toEqual(['en']);
  });

  it('is 404 for a reader who may not read the output, or another release’s', async () => {
    const t = setup();
    const out = t.output();
    for (const actor of [
      actorWith(['content.read'], { moduleTypes: ['concept'] }),
      actorWith(['content.read'], { languages: ['de'] }),
    ]) {
      await expect(
        t.get.handle({
          actor,
          releaseId: t.release.id,
          packageId: out.id,
          options: DEFAULTS,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
    const other = t.output({ releaseId: newReleaseId() });
    await expect(
      t.get.handle({
        actor: READER,
        releaseId: t.release.id,
        packageId: other.id,
        options: DEFAULTS,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a package past the archive’s limit', async () => {
    const t = setup();
    const out = t.output();
    (t.settings as { maxBytes: number }).maxBytes = 100;
    const error = await t.get
      .handle({
        actor: READER,
        releaseId: t.release.id,
        packageId: out.id,
        options: DEFAULTS,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnprocessableError);
    expect((error as UnprocessableError).code).toBe('dita-package-too-large');
  });

  it('makes at most two at once, and refuses more than wait', async () => {
    const t = setup();
    const outs = Array.from(
      { length: PLANS_MADE_AT_ONCE + PLANS_WAITING + 1 },
      () => t.output(),
    );
    const results = await Promise.allSettled(
      outs.map((o) =>
        t.get.handle({
          actor: READER,
          releaseId: t.release.id,
          packageId: o.id,
          options: DEFAULTS,
        }),
      ),
    );
    const refused = results.filter(
      (r) =>
        r.status === 'rejected' && r.reason instanceof TooManyRequestsError,
    );
    expect(refused).toHaveLength(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(
      outs.length - 1,
    );
  });
});

describe('ListDitaPackagesAction', () => {
  it('lists one package per output the reader may read, paged', async () => {
    const t = setup();
    const out = t.output();
    t.output({ lang: 'de', audience: 'public' });
    const page = await t.list.handle({
      actor: actorWith(['content.read'], { languages: ['en'] }),
      releaseId: t.release.id,
      filter: {},
      page: { number: 1, size: 10 },
    });
    expect(page.items.map((o) => o.id)).toEqual([out.id]);
    expect(page.total).toBe(1);
  });
});
