import { execFileSync } from 'node:child_process';
import { GitWriter } from '@openfolia/content-repo';
import { unzipSync } from 'fflate';
import { eq, sql } from 'drizzle-orm';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { outbox } from '../src/change-sets/repos/outbox.tables.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { JobQueue } from '../src/jobs/core/job-queue.js';
import { RenderManualPdfAction } from '../src/manuals/core/actions/render-manual-pdf.action.js';
import { NotificationsConsumer } from '../src/notifications/api/notifications-consumer.js';
import { NotificationPageDocument } from '../src/notifications/api/notification.resources.js';
import { FailReleaseOutputAction } from '../src/releases/core/actions/render-release-output.action.js';
import {
  ReleaseOutputDocument,
  ReleaseOutputPageDocument,
} from '../src/releases/api/release-output.resources.js';
import {
  ReleaseDetailDocument,
  ReleaseListPageDocument,
  ReleaseDocument,
} from '../src/releases/api/release.resources.js';
import {
  PLAN_RELEASE_OUTPUTS,
  PROMOTED_PRIORITY,
  RENDER_RELEASE_OUTPUT,
} from '../src/releases/core/release-output.js';
import { releaseOutputs } from '../src/releases/repos/releases.tables.js';
import { actorWith, READER } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

// Renders a dozen PDFs or so: slower than most.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith(permissions, scope), id });
const publisher = user('sample-publisher', ['content.read', 'release.publish']);
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

const cut = async (revision: string) => {
  // Tags are ordered by their date, to the second.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  t.actAs(publisher);
  const res = await t.post('/releases').send(
    JSON.stringify({
      data: { type: 'Release', attributes: { product: 'north', revision } },
    }),
  );
  expect(res.status).toBe(201);
  return ReleaseDocument.parse(res.body).data;
};

/** Changes the German charging module on main. */
const changeGerman = async (text: string) => {
  const path = 'modules/de/charging.adoc';
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: [
      {
        path,
        content: git('show', `main:${path}`).replace(
          /Das \{product-name\} [^\n]*/,
          `Das {product-name} ${text}`,
        ),
      },
    ],
    message: 'Reword German charging',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
};

const outputs = async (id: string, query = '', as: Actor = READER) => {
  t.actAs(as);
  const res = await t.get(`/releases/${id}/outputs${query}`);
  expect(res.status).toBe(200);
  return ReleaseOutputPageDocument.parse(res.body);
};

/**
 * The release's `meta.outputs`, as `as` reads it (#456); the list of releases says the same of it
 * (#481), so a list shows every release's files without a read per release, all but what waits
 * ahead of it (#497: `queue`, the release's own read only).
 */
const progress = async (id: string, as: Actor = READER) => {
  t.actAs(as);
  const res = await t.get(`/releases/${id}`);
  expect(res.status).toBe(200);
  const own = ReleaseDetailDocument.parse(res.body).data.meta.outputs;
  const list = await t.get('/releases?page[size]=200');
  expect(list.status).toBe(200);
  const listed = ReleaseListPageDocument.parse(list.body).data.find(
    (r) => r.id === id,
  );
  expect(listed?.meta.outputs).toEqual(own && { ...own, queue: null });
  return own;
};

/** `<state> <manual>/<variant>/<lang>`, `(reused)` when it reuses a file. */
const summary = (page: Awaited<ReturnType<typeof outputs>>) =>
  page.data.map(
    (o) =>
      `${o.attributes.state} ${o.attributes.manual}/${o.attributes.variant}/${o.attributes.lang}${o.meta.reusedFrom ? ' (reused)' : ''}`,
  );

const codeOf = (body: unknown) => ErrorDocument.parse(body).errors[0]?.code;

const file = (path: string, as: Actor = READER) => {
  t.actAs(as);
  return t.get(path).buffer(true);
};

/** A release's archive (#469), its body as bytes whatever its type (a JSON:API error stays JSON). */
const archive = (releaseId: string, as: Actor = READER) => {
  t.actAs(as);
  return t
    .get(`/releases/${releaseId}/outputs/archive`)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        done(
          null,
          res.headers['content-type'] === 'application/zip'
            ? body
            : JSON.parse(body.toString('utf8')),
        );
      });
    });
};

describe('release outputs', () => {
  let first: Awaited<ReturnType<typeof cut>>;
  let second: Awaited<ReturnType<typeof cut>>;

  it('renders every manual in each variant and language for a product’s first release', async () => {
    first = await cut('1.0');
    // Queued with the release, rendered in the background.
    expect(summary(await outputs(first.id))).toEqual([]);
    // No rows yet, but the release says they are being prepared (#456).
    expect(await progress(first.id)).toEqual({
      state: 'planning',
      total: 0,
      queued: 0,
      rendering: 0,
      done: 0,
      failed: 0,
      refused: null,
      queue: null,
    });
    await t.runJobs();
    expect(await progress(first.id)).toEqual({
      state: 'done',
      total: 9,
      queued: 0,
      rendering: 0,
      done: 9,
      failed: 0,
      refused: null,
      queue: null,
    });
    const page = await outputs(first.id);
    expect(summary(page)).toEqual([
      'done operating/model=large/de',
      'done operating/model=large/en',
      'done operating/model=large/fr',
      'done operating/model=small/de',
      'done operating/model=small/en',
      'done operating/model=small/fr',
      'done service/model=large/de',
      'done service/model=large/en',
      'done service/model=large/fr',
    ]);
    expect(page.meta.page.total).toBe(9);
    const one = page.data.find(
      (o) =>
        o.attributes.manual === 'operating' &&
        o.attributes.variant === 'model=small' &&
        o.attributes.lang === 'en',
    );
    expect(one?.meta).toMatchObject({
      attempts: 1,
      retries: 0,
      withdrawn: false,
    });
    const res = await file(one?.links.file as string);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toBe(
      'private, max-age=31536000, immutable',
    );
    expect(res.headers['content-disposition']).toContain(
      'filename="operating_model-small_en_1.0.pdf"',
    );
    expect(res.headers['etag']).toBe(`"${one?.attributes.sha256}"`);
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(body.length).toBe(one?.attributes.size);

    // Reproducible: the same tag renders the same bytes, here as another
    // reader (another cache key) through the manual's PDF route.
    t.actAs(READER);
    const again = await t
      .get(
        `/manuals/operating/variants/model=small/en/pdf?ref=${first.attributes.tag}`,
      )
      .buffer(true);
    expect(again.status).toBe(200);
    expect((again.body as Buffer).equals(body)).toBe(true);

    const filtered = await outputs(
      first.id,
      '?filter[manual]=operating&filter[lang]=de&filter[state]=done&page[size]=1',
    );
    expect(filtered.meta.page.total).toBe(2);
    expect(filtered.data).toHaveLength(1);
    t.actAs(READER);
    const bad = await t.get(`/releases/${first.id}/outputs?filter[state]=nope`);
    expect(bad.status).toBe(400);
  });

  it('shows a reader only the outputs of manuals they may read (404 for the others)', async () => {
    const page = await outputs(first.id, '', publicReader);
    expect(page.meta.page.total).toBe(6);
    // The release's progress counts only what they may read, too.
    expect(await progress(first.id, publicReader)).toMatchObject({
      state: 'done',
      total: 6,
      done: 6,
    });
    expect(page.data.every((o) => o.attributes.manual === 'operating')).toBe(
      true,
    );
    const service = (await outputs(first.id)).data.find(
      (o) => o.attributes.manual === 'service',
    );
    const res = await file(service?.links.file as string, publicReader);
    expect(res.status).toBe(404);
    expect(codeOf(res.body)).toBe('not-found');
    // The file route takes no query parameters.
    t.actAs(publicReader);
    expect(
      (await t.get(`/releases/${first.id}/outputs/${service?.id}/file?x=1`))
        .status,
    ).toBe(400);
  });

  it('downloads all of a release’s done files as one ZIP, each with the bytes the file route serves (#469)', async () => {
    const res = await archive(first.id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="north_1.0.zip"; filename*=UTF-8''north_1.0.zip`,
    );
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-ccms-archive-files']).toBe('9');
    expect(res.headers['x-ccms-archive-left-out']).toBe('0');
    const zip = res.body as Buffer;
    expect(Number(res.headers['content-length'])).toBe(zip.length);
    const entries = unzipSync(zip);
    const page = await outputs(first.id);
    expect(Object.keys(entries)).toEqual(
      page.data.map(
        (o) =>
          `${o.attributes.manual}/${o.attributes.lang}/${o.attributes.variant?.replace('=', '-')}.pdf`,
      ),
    );
    for (const o of page.data) {
      const one = await file(o.links.file as string);
      expect(one.status).toBe(200);
      const name = `${o.attributes.manual}/${o.attributes.lang}/${o.attributes.variant?.replace('=', '-')}.pdf`;
      expect(
        Buffer.from(entries[name] as Uint8Array).equals(one.body as Buffer),
      ).toBe(true);
    }

    // A reader gets only the files of manuals they may read whole.
    const scoped = await archive(first.id, publicReader);
    expect(scoped.status).toBe(200);
    const names = Object.keys(unzipSync(scoped.body as Buffer));
    expect(names).toHaveLength(6);
    expect(names.every((n) => n.startsWith('operating/'))).toBe(true);
    // One who may read none of them: nothing to zip.
    const none = await archive(
      first.id,
      user('region-reader', ['content.read'], {
        facets: { region: ['north'] },
      }),
    );
    expect(none.status).toBe(409);
    expect(codeOf(none.body)).toBe('release-archive-empty');
    expect(ErrorDocument.parse(none.body).errors[0]?.meta).toEqual({
      total: 0,
      notReady: 0,
    });
    // No query parameters; an unknown release is 404.
    t.actAs(READER);
    expect(
      (await t.get(`/releases/${first.id}/outputs/archive?x=1`)).status,
    ).toBe(400);
    expect(
      (
        await t.get(
          '/releases/00000000-0000-7000-8000-000000000000/outputs/archive',
        )
      ).status,
    ).toBe(404);
  });

  it('renders only what the next release changed; the rest points at the previous files', async () => {
    await changeGerman('lädt sich von allein.');
    second = await cut('1.1');
    await t.runJobs();
    const page = await outputs(second.id);
    expect(summary(page)).toEqual([
      'done operating/model=large/de',
      'done operating/model=large/en (reused)',
      'done operating/model=large/fr (reused)',
      'done operating/model=small/de',
      'done operating/model=small/en (reused)',
      'done operating/model=small/fr (reused)',
      'done service/model=large/de',
      'done service/model=large/en (reused)',
      'done service/model=large/fr (reused)',
    ]);
    const before = await outputs(first.id);
    const key = (o: (typeof page.data)[number]) =>
      `${o.attributes.manual}/${o.attributes.variant}/${o.attributes.lang}`;
    for (const output of page.data) {
      const previous = before.data.find((o) => key(o) === key(output));
      if (output.meta.reusedFrom) {
        expect(output.meta.reusedFrom).toEqual({
          releaseId: first.id,
          outputId: previous?.id,
        });
        expect(output.attributes.sha256).toBe(previous?.attributes.sha256);
        expect(output.meta.attempts).toBe(0);
      } else {
        expect(output.attributes.sha256).not.toBe(previous?.attributes.sha256);
      }
    }
  });

  it('finishes a planning or rendering cut off and run again without lost or doubled rows', async () => {
    const queue = t.app.get(JobQueue);
    // The plan job again, as after a crash past its commit: nothing new.
    await queue.enqueue(
      PLAN_RELEASE_OUTPUTS,
      { releaseId: second.id },
      { key: second.id },
    );
    // A render attempt cut off mid-render: the row says rendering, the job runs again.
    const [cutOff] = await t.database.db
      .update(releaseOutputs)
      .set({ state: 'rendering', sha256: null, size: null })
      .where(
        eq(releaseOutputs.id, (await outputs(second.id)).data[0]?.id as string),
      )
      .returning();
    await queue.enqueue(
      RENDER_RELEASE_OUTPUT,
      { outputId: cutOff?.id as string, retries: 0 },
      { key: cutOff?.id as string },
    );
    await t.runJobs();
    const page = await outputs(second.id);
    expect(page.meta.page.total).toBe(9);
    expect(page.data.every((o) => o.attributes.state === 'done')).toBe(true);
    expect(page.data[0]?.meta.attempts).toBe(2);
  });

  it('fails a render that cannot succeed, tells of it, keeps the previous file and retries on request', async () => {
    // A character no font can show: the PDF cannot meet PDF/UA-1.
    await changeGerman('lädt sich \u{7} selbst.');
    const third = await cut('1.2');
    await t.runJobs();
    const failed = await outputs(third.id, '?filter[state]=failed');
    expect(summary(failed)).toEqual([
      'failed operating/model=large/de',
      'failed operating/model=small/de',
      'failed service/model=large/de',
    ]);
    expect(failed.data[0]?.attributes.error?.code).toBe('pdf-accessibility');
    expect(await progress(third.id)).toEqual({
      state: 'failed',
      total: 9,
      queued: 0,
      rendering: 0,
      done: 6,
      failed: 3,
      refused: null,
      queue: null,
    });
    expect(failed.data[0]?.links.file).toBeNull();
    const rows = await t.database.db
      .select()
      .from(outbox)
      .where(eq(outbox.topic, 'release.output-failed'));
    expect(rows).toHaveLength(3);
    expect(rows[0]?.payload).toMatchObject({
      releaseId: third.id,
      lang: 'de',
      code: 'pdf-accessibility',
    });
    // The previous release's German PDF is still the latest good one.
    const previous = await outputs(second.id, '?filter[lang]=de');
    expect(previous.data.every((o) => o.attributes.state === 'done')).toBe(
      true,
    );
    expect((await file(previous.data[0]?.links.file as string)).status).toBe(
      200,
    );
    // The ZIP holds the six done and says three are left out.
    const partial = await archive(third.id);
    expect(partial.status).toBe(200);
    expect(partial.headers['x-ccms-archive-files']).toBe('6');
    expect(partial.headers['x-ccms-archive-left-out']).toBe('3');
    expect(
      Object.keys(unzipSync(partial.body as Buffer)).some((n) =>
        n.includes('/de/'),
      ),
    ).toBe(false);
    const failedOne = failed.data[0];
    t.actAs(READER);
    expect(
      (await t.get(`/releases/${third.id}/outputs/${failedOne?.id}/file`))
        .status,
    ).toBe(409);

    // Retrying: only a publisher of the product, only a failed output.
    t.actAs(READER);
    const forbidden = await t
      .post(`/releases/${third.id}/outputs/${failedOne?.id}/retry`)
      .send();
    expect(forbidden.status).toBe(403);
    // A publisher of the product by its facet reads no output: retrying
    // answers only where the output stands, nothing of it (#340).
    const regionPublisher = user(
      'region-publisher',
      ['content.read', 'release.publish'],
      { facets: { region: ['north'] } },
    );
    t.actAs(regionPublisher);
    const narrow = await t
      .post(`/releases/${third.id}/outputs/${failedOne?.id}/retry`)
      .send();
    expect(narrow.status).toBe(202);
    ReleaseOutputDocument.parse(narrow.body);
    expect(narrow.body.data).toEqual({
      type: 'ReleaseOutput',
      id: failedOne?.id,
      attributes: { state: 'queued' },
      meta: { attempts: failedOne?.meta.attempts, retries: 1 },
      links: { file: null },
    });
    // A publisher who reads the whole manual gets it in full.
    const failedTwo = failed.data[1];
    t.actAs(publisher);
    const retried = await t
      .post(`/releases/${third.id}/outputs/${failedTwo?.id}/retry`)
      .send();
    expect(retried.status).toBe(202);
    expect(ReleaseOutputDocument.parse(retried.body).data).toMatchObject({
      id: failedTwo?.id,
      attributes: {
        manual: failedTwo?.attributes.manual,
        variant: failedTwo?.attributes.variant,
        lang: 'de',
        state: 'queued',
        error: null,
      },
      meta: { retries: 1, withdrawn: false },
    });
    const twice = await t
      .post(`/releases/${third.id}/outputs/${failedOne?.id}/retry`)
      .send();
    expect(twice.status).toBe(409);
    expect(codeOf(twice.body)).toBe('output-not-failed');
    expect(await progress(third.id)).toMatchObject({
      state: 'rendering',
      queued: 2,
      failed: 1,
    });
    await t.runJobs();
    // Both fail again, and that is told again.
    expect(
      await t.database.db
        .select()
        .from(outbox)
        .where(eq(outbox.topic, 'release.output-failed')),
    ).toHaveLength(5);
  });

  it('tells the publishers of a failed output, then that it is ready after all once a late file finishes it (#551)', async () => {
    const watcher = user('output-publisher', [
      'content.read',
      'release.publish',
    ]);
    await seedAccess(
      t.database,
      Seed.parse({
        roles: watcher.roles.map((r) => ({ ...r, id: `watcher-${r.id}` })),
        users: [
          {
            id: watcher.id,
            name: watcher.id,
            roles: watcher.roles.map((r) => `watcher-${r.id}`),
          },
        ],
      }),
    );
    // An attempt under way, with no file to reuse.
    const id = (await outputs(second.id)).data[0]?.id as string;
    await t.database.db
      .update(releaseOutputs)
      .set({ state: 'rendering', sha256: null, size: null, reuseGroup: null })
      .where(eq(releaseOutputs.id, id));
    // Its job gives up on it (failed for good) while the attempt still renders.
    const pdf = t.app.get(RenderManualPdfAction);
    const render = pdf.handle.bind(pdf);
    const spy = vi.spyOn(pdf, 'handle').mockImplementationOnce(async (q) => {
      await t.app
        .get(FailReleaseOutputAction)
        .handle({ outputId: id, retries: 0 });
      return render(q);
    });
    const queue = t.app.get(JobQueue);
    await queue.enqueue(
      RENDER_RELEASE_OUTPUT,
      { outputId: id, retries: 0 },
      { key: `${id}/late` },
    );
    await t.runJobs();
    spy.mockRestore();
    // The late file finished it.
    const [row] = await t.database.db
      .select()
      .from(releaseOutputs)
      .where(eq(releaseOutputs.id, id));
    expect(row?.state).toBe('done');
    const told = await t.database.db
      .select()
      .from(outbox)
      .where(sql`${outbox.payload}->>'outputId' = ${id}`);
    expect(told.map((r) => r.topic)).toEqual([
      'release.output-failed',
      'release.output-recovered',
    ]);
    // What the publisher reads in the end: failed, then ready after all.
    await t.app.get(NotificationsConsumer).runOnce();
    t.actAs(watcher);
    const inbox = await t.get('/me/notifications?page[size]=100');
    expect(inbox.status).toBe(200);
    const kinds = NotificationPageDocument.parse(inbox.body)
      .data.filter((n) => n.attributes.subject.id === second.id)
      .map((n) => n.attributes.kind);
    expect(kinds.sort()).toEqual([
      'release.output-failed',
      'release.output-recovered',
    ]);
  });

  it('plans a release again for a publisher, adding nothing it has', async () => {
    const before = (await outputs(second.id)).meta.page.total;
    t.actAs(READER);
    expect(
      (await t.post(`/releases/${second.id}/outputs/plan`).send()).status,
    ).toBe(403);
    t.actAs(publisher);
    const res = await t.post(`/releases/${second.id}/outputs/plan`).send();
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ meta: { queued: true } });
    expect((await progress(second.id))?.state).toBe('planning');
    await t.runJobs();
    expect((await progress(second.id))?.state).toBe('done');
    expect((await outputs(second.id)).meta.page.total).toBe(before);
  });

  it('keeps a withdrawn release’s outputs readable, marked withdrawn', async () => {
    t.actAs(publisher);
    const res = await t
      .post(`/releases/${second.id}/withdraw`)
      .send(JSON.stringify({ meta: { reason: 'Wrong charging text.' } }));
    expect(res.status).toBe(200);
    const page = await outputs(second.id);
    expect(page.data.every((o) => o.meta.withdrawn)).toBe(true);
    expect((await file(page.data[0]?.links.file as string)).status).toBe(200);
  });

  it('shows where a release’s files wait behind a later release’s, moves one asked for ahead, and plans the rest again (#497)', async () => {
    const older = await cut('9.0');
    const newer = await cut('9.1');
    await t.runJobs();
    // Their files waiting to render, none with a job yet: a backlog.
    const back = (releaseId: string) =>
      t.database.db
        .update(releaseOutputs)
        .set({
          state: 'queued',
          sha256: null,
          size: null,
          reusedFromRelease: null,
          reusedFromOutput: null,
          finishedAt: null,
          scheduledAt: null,
        })
        .where(eq(releaseOutputs.releaseId, releaseId))
        .returning();
    const olderRows = await back(older.id);
    const newerRows = await back(newer.id);
    expect(olderRows).toHaveLength(9);
    expect(await progress(older.id, publisher)).toMatchObject({
      state: 'rendering',
      queued: 9,
      queue: { ahead: newerRows.length },
    });
    // The count is of every manual: a publisher of the product's only.
    expect((await progress(older.id, publicReader))?.queue).toBeNull();
    expect((await progress(newer.id, publisher))?.queue).toBeNull();

    // Asked for before it is rendered: still 409, and its job goes first.
    const [wanted] = (await outputs(older.id, '?filter[lang]=en')).data;
    const res = await file(`/releases/${older.id}/outputs/${wanted?.id}/file`);
    expect(res.status).toBe(409);
    expect(codeOf(res.body)).toBe('output-not-ready');
    const { rows } = await t.database.db.execute<{ priority: number }>(
      sql`select priority from pgboss.job where name = ${RENDER_RELEASE_OUTPUT.name} and singleton_key = ${wanted?.id} and state = 'created'`,
    );
    expect(rows.map((r) => r.priority)).toEqual([PROMOTED_PRIORITY]);

    // Planned again: the waiting files get their jobs, and every file is made.
    t.actAs(publisher);
    expect(
      (await t.post(`/releases/${newer.id}/outputs/plan`).send()).status,
    ).toBe(202);
    await t.runJobs();
    for (const id of [older.id, newer.id]) {
      const page = await outputs(id, '', publisher);
      expect(
        page.data.filter((o) =>
          ['queued', 'rendering'].includes(o.attributes.state),
        ),
      ).toEqual([]);
    }
    expect((await progress(older.id, publisher))?.queue).toBeNull();
  });

  it('plans releases strictly in the order cut, and tells a publisher of the newer one how many earlier ones go first (#527)', async () => {
    // Content every file can be made of (an earlier test left a character no font shows).
    await changeGerman('lädt sich wieder auf.');
    const older = await cut('10.0');
    const newer = await cut('10.1');
    // Neither planned yet: the newer one waits for the older one.
    expect(await progress(newer.id, publisher)).toMatchObject({
      state: 'planning',
      queue: { ahead: 0, releases: 1 },
    });
    expect((await progress(older.id, publisher))?.queue).toBeNull();
    expect((await progress(newer.id, publicReader))?.queue).toBeNull();
    // The newer one's job is claimed first (newest first) and plans the older one before it.
    await t.runJobs();
    expect((await progress(older.id, publisher))?.state).toBe('done');
    expect((await progress(newer.id, publisher))?.state).toBe('done');
    const olderPage = await outputs(older.id, '', publisher);
    const newerPage = await outputs(newer.id, '', publisher);
    expect(newerPage.data).toHaveLength(olderPage.data.length);
    // Nothing changed between them: every file of the newer one is a file made once.
    expect(newerPage.data.every((o) => o.meta.reusedFrom !== null)).toBe(true);
  });

  it('answers 404 for an unknown release or output', async () => {
    t.actAs(READER);
    const none = '00000000-0000-7000-8000-000000000000';
    expect((await t.get(`/releases/${none}/outputs`)).status).toBe(404);
    expect(
      (await t.get(`/releases/${first.id}/outputs/${none}/file`)).status,
    ).toBe(404);
    expect(
      (await t.get(`/releases/${first.id}/outputs/nope/file`)).status,
    ).toBe(404);
  });
});
