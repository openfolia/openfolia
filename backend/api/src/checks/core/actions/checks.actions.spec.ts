import {
  PageDesign,
  printPageDesign,
  ProjectConfig,
  translationRecordOf,
  type Block,
  type Inline,
  type Module,
} from '@openfolia/content-model';
import { actorWith } from '../../../../tests/fakes/actors.js';
import { addressSettings } from '../../../../tests/fakes/fake-address-settings.js';
import { FakeBlobStore } from '../../../../tests/fakes/fake-blob-store.js';
import { FakeContentChanges } from '../../../../tests/fakes/fake-content-changes.js';
import {
  config as baseConfig,
  manifest,
  module,
  readable,
  type FakeContent,
} from '../../../../tests/fakes/fake-content.js';
import { FakeHistory } from '../../../../tests/fakes/fake-history.js';
import {
  problem,
  RecordingRenderer,
} from '../../../../tests/fakes/recording-pdf-renderer.js';
import type { Actor, Scope } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import {
  FailedError,
  ForbiddenError,
  NotFoundError,
  UnavailableError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import {
  PdfAccessibilityError,
  PdfTemplateError,
} from '../../../manuals/core/pdf-renderer.js';
import { GetChangeSetAction } from '../../../change-sets/core/actions/get-change-set.action.js';
import { ListChangeSetChangesAction } from '../../../change-sets/core/actions/list-change-set-changes.action.js';
import { ListChunksAction } from '../../../chunks/core/actions/list-chunks.action.js';
import { categoryOf, severityOf } from '../check.js';
import {
  CHECK_RENDERS_WAITING,
  ContentChecks,
  RenderQueue,
} from '../content-checks.js';
import { CheckContentAction } from './check-content.action.js';
import { ListChangeSetChecksAction } from './list-change-set-checks.action.js';
import { ListManualChecksAction } from './list-manual-checks.action.js';

const config = ProjectConfig.parse({
  ...baseConfig,
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
});
const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith(permissions, scope), id });
const drafts = user('drafts', ['content.read', 'content.read.draft']);
const publicDrafts = user('public', ['content.read', 'content.read.draft'], {
  maxAudience: 'public',
});
const consumer = user('consumer', ['content.read']);
const author = user('author', ['content.read', 'content.edit']);

const STORED = 'a'.repeat(64);
const IN_GIT = 'b'.repeat(64);
const MISSING = 'c'.repeat(64);

const withBlocks = (m: Module, blocks: Block[]): Module => ({ ...m, blocks });
const image = (id: string, hash: string): Block => ({
  type: 'image',
  id,
  asset: `sha256:${hash}`,
  alt: 'An image',
});

const COMMIT = 'f'.repeat(40);
/** The records of translations made from these source modules' text: up to date. */
const translatedFrom = (...sources: Module[]) =>
  Object.fromEntries(
    sources.map((m) => [`de/${m.id}`, translationRecordOf(m, COMMIT)]),
  );

const intro = withBlocks(module('intro'), [
  { type: 'paragraph', id: 'p', content: [{ type: 'text', text: 'Hi.' }] },
  image('stored', STORED),
  image('in-git', IN_GIT),
  image('gone', MISSING),
  { type: 'moduleRef', id: 'ref', module: 'nowhere' },
  {
    type: 'paragraph',
    id: 'link',
    content: [
      {
        type: 'xref',
        module: 'intro',
        block: 'nope',
        text: [{ type: 'text', text: 'see' }],
      },
    ],
  },
]);

/** A manual with problems of every kind. */
const broken: FakeContent = {
  config,
  modules: [
    intro,
    module('intro', 'de'),
    {
      ...module('typo'),
      meta: { ...module('typo').meta, type: 'no-such-type' },
    },
    {
      ...module('secret'),
      meta: { ...module('secret').meta, audience: 'internal', type: 'nope' },
    },
    module('clean'),
    module('clean', 'de'),
  ],
  manifests: [manifest('op', ['intro', 'typo', 'secret', 'clean', 'missing'])],
  assets: { [IN_GIT]: new Uint8Array([1]) },
  translationRecords: translatedFrom(intro, module('clean')),
};

function setUp() {
  const blobs = new FakeBlobStore();
  blobs.blobs.set(STORED, {
    data: Buffer.from([1]),
    contentType: 'image/png',
  });
  const renderer = new RecordingRenderer();
  const checks = new ContentChecks(blobs, renderer, addressSettings());
  return {
    blobs,
    renderer,
    checks,
    manual: new ListManualChecksAction(checks),
  };
}

const page = { number: 1, size: 50 };
const keys = (
  items: readonly { code: string; subject: object; blockId?: string }[],
) =>
  items.map((c) =>
    [
      c.code,
      Object.values(c.subject).slice(1).join('/'),
      c.blockId ?? '-',
    ].join(' '),
  );

describe('ListManualChecksAction, attachments', () => {
  const attachment = (
    id: string,
    hash: string,
    fileName = 'settings.zip',
  ): Block => ({
    type: 'attachment',
    id,
    asset: `sha256:${hash}`,
    name: 'Settings',
    fileName,
    mediaType: 'application/zip',
    size: 1,
  });

  it('reports an attachment whose file is not stored, or is misnamed, as blocking', async () => {
    const { manual } = setUp();
    const content: FakeContent = {
      config,
      modules: [
        withBlocks(module('files'), [
          attachment('kept', STORED, 'photo.png'),
          attachment('in-git', IN_GIT),
          attachment('gone', MISSING),
          attachment('misnamed', STORED, 'evil.html'),
        ]),
        module('files', 'de'),
      ],
      manifests: [manifest('op', ['files'])],
      assets: { [IN_GIT]: new Uint8Array([1]) },
    };
    content.translationRecords = translatedFrom(content.modules?.[0] as Module);
    const result = await manual.handle({
      actor: drafts,
      snapshot: readable(content, drafts, 'content.read.draft'),
      id: 'op',
      filter: {},
      page,
    });
    expect(keys(result.items)).toEqual([
      'missing-attachment en/files gone',
      'attachment-file-name en/files misnamed',
    ]);
    expect(result.items[0]).toMatchObject({
      params: { asset: `sha256:${MISSING}` },
    });
    expect(result.items[1]).toMatchObject({
      params: { fileName: 'evil.html', contentType: 'image/png' },
    });
    expect(result.counts).toEqual({ blocking: 2, warning: 0 });
  });
});

describe('ListManualChecksAction, deprecation (#266)', () => {
  const deprecated = (m: Module, replacedBy?: string): Module => ({
    ...m,
    meta: {
      ...m.meta,
      deprecated: { reason: 'Superseded.', ...(replacedBy && { replacedBy }) },
    },
  });
  const content = (): FakeContent => {
    const old = deprecated(module('old'), 'fresh');
    const lost = deprecated(module('lost'), 'nowhere');
    const wrapper = withBlocks(module('wrapper'), [
      { type: 'moduleRef', id: 'ref', module: 'lost' },
    ]);
    const modules = [old, module('fresh'), lost, wrapper];
    return {
      config,
      modules: [
        ...modules,
        // A translation without the deprecation: the source's counts.
        ...modules.map((m) => ({ ...m, meta: { ...m.meta, lang: 'de' } })),
      ].map((m) =>
        m.meta.lang === 'de'
          ? { ...m, meta: { ...m.meta, deprecated: undefined } }
          : m,
      ) as Module[],
      manifests: [
        {
          ...manifest('op', ['old', 'fresh', 'wrapper']),
          deprecated: { reason: 'Replaced.', replacedBy: 'no-manual' },
        },
      ],
      translationRecords: translatedFrom(...modules),
    };
  };

  it('warns at each deprecated module a manual includes, naming the replacement, and at replacements that do not exist', async () => {
    const { manual } = setUp();
    const result = await manual.handle({
      actor: drafts,
      snapshot: readable(content(), drafts, 'content.read.draft'),
      id: 'op',
      filter: {},
      page,
    });
    const found = result.items.map((c) => [
      c.code,
      Object.values(c.subject).slice(1).join('/'),
      c.params,
    ]);
    expect(found).toEqual([
      ['deprecated-module', 'op', { module: 'lost', replacedBy: 'nowhere' }],
      ['deprecated-module', 'op', { module: 'old', replacedBy: 'fresh' }],
      ['unknown-replacement', 'op', { replacedBy: 'no-manual' }],
      ['unknown-replacement', 'en/lost', { replacedBy: 'nowhere' }],
    ]);
    expect(result.items.every((c) => severityOf(c) === 'warning')).toBe(true);
    expect(result.counts).toEqual({ blocking: 0, warning: 4 });
  });

  it('tells a missing replacement only to a reader told what was left out, as a missing module', async () => {
    const { manual } = setUp();
    const scoped = user('scoped', ['content.read'], { maxAudience: 'public' });
    const result = await manual.handle({
      actor: scoped,
      snapshot: readable(content(), scoped),
      id: 'op',
      filter: {},
      page,
    });
    expect(result.items.map((c) => c.code)).toEqual([
      'deprecated-module',
      'deprecated-module',
    ]);
  });
});

describe('ListManualChecksAction', () => {
  it('lists every kind of problem at its module and block, in order', async () => {
    const { manual } = setUp();
    const snapshot = readable(broken, drafts, 'content.read.draft');
    const result = await manual.handle({
      actor: drafts,
      snapshot,
      id: 'op',
      filter: {},
      page,
    });
    expect(keys(result.items)).toEqual([
      'missing-module op -',
      'missing-image en/intro gone',
      'missing-module en/intro ref',
      'xref-unknown-block en/intro link',
      // The subject's own checks first, blocking ones first.
      'unknown-module-type en/secret -',
      'above-audience en/secret -',
      'missing-translation en/secret -',
      'unknown-module-type en/typo -',
      'missing-translation en/typo -',
    ]);
    expect(result.counts).toEqual({ blocking: 6, warning: 3 });
    expect(result.modules).toEqual({ checked: 4, withoutIssues: 1 });
    expect(result.total).toBe(9);
    expect(result.commit).toBe(snapshot.commit);
    const missing = result.items[0];
    expect(missing).toMatchObject({
      params: { module: 'missing' },
      variants: ['model=small', 'model=large'],
      languages: ['en', 'de'],
    });
    expect(missing?.title).toBe('Manual op');
    expect(result.items[1]?.title).toBe('Title of intro');
    expect(result.items[2]).toMatchObject({
      // Found at the block and by resolving, as one check.
      params: { module: 'nowhere' },
      variants: ['model=small', 'model=large'],
      languages: ['en'],
    });
  });

  it('filters by severity after counting, and pages', async () => {
    const { manual } = setUp();
    const snapshot = readable(broken, drafts, 'content.read.draft');
    const result = await manual.handle({
      actor: drafts,
      snapshot,
      id: 'op',
      filter: { severity: 'warning' },
      page: { number: 3, size: 1 },
    });
    expect(result.total).toBe(3);
    expect(keys(result.items)).toEqual(['missing-translation en/typo -']);
    expect(result.counts).toEqual({ blocking: 6, warning: 3 });
  });

  it('lists and counts nothing about modules the reader may not see', async () => {
    const { manual } = setUp();
    const snapshot = readable(broken, publicDrafts, 'content.read.draft');
    const result = await manual.handle({
      actor: publicDrafts,
      snapshot,
      id: 'op',
      filter: {},
      page,
    });
    expect(keys(result.items).filter((k) => k.includes('secret'))).toEqual([]);
    expect(result.counts.blocking).toBe(5);
    expect(result.modules).toEqual({ checked: 3, withoutIssues: 1 });
  });

  it('tells a missing module only to a reader of drafts or one from whom nothing is hidden', async () => {
    const { manual } = setUp();
    const codes = async (actor: Actor) =>
      (
        await manual.handle({
          actor,
          snapshot: readable(broken, actor),
          id: 'op',
          filter: {},
          page,
        })
      ).items.map((c) => [c.code, c.params['module']]);
    const narrow = user('narrow', ['content.read'], { maxAudience: 'public' });
    expect(await codes(narrow)).not.toContainEqual([
      'missing-module',
      'missing',
    ]);
    expect(await codes(narrow)).not.toContainEqual([
      'missing-module',
      'nowhere',
    ]);
    expect(await codes(consumer)).toContainEqual(['missing-module', 'missing']);
    expect(await codes(consumer)).toContainEqual(['missing-module', 'nowhere']);
  });

  it('checks cross-references: blocking when the target is gone, silent when it is hidden, one check per link', async () => {
    const { manual } = setUp();
    const xref = (module: string, block?: string): Inline => ({
      type: 'xref',
      module,
      ...(block !== undefined && { block }),
      text: [{ type: 'text', text: 'see' }],
    });
    const content: FakeContent = {
      config,
      modules: [
        withBlocks(module('links'), [
          {
            type: 'paragraph',
            id: 'p',
            content: [
              xref('gone'),
              xref('links', 'nope'),
              xref('links', 'also-nope'),
              xref('secret'),
            ],
          },
        ]),
        {
          ...module('secret'),
          meta: { ...module('secret').meta, audience: 'internal' },
        },
      ],
      manifests: [manifest('op', ['links'])],
    };
    const result = await manual.handle({
      actor: publicDrafts,
      snapshot: readable(content, publicDrafts, 'content.read.draft'),
      id: 'op',
      filter: {},
      page,
    });
    const xrefs = result.items.filter((c) => c.code.startsWith('xref-'));
    expect(xrefs.map((c) => [c.code, c.blockId, c.params])).toEqual([
      ['xref-unknown-block', 'p', { module: 'links', block: 'also-nope' }],
      ['xref-unknown-block', 'p', { module: 'links', block: 'nope' }],
      ['xref-unknown-module', 'p', { module: 'gone' }],
    ]);
    expect(JSON.stringify(result.items)).not.toContain('secret');
  });

  it('checks module references to one block (#223): blocking when the block is not in the module, silent for a module the reader may not see', async () => {
    const { manual } = setUp();
    const content: FakeContent = {
      config,
      modules: [
        withBlocks(module('host'), [
          { type: 'moduleRef', id: 'ok', module: 'shared', block: 'p' },
          { type: 'moduleRef', id: 'gone', module: 'shared', block: 'nope' },
          { type: 'moduleRef', id: 'hidden', module: 'secret', block: 'x' },
        ]),
        module('shared'),
        {
          ...module('secret'),
          meta: { ...module('secret').meta, audience: 'internal' },
        },
      ],
      manifests: [manifest('op', ['host'])],
    };
    const result = await manual.handle({
      actor: publicDrafts,
      snapshot: readable(content, publicDrafts, 'content.read.draft'),
      id: 'op',
      filter: {},
      page,
    });
    const found = result.items.filter(
      (c) => c.code === 'module-ref-unknown-block',
    );
    // One check, though both the module and the manual's resolution find it.
    expect(
      found.map((c) => [c.code, c.blockId, c.params, severityOf(c)]),
    ).toEqual([
      [
        'module-ref-unknown-block',
        'gone',
        { module: 'shared', block: 'nope' },
        'blocking',
      ],
    ]);
    expect(JSON.stringify(result.items)).not.toContain('secret');
  });

  it('checks term links (#245): blocking for a term that is not there or cannot be read, a warning for a deprecated one', async () => {
    const { manual } = setUp();
    const linked = (text: string, termId: string): Inline => ({
      type: 'text',
      text,
      marks: [{ type: 'term', termId }],
    });
    const content: FakeContent = {
      config,
      modules: [
        withBlocks(module('terms'), [
          {
            type: 'paragraph',
            id: 'p',
            content: [
              linked('charger', 'charger'),
              linked('plug', 'plug'),
              linked('old', 'old'),
              linked('older', 'older'),
              linked('broken', 'broken'),
              { type: 'text', text: ' and ' },
              linked('gone', 'gone'),
            ],
          },
          {
            type: 'list',
            id: 'l',
            ordered: false,
            items: [
              { id: 'i', content: [linked('gone again', 'gone')], blocks: [] },
            ],
          },
        ]),
      ],
      manifests: [manifest('op', ['terms'])],
      terms: {
        charger:
          'schemaVersion: 1\nstatus: approved\nlanguages:\n  en:\n    preferred: charger\n',
        plug: 'schemaVersion: 1\nstatus: proposed\nlanguages:\n  en:\n    preferred: plug\n',
        old: 'schemaVersion: 1\nstatus: deprecated\nreplacedBy: charger\nlanguages:\n  en:\n    preferred: old\n',
        older:
          'schemaVersion: 1\nstatus: deprecated\nlanguages:\n  en:\n    preferred: older\n',
        broken: 'not: [a term',
      },
    };
    const result = await manual.handle({
      actor: drafts,
      snapshot: readable(content, drafts, 'content.read.draft'),
      id: 'op',
      filter: {},
      page,
    });
    const terms = result.items.filter((c) => c.code.endsWith('-term'));
    expect(
      terms.map((c) => [c.code, severityOf(c), c.blockId, c.params]),
    ).toEqual([
      ['unknown-term', 'blocking', 'p', { term: 'broken' }],
      ['unknown-term', 'blocking', 'p', { term: 'gone' }],
      [
        'deprecated-term',
        'warning',
        'p',
        { term: 'old', replacedBy: 'charger' },
      ],
      ['deprecated-term', 'warning', 'p', { term: 'older' }],
      ['unknown-term', 'blocking', 'i', { term: 'gone' }],
    ]);
    expect(terms.every((c) => categoryOf(c) === 'reference')).toBe(true);
  });

  it('keeps a manual’s checks for a short while, so pages read them once', async () => {
    const { checks } = setUp();
    let made = 0;
    const counted = new ContentChecks(
      new FakeBlobStore(),
      new RecordingRenderer(),
      addressSettings(),
    );
    counted.manual = (...args) => {
      made += 1;
      return checks.manual(...args);
    };
    const manual = new ListManualChecksAction(counted);
    const snapshot = readable(broken, drafts, 'content.read.draft');
    for (const number of [1, 2]) {
      await manual.handle({
        actor: drafts,
        snapshot,
        id: 'op',
        filter: {},
        page: { number, size: 2 },
      });
    }
    expect(made).toBe(1);
  });

  it('reports a manifest that cannot be read, and 404 for one that is not there', async () => {
    const { manual } = setUp();
    const snapshot = readable({ config, brokenManifests: ['bad'] }, drafts);
    const result = await manual.handle({
      actor: drafts,
      snapshot,
      id: 'bad',
      filter: {},
      page,
    });
    expect(result.items.map((c) => c.code)).toEqual(['invalid-manifest']);
    await expect(
      manual.handle({ actor: drafts, snapshot, id: 'nope', filter: {}, page }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const internal = readable(
      { config, manifests: [{ ...manifest('in', []), audience: 'internal' }] },
      publicDrafts,
    );
    await expect(
      manual.handle({
        actor: publicDrafts,
        snapshot: internal,
        id: 'in',
        filter: {},
        page,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('needs content.read', async () => {
    const { manual } = setUp();
    const nobody = actorWith([]);
    await expect(
      manual.handle({
        actor: nobody,
        snapshot: readable(broken),
        id: 'op',
        filter: {},
        page,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('ListManualChecksAction, PDF/UA-1', () => {
  const content: FakeContent = {
    config,
    modules: [module('clean'), module('clean', 'de')],
    manifests: [manifest('op', ['clean'])],
    translationRecords: translatedFrom(module('clean')),
  };
  const list = async (
    renderer: RecordingRenderer,
    of: FakeContent = content,
  ) => {
    const manual = new ListManualChecksAction(
      new ContentChecks(new FakeBlobStore(), renderer, addressSettings()),
    );
    return manual.handle({
      actor: drafts,
      snapshot: readable(of, drafts, 'content.read.draft'),
      id: 'op',
      filter: {},
      page,
    });
  };

  it('renders every variant in every language, one at a time, and reports a refusal as blocking', async () => {
    const renderer = new RecordingRenderer();
    renderer.fail = ({ manual }) =>
      manual.variant['model'] === 'large'
        ? new PdfAccessibilityError([
            problem('missing alt text'),
            problem('heading title is empty'),
          ])
        : undefined;
    const result = await list(renderer);
    expect(renderer.keys).toHaveLength(4);
    expect(renderer.maxConcurrent).toBe(1);
    expect(result.items.map((c) => [c.code, c.params])).toEqual([
      ['pdf-accessibility', { problem: 'heading title is empty' }],
      ['pdf-accessibility', { problem: 'missing alt text' }],
    ]);
    const [first] = result.items;
    expect(first).toMatchObject({
      subject: { type: 'manual', manualId: 'op' },
      variants: ['model=large'],
      languages: ['en', 'de'],
    });
    expect(first && severityOf(first)).toBe('blocking');
    expect(first && categoryOf(first)).toBe('validation');
    expect(result.counts).toEqual({ blocking: 2, warning: 0 });
  });

  it('renders nothing when the PDF standard is off', async () => {
    const renderer = new RecordingRenderer();
    renderer.fail = () => new PdfAccessibilityError([problem('missing')]);
    const off = ProjectConfig.parse({ ...config, pdf: { standard: 'none' } });
    const result = await list(renderer, { ...content, config: off });
    expect(renderer.keys).toEqual([]);
    expect(result.items).toEqual([]);
  });

  it('fails while the renderer is busy, and warns that a PDF it cannot render was not checked', async () => {
    const busy = new RecordingRenderer();
    busy.fail = () => new UnavailableError('renderer-busy', 'Busy.', 30);
    await expect(list(busy)).rejects.toBeInstanceOf(UnavailableError);
    const broken = new RecordingRenderer();
    broken.fail = ({ manual }) =>
      manual.lang === 'de'
        ? new UnprocessableError('render-timeout', 'Too slow.')
        : new FailedError('render-failed', 'PDF rendering failed.');
    const result = await list(broken);
    expect(result.items.map((c) => [c.code, c.params, c.languages])).toEqual([
      ['pdf-not-checked', { reason: 'render-failed' }, ['en']],
      ['pdf-not-checked', { reason: 'render-timeout' }, ['de']],
    ]);
    expect(result.counts).toEqual({ blocking: 0, warning: 2 });
  });

  it('tries no more PDFs in a request once one took too long', async () => {
    const renderer = new RecordingRenderer();
    renderer.fail = () => new UnprocessableError('render-timeout', 'Too slow.');
    const result = await list(renderer);
    expect(renderer.keys).toHaveLength(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      code: 'pdf-not-checked',
      params: { reason: 'render-timeout' },
      variants: ['model=small', 'model=large'],
      languages: ['en', 'de'],
    });
  });

  it('refuses a rendering with 503 once too many wait, and takes them again after', async () => {
    const queue = new RenderQueue();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const waiting = Array.from({ length: CHECK_RENDERS_WAITING }, () =>
      queue.run(() => gate),
    );
    await expect(queue.run(() => Promise.resolve())).rejects.toMatchObject({
      code: 'renderer-busy',
      retryAfterSeconds: 30,
    });
    release();
    await Promise.all(waiting);
    await expect(queue.run(() => Promise.resolve(1))).resolves.toBe(1);
  });

  it('answers a checks request 503 while too many renderings wait', async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const slow = new RecordingRenderer();
    slow.fail = () => undefined;
    const render = slow.render.bind(slow);
    slow.render = async (...args) => {
      await gate;
      return render(...args);
    };
    const checks = new ContentChecks(
      new FakeBlobStore(),
      slow,
      addressSettings(),
    );
    const manual = new ListManualChecksAction(checks);
    const request = (id: string) => {
      const actor = user(id, ['content.read', 'content.read.draft']);
      return manual.handle({
        actor,
        snapshot: readable(content, actor, 'content.read.draft'),
        id: 'op',
        filter: {},
        page,
      });
    };
    // Each request reads its own snapshot (its own commit), so none share cached checks,
    // and has one rendering waiting at a time: fill every place.
    const first = Array.from({ length: CHECK_RENDERS_WAITING }, (_, i) =>
      request(`r${i}`),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(request('late')).rejects.toMatchObject({
      code: 'renderer-busy',
    });
    release();
    await Promise.all(first);
  });

  it('renders one at a time across requests, too', async () => {
    const renderer = new RecordingRenderer();
    const manual = new ListManualChecksAction(
      new ContentChecks(new FakeBlobStore(), renderer, addressSettings()),
    );
    const other = user('other', ['content.read', 'content.read.draft']);
    const request = (actor: Actor) =>
      manual.handle({
        actor,
        snapshot: readable(content, actor, 'content.read.draft'),
        id: 'op',
        filter: {},
        page,
      });
    await Promise.all([request(drafts), request(other)]);
    expect(renderer.keys).toHaveLength(8);
    expect(renderer.maxConcurrent).toBe(1);
  });
});

describe('ContentChecks, own templates (#396)', () => {
  const DESIGN = (template?: string) =>
    [
      'schemaVersion: 1',
      'name: House style',
      'preset: classic',
      ...(template ? [`template: ${template}`] : []),
      'colours:',
      '  primary: "#333333"',
      '  accent: "#555555"',
      '  text: "#111111"',
      '',
    ].join('\n');
  const content = (template = 'house'): FakeContent => ({
    config: ProjectConfig.parse({ ...config, pdf: { design: 'own' } }),
    modules: [module('clean'), module('clean', 'de')],
    manifests: [manifest('op', ['clean'])],
    translationRecords: translatedFrom(module('clean')),
    pageDesigns: { own: DESIGN(template), plain: DESIGN() },
    designTemplates: {
      house: { 'manual.typ': '#let manual(..a, body) = body\n' },
      // A folder without its entry file is no template.
      loose: { 'parts.typ': '' },
    },
  });
  const where = {
    file: 'templates/house/manual.typ',
    line: 12,
    column: 3,
    message: 'unknown variable: notice',
    trace: [],
  };

  it('reports a template that does not compile as blocking at the manual, with its file and line', async () => {
    const renderer = new RecordingRenderer();
    renderer.fail = () => new PdfTemplateError('own', 'house', [where]);
    const result = await new ListManualChecksAction(
      new ContentChecks(new FakeBlobStore(), renderer, addressSettings()),
    ).handle({
      actor: drafts,
      snapshot: readable(content(), drafts, 'content.read.draft'),
      id: 'op',
      filter: {},
      page,
    });
    const found = result.items.filter(
      (c) => c.code === 'page-design-template-error',
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      subject: { type: 'manual', manualId: 'op' },
      params: {
        design: 'own',
        template: 'house',
        file: 'templates/house/manual.typ',
        line: '12',
        column: '3',
        problem: 'unknown variable: notice',
      },
      languages: ['en', 'de'],
    });
    expect(severityOf(found[0] as never)).toBe('blocking');
    // Not also "not checked": the template is why.
    expect(result.items.map((c) => c.code)).not.toContain('pdf-not-checked');
  });

  it('reports a template the repository does not have, once, at the manual', async () => {
    const renderer = new RecordingRenderer();
    for (const missing of ['gone', 'loose']) {
      const result = await new ListManualChecksAction(
        new ContentChecks(new FakeBlobStore(), renderer, addressSettings()),
      ).handle({
        actor: drafts,
        snapshot: readable(content(missing), drafts, 'content.read.draft'),
        id: 'op',
        filter: {},
        page,
      });
      expect(
        result.items
          .filter((c) => c.code === 'page-design-unknown-template')
          .map((c) => [c.subject, c.params]),
      ).toEqual([
        [
          { type: 'manual', manualId: 'op' },
          { design: 'own', template: missing },
        ],
      ]);
    }
  });

  it('compiles the template of a design a change set changes, or whose folder it changes, and holds a broken one at the design', async () => {
    const renderer = new RecordingRenderer();
    renderer.templateProblems = () => [where];
    const checks = new ContentChecks(
      new FakeBlobStore(),
      renderer,
      addressSettings(),
    );
    const head = readable(content(), drafts, 'content.read.draft');
    const byDesign = await checks.changes(head, [
      { type: 'design', designId: 'own' },
      // A design without an own template compiles nothing.
      { type: 'design', designId: 'plain' },
    ]);
    expect(renderer.templates.map((t) => t.design.id)).toEqual(['own']);
    expect(Object.keys(renderer.templates[0]?.files ?? {})).toEqual([
      'manual.typ',
    ]);
    expect(byDesign.checks).toHaveLength(1);
    expect(byDesign.checks[0]).toMatchObject({
      code: 'page-design-template-error',
      subject: { type: 'design', designId: 'own' },
      title: 'House style',
      params: { file: 'templates/house/manual.typ', line: '12' },
    });
    // Only the template's folder changed: the designs naming it are checked.
    const byFolder = await checks.changes(head, [], undefined, ['house']);
    expect(byFolder.checks.map((c) => c.subject)).toEqual([
      { type: 'design', designId: 'own' },
    ]);
    expect(renderer.templates).toHaveLength(2);
    // A template that compiles: nothing to say.
    renderer.templateProblems = () => [];
    expect(
      (await checks.changes(head, [{ type: 'design', designId: 'own' }]))
        .checks,
    ).toEqual([]);
  });

  it('says a changed design names a template the repository does not have, and compiles nothing', async () => {
    const renderer = new RecordingRenderer();
    const result = await new ContentChecks(
      new FakeBlobStore(),
      renderer,
      addressSettings(),
    ).changes(readable(content('gone'), drafts, 'content.read.draft'), [
      { type: 'design', designId: 'own' },
    ]);
    expect(renderer.templates).toEqual([]);
    expect(result.checks.map((c) => [c.code, c.subject])).toEqual([
      ['page-design-unknown-template', { type: 'design', designId: 'own' }],
    ]);
  });
});

describe('ListManualChecksAction, page design layout (#391)', () => {
  const DESIGN = [
    'schemaVersion: 1',
    'name: Long',
    'preset: minimal',
    'colours:',
    '  primary: "#333333"',
    '  accent: "#555555"',
    '  text: "#111111"',
    '',
  ].join('\n');
  const content = (standard?: 'none'): FakeContent => ({
    config: ProjectConfig.parse({
      ...config,
      pdf: { design: 'long', ...(standard && { standard }) },
    }),
    modules: [module('clean'), module('clean', 'de')],
    manifests: [manifest('op', ['clean'])],
    translationRecords: translatedFrom(module('clean')),
    pageDesigns: { long: DESIGN },
  });
  const list = async (renderer: RecordingRenderer, of: FakeContent) =>
    new ListManualChecksAction(
      new ContentChecks(new FakeBlobStore(), renderer, addressSettings()),
    ).handle({
      actor: drafts,
      snapshot: readable(of, drafts, 'content.read.draft'),
      id: 'op',
      filter: {},
      page,
    });

  it('reports a clipped region and a shortened running head as warnings at the manual', async () => {
    const renderer = new RecordingRenderer();
    renderer.warnings = ({ manual, design }) => {
      expect(design?.id).toBe('long');
      return [
        {
          code: 'page-design-overflow',
          at: 'regions.footer',
          page: 1,
          pages: 1,
        },
        ...(manual.lang === 'de'
          ? [
              {
                code: 'running-head-truncated' as const,
                at: 'header.default.right',
                page: 3,
                pages: 4,
                text: 'Ein sehr langer Kapiteltitel',
              },
            ]
          : []),
      ];
    };
    const result = await list(renderer, content());
    expect(renderer.warned).toHaveLength(4);
    expect(
      result.items.map((c) => [c.code, c.params, c.variants, c.languages]),
    ).toEqual([
      [
        'page-design-overflow',
        { at: 'regions.footer' },
        ['model=small', 'model=large'],
        ['en', 'de'],
      ],
      [
        'running-head-truncated',
        { at: 'header.default.right', text: 'Ein sehr langer Kapiteltitel' },
        ['model=small', 'model=large'],
        ['de'],
      ],
    ]);
    expect(result.items.map((c) => severityOf(c))).toEqual([
      'warning',
      'warning',
    ]);
    expect(result.items[1]?.message).toBe(
      'The running head header.default.right does not fit on one line (pages 3 and 3 more): it is shortened with an ellipsis.',
    );
  });

  it('renders a designed manual for its layout even when the PDF standard is off, and says when it could not (#554)', async () => {
    const renderer = new RecordingRenderer();
    renderer.fail = () => new FailedError('render-failed', 'Broken.');
    const result = await list(renderer, content('none'));
    expect(renderer.keys).toHaveLength(4);
    // No PDF/UA-1 to report as not checked; the layout was not checked either.
    expect(
      result.items.map((c) => [
        c.code,
        severityOf(c),
        c.params,
        c.variants,
        c.languages,
      ]),
    ).toEqual([
      [
        'pdf-layout-not-checked',
        'warning',
        { reason: 'render-failed' },
        ['model=small', 'model=large'],
        ['en', 'de'],
      ],
    ]);
  });

  it('keeps the layout warnings of a PDF that PDF/UA-1 refuses, beside the refusal (#554)', async () => {
    const renderer = new RecordingRenderer();
    renderer.fail = () =>
      new PdfAccessibilityError(
        [problem('missing alt text')],
        [
          {
            code: 'page-design-overflow',
            at: 'regions.footer',
            page: 1,
            pages: 1,
          },
        ],
      );
    const result = await list(renderer, content());
    expect(result.items.map((c) => [c.code, c.params])).toEqual([
      ['pdf-accessibility', { problem: 'missing alt text' }],
      ['page-design-overflow', { at: 'regions.footer' }],
    ]);
  });

  it('reports what resolving the design found, with each manual that uses it (#554)', async () => {
    const designed = [
      'schemaVersion: 1',
      'name: Long',
      'preset: classic',
      'colours:',
      '  primary: "#333333"',
      '  accent: "#555555"',
      '  text: "#111111"',
      'titlePage:',
      '  fields: [title, release]',
      'regions:',
      '  footer:',
      '    en: |-',
      '      [#a]',
      '      A',
      '',
      '      [#b]',
      '      B',
      '    de: |-',
      '      [#a]',
      '      A',
      '  above-title:',
      '    de: |-',
      '      [#x]',
      '      Nur Deutsch',
      'header:',
      '  default:',
      '    left: placeholder:subtitle[]',
      '    right: "{serial}"',
      '',
    ].join('\n');
    const result = await list(new RecordingRenderer(), {
      ...content(),
      config: ProjectConfig.parse({
        ...config,
        textAttributes: [{ id: 'serial', label: 'Serial' }],
        pdf: { design: 'long' },
      }),
      pageDesigns: { long: designed },
    });
    const found = result.items
      .filter((c) => c.code.startsWith('page-design-'))
      .map((c) => [c.code, severityOf(c), c.params, c.languages]);
    expect(found).toEqual([
      [
        'page-design-missing-text-attribute',
        'blocking',
        { design: 'long', at: 'header.default.right', name: 'serial' },
        ['en', 'de'],
      ],
      [
        'page-design-dropped-text',
        'warning',
        { design: 'long', at: 'regions.above-title' },
        ['en'],
      ],
      [
        'page-design-missing-value',
        'warning',
        { design: 'long', at: 'header.default.left', name: 'subtitle' },
        ['en', 'de'],
      ],
      [
        'page-design-region-languages-differ',
        'warning',
        { design: 'long', at: 'regions.footer', name: 'en' },
        ['de'],
      ],
    ]);
    expect(
      result.items.find((c) => c.code === 'page-design-dropped-text')?.subject,
    ).toEqual({
      type: 'manual',
      manualId: 'op',
    });
    // The release is never known to a manual's checks yet: not reported (#533).
    expect(JSON.stringify(found)).not.toContain('release');
  });

  it('asks for no layout warnings without a design', async () => {
    const renderer = new RecordingRenderer();
    const plain = content();
    await list(renderer, {
      ...plain,
      config: ProjectConfig.parse({ ...config }),
    });
    expect(renderer.keys).toHaveLength(4);
    expect(renderer.warned).toEqual([]);
  });

  it('reports a default design that is not in the content as blocking (#589)', async () => {
    const plain = content();
    const result = await list(new RecordingRenderer(), {
      ...plain,
      pageDesigns: {},
    });
    const found = result.items.filter((c) => c.code === 'unknown-page-design');
    expect(found.map((c) => c.params)).toEqual([
      { design: 'long', from: 'config' },
    ]);
    expect(found.map((c) => severityOf(c))).toEqual(['blocking']);
    expect(found[0]?.subject).toEqual({ type: 'manual', manualId: 'op' });
  });

  it('reports a manual’s own design that is not in the content, and a broken design file (#589)', async () => {
    const plain = content();
    const named = (design: string): FakeContent => ({
      ...plain,
      manifests: [{ ...manifest('op', ['clean']), design }],
      pageDesigns: { long: DESIGN, broken: 'name: [' },
    });
    for (const design of ['gone', 'broken']) {
      const result = await list(new RecordingRenderer(), named(design));
      expect(
        result.items
          .filter((c) => c.code === 'unknown-page-design')
          .map((c) => c.params),
      ).toEqual([{ design, from: 'manual' }]);
    }
    const fine = await list(new RecordingRenderer(), named('long'));
    expect(fine.items.map((c) => c.code)).not.toContain('unknown-page-design');
  });
});

describe('ListManualChecksAction, a callout legend beside its image (#548)', () => {
  const pictured = (lang: string): Module => ({
    ...module('clean', lang),
    blocks: [
      {
        type: 'image',
        id: 'photo',
        asset: `sha256:${'a'.repeat(64)}`,
        alt: 'Photo',
        calloutLegend: 'beside',
        callouts: [
          {
            id: 'lid',
            anchor: { x: 0.5, y: 0.5 },
            legend: [{ type: 'text', text: 'Lid' }],
          },
        ],
      },
    ],
  });
  const content = (standard?: 'none'): FakeContent => ({
    config: ProjectConfig.parse({
      ...config,
      ...(standard && { pdf: { standard } }),
    }),
    modules: [pictured('en'), pictured('de')],
    manifests: [manifest('op', ['clean'])],
    translationRecords: translatedFrom(pictured('en')),
  });
  const list = async (renderer: RecordingRenderer, of: FakeContent) =>
    new ListManualChecksAction(
      new ContentChecks(new FakeBlobStore(), renderer, addressSettings()),
    ).handle({
      actor: drafts,
      snapshot: readable(of, drafts, 'content.read.draft'),
      id: 'op',
      filter: {},
      page,
    });

  it('reports a legend cut off per language, with its module, image and callout', async () => {
    const renderer = new RecordingRenderer();
    renderer.warnings = ({ manual }) =>
      manual.lang === 'de'
        ? [
            {
              code: 'callout-label-overflow',
              at: 'callouts.clean.photo.lid',
              page: 3,
              pages: 1,
            },
          ]
        : [];
    const result = await list(renderer, content());
    expect(renderer.warned).toHaveLength(4);
    // (The picture is in no blob store here: its own check is beside the point.)
    const items = result.items.filter((c) => c.code !== 'missing-image');
    expect(
      items.map((c) => [c.code, c.params, c.variants, c.languages]),
    ).toEqual([
      [
        'callout-label-overflow',
        {
          at: 'callouts.clean.photo.lid',
          module: 'clean',
          image: 'photo',
          callout: 'lid',
        },
        ['model=small', 'model=large'],
        ['de'],
      ],
    ]);
    expect(items[0] && severityOf(items[0])).toBe('warning');
    expect(items[0]?.message).toBe(
      'The legend of callout "lid" on image "photo" (module "clean") does not fit beside the image even at its smallest size (page 3): it is cut off.',
    );
  });

  it('reports a safety message split across pages, with its module, block and hazard (#668)', async () => {
    const renderer = new RecordingRenderer();
    renderer.warnings = ({ manual }) =>
      manual.lang === 'en'
        ? [
            {
              code: 'safety-message-split',
              at: 'safety.clean.notice',
              page: 4,
              pages: 1,
              text: 'Crushing',
            },
            // Not a safety message's place: dropped.
            {
              code: 'safety-message-split',
              at: 'safety.clean',
              page: 4,
              pages: 1,
            },
          ]
        : [];
    const result = await list(renderer, content());
    const items = result.items.filter((c) => c.code !== 'missing-image');
    expect(
      items.map((c) => [c.code, c.params, c.variants, c.languages]),
    ).toEqual([
      [
        'safety-message-split',
        {
          at: 'safety.clean.notice',
          module: 'clean',
          block: 'notice',
          text: 'Crushing',
        },
        ['model=small', 'model=large'],
        ['en'],
      ],
    ]);
    expect(items[0] && severityOf(items[0])).toBe('warning');
    expect(items[0]?.message).toBe(
      'The safety message "notice" (module "clean") is taller than a page (page 4): it is broken across pages.',
    );
  });

  it('renders for the layout even when the PDF standard is off', async () => {
    const renderer = new RecordingRenderer();
    await list(renderer, content('none'));
    expect(renderer.keys).toHaveLength(4);
    expect(renderer.warned).toHaveLength(4);
  });
});

describe('outdated translations', () => {
  const para = (id: string, text: string): Block => ({
    type: 'paragraph',
    id,
    content: [{ type: 'text', text }],
  });
  const doc = (first: string, lang = 'en') =>
    withBlocks(module('doc', lang), [para('one', first), para('two', 'Two.')]);

  it('warns on a translation per block changed in the source since, or without a record', async () => {
    const { manual } = setUp();
    const check = async (content: Partial<FakeContent>) => {
      const result = await manual.handle({
        actor: drafts,
        snapshot: readable(
          {
            config,
            modules: [doc('One, edited.'), doc('Eins.', 'de')],
            manifests: [manifest('op', ['doc'])],
            ...content,
          },
          drafts,
          'content.read.draft',
        ),
        id: 'op',
        filter: {},
        page,
      });
      return result.items
        .filter((c) => c.code === 'outdated-translation')
        .map((c) => [keys([c])[0], c.params, severityOf(c), categoryOf(c)]);
    };
    // Translated from the first paragraph's old text: that block only.
    expect(
      await check({ translationRecords: translatedFrom(doc('One.')) }),
    ).toEqual([
      [
        'outdated-translation de/doc -',
        { lang: 'de', blocks: '1' },
        'warning',
        'translation',
      ],
    ]);
    expect(
      await check({ translationRecords: translatedFrom(doc('One, edited.')) }),
    ).toEqual([]);
    // No record, or one that cannot be read: every block.
    for (const content of [{}, { brokenTranslationRecords: ['de/doc'] }]) {
      expect((await check(content))[0]?.[1]).toEqual({
        lang: 'de',
        blocks: '2',
      });
    }
  });

  it('warns on the translations of a source module a change set changes', async () => {
    const { checks } = setUp();
    const main: FakeContent = {
      config,
      modules: [doc('One.'), doc('Eins.', 'de')],
      manifests: [],
      translationRecords: translatedFrom(doc('One.')),
    };
    const history = new FakeHistory(main);
    const changeSet = history.changeSet(author, {
      ...main,
      modules: [doc('One, edited.'), doc('Eins.', 'de')],
    });
    const getChangeSet = new GetChangeSetAction(history.store);
    const action = new ListChangeSetChecksAction(
      getChangeSet,
      history.branches,
      history.openSnapshot,
      new ListChangeSetChangesAction(
        getChangeSet,
        history.branches,
        history.openSnapshot,
      ),
      checks,
      new ListChunksAction(new FakeContentChanges()),
    );
    const result = await action.handle({
      actor: drafts,
      id: changeSet.id,
      filter: {},
      page,
    });
    expect(
      result.items
        .filter((c) => c.code === 'outdated-translation')
        .map((c) => [keys([c])[0], c.params]),
    ).toEqual([['outdated-translation de/doc -', { lang: 'de', blocks: '1' }]]);
  });

  it('warns at a manual whose cover image text or page design text has an outdated translation (#656)', async () => {
    const { manual } = setUp();
    const design = PageDesign.parse({
      schemaVersion: 1,
      id: 'house',
      name: 'House',
      preset: 'classic',
      colours: { primary: '#1f4e79', accent: '#2563eb', text: '#1f2328' },
      regions: {
        back: {
          en: [para('maker', 'Made by us')],
          de: [para('maker', 'Von uns')],
        },
        footer: [para('note', 'Same for all')],
      },
    });
    const result = await manual.handle({
      actor: drafts,
      snapshot: readable(
        {
          config,
          modules: [doc('One.'), doc('Eins.', 'de')],
          manifests: [
            {
              ...manifest('op', ['doc']),
              design: 'house',
              coverImage: {
                default: {
                  asset: 'sha256:' + 'a'.repeat(64),
                  alt: { en: 'The vehicle', de: 'Das Fahrzeug' },
                },
                variants: [],
              },
            },
          ],
          pageDesigns: { house: printPageDesign(design) },
          translationRecords: translatedFrom(doc('One.')),
        },
        drafts,
        'content.read.draft',
      ),
      id: 'op',
      filter: {},
      page,
    });
    // Neither has a record: each own text in German is outdated; the footer is missing, not outdated.
    expect(
      result.items
        .filter((c) => c.code === 'outdated-translation')
        .map((c) => [keys([c])[0], c.params, c.languages]),
    ).toEqual([
      [
        'outdated-translation op -',
        { lang: 'de', blocks: '1', at: 'coverImage' },
        ['de'],
      ],
      [
        'outdated-translation op -',
        { lang: 'de', blocks: '1', design: 'house' },
        ['de'],
      ],
    ]);
  });
});

describe('ListChangeSetChecksAction', () => {
  const main: FakeContent = {
    config,
    modules: [
      module('kept'),
      module('dropped'),
      withBlocks(module('user'), [
        { type: 'moduleRef', id: 'uses', module: 'dropped' },
      ]),
    ],
    manifests: [manifest('op', ['kept', 'dropped'])],
  };
  const head: FakeContent = {
    config,
    modules: [
      withBlocks(module('kept'), [image('img', MISSING)]),
      withBlocks(module('user'), [
        { type: 'moduleRef', id: 'uses', module: 'dropped' },
      ]),
      {
        ...module('hidden'),
        meta: { ...module('hidden').meta, audience: 'internal', type: 'x' },
      },
    ],
    manifests: [manifest('op', ['kept', 'dropped'])],
  };

  function changeSetUp() {
    const { checks } = setUp();
    const history = new FakeHistory(main);
    const changeSet = history.changeSet(author, head);
    const getChangeSet = new GetChangeSetAction(history.store);
    const action = new ListChangeSetChecksAction(
      getChangeSet,
      history.branches,
      history.openSnapshot,
      new ListChangeSetChangesAction(
        getChangeSet,
        history.branches,
        history.openSnapshot,
      ),
      checks,
      new ListChunksAction(new FakeContentChanges()),
    );
    const list = (actor: Actor) =>
      action.handle({ actor, id: changeSet.id, filter: {}, page });
    return { history, changeSet, list };
  }

  it('checks what it changes at its head, and where a removed module is still used', async () => {
    const { history, changeSet, list } = changeSetUp();
    const result = await list(drafts);
    expect(result.commit).toBe(history.heads.get(changeSet.branch));
    expect(keys(result.items)).toEqual([
      'missing-module op -',
      'unknown-module-type en/hidden -',
      'missing-translation en/hidden -',
      'missing-translation en/kept -',
      'missing-image en/kept img',
      'missing-module en/user uses',
    ]);
    expect(result.modules.withoutIssues).toBe(0);
    expect(result.items[0]?.title).toBe('Manual op');
  });

  it('lists nothing about modules the reader may not see', async () => {
    const { list } = changeSetUp();
    const result = await list(publicDrafts);
    expect(keys(result.items).filter((k) => k.includes('hidden'))).toEqual([]);
    expect(result.counts).toEqual({ blocking: 3, warning: 1 });
  });

  it('shows its author without content.read.draft the references they broke', async () => {
    const { list } = changeSetUp();
    const result = await list(author);
    expect(keys(result.items)).toContain('missing-module en/user uses');
    expect(keys(result.items)).toContain('missing-module op -');
  });

  it('reports of a module still referring to a removed one only that reference', async () => {
    const { checks } = setUp();
    const history = new FakeHistory({
      config,
      modules: [
        module('dropped'),
        withBlocks(module('user'), [
          { type: 'moduleRef', id: 'uses', module: 'dropped' },
          image('old-problem', MISSING),
        ]),
      ],
    });
    const changeSet = history.changeSet(author, {
      config,
      modules: [
        withBlocks(module('user'), [
          { type: 'moduleRef', id: 'uses', module: 'dropped' },
          image('old-problem', MISSING),
        ]),
      ],
    });
    const getChangeSet = new GetChangeSetAction(history.store);
    const action = new ListChangeSetChecksAction(
      getChangeSet,
      history.branches,
      history.openSnapshot,
      new ListChangeSetChangesAction(
        getChangeSet,
        history.branches,
        history.openSnapshot,
      ),
      checks,
      new ListChunksAction(new FakeContentChanges()),
    );
    const result = await action.handle({
      actor: drafts,
      id: changeSet.id,
      filter: {},
      page,
    });
    expect(keys(result.items)).toEqual(['missing-module en/user uses']);
  });

  it('reports a module reference cycle it closes, at the closing block, unless a hidden module is in it', async () => {
    const { checks } = setUp();
    const ref = (id: string, to: string): Block => ({
      type: 'moduleRef',
      id,
      module: to,
    });
    const internal = (m: Module): Module => ({
      ...m,
      meta: { ...m.meta, audience: 'internal' },
    });
    // No manual includes any of them. `a` includes `b`; `c` includes the
    // hidden `h`, which includes `d`.
    const before: FakeContent = {
      config,
      modules: [
        withBlocks(module('a'), [ref('to-b', 'b')]),
        module('b'),
        withBlocks(module('c'), [ref('to-h', 'h')]),
        internal(withBlocks(module('h'), [ref('to-d', 'd')])),
        module('d'),
        module('e'),
      ],
    };
    // Now `b` includes `a` (a cycle under a variant block counts too), `d`
    // includes `c` (a cycle through `h`), and `e` one block of itself.
    const after: FakeContent = {
      ...before,
      modules: [
        withBlocks(module('a'), [ref('to-b', 'b')]),
        withBlocks(module('b'), [
          {
            type: 'variant',
            id: 'v',
            when: { op: 'in', attr: 'model', values: ['small'] },
            blocks: [ref('to-a', 'a')],
          },
          ref('to-a-again', 'a'),
        ]),
        withBlocks(module('c'), [ref('to-h', 'h')]),
        internal(withBlocks(module('h'), [ref('to-d', 'd')])),
        withBlocks(module('d'), [ref('to-c', 'c')]),
        // One block of itself (#223): a cycle all the same.
        withBlocks(module('e'), [
          { ...ref('self', 'e'), block: 'p' } as Block,
          ...module('e').blocks,
        ]),
      ],
    };
    const history = new FakeHistory(before);
    const changeSet = history.changeSet(author, after);
    const getChangeSet = new GetChangeSetAction(history.store);
    const action = new ListChangeSetChecksAction(
      getChangeSet,
      history.branches,
      history.openSnapshot,
      new ListChangeSetChangesAction(
        getChangeSet,
        history.branches,
        history.openSnapshot,
      ),
      checks,
      new ListChunksAction(new FakeContentChanges()),
    );
    const cycles = async (actor: Actor) => {
      const result = await action.handle({
        actor,
        id: changeSet.id,
        filter: {},
        page,
      });
      return {
        result,
        found: result.items
          .filter((c) => c.code === 'module-cycle')
          .map((c) => [...keys([c]), c.params, c.message]),
      };
    };

    const all = await cycles(drafts);
    expect(all.found).toEqual([
      [
        'module-cycle en/b to-a',
        { module: 'a' },
        'module reference cycle: b → a → b',
      ],
      [
        'module-cycle en/b to-a-again',
        { module: 'a' },
        'module reference cycle: b → a → b',
      ],
      [
        'module-cycle en/d to-c',
        { module: 'c' },
        'module reference cycle: d → c → h → d',
      ],
      ['module-cycle en/e self', {}, 'module reference cycle: e → e'],
    ]);
    expect(
      all.result.items.find((c) => c.code === 'module-cycle'),
    ).toMatchObject({ title: 'Title of b' });

    // A reader who may not see `h` is told nothing of the cycle through it,
    // and it is neither named nor counted.
    const narrow = await cycles(publicDrafts);
    expect(narrow.found.map(([key]) => key)).toEqual([
      'module-cycle en/b to-a',
      'module-cycle en/b to-a-again',
      'module-cycle en/e self',
    ]);
    expect(JSON.stringify(narrow.result.items)).not.toMatch(/"h"|→ h/);
    expect(narrow.result.counts.blocking).toBe(all.result.counts.blocking - 1);
    expect(narrow.result.modules).toEqual(all.result.modules);
  });

  it('names at most 20 modules of a long cycle', async () => {
    const { checks } = setUp();
    const chain = Array.from({ length: 30 }, (_, i) => `m${i + 1}`);
    const linked = (id: string, to: string): Module =>
      withBlocks(module(id), [{ type: 'moduleRef', id: 'next', module: to }]);
    const modules = chain.map((id, i) => linked(id, chain[i + 1] ?? 'a'));
    const history = new FakeHistory({
      config,
      modules: [module('a'), ...modules],
    });
    const changeSet = history.changeSet(author, {
      config,
      modules: [linked('a', 'm1'), ...modules],
    });
    const getChangeSet = new GetChangeSetAction(history.store);
    const action = new ListChangeSetChecksAction(
      getChangeSet,
      history.branches,
      history.openSnapshot,
      new ListChangeSetChangesAction(
        getChangeSet,
        history.branches,
        history.openSnapshot,
      ),
      checks,
      new ListChunksAction(new FakeContentChanges()),
    );
    const result = await action.handle({
      actor: drafts,
      id: changeSet.id,
      filter: {},
      page,
    });
    const cycle = result.items.find((c) => c.code === 'module-cycle');
    expect(cycle?.message).toBe(
      `module reference cycle: a → ${chain.slice(0, 19).join(' → ')} → … → a`,
    );
  });

  it('reports a module whose retrieval chunks are too large to cut, as the reader sees it (#688)', async () => {
    const { checks } = setUp();
    const wide = (m: Module, to: string): Module =>
      withBlocks(m, [
        ...m.blocks,
        ...Array.from({ length: 800 }, (_, i): Block => ({
          type: 'moduleRef',
          id: `to-${i}`,
          module: to,
        })),
      ]);
    const modules = [module('leaf'), wide(module('mid'), 'leaf')];
    const main: FakeContent = { config, modules };
    const history = new FakeHistory(main);
    // `de/top` falls back to `en/mid` (800 × 800 module references), as its chunk would.
    const changeSet = history.changeSet(author, {
      ...main,
      modules: [...modules, wide(module('top', 'de'), 'mid')],
    });
    const getChangeSet = new GetChangeSetAction(history.store);
    const action = new ListChangeSetChecksAction(
      getChangeSet,
      history.branches,
      history.openSnapshot,
      new ListChangeSetChangesAction(
        getChangeSet,
        history.branches,
        history.openSnapshot,
      ),
      checks,
      new ListChunksAction(new FakeContentChanges()),
    );
    const listAs = (actor: Actor) =>
      action.handle({ actor, id: changeSet.id, filter: {}, page });
    const large = (await listAs(drafts)).items.filter(
      (c) => c.code === 'expansion-too-large',
    );
    expect(large).toEqual([
      expect.objectContaining({
        subject: { type: 'module', lang: 'de', moduleId: 'top' },
        params: { reason: 'size' },
        message: expect.stringContaining('retrieval chunks are left out'),
      }),
    ]);
    // One who reads German only has no `en/mid` to fall back to: the chunk is small.
    const german = user('german', ['content.read', 'content.read.draft'], {
      languages: ['de'],
    });
    expect((await listAs(german)).items.map((c) => c.code)).not.toContain(
      'expansion-too-large',
    );
  });

  it('is not found for another author’s change set without content.read.draft', async () => {
    const { list } = changeSetUp();
    await expect(
      list(user('other', ['content.read', 'content.edit'])),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('ListManualChecksAction, the manufacturer details (#395)', () => {
  const withConfig = (extra: Record<string, unknown>): FakeContent => ({
    config: ProjectConfig.parse({ ...baseConfig, ...config, ...extra }),
    modules: [module('clean'), module('clean', 'de')],
    manifests: [manifest('op', ['clean']), manifest('guide', ['clean'])],
    translationRecords: translatedFrom(module('clean')),
  });
  const checksOf = async (content: FakeContent, id: string) => {
    const checks = new ContentChecks(
      new FakeBlobStore(),
      new RecordingRenderer(),
      addressSettings(),
    );
    const result = await new ListManualChecksAction(checks).handle({
      actor: drafts,
      snapshot: readable(content, drafts, 'content.read.draft'),
      id,
      filter: {},
      page,
    });
    return result.items.filter((c) => c.code === 'missing-manufacturer');
  };

  it('warns at every manual without manufacturer details, once the project turns it on', async () => {
    const on = withConfig({ release: { checkManufacturer: true } });
    for (const id of ['op', 'guide']) {
      const found = await checksOf(on, id);
      expect(found).toMatchObject([
        {
          code: 'missing-manufacturer',
          subject: { type: 'manual', manualId: id },
        },
      ]);
      expect(found.map(severityOf)).toEqual(['warning']);
      expect(found.map(categoryOf)).toEqual(['validation']);
    }
  });

  it('says nothing with details, nor with the check off (the default)', async () => {
    expect(
      await checksOf(
        withConfig({
          release: { checkManufacturer: true },
          manufacturer: { name: 'Example Works Ltd' },
        }),
        'op',
      ),
    ).toEqual([]);
    expect(await checksOf(withConfig({}), 'op')).toEqual([]);
    expect(
      await checksOf(
        withConfig({ release: { checkManufacturer: false } }),
        'op',
      ),
    ).toEqual([]);
  });
});

describe('ListManualChecksAction, stable addresses (#553)', () => {
  const withDelivery = (delivery: Record<string, unknown>): FakeContent => ({
    config: ProjectConfig.parse({ ...baseConfig, ...config, delivery }),
    modules: [module('clean'), module('clean', 'de')],
    manifests: [
      manifest('op', ['clean']),
      manifest('guide', ['clean']),
      { ...manifest('staff', ['clean']), audience: 'internal' },
    ],
    translationRecords: translatedFrom(module('clean')),
  });
  const checksOf = async (
    content: FakeContent,
    id: string,
    actor: Actor = drafts,
    settings = addressSettings(),
  ) => {
    const checks = new ContentChecks(
      new FakeBlobStore(),
      new RecordingRenderer(),
      settings,
    );
    const result = await new ListManualChecksAction(checks).handle({
      actor,
      snapshot: readable(content, actor, 'content.read.draft'),
      id,
      filter: {},
      page,
    });
    return result.items.filter((c) =>
      ['address-taken', 'delivery-access-capped'].includes(c.code),
    );
  };

  it('warns at each manual when delivery.access is above the deployment’s cap', async () => {
    const content = withDelivery({ access: 'public' });
    expect(await checksOf(content, 'op')).toEqual([]);
    const capped = await checksOf(
      content,
      'op',
      drafts,
      addressSettings({ maxAccess: 'signed-in' }),
    );
    expect(capped).toMatchObject([
      {
        code: 'delivery-access-capped',
        subject: { type: 'manual', manualId: 'op' },
        params: { access: 'public', maxAccess: 'signed-in' },
      },
    ]);
    expect(capped.map(severityOf)).toEqual(['warning']);
    // Within the cap: nothing.
    expect(
      await checksOf(
        withDelivery({ access: 'signed-in' }),
        'op',
        drafts,
        addressSettings({ maxAccess: 'signed-in' }),
      ),
    ).toEqual([]);
  });

  it('reports a slug or former address that is another manual’s ID, at both manuals', async () => {
    const content = withDelivery({
      manuals: {
        op: { slug: 'operating', formerly: ['guide', 'old-op'] },
        other: { slug: 'op-2' },
      },
    });
    const taken = await checksOf(content, 'op');
    expect(taken).toMatchObject([
      {
        code: 'address-taken',
        subject: { type: 'manual', manualId: 'op' },
        params: { address: 'guide', manual: 'guide', as: 'formerly' },
      },
    ]);
    expect(taken.map(severityOf)).toEqual(['blocking']);
    expect(taken.map(categoryOf)).toEqual(['reference']);
    // The manual whose address is taken is told too.
    expect(await checksOf(content, 'guide')).toMatchObject([
      {
        code: 'address-taken',
        subject: { type: 'manual', manualId: 'guide' },
        params: { address: 'guide', manual: 'op', as: 'formerly' },
      },
    ]);
    // A slug that is another manual's ID.
    expect(
      await checksOf(
        withDelivery({ manuals: { op: { slug: 'guide' } } }),
        'op',
      ),
    ).toMatchObject([
      { code: 'address-taken', params: { address: 'guide', as: 'slug' } },
    ]);
  });

  it('tells of no manual the reader may not see', async () => {
    const content = withDelivery({
      manuals: { op: { formerly: ['staff'] } },
    });
    expect(await checksOf(content, 'op')).toMatchObject([
      { code: 'address-taken', params: { address: 'staff' } },
    ]);
    expect(await checksOf(content, 'op', publicDrafts)).toEqual([]);
    // Nor one that takes this manual's address, nor one that does not exist.
    const claimed = withDelivery({ manuals: { staff: { slug: 'op' } } });
    expect(await checksOf(claimed, 'op')).toMatchObject([
      { code: 'address-taken', params: { manual: 'staff', as: 'slug' } },
    ]);
    expect(await checksOf(claimed, 'op', publicDrafts)).toEqual([]);
    expect(
      await checksOf(
        withDelivery({ manuals: { gone: { formerly: ['op'] } } }),
        'op',
      ),
    ).toEqual([]);
  });
});

describe('the chunks of a checks run and of a change set’s head, held to a budget (#710, #711)', () => {
  // A diamond 15 levels deep (as in `list-chunks.action.spec.ts`, one deeper): its top, `j0`,
  // expands to about 260,000 content nodes and 2,300,000 characters, within the limits of #679,
  // from a few hundred of its own. Each `r…` module refers to it once, so its chunk is as large.
  const DEPTH = 15;
  const refs = (id: string, to: string[], audience = 'public'): Module => {
    const m = withBlocks(
      module(id),
      to.map((ref): Block => ({
        type: 'moduleRef',
        id: `to-${ref}`,
        module: ref,
      })),
    );
    return { ...m, meta: { ...m.meta, audience } };
  };
  /** The diamond at `main`, with a counter of the reads of its top's blocks: the work. */
  const diamond = () => {
    const modules: Module[] = [];
    let reads = 0;
    for (let level = 0; level < DEPTH; level++) {
      const next = `j${level + 1}`;
      const top = refs(`j${level}`, [`a${level}`, `b${level}`]);
      if (level === 0) {
        const { blocks } = top;
        Object.defineProperty(top, 'blocks', {
          get() {
            reads++;
            return blocks;
          },
        });
      }
      modules.push(top, refs(`a${level}`, [next]), refs(`b${level}`, [next]));
    }
    modules.push(refs(`j${DEPTH}`, []));
    return { modules, reads: () => reads };
  };
  const many = (count: number, audience = 'public') =>
    Array.from({ length: count }, (_, i) =>
      refs(`r${String(i).padStart(3, '0')}`, ['j0'], audience),
    );

  /** A change set adding `added` to the diamond at `main`, and its checks as an actor reads them. */
  function changeSetOf(added: Module[], checks = setUp().checks) {
    const { modules, reads } = diamond();
    const main: FakeContent = { config, modules };
    const history = new FakeHistory(main);
    const changeSet = history.changeSet(author, {
      ...main,
      modules: [...modules, ...added],
    });
    const getChangeSet = new GetChangeSetAction(history.store);
    const chunks = new ListChunksAction(new FakeContentChanges());
    const actionOf = () =>
      new ListChangeSetChecksAction(
        getChangeSet,
        history.branches,
        history.openSnapshot,
        new ListChangeSetChangesAction(
          getChangeSet,
          history.branches,
          history.openSnapshot,
        ),
        checks,
        chunks,
      );
    const action = actionOf();
    const list = (actor: Actor = drafts, by = action) =>
      by.handle({
        actor,
        id: changeSet.id,
        filter: {},
        page: { number: 1, size: 200 },
      });
    return { list, reads, actionOf, chunks };
  }

  it('checks a change set of a few modules each near the limits as before', async () => {
    const { list } = changeSetOf(many(5));
    const codes = (await list()).items.map((c) => c.code);
    expect(codes).not.toContain('chunk-set-too-large');
    expect(codes).not.toContain('chunks-not-checked');
    expect(codes).not.toContain('expansion-too-large');
  });

  it('stops cutting the chunks of a run of many modules at its budget, and says so (#711)', async () => {
    const { checks } = setUp();
    const { modules, reads } = diamond();
    const added = many(100);
    const run = await checks.changes(
      readable(
        { config, modules: [...modules, ...added] },
        drafts,
        'content.read.draft',
      ),
      added.map((m) => ({ type: 'module', lang: 'en', moduleId: m.id })),
    );
    // Each cut reads the top's blocks three times (finding what it includes, its weight, its
    // walk); the run reads them once more for cycles. Its budget (`ExpansionBudget.forContent`
    // over the modules it checks, whose content is small: about the room for 32 modules at
    // 500,000 nodes) is spent at about 61 cuts of 262,000: never all 100.
    expect(reads()).toBeLessThan(1 + 3 * 65);
    expect(reads()).toBeGreaterThan(1 + 3 * 55);
    const stopped = run.checks.filter((c) => c.code === 'chunks-not-checked');
    expect(stopped).toHaveLength(1);
    expect(severityOf(stopped[0] as never)).toBe('warning');
    // At the first module not cut, saying how many were not.
    const at = Number(
      (stopped[0]?.subject as { moduleId: string }).moduleId.slice(1),
    );
    expect(at).toBeGreaterThan(55);
    expect(at).toBeLessThan(65);
    expect(stopped[0]?.params).toEqual({ modules: String(100 - at) });
  });

  it('keeps each cut with what it spent: checking again cuts nothing and says the same', async () => {
    const { checks } = setUp();
    const { list, reads, actionOf } = changeSetOf(many(100), checks);
    const first = (await list()).items;
    const once = reads();
    // Another action (none of its checks kept), the same cuts kept by `ContentChecks`.
    const again = (await list(drafts, actionOf())).items;
    expect(again).toEqual(first);
    // The second run reads the top only for cycles and for the last few cuts, made on the
    // run's budget itself once it has less room left than a module at the limits (not kept):
    // at most 1 + 3 × 5 reads, against hundreds for the first.
    expect(once).toBeGreaterThan(200);
    expect(reads() - once).toBeLessThanOrEqual(1 + 3 * 5);
  });

  it('reports a head whose chunks are too large together as blocking, at the modules that spent the most (#710)', async () => {
    const { list } = changeSetOf(many(100));
    const items = (await list()).items;
    const large = items.filter((c) => c.code === 'chunk-set-too-large');
    // `meta.largest` of `GET /chunks`: up to five, the top first, then modules referring to it.
    expect(large.length).toBeGreaterThan(0);
    expect(large.length).toBeLessThanOrEqual(5);
    for (const check of large) {
      expect(severityOf(check)).toBe('blocking');
      expect(check.subject).toMatchObject({ type: 'module', lang: 'en' });
      expect(Number(check.params['chars'])).toBeGreaterThan(1_000_000);
      expect(Number(check.params['nodes'])).toBeGreaterThan(100_000);
    }
    expect(
      large.every((c) =>
        /^(j0|r\d{3})$/.test((c.subject as { moduleId: string }).moduleId),
      ),
    ).toBe(true);
  });

  it('tells a reader who may not see the modules that multiply nothing of them (#710)', async () => {
    const { list } = changeSetOf(many(100, 'internal'));
    expect(
      (await list()).items.filter((c) => c.code === 'chunk-set-too-large'),
    ).not.toEqual([]);
    const items = (await list(publicDrafts)).items;
    expect(items.map((c) => c.code)).not.toContain('chunk-set-too-large');
    expect(items.map((c) => c.code)).not.toContain('chunks-not-checked');
    expect(
      items.filter((c) =>
        (c.subject as { moduleId?: string }).moduleId?.startsWith('r'),
      ),
    ).toEqual([]);
  });

  it('keeps the head’s chunk set verdict: asking the checks again chunks nothing', async () => {
    const { list, reads, actionOf } = changeSetOf(many(100));
    await list();
    const once = reads();
    await list(drafts, actionOf());
    // As above: the set is not cut again, nor the cuts kept.
    expect(reads() - once).toBeLessThanOrEqual(1 + 3 * 5);
  });

  it('holds a manual’s chunk cuts to one budget too (#711)', async () => {
    const { modules } = diamond();
    const rs = many(100);
    const content: FakeContent = {
      config,
      modules: [...modules, ...rs],
      manifests: [
        manifest(
          'big',
          rs.map((m) => m.id),
        ),
      ],
    };
    const { manual } = setUp();
    const result = await manual.handle({
      actor: drafts,
      snapshot: readable(content, drafts, 'content.read.draft'),
      id: 'big',
      filter: {},
      page: { number: 1, size: 200 },
    });
    expect(
      result.items.filter((c) => c.code === 'chunks-not-checked'),
    ).toHaveLength(1);
  });
});

describe('the writing checks (#55)', () => {
  const LOADER = `schemaVersion: 1
status: approved
languages:
  en:
    preferred: charger
    forbidden:
      - term: loader
`;
  const said = (text: string, id = 'said') =>
    withBlocks(module(id), [
      { type: 'paragraph', id: 'p', content: [{ type: 'text', text }] },
    ]);
  const content = (
    configured: Record<string, unknown> = {},
    modules = [said('Plug in the loader. Utilise it.')],
  ): FakeContent => ({
    config: ProjectConfig.parse({
      ...config,
      styleRules: {
        en: {
          rules: [
            {
              id: 'use',
              pattern: '\\butilise\\b',
              message: 'Write “use”.',
              replacement: 'use',
            },
          ],
        },
      },
      ...configured,
    }),
    modules,
    manifests: [
      manifest(
        'op',
        modules.map((m) => m.id),
      ),
    ],
    terms: { charger: LOADER },
  });

  it('reports a forbidden term and a style rule at the block, as warnings by default', async () => {
    const { manual } = setUp();
    const result = await manual.handle({
      actor: drafts,
      snapshot: readable(content(), drafts, 'content.read.draft'),
      id: 'op',
      filter: {},
      page,
    });
    const writing = result.items.filter((c) => categoryOf(c) === 'writing');
    expect(
      writing.map((c) => [c.code, severityOf(c), c.blockId, c.params]),
    ).toEqual([
      [
        'forbidden-term',
        'warning',
        'p',
        {
          field: 'content',
          start: '12',
          end: '18',
          text: 'loader',
          replacement: 'charger',
          term: 'charger',
          status: 'forbidden',
        },
      ],
      [
        'style-rule',
        'warning',
        'p',
        {
          field: 'content',
          start: '20',
          end: '27',
          text: 'Utilise',
          replacement: 'use',
          rule: 'use',
          message: 'Write “use”.',
        },
      ],
    ]);
    expect(result.counts.blocking).toBe(0);
  });

  it('makes a forbidden term blocking when the configuration says so, counted as blocking', async () => {
    const { manual } = setUp();
    const result = await manual.handle({
      actor: drafts,
      snapshot: readable(
        content({ terminology: { forbiddenIsBlocking: true } }),
        drafts,
        'content.read.draft',
      ),
      id: 'op',
      filter: { severity: 'blocking' },
      page,
    });
    expect(result.items.map((c) => c.code)).toContain('forbidden-term');
    expect(result.counts.blocking).toBeGreaterThanOrEqual(1);
  });

  it('says where the checks stopped before the end of a module’s text', async () => {
    const { manual } = setUp();
    const result = await manual.handle({
      actor: drafts,
      snapshot: readable(
        content({}, [said('loader '.repeat(1_001))]),
        drafts,
        'content.read.draft',
      ),
      id: 'op',
      filter: {},
      page: { number: 1, size: 2_000 },
    });
    expect(
      result.items.filter((c) => c.code === 'forbidden-term'),
    ).toHaveLength(1_000);
    expect(
      result.items.filter((c) => c.code === 'writing-not-checked'),
    ).toEqual([expect.objectContaining({ params: { stopped: 'findings' } })]);
  });

  it('CheckContentAction checks every module and manual at the commit, or one manual', async () => {
    const { checks } = setUp();
    const action = new CheckContentAction(checks);
    const modules = [said('A loader.'), said('Another loader.', 'loose')];
    const fake = {
      ...content({}, modules),
      // The manual includes only the first module.
      manifests: [manifest('op', ['said'])],
    };
    const all = await action.handle({
      actor: drafts,
      snapshot: readable(fake, drafts, 'content.read.draft'),
    });
    expect(
      all.checks
        .filter((c) => c.code === 'forbidden-term')
        .map((c) => c.subject),
    ).toEqual([
      { type: 'module', lang: 'en', moduleId: 'loose' },
      { type: 'module', lang: 'en', moduleId: 'said' },
    ]);
    expect(all.commit).toMatch(/^[0-9a-f]{40}$/);
    const one = await action.handle({
      actor: drafts,
      snapshot: readable(fake, drafts, 'content.read.draft'),
      manualId: 'op',
    });
    expect(
      one.checks
        .filter((c) => c.code === 'forbidden-term')
        .map((c) => c.subject),
    ).toEqual([{ type: 'module', lang: 'en', moduleId: 'said' }]);
    await expect(
      action.handle({
        actor: drafts,
        snapshot: readable(fake, drafts, 'content.read.draft'),
        manualId: 'nope',
      }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      action.handle({
        actor: user('nobody', []),
        snapshot: readable(fake, drafts, 'content.read.draft'),
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});
