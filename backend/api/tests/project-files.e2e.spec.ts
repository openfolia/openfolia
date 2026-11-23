import { execFileSync } from 'node:child_process';
import type { ProjectConfig } from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import { sql } from 'drizzle-orm';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetChangePageDocument } from '../src/change-sets/api/change.resources.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import {
  ConfigWorkingCopyDocument,
  TermWorkingCopyDocument,
} from '../src/change-sets/api/working-copy.resources.js';
import {
  MergeDocument,
  ReviewDocument,
} from '../src/change-sets/api/workflow.resources.js';
import { VariantAttributePageDocument } from '../src/variants/api/variant.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const READS: Permission[] = ['content.read', 'content.read.draft'];
const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith([...READS, ...permissions], scope), id });

/** Edits everything and administers roles: may change the configuration. */
const admin = user('sample-admin', ['content.edit', 'admin.roles']);
/** Edits everything, but holds no `admin.roles`. */
const editor = user('sample-author', ['content.edit']);
/** Administers roles, but edits only German. */
const narrowAdmin = user('sample-narrow', ['admin.roles', 'content.edit'], {
  languages: ['de'],
});
/** Edits German only. */
const german = user('sample-german', ['content.edit'], { languages: ['de'] });
const reviewer = user('sample-reviewer', ['content.review']);
const approver = user('sample-approver', ['content.approve'], {
  moduleTypes: ['procedure'],
});
const publisher = user('sample-publisher', ['release.publish']);

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const errors = (body: unknown) => ErrorDocument.parse(body).errors;

beforeAll(async () => {
  t = await createTestApp();
  // Procedures are a restricted type here: a configuration change needs
  // every sign-off there is.
  const config = git('show', 'main:openfolia.yaml').replace(
    '{ id: procedure, label: Procedure }',
    '{ id: procedure, label: Procedure, restricted: true }',
  );
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: [{ path: 'openfolia.yaml', content: `${config}\n` }],
    message: 'Restrict procedures',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
  const actors = [reviewer, approver, publisher];
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
});
afterAll(() => t?.close());
afterEach(async () => {
  if (!t) return;
  t.actAs(undefined);
  await t.database.db.execute(sql`delete from locks`);
});

const json = (body: unknown) => JSON.stringify(body);

async function changeSet(actor: Actor): Promise<string> {
  t.actAs(actor);
  const created = await t.post('/change-sets').send(
    json({
      data: { type: 'ChangeSet', attributes: { title: 'Project files' } },
    }),
  );
  expect(created.status).toBe(201);
  return ChangeSetDocument.parse(created.body).data.id;
}

const lock = (id: string, subject: unknown) =>
  t
    .post(`/change-sets/${id}/locks`)
    .send(json({ data: { type: 'Lock', attributes: { subject } } }));

const configPath = (id: string) => `/change-sets/${id}/config/working-copy`;
const termPath = (id: string, termId: string) =>
  `/change-sets/${id}/terms/${termId}/working-copy`;

async function readConfig(id: string) {
  const read = await t.get(configPath(id));
  expect(read.status).toBe(200);
  return ConfigWorkingCopyDocument.parse(read.body).data.attributes;
}

const putCopy = (
  path: string,
  content: unknown,
  meta: { version: number; baseCommit: string },
) =>
  t
    .put(path)
    .send(
      json({ data: { type: 'WorkingCopy', attributes: { content } }, meta }),
    );

/** The configuration with the `model` attribute's values replaced. */
function withModelValues(
  config: ProjectConfig,
  values: { id: string; label: string; archived?: boolean }[],
): ProjectConfig {
  return {
    ...config,
    variantAttributes: config.variantAttributes.map((a) =>
      a.id === 'model' && a.kind === 'enum' ? { ...a, values } : a,
    ),
  };
}

const transition = (id: string, name: string) =>
  t.post(`/change-sets/${id}/${name}`).send('');

describe('the configuration as a change-set subject', () => {
  it('is changed in a change set, reviewed with every sign-off and merged', async () => {
    const id = await changeSet(admin);
    expect((await lock(id, { type: 'config' })).status).toBe(201);

    const read = await readConfig(id);
    expect(read).toMatchObject({ version: 0, subject: { type: 'config' } });
    const saved = await putCopy(
      configPath(id),
      withModelValues(read.content as ProjectConfig, [
        { id: 'small', label: 'Compact' },
        { id: 'large', label: 'Large' },
      ]),
      { version: 0, baseCommit: read.baseCommit },
    );
    expect(saved.status).toBe(200);
    const copy = ConfigWorkingCopyDocument.parse(saved.body).data;
    expect(copy.id).toBe(`${id}/config`);
    expect(copy.attributes.version).toBe(1);

    const committed = await t.post(`/change-sets/${id}/commits`);
    expect(committed.status).toBe(201);
    const branch = `change-sets/${id}`;
    expect(git('show', `${branch}:openfolia.yaml`)).toContain('label: Compact');

    const changes = await t.get(`/change-sets/${id}/changes`);
    expect(changes.status).toBe(200);
    const page = ChangeSetChangePageDocument.parse(changes.body);
    expect(page.data.map((c) => [c.id, c.meta.change, c.meta.fields])).toEqual([
      ['config', 'changed', ['variantAttributes/model']],
    ]);

    expect((await transition(id, 'submit')).status).toBe(200);
    t.actAs(reviewer);
    const reviewed = await transition(id, 'approve');
    expect(reviewed.status).toBe(200);
    expect(ReviewDocument.parse(reviewed.body).meta.review).toMatchObject({
      required: ['review', 'sign-off/procedure'],
      pending: ['sign-off/procedure'],
    });
    t.actAs(approver);
    expect((await transition(id, 'sign-off')).status).toBe(200);
    t.actAs(publisher);
    const merged = await transition(id, 'merge');
    expect(merged.status).toBe(200);
    expect(MergeDocument.parse(merged.body).data.attributes.state).toBe(
      'merged',
    );

    t.actAs(editor);
    const variants = await t.get('/variants');
    const model = VariantAttributePageDocument.parse(variants.body).data.find(
      (a) => a.id === 'model',
    );
    expect(model?.attributes).toMatchObject({
      values: [
        { id: 'small', label: 'Compact' },
        { id: 'large', label: 'Large' },
      ],
    });
  });

  it('refuses removing a value still in use, with the usages; archiving it is accepted', async () => {
    const id = await changeSet(admin);
    expect((await lock(id, { type: 'config' })).status).toBe(201);
    const read = await readConfig(id);
    const config = read.content as ProjectConfig;

    const removed = await putCopy(
      configPath(id),
      withModelValues(config, [{ id: 'small', label: 'Small' }]),
      { version: 0, baseCommit: read.baseCommit },
    );
    expect(removed.status).toBe(422);
    const usages = errors(removed.body);
    expect(usages.every((e) => e.code === 'config-in-use')).toBe(true);
    // The operating manual ships a large variant and names it in a condition.
    expect(usages.map((e) => [e.source?.pointer, e.meta?.['issue']])).toEqual(
      expect.arrayContaining([
        ['/manual/operating/blocks/variant 2', 'unknown-variant-value'],
        ['/manual/operating/blocks/product-name', 'unknown-variant-value'],
        ['/manual/service/blocks/variant 1', 'unknown-variant-value'],
      ]),
    );

    const archived = await putCopy(
      configPath(id),
      withModelValues(config, [
        { id: 'small', label: 'Small' },
        { id: 'large', label: 'Large', archived: true },
      ]),
      { version: 0, baseCommit: read.baseCommit },
    );
    expect(archived.status).toBe(200);
    expect((await t.post(`/change-sets/${id}/commits`)).status).toBe(201);
    expect(git('show', `change-sets/${id}:openfolia.yaml`)).toContain(
      'archived: true',
    );
    const variants = await t.get(`/variants?ref=change-sets/${id}`);
    const model = VariantAttributePageDocument.parse(variants.body).data.find(
      (a) => a.id === 'model',
    );
    expect(model?.attributes).toMatchObject({
      values: [
        { id: 'small', label: 'Small' },
        { id: 'large', label: 'Large', archived: true },
      ],
    });
  });

  it('is changed only with `content.edit` everywhere and `admin.roles`', async () => {
    for (const actor of [editor, narrowAdmin]) {
      const id = await changeSet(actor);
      const locked = await lock(id, { type: 'config' });
      expect(locked.status).toBe(403);
      expect(errors(locked.body)[0]?.code).toBe('forbidden');
      const read = await readConfig(id);
      const saved = await putCopy(configPath(id), read.content, {
        version: 0,
        baseCommit: read.baseCommit,
      });
      expect(saved.status).toBe(403);
    }
  });

  it('refuses unknown members and is never deleted', async () => {
    const id = await changeSet(admin);
    expect((await lock(id, { type: 'config' })).status).toBe(201);
    const read = await readConfig(id);
    const config = read.content as ProjectConfig;
    const unknown = await putCopy(
      configPath(id),
      {
        ...config,
        audiences: config.audiences.map((a) => ({ ...a, colour: 'red' })),
      },
      { version: 0, baseCommit: read.baseCommit },
    );
    expect(unknown.status).toBe(400);
    const deleted = await t.post(`/change-sets/${id}/commits`).send(
      json({
        data: {
          type: 'Commit',
          attributes: { deletes: [{ type: 'config' }] },
        },
      }),
    );
    expect(deleted.status).toBe(422);
    expect(errors(deleted.body)[0]?.code).toBe('not-deletable');
  });
});

describe('terms as change-set subjects', () => {
  const term = (languages: Record<string, unknown>) => ({
    schemaVersion: 1,
    id: 'charger',
    status: 'approved',
    languages,
  });

  it('are locked, saved, committed and listed as changes', async () => {
    const id = await changeSet(editor);
    const subject = { type: 'term', termId: 'charger' };
    expect((await lock(id, subject)).status).toBe(201);
    expect((await t.get(termPath(id, 'charger'))).status).toBe(404);
    const base = ChangeSetDocument.parse(
      (await t.get(`/change-sets/${id}`)).body,
    ).data.attributes.baseCommit;
    const saved = await putCopy(
      termPath(id, 'charger'),
      term({
        en: { preferred: 'charger', forbidden: [{ term: 'loader' }] },
        de: { preferred: 'Ladegerät' },
      }),
      { version: 0, baseCommit: base },
    );
    expect(saved.status).toBe(200);
    expect(TermWorkingCopyDocument.parse(saved.body).data.meta.issues).toEqual(
      [],
    );
    // The path names the term: content naming another is refused.
    const other = await putCopy(
      termPath(id, 'charger'),
      { ...term({ en: { preferred: 'x' } }), id: 'other' },
      { version: 1, baseCommit: base },
    );
    expect(other.status).toBe(422);
    expect(errors(other.body)[0]?.code).toBe('subject-mismatch');

    expect((await t.post(`/change-sets/${id}/commits`)).status).toBe(201);
    expect(git('show', `change-sets/${id}:terms/charger.yaml`)).toBe(
      [
        'schemaVersion: 1',
        'status: approved',
        'languages:',
        '  de:',
        '    preferred: Ladegerät',
        '  en:',
        '    preferred: charger',
        '    forbidden:',
        '      - term: loader',
      ].join('\n'),
    );
    const read = await t.get(termPath(id, 'charger'));
    expect(read.status).toBe(200);
    expect(
      TermWorkingCopyDocument.parse(read.body).data.attributes,
    ).toMatchObject({
      version: 0,
      content: { id: 'charger', status: 'approved' },
    });
    const changes = ChangeSetChangePageDocument.parse(
      (await t.get(`/change-sets/${id}/changes`)).body,
    );
    expect(changes.data.map((c) => [c.id, c.meta.change])).toEqual([
      ['term/charger', 'added'],
    ]);
  });

  it('are changed only in the languages the editor edits', async () => {
    const id = await changeSet(german);
    expect((await lock(id, { type: 'term', termId: 'battery' })).status).toBe(
      201,
    );
    const base = ChangeSetDocument.parse(
      (await t.get(`/change-sets/${id}`)).body,
    ).data.attributes.baseCommit;
    const outside = await putCopy(
      termPath(id, 'battery'),
      { ...term({ en: { preferred: 'battery' } }), id: 'battery' },
      { version: 0, baseCommit: base },
    );
    expect(outside.status).toBe(403);
    const inside = await putCopy(
      termPath(id, 'battery'),
      { ...term({ de: { preferred: 'Akku' } }), id: 'battery' },
      { version: 0, baseCommit: base },
    );
    expect(inside.status).toBe(200);
    // A language outside what the editor edits is refused, configured or not.
    const unknown = await putCopy(
      termPath(id, 'battery'),
      {
        ...term({ de: { preferred: 'Akku' }, it: { preferred: 'x' } }),
        id: 'battery',
      },
      { version: 1, baseCommit: base },
    );
    expect(unknown.status).toBe(403);
  });
});
