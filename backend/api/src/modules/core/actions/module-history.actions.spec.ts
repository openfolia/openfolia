import { type Module, ProjectConfig } from '@openfolia/content-model';
import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import {
  config as baseConfig,
  type FakeContent,
  module,
} from '../../../../tests/fakes/fake-content.js';
import { FakeHistory } from '../../../../tests/fakes/fake-history.js';
import { FakeUserDirectory } from '../../../../tests/fakes/fake-user-directory.js';
import type { Actor } from '../../../access/core/actor.js';
import { NotFoundError } from '../../../base/core/errors.js';
import { newChangeSetId } from '../../../change-sets/core/change-set.js';
import { ReadableRefs } from '../../../content/core/readable-refs.js';
import { versionsSeen } from '../module-history.js';
import { CompareModuleVersionsAction } from './compare-module-versions.action.js';
import { GetModuleHistoryAction } from './get-module-history.action.js';

const config = ProjectConfig.parse({
  ...baseConfig,
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
});
const at = (...modules: Module[]): FakeContent => ({ config, modules });
const internal = (m: Module): Module => ({
  ...m,
  meta: { ...m.meta, audience: 'internal' },
});
const publisher: Actor = { ...actorWith(['release.publish']), id: 'pub' };
const approver: Actor = { ...actorWith(['content.review']), id: 'rev' };
const drafts = actorWith(['content.read', 'content.read.draft']);
const publicOnly = actorWith(['content.read'], { maxAudience: 'public' });

/** Paragraphs with these IDs and texts. */
const storage = (...blocks: [string, string][]): Module => ({
  ...module('storage'),
  blocks: blocks.map(([id, text]) => ({
    type: 'paragraph',
    id,
    content: [{ type: 'text', text }],
  })),
});

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
 * `main`: no `storage`, then three merged change sets adding it and
 * changing it twice, with a commit changing only another module between
 * the first two; `v1` tags that commit (holding rev 1), `v2` the third.
 */
function setUp() {
  const history = new FakeHistory(at(module('other')));
  const ids = [newChangeSetId(), newChangeSetId(), newChangeSetId()];
  const rev1 = history.onMain(
    at(module('other'), storage(['a', 'One.'])),
    merged(ids[0] as string, 'rev'),
  );
  const unrelated = history.onMain(
    at(module('other', 'en', 'Else.'), storage(['a', 'One.'])),
    { message: 'Something else' },
  );
  history.tag('v1', unrelated.commit);
  const rev2 = history.onMain(
    at(module('other', 'en', 'Else.'), storage(['a', 'Two.'])),
    merged(ids[1] as string, 'rev', 'gone'),
  );
  const rev3 = history.onMain(
    at(module('other', 'en', 'Else.'), storage(['a', 'Two.'], ['b', 'Added.'])),
    {
      message: 'Directly',
      trailers: [
        { key: 'Change-set', value: ids[2] as string },
        { key: 'Actor', value: 'service/importer' },
      ],
    },
  );
  history.tag('v2', rev3.commit);
  const users = new FakeUserDirectory([publisher, approver]);
  const action = new GetModuleHistoryAction(
    new ReadableRefs(history),
    history.openSnapshot,
    users,
  );
  const list = async (
    actor: Actor = READER,
    ref = 'main',
    page = { number: 1, size: 50 },
    id = 'storage',
  ) =>
    action.handle({
      actor,
      snapshot: await history.openSnapshot.handle({ actor, ref }),
      id,
      lang: 'en',
      page,
    });
  const compare = (actor: Actor, base: string, head: string, id = 'storage') =>
    new CompareModuleVersionsAction(history.openSnapshot).handle({
      actor,
      id,
      lang: 'en',
      base,
      head,
    });
  return {
    history,
    ids,
    commits: { rev1, unrelated, rev2, rev3 },
    list,
    compare,
  };
}

describe('GetModuleHistoryAction', () => {
  it('lists the versions newest first, numbered from the oldest, with who, which change set, approvers and releases', async () => {
    const { ids, commits, list } = setUp();
    const page = await list();
    expect(page.total).toBe(3);
    expect(page.truncated).toBe(false);
    expect(page.items.map((v) => [v.commit, v.revision, v.change])).toEqual([
      [commits.rev3.commit, 3, 'changed'],
      [commits.rev2.commit, 2, 'changed'],
      [commits.rev1.commit, 1, 'added'],
    ]);
    const [rev3, rev2, rev1] = page.items;
    expect(rev1).toMatchObject({
      actor: { kind: 'user', id: 'pub' },
      actorKnown: true,
      changeSetId: ids[0],
      approvedBy: [{ kind: 'user', id: 'rev' }],
      knownApprovers: ['rev'],
      parents: 2,
      message: 'A change\n\nMerge change set.',
      // The commit after it changed only another file: it holds rev 1.
      releases: [{ tag: 'v1', commit: commits.unrelated.commit }],
    });
    expect(rev2).toMatchObject({
      changeSetId: ids[1],
      approvedBy: [
        { kind: 'user', id: 'rev' },
        { kind: 'user', id: 'gone' },
      ],
      // Only the users the directory knows.
      knownApprovers: ['rev'],
      releases: [],
    });
    expect(rev3).toMatchObject({
      actor: { kind: 'service', id: 'importer' },
      actorKnown: false,
      changeSetId: ids[2],
      approvedBy: [],
      releases: [{ tag: 'v2', commit: commits.rev3.commit }],
    });
  });

  it('pages the versions', async () => {
    const { commits, list } = setUp();
    const second = await list(READER, 'main', { number: 2, size: 2 });
    expect(second.total).toBe(3);
    expect(second.items.map((v) => v.commit)).toEqual([commits.rev1.commit]);
  });

  it('reads the history of the ref asked for', async () => {
    const { commits, list } = setUp();
    // An older commit of main is a draft: it needs content.read.draft.
    await expect(list(READER, commits.rev2.commit)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const old = await list(drafts, commits.rev2.commit);
    expect(old.items.map((v) => v.revision)).toEqual([2, 1]);
  });

  it('is not found for a missing module, and for one outside the reader’s scope', async () => {
    const { history, list } = setUp();
    await expect(
      list(READER, 'main', undefined, 'nothing'),
    ).rejects.toBeInstanceOf(NotFoundError);
    history.onMain(at(module('other'), internal(storage(['a', 'Hidden.']))));
    await expect(list(publicOnly)).rejects.toBeInstanceOf(NotFoundError);
    // Someone who sees it there sees every version.
    expect((await list(READER)).total).toBe(4);
  });

  it('treats a version the reader may not see as no file', async () => {
    const { history, commits, list } = setUp();
    const hidden = history.onMain(
      at(module('other'), internal(storage(['a', 'Hidden.']))),
    );
    const secret = history.onMain(
      at(module('other'), internal(storage(['a', 'Still hidden.']))),
    );
    const back = history.onMain(
      at(module('other'), storage(['a', 'Public again.'])),
    );
    const seen = await list(publicOnly);
    // Hidden to hidden is no version for them.
    expect(seen.items.map((v) => [v.commit, v.change, v.revision])).toEqual([
      [back.commit, 'added', 5],
      [hidden.commit, 'removed', 4],
      [commits.rev3.commit, 'changed', 3],
      [commits.rev2.commit, 'changed', 2],
      [commits.rev1.commit, 'added', 1],
    ]);
    expect(seen.items[1]?.fileRevision).toBeUndefined();
    expect((await list(READER)).items.map((v) => v.commit)).toContain(
      secret.commit,
    );
  });

  it('keeps the history of a module deleted at the ref', async () => {
    const { history, list } = setUp();
    const deleted = history.onMain(at(module('other')), {
      message: 'Drop storage',
    });
    const page = await list();
    expect(page.items[0]).toMatchObject({
      commit: deleted.commit,
      change: 'removed',
      revision: 4,
      releases: [],
    });
  });

  it('is not found for a deleted module whose last file the reader may not see', async () => {
    const { history, list } = setUp();
    history.onMain(at(module('other'), internal(storage(['a', 'Hidden.']))));
    history.onMain(at(module('other')));
    await expect(list(publicOnly)).rejects.toBeInstanceOf(NotFoundError);
    expect((await list(READER)).items[0]?.change).toBe('removed');
  });

  it('names no release where the module lies outside the reader’s scope', async () => {
    const { history, list } = setUp();
    const hidden = history.onMain(
      at(module('other'), internal(storage(['a', 'Hidden.']))),
    );
    history.tag('v3', hidden.commit);
    history.onMain(at(module('other'), storage(['a', 'Hidden.'])));
    const seen = await list(publicOnly);
    expect(seen.items[0]?.releases).toEqual([]);
    expect((await list(READER)).items[1]?.releases).toEqual([
      { tag: 'v3', commit: hidden.commit },
    ]);
  });

  it('reports a broken revision only to a reader of all of its language', async () => {
    const { history, list } = setUp();
    history.onMain({
      config,
      modules: [module('other')],
      brokenModules: [{ id: 'storage', lang: 'en' }],
    });
    expect((await list(READER)).items[0]).toMatchObject({
      change: 'changed',
      unreadable: true,
    });
    // Narrower than the language: the broken file is no file to them.
    await expect(list(publicOnly)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('versionsSeen', () => {
  const version = (commit: string, revision?: string) => ({
    commit,
    parents: 1,
    committedAt: '2026-01-01T00:00:00Z',
    message: '',
    trailers: [],
    seen: revision === undefined ? undefined : { revision, unreadable: false },
  });

  it('numbers nothing when the walk was cut, and starts from what came before', () => {
    const versions = versionsSeen({
      versions: [version('c3', 'r3'), version('c2', 'r2')],
      truncated: true,
      before: { revision: 'r1', unreadable: false },
      startsInWindow: false,
    });
    expect(versions.map((v) => [v.commit, v.change, v.revision])).toEqual([
      ['c3', 'changed', undefined],
      ['c2', 'changed', undefined],
    ]);
  });

  it('numbers a cut walk when the file began within it', () => {
    const versions = versionsSeen({
      versions: [version('c2', 'r2'), version('c1', 'r1')],
      truncated: true,
      before: undefined,
      startsInWindow: true,
    });
    expect(versions.map((v) => [v.change, v.revision])).toEqual([
      ['changed', 2],
      ['added', 1],
    ]);
  });

  it('leaves out trailers that name no actor or change set', () => {
    const [only] = versionsSeen({
      versions: [
        {
          ...version('c1', 'r1'),
          trailers: [
            { key: 'Merged-by', value: 'nobody' },
            { key: 'Merged-change-set', value: 'not-an-id' },
            { key: 'Approved-by', value: 'robot/x' },
          ],
        },
      ],
      truncated: false,
      before: undefined,
      startsInWindow: true,
    });
    expect(only).toMatchObject({ approvedBy: [], revision: 1 });
    expect(only?.actor).toBeUndefined();
    expect(only?.changeSetId).toBeUndefined();
  });
});

describe('CompareModuleVersionsAction', () => {
  it('gives both versions and the blocks that differ, as the change sets’ diffs combined', async () => {
    const { commits, compare } = setUp();
    const found = await compare(drafts, commits.rev1.commit, 'v2');
    expect(found.base).toEqual({
      commit: commits.rev1.commit,
      module: storage(['a', 'One.']),
    });
    expect(found.head.commit).toBe(commits.rev3.commit);
    // rev 2 changed `a`, rev 3 added `b`.
    expect(found.change).toMatchObject({
      change: 'changed',
      fields: [],
      blocks: [
        { blockId: 'a', change: 'changed' },
        { blockId: 'b', change: 'added' },
      ],
    });
  });

  it('needs content.read.draft for a side that is not released', async () => {
    const { commits, compare } = setUp();
    await expect(
      compare(READER, commits.rev1.commit, 'v2'),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Two releases: content.read is enough.
    const released = await compare(READER, 'v1', 'v2');
    expect(released.change?.change).toBe('changed');
  });

  it('is added or removed where a side has no module, unchanged for the same, not found on neither', async () => {
    const { history, compare } = setUp();
    const first = history.tags.find((t) => t.name === 'v1');
    const root = [...history.commits.values()][0]?.commit as string;
    expect((await compare(drafts, root, 'v1')).change?.change).toBe('added');
    expect((await compare(drafts, 'v1', root)).change?.change).toBe('removed');
    expect((await compare(drafts, 'v1', first?.commit ?? '')).change).toBe(
      undefined,
    );
    await expect(compare(drafts, 'v1', 'v2', 'nothing')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('shows a side only as the reader would see it on the other too', async () => {
    const { history, compare } = setUp();
    // Internal on a draft: a reader of public drafts only, of everything released.
    const narrowDrafts: Actor = {
      ...actorWith([]),
      roles: [
        {
          id: 'r1',
          name: 'Released',
          permissions: ['content.read'],
          scope: {},
        },
        {
          id: 'r2',
          name: 'Drafts',
          permissions: ['content.read.draft'],
          scope: { maxAudience: 'public' },
        },
      ],
    };
    const draft = history.commit(
      at(module('other'), internal(storage(['a', 'Secret.']))),
    );
    // v2 is released, but they would not see it in their draft scope if it
    // were internal; here the draft side is internal: not there for them.
    const found = await compare(narrowDrafts, 'v2', draft.commit);
    expect(found.head.module).toBeUndefined();
    expect(found.change?.change).toBe('removed');
  });
});
