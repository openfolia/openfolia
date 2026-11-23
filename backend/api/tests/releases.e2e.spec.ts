import { execFileSync } from 'node:child_process';
import { GitWriter } from '@openfolia/content-repo';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ManualPageDocument } from '../src/manuals/api/manual.resources.js';
import { ModuleDocument } from '../src/modules/api/module.resources.js';
import {
  ReleaseDocument,
  ReleasePageDocument,
} from '../src/releases/api/release.resources.js';
import { actorWith, READER } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

// Two apps and PDFs: slower than most.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith(permissions, scope), id });
const publisher = user('sample-publisher', ['content.read', 'release.publish']);
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

const cut = (attributes: Record<string, unknown>, as: Actor = publisher) => {
  t.actAs(as);
  return t
    .post('/releases')
    .send(JSON.stringify({ data: { type: 'Release', attributes } }));
};

const codeOf = (body: unknown) => ErrorDocument.parse(body).errors[0]?.code;

describe('releases', () => {
  it('cuts a release of main, lists and reads it, and reads the content at its tag', async () => {
    const main = git('rev-parse', 'refs/heads/main');
    const res = await cut({
      product: 'north',
      revision: '1.0',
      notes: 'First release.\r\nWith two lines.  ',
    });
    expect(res.status).toBe(201);
    const { data } = ReleaseDocument.parse(res.body);
    expect(res.headers['location']).toBe(`/releases/${data.id}`);
    expect(data.attributes).toEqual({
      product: 'north',
      productFacet: 'region',
      revision: '1.0',
      tag: 'release/north/1.0',
      tagObject: git('rev-parse', 'refs/tags/release/north/1.0'),
      commit: main,
      notes: 'First release.\nWith two lines.',
      notesByLanguage: {},
      major: false,
      publishedBy: { kind: 'user', id: 'sample-publisher' },
      publishedAt: expect.stringMatching(/:\d\d\.000Z$/),
      withdrawal: null,
    });
    expect(git('cat-file', 'tag', data.attributes.tagObject)).toContain(
      'Release north 1.0\n\nFirst release.\nWith two lines.\n\nProduct: north\nRevision: 1.0\nActor: user/sample-publisher',
    );

    t.actAs(READER);
    const list = ReleasePageDocument.parse((await t.get('/releases')).body);
    expect(list.data).toEqual([data]);
    expect(list.meta.page.total).toBe(1);
    const one = await t.get(`/releases/${data.id}`);
    expect(ReleaseDocument.parse(one.body).data).toEqual(data);
    expect((await t.get('/releases?filter[product]=south')).body.data).toEqual(
      [],
    );
    for (const id of ['00000000-0000-7000-8000-000000000000', 'nope']) {
      const missing = await t.get(`/releases/${id}`);
      expect(missing.status).toBe(404);
      expect(codeOf(missing.body)).toBe('not-found');
    }
    expect(
      (await t.get('/releases?filter[product]=Not%20A%20Key')).status,
    ).toBe(400);

    // A reader of released content reads at the tag.
    const manuals = await t.get(`/manuals?ref=${data.attributes.tag}`);
    expect(manuals.status).toBe(200);
    expect(manuals.headers['x-ccms-commit']).toBe(main);
    ManualPageDocument.parse(manuals.body);

    // The module's released status follows: the newest release holding it.
    const module = ModuleDocument.parse(
      (await t.get('/modules/en/charging')).body,
    );
    expect(module.data.meta.status.release).toMatchObject({
      tag: 'release/north/1.0',
      commit: main,
      same: true,
    });

    t.actAs(admin);
    const audit = AuditEventPageDocument.parse(
      (await t.get('/audit-events?filter[action]=release.publish')).body,
    );
    expect(audit.data.map((e) => e.attributes.subject)).toEqual([
      { type: 'release', id: data.id },
    ]);
  });

  it('never changes or re-creates a release under the same name', async () => {
    const tag = git('rev-parse', 'refs/tags/release/north/1.0');
    // main moves on; the same name stays taken.
    await new GitWriter(dir()).commit({
      branch: 'main',
      parent: git('rev-parse', 'refs/heads/main'),
      changes: [
        {
          path: 'modules/en/charging.adoc',
          content: git('show', 'main:modules/en/charging.adoc').replace(
            'charges automatically',
            'charges by itself',
          ),
        },
      ],
      message: 'Move main on',
      author: { name: 'Someone', email: 'someone@example.com' },
    });
    const again = await cut({ product: 'north', revision: '1.0' });
    expect(again.status).toBe(409);
    expect(codeOf(again.body)).toBe('release-exists');
    expect(ErrorDocument.parse(again.body).errors[0]?.meta).toMatchObject({
      releaseId: expect.any(String),
    });
    expect(git('rev-parse', 'refs/tags/release/north/1.0')).toBe(tag);
    // Nor in another case: the same tag on a case-insensitive file system.
    expect((await cut({ product: 'north', revision: 'rc1' })).status).toBe(201);
    const upper = await cut({ product: 'north', revision: 'RC1' });
    expect(upper.status).toBe(409);
    expect(codeOf(upper.body)).toBe('release-exists');
    t.actAs(READER);
    expect(
      ReleasePageDocument.parse((await t.get('/releases')).body).meta.page
        .total,
    ).toBe(2);
  });

  it('refuses what can never be a release', async () => {
    const before = git('for-each-ref');
    const status = async (attributes: Record<string, unknown>) => {
      const res = await cut(attributes);
      return `${res.status} ${codeOf(res.body)}`;
    };
    expect(await status({ product: 'nowhere', revision: '1' })).toBe(
      '422 invalid-product',
    );
    expect(await status({ product: 'north', revision: '1..2' })).toBe(
      '400 invalid-body',
    );
    expect(await status({ product: 'north', revision: '1', notes: '' })).toBe(
      '400 invalid-body',
    );
    expect(
      await status({ product: 'north', revision: '1', notes: 'x\n---\ny' }),
    ).toBe('400 invalid-body');
    expect(
      await status({ product: 'north', revision: '1', notes: 'See: below' }),
    ).toBe('422 invalid-notes');
    expect(await status({ product: 'north', revision: '1', extra: true })).toBe(
      '400 invalid-body',
    );
    expect(git('for-each-ref')).toBe(before);
  });

  it('needs release.publish over the product everywhere', async () => {
    const status = async (actor: Actor) =>
      (await cut({ product: 'south', revision: '1' }, actor)).status;
    expect(await status(READER)).toBe(403);
    expect(
      await status(
        user('german-publisher', ['content.read', 'release.publish'], {
          languages: ['de'],
        }),
      ),
    ).toBe(403);
    expect(
      await status(
        user('north-publisher', ['content.read', 'release.publish'], {
          facets: { region: ['north'] },
        }),
      ),
    ).toBe(403);
    expect(
      await status(
        user('south-publisher', ['content.read', 'release.publish'], {
          facets: { region: ['south'] },
        }),
      ),
    ).toBe(201);
  });

  it('builds the same PDF from a release tag every time', async () => {
    const res = await cut({ product: 'north', revision: '2.0' });
    expect(res.status).toBe(201);
    const { tag } = ReleaseDocument.parse(res.body).data.attributes;
    const path = `/manuals/operating/variants/model=small/en/pdf?ref=${tag}`;
    t.actAs(READER);
    const first = await t.get(path).buffer(true);
    expect(first.status).toBe(200);
    // Rendered again, not from the cache (kept per reading scope): a
    // reader of English only, who sees the same English manual.
    t.actAs(user('english-reader', ['content.read'], { languages: ['en'] }));
    const second = await t.get(path).buffer(true);
    expect(second.status).toBe(200);
    expect(second.headers['x-ccms-commit']).toBe(
      first.headers['x-ccms-commit'],
    );
    expect((second.body as Buffer).equals(first.body as Buffer)).toBe(true);
  });
});
