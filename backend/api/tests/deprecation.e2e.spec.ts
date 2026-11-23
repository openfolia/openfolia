import type { Deprecation, Module } from '@openfolia/content-model';
import { eq, sql } from 'drizzle-orm';
import type { Actor } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { outbox } from '../src/change-sets/repos/outbox.tables.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import { ManualDocument } from '../src/manuals/api/manual.resources.js';
import { ModuleSummaryPageDocument } from '../src/modules/api/module-summary.resources.js';
import { ModuleDocument } from '../src/modules/api/module.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const READS: Permission[] = ['content.read', 'content.read.draft'];
const user = (id: string, permissions: Permission[]): Actor => ({
  ...actorWith([...READS, ...permissions]),
  id,
});
const author = user('sample-author', ['content.edit']);
const reviewer = user('sample-reviewer', ['content.review']);
const publisher = user('sample-publisher', ['release.publish']);
const consumer = actorWith(['content.read']);
const charging = { type: 'module', lang: 'en', moduleId: 'charging' } as const;
const DEPRECATION: Deprecation = {
  reason: 'Superseded by the safety note.',
  replacedBy: 'safety-note',
};

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
  // Approvals hold while their approver, looked up again, holds the role.
  const roleId = (a: Actor, r: { id: string }) => `${a.id}-${r.id}`;
  await seedAccess(
    t.database,
    Seed.parse({
      roles: reviewer.roles.map((r) => ({ ...r, id: roleId(reviewer, r) })),
      users: [
        {
          id: reviewer.id,
          name: reviewer.id,
          roles: reviewer.roles.map((r) => roleId(reviewer, r)),
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

type Subject =
  typeof charging | { readonly type: 'manual'; readonly manualId: string };
const copyPath = (id: string, subject: Subject) =>
  subject.type === 'module'
    ? `/change-sets/${id}/modules/${subject.lang}/${subject.moduleId}/working-copy`
    : `/change-sets/${id}/manuals/${subject.manualId}/working-copy`;

/** `content` with `deprecated` set (none: taken away). */
function withDeprecation(
  subject: Subject,
  content: Record<string, unknown>,
  deprecated: Deprecation | undefined,
): Record<string, unknown> {
  const set = (o: object): Record<string, unknown> => {
    const next: Record<string, unknown> = { ...o };
    delete next['deprecated'];
    return deprecated ? { ...next, deprecated } : next;
  };
  if (subject.type === 'manual') return set(content);
  const module = content as unknown as Module;
  return { ...module, meta: set(module.meta) };
}

/** A change set setting a deprecation (none: undoing it), merged into `main`. */
async function mergeDeprecation(
  deprecated: Deprecation | undefined,
  subject: Subject = charging,
): Promise<string> {
  t.actAs(author);
  const created = await t.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title: 'Deprecate it' } },
    }),
  );
  expect(created.status).toBe(201);
  const { id } = ChangeSetDocument.parse(created.body).data;
  const locked = await t
    .post(`/change-sets/${id}/locks`)
    .send(JSON.stringify({ data: { type: 'Lock', attributes: { subject } } }));
  expect(locked.status).toBe(201);
  const read = (await t.get(copyPath(id, subject))).body as {
    data: {
      attributes: {
        content: Record<string, unknown>;
        version: number;
        baseCommit: string;
      };
    };
  };
  const { content, version, baseCommit } = read.data.attributes;
  const saved = await t.put(copyPath(id, subject)).send(
    JSON.stringify({
      data: {
        type: 'WorkingCopy',
        attributes: {
          content: withDeprecation(subject, content, deprecated),
        },
      },
      meta: { version, baseCommit },
    }),
  );
  expect(saved.status).toBe(200);
  expect((await t.post(`/change-sets/${id}/commits`)).status).toBe(201);
  expect((await t.post(`/change-sets/${id}/submit`).send('')).status).toBe(200);
  t.actAs(reviewer);
  expect((await t.post(`/change-sets/${id}/approve`).send('')).status).toBe(
    200,
  );
  t.actAs(publisher);
  const merged = await t.post(`/change-sets/${id}/merge`).send('');
  expect(merged.status).toBe(200);
  return id;
}

const statusOf = async (lang: string, as: Actor = author) => {
  t.actAs(as);
  const res = await t.get(`/modules/${lang}/charging?ref=main`);
  expect(res.status).toBe(200);
  return ModuleDocument.parse(res.body).data;
};

const rows = (topic = 'module.deprecated') =>
  t.database.db.select().from(outbox).where(eq(outbox.topic, topic));

describe('deprecating a module through a change set (#266)', () => {
  let changeSetId = '';

  it('shows it as deprecated once merged, in every language, and writes one outbox row', async () => {
    expect((await statusOf('en')).meta.status.deprecated).toBeNull();
    changeSetId = await mergeDeprecation(DEPRECATION);

    const en = await statusOf('en');
    expect(en.attributes.deprecated).toEqual(DEPRECATION);
    expect(en.meta.status.deprecated).toEqual(DEPRECATION);
    // The German file has none of its own: the module's is the source's.
    const de = await statusOf('de');
    expect(de.attributes.deprecated).toBeUndefined();
    expect(de.meta.status.deprecated).toEqual(DEPRECATION);
    // The delivery API shows it too.
    expect((await statusOf('en', consumer)).meta.status.deprecated).toEqual(
      DEPRECATION,
    );

    const written = await rows();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      key: `${changeSetId}/charging`,
      payload: {
        moduleId: 'charging',
        reason: DEPRECATION.reason,
        replacedBy: 'safety-note',
        changeSetId,
      },
    });
  });

  it('lists it with filter[deprecated] and leaves it out with false', async () => {
    t.actAs(author);
    const only = ModuleSummaryPageDocument.parse(
      (await t.get('/module-summaries?ref=main&filter[deprecated]=true')).body,
    );
    expect(only.data.map((s) => [s.id, s.attributes.deprecated])).toEqual([
      ['charging', DEPRECATION],
    ]);
    const others = ModuleSummaryPageDocument.parse(
      (await t.get('/module-summaries?ref=main&filter[deprecated]=false')).body,
    );
    expect(others.data.map((s) => s.id)).not.toContain('charging');
    expect(others.data.length).toBeGreaterThan(0);
    const bad = await t.get('/module-summaries?filter[deprecated]=yes');
    expect(bad.status).toBe(400);
  });

  it('warns at the manual that includes it, naming the replacement', async () => {
    t.actAs(author);
    const res = await t.get('/manuals/operating/checks?ref=main');
    expect(res.status).toBe(200);
    const checks = CheckPageDocument.parse(res.body).data;
    expect(
      checks.find((c) => c.attributes.code === 'deprecated-module'),
    ).toMatchObject({
      attributes: {
        severity: 'warning',
        subject: { type: 'manual', manualId: 'operating' },
        params: { module: 'charging', replacedBy: 'safety-note' },
      },
    });
  });

  it('clears the status when a later change set undoes it, writing no new row', async () => {
    await mergeDeprecation(undefined);
    expect((await statusOf('en')).meta.status.deprecated).toBeNull();
    expect((await statusOf('en')).attributes.deprecated).toBeUndefined();
    expect(await rows()).toHaveLength(1);
  });
});

describe('deprecating a manual through a change set (#266)', () => {
  it('shows it in the manual once merged and writes one manual.deprecated row', async () => {
    const replaced: Deprecation = {
      reason: 'Merged.',
      replacedBy: 'operating',
    };
    const id = await mergeDeprecation(replaced, {
      type: 'manual',
      manualId: 'service',
    });
    t.actAs(author);
    const res = await t.get('/manuals/service?ref=main');
    expect(res.status).toBe(200);
    expect(ManualDocument.parse(res.body).data.attributes.deprecated).toEqual(
      replaced,
    );
    // "Used in" of a module it includes says the manual is deprecated.
    const first = JSON.stringify(
      ManualDocument.parse(res.body).data.attributes.entries,
    ).match(/"module":"([a-z0-9-]+)"/)?.[1];
    expect(first).toBeDefined();
    const used = ModuleDocument.parse(
      (await t.get(`/modules/en/${first}?ref=main`)).body,
    ).data.meta;
    expect('usedIn' in used ? used.usedIn : []).toContainEqual(
      expect.objectContaining({
        kind: 'manual',
        id: 'service',
        deprecated: true,
      }),
    );
    expect(await rows('manual.deprecated')).toEqual([
      expect.objectContaining({
        key: `${id}/service`,
        payload: expect.objectContaining({
          manualId: 'service',
          replacedBy: 'operating',
        }),
      }),
    ]);
  });
});
