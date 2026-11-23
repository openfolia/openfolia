import {
  type Manifest,
  type Module,
  ProjectConfig,
  type Safety,
  walk,
} from '@openfolia/content-model';
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
import { schemaProblems } from '../../../../tests/iirds/iirds-schema.js';
import type { ManualResolution } from '../../../content/core/content.repository.js';
import {
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { ResolveManualAction } from '../../../manuals/core/actions/resolve-manual.action.js';
import {
  type HtmlFragment,
  HtmlRenderer,
  type HtmlRenderOptions,
} from '../../../preview/core/html-renderer.js';
import { newReleaseId, type Release } from '../../../releases/core/release.js';
import {
  outputFileName,
  type ReleaseOutput,
} from '../../../releases/core/release-output.js';
import {
  GetIirdsPackageAction,
  IirdsPlans,
  ListIirdsPackagesAction,
} from './iirds-packages.action.js';

const HASH = 'a'.repeat(64);
const GONE = 'b'.repeat(64);
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

const mapping = {
  baseIri: 'https://docs.example.com/',
  documentTypes: ['OperatingInstructions'],
  moduleTypes: { concept: 'GenericConcept' },
  audiences: { public: 'Role' },
  facets: { line: 'ProductVariant' },
  variantAttributes: { model: 'ProductVariant' },
};
const config = (iirds: unknown = mapping) =>
  ProjectConfig.parse({
    ...baseConfig,
    facets: [
      { id: 'line', label: 'Line', values: [{ id: 'one', label: 'One' }] },
      { id: 'phase', label: 'Phase', values: [{ id: 'use', label: 'Use' }] },
    ],
    ...(iirds !== null && { iirds }),
  });

const withImage: Module = {
  ...module('a'),
  meta: { ...module('a').meta, facets: { phase: ['use'] } },
  blocks: [
    { type: 'paragraph', id: 'p', content: [{ type: 'text', text: 'A.' }] },
    { type: 'image', id: 'i', asset: `sha256:${HASH}`, alt: 'A picture' },
    { type: 'image', id: 'j', asset: `sha256:${GONE}`, alt: 'Gone' },
  ],
} as Module;

/** Writes the title and the files it was asked for, as the renderer reports them. */
class StubRenderer extends HtmlRenderer {
  manual(): HtmlFragment {
    return { html: '' };
  }
  module(
    resolution: ManualResolution,
    id: string,
    options: HtmlRenderOptions,
  ): HtmlFragment | undefined {
    const entry = resolution.manual.entries.find(
      (e) => e.kind === 'module' && e.module === id,
    );
    if (!entry || entry.kind !== 'module') return undefined;
    const assets: string[] = [];
    for (const found of walk(entry.blocks)) {
      if (found.kind === 'block' && found.node.type === 'image') {
        assets.push(found.node.asset);
      }
    }
    const other = id === 'a' ? 'b' : 'a';
    const anchor = resolution.manual.anchors[other];
    const link = options.xrefHref?.({
      module: other,
      ...(anchor !== undefined && { id: anchor }),
    });
    return {
      html: `<p>${id} <&> ${assets.map((a) => options.assetUrl(a.slice(7))).join(' ')} blocks:${entry.blocks.map((b) => b.id).join(',')} link:${link ?? '-'}</p>`,
      assets,
    };
  }
}

function setup(
  iirds: unknown = mapping,
  content: { modules: Module[]; manifests: Manifest[] } = {
    modules: [withImage, module('b')],
    manifests: [manifest('m', ['a', 'b'])],
  },
) {
  const history = new FakeHistory({
    config: config(iirds),
    ...content,
    assets: { [HASH]: PNG },
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
      variant: 'model=small',
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
  const plans = new IirdsPlans(
    history.openSnapshot,
    new ResolveManualAction(),
    new StubRenderer(),
    blobs,
  );
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
    list: new ListIirdsPackagesAction(store, outputs, history.openSnapshot),
    get: new GetIirdsPackageAction(
      store,
      outputs,
      history.openSnapshot,
      plans,
      settings,
      blobs,
    ),
  };
}

async function bytesOf(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('GetIirdsPackageAction', () => {
  it('gives a module of a manual of notices grouped by level one topic with its notices of every level (#670)', async () => {
    const notice = (id: string, severity: Safety['severity']): Safety => ({
      type: 'safety',
      id,
      severity,
      hazard: [{ type: 'text', text: id }],
      symbols: [],
      blocks: [],
    });
    const a: Module = {
      ...module('a'),
      blocks: [notice('crush', 'danger'), notice('hot', 'caution')],
    } as Module;
    const b: Module = {
      ...module('b'),
      blocks: [notice('acid', 'danger')],
    } as Module;
    const notices = {
      ...manifest('m', []),
      kind: 'derived',
      rule: {
        source: 'src',
        exclude: [],
        front: [],
        back: [],
        notices: { groupBy: 'level' },
      },
    } as Manifest;
    const t = setup(mapping, {
      modules: [a, b],
      manifests: [manifest('src', ['a', 'b']), notices],
    });
    const out = t.output();
    const made = await t.get.handle({
      actor: READER,
      releaseId: t.release.id,
      packageId: out.id,
    });
    const files = unzipSync(await bytesOf(made.stream()));
    expect(Object.keys(files).filter((f) => f.startsWith('content/'))).toEqual([
      'content/a.html',
      'content/b.html',
    ]);
    expect(
      Buffer.from(files['content/a.html'] as Uint8Array).toString(),
    ).toContain('blocks:a--crush,a--hot ');
  });

  it('packs the topics, the media they show and the PDF once done, with metadata the schema allows', async () => {
    const t = setup();
    const pdf = new TextEncoder().encode('%PDF-1.7 sample');
    const stored = await t.blobs.put(
      (async function* () {
        yield pdf;
      })(),
      { contentType: 'application/pdf', maxBytes: 1_000 },
    );
    const out = t.output({
      state: 'done',
      sha256: stored.sha256,
      size: pdf.length,
    });
    const made = await t.get.handle({
      actor: READER,
      releaseId: t.release.id,
      packageId: out.id,
    });
    expect(made.fileName).toBe('m_model-small_en_1.0.iirds');
    expect(made.plan.warnings.map((w) => `${w.code} ${w.id}`)).toEqual([
      `missing-asset sha256:${GONE}`,
      'unmapped-facet phase',
    ]);
    const zip = await bytesOf(made.stream());
    expect(zip.length).toBe(made.size);
    const files = unzipSync(zip);
    expect(Object.keys(files)).toEqual([
      'mimetype',
      'META-INF/metadata.rdf',
      'content/a.html',
      'content/b.html',
      `media/${HASH}.png`,
      `pdf/${outputFileName(out, '1.0')}`,
    ]);
    expect(Buffer.from(files[`media/${HASH}.png`] as Uint8Array)).toEqual(
      Buffer.from(PNG),
    );
    expect(
      Buffer.from(files[`pdf/${outputFileName(out, '1.0')}`] as Uint8Array),
    ).toEqual(Buffer.from(pdf));
    const html = Buffer.from(files['content/a.html'] as Uint8Array).toString();
    expect(html).toContain(`../media/${HASH}.png`);
    expect(html).toContain('<title>Title of a</title>');
    // A cross-reference to another topic links its file.
    expect(html).toMatch(/link:b\.html#of-[a-z0-9-]+</);
    const rdf = Buffer.from(
      files['META-INF/metadata.rdf'] as Uint8Array,
    ).toString();
    expect(schemaProblems(rdf)).toEqual([]);
    expect(rdf).toContain('<iirds:format>application/pdf</iirds:format>');
    // The same output makes the same bytes, from the plan kept.
    const again = await t.get.handle({
      actor: READER,
      releaseId: t.release.id,
      packageId: out.id,
    });
    expect(again.plan).toBe(made.plan);
    expect((await bytesOf(again.stream())).equals(zip)).toBe(true);
    // And a package made again, by another server, too.
    const fresh = new GetIirdsPackageAction(
      t.store,
      t.outputs,
      t.history.openSnapshot,
      new IirdsPlans(
        t.history.openSnapshot,
        new ResolveManualAction(),
        new StubRenderer(),
        t.blobs,
      ),
      t.settings,
      t.blobs,
    );
    const remade = await fresh.handle({
      actor: READER,
      releaseId: t.release.id,
      packageId: out.id,
    });
    expect(remade.plan).not.toBe(made.plan);
    expect((await bytesOf(remade.stream())).equals(zip)).toBe(true);
  });

  it('leaves the PDF out until it is done, and marks a withdrawn release’s document withdrawn', async () => {
    const t = setup();
    const out = t.output();
    const made = await t.get.handle({
      actor: READER,
      releaseId: t.release.id,
      packageId: out.id,
    });
    expect(made.plan.pdf).toBe(false);
    expect(made.plan.warnings.map((w) => w.code)).toContain('pdf-not-included');
    t.store.withdrawals.set(t.release.id, {
      at: new Date('2026-04-01T00:00:00Z'),
      by: { kind: 'user', id: 'sample-publisher' },
      reason: 'Wrong',
    });
    const withdrawn = await t.get.handle({
      actor: READER,
      releaseId: t.release.id,
      packageId: out.id,
    });
    const rdf = Buffer.from(
      unzipSync(await bytesOf(withdrawn.stream()))[
        'META-INF/metadata.rdf'
      ] as Uint8Array,
    ).toString();
    expect(rdf).toContain('iirds#Withdrawn');
    expect(rdf).toContain('2026-04-01T00:00:00Z');
  });

  it('is 404 for a reader who may not read the output, or another release’s, before making anything', async () => {
    const t = setup();
    const out = t.output();
    const spy = vi.spyOn(t.plans, 'plan');
    for (const actor of [
      actorWith(['content.read'], { moduleTypes: ['concept'] }),
      actorWith(['content.read'], { languages: ['de'] }),
    ]) {
      await expect(
        t.get.handle({ actor, releaseId: t.release.id, packageId: out.id }),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
    const other = t.output({ releaseId: newReleaseId() });
    await expect(
      t.get.handle({
        actor: READER,
        releaseId: t.release.id,
        packageId: other.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a release without a mapping, and a package past the limit', async () => {
    const bare = setup(null);
    const out = bare.output();
    await expect(
      bare.get.handle({
        actor: READER,
        releaseId: bare.release.id,
        packageId: out.id,
      }),
    ).rejects.toMatchObject({ code: 'iirds-not-configured' });
    await expect(
      bare.list.handle({
        actor: READER,
        releaseId: bare.release.id,
        filter: {},
        page: { number: 1, size: 10 },
      }),
    ).rejects.toBeInstanceOf(UnprocessableError);
    const t = setup();
    const big = t.output();
    t.settings.maxBytes = 100;
    await expect(
      t.get.handle({
        actor: READER,
        releaseId: t.release.id,
        packageId: big.id,
      }),
    ).rejects.toMatchObject({ code: 'iirds-package-too-large' });
  });
});

describe('IirdsPlans', () => {
  it('makes at most two packages at once, and makes each once while it is being made', async () => {
    const t = setup();
    const resolve = new ResolveManualAction();
    let now = 0;
    let most = 0;
    const handle = resolve.handle.bind(resolve);
    vi.spyOn(resolve, 'handle').mockImplementation(async (input) => {
      now++;
      most = Math.max(most, now);
      await new Promise((r) => setTimeout(r, 10));
      now--;
      return handle(input);
    });
    const plans = new IirdsPlans(
      t.history.openSnapshot,
      resolve,
      new StubRenderer(),
      t.blobs,
    );
    const outs = [1, 2, 3, 4].map(() => t.output());
    const cfg = config();
    const made = await Promise.all([
      ...outs.map((o) => plans.plan(t.release, o, cfg)),
      plans.plan(t.release, outs[0] as ReleaseOutput, cfg),
    ]);
    expect(most).toBe(2);
    expect(made[4]).toBe(made[0]);
    expect(resolve.handle).toHaveBeenCalledTimes(4);
  });

  it('never drops a plan still being made: with 40 outputs asked for, each is made once (#551)', async () => {
    const t = setup();
    const resolve = new ResolveManualAction();
    const handle = resolve.handle.bind(resolve);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let calls = 0;
    vi.spyOn(resolve, 'handle').mockImplementation(async (input) => {
      // The first is slow: every other one is made and kept meanwhile.
      if (++calls === 1) await held;
      return handle(input);
    });
    const plans = new IirdsPlans(
      t.history.openSnapshot,
      resolve,
      new StubRenderer(),
      t.blobs,
    );
    const cfg = config();
    const outs = Array.from({ length: 40 }, () => t.output());
    const [slow, ...rest] = outs as [ReleaseOutput, ...ReleaseOutput[]];
    const first = plans.plan(t.release, slow, cfg);
    for (const o of rest) await plans.plan(t.release, o, cfg);
    expect(calls).toBe(40);
    // More than PLANS_KEPT made since, yet the slow one is not made again.
    const again = plans.plan(t.release, slow, cfg);
    expect(again).toBe(first);
    release();
    expect(await again).toBe(await first);
    expect(calls).toBe(40);
    // Kept once made, as the most recently used.
    expect(plans.plan(t.release, slow, cfg)).toBe(first);
    // The most recent PLANS_KEPT made are kept too; older ones are made again.
    await plans.plan(t.release, outs[39] as ReleaseOutput, cfg);
    expect(calls).toBe(40);
    await plans.plan(t.release, outs[1] as ReleaseOutput, cfg);
    expect(calls).toBe(41);
  });

  it('hands its turn on when a make fails, and refuses past the queue', async () => {
    const t = setup();
    const resolve = new ResolveManualAction();
    const handle = resolve.handle.bind(resolve);
    let calls = 0;
    vi.spyOn(resolve, 'handle').mockImplementation(async (input) => {
      const n = ++calls;
      await new Promise((r) => setTimeout(r, 5));
      if (n === 1) throw new Error('git is down');
      return handle(input);
    });
    const plans = new IirdsPlans(
      t.history.openSnapshot,
      resolve,
      new StubRenderer(),
      t.blobs,
    );
    const cfg = config();
    const outs = Array.from({ length: 2 + 16 + 1 }, () => t.output());
    const results = await Promise.allSettled(
      outs.map((o) => plans.plan(t.release, o, cfg)),
    );
    const reasons = results.flatMap((r) =>
      r.status === 'rejected' ? [String((r.reason as Error).message)] : [],
    );
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toBe('git is down');
    expect(reasons[1]).toMatch(/Too many/);
    // Everyone else got a plan, the first failure's turn passed on.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(17);
  });
});

describe('an empty manual', () => {
  it('makes a package of its document alone, with a warning, so the list shows only what GET delivers (#551)', async () => {
    const t = setup();
    const out = t.output({ audience: null, manualId: 'm' });
    t.history.onMain({
      config: config(),
      modules: [],
      manifests: [manifest('m', [])],
    });
    const commit = t.history.heads.get('main') as string;
    t.history.tags.length = 0;
    t.history.tag('release/one/1.0', commit);
    (t.release as { commit: string }).commit = commit;
    const listed = await t.list.handle({
      actor: READER,
      releaseId: t.release.id,
      filter: {},
      page: { number: 1, size: 10 },
    });
    expect(listed.items.map((o) => o.id)).toEqual([out.id]);
    const made = await t.get.handle({
      actor: READER,
      releaseId: t.release.id,
      packageId: out.id,
    });
    expect(made.plan.warnings.map((w) => w.code)).toEqual([
      'manual-empty',
      'pdf-not-included',
    ]);
    const files = unzipSync(await bytesOf(made.stream()));
    expect(Object.keys(files)).toEqual(['mimetype', 'META-INF/metadata.rdf']);
    const rdf = Buffer.from(
      files['META-INF/metadata.rdf'] as Uint8Array,
    ).toString();
    expect(schemaProblems(rdf)).toEqual([]);
    expect(rdf).toContain('<iirds:Document ');
    expect(rdf).not.toContain('DirectoryNode');
  });
});

describe('ListIirdsPackagesAction', () => {
  it('lists the outputs the reader may read, paged', async () => {
    const t = setup();
    t.output();
    t.output({ variant: 'model=large' });
    t.output({ manualId: 'staff', audience: 'internal' });
    const pub = actorWith(['content.read'], { maxAudience: 'public' });
    const page = await t.list.handle({
      actor: pub,
      releaseId: t.release.id,
      filter: {},
      page: { number: 1, size: 1 },
    });
    expect(page.total).toBe(2);
    expect(page.items.map((o) => o.manualId)).toEqual(['m']);
  });
});
