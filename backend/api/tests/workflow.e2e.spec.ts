import { execFileSync } from 'node:child_process';
import {
  type Module,
  parseModule,
  printModule,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import { sql } from 'drizzle-orm';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetReconciler } from '../src/change-sets/api/change-set-reconciler.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ModuleWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import {
  MergeDocument,
  ReviewDocument,
} from '../src/change-sets/api/workflow.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const READS: Permission[] = ['content.read', 'content.read.draft'];
const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith([...READS, ...permissions], scope), id });

const author = user('sample-author', ['content.edit']);
const reviewer = user('sample-reviewer', ['content.review']);
const approver = user('sample-approver', ['content.approve'], {
  moduleTypes: ['procedure'],
});
const publisher = user('sample-publisher', ['release.publish']);
const admin = actorWith(['admin.roles']);
const charging = { type: 'module', lang: 'en', moduleId: 'charging' } as const;

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const errors = (body: unknown) => ErrorDocument.parse(body).errors;

/** Commits `changes` on `main` as someone outside the API. */
async function onMain(changes: { path: string; content: string }[]) {
  const { commit } = await new GitWriter(dir()).commit({
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes,
    message: 'On main',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
  return commit;
}

beforeAll(async () => {
  t = await createTestApp();
  // Procedures are a restricted type here: they need a sign-off.
  const config = git('show', 'main:openfolia.yaml').replace(
    '{ id: procedure, label: Procedure }',
    '{ id: procedure, label: Procedure, restricted: true }',
  );
  await onMain([{ path: 'openfolia.yaml', content: `${config}\n` }]);
  await seedUsers(reviewer, approver);
});
afterAll(() => t?.close());
afterEach(async () => {
  if (!t) return; // beforeAll failed: only its error is reported.
  t.actAs(undefined);
  await t.database.db.execute(sql`delete from locks`);
});

/**
 * Puts `actors` into the user directory with their roles as they are:
 * approvals hold only while their approver, looked up there, still holds
 * what they gave. A user seeded again holds exactly the roles given now.
 */
async function seedUsers(...actors: Actor[]) {
  const roleId = (a: Actor, r: { id: string }) => `${a.id}-${r.id}`;
  await seedAccess(
    t.database,
    Seed.parse({
      roles: actors.flatMap((a) =>
        a.roles.map((r) => ({ ...r, id: roleId(a, r) })),
      ),
      users: actors.map((a) => ({
        id: a.id,
        name: a.id,
        roles: a.roles.map((r) => roleId(a, r)),
      })),
    }),
  );
}

async function as<T>(actor: Actor, call: () => Promise<T>): Promise<T> {
  t.actAs(actor);
  return call();
}

/** A change set with `text` committed into `charging` at a save point. */
async function changed(text: string): Promise<{ id: string; branch: string }> {
  t.actAs(author);
  const created = await t.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title: 'Clearer charging' } },
    }),
  );
  expect(created.status).toBe(201);
  const { id, attributes } = ChangeSetDocument.parse(created.body).data;
  const locked = await t.post(`/change-sets/${id}/locks`).send(
    JSON.stringify({
      data: { type: 'Lock', attributes: { subject: charging } },
    }),
  );
  expect(locked.status).toBe(201);
  await save(id, text);
  expect((await t.post(`/change-sets/${id}/commits`)).status).toBe(201);
  return { id, branch: attributes.branch };
}

const copyPath = (id: string) =>
  `/change-sets/${id}/modules/en/charging/working-copy`;

async function save(id: string, text: string) {
  const read = await t.get(copyPath(id));
  const at = ModuleWorkingCopyDocument.parse(read.body).data.attributes;
  const content = at.content as Module;
  return t.put(copyPath(id)).send(
    JSON.stringify({
      data: {
        type: 'WorkingCopy',
        attributes: {
          content: {
            ...content,
            blocks: [
              {
                type: 'paragraph',
                id: 'typed',
                content: [{ type: 'text', text }],
              },
            ],
          },
        },
      },
      meta: { version: at.version, baseCommit: at.baseCommit },
    }),
  );
}

const transition = (id: string, name: string, comment?: string) =>
  t
    .post(`/change-sets/${id}/${name}`)
    .send(comment === undefined ? '' : JSON.stringify({ meta: { comment } }));

async function events(id: string) {
  t.actAs(admin);
  const res = await t.get(
    `/audit-events?filter[subject]=change-set/${id}&page[size]=200`,
  );
  return AuditEventPageDocument.parse(res.body)
    .data.map((e) => e.attributes)
    .reverse();
}

describe('the change set workflow', () => {
  it('goes draft → in review → approved → merged, frozen while reviewed', async () => {
    const cs = await changed('Plug in, then switch on.');
    const head = git('rev-parse', `refs/heads/${cs.branch}`);

    const submitted = await as(author, () =>
      transition(cs.id, 'submit', 'Ready.'),
    );
    expect(submitted.status).toBe(200);
    expect(
      ChangeSetDocument.parse(submitted.body).data.attributes,
    ).toMatchObject({
      state: 'in-review',
      reviewHead: head,
      mergeCommit: null,
    });
    // Frozen: no save until it is returned.
    const frozen = await save(cs.id, 'Sneaked in.');
    expect(frozen.status).toBe(409);
    expect(errors(frozen.body)[0]?.code).toBe('invalid-state');

    // Four eyes: the author never approves their own.
    const own = await as(
      user('sample-author', ['content.edit', 'content.review']),
      () => transition(cs.id, 'approve'),
    );
    expect(own.status).toBe(403);

    const reviewed = await as(reviewer, () =>
      transition(cs.id, 'approve', 'Reads well.'),
    );
    expect(reviewed.status).toBe(200);
    const review = ReviewDocument.parse(reviewed.body);
    expect(review.data.attributes.state).toBe('in-review');
    expect(review.meta.review).toMatchObject({
      required: ['review', 'sign-off/procedure'],
      granted: ['review'],
      pending: ['sign-off/procedure'],
    });
    const signed = await as(approver, () =>
      transition(cs.id, 'sign-off', 'Safe.'),
    );
    expect(signed.status).toBe(200);
    expect(ReviewDocument.parse(signed.body).data.attributes.state).toBe(
      'approved',
    );

    const main = git('rev-parse', 'refs/heads/main');
    const merged = await as(publisher, () =>
      transition(cs.id, 'merge', 'Out it goes.'),
    );
    expect(merged.status).toBe(200);
    const merge = MergeDocument.parse(merged.body);
    expect(merge.data.attributes).toMatchObject({
      state: 'merged',
      mergeCommit: merge.meta.merge.commit,
    });
    expect(git('rev-parse', 'refs/heads/main')).toBe(merge.meta.merge.commit);
    expect(git('log', '-1', '--format=%P', merge.meta.merge.commit)).toBe(
      `${main} ${head}`,
    );
    expect(
      git('log', '-1', '--format=%(trailers:only)', merge.meta.merge.commit),
    ).toBe(
      [
        `Merged-change-set: ${cs.id}`,
        'Merged-by: user/sample-publisher',
        'Approved-by: user/sample-approver',
        'Approved-by: user/sample-reviewer',
      ].join('\n'),
    );
    // The locks are released.
    const locks = await as(author, () =>
      t.get(`/locks?filter[changeSet]=${cs.id}`),
    );
    expect(locks.body.meta.page.total).toBe(0);

    const audited = (await events(cs.id)).filter((e) =>
      /^change-set\.(submit|approve|sign-off|merge)$/.test(e.action),
    );
    expect(
      audited.map((e) => [e.action, e.actor.id, e.comment, e.data]),
    ).toEqual([
      [
        'change-set.submit',
        'sample-author',
        'Ready.',
        { from: 'draft', to: 'in-review', head },
      ],
      [
        'change-set.approve',
        'sample-reviewer',
        'Reads well.',
        expect.objectContaining({ from: 'in-review', to: 'in-review' }),
      ],
      [
        'change-set.sign-off',
        'sample-approver',
        'Safe.',
        expect.objectContaining({ from: 'in-review', to: 'approved' }),
      ],
      [
        'change-set.merge',
        'sample-publisher',
        'Out it goes.',
        expect.objectContaining({
          from: 'approved',
          to: 'merged',
          commit: merge.meta.merge.commit,
          approvedBy: ['user/sample-approver', 'user/sample-reviewer'],
        }),
      ],
    ]);
    const outbox = await t.database.db.execute(
      sql`select topic from outbox where payload->>'changeSetId' = ${cs.id} and topic <> 'change-set.commit' order by id`,
    );
    expect(outbox.rows.map((r) => r['topic'])).toEqual([
      'change-set.submit',
      'change-set.approve',
      'change-set.sign-off',
      'change-set.merge',
    ]);
  });

  it('reads where a review stands, found as the change set is', async () => {
    const cs = await changed('Read me.');
    const draft = await as(reviewer, () =>
      t.get(`/change-sets/${cs.id}/review`),
    );
    expect(draft.status).toBe(200);
    expect(ReviewDocument.parse(draft.body).meta.review).toEqual({
      required: ['review', 'sign-off/procedure'],
      granted: [],
      pending: ['review', 'sign-off/procedure'],
      approvals: [],
      lapsed: [],
      selfApproved: false,
      selfApproval: 'never',
      yours: false,
    });
    await as(author, () => transition(cs.id, 'submit'));
    await as(reviewer, () => transition(cs.id, 'approve'));
    const half = await as(approver, () =>
      t.get(`/change-sets/${cs.id}/review`),
    );
    expect(ReviewDocument.parse(half.body).meta.review.pending).toEqual([
      'sign-off/procedure',
    ]);
    await as(approver, () => transition(cs.id, 'sign-off'));
    const read = await as(author, () => t.get(`/change-sets/${cs.id}/review`));
    expect(read.status).toBe(200);
    const review = ReviewDocument.parse(read.body);
    expect(review.data.attributes.state).toBe('approved');
    expect(review.meta.review).toMatchObject({
      granted: [],
      pending: [],
      approvals: [
        {
          requirement: 'review',
          approver: { kind: 'user', id: 'sample-reviewer' },
        },
        {
          requirement: 'sign-off/procedure',
          approver: { kind: 'user', id: 'sample-approver' },
        },
      ],
    });
    // Without content.read.draft: refused, whether the change set exists or not.
    const blind = actorWith(['content.read', 'content.review']);
    const refused = await as(blind, () =>
      t.get(`/change-sets/${cs.id}/review`),
    );
    expect(refused.status).toBe(403);
    const missing = await as(reviewer, () =>
      t.get('/change-sets/0190a0b0-0000-7000-8000-000000000000/review'),
    );
    expect(missing.status).toBe(404);
    expect(errors(missing.body)[0]?.code).toBe('not-found');
  });

  it('returns a change set to draft with the changes requested', async () => {
    const cs = await changed('First try.');
    await as(author, () => transition(cs.id, 'submit'));
    await as(reviewer, () => transition(cs.id, 'approve'));
    const returned = await as(reviewer, () =>
      transition(cs.id, 'return', 'Name the charger.'),
    );
    expect(returned.status).toBe(200);
    expect(
      ChangeSetDocument.parse(returned.body).data.attributes,
    ).toMatchObject({ state: 'draft', reviewHead: null });
    const [event] = (await events(cs.id)).filter(
      (e) => e.action === 'change-set.return',
    );
    expect(event).toMatchObject({
      comment: 'Name the charger.',
      data: { from: 'in-review', to: 'draft', approvals: 1 },
    });
    // The author goes on with the same lock.
    expect((await as(author, () => save(cs.id, 'Second try.'))).status).toBe(
      200,
    );
    const again = await transition(cs.id, 'submit');
    expect(again.status).toBe(409);
    expect(errors(again.body)[0]?.code).toBe('uncommitted-working-copies');
  });

  it('answers a conflict with the paths and stays approved but unmerged', async () => {
    const cs = await changed('Ours.');
    await as(author, () => transition(cs.id, 'submit'));
    await as(reviewer, () => transition(cs.id, 'approve'));
    await as(approver, () => transition(cs.id, 'sign-off'));
    const committed = parseModule(
      `${git('show', 'main:modules/en/charging.adoc')}\n`,
      { id: 'charging' },
    );
    const theirs = printModule({
      ...committed,
      blocks: [
        {
          type: 'paragraph',
          id: 'theirs',
          content: [{ type: 'text', text: 'Theirs.' }],
        },
      ],
    });
    const main = await onMain([
      { path: 'modules/en/charging.adoc', content: theirs },
    ]);
    const res = await as(publisher, () => transition(cs.id, 'merge'));
    expect(res.status).toBe(409);
    expect(errors(res.body)[0]).toMatchObject({
      code: 'merge-conflict',
      meta: {
        conflicts: [{ path: 'modules/en/charging.adoc', kinds: ['contents'] }],
        total: 1,
      },
    });
    expect(git('rev-parse', 'refs/heads/main')).toBe(main);
    const read = await as(publisher, () => t.get(`/change-sets/${cs.id}`));
    expect(ChangeSetDocument.parse(read.body).data.attributes.state).toBe(
      'approved',
    );
    // A reviewer sends it back for the author to resolve.
    expect((await as(reviewer, () => transition(cs.id, 'return'))).status).toBe(
      200,
    );
  });

  it('refuses a publisher whose scope misses what the change set changes', async () => {
    const cs = await changed('Scoped.');
    await as(author, () => transition(cs.id, 'submit'));
    await as(reviewer, () => transition(cs.id, 'approve'));
    await as(approver, () => transition(cs.id, 'sign-off'));
    const narrow = user('narrow-publisher', ['release.publish'], {
      moduleTypes: ['concept'],
    });
    const res = await as(narrow, () => transition(cs.id, 'merge'));
    expect(res.status).toBe(403);
    expect(errors(res.body)[0]?.code).toBe('forbidden');
  });

  it('refuses a merge whose approver lost the role since, with a clear 409', async () => {
    const cs = await changed('Approved, then demoted.');
    await as(author, () => transition(cs.id, 'submit'));
    await as(reviewer, () => transition(cs.id, 'approve'));
    await as(approver, () => transition(cs.id, 'sign-off'));
    const main = git('rev-parse', 'refs/heads/main');
    // The reviewer's role is taken away after they approved.
    await seedUsers({ ...reviewer, roles: [] });
    try {
      const res = await as(publisher, () => transition(cs.id, 'merge'));
      expect(res.status).toBe(409);
      expect(errors(res.body)[0]).toMatchObject({
        code: 'approval-lapsed',
        meta: {
          pending: ['review'],
          lapsed: [
            {
              requirement: 'review',
              approver: { kind: 'user', id: 'sample-reviewer' },
            },
          ],
        },
      });
      expect(git('rev-parse', 'refs/heads/main')).toBe(main);
    } finally {
      await seedUsers(reviewer);
    }
    // With the role back, the approval holds again.
    const merged = await as(publisher, () => transition(cs.id, 'merge'));
    expect(merged.status).toBe(200);
  });

  it('writes an outbox row for an abandon, as for every transition', async () => {
    const cs = await changed('Not needed.');
    const res = await as(author, () =>
      transition(cs.id, 'abandon', 'Superseded.'),
    );
    expect(res.status).toBe(200);
    const outbox = await t.database.db.execute(
      sql`select topic, key, payload from outbox where payload->>'changeSetId' = ${cs.id} and topic <> 'change-set.commit' order by id`,
    );
    // (The save point dropped the working copy: none counted.)
    expect(outbox.rows).toEqual([
      {
        topic: 'change-set.abandon',
        key: cs.id,
        payload: {
          changeSetId: cs.id,
          actor: { kind: 'user', id: 'sample-author' },
          comment: 'Superseded.',
          from: 'draft',
          to: 'abandoned',
        },
      },
    ]);
  });

  it('records a merge that landed in Git when the database failed after it', async () => {
    const cs = await changed('Crash.');
    await as(author, () => transition(cs.id, 'submit'));
    await as(reviewer, () => transition(cs.id, 'approve'));
    await as(approver, () => transition(cs.id, 'sign-off'));
    await t.database.db.execute(
      sql.raw(`create function fail_merge() returns trigger language plpgsql as $$
        begin raise exception 'injected failure'; end $$`),
    );
    await t.database.db.execute(
      sql.raw(`create trigger fail_merge before insert on outbox
        for each row when (new.topic = 'change-set.merge') execute function fail_merge()`),
    );
    try {
      const res = await as(publisher, () => transition(cs.id, 'merge'));
      expect(res.status).toBe(500);
    } finally {
      await t.database.db.execute(sql.raw('drop trigger fail_merge on outbox'));
      await t.database.db.execute(sql.raw('drop function fail_merge()'));
    }
    const main = git('rev-parse', 'refs/heads/main');
    expect(
      git(
        'log',
        '-1',
        '--format=%(trailers:key=Merged-change-set,valueonly)',
        main,
      ),
    ).toBe(cs.id);
    const before = await as(publisher, () => t.get(`/change-sets/${cs.id}`));
    expect(ChangeSetDocument.parse(before.body).data.attributes.state).toBe(
      'approved',
    );

    await t.app.get(ChangeSetReconciler).runOnce();
    const after = await as(publisher, () => t.get(`/change-sets/${cs.id}`));
    expect(ChangeSetDocument.parse(after.body).data.attributes).toMatchObject({
      state: 'merged',
      mergeCommit: main,
    });
    const [merge] = (await events(cs.id)).filter(
      (e) => e.action === 'change-set.merge',
    );
    expect(merge).toMatchObject({
      actor: { kind: 'service', id: 'service:reconciler' },
      data: {
        recovered: true,
        commit: main,
        claimedMergedBy: 'user/sample-publisher',
      },
    });
  });
});
