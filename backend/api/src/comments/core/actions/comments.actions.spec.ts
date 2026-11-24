import type { Module } from '@openfolia/content-model';
import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeCommentStore } from '../../../../tests/fakes/fake-comment-store.js';
import {
  config,
  type FakeContent,
  module,
} from '../../../../tests/fakes/fake-content.js';
import { FakeHistory } from '../../../../tests/fakes/fake-history.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import type { Actor, Scope } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import { ProjectConfig } from '@openfolia/content-model';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  UnprocessableProblems,
} from '../../../base/core/errors.js';
import { GetChangeSetAction } from '../../../change-sets/core/actions/get-change-set.action.js';
import type { ChangeSet } from '../../../change-sets/core/change-set.js';
import { ChangeSetComments } from '../change-set-comments.js';
import {
  type CommentFilter,
  type CommentSubject,
  MAX_COMMENTS,
  newCommentId,
} from '../comment.js';
import { CreateCommentAction } from './create-comment.action.js';
import { DeleteCommentAction } from './delete-comment.action.js';
import { EditCommentAction } from './edit-comment.action.js';
import { GetCommentAction } from './get-comment.action.js';
import { ListCommentsAction } from './list-comments.action.js';
import {
  ReopenCommentAction,
  ResolveCommentAction,
} from './resolve-comment.action.js';
import { Sandbox } from '../../../sandbox/core/sandbox.js';

const scoped = ProjectConfig.parse({
  ...config,
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
/** Reads drafts but does not review. */
const drafts = user('draft-reader', ['content.read', 'content.read.draft']);
const publicReviewer = user(
  'public-reviewer',
  ['content.read', 'content.read.draft', 'content.review'],
  { maxAudience: 'public' },
);
/** Reads every draft, reviews only German. */
const germanReviewer: Actor = {
  kind: 'user',
  id: 'german-reviewer',
  roles: [
    {
      id: 'reader',
      name: 'Reader',
      permissions: ['content.read', 'content.read.draft'],
      scope: {},
    },
    {
      id: 'de-reviewer',
      name: 'German reviewer',
      permissions: ['content.review'],
      scope: { languages: ['de'] },
    },
  ],
};
const other = user('other-author', ['content.read', 'content.edit']);

const p = (id: string, text = 'Hello.'): Module['blocks'][number] => ({
  type: 'paragraph',
  id,
  content: [{ type: 'text', text }],
});
const withBlocks = (m: Module, blocks: Module['blocks']): Module => ({
  ...m,
  blocks,
});
const internal = (m: Module): Module => ({
  ...m,
  meta: { ...m.meta, audience: 'internal' },
});

const base: FakeContent = {
  config: scoped,
  modules: [
    withBlocks(module('charging'), [p('intro'), p('dropped')]),
    internal(module('secret')),
  ],
};
const head: FakeContent = {
  config: scoped,
  modules: [
    withBlocks(module('charging'), [
      p('intro', 'Plug it in.'),
      {
        type: 'list',
        id: 'steps',
        ordered: false,
        items: [
          {
            id: 'first',
            content: [{ type: 'text', text: 'First.' }],
            blocks: [p('inner')],
          },
        ],
      },
    ]),
    internal(module('secret')),
    module('fresh', 'de'),
  ],
};

const charging: CommentSubject = {
  type: 'module',
  lang: 'en',
  moduleId: 'charging',
};
const secret: CommentSubject = { ...charging, moduleId: 'secret' };
const fresh: CommentSubject = { type: 'module', lang: 'de', moduleId: 'fresh' };

function setUp(over: Partial<ChangeSet> = {}, sandbox: Sandbox = Sandbox.OFF) {
  const history = new FakeHistory(base);
  const changeSet = history.changeSet(author, head, over);
  const store = new FakeCommentStore();
  const auditLog = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const comments = new ChangeSetComments(
    new GetChangeSetAction(history.store),
    history.branches,
    history.openSnapshot,
    store,
  );
  const writes = [comments, store, history.store, auditLog, unit] as const;
  const create = new CreateCommentAction(...writes, sandbox);
  const resolve = new ResolveCommentAction(...writes);
  const reopen = new ReopenCommentAction(...writes);
  const edit = new EditCommentAction(...writes, sandbox);
  const remove = new DeleteCommentAction(...writes);
  const list = new ListCommentsAction(comments, store);
  const get = new GetCommentAction(comments);
  const id = changeSet.id;
  return {
    history,
    changeSet,
    store,
    auditLog,
    on: (
      actor: Actor,
      subject: CommentSubject,
      blockId: string,
      body = 'Why?',
    ) =>
      create.handle({
        actor,
        changeSetId: id,
        body,
        anchor: { subject, blockId },
      }),
    reply: (actor: Actor, threadId: string, body = 'Because.') =>
      create.handle({ actor, changeSetId: id, body, anchor: { threadId } }),
    resolve: (actor: Actor, commentId: string) =>
      resolve.handle({ actor, changeSetId: id, commentId }),
    reopen: (actor: Actor, commentId: string) =>
      reopen.handle({ actor, changeSetId: id, commentId }),
    edit: (
      actor: Actor,
      commentId: string,
      body: string,
      resourceId?: string,
    ) =>
      edit.handle({
        actor,
        changeSetId: id,
        commentId,
        body,
        ...(resourceId !== undefined && { resourceId }),
      }),
    remove: (actor: Actor, commentId: string) =>
      remove.handle({ actor, changeSetId: id, commentId }),
    list: (
      actor: Actor,
      filter: Omit<CommentFilter, 'modules'> = { resolved: false },
      page = { number: 1, size: 50 },
    ) => list.handle({ actor, changeSetId: id, filter, page }),
    get: (actor: Actor, commentId: string) =>
      get.handle({ actor, changeSetId: id, commentId }),
    /** A save point on the change set's branch: its head now holds `content`. */
    save: (content: FakeContent) =>
      history.heads.set(changeSet.branch, history.commit(content).commit),
  };
}

const ids = (page: {
  items: readonly { comment: { body: string | null } }[];
}) => page.items.map((i) => i.comment.body);

describe('CreateCommentAction', () => {
  it('writes a thread on a block of the head, audited without its text', async () => {
    const { on, history, changeSet, auditLog, list } = setUp();
    const { comment, orphaned } = await on(reviewer, charging, 'intro');
    expect(orphaned).toBe(false);
    expect(comment).toMatchObject({
      changeSetId: changeSet.id,
      threadId: comment.id,
      subject: charging,
      blockId: 'intro',
      commit: history.heads.get(changeSet.branch),
      author: { kind: 'user', id: 'sample-reviewer' },
      body: 'Why?',
    });
    expect(comment.resolution).toBeUndefined();
    expect(auditLog.events).toEqual([
      expect.objectContaining({
        action: 'comment.create',
        subject: { type: 'comment', id: comment.id },
        actor: { kind: 'user', id: 'sample-reviewer' },
        data: {
          changeSetId: changeSet.id,
          module: 'en/charging',
          blockId: 'intro',
          commit: comment.commit,
        },
      }),
    ]);
    expect(JSON.stringify(auditLog.events)).not.toContain('Why?');
    expect((await list(reviewer)).items).toHaveLength(1);
  });

  it('anchors list items and nested blocks too, and a block only the base has', async () => {
    const { on } = setUp();
    expect((await on(reviewer, charging, 'first')).orphaned).toBe(false);
    expect((await on(reviewer, charging, 'inner')).orphaned).toBe(false);
    // Removed by the change set: a reviewer may ask why; it is orphaned.
    expect((await on(reviewer, charging, 'dropped')).orphaned).toBe(true);
  });

  it('lets the change set’s author comment without content.review', async () => {
    const { on } = setUp();
    await expect(on(author, charging, 'intro')).resolves.toBeDefined();
  });

  it('refuses anyone else who is no reviewer over the module', async () => {
    const { on, store } = setUp();
    await expect(on(drafts, charging, 'intro')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(on(germanReviewer, charging, 'intro')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(on(germanReviewer, fresh, 'p')).resolves.toBeDefined();
    // Another author does not see the change set at all.
    await expect(on(other, charging, 'intro')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(store.comments).toHaveLength(1);
  });

  it('answers a missing block and a hidden module alike', async () => {
    const { on } = setUp();
    const refusal = async (subject: CommentSubject, blockId: string) => {
      const error = await on(publicReviewer, subject, blockId).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(UnprocessableProblems);
      return {
        code: (error as UnprocessableProblems).code,
        problems: (error as UnprocessableProblems).problems.map((p) => ({
          ...p,
          detail: p.detail
            .replace(/secret|charging|nowhere/, 'X')
            .replace(/"\w+"/, ''),
        })),
      };
    };
    const missing = await refusal(charging, 'nope');
    expect(missing.code).toBe('block-not-found');
    expect(await refusal(secret, 'p')).toEqual(missing);
    expect(await refusal({ ...charging, moduleId: 'nowhere' }, 'p')).toEqual(
      missing,
    );
  });

  it('puts a reply on its thread’s anchor, and never on a reply', async () => {
    const { on, reply, list } = setUp();
    const first = (await on(reviewer, charging, 'intro', 'One')).comment;
    const second = (await on(reviewer, charging, 'first', 'Two')).comment;
    const answer = (await reply(author, first.id, 'One, answered')).comment;
    expect(answer).toMatchObject({
      threadId: first.id,
      subject: charging,
      blockId: 'intro',
    });
    await expect(reply(reviewer, answer.id)).rejects.toMatchObject({
      code: 'invalid-thread',
    });
    await expect(reply(reviewer, newCommentId())).rejects.toMatchObject({
      code: 'invalid-thread',
    });
    await reply(reviewer, first.id, 'One, again');
    expect(ids(await list(reviewer))).toEqual([
      'One',
      'One, answered',
      'One, again',
      'Two',
    ]);
    expect(second.threadId).toBe(second.id);
  });

  it('refuses a reply to a thread the reader may not see', async () => {
    const { on, reply } = setUp();
    const hidden = (await on(reviewer, secret, 'p')).comment;
    await expect(reply(publicReviewer, hidden.id)).rejects.toMatchObject({
      code: 'invalid-thread',
    });
  });

  it('writes only on an open change set', async () => {
    for (const state of ['merged', 'abandoned'] as const) {
      const { on } = setUp({
        state,
        reviewHead: undefined,
      });
      await expect(on(reviewer, charging, 'intro')).rejects.toMatchObject({
        code: 'invalid-state',
        meta: { state },
      });
    }
  });

  it('holds at most MAX_COMMENTS per change set', async () => {
    const { on, store, changeSet } = setUp();
    const first = (await on(reviewer, charging, 'intro')).comment;
    for (let i = 1; i < MAX_COMMENTS; i++) {
      store.comments.push({ ...first, id: newCommentId(), threadId: first.id });
    }
    const error = await on(reviewer, charging, 'intro').catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({
      code: 'too-many-comments',
      meta: { max: MAX_COMMENTS },
    });
    expect(
      store.comments.filter((c) => c.changeSetId === changeSet.id),
    ).toHaveLength(MAX_COMMENTS);
  });
});

describe('orphaned comments', () => {
  it('stay on a block that is edited or moved, and stay orphaned once it is removed', async () => {
    const { on, list, save, get } = setUp();
    const intro = (await on(reviewer, charging, 'intro')).comment;
    const inner = (await on(reviewer, charging, 'inner')).comment;
    // Edited and moved out of the list: the same ID, still on it.
    save({
      ...head,
      modules: [
        withBlocks(module('charging'), [
          p('inner', 'Moved.'),
          p('intro', 'Edited.'),
        ]),
        internal(module('secret')),
      ],
    });
    expect((await list(reviewer)).items.map((i) => i.orphaned)).toEqual([
      false,
      false,
    ]);
    // A later save removes one block, then the whole module.
    save({
      ...head,
      modules: [withBlocks(module('charging'), [p('intro')])],
    });
    expect((await get(reviewer, inner.id)).orphaned).toBe(true);
    expect((await get(reviewer, intro.id)).orphaned).toBe(false);
    save({ ...head, modules: [] });
    const page = await list(reviewer);
    expect(page.total).toBe(2);
    expect(page.items.map((i) => i.orphaned)).toEqual([true, true]);
  });

  it('keeps comments on a module gone from both sides for readers of all of its language only', async () => {
    const { on, list, save } = setUp();
    await on(reviewer, fresh, 'p');
    save({ ...head, modules: head.modules?.filter((m) => m.id !== 'fresh') });
    expect((await list(reviewer)).items[0]?.orphaned).toBe(true);
    // Limited to an audience: a gone module and a hidden one look alike.
    expect((await list(publicReviewer)).total).toBe(0);
  });
});

describe('ListCommentsAction and GetCommentAction', () => {
  it('leave out comments on modules the reader may not see, before paging', async () => {
    const { on, list, get } = setUp();
    await on(reviewer, charging, 'intro', 'Public');
    const hidden = (await on(reviewer, secret, 'p', 'Internal')).comment;
    expect(ids(await list(reviewer))).toEqual(['Public', 'Internal']);
    const seen = await list(publicReviewer);
    expect(ids(seen)).toEqual(['Public']);
    expect(seen.total).toBe(1);
    expect(
      (await list(publicReviewer, { module: secret, resolved: false })).total,
    ).toBe(0);
    await expect(get(publicReviewer, hidden.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(get(reviewer, hidden.id)).resolves.toBeDefined();
  });

  it('filters by module and block, and pages', async () => {
    const { on, list } = setUp();
    await on(reviewer, charging, 'intro', 'A');
    await on(reviewer, charging, 'first', 'B');
    await on(reviewer, fresh, 'p', 'C');
    expect(
      ids(await list(reviewer, { module: fresh, resolved: false })),
    ).toEqual(['C']);
    expect(
      ids(await list(reviewer, { blockId: 'first', resolved: false })),
    ).toEqual(['B']);
    const second = await list(
      reviewer,
      { resolved: false },
      { number: 2, size: 2 },
    );
    expect(ids(second)).toEqual(['C']);
    expect(second.total).toBe(3);
  });

  it('is not there for another author’s change set without content.read.draft', async () => {
    const { list, on, get } = setUp();
    const { comment } = await on(reviewer, charging, 'intro');
    await expect(list(other)).rejects.toBeInstanceOf(NotFoundError);
    await expect(get(other, comment.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('ResolveCommentAction and ReopenCommentAction', () => {
  it('resolve and reopen a thread, which lists hide while resolved', async () => {
    const { on, reply, resolve, reopen, list, auditLog, changeSet } = setUp();
    const thread = (await on(reviewer, charging, 'intro', 'Thread')).comment;
    await reply(author, thread.id, 'Reply');
    await on(reviewer, charging, 'first', 'Other');
    const resolved = await resolve(author, thread.id);
    expect(resolved.comment.resolution).toMatchObject({
      by: { kind: 'user', id: 'sample-author' },
    });
    expect(ids(await list(reviewer))).toEqual(['Other']);
    expect(ids(await list(reviewer, { resolved: true }))).toEqual([
      'Thread',
      'Reply',
    ]);
    expect(ids(await list(reviewer, {}))).toEqual(['Thread', 'Reply', 'Other']);
    await expect(resolve(reviewer, thread.id)).rejects.toMatchObject({
      code: 'already-resolved',
    });
    const reopened = await reopen(reviewer, thread.id);
    expect(reopened.comment.resolution).toBeUndefined();
    await expect(reopen(reviewer, thread.id)).rejects.toMatchObject({
      code: 'not-resolved',
    });
    expect(
      auditLog.events
        .filter((e) => e.subject.id === thread.id)
        .map((e) => [e.action, e.actor.id, e.data]),
    ).toEqual([
      ['comment.create', 'sample-reviewer', expect.anything()],
      ['comment.resolve', 'sample-author', { changeSetId: changeSet.id }],
      ['comment.reopen', 'sample-reviewer', { changeSetId: changeSet.id }],
    ]);
  });

  it('take a thread only, from who may comment on it, on an open change set', async () => {
    const { on, reply, resolve, history, changeSet } = setUp();
    const thread = (await on(reviewer, charging, 'intro')).comment;
    const answer = (await reply(author, thread.id)).comment;
    const error = await resolve(author, answer.id).catch((e) => e);
    expect(error).toBeInstanceOf(UnprocessableError);
    expect(error).toMatchObject({
      code: 'not-a-thread',
      meta: { threadId: thread.id },
    });
    await expect(resolve(drafts, thread.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(resolve(other, thread.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const at = history.store.changeSets.findIndex((c) => c.id === changeSet.id);
    history.store.changeSets[at] = { ...changeSet, state: 'abandoned' };
    await expect(resolve(author, thread.id)).rejects.toMatchObject({
      code: 'invalid-state',
    });
  });
});

describe('EditCommentAction', () => {
  it('changes its author’s text, marked edited, audited without either text', async () => {
    const { on, edit, get, auditLog, changeSet } = setUp();
    const thread = (await on(reviewer, charging, 'intro', 'Teh plug')).comment;
    const edited = await edit(reviewer, thread.id, 'The plug');
    expect(edited.comment).toMatchObject({
      id: thread.id,
      body: 'The plug',
      threadId: thread.id,
      blockId: 'intro',
    });
    expect(edited.comment.editedAt).toBeInstanceOf(Date);
    expect((await get(reviewer, thread.id)).comment.body).toBe('The plug');
    // The same text again: nothing changes, nothing is audited.
    await edit(reviewer, thread.id, 'The plug');
    const events = auditLog.events.filter((e) => e.subject.id === thread.id);
    expect(events.map((e) => [e.action, e.actor.id, e.data])).toEqual([
      ['comment.create', 'sample-reviewer', expect.anything()],
      ['comment.edit', 'sample-reviewer', { changeSetId: changeSet.id }],
    ]);
    expect(JSON.stringify(auditLog.events)).not.toContain('plug');
  });

  it('is its author’s only: 403 for another who sees it, 404 for who does not', async () => {
    const { on, edit, reply, history, changeSet } = setUp();
    const thread = (await on(reviewer, charging, 'intro')).comment;
    const answer = (await reply(author, thread.id)).comment;
    for (const [actor, id] of [
      [author, thread.id],
      [reviewer, answer.id],
      [drafts, thread.id],
      [germanReviewer, thread.id],
    ] as const) {
      await expect(edit(actor, id, 'x')).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(edit(other, thread.id, 'x')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(edit(reviewer, newCommentId(), 'x')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      edit(reviewer, thread.id, 'x', newCommentId()),
    ).rejects.toMatchObject({ code: 'id-mismatch' });
    // The author lost the right to comment on the module: no longer theirs to change.
    const reviewerWithout = user('sample-reviewer', [
      'content.read',
      'content.read.draft',
    ]);
    await expect(edit(reviewerWithout, thread.id, 'x')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const at = history.store.changeSets.findIndex((c) => c.id === changeSet.id);
    history.store.changeSets[at] = { ...changeSet, state: 'merged' };
    await expect(edit(reviewer, thread.id, 'x')).rejects.toMatchObject({
      code: 'invalid-state',
    });
  });
});

describe('DeleteCommentAction', () => {
  it('keeps a thread start with replies as deleted, and removes a lone one or a reply', async () => {
    const { on, reply, remove, list, get, auditLog, changeSet } = setUp();
    const thread = (await on(reviewer, charging, 'intro', 'Thread')).comment;
    const answer = (await reply(author, thread.id, 'Reply')).comment;
    const lone = (await on(reviewer, charging, 'first', 'Lone')).comment;

    expect(await remove(reviewer, thread.id)).toEqual({ kept: true });
    const kept = await get(author, thread.id);
    expect(kept.comment).toMatchObject({ id: thread.id, body: null });
    expect(kept.comment.deletedAt).toBeInstanceOf(Date);
    expect(ids(await list(author))).toEqual([null, 'Reply', 'Lone']);
    await expect(remove(reviewer, thread.id)).rejects.toMatchObject({
      code: 'comment-deleted',
    });

    expect(await remove(reviewer, lone.id)).toEqual({ kept: false });
    await expect(get(reviewer, lone.id)).rejects.toBeInstanceOf(NotFoundError);
    // The last reply of a deleted thread takes the thread with it.
    expect(await remove(author, answer.id)).toEqual({ kept: false });
    expect((await list(reviewer)).total).toBe(0);

    expect(
      auditLog.events
        .filter((e) => e.action === 'comment.delete')
        .map((e) => [e.subject.id, e.data]),
    ).toEqual([
      [thread.id, { changeSetId: changeSet.id, kept: true }],
      [lone.id, { changeSetId: changeSet.id, kept: false }],
      [
        answer.id,
        {
          changeSetId: changeSet.id,
          threadId: thread.id,
          kept: false,
          threadRemoved: true,
        },
      ],
    ]);
    expect(JSON.stringify(auditLog.events)).not.toContain('Thread');
  });

  it('leaves a deleted thread with other replies, and a thread not deleted, in place', async () => {
    const { on, reply, remove, list } = setUp();
    const thread = (await on(reviewer, charging, 'intro', 'Thread')).comment;
    const one = (await reply(author, thread.id, 'One')).comment;
    await reply(author, thread.id, 'Two');
    await remove(author, one.id);
    expect(ids(await list(reviewer))).toEqual(['Thread', 'Two']);
    await remove(reviewer, thread.id);
    expect(ids(await list(reviewer))).toEqual([null, 'Two']);
  });

  it('refuses another’s comment, a deleted one’s edit, a reply to a removed thread, and a closed change set', async () => {
    const { on, reply, remove, edit, history, changeSet } = setUp();
    const thread = (await on(reviewer, charging, 'intro')).comment;
    await reply(author, thread.id);
    await expect(remove(author, thread.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(remove(other, thread.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await remove(reviewer, thread.id);
    await expect(edit(reviewer, thread.id, 'Back')).rejects.toMatchObject({
      code: 'comment-deleted',
    });
    // A reply to a deleted thread start still goes to its thread.
    const more = (await reply(reviewer, thread.id, 'More')).comment;
    expect(more.threadId).toBe(thread.id);
    const lone = (await on(reviewer, charging, 'first')).comment;
    await remove(reviewer, lone.id);
    await expect(reply(author, lone.id)).rejects.toMatchObject({
      code: 'invalid-thread',
    });
    const at = history.store.changeSets.findIndex((c) => c.id === changeSet.id);
    history.store.changeSets[at] = { ...changeSet, state: 'abandoned' };
    await expect(remove(reviewer, more.id)).rejects.toMatchObject({
      code: 'invalid-state',
    });
  });
});

describe('comments in a public sandbox (#826)', () => {
  const sandbox = () =>
    Sandbox.on({
      limits: {
        moduleBytes: 1_000,
        commentLength: 10,
        changeSets: 5,
        modules: 5,
        manuals: 5,
        releasesPerHour: 5,
        renderJobs: 1,
        writeBytes: 1_000_000,
      },
      lifetime: { idleMinutes: 30, maxMinutes: 90 },
    });

  it('refuses a comment, a reply or an edit past CCMS_SANDBOX_MAX_COMMENT_LENGTH; nothing written', async () => {
    const t = setUp({}, sandbox());
    const { comment } = await t.on(reviewer, charging, 'intro', 'Ten chars!');
    await expect(
      t.on(reviewer, charging, 'intro', 'Eleven char'),
    ).rejects.toMatchObject({
      code: 'sandbox-limit-reached',
      meta: { limit: 'commentLength', max: 10 },
    });
    await expect(
      t.reply(reviewer, comment.id, 'x'.repeat(11)),
    ).rejects.toMatchObject({ code: 'sandbox-limit-reached' });
    await expect(
      t.edit(reviewer, comment.id, 'x'.repeat(11)),
    ).rejects.toMatchObject({ code: 'sandbox-limit-reached' });
    expect(ids(await t.list(reviewer))).toEqual(['Ten chars!']);
    expect(t.auditLog.events).toHaveLength(1);
  });
});
