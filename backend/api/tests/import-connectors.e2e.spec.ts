import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Server } from 'node:http';
import {
  createTriggerListener,
  ImportApi,
  type ItemSource,
  type RunResult,
  RunQueue,
  runOnce,
  TRIGGER_SIGNATURE_HEADER,
  type TrackerItem,
  TrackerMapping,
  triggerSignatureHeader,
} from '@openfolia/connector-tracker';
import { parse as parseYaml } from 'yaml';
import type { Actor } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { mintServiceToken } from '../src/access/core/service-token.js';
import { roles } from '../src/access/repos/access.tables.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import {
  serviceAccountRoles,
  serviceAccounts,
  serviceTokens,
} from '../src/access/repos/service-accounts.tables.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

/**
 * An import connector (#141, `@openfolia/connector-tracker`) against the real
 * API over the sample repository: it talks to the API only through the
 * import format and the import routes, acting for a person who may import
 * (an import is a person's: a service account cannot hold `admin.roles`),
 * and what it imports lands in a change set in review. Nothing reaches the
 * default branch until a reviewer approves it and it is merged; a second run
 * over the same items writes nothing, a changed item becomes an update.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const FIXTURES = join(
  import.meta.dirname,
  '../../../connectors/tracker/src/fixtures',
);
const mapping = TrackerMapping.parse(
  parseYaml(readFileSync(join(FIXTURES, 'mapping.yaml'), 'utf8')),
);
const fixtureItems = (
  JSON.parse(readFileSync(join(FIXTURES, 'items.json'), 'utf8')) as {
    items: TrackerItem[];
  }
).items;

const READS: Permission[] = ['content.read', 'content.read.draft'];
const user = (id: string, permissions: Permission[]): Actor => ({
  ...actorWith([...READS, ...permissions]),
  id,
});
/** The person the connector acts for: they may import, nothing more. */
const importer = user('notes-importer', ['admin.roles', 'content.edit']);
const reviewer = user('notes-reviewer', ['content.review']);
const publisher = user('notes-publisher', ['release.publish']);

let t: TestApp;
let api: ImportApi;
let apiUrl: string;
let items: TrackerItem[] = fixtureItems;
const source: ItemSource = {
  name: 'items',
  items: async () => items,
};

beforeAll(async () => {
  t = await createTestApp();
  await t.app.listen(0, '127.0.0.1');
  apiUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  // The import's job and approvals look their people up again.
  const roleId = (a: Actor) => `${a.id}-role`;
  await seedAccess(
    t.database,
    Seed.parse({
      roles: [importer, reviewer].flatMap((a) =>
        a.roles.map((r) => ({ ...r, id: roleId(a) })),
      ),
      users: [importer, reviewer].map((a) => ({
        id: a.id,
        name: a.id,
        roles: [roleId(a)],
      })),
    }),
  );
  // The test app's token acting as the importer stands in for their session.
  api = new ImportApi({ baseUrl: apiUrl, credential: { bearer: TOKEN } });
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

/** One run of the connector, for the importer; its import's job runs while it waits. */
const run = () => {
  t.actAs(importer);
  return runOnce({
    source,
    mapping,
    api,
    pollMs: 1,
    wait: async () => {
      await t.runJobs();
    },
  });
};

const as = (actor: Actor, path: string) => {
  t.actAs(actor);
  return t.post(path).send('');
};

describe('the tracker connector against the API', () => {
  let changeSetId: string;

  it('imports the included items into a change set in review, as the person it acts for', async () => {
    const result = await run();
    expect(result).toMatchObject({
      outcome: 'imported',
      changeSetState: 'in-review',
      counts: { create: 3, update: 0, refuse: 0 },
    });
    if (result.outcome !== 'imported') return;
    changeSetId = result.changeSetId;
    const res = await t.get(`/change-sets/${changeSetId}`);
    expect(res.status).toBe(200);
    const doc = ChangeSetDocument.parse(res.body);
    expect(doc.data.attributes.state).toBe('in-review');
    expect(doc.data.attributes.author).toMatchObject({
      kind: 'user',
      id: importer.id,
    });
    // Nothing published: the default branch has none of it.
    expect((await t.get('/modules/en/charging')).status).toBe(200);
    for (const path of [
      '/modules/en/note-prj-101',
      '/modules/en/note-prj-102',
      '/manuals/release-notes',
    ]) {
      expect((await t.get(path)).status).toBe(404);
    }
  });

  it('cannot approve its own change set; a reviewer approves, a publisher merges', async () => {
    expect(
      (await as(importer, `/change-sets/${changeSetId}/approve`)).status,
    ).toBe(403);
    expect(
      (await as(reviewer, `/change-sets/${changeSetId}/approve`)).status,
    ).toBe(200);
    expect(
      (await as(publisher, `/change-sets/${changeSetId}/merge`)).status,
    ).toBe(200);
    t.actAs(reviewer);
    const module = await t.get('/modules/en/note-prj-101');
    expect(module.status).toBe(200);
    expect(JSON.stringify(module.body)).toContain('Faster charging');
  });

  it('writes nothing when it runs again over the same items', async () => {
    expect(await run()).toMatchObject({
      outcome: 'nothing-new',
      counts: { create: 0, update: 0 },
    });
  });

  it('imports a changed item as an update, into a new change set', async () => {
    items = fixtureItems.map((item) =>
      item.id === 'PRJ-101'
        ? {
            ...item,
            body: `${item.body}\n\nCharging now also works below 5 °C.`,
          }
        : item,
    );
    const result = await run();
    expect(result).toMatchObject({
      outcome: 'imported',
      changeSetState: 'in-review',
      counts: { create: 0, update: 1 },
    });
    if (result.outcome === 'imported') {
      expect(result.changeSetId).not.toBe(changeSetId);
    }
  });

  it('writes nothing while what changed is held by the change set in review', async () => {
    items = items.map((item) =>
      item.id === 'PRJ-101'
        ? { ...item, body: `${item.body}\n\nAnd above 40 °C.` }
        : item,
    );
    t.actAs(importer);
    const before = (await t.get('/change-sets?page[size]=100')).body.meta.page
      .total as number;
    const result = await run();
    expect(result).toMatchObject({
      outcome: 'held',
      held: [{ subject: 'module/en/note-prj-101' }],
    });
    // No import ran, so no change set was left behind.
    t.actAs(importer);
    expect(
      (await t.get('/change-sets?page[size]=100')).body.meta.page.total,
    ).toBe(before);
  });

  describe('triggered by the source (a signed webhook)', () => {
    const secret = 'webhook-secret-'.padEnd(48, 'x');
    const results: RunResult[] = [];
    let listener: Server;
    let triggerUrl: string;

    beforeAll(async () => {
      const queue = new RunQueue({
        run: async () => {
          results.push(await run());
        },
      });
      listener = createTriggerListener({ secret, queue });
      await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
      triggerUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/trigger`;
    });
    afterAll(
      () =>
        new Promise<void>((r) => {
          listener.close(() => r());
          listener.closeAllConnections();
        }),
    );

    const trigger = (body: string, header?: string) =>
      fetch(triggerUrl, {
        method: 'POST',
        body,
        headers: {
          [TRIGGER_SIGNATURE_HEADER]:
            header ??
            triggerSignatureHeader(secret, Math.floor(Date.now() / 1000), body),
        },
      });
    /** Answered at once; the run it queued ends later. */
    const triggered = async (body: string) => {
      const before = results.length;
      const res = await trigger(body);
      expect(res.status).toBe(202);
      await vi.waitFor(() => expect(results.length).toBe(before + 1), {
        timeout: 60_000,
      });
      return results[before] as RunResult;
    };

    it('runs on a signed trigger and keeps its outcomes: held while the change set is in review, then a new change set in review', async () => {
      const held = await triggered('{"item":"PRJ-101"}');
      expect(held).toMatchObject({
        outcome: 'held',
        held: [{ subject: 'module/en/note-prj-101' }],
      });
      if (held.outcome !== 'held') return;
      const inReview = held.held[0]?.changeSetId as string;
      expect(
        (await as(importer, `/change-sets/${inReview}/abandon`)).status,
      ).toBe(200);
      const imported = await triggered('{"item":"PRJ-101","again":true}');
      expect(imported).toMatchObject({
        outcome: 'imported',
        changeSetState: 'in-review',
        counts: { update: 1 },
      });
    });

    it('runs nothing for an unsigned, wrongly signed or replayed trigger', async () => {
      const before = results.length;
      expect((await trigger('{}', 't=1,v1=00')).status).toBe(401);
      expect(
        (
          await trigger(
            '{}',
            triggerSignatureHeader(
              'another-secret'.padEnd(48, 'y'),
              Math.floor(Date.now() / 1000),
              '{}',
            ),
          )
        ).status,
      ).toBe(401);
      const header = triggerSignatureHeader(
        secret,
        Math.floor(Date.now() / 1000),
        'replayed',
      );
      expect((await trigger('replayed', header)).status).toBe(202);
      expect((await trigger('replayed', header)).status).toBe(409);
      await vi.waitFor(() => expect(results.length).toBe(before + 1), {
        timeout: 60_000,
      });
      // The one accepted run: still held by the change set in review.
      expect(results[before]).toMatchObject({ outcome: 'held' });
    });
  });

  it("refuses a service account's token: an import is a person's", async () => {
    await t.database.db.insert(roles).values({
      id: 'connector-editor',
      name: 'Connector',
      permissions: ['content.edit', ...READS],
    });
    await t.database.db
      .insert(serviceAccounts)
      .values({ id: 'tracker-connector', name: 'Tracker connector' });
    await t.database.db.insert(serviceAccountRoles).values({
      serviceAccountId: 'tracker-connector',
      roleId: 'connector-editor',
    });
    const minted = mintServiceToken();
    await t.database.db.insert(serviceTokens).values({
      id: minted.id,
      serviceAccountId: 'tracker-connector',
      name: 'connector',
      secretHash: minted.secretHash,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    t.actAs(undefined);
    const result = runOnce({
      source,
      mapping,
      api: new ImportApi({
        baseUrl: apiUrl,
        credential: { bearer: minted.token },
      }),
    });
    await expect(result).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });
});
