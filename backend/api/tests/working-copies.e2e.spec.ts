import type { Module } from '@openfolia/content-model';
import { sql } from 'drizzle-orm';
import type { Actor } from '../src/access/core/actor.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { MAX_BODY_DEPTH } from '../src/base/api/validation.pipe.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import {
  ManualWorkingCopyDocument,
  ModuleWorkingCopyDocument,
} from '../src/change-sets/api/working-copy.resources.js';
import { newLockId } from '../src/change-sets/core/lock.js';
import { ModuleDocument } from '../src/modules/api/module.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const author: Actor = {
  ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
  id: 'sample-author',
};
const otherAuthor: Actor = { ...author, id: 'sample-other' };
const admin = actorWith(['admin.roles']);

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(async () => {
  if (!t) return; // beforeAll failed: only its error is reported.
  t.actAs(undefined);
  // One lock per subject: each test takes the sample's subjects afresh.
  await t.database.db.execute(sql`delete from working_copies`);
  await t.database.db.execute(sql`delete from locks`);
});

const only = (body: unknown) => {
  const [first, ...rest] = ErrorDocument.parse(body).errors;
  expect(rest).toEqual([]);
  return first;
};

async function changeSet(as: Actor = author): Promise<string> {
  t.actAs(as);
  const res = await t.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title: 'Working copies' } },
    }),
  );
  expect(res.status).toBe(201);
  return ChangeSetDocument.parse(res.body).data.id;
}

async function lock(changeSetId: string, subject: unknown) {
  const res = await t
    .post(`/change-sets/${changeSetId}/locks`)
    .send(JSON.stringify({ data: { type: 'Lock', attributes: { subject } } }));
  expect(res.status).toBe(201);
}

const moduleCopy = (cs: string, id = 'charging', lang = 'en') =>
  `/change-sets/${cs}/modules/${lang}/${id}/working-copy`;
const manualCopy = (cs: string, id = 'operating') =>
  `/change-sets/${cs}/manuals/${id}/working-copy`;

/** A save based on `baseCommit`: by default `main`, where every change set here starts. */
const save = (
  path: string,
  content: unknown,
  version: number,
  baseCommit = t.commits.main,
) =>
  t.put(path).send(
    JSON.stringify({
      data: { type: 'WorkingCopy', attributes: { content } },
      meta: { version, baseCommit },
    }),
  );

const typed = (committed: Module, text: string): Module => ({
  ...committed,
  blocks: [
    { type: 'paragraph', id: 'typed', content: [{ type: 'text', text }] },
  ],
});

const auditCount = async () => {
  t.actAs(admin);
  const res = await t.get('/audit-events?page[size]=1');
  return AuditEventPageDocument.parse(res.body).meta.page.total;
};

describe('module working copies', () => {
  it('saves, reads back and discards, with no commit and no audit event', async () => {
    const cs = await changeSet();
    t.actAs(author);
    await lock(cs, { type: 'module', lang: 'en', moduleId: 'charging' });
    const branch = `change-sets/${cs}`;

    // Nothing saved yet: the committed file, at version 0.
    const initial = await t.get(moduleCopy(cs));
    expect(initial.status).toBe(200);
    expect(initial.headers['content-type']).toBe(JSON_API);
    const committed = ModuleWorkingCopyDocument.parse(initial.body).data;
    expect(committed).toMatchObject({
      type: 'WorkingCopy',
      id: `${cs}/module/en/charging`,
      attributes: {
        subject: { type: 'module', lang: 'en', moduleId: 'charging' },
        version: 0,
        baseCommit: t.commits.main,
      },
      relationships: { changeSet: { data: { type: 'ChangeSet', id: cs } } },
      meta: { saved: false, issues: [] },
    });
    expect(committed.attributes.updatedBy).toBeUndefined();
    const content = committed.attributes.content;

    const events = await auditCount();
    t.actAs(author);
    let version = 0;
    for (let i = 1; i <= 20; i++) {
      const res = await save(
        moduleCopy(cs),
        typed(content, `Draft ${i}.`),
        version,
      );
      expect(res.status).toBe(200);
      const saved = ModuleWorkingCopyDocument.parse(res.body).data;
      expect(saved.meta.saved).toBe(true);
      version = saved.attributes.version;
    }
    expect(version).toBe(20);
    expect(await auditCount()).toBe(events);

    t.actAs(author);
    const read = ModuleWorkingCopyDocument.parse(
      (await t.get(moduleCopy(cs))).body,
    ).data;
    expect(read.attributes).toMatchObject({
      content: typed(content, 'Draft 20.'),
      version: 20,
      baseCommit: t.commits.main,
      updatedBy: { kind: 'user', id: 'sample-author' },
      updatedAt: expect.any(String),
    });

    // The branch is untouched: reads with ?ref= show what is committed.
    const onBranch = await t.get(
      `/modules/en/charging?ref=${encodeURIComponent(branch)}`,
    );
    expect(onBranch.headers['x-ccms-commit']).toBe(t.commits.main);
    expect(ModuleDocument.parse(onBranch.body).data.attributes.blocks).toEqual(
      content.blocks,
    );

    expect((await t.delete(moduleCopy(cs))).status).toBe(204);
    const after = ModuleWorkingCopyDocument.parse(
      (await t.get(moduleCopy(cs))).body,
    ).data;
    expect(after.attributes.version).toBe(0);
    expect(after.attributes.content).toEqual(content);
    const again = await t.delete(moduleCopy(cs));
    expect(again.status).toBe(404);
    expect(only(again.body)?.code).toBe('not-found');
    expect(await auditCount()).toBe(events);
  });

  it('refuses a stale save with the current version', async () => {
    const cs = await changeSet();
    t.actAs(author);
    await lock(cs, { type: 'module', lang: 'en', moduleId: 'charging' });
    const content = ModuleWorkingCopyDocument.parse(
      (await t.get(moduleCopy(cs))).body,
    ).data.attributes.content;
    expect((await save(moduleCopy(cs), typed(content, 'a'), 0)).status).toBe(
      200,
    );
    expect((await save(moduleCopy(cs), typed(content, 'b'), 1)).status).toBe(
      200,
    );
    const stale = await save(moduleCopy(cs), typed(content, 'old tab'), 1);
    expect(stale.status).toBe(409);
    expect(only(stale.body)).toMatchObject({
      code: 'version-conflict',
      meta: { version: 2 },
    });
    const read = ModuleWorkingCopyDocument.parse(
      (await t.get(moduleCopy(cs))).body,
    ).data;
    expect(read.attributes.content).toEqual(typed(content, 'b'));
  });

  it('needs the lock held by this change set', async () => {
    const cs = await changeSet();
    t.actAs(author);
    const content = ModuleWorkingCopyDocument.parse(
      (await t.get(moduleCopy(cs))).body,
    ).data.attributes.content;
    const res = await save(moduleCopy(cs), content, 0);
    expect(res.status).toBe(409);
    expect(only(res.body)?.code).toBe('lock-required');
  });

  it('is its author’s alone', async () => {
    const cs = await changeSet();
    t.actAs(author);
    await lock(cs, { type: 'module', lang: 'en', moduleId: 'charging' });
    t.actAs(otherAuthor);
    for (const res of [
      await t.get(moduleCopy(cs)),
      await t.delete(moduleCopy(cs)),
    ]) {
      expect(res.status).toBe(403);
      expect(only(res.body)?.code).toBe('forbidden');
    }
  });

  it('checks the shape: an invalid tree, a deep one, another subject', async () => {
    const cs = await changeSet();
    t.actAs(author);
    await lock(cs, { type: 'module', lang: 'en', moduleId: 'charging' });
    const content = ModuleWorkingCopyDocument.parse(
      (await t.get(moduleCopy(cs))).body,
    ).data.attributes.content;

    const invalid = await save(
      moduleCopy(cs),
      { ...content, blocks: [{ type: 'paragraph', content: [] }] },
      0,
    );
    expect(invalid.status).toBe(400);
    const error = ErrorDocument.parse(invalid.body).errors[0];
    expect(error).toMatchObject({
      code: 'invalid-body',
      source: {
        pointer: expect.stringMatching(/^\/data\/attributes\/content\/blocks/),
      },
    });

    let deep: unknown = { type: 'text', text: 'x' };
    for (let i = 0; i < MAX_BODY_DEPTH; i++) deep = [deep];
    const tooDeep = await save(moduleCopy(cs), { ...content, blocks: deep }, 0);
    expect(tooDeep.status).toBe(400);
    expect(only(tooDeep.body)?.code).toBe('invalid-body');

    const other = await save(moduleCopy(cs), { ...content, id: 'other' }, 0);
    expect(other.status).toBe(422);
    expect(only(other.body)?.code).toBe('subject-mismatch');

    // Validation issues come back without refusing the draft.
    const draft = await save(
      moduleCopy(cs),
      { ...content, meta: { ...content.meta, type: 'no-such-type' } },
      0,
    );
    expect(draft.status).toBe(200);
    expect(
      ModuleWorkingCopyDocument.parse(draft.body).data.meta.issues.map(
        (i) => i.code,
      ),
    ).toContain('unknown-module-type');
  });

  it('a new module: nothing committed yet', async () => {
    const cs = await changeSet();
    t.actAs(author);
    await lock(cs, { type: 'module', lang: 'en', moduleId: 'brand-new' });
    expect((await t.get(moduleCopy(cs, 'brand-new'))).status).toBe(404);
    const content: Module = {
      schemaVersion: 1,
      id: 'brand-new',
      meta: { title: 'New', type: 'concept', lang: 'en', facets: {} },
      blocks: [],
    };
    const res = await save(moduleCopy(cs, 'brand-new'), content, 0);
    expect(res.status).toBe(200);
    expect(
      ModuleWorkingCopyDocument.parse(
        (await t.get(moduleCopy(cs, 'brand-new'))).body,
      ).data.attributes,
    ).toMatchObject({ version: 1, content });
  });
});

describe('manual working copies', () => {
  it('saves and reads a manifest, and abandoning drops every working copy', async () => {
    const cs = await changeSet();
    t.actAs(author);
    await lock(cs, { type: 'manual', manualId: 'operating' });
    await lock(cs, { type: 'module', lang: 'en', moduleId: 'charging' });
    const initial = ManualWorkingCopyDocument.parse(
      (await t.get(manualCopy(cs))).body,
    ).data;
    expect(initial.attributes.version).toBe(0);
    const manifest = { ...initial.attributes.content, title: 'Renamed' };
    const res = await save(manualCopy(cs), manifest, 0);
    expect(res.status).toBe(200);
    expect(
      ManualWorkingCopyDocument.parse(res.body).data.attributes,
    ).toMatchObject({ version: 1, content: manifest });
    const moduleContent = ModuleWorkingCopyDocument.parse(
      (await t.get(moduleCopy(cs))).body,
    ).data.attributes.content;
    expect((await save(moduleCopy(cs), moduleContent, 0)).status).toBe(200);

    const count = async () =>
      (
        await t.database.db.execute<{ n: number }>(
          sql`select count(*)::int as n from working_copies where change_set_id = ${cs}`,
        )
      ).rows[0]?.n;
    expect(await count()).toBe(2);
    expect((await t.post(`/change-sets/${cs}/abandon`)).status).toBe(200);
    expect(await count()).toBe(0);
    t.actAs(admin);
    const abandoned = AuditEventPageDocument.parse(
      (
        await t.get(
          `/audit-events?filter[subject]=${encodeURIComponent(`change-set/${cs}`)}`,
        )
      ).body,
    ).data[0];
    expect(abandoned?.attributes).toMatchObject({
      action: 'change-set.abandon',
      data: { from: 'draft', to: 'abandoned', workingCopies: 2 },
    });
    // An abandoned change set is no draft: nothing is saved any more.
    t.actAs(author);
    const refused = await save(manualCopy(cs), manifest, 0);
    expect(refused.status).toBe(409);
    expect(only(refused.body)?.code).toBe('invalid-state');
  });

  it('refuses a manifest naming another manual', async () => {
    const cs = await changeSet();
    t.actAs(author);
    await lock(cs, { type: 'manual', manualId: 'operating' });
    const initial = ManualWorkingCopyDocument.parse(
      (await t.get(manualCopy(cs))).body,
    ).data;
    const res = await save(
      manualCopy(cs),
      { ...initial.attributes.content, id: 'other' },
      0,
    );
    expect(res.status).toBe(422);
    expect(only(res.body)?.code).toBe('subject-mismatch');
  });
});

describe('scope', () => {
  const publicEditor: Actor = {
    ...actorWith(['content.read', 'content.read.draft', 'content.edit'], {
      maxAudience: 'public',
    }),
    id: 'sample-public-editor',
  };

  /**
   * A lock the change set holds although acquiring it would be refused
   * now (#121): taken while the editor's scope was wider, or before the
   * branch's content changed. The save checks the scope again.
   */
  const held = async (
    changeSetId: string,
    subject: string,
    type = 'module',
  ) => {
    await t.database.db.execute(
      sql`insert into locks (id, subject_type, subject_id, change_set_id, holder_kind, holder_id, since)
          values (${newLockId()}, ${type}, ${subject}, ${changeSetId}, 'user', ${publicEditor.id}, now())`,
    );
  };

  it('refuses saving over a committed module outside the editor’s scope that they cannot see', async () => {
    const cs = await changeSet(publicEditor);
    t.actAs(publicEditor);
    await held(cs, 'en/internals');
    // Hidden from them: it looks missing.
    expect((await t.get(moduleCopy(cs, 'internals'))).status).toBe(404);
    const content: Module = {
      schemaVersion: 1,
      id: 'internals',
      meta: {
        title: 'Overwritten',
        type: 'concept',
        lang: 'en',
        audience: 'public',
        facets: {},
      },
      blocks: [],
    };
    const res = await save(moduleCopy(cs, 'internals'), content, 0);
    expect(res.status).toBe(403);
    expect(only(res.body)?.code).toBe('forbidden');
    const rows = await t.database.db.execute<{ n: number }>(
      sql`select count(*)::int as n from working_copies where change_set_id = ${cs}`,
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it('answers saving over a hidden module exactly as over a missing one', async () => {
    const cs = await changeSet(publicEditor);
    t.actAs(publicEditor);
    const refusal = async (moduleId: string) => {
      await held(cs, `en/${moduleId}`);
      const res = await save(
        moduleCopy(cs, moduleId),
        {
          schemaVersion: 1,
          id: moduleId,
          meta: {
            title: 'Probe',
            type: 'concept',
            lang: 'en',
            audience: 'public',
            facets: {},
          },
          blocks: [],
        },
        0,
      );
      return { status: res.status, body: res.text };
    };
    const hidden = await refusal('internals');
    expect(hidden.status).toBe(403);
    expect(await refusal('no-such-module')).toEqual(hidden);
  });

  it('refuses saving a manual that names modules the editor cannot see', async () => {
    const cs = await changeSet(publicEditor);
    t.actAs(publicEditor);
    await held(cs, 'operating', 'manual');
    // They read it without `internals`…
    const read = ManualWorkingCopyDocument.parse(
      (await t.get(manualCopy(cs))).body,
    ).data;
    expect(read.meta.issues.map((i) => i.code)).toContain('outside-scope');
    // …so saving what they see back would drop it.
    const res = await save(manualCopy(cs), read.attributes.content, 0);
    expect(res.status).toBe(403);
    expect(only(res.body)?.code).toBe('forbidden');
  });
});
