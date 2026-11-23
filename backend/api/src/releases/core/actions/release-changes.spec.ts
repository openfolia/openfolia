import { FakeReleaseDiffStore } from '../../../../tests/fakes/fake-release-diff-store.js';
import { type Module, ProjectConfig } from '@openfolia/content-model';
import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import { FakeJobQueue } from '../../../../tests/fakes/fake-job-queue.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import {
  config as baseConfig,
  manifest,
  module,
} from '../../../../tests/fakes/fake-content.js';
import { FakeHistory } from '../../../../tests/fakes/fake-history.js';
import { FakeMaintenanceLineStore } from '../../../../tests/fakes/fake-maintenance-lines.js';
import { FakeReleaseEvents } from '../../../../tests/fakes/fake-release-events.js';
import { FakeReleaseStore } from '../../../../tests/fakes/fake-release-store.js';
import { FakeReleaseTags } from '../../../../tests/fakes/fake-release-tags.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import type { Actor } from '../../../access/core/actor.js';
import { ForbiddenError, NotFoundError } from '../../../base/core/errors.js';
import { ReadableRefs } from '../../../content/core/readable-refs.js';
import { WithdrawnReleases } from '../../../content/core/withdrawn-releases.js';
import {
  newReleaseId,
  type Release,
  releaseMessage,
  type ReleaseText,
  releaseTextOf,
} from '../release.js';
import { CreateReleaseAction } from './create-release.action.js';
import {
  ListChangelogAction,
  ListReleaseChangesAction,
  ReleaseChangeReader,
} from './release-changes.action.js';
import { WithdrawReleaseAction } from './withdraw-release.action.js';

const config = ProjectConfig.parse({
  ...baseConfig,
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
  facets: [
    {
      id: 'product-line',
      label: 'Product line',
      values: [
        { id: 'tuggers', label: 'Tuggers' },
        { id: 'lifters', label: 'Lifters' },
      ],
    },
  ],
});

const publisher: Actor = {
  ...actorWith(['content.read', 'release.publish']),
  id: 'sample-publisher',
};

const internal = (m: Module): Module => ({
  ...m,
  meta: { ...m.meta, audience: 'internal' },
});

/** Modules `a`, `b` and `c` in English and German; manuals naming them. */
const v1 = {
  config,
  modules: ['a', 'b', 'c'].flatMap((id) => [module(id), module(id, 'de')]),
  manifests: [
    manifest('both', ['a', 'b']),
    manifest('only-a', ['a']),
    manifest('only-b', ['b']),
  ],
};

const page = { number: 1, size: 50 };

function setup() {
  const history = new FakeHistory(v1);
  const store = new FakeReleaseStore();
  const unit = new FakeUnitOfWork();
  const tags = new FakeReleaseTags();
  const audit = new FakeAuditLog();
  const events = new FakeReleaseEvents();
  const jobs = new FakeJobQueue();
  const lines = new FakeMaintenanceLineStore();
  store.lineOf = (id) => lines.released.get(id);
  const kept = new FakeReleaseDiffStore();
  /** A reader as a server process starting now has it: nothing in memory. */
  const newReader = () =>
    new ReleaseChangeReader(
      store,
      history.openSnapshot,
      history.branches,
      lines,
      kept,
    );
  const reader = newReader();
  const create = new CreateReleaseAction(
    history.openSnapshot,
    tags,
    store,
    audit,
    unit,
    events,
    reader,
    jobs,
    lines,
  );
  let at = Date.parse('2026-03-01T10:00:00Z');
  /** A release of `tuggers` at a new commit on main holding `content`. */
  const release = async (
    revision: string,
    content: Parameters<FakeHistory['onMain']>[0] = v1,
  ): Promise<Release> => {
    const commit = history.onMain(content).commit;
    const tag = `release/tuggers/${revision}`;
    history.tag(tag, commit);
    at += 1000;
    const r: Release = {
      id: newReleaseId(at),
      product: 'tuggers',
      productFacet: 'product-line',
      revision,
      tag,
      tagObject: 'e'.repeat(40),
      commit,
      notes: null,
      notesByLanguage: {},
      major: false,
      publishedBy: { kind: 'user', id: 'sample-publisher' },
      publishedAt: new Date(at),
      withdrawal: null,
    };
    store.rows.push(r);
    return r;
  };
  const withdraw = new WithdrawReleaseAction(
    store,
    history.openSnapshot,
    audit,
    events,
    unit,
  );
  return {
    history,
    store,
    lines,
    tags,
    audit,
    events,
    release,
    create,
    withdraw,
    kept,
    newReader,
    changes: new ListReleaseChangesAction(store, reader),
    changelog: new ListChangelogAction(store, reader),
  };
}

type T = ReturnType<typeof setup>;
const changesOf = async (t: T, r: Release, actor: Actor = READER) =>
  (await t.changes.handle({ actor, id: r.id, page })).items.map(
    (c) =>
      `${c.change} ${c.lang}/${c.manualId}${c.modules.map((m) => ` ${m.change}:${m.moduleId}`).join('')}`,
  );

describe('ListReleaseChangesAction on maintenance lines (#60)', () => {
  const changedB = {
    ...v1,
    modules: v1.modules.map((m) =>
      m.id === 'b' && m.meta.lang === 'en' ? module('b', 'en', 'Fixed.') : m,
    ),
  };
  const changedA = {
    ...v1,
    modules: v1.modules.map((m) =>
      m.id === 'a' && m.meta.lang === 'en' ? module('a', 'en', 'Newer.') : m,
    ),
  };

  it('counts a line’s release from the line’s previous, else its base; main’s never from a line’s', async () => {
    const t = setup();
    const base = await t.release('1.0');
    const newer = await t.release('2.0', changedA);
    const lineId = newReleaseId();
    t.lines.rows.push({
      id: lineId,
      product: 'tuggers',
      revision: '1.0',
      baseRelease: base.id,
      baseCommit: base.commit,
      branch: 'maintenance/tuggers/1.0',
      createdBy: { kind: 'user', id: 'sample-publisher' },
      createdAt: new Date(),
      closedAt: null,
      closedBy: null,
    });
    const fix = await t.release('1.0.1', changedB);
    t.lines.released.set(fix.id, lineId);
    // Against 1.0, not 2.0 (the product's newest before it).
    const first = await t.changes.handle({ actor: READER, id: fix.id, page });
    expect(first.previous?.id).toBe(base.id);
    expect(await changesOf(t, fix)).toEqual([
      'changed en/both changed:b',
      'changed en/only-b changed:b',
    ]);
    const again = await t.release('1.0.2', changedB);
    t.lines.released.set(again.id, lineId);
    expect(
      (await t.changes.handle({ actor: READER, id: again.id, page })).previous
        ?.id,
    ).toBe(fix.id);
    // main's next release counts from 2.0, past the line's.
    const later = await t.release('2.1', changedA);
    expect(
      (await t.changes.handle({ actor: READER, id: later.id, page })).previous
        ?.id,
    ).toBe(newer.id);
    // The base withdrawn: what it counted from (none: its product's first).
    t.store.withdrawals.set(base.id, {
      by: { kind: 'user', id: 'sample-publisher' },
      at: new Date(),
      reason: 'Wrong.',
    });
    expect(
      (await t.changes.handle({ actor: READER, id: fix.id, page })).previous,
    ).toBeNull();
  });
});

describe('ListReleaseChangesAction', () => {
  it('lists every manual as added in each language for a product’s first release', async () => {
    const t = setup();
    const first = await t.release('1.0');
    expect(await changesOf(t, first)).toEqual([
      'added de/both',
      'added en/both',
      'added de/only-a',
      'added en/only-a',
      'added de/only-b',
      'added en/only-b',
    ]);
    const result = await t.changes.handle({
      actor: READER,
      id: first.id,
      page: { number: 1, size: 2 },
    });
    expect(result.total).toBe(6);
    expect(result.items).toHaveLength(2);
    expect(result.previous).toBeNull();
  });

  it('lists a changed module under each manual and language it appears in, and nothing else', async () => {
    const t = setup();
    const first = await t.release('1.0');
    const second = await t.release('1.1', {
      ...v1,
      modules: v1.modules.map((m) =>
        m.id === 'a' && m.meta.lang === 'en' ? module('a', 'en', 'Hi.') : m,
      ),
    });
    expect(await changesOf(t, second)).toEqual([
      'changed en/both changed:a',
      'changed en/only-a changed:a',
    ]);
    const [change] = (
      await t.changes.handle({ actor: READER, id: second.id, page })
    ).items;
    expect(change).toEqual({
      manualId: 'both',
      lang: 'en',
      change: 'changed',
      fields: [],
      modules: [
        {
          moduleId: 'a',
          change: 'changed',
          fields: [],
          blocks: [{ blockId: 'p', change: 'changed' }],
        },
      ],
    });
    expect(
      (await t.changes.handle({ actor: READER, id: second.id, page })).previous
        ?.id,
    ).toBe(first.id);
  });

  it('lists manuals added, removed and with a changed manifest', async () => {
    const t = setup();
    await t.release('1.0');
    const second = await t.release('1.1', {
      ...v1,
      manifests: [
        { ...manifest('both', ['a', 'b']), title: 'Renamed' },
        manifest('only-a', ['a']),
        manifest('new', ['c']),
      ],
    });
    expect(await changesOf(t, second)).toEqual([
      'changed de/both',
      'changed en/both',
      'added de/new',
      'added en/new',
      'removed de/only-b',
      'removed en/only-b',
    ]);
    expect(
      (await t.changes.handle({ actor: READER, id: second.id, page })).items[0]
        ?.fields,
    ).toEqual(['title']);
  });

  it('never names a module or manual outside the reader’s scope', async () => {
    const t = setup();
    await t.release('1.0', {
      ...v1,
      modules: v1.modules.map((m) => (m.id === 'b' ? internal(m) : m)),
      manifests: [
        ...v1.manifests,
        { ...manifest('secret', ['a']), audience: 'internal' },
      ],
    });
    const second = await t.release('1.1', {
      ...v1,
      modules: v1.modules.map((m) =>
        m.id === 'b' ? internal(module('b', m.meta.lang, 'Changed.')) : m,
      ),
      manifests: [
        ...v1.manifests,
        { ...manifest('secret', ['a']), audience: 'internal', title: 'New' },
      ],
    });
    const everything = await changesOf(t, second);
    expect(everything).toEqual([
      'changed de/both changed:b',
      'changed en/both changed:b',
      'changed de/only-b changed:b',
      'changed en/only-b changed:b',
      'changed de/secret',
      'changed en/secret',
    ]);
    const publicOnly = actorWith(['content.read'], { maxAudience: 'public' });
    expect(await changesOf(t, second, publicOnly)).toEqual([]);
    const german = actorWith(['content.read'], { languages: ['de'] });
    expect(await changesOf(t, second, german)).toEqual([
      'changed de/both changed:b',
      'changed de/only-b changed:b',
      'changed de/secret',
    ]);
  });

  it('counts from the previous release that is not withdrawn', async () => {
    const t = setup();
    const first = await t.release('1.0');
    const changed = {
      ...v1,
      modules: v1.modules.map((m) =>
        m.id === 'c' ? module('c', m.meta.lang, 'New.') : m,
      ),
    };
    const second = await t.release('1.1', changed);
    const third = await t.release('1.2', changed);
    expect(await changesOf(t, third)).toEqual([]);
    await t.withdraw.handle({
      actor: publisher,
      id: second.id,
      reason: 'Bad.',
    });
    const result = await t.changes.handle({
      actor: READER,
      id: third.id,
      page,
    });
    expect(result.previous?.id).toBe(first.id);
  });

  it('is 404 for an unknown release', async () => {
    const t = setup();
    await expect(
      t.changes.handle({ actor: READER, id: newReleaseId(), page }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('ListChangelogAction', () => {
  it('lists releases newest first with the manuals each changed, filtered by manual and language', async () => {
    const t = setup();
    const germanB = (text: string) => ({
      ...v1,
      modules: v1.modules.map((m) =>
        m.id === 'b' && m.meta.lang === 'de'
          ? internal(module('b', 'de', text))
          : m,
      ),
    });
    const first = await t.release('1.0', germanB('Alt.'));
    const second = await t.release('1.1', germanB('Neu.'));
    const list = (filter = {}, actor: Actor = READER) =>
      t.changelog.handle({ actor, filter, page });
    const all = await list();
    expect(
      all.items.map((e) => [e.release.revision, e.changedManuals]),
    ).toEqual([
      ['1.1', 2],
      ['1.0', 3],
    ]);
    expect(all.truncated).toBe(false);
    expect(
      (await list({ manual: 'only-a' })).items.map((e) => e.release.id),
    ).toEqual([first.id]);
    expect(
      (await list({ manual: 'only-b', lang: 'de' })).items.map(
        (e) => e.release.id,
      ),
    ).toEqual([second.id, first.id]);
    expect(
      (await list({ manual: 'only-b', lang: 'en' })).items.map(
        (e) => e.release.id,
      ),
    ).toEqual([first.id]);
    // The German change is to an internal module: a public reader learns
    // nothing of it, neither in the count nor by filtering.
    const publicOnly = actorWith(['content.read'], { maxAudience: 'public' });
    expect(
      (await list({}, publicOnly)).items.map((e) => e.changedManuals),
    ).toEqual([0, 3]);
    const filtered = await list({ manual: 'only-b', lang: 'de' }, publicOnly);
    expect(filtered.items.map((e) => e.release.id)).toEqual([first.id]);
    expect(filtered.total).toBe(1);
  });

  it('works each release’s diff out from Git once, whoever asks, and still filters it per reader', async () => {
    const t = setup();
    await t.release('1.0');
    await t.release('1.1', {
      ...v1,
      modules: v1.modules.map((m) =>
        m.id === 'b' ? internal(module('b', m.meta.lang, 'Changed.')) : m,
      ),
    });
    const diffs = vi.spyOn(t.history.branches, 'changedPaths');
    const publicOnly = actorWith(['content.read'], { maxAudience: 'public' });
    const counts = async (actor: Actor, filter = {}) =>
      (await t.changelog.handle({ actor, filter, page })).items.map(
        (e) => `${e.release.revision}:${e.changedManuals}`,
      );
    expect(await counts(READER)).toEqual(['1.1:2', '1.0:3']);
    expect(diffs).toHaveBeenCalledTimes(1);
    // b moved into the internal audience: for a public reader it left.
    expect(await counts(publicOnly)).toEqual(['1.1:2', '1.0:3']);
    expect(await counts(publicOnly, { manual: 'only-b' })).toEqual([
      '1.1:2',
      '1.0:3',
    ]);
    expect(await counts(READER, { lang: 'de' })).toEqual(['1.1:2', '1.0:3']);
    expect(diffs).toHaveBeenCalledTimes(1);
    const removed = await changesOf(t, t.store.rows[1] as Release, publicOnly);
    expect(removed).toEqual([
      'changed de/both removed:b',
      'changed en/both removed:b',
      'changed de/only-b removed:b',
      'changed en/only-b removed:b',
    ]);
    const internalB = actorWith(['content.read'], {
      maxAudience: 'public',
      languages: ['en'],
    });
    expect(await changesOf(t, t.store.rows[1] as Release, internalB)).toEqual([
      'changed en/both removed:b',
      'changed en/only-b removed:b',
    ]);
    expect(diffs).toHaveBeenCalledTimes(1);
  });

  it('keeps each diff, so a restarted server reads it without Git, and still filters it per reader (#478)', async () => {
    const t = setup();
    await t.release('1.0');
    const second = await t.release('1.1', {
      ...v1,
      modules: v1.modules.map((m) =>
        m.id === 'b' ? internal(module('b', m.meta.lang, 'Changed.')) : m,
      ),
    });
    const publicOnly = actorWith(['content.read'], { maxAudience: 'public' });
    const counts = async (changelog: ListChangelogAction, actor: Actor) =>
      (await changelog.handle({ actor, filter: {}, page })).items.map(
        (e) => `${e.release.revision}:${e.changedManuals}`,
      );
    const before = {
      all: await counts(t.changelog, READER),
      scoped: await changesOf(t, second, publicOnly),
    };
    expect(t.kept.rows.size).toBe(2);
    const diffs = vi.spyOn(t.history.branches, 'changedPaths');
    const snapshot = t.history.commits.get(second.commit);
    if (!snapshot) throw new Error('no snapshot');
    const reads = vi.spyOn(snapshot, 'module');
    const reader = t.newReader();
    const changelog = new ListChangelogAction(t.store, reader);
    const changes = new ListReleaseChangesAction(t.store, reader);
    expect(await counts(changelog, READER)).toEqual(before.all);
    expect(
      (
        await changes.handle({ actor: publicOnly, id: second.id, page })
      ).items.map(
        (c) =>
          `${c.change} ${c.lang}/${c.manualId}${c.modules.map((m) => ` ${m.change}:${m.moduleId}`).join('')}`,
      ),
    ).toEqual(before.scoped);
    expect(before.scoped).toContain('changed en/only-b removed:b');
    expect(diffs).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
  });

  it('opens each release’s commit once per changelog, and no commit as the release reader once its diff is kept', async () => {
    const t = setup();
    await t.release('1.0');
    await t.release('1.1');
    await t.release('1.2');
    await t.changelog.handle({ actor: READER, filter: {}, page });
    const opens = vi.spyOn(t.history.openSnapshot, 'handle');
    const { items } = await t.changelog.handle({
      actor: READER,
      filter: {},
      page,
    });
    expect(items).toHaveLength(3);
    expect(opens.mock.calls.map(([input]) => input.actor)).toEqual([
      READER,
      READER,
      READER,
    ]);
    expect(new Set(opens.mock.calls.map(([input]) => input.ref)).size).toBe(3);
  });

  it('works a diff out again when the kept one is gone', async () => {
    const t = setup();
    await t.release('1.0');
    await t.release('1.1');
    await t.changelog.handle({ actor: READER, filter: {}, page });
    t.kept.rows.clear();
    const diffs = vi.spyOn(t.history.branches, 'changedPaths');
    const changelog = new ListChangelogAction(t.store, t.newReader());
    const { items } = await changelog.handle({
      actor: READER,
      filter: {},
      page,
    });
    expect(items.map((e) => e.changedManuals)).toEqual([0, 3]);
    expect(diffs).toHaveBeenCalledTimes(1);
    expect(t.kept.rows.size).toBe(2);
  });

  it('decides once that a pair of releases is too large to compare, and lists it uncounted', async () => {
    const t = setup();
    await t.release('1.0');
    const second = await t.release('1.1');
    const diffs = vi
      .spyOn(t.history.branches, 'changedPaths')
      .mockResolvedValue(
        Array.from({ length: 10_001 }, (_, i) => ({
          path: `modules/en/m${i}.adoc`,
          deleted: false,
        })),
      );
    const snapshot = t.history.commits.get(second.commit);
    if (!snapshot) throw new Error('no snapshot');
    const manuals = vi.spyOn(snapshot, 'manifests');
    for (let i = 0; i < 2; i++) {
      await expect(
        t.changes.handle({ actor: READER, id: second.id, page }),
      ).rejects.toMatchObject({ code: 'too-many-changes' });
    }
    const filtered = await t.changelog.handle({
      actor: READER,
      filter: { manual: 'only-a' },
      page,
    });
    expect(
      filtered.items.map((e) => `${e.release.revision}:${e.changedManuals}`),
    ).toEqual(['1.1:null', '1.0:3']);
    expect(diffs).toHaveBeenCalledTimes(1);
    // Decided before any manifest is read.
    expect(manuals).not.toHaveBeenCalled();
  });

  it('shows a withdrawn release withdrawn, with its reason', async () => {
    const t = setup();
    const first = await t.release('1.0');
    await t.withdraw.handle({
      actor: publisher,
      id: first.id,
      reason: 'Wrong torque values.',
    });
    const [entry] = (
      await t.changelog.handle({ actor: READER, filter: {}, page })
    ).items;
    expect(entry?.release.withdrawal).toEqual({
      by: { kind: 'user', id: 'sample-publisher' },
      at: expect.any(Date),
      reason: 'Wrong torque values.',
    });
  });
});

describe('WithdrawReleaseAction', () => {
  it('marks the release withdrawn once, audits it and writes release.withdrawn', async () => {
    const t = setup();
    const r = await t.release('1.0');
    const withdrawn = await t.withdraw.handle({
      actor: publisher,
      id: r.id,
      reason: 'Wrong torque values.',
    });
    expect(withdrawn).toEqual({
      ...r,
      withdrawal: {
        by: { kind: 'user', id: 'sample-publisher' },
        at: expect.any(Date),
        reason: 'Wrong torque values.',
      },
    });
    expect(t.store.rows.find((row) => row.id === r.id)).toEqual(
      t.store.rows[0],
    );
    expect(t.audit.events).toEqual([
      expect.objectContaining({
        action: 'release.withdraw',
        subject: { type: 'release', id: r.id },
        comment: 'Wrong torque values.',
        data: {
          product: 'tuggers',
          revision: '1.0',
          tag: r.tag,
          commit: r.commit,
        },
      }),
    ]);
    expect(t.events.events).toEqual([
      {
        topic: 'release.withdrawn',
        key: r.id,
        payload: {
          releaseId: r.id,
          product: 'tuggers',
          revision: '1.0',
          tag: r.tag,
          commit: r.commit,
          reason: 'Wrong torque values.',
          actor: { kind: 'user', id: 'sample-publisher' },
        },
      },
    ]);
    // The tag stays.
    expect(t.history.tags.map((tag) => tag.name)).toEqual([r.tag]);
    await expect(
      t.withdraw.handle({ actor: publisher, id: r.id, reason: 'Again.' }),
    ).rejects.toMatchObject({ code: 'release-withdrawn' });
    expect(t.audit.events).toHaveLength(1);
  });

  it('needs release.publish over the whole product', async () => {
    const t = setup();
    const r = await t.release('1.0');
    for (const actor of [
      READER,
      actorWith(['content.read', 'release.publish'], { languages: ['de'] }),
      actorWith(['content.read', 'release.publish'], {
        facets: { 'product-line': ['lifters'] },
      }),
    ]) {
      await expect(
        t.withdraw.handle({ actor, id: r.id, reason: 'No.' }),
      ).rejects.toThrow(ForbiddenError);
    }
    await expect(
      t.withdraw.handle({ actor: publisher, id: newReleaseId(), reason: 'x' }),
    ).rejects.toThrow(NotFoundError);
    expect(t.store.withdrawals.size).toBe(0);
  });

  it('leaves a withdrawn release’s tag out of the releases that count', async () => {
    const t = setup();
    const first = await t.release('1.0');
    const second = await t.release('1.1');
    class Withdrawn extends WithdrawnReleases {
      async withdrawals() {
        return new Map(
          t.store.rows.flatMap((row) => {
            const withdrawal = t.store.withdrawals.get(row.id);
            return withdrawal ? [[row.tag, withdrawal] as const] : [];
          }),
        );
      }
    }
    const refs = new ReadableRefs(t.history, new Withdrawn());
    expect((await refs.releases()).map((r) => r.name)).toEqual([
      second.tag,
      first.tag,
    ]);
    await t.withdraw.handle({ actor: publisher, id: second.id, reason: 'x' });
    expect((await refs.releases()).map((r) => r.name)).toEqual([first.tag]);
  });
});

describe('CreateReleaseAction with notes per language and major', () => {
  it('keeps them in the release and its tag, and writes release.published', async () => {
    const t = setup();
    await t.release('1.0');
    t.history.onMain({
      ...v1,
      modules: v1.modules.map((m) =>
        m.id === 'a' && m.meta.lang === 'de' ? module('a', 'de', 'Neu.') : m,
      ),
    });
    const release = await t.create.handle({
      actor: publisher,
      product: 'tuggers',
      revision: '2.0',
      notes: 'What changed.',
      notesByLanguage: { de: 'Was sich änderte.' },
      major: true,
    });
    expect(release).toMatchObject({
      notes: 'What changed.',
      notesByLanguage: { de: 'Was sich änderte.' },
      major: true,
      withdrawal: null,
    });
    const message = t.tags.tags.get(release.tag)?.message as string;
    expect(message).toBe(
      'Release tuggers 2.0 (major)\n\nWhat changed.\n\n[notes:de]\nWas sich änderte.',
    );
    expect(releaseTextOf(message, 'tuggers', '2.0')).toEqual({
      notes: 'What changed.',
      notesByLanguage: { de: 'Was sich änderte.' },
      major: true,
    });
    expect(t.events.events).toEqual([
      {
        topic: 'release.published',
        key: release.id,
        payload: {
          releaseId: release.id,
          product: 'tuggers',
          revision: '2.0',
          tag: release.tag,
          tagObject: release.tagObject,
          commit: release.commit,
          major: true,
          level: 'major',
          actor: { kind: 'user', id: 'sample-publisher' },
          manualIds: ['both', 'only-a'],
          modules: [{ moduleId: 'a', lang: 'de', change: 'changed' }],
          complete: true,
        },
      },
    ]);
  });

  it('publishes the release even when its changes cannot be worked out', async () => {
    const t = setup();
    await t.release('1.0');
    vi.spyOn(t.history.branches, 'changedPaths').mockRejectedValue(
      new NotFoundError('no such commit'),
    );
    const release = await t.create.handle({
      actor: publisher,
      product: 'tuggers',
      revision: '2.0',
      notes: null,
    });
    expect(t.store.rows.find((r) => r.id === release.id)?.tagObject).toBe(
      release.tagObject,
    );
    expect(t.events.events[0]?.payload).toMatchObject({
      manualIds: ['both', 'only-a', 'only-b'],
      modules: [],
      complete: false,
    });
  });

  it('refuses notes in a language not configured', async () => {
    const t = setup();
    await expect(
      t.create.handle({
        actor: publisher,
        product: 'tuggers',
        revision: '2.0',
        notes: null,
        notesByLanguage: { fr: 'Quoi de neuf.' },
      }),
    ).rejects.toMatchObject({ code: 'invalid-language', meta: { lang: 'fr' } });
    expect(t.tags.tags.size).toBe(0);
  });

  it('refuses notes too long for a tag message, in all languages together', async () => {
    const t = setup();
    const targets = ['de', 'fr', 'it', 'es', 'nl', 'pl'];
    t.history.onMain({
      ...v1,
      config: ProjectConfig.parse({
        ...config,
        languages: { source: 'en', targets },
      }),
    });
    const long = 'x'.repeat(10_000);
    await expect(
      t.create.handle({
        actor: publisher,
        product: 'tuggers',
        revision: '2.0',
        notes: long,
        notesByLanguage: Object.fromEntries(targets.map((l) => [l, long])),
      }),
    ).rejects.toMatchObject({ code: 'invalid-notes' });
    expect(t.tags.tags.size).toBe(0);
  });
});

describe('releaseMessage and releaseTextOf', () => {
  it('read back exactly what they wrote', () => {
    const texts: ReleaseText[] = [
      { notes: null, notesByLanguage: {}, major: false },
      { notes: 'One.\n\nTwo.', notesByLanguage: {}, major: true },
      {
        notes: null,
        notesByLanguage: { de: 'Eins.', en: 'One.' },
        major: false,
      },
      { notes: 'A', notesByLanguage: { de: 'B\n\nC' }, major: true },
    ];
    for (const text of texts) {
      const message = releaseMessage('tuggers', '1.0', text);
      expect(releaseTextOf(message, 'tuggers', '1.0')).toEqual(text);
    }
    expect(releaseTextOf('Something else', 'tuggers', '1.0')).toBeUndefined();
  });
});
