import { execFileSync } from 'node:child_process';
import {
  parseConfig,
  printConfig,
  type ProjectConfig,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import { addSamplePageDesigns } from '@openfolia/content-repo/testing';
import { sql } from 'drizzle-orm';
import type { Actor } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import {
  ConfigWorkingCopyDocument,
  ManualWorkingCopyDocument,
} from '../src/change-sets/api/working-copy.resources.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { MergeDocument } from '../src/change-sets/api/workflow.resources.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import {
  ManualDocument,
  ManualPageDocument,
} from '../src/manuals/api/manual.resources.js';
import { ReleaseOutputPageDocument } from '../src/releases/api/release-output.resources.js';
import { ReleaseDocument } from '../src/releases/api/release.resources.js';
import { actorWith, READER } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

// Two releases of a product, nine PDFs each: slower than most.
vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

/**
 * #589: which page design a manual is printed with (`meta.design` of a manual and of a release's
 * output), from a new default merged through a change set to the next release's PDF, and the
 * check that tells of a design that is not there. Main is this file's alone (its own test app).
 */
const READS: Permission[] = ['content.read', 'content.read.draft'];
const user = (id: string, permissions: Permission[]): Actor => ({
  ...actorWith([...READS, ...permissions], {}),
  id,
});
const admin = user('sample-admin', ['content.edit', 'admin.roles']);
const reviewer = user('sample-reviewer', ['content.review']);
const publisher = user('sample-publisher', ['release.publish']);

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const json = (body: unknown) => JSON.stringify(body);

beforeAll(async () => {
  t = await createTestApp();
  // `classic` and `minimal` on main; the configuration names none.
  await addSamplePageDesigns(dir());
  const actors = [reviewer, publisher];
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

const manual = async (id: string, query = '', as: Actor = READER) => {
  t.actAs(as);
  const res = await t.get(`/manuals/${id}${query}`);
  expect(res.status).toBe(200);
  return ManualDocument.parse(res.body).data;
};

const cut = async (revision: string) => {
  // Tags are ordered by their date, to the second.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  t.actAs(publisher);
  const res = await t.post('/releases').send(
    json({
      data: { type: 'Release', attributes: { product: 'north', revision } },
    }),
  );
  expect(res.status).toBe(201);
  const release = ReleaseDocument.parse(res.body).data;
  await t.runJobs();
  return release;
};

const outputs = async (releaseId: string) => {
  t.actAs(READER);
  const res = await t.get(`/releases/${releaseId}/outputs?page[size]=50`);
  expect(res.status).toBe(200);
  return ReleaseOutputPageDocument.parse(res.body).data;
};

/** The bytes of the release's PDF of the operating manual, large model, in English. */
const operatingPdf = async (releaseId: string): Promise<Buffer> => {
  const output = (await outputs(releaseId)).find(
    (o) =>
      o.attributes.manual === 'operating' &&
      o.attributes.variant === 'model=large' &&
      o.attributes.lang === 'en',
  );
  expect(output?.attributes.state).toBe('done');
  t.actAs(READER);
  const res = await t
    .get(output?.links.file as string)
    .buffer(true)
    .parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on('data', (chunk: Buffer) => chunks.push(chunk));
      r.on('end', () => done(null, Buffer.concat(chunks)));
    });
  expect(res.status).toBe(200);
  return res.body as Buffer;
};

/** Makes `design` the project's default through a change set: saved, reviewed and merged. */
async function mergeDefault(design: string): Promise<void> {
  t.actAs(admin);
  const created = await t
    .post('/change-sets')
    .send(
      json({ data: { type: 'ChangeSet', attributes: { title: 'Default' } } }),
    );
  expect(created.status).toBe(201);
  const id = ChangeSetDocument.parse(created.body).data.id;
  const locked = await t.post(`/change-sets/${id}/locks`).send(
    json({
      data: { type: 'Lock', attributes: { subject: { type: 'config' } } },
    }),
  );
  expect(locked.status).toBe(201);
  const path = `/change-sets/${id}/config/working-copy`;
  const read = ConfigWorkingCopyDocument.parse((await t.get(path)).body).data
    .attributes;
  const config = read.content as ProjectConfig;
  const saved = await t.put(path).send(
    json({
      data: {
        type: 'WorkingCopy',
        attributes: { content: { ...config, pdf: { ...config.pdf, design } } },
      },
      meta: { version: read.version, baseCommit: read.baseCommit },
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
  expect(MergeDocument.parse(merged.body).data.attributes.state).toBe('merged');
}

describe('the page design a manual is printed with (#589)', () => {
  it('follows a default merged through a change set into the next release and its PDF', async () => {
    expect((await manual('operating')).meta.design).toEqual({
      id: 'builtin',
      name: null,
      source: 'builtin',
      missing: false,
    });
    const before = await cut('1.0');
    const plain = await outputs(before.id);
    expect(plain.length).toBeGreaterThan(0);
    for (const o of plain) {
      expect(o.meta.design).toMatchObject({ id: 'builtin', source: 'builtin' });
    }
    const plainPdf = await operatingPdf(before.id);

    await mergeDefault('classic');
    const classic = {
      id: 'classic',
      name: 'Classic',
      source: 'project',
      missing: false,
    };
    expect((await manual('operating')).meta.design).toEqual(classic);
    // The list says the same of every manual.
    t.actAs(READER);
    const list = ManualPageDocument.parse((await t.get('/manuals')).body);
    for (const m of list.data) {
      if ('attributes' in m) expect(m.meta.design).toEqual(classic);
    }

    const after = await cut('1.1');
    const designed = await outputs(after.id);
    expect(designed.map((o) => o.meta.design)).toEqual(
      designed.map(() => classic),
    );
    const designedPdf = await operatingPdf(after.id);
    expect(designedPdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(designedPdf.equals(plainPdf)).toBe(false);
    // The earlier release still names the design it was printed with: its tag's.
    expect((await outputs(before.id))[0]?.meta.design?.id).toBe('builtin');
  });

  it('tells of a design that is not in the content: in `meta.design` and as a blocking check', async () => {
    const config = parseConfig(git('show', 'main:openfolia.yaml'));
    git('branch', 'gone-default', 'main');
    await new GitWriter(dir()).commit({
      branch: 'gone-default',
      parent: git('rev-parse', 'refs/heads/main'),
      changes: [
        {
          path: 'openfolia.yaml',
          content: printConfig({
            ...config,
            pdf: { ...config.pdf, design: 'gone' },
          }),
        },
      ],
      message: 'A default design that is not there',
      author: { name: 'Someone', email: 'someone@example.com' },
    });
    expect(
      (await manual('operating', '?ref=gone-default', admin)).meta.design,
    ).toEqual({ id: 'gone', name: null, source: 'project', missing: true });

    // A branch is read by a reader of drafts.
    t.actAs(admin);
    const res = await t.get('/manuals/operating/checks?ref=gone-default');
    expect(res.status).toBe(200);
    const found = CheckPageDocument.parse(res.body)
      .data.map((c) => c.attributes)
      .filter((c) => c.code === 'unknown-page-design');
    expect(found.map((c) => [c.severity, c.params])).toEqual([
      ['blocking', { design: 'gone', from: 'config' }],
    ]);
    // Main names a design that is there: no such check.
    const onMain = await t.get('/manuals/operating/checks');
    expect(
      CheckPageDocument.parse(onMain.body).data.map((c) => c.attributes.code),
    ).not.toContain('unknown-page-design');
  });
});

describe('deleting a page design in use (#554)', () => {
  it('is refused with 409 design-in-use while a manual names it, and done once none does', async () => {
    t.actAs(admin);
    const created = await t.post('/change-sets').send(
      json({
        data: { type: 'ChangeSet', attributes: { title: 'Drop a design' } },
      }),
    );
    expect(created.status).toBe(201);
    const { id, attributes } = ChangeSetDocument.parse(created.body).data;
    const lock = async (subject: Record<string, string>) =>
      expect(
        (
          await t
            .post(`/change-sets/${id}/locks`)
            .send(json({ data: { type: 'Lock', attributes: { subject } } }))
        ).status,
      ).toBe(201);
    await lock({ type: 'design', designId: 'minimal' });
    await lock({ type: 'manual', manualId: 'operating' });
    const path = `/change-sets/${id}/manuals/operating/working-copy`;
    /** Saves the manual naming `design` (none: no design of its own) and commits it. */
    const save = async (design: string | undefined) => {
      const read = ManualWorkingCopyDocument.parse((await t.get(path)).body)
        .data.attributes;
      const { design: _was, ...rest } = read.content as Record<string, unknown>;
      void _was;
      const saved = await t.put(path).send(
        json({
          data: {
            type: 'WorkingCopy',
            attributes: {
              content: { ...rest, ...(design !== undefined && { design }) },
            },
          },
          meta: { version: read.version, baseCommit: read.baseCommit },
        }),
      );
      expect(saved.status).toBe(200);
      expect((await t.post(`/change-sets/${id}/commits`)).status).toBe(201);
    };
    await save('minimal');

    const deleting = () =>
      t.post(`/change-sets/${id}/commits`).send(
        json({
          data: {
            type: 'Commit',
            attributes: { deletes: [{ type: 'design', designId: 'minimal' }] },
          },
        }),
      );
    const refused = await deleting();
    expect(refused.status).toBe(409);
    const [error] = ErrorDocument.parse(refused.body).errors;
    expect(error).toMatchObject({
      status: '409',
      code: 'design-in-use',
      meta: {
        designs: ['minimal'],
        usedIn: [{ in: 'manual', design: 'minimal', manual: 'operating' }],
      },
    });
    expect(git('show', `${attributes.branch}:design/minimal.yaml`)).toContain(
      'Minimal',
    );

    // The manual names none any more: the design goes.
    await save(undefined);
    expect((await deleting()).status).toBe(201);
    expect(() =>
      git('show', `${attributes.branch}:design/minimal.yaml`),
    ).toThrow();
  });
});
