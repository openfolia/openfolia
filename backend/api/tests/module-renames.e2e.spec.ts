import type { Module } from '@openfolia/content-model';
import { sql } from 'drizzle-orm';
import type { Actor } from '../src/access/core/actor.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ChangeSetChangePageDocument } from '../src/change-sets/api/change.resources.js';
import { CommitDocument } from '../src/change-sets/api/commit.resources.js';
import {
  ModuleReferencesDocument,
  ModuleRenameDocument,
} from '../src/change-sets/api/module-rename.resources.js';
import { ModuleWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import { CommentPageDocument } from '../src/comments/api/comment.resources.js';
import {
  ManualDocument,
  ResolvedManualDocument,
} from '../src/manuals/api/manual.resources.js';
import { ModuleDocument } from '../src/modules/api/module.resources.js';
import { TranslationStatusDocument } from '../src/translations/api/translation-status.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const EDITING = ['content.read', 'content.read.draft', 'content.edit'] as const;
const author: Actor = { ...actorWith(EDITING), id: 'sample-author' };
const admin = actorWith(['admin.roles']);

const mod = (lang: string, moduleId: string) =>
  ({ type: 'module', lang, moduleId }) as const;
const manual = (manualId: string) => ({ type: 'manual', manualId }) as const;

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(async () => {
  if (!t) return; // beforeAll failed: only its error is reported.
  t.actAs(undefined);
  await t.database.db.execute(sql`delete from working_copies`);
  await t.database.db.execute(sql`delete from locks`);
});

const errors = (body: unknown) => ErrorDocument.parse(body).errors;

async function changeSet(as: Actor = author) {
  t.actAs(as);
  const res = await t.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title: 'Rename' } },
    }),
  );
  expect(res.status).toBe(201);
  const { id, attributes } = ChangeSetDocument.parse(res.body).data;
  return { id, branch: attributes.branch, base: attributes.baseCommit };
}

async function lock(cs: string, subject: unknown) {
  const res = await t
    .post(`/change-sets/${cs}/locks`)
    .send(JSON.stringify({ data: { type: 'Lock', attributes: { subject } } }));
  expect([200, 201]).toContain(res.status);
}

const rename = (cs: string, from: string, to: string) =>
  t.post(`/change-sets/${cs}/module-renames`).send(
    JSON.stringify({
      data: { type: 'ModuleRename', attributes: { from, to } },
    }),
  );

const references = (cs: string, id: string) =>
  t.get(`/change-sets/${cs}/module-references/${id}`);

/** Saves `blocks` into the English module's working copy. */
async function save(cs: string, id: string, blocks: Module['blocks']) {
  const path = `/change-sets/${cs}/modules/en/${id}/working-copy`;
  const read = await t.get(path);
  expect(read.status).toBe(200);
  const at = ModuleWorkingCopyDocument.parse(read.body).data.attributes;
  const res = await t.put(path).send(
    JSON.stringify({
      data: {
        type: 'WorkingCopy',
        attributes: { content: { ...(at.content as Module), blocks } },
      },
      meta: { version: at.version, baseCommit: at.baseCommit },
    }),
  );
  expect(res.status).toBe(200);
}

async function commit(cs: string) {
  const res = await t.post(`/change-sets/${cs}/commits`);
  expect(res.status).toBe(201);
  return CommitDocument.parse(res.body).data.id;
}

const at = (branch: string) => `ref=${encodeURIComponent(branch)}`;

async function checkCodes(ref: string) {
  const res = await t.get(`/manuals/operating/checks?${ref}&page[size]=100`);
  expect(res.status).toBe(200);
  return CheckPageDocument.parse(res.body)
    .data.map((c) => c.attributes.code)
    .sort();
}

/** Every lock a rename of `charging` to `battery-charging` needs. */
async function lockAll(cs: string) {
  for (const subject of [
    mod('de', 'charging'),
    mod('en', 'charging'),
    mod('de', 'battery-charging'),
    mod('en', 'battery-charging'),
    manual('operating'),
    manual('service'),
    mod('en', 'safety-note'),
  ]) {
    await lock(cs, subject);
  }
}

describe('POST /change-sets/:changeSetId/module-renames', () => {
  it('moves every language and rewrites the manuals and modules naming it in one commit', async () => {
    const cs = await changeSet();
    // A module naming `charging` by a cross-reference.
    await lock(cs.id, mod('en', 'safety-note'));
    await save(cs.id, 'safety-note', [
      {
        type: 'paragraph',
        id: 'see',
        content: [
          { type: 'text', text: 'See ' },
          { type: 'xref', module: 'charging', block: 'intro' },
        ],
      },
    ]);
    await commit(cs.id);
    const comment = await t.post(`/change-sets/${cs.id}/comments`).send(
      JSON.stringify({
        data: {
          type: 'Comment',
          attributes: {
            body: 'Name it after the battery.',
            subject: mod('en', 'charging'),
            blockId: 'intro',
          },
        },
      }),
    );
    expect(comment.status).toBe(201);
    const before = await checkCodes(at(cs.branch));

    const found = await references(cs.id, 'charging');
    expect(found.status).toBe(200);
    const listed = ModuleReferencesDocument.parse(found.body).data;
    expect(listed.attributes).toEqual({
      languages: ['de', 'en'],
      references: [
        manual('operating'),
        manual('service'),
        mod('en', 'safety-note'),
      ],
      // No German translation of `safety-note` to bring up to date.
      translations: [],
    });
    expect(listed.meta.workingCopies).toEqual([]);

    await lockAll(cs.id);
    const res = await rename(cs.id, 'charging', 'battery-charging');
    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toBe(JSON_API);
    const renamed = ModuleRenameDocument.parse(res.body).data;
    expect(renamed.attributes).toMatchObject({
      from: 'charging',
      to: 'battery-charging',
      languages: ['de', 'en'],
      rewritten: [
        manual('operating'),
        manual('service'),
        mod('en', 'safety-note'),
      ],
    });
    expect(renamed.meta.comments).toBe(1);

    // One commit: the old files gone, the new ones there, the rest rewritten.
    const ref = at(cs.branch);
    expect((await t.get(`/modules/en/charging?${ref}`)).status).toBe(404);
    expect((await t.get(`/modules/de/charging?${ref}`)).status).toBe(404);
    const moved = await t.get(`/modules/en/battery-charging?${ref}`);
    expect(moved.status).toBe(200);
    expect(moved.headers['x-ccms-commit']).toBe(renamed.id);
    expect(ModuleDocument.parse(moved.body).data.attributes.title).toBe(
      'Charging',
    );
    const note = await t.get(`/modules/en/safety-note?${ref}`);
    expect(JSON.stringify(ModuleDocument.parse(note.body).data)).toContain(
      '"module":"battery-charging"',
    );
    expect(JSON.stringify(note.body)).not.toContain('"module":"charging"');

    // The manual resolves under the new ID, and its checks are as before.
    const resolved = await t.get(
      `/manuals/operating/variants/model=large/en?${ref}`,
    );
    expect(resolved.status).toBe(200);
    expect(
      JSON.stringify(ResolvedManualDocument.parse(resolved.body).data),
    ).toContain('The Model A charges automatically.');
    expect(await checkCodes(ref)).toEqual(before);

    // The translation record moved with it.
    const status = await t.get(
      `/translations/status/de/battery-charging?${ref}`,
    );
    expect(status.status).toBe(200);
    expect(
      TranslationStatusDocument.parse(status.body).data.meta.sourceCommit,
    ).not.toBeNull();

    // Two histories (#88): the new ID's starts at the rename, the old ID's ends in its removal.
    const historyOf = async (id: string) => {
      const res = await t.get(`/modules/en/${id}/history?${ref}`);
      expect(res.status).toBe(200);
      return (
        res.body as {
          data: { attributes: { commit: string }; meta: { change: string } }[];
        }
      ).data.map((v) => [v.attributes.commit, v.meta.change]);
    };
    expect(await historyOf('battery-charging')).toEqual([
      [renamed.id, 'added'],
    ]);
    expect((await historyOf('charging'))[0]).toEqual([renamed.id, 'removed']);

    // The comment follows the module.
    const comments = await t.get(
      `/change-sets/${cs.id}/comments?filter[module]=en/battery-charging`,
    );
    expect(
      CommentPageDocument.parse(comments.body).data.map(
        (c) => c.attributes.body,
      ),
    ).toEqual(['Name it after the battery.']);

    // The review lists the old module removed and the new one added.
    const changes = await t.get(`/change-sets/${cs.id}/changes`);
    expect(
      ChangeSetChangePageDocument.parse(changes.body).data.map((c) => c.id),
    ).toEqual(
      expect.arrayContaining([
        'module/en/battery-charging',
        'module/en/charging',
        'module/de/battery-charging',
        'module/de/charging',
        'manual/operating',
      ]),
    );

    t.actAs(admin);
    const audited = await t.get(
      '/audit-events?filter[action]=module.rename&page[size]=50',
    );
    const events = AuditEventPageDocument.parse(audited.body).data.filter(
      (e) => e.attributes.data?.['changeSetId'] === cs.id,
    );
    expect(
      events
        .map((e) => e.attributes.subject)
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    ).toEqual([
      { type: 'module', id: 'de/charging' },
      { type: 'module', id: 'en/charging' },
    ]);
    expect(events[0]?.attributes.data).toMatchObject({
      commit: renamed.id,
      from: 'charging',
      to: 'battery-charging',
      rewritten: 3,
    });
  });

  it('answers each refusal with its code', async () => {
    const cs = await changeSet();
    const codes = async (res: Awaited<ReturnType<typeof rename>>) => ({
      status: res.status,
      code: errors(res.body)[0]?.code,
      meta: errors(res.body)[0]?.meta,
    });
    expect(await codes(await rename(cs.id, 'charging', 'Not An ID'))).toEqual({
      status: 422,
      code: 'invalid-id',
      meta: { member: 'to' },
    });
    expect(await codes(await rename(cs.id, 'charging', 'charging'))).toEqual({
      status: 422,
      code: 'invalid-id',
      meta: { member: 'to' },
    });
    expect(await codes(await rename(cs.id, 'charging', 'internals'))).toEqual({
      status: 409,
      code: 'id-taken',
      meta: { moduleId: 'internals' },
    });
    expect(
      await codes(await rename(cs.id, 'nope', 'still-nope')),
    ).toMatchObject({ status: 404, code: 'not-found' });
    expect((await references(cs.id, 'nope')).status).toBe(404);
    expect(
      await codes(await rename(cs.id, 'charging', 'battery-charging')),
    ).toEqual({
      status: 409,
      code: 'lock-required',
      meta: { subject: mod('de', 'charging') },
    });

    // A working copy of the module: commit or discard it first.
    await lockAll(cs.id);
    await save(cs.id, 'charging', [
      {
        type: 'paragraph',
        id: 'typed',
        content: [{ type: 'text', text: 'Typed.' }],
      },
    ]);
    expect(
      await codes(await rename(cs.id, 'charging', 'battery-charging')),
    ).toEqual({
      status: 409,
      code: 'uncommitted-working-copies',
      meta: { subjects: [mod('en', 'charging')] },
    });
    const listed = await references(cs.id, 'charging');
    expect(
      ModuleReferencesDocument.parse(listed.body).data.meta.workingCopies,
    ).toEqual([mod('en', 'charging')]);
  });

  it('gives one 403 for anything outside the actor’s scope, whatever it is', async () => {
    // Public audiences only: the service manual naming the module is internal.
    const publicOnly: Actor = {
      ...actorWith(EDITING, { maxAudience: 'public' }),
      id: 'sample-public',
    };
    // English only: the module has a German file.
    const english: Actor = {
      ...actorWith(EDITING, { languages: ['en'] }),
      id: 'sample-english',
    };
    const bodies = [];
    for (const actor of [publicOnly, english]) {
      const cs = await changeSet(actor);
      const res = await rename(cs.id, 'charging', 'battery-charging');
      expect(res.status).toBe(403);
      bodies.push(errors(res.body));
      expect((await references(cs.id, 'charging')).status).toBe(403);
    }
    expect(bodies[0]).toEqual(bodies[1]);
  });
});

describe('POST /change-sets/:changeSetId/module-renames, replacements (#360)', () => {
  /** Changes `subject`'s working copy content with `change`. */
  async function edit(
    cs: string,
    subject: ReturnType<typeof mod> | ReturnType<typeof manual>,
    change: (content: Record<string, unknown>) => Record<string, unknown>,
  ) {
    const path =
      subject.type === 'module'
        ? `/change-sets/${cs}/modules/${subject.lang}/${subject.moduleId}/working-copy`
        : `/change-sets/${cs}/manuals/${subject.manualId}/working-copy`;
    const read = await t.get(path);
    expect(read.status).toBe(200);
    const at = (
      read.body as {
        data: {
          attributes: {
            content: Record<string, unknown>;
            version: number;
            baseCommit: string;
          };
        };
      }
    ).data.attributes;
    const res = await t.put(path).send(
      JSON.stringify({
        data: {
          type: 'WorkingCopy',
          attributes: { content: change(at.content) },
        },
        meta: { version: at.version, baseCommit: at.baseCommit },
      }),
    );
    expect(res.status).toBe(200);
  }

  async function changeSetCheckCodes(cs: string) {
    const res = await t.get(`/change-sets/${cs}/checks?page[size]=100`);
    expect(res.status).toBe(200);
    return CheckPageDocument.parse(res.body).data.map((c) => c.attributes.code);
  }

  it('rewrites the replacedBy of a module deprecated in favour of it, listed and locked with the rest', async () => {
    const cs = await changeSet();
    // A module deprecated in favour of `charging`, and a manual including
    // it that is deprecated in favour of another manual.
    await lock(cs.id, mod('en', 'safety-note'));
    await edit(cs.id, mod('en', 'safety-note'), (content) => ({
      ...content,
      meta: {
        ...(content['meta'] as object),
        deprecated: { reason: 'Superseded.', replacedBy: 'charging' },
      },
    }));
    await lock(cs.id, manual('service'));
    await edit(cs.id, manual('service'), (content) => ({
      ...content,
      deprecated: { reason: 'Merged.', replacedBy: 'operating' },
    }));
    await commit(cs.id);
    expect(await changeSetCheckCodes(cs.id)).not.toContain(
      'unknown-replacement',
    );

    const found = await references(cs.id, 'charging');
    expect(found.status).toBe(200);
    expect(
      ModuleReferencesDocument.parse(found.body).data.attributes.references,
    ).toEqual([
      manual('operating'),
      manual('service'),
      mod('en', 'safety-note'),
    ]);

    // Its lock is needed like any file's the rename rewrites.
    await t.database.db.execute(sql`delete from locks`);
    for (const subject of [
      mod('de', 'charging'),
      mod('en', 'charging'),
      mod('de', 'battery-charging'),
      mod('en', 'battery-charging'),
      manual('operating'),
      manual('service'),
    ]) {
      await lock(cs.id, subject);
    }
    const refused = await rename(cs.id, 'charging', 'battery-charging');
    expect(refused.status).toBe(409);
    expect(errors(refused.body)[0]).toMatchObject({
      code: 'lock-required',
      meta: { subject: mod('en', 'safety-note') },
    });

    await lock(cs.id, mod('en', 'safety-note'));
    const res = await rename(cs.id, 'charging', 'battery-charging');
    expect(res.status).toBe(201);
    expect(
      ModuleRenameDocument.parse(res.body).data.attributes.rewritten,
    ).toEqual([
      manual('operating'),
      manual('service'),
      mod('en', 'safety-note'),
    ]);

    const ref = at(cs.branch);
    const note = await t.get(`/modules/en/safety-note?${ref}`);
    expect(note.status).toBe(200);
    expect(ModuleDocument.parse(note.body).data.attributes.deprecated).toEqual({
      reason: 'Superseded.',
      replacedBy: 'battery-charging',
    });
    const service = await t.get(`/manuals/service?${ref}`);
    expect(
      ManualDocument.parse(service.body).data.attributes.deprecated,
    ).toEqual({ reason: 'Merged.', replacedBy: 'operating' });
    expect(await changeSetCheckCodes(cs.id)).not.toContain(
      'unknown-replacement',
    );
  });
});
