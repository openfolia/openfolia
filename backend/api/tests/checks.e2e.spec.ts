import { execFileSync } from 'node:child_process';
import {
  parseModule,
  printModule,
  type Module,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
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
const publicReviewer = user(
  'public-reviewer',
  ['content.read', 'content.read.draft'],
  { maxAudience: 'public' },
);

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const keys = (doc: ReturnType<typeof CheckPageDocument.parse>) =>
  doc.data.map(({ attributes: a }) =>
    [
      a.code,
      a.subject.type === 'module'
        ? `${a.subject.lang}/${a.subject.moduleId}`
        : a.subject.type === 'design'
          ? `design/${a.subject.designId}`
          : a.subject.manualId,
      a.blockId ?? '-',
    ].join(' '),
  );

/** A change set by `author` whose head breaks `charging`: an image not stored, a reference to nothing. */
async function brokenChangeSet(): Promise<string> {
  t.actAs(author);
  const created = await t.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title: 'Broken charging' } },
    }),
  );
  expect(created.status).toBe(201);
  const { id, attributes } = ChangeSetDocument.parse(created.body).data;
  const charging = parseModule(git('show', 'main:modules/en/charging.adoc'), {
    id: 'charging',
  });
  const broken: Module = {
    ...charging,
    blocks: [
      ...charging.blocks,
      {
        type: 'image',
        id: 'unstored',
        asset: `sha256:${'d'.repeat(64)}`,
        alt: 'Not stored',
      },
      { type: 'moduleRef', id: 'dangling', module: 'no-such-module' },
    ],
  };
  await new GitWriter(dir()).commit({
    branch: attributes.branch,
    parent: git('rev-parse', `refs/heads/${attributes.branch}`),
    changes: [
      { path: 'modules/en/charging.adoc', content: printModule(broken) },
    ],
    message: 'Broken charging',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
  return id;
}

/**
 * A change set by `author` whose head closes a module reference cycle: `charging` already
 * includes `safety-note`, and `safety-note` now includes `charging`.
 */
async function cycleChangeSet(): Promise<{ id: string; branch: string }> {
  t.actAs(author);
  const created = await t.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title: 'Cycle' } },
    }),
  );
  expect(created.status).toBe(201);
  const { id, attributes } = ChangeSetDocument.parse(created.body).data;
  const note = parseModule(git('show', 'main:modules/en/safety-note.adoc'), {
    id: 'safety-note',
  });
  const looped: Module = {
    ...note,
    blocks: [
      ...note.blocks,
      { type: 'moduleRef', id: 'back', module: 'charging' },
    ],
  };
  await new GitWriter(dir()).commit({
    branch: attributes.branch,
    parent: git('rev-parse', `refs/heads/${attributes.branch}`),
    changes: [
      { path: 'modules/en/safety-note.adoc', content: printModule(looped) },
    ],
    message: 'Cycle',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
  return { id, branch: attributes.branch };
}

describe('GET /manuals/:id/checks', () => {
  it('lists the blocking issues and warnings of a broken manual, paged', async () => {
    t.actAs(reviewer);
    const res = await t.get('/manuals/operating/checks?ref=draft');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.api+json');
    expect(res.headers['x-ccms-commit']).toBe(
      git('rev-parse', 'refs/heads/draft'),
    );
    expect(res.headers['cache-control']).toBe('private, no-cache');
    const doc = CheckPageDocument.parse(res.body);
    const found = keys(doc);
    expect(found).toEqual(
      expect.arrayContaining([
        'unknown-variant-attribute operating -',
        'invalid-module en/broken -',
        'above-audience en/internals -',
        'missing-variant-attribute operating -',
        'missing-translation en/safety-note -',
      ]),
    );
    expect(doc.meta.commit).toBe(git('rev-parse', 'refs/heads/draft'));
    expect(doc.meta.counts.blocking).toBeGreaterThan(0);
    expect(doc.meta.counts.blocking + doc.meta.counts.warning).toBe(
      doc.meta.page.total,
    );
    const invalid = doc.data.find(
      (c) => c.attributes.code === 'invalid-module',
    );
    expect(invalid?.attributes).toMatchObject({
      severity: 'blocking',
      category: 'validation',
      blockId: null,
    });
    // A file that cannot be read has no title; a module that can, its own.
    expect(invalid?.meta.title).toBeNull();
    const translation = doc.data.find(
      (c) => c.attributes.code === 'missing-translation',
    );
    expect(translation?.meta.title).toEqual(expect.any(String));

    const warnings = CheckPageDocument.parse(
      (
        await t.get(
          '/manuals/operating/checks?ref=draft&filter[severity]=warning&page[size]=1',
        )
      ).body,
    );
    expect(warnings.meta.page.total).toBe(doc.meta.counts.warning);
    expect(warnings.data).toHaveLength(1);
    expect(warnings.data[0]?.attributes.severity).toBe('warning');
    expect(warnings.meta.counts).toEqual(doc.meta.counts);
    expect(warnings.meta.modules).toEqual(doc.meta.modules);
    expect(doc.meta.modules.checked).toBeGreaterThan(0);
    expect(doc.meta.modules.withoutIssues).toBeLessThan(
      doc.meta.modules.checked,
    );
  });

  it('reports a module reference cycle as blocking', async () => {
    const { branch } = await cycleChangeSet();
    t.actAs(reviewer);
    const res = await t.get(
      `/manuals/operating/checks?ref=${encodeURIComponent(branch)}`,
    );
    expect(res.status).toBe(200);
    const doc = CheckPageDocument.parse(res.body);
    const cycle = doc.data.find((c) => c.attributes.code === 'module-cycle');
    expect(cycle?.attributes.severity).toBe('blocking');
    expect(cycle?.attributes.category).toBe('reference');
  });

  it('names nothing the reader may not see', async () => {
    t.actAs(publicReviewer);
    const res = await t.get('/manuals/operating/checks?ref=draft');
    expect(res.status).toBe(200);
    const found = keys(CheckPageDocument.parse(res.body));
    expect(found.filter((k) => /internals|unlabelled/.test(k))).toEqual([]);
  });

  it('is 404 for a manual that is not there, 400 for a bad filter', async () => {
    t.actAs(reviewer);
    const missing = await t.get('/manuals/nope/checks');
    expect(missing.status).toBe(404);
    expect(ErrorDocument.parse(missing.body).errors[0]?.code).toBe('not-found');
    const bad = await t.get('/manuals/operating/checks?filter[severity]=fatal');
    expect(bad.status).toBe(400);
    const other = await t.get('/manuals/operating/checks?filter[other]=x');
    expect(other.status).toBe(400);
  });
});

describe('GET /change-sets/:changeSetId/checks', () => {
  it('reports a module reference cycle it closes, at the closing block', async () => {
    const { id } = await cycleChangeSet();
    t.actAs(reviewer);
    const res = await t.get(`/change-sets/${id}/checks`);
    expect(res.status).toBe(200);
    const doc = CheckPageDocument.parse(res.body);
    const cycles = doc.data.filter((c) => c.attributes.code === 'module-cycle');
    expect(cycles.map((c) => c.attributes)).toEqual([
      expect.objectContaining({
        severity: 'blocking',
        category: 'reference',
        subject: { type: 'module', lang: 'en', moduleId: 'safety-note' },
        blockId: 'back',
        params: { module: 'charging' },
        message: 'module reference cycle: safety-note → charging → safety-note',
      }),
    ]);
  });

  it('checks what the change set changes, at its head', async () => {
    const id = await brokenChangeSet();
    t.actAs(reviewer);
    const res = await t.get(`/change-sets/${id}/checks`);
    expect(res.status).toBe(200);
    const doc = CheckPageDocument.parse(res.body);
    expect(keys(doc)).toEqual(
      expect.arrayContaining([
        'missing-image en/charging unstored',
        'missing-module en/charging dangling',
        'missing-translation en/charging -',
      ]),
    );
    expect(doc.meta.commit).toBe(
      git('rev-parse', `refs/heads/change-sets/${id}`),
    );
    const image = doc.data.find((c) => c.attributes.code === 'missing-image');
    expect(image?.attributes.params).toEqual({
      asset: `sha256:${'d'.repeat(64)}`,
    });

    const bad = await t.get(`/change-sets/${id}/checks?filter[severity]=x`);
    expect(bad.status).toBe(400);
    const ref = await t.get(`/change-sets/${id}/checks?ref=main`);
    expect(ref.status).toBe(400);

    // Its author sees their own, the reference they broke too; another
    // author's is not there.
    t.actAs(author);
    const own = await t.get(`/change-sets/${id}/checks`);
    expect(own.status).toBe(200);
    expect(keys(CheckPageDocument.parse(own.body))).toContain(
      'missing-module en/charging dangling',
    );
    t.actAs(otherAuthor);
    const hidden = await t.get(`/change-sets/${id}/checks`);
    expect(hidden.status).toBe(404);
    expect(ErrorDocument.parse(hidden.body).errors[0]?.code).toBe('not-found');
  });
});
