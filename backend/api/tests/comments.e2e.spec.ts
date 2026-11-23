import { execFileSync } from 'node:child_process';
import {
  type Module,
  parseModule,
  printModule,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import {
  CommentDocument,
  CommentPageDocument,
} from '../src/comments/api/comment.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith(permissions, scope), id });
const author = user('sample-author', ['content.read', 'content.edit']);
const otherAuthor = user('other-author', ['content.read', 'content.edit']);
const reviewer = user('sample-reviewer', [
  'content.read',
  'content.read.draft',
  'content.review',
]);
/** Reads drafts, reviews nothing. */
const drafts = user('draft-reader', ['content.read', 'content.read.draft']);
/** Reads every draft, reviews German only. */
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
/** Reads and reviews German only: English modules are hidden from them. */
const germanOnly = user(
  'german-only',
  ['content.read', 'content.read.draft', 'content.review'],
  { languages: ['de'] },
);
const admin = user('sample-admin', ['admin.roles']);

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const charging = (): Module =>
  parseModule(git('show', 'main:modules/en/charging.adoc'), { id: 'charging' });

const paragraph = (id: string, text: string): Module['blocks'][number] => ({
  type: 'paragraph',
  id,
  content: [{ type: 'text', text }],
});

/** Commits `charging` with `blocks` to the change set's branch, outside the API. */
async function save(branch: string, blocks: Module['blocks']): Promise<string> {
  const { commit } = await new GitWriter(dir()).commit({
    branch,
    parent: git('rev-parse', `refs/heads/${branch}`),
    changes: [
      {
        path: 'modules/en/charging.adoc',
        content: printModule({ ...charging(), blocks }),
      },
    ],
    message: 'Edit charging',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
  return commit;
}

/** A change set by `author` whose branch adds a block to `charging`. */
async function changeSet(): Promise<{ id: string; branch: string }> {
  t.actAs(author);
  const created = await t.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title: 'Clearer charging' } },
    }),
  );
  expect(created.status).toBe(201);
  const { id, attributes } = ChangeSetDocument.parse(created.body).data;
  await save(attributes.branch, [
    ...charging().blocks,
    paragraph('after-care', 'Unplug it.'),
  ]);
  return { id, branch: attributes.branch };
}

const enCharging = { type: 'module', lang: 'en', moduleId: 'charging' };

const comment = (
  id: string,
  attributes: Record<string, unknown>,
  relationships?: unknown,
) =>
  t.post(`/change-sets/${id}/comments`).send(
    JSON.stringify({
      data: {
        type: 'Comment',
        attributes,
        ...(relationships !== undefined && { relationships }),
      },
    }),
  );

const error = (body: unknown) => ErrorDocument.parse(body).errors[0];

describe('POST /change-sets/:changeSetId/comments', () => {
  it('starts a thread on a block, and answers it with a reply', async () => {
    const { id } = await changeSet();
    t.actAs(reviewer);
    const created = await comment(id, {
      body: 'Is this safe?',
      subject: enCharging,
      blockId: 'after-care',
    });
    expect(created.status).toBe(201);
    expect(created.headers['content-type']).toContain(
      'application/vnd.api+json',
    );
    const thread = CommentDocument.parse(created.body).data;
    expect(created.headers['location']).toBe(
      `/change-sets/${id}/comments/${thread.id}`,
    );
    expect(thread).toMatchObject({
      type: 'Comment',
      attributes: {
        subject: enCharging,
        blockId: 'after-care',
        body: 'Is this safe?',
        author: { kind: 'user', id: 'sample-reviewer' },
        commit: git('rev-parse', `refs/heads/change-sets/${id}`),
        resolvedAt: null,
        resolvedBy: null,
      },
      relationships: {
        changeSet: { data: { type: 'ChangeSet', id } },
        thread: { data: { type: 'Comment', id: thread.id } },
      },
      meta: { orphaned: false },
    });

    t.actAs(author);
    const replied = await comment(
      id,
      { body: 'Yes.' },
      { thread: { data: { type: 'Comment', id: thread.id } } },
    );
    expect(replied.status).toBe(201);
    expect(CommentDocument.parse(replied.body).data).toMatchObject({
      attributes: { subject: enCharging, blockId: 'after-care' },
      relationships: { thread: { data: { id: thread.id } } },
    });

    t.actAs(admin);
    const audit = await t.get(
      `/audit-events?filter[subject]=comment/${thread.id}`,
    );
    expect(AuditEventPageDocument.parse(audit.body).data).toMatchObject([
      {
        attributes: {
          action: 'comment.create',
          data: {
            changeSetId: id,
            module: 'en/charging',
            blockId: 'after-care',
          },
        },
      },
    ]);
    expect(JSON.stringify(audit.body)).not.toContain('Is this safe?');
  });

  it('refuses a body that is neither a thread nor a reply, a missing block, and a non-reviewer', async () => {
    const { id } = await changeSet();
    t.actAs(reviewer);
    const both = await comment(
      id,
      { body: 'x', subject: enCharging, blockId: 'intro' },
      { thread: { data: { type: 'Comment', id } } },
    );
    expect(both.status).toBe(400);
    expect(error(both.body)?.code).toBe('invalid-body');
    const neither = await comment(id, { body: 'x' });
    expect(neither.status).toBe(400);
    const missing = await comment(id, {
      body: 'x',
      subject: enCharging,
      blockId: 'nope',
    });
    expect(missing.status).toBe(422);
    expect(error(missing.body)).toMatchObject({
      code: 'block-not-found',
      source: { pointer: '/data/attributes/blockId' },
    });
    for (const actor of [drafts, germanReviewer]) {
      t.actAs(actor);
      const refused = await comment(id, {
        body: 'x',
        subject: enCharging,
        blockId: 'intro',
      });
      expect(refused.status).toBe(403);
      expect(error(refused.body)?.code).toBe('forbidden');
    }
    // Another author does not see the change set: 404, as for none.
    t.actAs(otherAuthor);
    const hidden = await comment(id, {
      body: 'x',
      subject: enCharging,
      blockId: 'intro',
    });
    expect(hidden.status).toBe(404);
    expect(error(hidden.body)?.code).toBe('not-found');
  });
});

describe('GET /change-sets/:changeSetId/comments', () => {
  it('lists in thread order, flags a block a later save removed, and pages', async () => {
    const { id, branch } = await changeSet();
    t.actAs(reviewer);
    for (const [blockId, body] of [
      ['after-care', 'One'],
      ['intro', 'Two'],
    ]) {
      expect(
        (await comment(id, { body, subject: enCharging, blockId })).status,
      ).toBe(201);
    }
    // A save point removes `after-care`: its comment stays, orphaned.
    const head = await save(branch, charging().blocks);
    const res = await t.get(`/change-sets/${id}/comments`);
    expect(res.status).toBe(200);
    const page = CommentPageDocument.parse(res.body);
    expect(page.meta).toMatchObject({ head, page: { total: 2 } });
    expect(page.data.map((c) => [c.attributes.body, c.meta.orphaned])).toEqual([
      ['One', true],
      ['Two', false],
    ]);
    const second = CommentPageDocument.parse(
      (await t.get(`/change-sets/${id}/comments?page[size]=1&page[number]=2`))
        .body,
    );
    expect(second.data.map((c) => c.attributes.body)).toEqual(['Two']);
    expect(second.links.prev).not.toBeNull();
    const filtered = CommentPageDocument.parse(
      (
        await t.get(
          `/change-sets/${id}/comments?filter[module]=en/charging&filter[block]=intro`,
        )
      ).body,
    );
    expect(filtered.data.map((c) => c.attributes.body)).toEqual(['Two']);
    const one = await t.get(`/change-sets/${id}/comments/${page.data[0]?.id}`);
    expect(CommentDocument.parse(one.body).data.meta.orphaned).toBe(true);
  });

  it('refuses unsupported and malformed filters', async () => {
    const { id } = await changeSet();
    t.actAs(reviewer);
    for (const query of [
      'filter[nope]=1',
      'filter[module]=charging',
      'filter[resolved]=yes',
      'filter[block]=Not%20an%20ID',
    ]) {
      const res = await t.get(`/change-sets/${id}/comments?${query}`);
      expect([query, res.status]).toEqual([query, 400]);
    }
  });

  it('is 404 for a change set the reader may not see, and for another’s comment', async () => {
    const { id } = await changeSet();
    t.actAs(reviewer);
    const created = CommentDocument.parse(
      (await comment(id, { body: 'x', subject: enCharging, blockId: 'intro' }))
        .body,
    ).data;
    t.actAs(otherAuthor);
    expect((await t.get(`/change-sets/${id}/comments`)).status).toBe(404);
    const other = await changeSet();
    t.actAs(reviewer);
    const res = await t.get(`/change-sets/${other.id}/comments/${created.id}`);
    expect(res.status).toBe(404);
    expect(error(res.body)?.code).toBe('not-found');
  });
});

describe('a module outside the reader’s scope', () => {
  it('hides its comments exactly like missing ones', async () => {
    const { id } = await changeSet();
    t.actAs(reviewer);
    const hidden = CommentDocument.parse(
      (await comment(id, { body: 'x', subject: enCharging, blockId: 'intro' }))
        .body,
    ).data;
    t.actAs(germanOnly);
    const page = CommentPageDocument.parse(
      (await t.get(`/change-sets/${id}/comments?filter[resolved]=any`)).body,
    );
    expect(page.data).toEqual([]);
    expect(page.meta.page.total).toBe(0);
    for (const path of [
      `/change-sets/${id}/comments/${hidden.id}`,
      `/change-sets/${id}/comments/${hidden.id}/resolve`,
      `/change-sets/${id}/comments/${hidden.id}/reopen`,
    ]) {
      const res = path.endsWith(hidden.id)
        ? await t.get(path)
        : await t.post(path);
      expect([path, res.status]).toEqual([path, 404]);
    }
    const asNew = await comment(id, {
      body: 'x',
      subject: enCharging,
      blockId: 'intro',
    });
    const missing = await comment(id, {
      body: 'x',
      subject: { ...enCharging, moduleId: 'nowhere' },
      blockId: 'intro',
    });
    expect([asNew.status, missing.status]).toEqual([422, 422]);
    expect(error(asNew.body)?.code).toBe(error(missing.body)?.code);
    const reply = await comment(
      id,
      { body: 'x' },
      { thread: { data: { type: 'Comment', id: hidden.id } } },
    );
    expect(reply.status).toBe(422);
    expect(error(reply.body)?.code).toBe('invalid-thread');
  });
});

describe('resolve and reopen', () => {
  it('hide a resolved thread by default, show it on asking, and open it again', async () => {
    const { id } = await changeSet();
    t.actAs(reviewer);
    const thread = CommentDocument.parse(
      (
        await comment(id, {
          body: 'Thread',
          subject: enCharging,
          blockId: 'intro',
        })
      ).body,
    ).data;
    const answer = CommentDocument.parse(
      (
        await comment(
          id,
          { body: 'Reply' },
          { thread: { data: { type: 'Comment', id: thread.id } } },
        )
      ).body,
    ).data;
    t.actAs(author);
    const resolved = await t.post(
      `/change-sets/${id}/comments/${thread.id}/resolve`,
    );
    expect(resolved.status).toBe(200);
    expect(CommentDocument.parse(resolved.body).data.attributes).toMatchObject({
      resolvedBy: { kind: 'user', id: 'sample-author' },
    });
    const bodies = async (query = '') =>
      CommentPageDocument.parse(
        (await t.get(`/change-sets/${id}/comments${query}`)).body,
      ).data.map((c) => c.attributes.body);
    expect(await bodies()).toEqual([]);
    expect(await bodies('?filter[resolved]=true')).toEqual(['Thread', 'Reply']);
    expect(await bodies('?filter[resolved]=any')).toEqual(['Thread', 'Reply']);
    const again = await t.post(
      `/change-sets/${id}/comments/${thread.id}/resolve`,
    );
    expect(again.status).toBe(409);
    expect(error(again.body)?.code).toBe('already-resolved');
    const ofReply = await t.post(
      `/change-sets/${id}/comments/${answer.id}/resolve`,
    );
    expect(ofReply.status).toBe(422);
    expect(error(ofReply.body)?.code).toBe('not-a-thread');
    const reopened = await t.post(
      `/change-sets/${id}/comments/${thread.id}/reopen`,
    );
    expect(reopened.status).toBe(200);
    expect(
      CommentDocument.parse(reopened.body).data.attributes.resolvedAt,
    ).toBe(null);
    expect(await bodies()).toEqual(['Thread', 'Reply']);

    // Abandoned: the comments stay readable, nothing more is written.
    expect((await t.post(`/change-sets/${id}/abandon`)).status).toBe(200);
    const closed = await t.post(
      `/change-sets/${id}/comments/${thread.id}/resolve`,
    );
    expect(closed.status).toBe(409);
    expect(error(closed.body)).toMatchObject({
      code: 'invalid-state',
      meta: { state: 'abandoned' },
    });
    expect(await bodies()).toEqual(['Thread', 'Reply']);
  });
});

describe('edit and delete one’s own comment', () => {
  const edit = (id: string, commentId: string, body: string, as = commentId) =>
    t.patch(`/change-sets/${id}/comments/${commentId}`).send(
      JSON.stringify({
        data: { type: 'Comment', id: as, attributes: { body } },
      }),
    );

  it('edits the text, marked edited, and deletes a thread start with a reply as “deleted”', async () => {
    const { id } = await changeSet();
    t.actAs(reviewer);
    const thread = CommentDocument.parse(
      (
        await comment(id, {
          body: 'Teh plug',
          subject: enCharging,
          blockId: 'intro',
        })
      ).body,
    ).data;
    expect(thread.meta).toEqual({
      orphaned: false,
      deleted: false,
      editedAt: null,
    });
    const edited = await edit(id, thread.id, '  The plug ');
    expect(edited.status).toBe(200);
    expect(edited.headers['content-type']).toContain(
      'application/vnd.api+json',
    );
    const after = CommentDocument.parse(edited.body).data;
    expect(after.attributes.body).toBe('The plug');
    expect(after.meta.editedAt).not.toBeNull();

    t.actAs(author);
    const answer = CommentDocument.parse(
      (
        await comment(
          id,
          { body: 'Fixed.' },
          { thread: { data: { type: 'Comment', id: thread.id } } },
        )
      ).body,
    ).data;

    t.actAs(reviewer);
    const deleted = await t.delete(`/change-sets/${id}/comments/${thread.id}`);
    expect(deleted.status).toBe(204);
    const page = CommentPageDocument.parse(
      (await t.get(`/change-sets/${id}/comments`)).body,
    );
    expect(
      page.data.map((c) => [c.id, c.attributes.body, c.meta.deleted]),
    ).toEqual([
      [thread.id, null, true],
      [answer.id, 'Fixed.', false],
    ]);
    const again = await t.delete(`/change-sets/${id}/comments/${thread.id}`);
    expect(again.status).toBe(409);
    expect(error(again.body)?.code).toBe('comment-deleted');

    // The last reply goes: nothing is left of the thread.
    t.actAs(author);
    expect(
      (await t.delete(`/change-sets/${id}/comments/${answer.id}`)).status,
    ).toBe(204);
    const empty = CommentPageDocument.parse(
      (await t.get(`/change-sets/${id}/comments?filter[resolved]=any`)).body,
    );
    expect(empty.meta.page.total).toBe(0);
    expect(
      (await t.get(`/change-sets/${id}/comments/${thread.id}`)).status,
    ).toBe(404);

    t.actAs(admin);
    const audit = await t.get(
      `/audit-events?filter[subject]=comment/${thread.id}`,
    );
    // Newest first.
    expect(
      AuditEventPageDocument.parse(audit.body).data.map(
        (e) => e.attributes.action,
      ),
    ).toEqual(['comment.delete', 'comment.edit', 'comment.create']);
    expect(JSON.stringify(audit.body)).not.toContain('plug');
  });

  it('is 403 for another person’s comment, 404 for who does not see it, and only on an open change set', async () => {
    const { id } = await changeSet();
    t.actAs(reviewer);
    const theirs = CommentDocument.parse(
      (await comment(id, { body: 'x', subject: enCharging, blockId: 'intro' }))
        .body,
    ).data;
    for (const actor of [author, drafts]) {
      t.actAs(actor);
      for (const res of [
        await edit(id, theirs.id, 'Mine now'),
        await t.delete(`/change-sets/${id}/comments/${theirs.id}`),
      ]) {
        expect(res.status).toBe(403);
        expect(error(res.body)?.code).toBe('forbidden');
      }
    }
    t.actAs(otherAuthor);
    expect((await edit(id, theirs.id, 'x')).status).toBe(404);
    expect(
      (await t.delete(`/change-sets/${id}/comments/${theirs.id}`)).status,
    ).toBe(404);

    t.actAs(reviewer);
    const mismatch = await edit(
      id,
      theirs.id,
      'x',
      '00000000-0000-7000-8000-000000000000',
    );
    expect(mismatch.status).toBe(409);
    expect(error(mismatch.body)?.code).toBe('id-mismatch');
    const empty = await edit(id, theirs.id, '   ');
    expect(empty.status).toBe(400);
    const extra = await t
      .patch(`/change-sets/${id}/comments/${theirs.id}`)
      .send(
        JSON.stringify({
          data: {
            type: 'Comment',
            id: theirs.id,
            attributes: { body: 'x', blockId: 'other' },
          },
        }),
      );
    expect(extra.status).toBe(400);

    t.actAs(author);
    expect((await t.post(`/change-sets/${id}/abandon`)).status).toBe(200);
    t.actAs(reviewer);
    for (const res of [
      await edit(id, theirs.id, 'Late'),
      await t.delete(`/change-sets/${id}/comments/${theirs.id}`),
    ]) {
      expect(res.status).toBe(409);
      expect(error(res.body)).toMatchObject({
        code: 'invalid-state',
        meta: { state: 'abandoned' },
      });
    }
  });
});
