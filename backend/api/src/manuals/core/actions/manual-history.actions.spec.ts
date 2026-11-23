import { type Manifest, ProjectConfig } from '@openfolia/content-model';
import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import {
  config as baseConfig,
  type FakeContent,
  manifest,
  module,
} from '../../../../tests/fakes/fake-content.js';
import { FakeHistory } from '../../../../tests/fakes/fake-history.js';
import { FakeUserDirectory } from '../../../../tests/fakes/fake-user-directory.js';
import { FakeWithdrawnReleases } from '../../../../tests/fakes/fake-withdrawn-releases.js';
import type { Actor } from '../../../access/core/actor.js';
import { NotFoundError } from '../../../base/core/errors.js';
import { newChangeSetId } from '../../../change-sets/core/change-set.js';
import { ReadableRefs } from '../../../content/core/readable-refs.js';
import { CompareManualVersionsAction } from './compare-manual-versions.action.js';
import { GetManualHistoryAction } from './get-manual-history.action.js';
import { ListManualsAction } from './list-manuals.action.js';

const config = ProjectConfig.parse({
  ...baseConfig,
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
});
const modules = [module('intro'), module('care')];
const at = (...manifests: Manifest[]): FakeContent => ({
  config,
  modules,
  manifests,
});
const guide = (title: string, ...entries: string[]): Manifest => ({
  ...manifest('guide', entries),
  title,
});
const internal = (m: Manifest): Manifest => ({ ...m, audience: 'internal' });
const publisher: Actor = { ...actorWith(['release.publish']), id: 'pub' };
const approver: Actor = { ...actorWith(['content.review']), id: 'rev' };
const drafts = actorWith(['content.read', 'content.read.draft']);
const publicOnly = actorWith(['content.read'], { maxAudience: 'public' });
/** Reads drafts, as #321's tests of what a reader sees: of the public audience only. */
const publicDrafts = actorWith(['content.read', 'content.read.draft'], {
  maxAudience: 'public',
});

const listManuals = (history: FakeHistory) =>
  new ListManualsAction(new ReadableRefs(history), history.openSnapshot);

/** Reads released content of every audience, drafts only of the public one (#410). */
const narrowDrafts: Actor = {
  kind: 'user',
  id: 'narrow-drafts',
  roles: [
    {
      id: 'reads',
      name: 'Reads',
      permissions: ['content.read'],
      scope: {},
    },
    {
      id: 'drafts',
      name: 'Drafts',
      permissions: ['content.read.draft'],
      scope: { maxAudience: 'public' },
    },
  ],
};

const merged = (changeSet: string, ...approvers: string[]) => ({
  parents: 2,
  message: 'A change\n\nMerge change set.',
  trailers: [
    { key: 'Merged-change-set', value: changeSet },
    { key: 'Merged-by', value: 'user/pub' },
    ...approvers.map((a) => ({ key: 'Approved-by', value: `user/${a}` })),
  ],
});

/**
 * `main`: no `guide`, then two merged change sets adding it and changing
 * its outline, with a commit changing only a module between them; `v1`
 * tags that commit (holding rev 1).
 */
function setUp() {
  const history = new FakeHistory(at());
  const ids = [newChangeSetId(), newChangeSetId()];
  const rev1 = history.onMain(
    at(guide('Guide', 'intro')),
    merged(ids[0] as string, 'rev'),
  );
  const unrelated = history.onMain(
    {
      ...at(guide('Guide', 'intro')),
      modules: [module('intro', 'en', 'Else.'), module('care')],
    },
    { message: 'Something else' },
  );
  history.tag('v1', unrelated.commit);
  const rev2 = history.onMain(
    {
      ...at(guide('Guide', 'intro', 'care')),
      modules: [module('intro', 'en', 'Else.'), module('care')],
    },
    merged(ids[1] as string, 'rev'),
  );
  const users = new FakeUserDirectory([publisher, approver]);
  const action = new GetManualHistoryAction(
    new ReadableRefs(history),
    history.openSnapshot,
    users,
  );
  const list = async (
    actor: Actor = READER,
    ref = 'main',
    id = 'guide',
    page = { number: 1, size: 50 },
  ) =>
    action.handle({
      actor,
      snapshot: await history.openSnapshot.handle({ actor, ref }),
      id,
      page,
    });
  const compare = (actor: Actor, base: string, head: string, id = 'guide') =>
    new CompareManualVersionsAction(history.openSnapshot).handle({
      actor,
      id,
      base,
      head,
    });
  return { history, ids, commits: { rev1, unrelated, rev2 }, list, compare };
}

describe('GetManualHistoryAction', () => {
  it('lists the versions with who, which change set, approvers and releases', async () => {
    const { ids, commits, list } = setUp();
    const page = await list();
    expect(page.total).toBe(2);
    expect(page.items.map((v) => [v.commit, v.revision, v.change])).toEqual([
      [commits.rev2.commit, 2, 'changed'],
      [commits.rev1.commit, 1, 'added'],
    ]);
    const [rev2, rev1] = page.items;
    expect(rev1).toMatchObject({
      actor: { kind: 'user', id: 'pub' },
      actorKnown: true,
      changeSetId: ids[0],
      knownApprovers: ['rev'],
      releases: [{ tag: 'v1', commit: commits.unrelated.commit }],
    });
    expect(rev2).toMatchObject({ changeSetId: ids[1], releases: [] });
  });

  it('is 404 for a manual outside the reader’s scope, or none', async () => {
    const { history, list } = setUp();
    history.onMain(at(internal(guide('Guide', 'intro', 'care'))), {
      message: 'Internal now',
    });
    await expect(list(publicDrafts)).rejects.toBeInstanceOf(NotFoundError);
    expect((await list(drafts)).total).toBe(3);
    await expect(list(drafts, 'main', 'none')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('counts only the versions the reader sees: one hidden is a removal, one shown again an addition', async () => {
    const { history, list } = setUp();
    history.onMain(at(internal(guide('Guide', 'intro', 'care'))), {
      message: 'Internal',
    });
    history.onMain(at(guide('Guide, public again', 'intro')), {
      message: 'Public again',
    });
    const page = await list(publicDrafts);
    expect(page.items.map((v) => [v.revision, v.change])).toEqual([
      [4, 'added'],
      [3, 'removed'],
      [2, 'changed'],
      [1, 'added'],
    ]);
  });

  it('keeps the history of a manual deleted at the ref, its newest version the removal', async () => {
    const { history, list } = setUp();
    const deleted = history.onMain(at(), { message: 'Drop it' });
    const page = await list(drafts);
    expect(page.items[0]).toMatchObject({
      commit: deleted.commit,
      change: 'removed',
    });
    expect(page.items[0]?.fileRevision).toBeUndefined();
  });

  it('is 404 for a deleted manual whose last manifest the reader may not see', async () => {
    const { history, list } = setUp();
    history.onMain(at(internal(guide('Guide', 'intro'))), { message: 'Hide' });
    history.onMain(at(), { message: 'Drop it' });
    await expect(list(publicDrafts)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('a change to entries hidden from the reader', () => {
  const secret = {
    ...module('secret'),
    meta: { ...module('secret').meta, audience: 'internal' },
  };
  const withSecret = (...manifests: Manifest[]): FakeContent => ({
    config,
    modules: [...modules, secret],
    manifests,
  });
  /** `guide` naming `intro`, then also the internal `secret`, then `secret` moved first. */
  function hiddenSetUp() {
    const history = new FakeHistory(withSecret());
    const added = history.onMain(withSecret(guide('Guide', 'intro')), {
      message: 'Add',
    });
    const named = history.onMain(
      withSecret(guide('Guide', 'intro', 'secret')),
      {
        message: 'Name the secret',
      },
    );
    const moved = history.onMain(
      withSecret(guide('Guide', 'secret', 'intro')),
      {
        message: 'Move the secret',
      },
    );
    const action = new GetManualHistoryAction(
      new ReadableRefs(history),
      history.openSnapshot,
      new FakeUserDirectory([]),
    );
    const list = async (actor: Actor) =>
      action.handle({
        actor,
        snapshot: await history.openSnapshot.handle({ actor, ref: 'main' }),
        id: 'guide',
        page: { number: 1, size: 50 },
      });
    return { history, commits: { added, named, moved }, list };
  }

  it('is no version to a reader who may not see them; a reader of everything sees each', async () => {
    const { commits, list } = hiddenSetUp();
    const narrow = await list(publicDrafts);
    expect(narrow.items.map((v) => v.commit)).toEqual([commits.added.commit]);
    const full = await list(drafts);
    expect(full.items.map((v) => v.commit)).toEqual([
      commits.moved.commit,
      commits.named.commit,
      commits.added.commit,
    ]);
  });

  it('stays hidden once the hidden module is deleted too: no version, and not named by the deleted manual', async () => {
    const { history, commits, list } = hiddenSetUp();
    // The guide and the secret module go in one commit.
    history.onMain(at(), { message: 'Drop both' });
    const narrow = await list(publicDrafts);
    expect(narrow.items.map((v) => v.change)).toEqual(['removed', 'added']);
    expect(narrow.items[1]?.commit).toBe(commits.added.commit);
    expect((await list(drafts)).total).toBe(4);
    const deleted = await listManuals(history).handle({
      actor: publicDrafts,
      snapshot: await history.openSnapshot.handle({
        actor: publicDrafts,
        ref: 'main',
      }),
      page: { number: 1, size: 50 },
      status: 'deleted',
    });
    expect(
      deleted.items.map((m) => ('manifest' in m ? m.manifest.entries : [])),
    ).toEqual([[{ module: 'intro' }]]);
  });

  it('is not shown by a compare', async () => {
    const { history, commits } = hiddenSetUp();
    const result = await new CompareManualVersionsAction(
      history.openSnapshot,
    ).handle({
      actor: publicDrafts,
      id: 'guide',
      base: commits.added.commit,
      head: commits.moved.commit,
    });
    expect(result.change).toBeUndefined();
    expect(result.head.manifest).toMatchObject({
      entries: [{ module: 'intro' }],
    });
  });
});

describe('a reader of released content only (#410)', () => {
  it('is listed only the versions released content holds, each to be read at a released commit', async () => {
    const { history, commits, list, compare } = setUp();
    const rev3 = history.onMain(at(guide('Renamed', 'intro', 'care')), {
      message: 'Rename',
    });
    const rev4 = history.onMain(at(guide('Final', 'intro')), {
      message: 'Finish',
    });
    const page = await list(READER);
    // rev 2 and rev 3 were never released: no version to them.
    expect(page.total).toBe(2);
    expect(
      page.items.map((v) => [v.commit, v.revision, v.readAt, v.releases]),
    ).toEqual([
      // `main`'s head holds it.
      [rev4.commit, 4, rev4.commit, []],
      // `v1` holds it, on a later commit.
      [
        commits.rev1.commit,
        1,
        commits.unrelated.commit,
        [{ tag: 'v1', commit: commits.unrelated.commit }],
      ],
    ]);
    // What they are listed, they may read where it is listed.
    const [newest, oldest] = page.items;
    expect(
      (await compare(READER, oldest?.readAt ?? '', newest?.readAt ?? ''))
        .change,
    ).toMatchObject({ change: 'changed', fields: ['title'] });
    // Never at the versions' own commits, which are not released.
    await expect(
      compare(READER, commits.rev1.commit, rev4.commit),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      compare(READER, commits.rev2.commit, rev3.commit),
    ).rejects.toBeInstanceOf(NotFoundError);
    // A reader of drafts still gets every version, each read at its own commit.
    const all = await list(drafts);
    expect(all.items.map((v) => [v.commit, v.readAt])).toEqual(
      [rev4, rev3, commits.rev2, commits.rev1].map((c) => [c.commit, c.commit]),
    );
  });

  it('pages and counts only what they are listed', async () => {
    const { history, commits, list } = setUp();
    history.onMain(at(guide('Renamed', 'intro', 'care')), {
      message: 'Rename',
    });
    const first = await list(READER, 'main', 'guide', { number: 1, size: 1 });
    expect(first.total).toBe(2);
    const second = await list(READER, 'main', 'guide', { number: 2, size: 1 });
    expect(second.items.map((v) => v.commit)).toEqual([commits.rev1.commit]);
  });

  it('is 404 for a manual no released content ever held, also once deleted', async () => {
    const history = new FakeHistory(at());
    history.onMain(at(guide('Draft', 'intro')), { message: 'Add' });
    history.onMain(at(), { message: 'Drop it' });
    const action = new GetManualHistoryAction(
      new ReadableRefs(history),
      history.openSnapshot,
      new FakeUserDirectory([]),
    );
    const list = async (actor: Actor) =>
      action.handle({
        actor,
        snapshot: await history.openSnapshot.handle({ actor, ref: 'main' }),
        id: 'guide',
        page: { number: 1, size: 50 },
      });
    await expect(list(READER)).rejects.toBeInstanceOf(NotFoundError);
    expect((await list(drafts)).items.map((v) => v.change)).toEqual([
      'removed',
      'added',
    ]);
  });
});

describe('a reader whose draft scope is narrower than their read scope (#410)', () => {
  it('is listed only released versions of a manual whose versions their draft scope does not show alike', async () => {
    const history = new FakeHistory(at());
    const draftOnly = history.onMain(at(internal(guide('Draft', 'intro'))), {
      message: 'Add, internal',
    });
    const head = history.onMain(
      at(internal(guide('Released', 'intro', 'care'))),
      { message: 'Change' },
    );
    const action = new GetManualHistoryAction(
      new ReadableRefs(history),
      history.openSnapshot,
      new FakeUserDirectory([]),
    );
    const list = async (actor: Actor) =>
      action.handle({
        actor,
        snapshot: await history.openSnapshot.handle({ actor, ref: 'main' }),
        id: 'guide',
        page: { number: 1, size: 50 },
      });
    // Internal: outside their draft scope, so only what `main` holds.
    const narrow = await list(narrowDrafts);
    expect(narrow.items.map((v) => [v.commit, v.readAt])).toEqual([
      [head.commit, head.commit],
    ]);
    expect((await list(drafts)).items.map((v) => v.commit)).toEqual([
      head.commit,
      draftOnly.commit,
    ]);
    // Public now, but its internal versions are still drafts outside their
    // draft scope: still only what `main` holds.
    const pub = history.onMain(at(guide('Public', 'intro')), {
      message: 'Public',
    });
    expect((await list(narrowDrafts)).items.map((v) => v.commit)).toEqual([
      pub.commit,
    ]);
  });

  it('is listed every version when their draft scope shows them alike', async () => {
    const { history, commits, list } = setUp();
    // Public, and never released.
    const draft = history.onMain(at(guide('Renamed', 'intro', 'care')), {
      message: 'Rename',
    });
    const head = history.onMain(at(guide('Final', 'intro')), {
      message: 'Finish',
    });
    expect((await list(narrowDrafts)).items.map((v) => v.commit)).toEqual([
      head.commit,
      draft.commit,
      commits.rev2.commit,
      commits.rev1.commit,
    ]);
  });

  it('is listed a deleted manual outside their draft scope only from released content', async () => {
    const history = new FakeHistory(at());
    history.onMain(
      at(
        { ...internal(manifest('secret', ['care'])), title: 'Secret draft' },
        { ...manifest('open', ['intro']), title: 'Open draft' },
      ),
      { message: 'Add' },
    );
    history.onMain(at(), { message: 'Drop both' });
    const deleted = await listManuals(history).handle({
      actor: narrowDrafts,
      snapshot: await history.openSnapshot.handle({
        actor: narrowDrafts,
        ref: 'main',
      }),
      page: { number: 1, size: 50 },
      status: 'deleted',
    });
    // The internal one's last manifest is a draft outside their draft scope.
    expect(deleted.items.map((m) => m.id)).toEqual(['open']);
  });
});

describe('a release read by its tag (#410)', () => {
  it('holds its own version, also once withdrawn and no longer checked as a release', async () => {
    const history = new FakeHistory(at());
    const tagged = history.onMain(at(guide('Tagged', 'intro')), {
      message: 'Add',
    });
    history.tag('v1', tagged.commit);
    history.onMain(at(guide('Later', 'intro', 'care')), { message: 'Change' });
    const withdrawn = new FakeWithdrawnReleases();
    withdrawn.withdraw('v1');
    const action = new GetManualHistoryAction(
      new ReadableRefs(history, withdrawn),
      history.openSnapshot,
      new FakeUserDirectory([]),
    );
    const page = await action.handle({
      actor: READER,
      snapshot: await history.openSnapshot.handle({ actor: READER, ref: 'v1' }),
      id: 'guide',
      page: { number: 1, size: 50 },
    });
    expect(page.items.map((v) => [v.commit, v.readAt])).toEqual([
      [tagged.commit, tagged.commit],
    ]);
  });
});

describe('CompareManualVersionsAction', () => {
  it('compares two versions, the outline as a change', async () => {
    const { commits, compare } = setUp();
    const result = await compare(
      drafts,
      commits.rev1.commit,
      commits.rev2.commit,
    );
    expect(result.change).toMatchObject({ change: 'changed' });
    expect(result.change?.fields).toEqual(['entries']);
    expect(result.base.manifest).toMatchObject({
      entries: [{ module: 'intro' }],
    });
    expect(result.head.manifest).toMatchObject({
      entries: [{ module: 'intro' }, { module: 'care' }],
    });
  });

  it('a side without it is added or removed; 404 on neither', async () => {
    const { history, commits, compare } = setUp();
    const empty = history.onMain(at(), { message: 'Drop it' });
    expect(
      (await compare(drafts, commits.rev2.commit, empty.commit)).change,
    ).toMatchObject({ change: 'removed' });
    await expect(
      compare(drafts, commits.rev1.commit, empty.commit, 'none'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('shows a manual only as the reader sees it on both sides', async () => {
    const { history, commits, compare } = setUp();
    const hidden = history.onMain(at(internal(guide('Guide', 'intro'))), {
      message: 'Internal',
    });
    const result = await compare(
      publicDrafts,
      commits.rev2.commit,
      hidden.commit,
    );
    expect(result.head.manifest).toBeUndefined();
    expect(result.change).toMatchObject({ change: 'removed' });
  });

  it('needs content.read.draft for a commit that is not released', async () => {
    const { commits, compare } = setUp();
    await expect(
      compare(READER, commits.rev1.commit, commits.rev2.commit),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('ListManualsAction with filter[status]', () => {
  const listAt = async (
    history: FakeHistory,
    actor: Actor,
    status: 'current' | 'deleted' | 'any',
  ) =>
    listManuals(history).handle({
      actor,
      snapshot: await history.openSnapshot.handle({ actor, ref: 'main' }),
      page: { number: 1, size: 50 },
      status,
    });

  it('lists the deleted manuals from their last manifests, within the reader’s scope', async () => {
    const history = new FakeHistory(at());
    history.onMain(
      at(guide('Guide', 'intro'), {
        ...internal(manifest('secret', ['care'])),
        title: 'Secret',
      }),
      { message: 'Add' },
    );
    const deletion = history.onMain(
      { ...at(), manifests: [manifest('other', ['intro'])] },
      { message: 'Drop', committedAt: '2026-02-01T00:00:00Z' },
    );
    const deleted = await listAt(history, drafts, 'deleted');
    expect(deleted.items.map((m) => m.id)).toEqual(['guide', 'secret']);
    expect(deleted.items[0]).toMatchObject({
      manifest: { title: 'Guide' },
      deleted: {
        commit: deletion.commit,
        committedAt: '2026-02-01T00:00:00Z',
      },
    });
    const scoped = await listAt(history, publicDrafts, 'deleted');
    expect(scoped.items.map((m) => m.id)).toEqual(['guide']);
    expect(scoped.total).toBe(1);
    expect(
      (await listAt(history, publicDrafts, 'any')).items.map((m) => m.id),
    ).toEqual(['guide', 'other']);
    expect(
      (await listAt(history, publicDrafts, 'current')).items.map((m) => m.id),
    ).toEqual(['other']);
  });

  it('lists to a reader of released content only the deleted manuals released content held, from that manifest', async () => {
    const history = new FakeHistory(at());
    const released = history.onMain(
      at(guide('Guide', 'intro', 'care'), {
        ...manifest('draft', ['intro']),
        title: 'Draft',
      }),
      { message: 'Add' },
    );
    history.tag('v1', released.commit);
    // The draft changes before both go: its last manifest was never released.
    history.onMain(
      at(guide('Guide', 'intro', 'care'), {
        ...manifest('draft', ['intro', 'care']),
        title: 'Draft, renamed',
      }),
      { message: 'Rename the draft' },
    );
    history.onMain(
      at({ ...manifest('never', ['care']), title: 'Never released' }),
      { message: 'Drop both, add another' },
    );
    history.onMain(at(), { message: 'Drop it too' });
    const deleted = await listAt(history, READER, 'deleted');
    expect(deleted.total).toBe(1);
    expect(deleted.items).toEqual([
      expect.objectContaining({
        id: 'guide',
        manifest: expect.objectContaining({ title: 'Guide' }),
      }),
    ]);
    // Within their scope at that release too.
    history.tag(
      'v2',
      history.onMain(at(internal(guide('Internal', 'intro'))), {
        message: 'Internal',
      }).commit,
    );
    history.onMain(at(), { message: 'Drop the internal one' });
    expect(
      (await listAt(history, publicOnly, 'deleted')).items.map((m) => m.id),
    ).toEqual([]);
    expect(
      (await listAt(history, READER, 'deleted')).items.map((m) =>
        'manifest' in m ? m.manifest.title : m.error,
      ),
    ).toEqual(['Internal']);
    // A reader of drafts still gets every deleted manual's last manifest.
    expect(
      (await listAt(history, drafts, 'deleted')).items.map((m) =>
        'manifest' in m ? m.manifest.title : m.error,
      ),
    ).toEqual(['Draft, renamed', 'Internal', 'Never released']);
  });
});
