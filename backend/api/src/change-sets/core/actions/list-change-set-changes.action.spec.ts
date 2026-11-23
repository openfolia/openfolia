import { type Module, ProjectConfig } from '@openfolia/content-model';
import { actorWith } from '../../../../tests/fakes/actors.js';
import {
  config as baseConfig,
  type FakeContent,
  manifest,
  module,
} from '../../../../tests/fakes/fake-content.js';
import { FakeHistory } from '../../../../tests/fakes/fake-history.js';
import type { Actor, Scope } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import {
  ConflictError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { MAX_REVIEWED_PATHS } from '../review-scope.js';
import { GetChangeSetAction } from './get-change-set.action.js';
import { ListChangeSetChangesAction } from './list-change-set-changes.action.js';

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
const author = user('sample-author', ['content.read', 'content.edit']);
const reviewer = user('sample-reviewer', [
  'content.read',
  'content.read.draft',
  'content.review',
]);
const publicReviewer = user(
  'public-reviewer',
  ['content.read', 'content.read.draft'],
  { maxAudience: 'public' },
);
const other = user('other-author', ['content.read', 'content.edit']);

const internal = (m: Module): Module => ({
  ...m,
  meta: { ...m.meta, audience: 'internal' },
});
const withBlocks = (m: Module, blocks: Module['blocks']): Module => ({
  ...m,
  blocks,
});
const p = (id: string, text: string): Module['blocks'][number] => ({
  type: 'paragraph',
  id,
  content: [{ type: 'text', text }],
});

const base: FakeContent = {
  config,
  modules: [
    module('charging'),
    module('unchanged'),
    module('removed'),
    internal(module('secret')),
    module('goes-internal'),
  ],
  manifests: [manifest('operating', ['charging'])],
};
const head: FakeContent = {
  config,
  modules: [
    withBlocks(
      {
        ...module('charging'),
        meta: { ...module('charging').meta, title: 'Charging' },
      },
      [p('p', 'Hello.'), p('new', 'Added.')],
    ),
    module('unchanged'),
    module('added', 'de'),
    internal(module('secret', 'en', 'Changed.')),
    internal(module('goes-internal')),
  ],
  manifests: [manifest('operating', ['charging', 'added'])],
};

function setUp(content: FakeContent = head) {
  const history = new FakeHistory(base);
  const changeSet = history.changeSet(author, content);
  const action = new ListChangeSetChangesAction(
    new GetChangeSetAction(history.store),
    history.branches,
    history.openSnapshot,
  );
  const list = (actor: Actor, page = { number: 1, size: 50 }) =>
    action.handle({ actor, id: changeSet.id, page });
  return { history, changeSet, list };
}

const keys = (changes: {
  items: readonly { subject: object; change: string }[];
}) =>
  changes.items.map(({ subject, change }) => [
    Object.values(subject).slice(1).join('/'),
    change,
  ]);

describe('ListChangeSetChangesAction', () => {
  it('lists the changed modules and manuals, with fields and blocks by ID', async () => {
    const { history, changeSet, list } = setUp();
    const changes = await list(reviewer);
    expect(changes.base).toBe(changeSet.baseCommit);
    expect(changes.head).toBe(history.heads.get(changeSet.branch));
    expect(keys(changes)).toEqual([
      ['operating', 'changed'],
      ['de/added', 'added'],
      ['en/charging', 'changed'],
      ['en/goes-internal', 'changed'],
      ['en/removed', 'removed'],
      ['en/secret', 'changed'],
    ]);
    expect(changes.total).toBe(6);
    expect(changes.items[0]).toMatchObject({ fields: ['entries'], blocks: [] });
    expect(changes.items[2]).toEqual({
      subject: { type: 'module', lang: 'en', moduleId: 'charging' },
      change: 'changed',
      fields: ['title'],
      blocks: [{ blockId: 'new', change: 'added' }],
      unreadable: false,
    });
    expect(changes.items[3]).toMatchObject({
      fields: ['audience'],
      blocks: [],
    });
  });

  it('pages after filtering', async () => {
    const { list } = setUp();
    const second = await list(reviewer, { number: 2, size: 4 });
    expect(second.total).toBe(6);
    expect(keys(second)).toEqual([
      ['en/removed', 'removed'],
      ['en/secret', 'changed'],
    ]);
  });

  it('shows each side only as far as the reader may see it, and counts only that', async () => {
    const { list } = setUp();
    const changes = await list(publicReviewer);
    // `secret` is outside their scope on both sides: not there at all.
    // `goes-internal` they see only at the base: removed, for them.
    expect(keys(changes)).toEqual([
      ['operating', 'changed'],
      ['de/added', 'added'],
      ['en/charging', 'changed'],
      ['en/goes-internal', 'removed'],
      ['en/removed', 'removed'],
    ]);
    expect(changes.total).toBe(5);
  });

  it('lets an author without content.read.draft see their own, and nobody else', async () => {
    const { list } = setUp();
    expect((await list(author)).total).toBe(6);
    await expect(list(other)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('opens the base for its author once main has moved on, if it started from released content', async () => {
    const { history, changeSet, list } = setUp();
    history.heads.set('main', history.commit(base).commit);
    expect((await list(author)).total).toBe(6);
    expect((await list(reviewer)).total).toBe(6);
    // Started from a draft: its base is not theirs to read without draft rights.
    history.store.changeSets[0] = { ...changeSet, baseReleased: false };
    await expect(list(author)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reads both sides through what the reader sees on both, whatever each commit takes', async () => {
    // Released content everywhere, drafts only in German: an English
    // module changed in the draft is neither removed nor there at all.
    const germanDrafts: Actor = {
      kind: 'user',
      id: 'german-drafts',
      roles: [
        {
          id: 'reader',
          name: 'Reader',
          permissions: ['content.read'],
          scope: {},
        },
        {
          id: 'german',
          name: 'German drafts',
          permissions: ['content.read.draft'],
          scope: { languages: ['de'] },
        },
      ],
    };
    const { list } = setUp();
    const changes = await list(germanDrafts);
    expect(keys(changes)).toEqual([
      ['operating', 'changed'],
      ['de/added', 'added'],
    ]);
    expect(changes.total).toBe(2);

    // A draft that only drops an English reference from a manual: the
    // manual names only what it may name on both, so it has not changed.
    const dropsEnglish = setUp({
      ...base,
      manifests: [manifest('operating', [])],
    });
    expect((await dropsEnglish.list(germanDrafts)).items).toEqual([]);
    expect(keys(await dropsEnglish.list(reviewer))).toEqual([
      ['operating', 'changed'],
    ]);

    // Nor one that deletes an English module and its reference.
    const deletesEnglish = setUp({
      ...base,
      modules: base.modules?.filter((m) => m.id !== 'charging'),
      manifests: [manifest('operating', [])],
    });
    expect((await deletesEnglish.list(germanDrafts)).items).toEqual([]);
    expect(keys(await deletesEnglish.list(reviewer))).toEqual([
      ['operating', 'changed'],
      ['en/charging', 'removed'],
    ]);
  });

  it('compares the review head once submitted, wherever the branch is now', async () => {
    const history = new FakeHistory(base);
    const reviewed = history.commit(head).commit;
    const changeSet = history.changeSet(author, base, {
      state: 'in-review',
      reviewHead: reviewed,
    });
    const action = new ListChangeSetChangesAction(
      new GetChangeSetAction(history.store),
      history.branches,
      history.openSnapshot,
    );
    const changes = await action.handle({
      actor: reviewer,
      id: changeSet.id,
      page: { number: 1, size: 50 },
    });
    expect(changes.head).toBe(reviewed);
    expect(changes.total).toBe(6);
  });

  it('is empty for a change set that changes nothing visible', async () => {
    const { list } = setUp(base);
    expect(await list(reviewer)).toMatchObject({ items: [], total: 0 });
  });

  it('marks a file that cannot be read, for a reader who may learn of it', async () => {
    const { list } = setUp({
      ...base,
      brokenModules: [{ id: 'unchanged', lang: 'en' }],
      modules: base.modules?.filter((m) => m.id !== 'unchanged'),
    });
    expect((await list(reviewer)).items).toEqual([
      {
        subject: { type: 'module', lang: 'en', moduleId: 'unchanged' },
        change: 'changed',
        fields: [],
        blocks: [],
        unreadable: true,
      },
    ]);
    // A reader of less than all of English: a broken file is not there.
    expect((await list(publicReviewer)).items).toEqual([
      expect.objectContaining({ change: 'removed', unreadable: false }),
    ]);
  });

  it('answers 409 for a branch that is gone, 422 past the most files', async () => {
    const { history, changeSet, list } = setUp();
    history.branches.changedPaths = () =>
      Promise.resolve(
        Array.from({ length: MAX_REVIEWED_PATHS + 1 }, (_, i) => ({
          path: `modules/en/m${i}.adoc`,
          deleted: false,
        })),
      );
    await expect(list(reviewer)).rejects.toBeInstanceOf(UnprocessableError);
    history.heads.delete(changeSet.branch);
    await expect(list(reviewer)).rejects.toMatchObject({
      constructor: ConflictError,
      code: 'branch-missing',
    });
  });
});
