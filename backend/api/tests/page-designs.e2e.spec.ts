import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  parsePageDesign,
  type PageDesignInput,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import { addSamplePageDesigns } from '@openfolia/content-repo/testing';
import { sql } from 'drizzle-orm';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import {
  ErrorDocument,
  JSON_API,
  REQUEST_HEADER,
} from '../src/base/api/json-api.js';
import { ChangeSetChangePageDocument } from '../src/change-sets/api/change.resources.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { PageDesignWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import {
  MergeDocument,
  ReviewDocument,
} from '../src/change-sets/api/workflow.resources.js';
import {
  PageDesignDocument,
  PageDesignPageDocument,
} from '../src/page-designs/api/page-design.resources.js';
import { actorWith, READER } from './fakes/actors.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

/**
 * The page designs (#390) over the sample repository with its designs
 * (`addSamplePageDesigns`: classic, minimal on `main`) and one file that
 * is no design, `design/broken.yaml`, on top.
 */
const READS: Permission[] = ['content.read', 'content.read.draft'];
const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith([...READS, ...permissions], scope), id });

/** Edits everything: may change a page design. */
const editor = user('sample-author', ['content.edit']);
/** Edits German only: may not. */
const german = user('sample-german', ['content.edit'], { languages: ['de'] });
const reviewer = user('sample-reviewer', ['content.review']);
const publisher = user('sample-publisher', ['release.publish']);

let t: TestApp;
let main: string;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const errors = (body: unknown) => ErrorDocument.parse(body).errors;
const json = (body: unknown) => JSON.stringify(body);

beforeAll(async () => {
  t = await createTestApp();
  const withDesigns = await addSamplePageDesigns(dir());
  main = (
    await new GitWriter(dir()).commit({
      branch: 'main',
      parent: withDesigns,
      changes: [{ path: 'design/broken.yaml', content: 'preset: [\n' }],
      message: 'A broken design',
      author: { name: 'Someone', email: 'someone@example.com' },
    })
  ).commit;
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

/** The sample designs' back page, in a sample project with no manufacturer details (#395). */
const MISSING_MANUFACTURER = expect.objectContaining({
  severity: 'warning',
  code: 'missing-manufacturer',
  at: 'backPage',
});
afterEach(async () => {
  if (!t) return;
  t.actAs(undefined);
  await t.database.db.execute(sql`delete from locks`);
});

describe('GET /page-designs', () => {
  it('lists every design by ID, pinned to the commit, a broken file with why', async () => {
    t.actAs(READER);
    const res = await t.get('/page-designs');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(JSON_API);
    expect(res.headers['x-ccms-commit']).toBe(main);
    const page = PageDesignPageDocument.parse(res.body);
    expect(page.data.map((d) => d.id)).toEqual([
      'broken',
      'classic',
      'minimal',
    ]);
    expect(page.meta.page.total).toBe(3);
    expect(page.data[0]).toEqual({
      type: 'PageDesign',
      id: 'broken',
      attributes: {},
      meta: { error: expect.stringContaining('design/broken.yaml') },
    });
    expect(page.data[1]).toMatchObject({
      type: 'PageDesign',
      id: 'classic',
      attributes: {
        schemaVersion: 1,
        name: 'Classic',
        preset: 'classic',
        colours: { primary: '#1f4e79' },
      },
      // Its back page has nothing to print of a manufacturer: the sample project names none (#395).
      meta: { issues: [MISSING_MANUFACTURER] },
    });
    // The least a file holds, every other setting at its default.
    expect(page.data[2]).toMatchObject({
      id: 'minimal',
      attributes: {
        page: { size: 'a4', doubleSided: false },
        body: { columns: 1 },
        safety: { standard: 'ansi-z535' },
      },
    });
  });

  it('is paginated', async () => {
    t.actAs(READER);
    const res = await t.get('/page-designs?page[size]=1&page[number]=2');
    expect(res.status).toBe(200);
    const page = PageDesignPageDocument.parse(res.body);
    expect(page.data.map((d) => d.id)).toEqual(['classic']);
    expect(page.meta.page).toMatchObject({
      currentPage: 2,
      lastPage: 3,
      total: 3,
    });
  });

  it('lets every reader of the ref read them, whatever their scope', async () => {
    t.actAs(actorWith(['content.read'], { languages: ['de'] }));
    const res = await t.get('/page-designs');
    expect(res.status).toBe(200);
    expect(PageDesignPageDocument.parse(res.body).meta.page.total).toBe(3);
  });

  it('reads them at ?ref=, like every content route', async () => {
    t.actAs(READER);
    // The release tag predates the designs.
    const res = await t.get('/page-designs?ref=v1');
    expect(res.status).toBe(200);
    expect(PageDesignPageDocument.parse(res.body).data).toEqual([]);
    expect((await t.get('/page-designs?ref=no-such-ref')).status).toBe(404);
  });

  it('refuses unsupported parameters', async () => {
    t.actAs(READER);
    const res = await t.get('/page-designs?filter[name]=x');
    expect(res.status).toBe(400);
  });
});

describe('GET /page-designs/:designId', () => {
  it('reads one, with its assets checked against the blob store', async () => {
    t.actAs(READER);
    const res = await t.get('/page-designs/classic');
    expect(res.status).toBe(200);
    const { data } = PageDesignDocument.parse(res.body);
    expect(data.id).toBe('classic');
    expect(data.attributes.regions['footer']).toEqual([
      {
        type: 'paragraph',
        id: 'release',
        content: [{ type: 'placeholder', key: 'release' }],
      },
    ]);
    // Its logo is not stored.
    expect(data.meta.issues).toEqual([
      MISSING_MANUFACTURER,
      expect.objectContaining({
        severity: 'error',
        code: 'missing-asset',
        at: 'logo.light',
      }),
    ]);
  });

  it('finds a logo kept in the older layout, `assets/<sha256>` in the repository (#554)', async () => {
    const logo = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
    );
    const hash = createHash('sha256').update(logo).digest('hex');
    git('branch', 'old-layout-logo', main);
    await new GitWriter(dir()).commit({
      branch: 'old-layout-logo',
      parent: main,
      changes: [
        { path: `assets/${hash}`, content: logo },
        {
          path: 'design/old-logo.yaml',
          content: git('show', `${main}:design/classic.yaml`).replace(
            '1'.repeat(64),
            hash,
          ),
        },
      ],
      message: 'A design whose logo is in the old layout',
      author: { name: 'Someone', email: 'someone@example.com' },
    });
    // A branch is read by a reader of drafts.
    t.actAs(user('sample-drafts', []));
    const res = await t.get('/page-designs/old-logo?ref=old-layout-logo');
    expect(res.status).toBe(200);
    const { data } = PageDesignDocument.parse(res.body);
    expect(data.attributes.logo?.light).toBe(`sha256:${hash}`);
    expect(data.meta.issues).toEqual([MISSING_MANUFACTURER]);
  });

  it('is 404 for no design, 422 for a file that is no design, 400 for no design ID', async () => {
    t.actAs(READER);
    const missing = await t.get('/page-designs/nothing');
    expect(missing.status).toBe(404);
    const broken = await t.get('/page-designs/broken');
    expect(broken.status).toBe(422);
    expect(errors(broken.body)[0]?.code).toBe('invalid-content');
    for (const id of ['Not_An_Id', 'builtin']) {
      expect((await t.get(`/page-designs/${id}`)).status).toBe(400);
    }
  });
});

describe('page designs as change-set subjects', () => {
  async function changeSet(actor: Actor): Promise<string> {
    t.actAs(actor);
    const created = await t.post('/change-sets').send(
      json({
        data: { type: 'ChangeSet', attributes: { title: 'Page design' } },
      }),
    );
    expect(created.status).toBe(201);
    return ChangeSetDocument.parse(created.body).data.id;
  }

  const lock = (id: string, designId: string) =>
    t.post(`/change-sets/${id}/locks`).send(
      json({
        data: {
          type: 'Lock',
          attributes: { subject: { type: 'design', designId } },
        },
      }),
    );

  const copyPath = (id: string, designId: string) =>
    `/change-sets/${id}/page-designs/${designId}/working-copy`;

  const save = (
    id: string,
    designId: string,
    content: unknown,
    meta: { version: number; baseCommit: string },
  ) =>
    t
      .put(copyPath(id, designId))
      .send(
        json({ data: { type: 'WorkingCopy', attributes: { content } }, meta }),
      );

  const baseOf = async (id: string) =>
    ChangeSetDocument.parse((await t.get(`/change-sets/${id}`)).body).data
      .attributes.baseCommit;

  /** A real 1×1 PNG, with bytes after its end so no other test holds it. */
  const LOGO = Buffer.concat([
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    ),
    Buffer.from('#page-design-logo'),
  ]);
  const logo = `sha256:${createHash('sha256').update(LOGO).digest('hex')}`;

  const design = (asset: string): PageDesignInput => ({
    schemaVersion: 1,
    id: 'product-line',
    name: 'Product line',
    preset: 'minimal',
    colours: { primary: '#1f4e79', accent: '#b45309', text: '#1f2328' },
    logo: { light: asset },
    regions: {
      footer: {
        en: [
          {
            type: 'paragraph',
            id: 'doc',
            content: [
              { type: 'text', text: 'Release ' },
              { type: 'placeholder', key: 'release' },
            ],
          },
        ],
        de: [
          {
            type: 'paragraph',
            id: 'doc',
            content: [
              { type: 'text', text: 'Ausgabe ' },
              { type: 'placeholder', key: 'release' },
            ],
          },
        ],
      },
    },
    footer: {
      default: {
        right: { en: [{ type: 'placeholder', key: 'page' }] },
      },
    },
  });

  it('is written through a change set, reviewed and merged like configuration', async () => {
    const id = await changeSet(editor);
    expect((await lock(id, 'product-line')).status).toBe(201);
    // Not on the branch yet.
    expect((await t.get(copyPath(id, 'product-line'))).status).toBe(404);
    const uploaded = await t
      .anonymous()
      .post(`/change-sets/${id}/assets`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .set(REQUEST_HEADER, '1')
      .attach('file', LOGO, { filename: 'logo.png', contentType: 'image/png' });
    expect(uploaded.status).toBe(201);

    const saved = await save(id, 'product-line', design(logo), {
      version: 0,
      baseCommit: await baseOf(id),
    });
    expect(saved.status).toBe(200);
    const copy = PageDesignWorkingCopyDocument.parse(saved.body).data;
    expect(copy.id).toBe(`${id}/design/product-line`);
    expect(copy.attributes.version).toBe(1);
    // Defaults filled in; the issues say where in the design.
    expect(copy.attributes.content).toMatchObject({
      page: { size: 'a4' },
      headings: { pageBreakBeforeLevel1: true },
    });
    expect(copy.meta.issues).toEqual([]);

    expect((await t.post(`/change-sets/${id}/commits`)).status).toBe(201);
    const branch = `change-sets/${id}`;
    const file = git('show', `${branch}:design/product-line.yaml`);
    expect(file).toContain('Release placeholder:release[]');
    expect(parsePageDesign(`${file}\n`, { id: 'product-line' })).toMatchObject({
      name: 'Product line',
      logo: { light: logo },
    });

    const changes = await t.get(`/change-sets/${id}/changes`);
    expect(changes.status).toBe(200);
    expect(
      ChangeSetChangePageDocument.parse(changes.body).data.map((c) => [
        c.id,
        c.meta.change,
      ]),
    ).toEqual([['design/product-line', 'added']]);

    // Read at the branch, not on main until merged.
    const atBranch = await t.get(
      `/page-designs/product-line?ref=${encodeURIComponent(branch)}`,
    );
    expect(atBranch.status).toBe(200);
    // The logo uploaded into the change set is stored.
    expect(PageDesignDocument.parse(atBranch.body).data.meta.issues).toEqual(
      [],
    );
    t.actAs(READER);
    expect((await t.get('/page-designs/product-line')).status).toBe(404);

    t.actAs(editor);
    expect((await t.post(`/change-sets/${id}/submit`).send('')).status).toBe(
      200,
    );
    t.actAs(reviewer);
    const reviewed = await t.post(`/change-sets/${id}/approve`).send('');
    expect(reviewed.status).toBe(200);
    expect(ReviewDocument.parse(reviewed.body).meta.review).toMatchObject({
      required: ['review'],
      pending: [],
    });
    t.actAs(publisher);
    const merged = await t.post(`/change-sets/${id}/merge`).send('');
    expect(merged.status).toBe(200);
    expect(MergeDocument.parse(merged.body).data.attributes.state).toBe(
      'merged',
    );

    t.actAs(READER);
    const onMain = await t.get('/page-designs/product-line');
    expect(onMain.status).toBe(200);
    expect(
      PageDesignDocument.parse(onMain.body).data.attributes.regions['footer'],
    ).toMatchObject({ de: [{ id: 'doc' }], en: [{ id: 'doc' }] });
  });

  it('reports problems without refusing a draft, and refuses a file the editor may not name', async () => {
    const id = await changeSet(editor);
    expect((await lock(id, 'classic')).status).toBe(201);
    const read = await t.get(copyPath(id, 'classic'));
    expect(read.status).toBe(200);
    const committed = PageDesignWorkingCopyDocument.parse(read.body).data
      .attributes;
    expect(committed.version).toBe(0);

    const unknown = await save(
      id,
      'classic',
      { ...committed.content, logo: { light: `sha256:${'9'.repeat(64)}` } },
      { version: 0, baseCommit: committed.baseCommit },
    );
    expect(unknown.status).toBe(422);
    expect(errors(unknown.body)[0]?.code).toBe('unknown-asset');

    // The committed logo may be named again: every reader reads the design naming it.
    const lowContrast = await save(
      id,
      'classic',
      {
        ...committed.content,
        colours: { primary: '#eeeeee', accent: '#b45309', text: '#1f2328' },
        footer: {
          default: { left: [{ type: 'placeholder', key: 'no-such-value' }] },
        },
      },
      { version: 0, baseCommit: committed.baseCommit },
    );
    expect(lowContrast.status).toBe(200);
    const issues = PageDesignWorkingCopyDocument.parse(lowContrast.body).data
      .meta.issues;
    expect(issues.map((i) => [i.code, i.at])).toEqual(
      expect.arrayContaining([
        ['low-contrast', 'colours.primary'],
        ['unknown-placeholder', 'footer.default.left'],
      ]),
    );
    // An error refuses the save point.
    const commit = await t.post(`/change-sets/${id}/commits`);
    expect(commit.status).toBe(422);
    expect(errors(commit.body).map((e) => e.meta?.['issue'] ?? e.code)).toEqual(
      expect.arrayContaining(['unknown-placeholder']),
    );
  });

  it('is changed only with `content.edit` through a role that restricts nothing', async () => {
    const id = await changeSet(german);
    const locked = await lock(id, 'classic');
    expect(locked.status).toBe(403);
    expect(errors(locked.body)[0]?.code).toBe('forbidden');
  });

  it('refuses a content ID that is not the path’s, and unknown members', async () => {
    const id = await changeSet(editor);
    expect((await lock(id, 'product-other')).status).toBe(201);
    const base = await baseOf(id);
    const other = await save(id, 'product-other', design(logo), {
      version: 0,
      baseCommit: base,
    });
    expect(other.status).toBe(422);
    const unknown = await save(
      id,
      'product-other',
      { ...design(logo), id: 'product-other', columns: 2 },
      { version: 0, baseCommit: base },
    );
    expect(unknown.status).toBe(400);
  });
});
