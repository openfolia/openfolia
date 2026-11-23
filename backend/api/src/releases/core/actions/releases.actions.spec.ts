import { FakeReleaseDiffStore } from '../../../../tests/fakes/fake-release-diff-store.js';
import { ProjectConfig } from '@openfolia/content-model';
import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import { FakeJobQueue } from '../../../../tests/fakes/fake-job-queue.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeChangeSetBranches } from '../../../../tests/fakes/fake-change-set-branches.js';
import { FakeReleaseEvents } from '../../../../tests/fakes/fake-release-events.js';
import { config as baseConfig } from '../../../../tests/fakes/fake-content.js';
import { FakeReleaseStore } from '../../../../tests/fakes/fake-release-store.js';
import { FakeReleaseTags } from '../../../../tests/fakes/fake-release-tags.js';
import { fakeOpenSnapshot } from '../../../../tests/fakes/fake-repository.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { FakeMaintenanceLineStore } from '../../../../tests/fakes/fake-maintenance-lines.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { newReleaseId } from '../release.js';
import { releasePriority } from '../release-output.js';
import {
  CreateReleaseAction,
  type CreateReleaseInput,
  RESUME_AFTER_MS,
} from './create-release.action.js';
import {
  GetReleaseAction,
  ListReleasesAction,
} from './read-releases.action.js';
import { ReleaseChangeReader } from './release-changes.action.js';

const config = ProjectConfig.parse({
  ...baseConfig,
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
  facets: [
    {
      id: 'region',
      label: 'Region',
      values: [{ id: 'north', label: 'North' }],
    },
    {
      id: 'product-line',
      label: 'Product line',
      values: [
        { id: 'tuggers', label: 'Tuggers' },
        { id: 'lifters', label: 'Lifters' },
      ],
    },
  ],
  release: { productFacet: 'product-line' },
});

const publisher = {
  ...actorWith(['content.read', 'release.publish']),
  id: 'sample-publisher',
};

function setup(content = { config }) {
  const open = fakeOpenSnapshot(content);
  const tags = new FakeReleaseTags();
  const store = new FakeReleaseStore();
  const audit = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const events = new FakeReleaseEvents();
  const jobs = new FakeJobQueue();
  const lines = new FakeMaintenanceLineStore();
  const reader = new ReleaseChangeReader(
    store,
    open,
    new FakeChangeSetBranches(),
    lines,
    new FakeReleaseDiffStore(),
  );
  const create = new CreateReleaseAction(
    open,
    tags,
    store,
    audit,
    unit,
    events,
    reader,
    jobs,
    lines,
  );
  const cut = (over: Partial<CreateReleaseInput> = {}) =>
    create.handle({
      actor: publisher,
      product: 'tuggers',
      revision: '2.1',
      notes: 'What changed.',
      ...over,
    });
  return {
    open,
    tags,
    jobs,
    store,
    audit,
    unit,
    lines,
    events,
    reader,
    cut,
    list: new ListReleasesAction(store),
    get: new GetReleaseAction(store),
  };
}

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (e: unknown) =>
      e instanceof ConflictError || e instanceof UnprocessableError
        ? e.code
        : e instanceof ForbiddenError
          ? 'forbidden'
          : String(e),
  );

describe('CreateReleaseAction', () => {
  it('tags main’s commit as the product revision, records it and audits it', async () => {
    const t = setup();
    const release = await t.cut();
    expect(release).toEqual({
      id: expect.any(String),
      product: 'tuggers',
      productFacet: 'product-line',
      revision: '2.1',
      tag: 'release/tuggers/2.1',
      tagObject: t.tags.tags.get('release/tuggers/2.1')?.tag,
      commit: expect.stringMatching(/^[0-9a-f]{40}$/),
      notes: 'What changed.',
      notesByLanguage: {},
      major: false,
      publishedBy: { kind: 'user', id: 'sample-publisher' },
      publishedAt: expect.any(Date),
      withdrawal: null,
    });
    expect(release.publishedAt.getMilliseconds()).toBe(0);
    expect(t.tags.tags.get(release.tag)).toMatchObject({
      commit: release.commit,
      message: 'Release tuggers 2.1\n\nWhat changed.',
      taggedAt: release.publishedAt,
    });
    expect(await t.get.handle({ actor: READER, id: release.id })).toEqual(
      release,
    );
    expect(t.audit.events).toEqual([
      expect.objectContaining({
        actor: { kind: 'user', id: 'sample-publisher' },
        action: 'release.publish',
        subject: { type: 'release', id: release.id },
        data: {
          product: 'tuggers',
          productFacet: 'product-line',
          revision: '2.1',
          tag: 'release/tuggers/2.1',
          tagObject: release.tagObject,
          commit: release.commit,
          major: false,
        },
      }),
    ]);
    // Its outputs are planned in the background (#249), keyed by it, newest release first (#497).
    expect(
      t.jobs.jobs.map((j) => [j.queue, j.key, j.payload, j.priority]),
    ).toEqual([
      [
        'release.plan-outputs',
        release.id,
        { releaseId: release.id },
        releasePriority(release),
      ],
    ]);
  });

  it('writes the title alone without notes', async () => {
    const t = setup();
    const release = await t.cut({ notes: null });
    expect(release.notes).toBeNull();
    expect(t.tags.tags.get(release.tag)?.message).toBe('Release tuggers 2.1');
  });

  it('never re-creates a release under the same name', async () => {
    const t = setup();
    const first = await t.cut();
    const again = t.cut({ notes: 'Another try.' });
    await expect(again).rejects.toMatchObject({
      code: 'release-exists',
      meta: { releaseId: first.id },
    });
    expect(t.store.rows).toHaveLength(1);
    expect(t.audit.events).toHaveLength(1);
  });

  it('takes only a value of the product facet, else the first facet', async () => {
    const t = setup();
    expect(await codeOf(t.cut({ product: 'north' }))).toBe('invalid-product');
    expect(await codeOf(t.cut({ product: 'nope' }))).toBe('invalid-product');
    const first = setup({ config: { ...config, release: undefined } });
    expect(await codeOf(first.cut({ product: 'tuggers' }))).toBe(
      'invalid-product',
    );
    expect((await first.cut({ product: 'north' })).productFacet).toBe('region');
    const none = setup({
      config: { ...config, facets: [], release: undefined },
    });
    expect(await codeOf(none.cut())).toBe('no-product-facet');
    expect(t.store.rows).toEqual([]);
    expect(t.tags.tags.size).toBe(0);
  });

  it('needs release.publish over the product in every language and audience', async () => {
    const t = setup();
    const cutAs = (actor: typeof publisher) => codeOf(t.cut({ actor }));
    const scoped = (scope: object) => ({
      ...publisher,
      roles: [
        {
          id: 'r',
          name: 'R',
          permissions: ['content.read', 'release.publish'] as const,
          scope,
        },
      ],
    });
    expect(await cutAs(READER as typeof publisher)).toBe('forbidden');
    expect(await cutAs(scoped({ languages: ['en'] }) as never)).toBe(
      'forbidden',
    );
    expect(await cutAs(scoped({ maxAudience: 'public' }) as never)).toBe(
      'forbidden',
    );
    expect(
      await cutAs(scoped({ facets: { 'product-line': ['lifters'] } }) as never),
    ).toBe('forbidden');
    expect(t.store.rows).toEqual([]);
    expect(
      await cutAs(scoped({ facets: { 'product-line': ['tuggers'] } }) as never),
    ).toBe('ok');
  });

  it('drops the reservation when the tag can never be made', async () => {
    const t = setup();
    t.tags.failure = {
      error: new UnprocessableError('invalid-message', 'trailers'),
      when: 'before',
    };
    expect(await codeOf(t.cut({ notes: 'See: below' }))).toBe('invalid-notes');
    expect(t.store.rows).toEqual([]);
    t.tags.failure = undefined;
    expect(await codeOf(t.cut())).toBe('ok');
  });

  it('keeps a reservation cut off after the tag, and finishes it later as first asked', async () => {
    const t = setup();
    t.tags.failure = { error: new Error('git died'), when: 'after' };
    await expect(t.cut()).rejects.toThrow('git died');
    t.tags.failure = undefined;
    expect(t.store.rows).toEqual([
      expect.objectContaining({ tagObject: null, notes: 'What changed.' }),
    ]);
    // Too early: it may still be being made.
    await expect(t.cut({ notes: 'Other notes.' })).rejects.toMatchObject({
      code: 'release-pending',
      meta: { releaseId: t.store.rows[0]?.id, retryAfter: expect.any(Number) },
    });
    // Once old enough, finished with the reservation's data and its tag.
    const reserved = t.store.rows[0];
    if (!reserved) throw new Error('no reservation');
    const old = new Date(reserved.publishedAt.getTime() - RESUME_AFTER_MS);
    t.store.rows[0] = { ...reserved, publishedAt: old };
    const tag = t.tags.tags.get(reserved.tag);
    if (tag) t.tags.tags.set(reserved.tag, { ...tag, taggedAt: old });
    const finished = await t.cut({ notes: 'Other notes.' });
    expect(finished).toMatchObject({
      id: reserved.id,
      notes: 'What changed.',
      tagObject: tag?.tag,
    });
    expect(t.audit.events).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          resumed: true,
          publishedBy: 'user/sample-publisher',
        }),
      }),
    ]);
    expect(
      await t.list.handle({
        actor: READER,
        filter: {},
        page: { number: 1, size: 10 },
      }),
    ).toEqual({
      total: 1,
      items: [finished],
    });
  });

  it('finishes a reservation whose tag was never made', async () => {
    const t = setup();
    t.tags.failure = { error: new Error('git busy'), when: 'before' };
    await expect(t.cut()).rejects.toThrow('git busy');
    t.tags.failure = undefined;
    const reserved = t.store.rows[0];
    if (!reserved) throw new Error('no reservation');
    t.store.rows[0] = {
      ...reserved,
      publishedAt: new Date(reserved.publishedAt.getTime() - RESUME_AFTER_MS),
    };
    expect((await t.cut()).id).toBe(reserved.id);
    expect(t.tags.tags.size).toBe(1);
  });

  it('never takes a tag of that name made outside the API', async () => {
    const t = setup();
    t.tags.tags.set('release/tuggers/2.1', {
      name: 'release/tuggers/2.1',
      tag: 'e'.repeat(40),
      commit: 'f'.repeat(40),
      message: 'Made by hand',
      taggedAt: new Date(),
    });
    expect(await codeOf(t.cut())).toBe('release-exists');
    expect(t.store.rows).toEqual([]);
    expect(t.audit.events).toEqual([]);
  });

  it('answers 409 when main is gone', async () => {
    const t = setup();
    const create = new CreateReleaseAction(
      {
        handle: () => Promise.reject(new NotFoundError('no main')),
      } as never,
      t.tags,
      t.store,
      t.audit,
      new FakeUnitOfWork(),
      t.events,
      t.reader,
      t.jobs,
      t.lines,
    );
    expect(
      await codeOf(
        create.handle({
          actor: publisher,
          product: 'tuggers',
          revision: '1',
          notes: null,
        }),
      ),
    ).toBe('branch-missing');
  });
});

describe('ListReleasesAction and GetReleaseAction', () => {
  it('list newest first, filtered by product, for any reader', async () => {
    const t = setup();
    const a = await t.cut({ revision: '1' });
    const b = await t.cut({ product: 'lifters', revision: '1' });
    const page = { number: 1, size: 10 };
    const listed = await t.list.handle({ actor: READER, filter: {}, page });
    expect(listed.total).toBe(2);
    expect(new Set(listed.items.map((r) => r.id))).toEqual(
      new Set([a.id, b.id]),
    );
    expect(
      (
        await t.list.handle({
          actor: READER,
          filter: { product: 'lifters' },
          page,
        })
      ).items,
    ).toEqual([b]);
    await expect(
      t.get.handle({ actor: READER, id: newReleaseId() }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      t.list.handle({ actor: actorWith([]), filter: {}, page }),
    ).rejects.toThrow(ForbiddenError);
  });
});
