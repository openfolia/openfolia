import { execFileSync } from 'node:child_process';
import { type Module } from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import { sql } from 'drizzle-orm';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ChangeSetChangePageDocument } from '../src/change-sets/api/change.resources.js';
import { ModuleWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import { CarryForwardDocument } from '../src/change-sets/api/workflow.resources.js';
import { ModuleDocument } from '../src/modules/api/module.resources.js';
import {
  MaintenanceLineDocument,
  MaintenanceLinePageDocument,
} from '../src/releases/api/maintenance-line.resources.js';
import {
  ReleaseDocument,
  ReleasePageDocument,
} from '../src/releases/api/release.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const READS: Permission[] = ['content.read', 'content.read.draft'];
const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith([...READS, ...permissions], scope), id });

const author = user('sample-author', ['content.edit']);
const reviewer = user('sample-reviewer', ['content.review']);
const publisher = user('sample-publisher', ['release.publish']);
const narrowPublisher = user('sample-narrow', ['release.publish'], {
  languages: ['de'],
});
const admin = actorWith(['admin.roles']);
const charging = { type: 'module', lang: 'en', moduleId: 'charging' } as const;

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const errors = (body: unknown) => ErrorDocument.parse(body).errors;
const codeOf = (body: unknown) => errors(body)[0]?.code;

beforeAll(async () => {
  t = await createTestApp();
  // Approvals are checked against the reviewer as the directory has them.
  await seedAccess(
    t.database,
    Seed.parse({
      roles: reviewer.roles.map((r) => ({ ...r, id: `reviewer-${r.id}` })),
      users: [
        {
          id: reviewer.id,
          name: reviewer.id,
          roles: reviewer.roles.map((r) => `reviewer-${r.id}`),
        },
      ],
    }),
  );
});
afterAll(() => t?.close());
afterEach(async () => {
  if (!t) return;
  t.actAs(undefined);
  await t.database.db.execute(sql`delete from locks`);
});

async function as<T>(actor: Actor, call: () => Promise<T>): Promise<T> {
  t.actAs(actor);
  return call();
}

const post = (path: string, body?: unknown) =>
  t.post(path).send(body === undefined ? '' : JSON.stringify(body));

async function release(revision: string, maintenanceLine?: string) {
  const res = await as(publisher, () =>
    post('/releases', {
      data: {
        type: 'Release',
        attributes: {
          product: 'north',
          revision,
          ...(maintenanceLine && { maintenanceLine }),
        },
      },
    }),
  );
  expect(res.status).toBe(201);
  return ReleaseDocument.parse(res.body).data;
}

const startLine = (releaseId: string, actor: Actor = publisher) =>
  as(actor, () =>
    post('/maintenance-lines', {
      data: {
        type: 'MaintenanceLine',
        relationships: {
          baseRelease: { data: { type: 'Release', id: releaseId } },
        },
      },
    }),
  );

/** Commits `changes` on `main` as someone outside the API. */
async function onMain(changes: { path: string; content: string }[]) {
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes,
    message: 'On main',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
}

const copyPath = (id: string) =>
  `/change-sets/${id}/modules/en/charging/working-copy`;

/** A change set on the line with `text` as charging's first paragraph, merged. */
async function fixOnLine(line: string, text: string) {
  t.actAs(author);
  const created = await post('/change-sets', {
    data: {
      type: 'ChangeSet',
      attributes: { title: 'Fix a typo', maintenanceLine: line },
    },
  });
  expect(created.status).toBe(201);
  const changeSet = ChangeSetDocument.parse(created.body).data;
  const { id } = changeSet;
  expect(
    (
      await post(`/change-sets/${id}/locks`, {
        data: { type: 'Lock', attributes: { subject: charging } },
      })
    ).status,
  ).toBe(201);
  const read = ModuleWorkingCopyDocument.parse((await t.get(copyPath(id))).body)
    .data.attributes;
  const content = read.content as Module;
  const [first, ...rest] = content.blocks;
  const saved = await t.put(copyPath(id)).send(
    JSON.stringify({
      data: {
        type: 'WorkingCopy',
        attributes: {
          content: {
            ...content,
            blocks: [
              {
                type: 'paragraph',
                id: first?.id ?? 'p',
                content: [{ type: 'text', text }],
              },
              ...rest,
            ],
          },
        },
      },
      meta: { version: read.version, baseCommit: read.baseCommit },
    }),
  );
  expect(saved.status).toBe(200);
  expect((await post(`/change-sets/${id}/commits`)).status).toBe(201);
  expect((await post(`/change-sets/${id}/submit`)).status).toBe(200);
  expect(
    (await as(reviewer, () => post(`/change-sets/${id}/approve`))).status,
  ).toBe(200);
  const merged = await as(publisher, () => post(`/change-sets/${id}/merge`));
  expect(merged.status).toBe(200);
  return ChangeSetDocument.parse(merged.body).data;
}

describe('maintenance lines', () => {
  let line: string;
  let branch: string;
  let base: Awaited<ReturnType<typeof release>>;

  it('starts a line from a release, its branch at exactly the release’s tag', async () => {
    base = await release('1.0');
    expect((await startLine(base.id, author)).status).toBe(403);
    expect((await startLine(base.id, narrowPublisher)).status).toBe(403);
    const res = await startLine(base.id);
    expect(res.status).toBe(201);
    const { data } = MaintenanceLineDocument.parse(res.body);
    expect(res.headers['location']).toBe(`/maintenance-lines/${data.id}`);
    expect(data).toMatchObject({
      attributes: {
        product: 'north',
        revision: '1.0',
        branch: 'maintenance/north/1.0',
        baseCommit: base.attributes.commit,
        state: 'open',
        createdBy: { kind: 'user', id: 'sample-publisher' },
        closedAt: null,
      },
      relationships: {
        baseRelease: { data: { type: 'Release', id: base.id } },
      },
      meta: { head: base.attributes.commit },
    });
    line = data.id;
    branch = data.attributes.branch;
    expect(git('rev-parse', `refs/heads/${branch}`)).toBe(
      git('rev-parse', `refs/tags/${base.attributes.tag}^{commit}`),
    );

    const again = await startLine(base.id);
    expect(again.status).toBe(409);
    expect(codeOf(again.body)).toBe('maintenance-line-exists');
    const unknown = await startLine('00000000-0000-7000-8000-000000000000');
    expect(unknown.status).toBe(404);
    expect(codeOf(unknown.body)).toBe('not-found');

    t.actAs(author);
    const list = MaintenanceLinePageDocument.parse(
      (await t.get('/maintenance-lines?filter[product]=north')).body,
    );
    expect(list.data.map((l) => l.id)).toEqual([line]);
    expect(list.meta.page.total).toBe(1);
    expect((await t.get(`/maintenance-lines/${line}`)).status).toBe(200);
    expect((await t.get('/maintenance-lines/nope')).status).toBe(404);
    t.actAs(actorWith(['content.read']));
    expect((await t.get('/maintenance-lines')).status).toBe(403);
  });

  it('fixes the older revision on the line, releases it, and carries the fix forward to main', async () => {
    // main moves on after the release: the line keeps 1.0's content.
    await onMain([
      {
        path: 'modules/en/safety-note.adoc',
        // `git` trims the file's last newline.
        content: `${git('show', 'main:modules/en/safety-note.adoc')}\n\nA newer paragraph on main.\n`,
      },
    ]);
    const fix = await fixOnLine(line, 'Fixed typo on the line.');
    expect(fix.attributes.baseRef).toBe(branch);
    expect(git('rev-parse', `refs/heads/${branch}`)).toBe(
      fix.attributes.mergeCommit,
    );
    expect(git('show', `${branch}:modules/en/charging.adoc`)).toContain(
      'Fixed typo on the line.',
    );
    // main does not have it.
    expect(git('show', 'main:modules/en/charging.adoc')).not.toContain(
      'Fixed typo on the line.',
    );

    // Released as a new revision of the line; its tag reads the fix.
    const fixed = await release('1.0.1', line);
    expect(fixed.attributes.commit).toBe(fix.attributes.mergeCommit);
    t.actAs(author);
    const atTag = ModuleDocument.parse(
      (await t.get(`/modules/en/charging?ref=${fixed.attributes.tag}`)).body,
    );
    expect(JSON.stringify(atTag.data.attributes)).toContain(
      'Fixed typo on the line.',
    );
    const lineReleases = ReleasePageDocument.parse(
      (await t.get(`/maintenance-lines/${line}/releases`)).body,
    );
    expect(lineReleases.data.map((r) => r.id)).toEqual([fixed.id]);
    // Another product is refused.
    const other = await as(publisher, () =>
      post('/releases', {
        data: {
          type: 'Release',
          attributes: {
            product: 'south',
            revision: '9',
            maintenanceLine: line,
          },
        },
      }),
    );
    expect(other.status).toBe(422);
    expect(codeOf(other.body)).toBe('invalid-product');

    // Carried forward: a draft on main whose diff is the original's.
    expect(
      (await as(reviewer, () => post(`/change-sets/${fix.id}/carry-forward`)))
        .status,
    ).toBe(403);
    const carried = await as(author, () =>
      post(`/change-sets/${fix.id}/carry-forward`),
    );
    expect(carried.status).toBe(200);
    const doc = CarryForwardDocument.parse(carried.body);
    expect(doc.data.attributes).toMatchObject({
      title: 'Carry forward: Fix a typo',
      baseRef: 'main',
      baseCommit: git('rev-parse', 'refs/heads/main'),
      state: 'draft',
    });
    expect(doc.meta.carryForward).toMatchObject({
      from: fix.id,
      applied: [charging],
      conflicts: [],
      total: 0,
    });
    const newBranch = doc.data.attributes.branch;
    const diff = (from: string, to: string) =>
      git('diff', '--no-color', from, to);
    expect(diff('main', newBranch)).toBe(
      diff(fix.attributes.baseCommit, fix.attributes.reviewHead as string),
    );
    // main's own newer paragraph is kept on the new branch.
    expect(git('show', `${newBranch}:modules/en/safety-note.adoc`)).toContain(
      'A newer paragraph on main.',
    );
    const changes = ChangeSetChangePageDocument.parse(
      (await t.get(`/change-sets/${doc.data.id}/changes`)).body,
    );
    expect(changes.data.map((c) => c.id)).toEqual(['module/en/charging']);

    const twice = await post(`/change-sets/${fix.id}/carry-forward`);
    expect(twice.status).toBe(409);
    expect(codeOf(twice.body)).toBe('already-carried-forward');

    t.actAs(admin);
    const audit = AuditEventPageDocument.parse(
      (
        await t.get(
          '/audit-events?filter[action]=change-set.carry-forward&page[size]=10',
        )
      ).body,
    );
    expect(audit.data.map((e) => e.attributes.subject)).toEqual([
      { type: 'change-set', id: fix.id },
    ]);
    expect(audit.data[0]?.attributes.data).toMatchObject({
      changeSetId: doc.data.id,
      maintenanceLine: line,
    });
    // The carried draft's own branch: abandon it, to free its lock.
    expect(
      (await as(author, () => post(`/change-sets/${doc.data.id}/abandon`)))
        .status,
    ).toBe(200);
  });

  it('lists a conflict and leaves that module as it is on main', async () => {
    const fix = await fixOnLine(line, 'A second fix on the line.');
    await onMain([
      {
        path: 'modules/en/charging.adoc',
        content: `${git('show', 'main:modules/en/charging.adoc').replace(
          'charges automatically.',
          'charges on its own, reworded on main.',
        )}\n`,
      },
    ]);
    const before = git('show', 'main:modules/en/charging.adoc');
    const carried = await as(author, () =>
      post(`/change-sets/${fix.id}/carry-forward`),
    );
    expect(carried.status).toBe(200);
    const doc = CarryForwardDocument.parse(carried.body);
    expect(doc.meta.carryForward.commit).toBeNull();
    expect(doc.meta.carryForward.conflicts).toEqual([
      expect.objectContaining({
        path: 'modules/en/charging.adoc',
        subject: charging,
        kinds: ['contents'],
      }),
    ]);
    expect(
      git('show', `${doc.data.attributes.branch}:modules/en/charging.adoc`),
    ).toBe(before);
  });

  it('closes a line: no new change sets on it, refused without release.publish', async () => {
    expect(
      (await as(author, () => post(`/maintenance-lines/${line}/close`))).status,
    ).toBe(403);
    const closed = await as(publisher, () =>
      post(`/maintenance-lines/${line}/close`, {
        meta: { comment: 'End of support.' },
      }),
    );
    expect(closed.status).toBe(200);
    expect(
      MaintenanceLineDocument.parse(closed.body).data.attributes,
    ).toMatchObject({
      state: 'closed',
      closedBy: { kind: 'user', id: 'sample-publisher' },
    });
    const again = await post(`/maintenance-lines/${line}/close`);
    expect(again.status).toBe(409);
    expect(codeOf(again.body)).toBe('invalid-state');

    for (const attributes of [
      { title: 'Too late', maintenanceLine: line },
      { title: 'Too late', baseRef: branch },
    ]) {
      const refused = await as(author, () =>
        post('/change-sets', { data: { type: 'ChangeSet', attributes } }),
      );
      expect(refused.status).toBe(409);
      expect(errors(refused.body)[0]).toMatchObject({
        code: 'invalid-state',
        meta: { state: 'closed' },
      });
    }
    // The branch stays.
    expect(git('rev-parse', '--verify', `refs/heads/${branch}`)).toMatch(
      /^[0-9a-f]{40}$/,
    );
    t.actAs(admin);
    const audit = AuditEventPageDocument.parse(
      (
        await t.get(
          `/audit-events?filter[subject]=maintenance-line/${line}&page[size]=10`,
        )
      ).body,
    );
    expect(audit.data.map((e) => e.attributes.action)).toEqual([
      'maintenance-line.close',
      'maintenance-line.start',
    ]);
  });
});
