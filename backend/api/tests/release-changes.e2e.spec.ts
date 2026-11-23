import { execFileSync } from 'node:child_process';
import { GitWriter } from '@openfolia/content-repo';
import { and, eq } from 'drizzle-orm';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { AuditEventPageDocument } from '../src/audit/api/audit-event.resources.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { outbox } from '../src/change-sets/repos/outbox.tables.js';
import { releaseDiffs } from '../src/releases/repos/release-diffs.tables.js';
import { ModuleDocument } from '../src/modules/api/module.resources.js';
import { RefPageDocument } from '../src/project/api/project.resources.js';
import {
  ChangelogPageDocument,
  ReleaseChangePageDocument,
  ReleaseDocument,
  ReleasePageDocument,
} from '../src/releases/api/release.resources.js';
import { actorWith, READER } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith(permissions, scope), id });
const publisher = user('sample-publisher', ['content.read', 'release.publish']);
const admin = user('sample-admin', ['admin.roles']);
const publicReader = user('public-reader', ['content.read'], {
  maxAudience: 'public',
});

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const cut = async (attributes: Record<string, unknown>) => {
  t.actAs(publisher);
  const res = await t
    .post('/releases')
    .send(JSON.stringify({ data: { type: 'Release', attributes } }));
  expect(res.status).toBe(201);
  return ReleaseDocument.parse(res.body).data;
};

const withdraw = (id: string, body: unknown, as: Actor = publisher) => {
  t.actAs(as);
  return t.post(`/releases/${id}/withdraw`).send(JSON.stringify(body));
};

const changes = async (id: string, as: Actor = READER) => {
  t.actAs(as);
  const res = await t.get(`/releases/${id}/changes`);
  expect(res.status).toBe(200);
  return ReleaseChangePageDocument.parse(res.body);
};

const changelog = async (query = '', as: Actor = READER) => {
  t.actAs(as);
  const res = await t.get(`/changelog${query}`);
  expect(res.status).toBe(200);
  return ChangelogPageDocument.parse(res.body);
};

const codeOf = (body: unknown) => ErrorDocument.parse(body).errors[0]?.code;

const published = () =>
  t.database.db
    .select()
    .from(outbox)
    .where(eq(outbox.topic, 'release.published'))
    .orderBy(outbox.id);

describe('release notes, changes and the changelog', () => {
  let first: Awaited<ReturnType<typeof cut>>;
  let second: Awaited<ReturnType<typeof cut>>;
  /** The ETag of a read at `second`'s tag before it was withdrawn. */
  let standingEtag: string;

  it('lists every manual as added for a product’s first release', async () => {
    first = await cut({ product: 'north', revision: '1.0' });
    const page = await changes(first.id);
    expect(page.meta.previous).toBeNull();
    expect(page.data.map((c) => `${c.meta.change} ${c.id}`)).toEqual([
      'added de/operating',
      'added en/operating',
      'added fr/operating',
      'added de/service',
      'added en/service',
      'added fr/service',
    ]);
    // A reader of public content only: not the internal service manual.
    expect(
      (await changes(first.id, publicReader)).data.map((c) => c.id),
    ).toEqual(['de/operating', 'en/operating', 'fr/operating']);
    // Worked out once, when it was cut, and kept for a restart (#478).
    const kept = await t.database.db
      .select({ base: releaseDiffs.baseCommit, diff: releaseDiffs.diff })
      .from(releaseDiffs)
      .where(eq(releaseDiffs.headCommit, first.attributes.commit));
    expect(kept).toEqual([{ base: '', diff: expect.any(Object) }]);
  });

  it('keeps notes per language and major, and lists a changed module under each manual naming it', async () => {
    // Tags are ordered by their date, to the second.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
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
      message: 'Reword charging',
      author: { name: 'Someone', email: 'someone@example.com' },
    });
    second = await cut({
      product: 'north',
      revision: '1.1',
      notes: 'Charging reworded.',
      notesByLanguage: { de: 'Laden neu formuliert.' },
      major: true,
    });
    expect(second.attributes).toMatchObject({
      notes: 'Charging reworded.',
      notesByLanguage: { de: 'Laden neu formuliert.' },
      major: true,
      withdrawal: null,
    });
    expect(git('cat-file', 'tag', second.attributes.tagObject)).toContain(
      'Release north 1.1 (major)\n\nCharging reworded.\n\n[notes:de]\nLaden neu formuliert.\n\nProduct: north',
    );

    const page = await changes(second.id);
    expect(page.meta.previous).toMatchObject({
      id: first.id,
      tag: 'release/north/1.0',
    });
    expect(
      page.data.map((c) => [
        c.id,
        c.meta.change,
        c.meta.modules.map((m) => `${m.change}:${m.moduleId}`),
      ]),
    ).toEqual([
      ['en/operating', 'changed', ['changed:charging']],
      ['en/service', 'changed', ['changed:charging']],
    ]);
    expect(page.data[0]?.meta.modules[0]?.blocks.length).toBeGreaterThan(0);
    const scoped = await changes(second.id, publicReader);
    expect(scoped.data.map((c) => c.id)).toEqual(['en/operating']);
    expect(scoped.meta.page.total).toBe(1);
    expect(JSON.stringify(scoped)).not.toContain('service');

    const rows = await published();
    expect(rows.map((r) => r.key)).toEqual([first.id, second.id]);
    expect(rows[1]?.payload).toMatchObject({
      releaseId: second.id,
      major: true,
      level: 'major',
      manualIds: ['operating', 'service'],
      modules: [{ moduleId: 'charging', lang: 'en', change: 'changed' }],
      complete: true,
    });
    expect(rows[0]?.payload).toMatchObject({ major: false, level: 'minor' });
  });

  it('lists the changelog newest first, filtered, as the reader sees it', async () => {
    const all = await changelog();
    expect(
      all.data.map((r) => [r.attributes.revision, r.meta.changedManuals]),
    ).toEqual([
      ['1.1', 2],
      ['1.0', 2],
    ]);
    expect(all.meta.truncated).toBe(false);
    expect(
      (await changelog('?filter[major]=true')).data.map((r) => r.id),
    ).toEqual([second.id]);
    expect((await changelog('?filter[lang]=de')).data.map((r) => r.id)).toEqual(
      [first.id],
    );
    expect(
      (await changelog('?filter[manual]=service')).data.map((r) => r.id),
    ).toEqual([second.id, first.id]);
    const scoped = await changelog('?filter[manual]=service', publicReader);
    expect(scoped.data).toEqual([]);
    expect(scoped.meta.page.total).toBe(0);
    expect(
      (await changelog('', publicReader)).data.map(
        (r) => r.meta.changedManuals,
      ),
    ).toEqual([1, 1]);
    t.actAs(READER);
    expect((await t.get('/changelog?filter[major]=maybe')).status).toBe(400);
    expect((await t.get('/changelog?filter[other]=x')).status).toBe(400);
  });

  it('withdraws a release: full-scope release.publish, audited, the tag kept, no longer the latest', async () => {
    t.actAs(READER);
    const status = async () =>
      ModuleDocument.parse((await t.get('/modules/en/charging')).body).data.meta
        .status.release;
    expect(await status()).toMatchObject({
      tag: 'release/north/1.1',
      same: true,
    });

    const reason = { meta: { reason: 'Wrong torque values.' } };
    expect((await withdraw(second.id, reason, READER)).status).toBe(403);
    expect(
      (
        await withdraw(
          second.id,
          reason,
          user('south-publisher', ['content.read', 'release.publish'], {
            facets: { region: ['south'] },
          }),
        )
      ).status,
    ).toBe(403);
    const empty = await withdraw(second.id, { meta: { reason: '  ' } });
    expect(empty.status).toBe(400);
    expect(codeOf(empty.body)).toBe('invalid-body');
    expect((await withdraw(second.id, {})).status).toBe(400);

    // A read at the tag while the release stands: not marked (#330).
    t.actAs(READER);
    const standing = await t.get('/manuals?ref=release/north/1.1');
    expect(standing.status).toBe(200);
    expect(standing.headers['x-ccms-withdrawn']).toBeUndefined();
    standingEtag = standing.headers['etag'] as string;

    const tag = git('rev-parse', 'refs/tags/release/north/1.1');
    const res = await withdraw(second.id, reason);
    expect(res.status).toBe(200);
    expect(ReleaseDocument.parse(res.body).data.attributes.withdrawal).toEqual({
      by: { kind: 'user', id: 'sample-publisher' },
      at: expect.any(String),
      reason: 'Wrong torque values.',
    });
    const again = await withdraw(second.id, reason);
    expect(again.status).toBe(409);
    expect(codeOf(again.body)).toBe('release-withdrawn');

    // The tag stays, and reads at it keep working.
    expect(git('rev-parse', 'refs/tags/release/north/1.1')).toBe(tag);
    t.actAs(READER);
    expect((await t.get('/manuals?ref=release/north/1.1')).status).toBe(200);
    // It no longer counts as the module's latest release.
    expect(await status()).toMatchObject({
      tag: 'release/north/1.0',
      same: false,
    });
    // Every reader sees it withdrawn, with the reason.
    const [entry] = (await changelog()).data;
    expect(entry?.id).toBe(second.id);
    expect(entry?.attributes.withdrawal?.reason).toBe('Wrong torque values.');
    t.actAs(READER);
    expect(
      ReleaseDocument.parse((await t.get(`/releases/${second.id}`)).body).data
        .attributes.withdrawal?.reason,
    ).toBe('Wrong torque values.');
    // Listed by state.
    const ids = async (query: string) =>
      ReleasePageDocument.parse(
        (await t.get(`/releases${query}`)).body,
      ).data.map((r) => r.id);
    expect(await ids('?filter[state]=withdrawn')).toEqual([second.id]);
    expect(await ids('?filter[state]=published')).not.toContain(second.id);
    expect((await t.get('/releases?filter[state]=gone')).status).toBe(400);

    t.actAs(admin);
    const audit = AuditEventPageDocument.parse(
      (await t.get('/audit-events?filter[action]=release.withdraw')).body,
    );
    expect(audit.data.map((e) => e.attributes.subject)).toEqual([
      { type: 'release', id: second.id },
    ]);
    const rows = await t.database.db
      .select()
      .from(outbox)
      .where(
        and(eq(outbox.topic, 'release.withdrawn'), eq(outbox.key, second.id)),
      );
    expect(rows.map((r) => r.payload)).toEqual([
      expect.objectContaining({
        releaseId: second.id,
        reason: 'Wrong torque values.',
      }),
    ]);
  });

  it('marks the withdrawn release’s tag in GET /refs and in reads at it, never a standing one (#330)', async () => {
    t.actAs(READER);
    const refs = RefPageDocument.parse(
      (await t.get('/refs?page[size]=200')).body,
    ).data;
    const byId = (id: string) => refs.find((ref) => ref.id === id);
    expect(byId('tags/release/north/1.1')?.meta).toEqual({
      withdrawal: {
        by: { kind: 'user', id: 'sample-publisher' },
        at: expect.any(String),
        reason: 'Wrong torque values.',
      },
    });
    expect(byId('tags/release/north/1.0')?.meta).toEqual({ withdrawal: null });
    expect(byId('heads/main')?.meta).toBeUndefined();

    // Reads at the tag keep working and say so, by name or full ref.
    for (const ref of ['release/north/1.1', 'refs/tags/release/north/1.1']) {
      const res = await t.get(`/manuals?ref=${encodeURIComponent(ref)}`);
      expect(res.status).toBe(200);
      expect(res.headers['x-ccms-withdrawn']).toBe('true');
    }
    // An HTML page too: every content route.
    const page = await t.get(
      '/modules/en/charging/preview?ref=release/north/1.1',
    );
    expect(page.status).toBe(200);
    expect(page.headers['x-ccms-withdrawn']).toBe('true');
    // The withdrawal changed the ETag: the answer cached before is not confirmed.
    const marked = await t
      .get('/manuals?ref=release/north/1.1')
      .set('If-None-Match', standingEtag);
    expect(marked.status).toBe(200);
    const etag = marked.headers['etag'] as string;
    expect(etag).not.toBe(standingEtag);
    const unchanged = await t
      .get('/manuals?ref=release/north/1.1')
      .set('If-None-Match', etag);
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers['x-ccms-withdrawn']).toBe('true');
    // On a route whose ETag hashes its answer (a module's status) as well.
    const status = await t.get('/modules/en/charging?ref=release/north/1.1');
    expect(status.status).toBe(200);
    expect(status.headers['x-ccms-withdrawn']).toBe('true');

    // A standing release's tag, `main` and the withdrawn tag's commit are not marked.
    const commit = git('rev-parse', 'refs/tags/release/north/1.1^{commit}');
    for (const ref of ['release/north/1.0', 'main', commit]) {
      const res = await t.get(`/manuals?ref=${encodeURIComponent(ref)}`);
      expect(res.status).toBe(200);
      expect(res.headers['x-ccms-withdrawn']).toBeUndefined();
    }
  });

  it('counts a later release’s changes from the previous one that stands', async () => {
    const third = await cut({ product: 'north', revision: '1.2' });
    const page = await changes(third.id);
    expect(page.meta.previous?.id).toBe(first.id);
    expect(page.data.map((c) => c.id)).toEqual(['en/operating', 'en/service']);
    t.actAs(READER);
    expect(
      (await t.get('/releases/00000000-0000-7000-8000-000000000000/changes'))
        .status,
    ).toBe(404);
  });
});
