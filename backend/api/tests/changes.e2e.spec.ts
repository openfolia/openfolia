import { execFileSync } from 'node:child_process';
import { eq, sql } from 'drizzle-orm';
import { GitWriter } from '@openfolia/content-repo';
import type { Actor, Scope } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { outbox } from '../src/change-sets/repos/outbox.tables.js';
import { ChangePageDocument } from '../src/changes/api/change.resources.js';
import { ChunkPageDocument } from '../src/chunks/api/chunk.resources.js';
import { releases } from '../src/releases/repos/releases.tables.js';
import { ReleaseDocument } from '../src/releases/api/release.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith(permissions, scope), id });
const publisher = user('sample-publisher', ['content.read', 'release.publish']);
/** Reads everything released; later narrowed to English. */
const consumer = user('rag-consumer', ['content.read']);
const narrowed = user('rag-consumer', ['content.read'], {
  languages: ['en'],
});
const other = user('other-consumer', ['content.read']);

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

type Page = ReturnType<typeof ChangePageDocument.parse>;
type Change = Page['data'][number];

const read = async (as: Actor, cursor?: string, size = 200): Promise<Page> => {
  t.actAs(as);
  const query = new URLSearchParams({ 'page[size]': String(size) });
  if (cursor !== undefined) query.set('page[cursor]', cursor);
  const res = await t.get(`/changes?${query.toString()}`);
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('private, no-store');
  return ChangePageDocument.parse(res.body);
};

/** Every event from `cursor` on, `size` per page, until up to date; calls `between` after the first page. */
const drain = async (
  as: Actor,
  cursor: string | undefined,
  size: number,
  between?: () => Promise<void>,
): Promise<{ events: Change[]; cursor: string }> => {
  const events: Change[] = [];
  let at = cursor;
  for (let i = 0; i < 500; i++) {
    const page = await read(as, at, size);
    expect(page.data.length).toBeLessThanOrEqual(size);
    events.push(...page.data);
    at = page.meta.page.cursor;
    expect(page.links.next).toContain(encodeURIComponent(at));
    if (i === 0 && between) await between();
    if (page.meta.upToDate) return { events, cursor: at };
  }
  throw new Error('The feed never caught up.');
};

const cut = async (revision: string) => {
  t.actAs(publisher);
  const res = await t.post('/releases').send(
    JSON.stringify({
      data: { type: 'Release', attributes: { product: 'north', revision } },
    }),
  );
  expect(res.status).toBe(201);
  // Tags are ordered by their date, to the second.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  return ReleaseDocument.parse(res.body).data;
};

const commit = async (
  message: string,
  changes: { path: string; content: string | null }[],
) => {
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: changes.map((c) =>
      c.content === null ? { path: c.path, delete: true } : c,
    ) as never,
    message,
    author: { name: 'Someone', email: 'someone@example.com' },
  });
};

const show = (path: string) => git('show', `main:${path}`) + '\n';

const chunksAt = async (as: Actor, tag: string) => {
  t.actAs(as);
  const res = await t.get(
    `/chunks?ref=${encodeURIComponent(tag)}&page[size]=200`,
  );
  expect(res.status).toBe(200);
  return ChunkPageDocument.parse(res.body).data;
};

const summary = (events: readonly Change[]) =>
  events.map((e) => {
    const d = e.attributes.data;
    return e.attributes.event.startsWith('chunk.')
      ? `${e.attributes.event} ${String(d['chunkId'])}${d['reason'] ? ` ${String(d['reason'])}` : ''}`
      : e.attributes.event;
  });

const codeOf = (body: unknown) => ErrorDocument.parse(body).errors[0]?.code;

describe('the change feed', () => {
  let start: string;
  let first: Awaited<ReturnType<typeof cut>>;

  it('starts empty before anything is released', async () => {
    const page = await read(consumer);
    expect(page.data).toEqual([]);
    expect(page.meta.upToDate).toBe(true);
    start = page.meta.page.cursor;
    // Short, opaque and of no use to anyone else.
    expect(start.length).toBeLessThan(2_048);
    expect(start).not.toContain('rag-consumer');
  });

  it('skips and repeats nothing across pages while releases are cut', async () => {
    first = await cut('1.0');
    let second: Awaited<ReturnType<typeof cut>> | undefined;
    const paged = await drain(consumer, start, 3, async () => {
      await commit('Reword charging', [
        {
          path: 'modules/en/charging.adoc',
          content: show('modules/en/charging.adoc').replace(
            'charges automatically',
            'charges by itself',
          ),
        },
      ]);
      second = await cut('1.1');
    });
    const ids = paged.events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Read again in one go from the same cursor: exactly the same events.
    const whole = await drain(consumer, start, 200);
    expect(whole.events.map((e) => e.id)).toEqual(ids);

    const chunks = await chunksAt(consumer, first.attributes.tag);
    const told = summary(paged.events);
    // The first release: its webhook events, then every chunk.
    const firstChunks = told
      .filter((s) => s.startsWith('chunk.'))
      .slice(0, chunks.length);
    expect(firstChunks).toEqual(chunks.map((c) => `chunk.upserted ${c.id}`));
    expect(told).toContain('manual.released');
    expect(told).toContain('module.released');
    // The second: only the chunks whose text changed (the reworded module, and those that include it).
    const later = paged.events.filter(
      (e) =>
        e.attributes.event.startsWith('chunk.') &&
        (e.attributes.data['release'] as { releaseId: string }).releaseId ===
          second?.id,
    );
    expect(later.map((e) => String(e.attributes.data['chunkId']))).toContain(
      'en/charging',
    );
    expect(later.every((e) => e.attributes.event === 'chunk.upserted')).toBe(
      true,
    );
    expect(later.length).toBeLessThan(chunks.length);
    if (!second) throw new Error('The second release was not cut.');
    const changed = (await chunksAt(consumer, second.attributes.tag)).find(
      (c) => c.id === 'en/charging',
    );
    expect(
      later.find((e) => e.attributes.data['chunkId'] === 'en/charging')
        ?.attributes.data['contentHash'],
    ).toBe(changed?.attributes.contentHash);
    start = paged.cursor;
  });

  it('gives a fresh consumer a snapshot first', async () => {
    const snapshot = await drain(other, undefined, 50);
    const tag = 'release/north/1.1';
    const chunks = await chunksAt(other, tag);
    expect(summary(snapshot.events)).toEqual(
      chunks.map((c) => `chunk.upserted ${c.id}`),
    );
    expect(
      snapshot.events.map((e) => e.attributes.data['contentHash']),
    ).toEqual(chunks.map((c) => c.attributes.contentHash));
    // Then nothing more until something happens.
    expect((await read(other, snapshot.cursor)).data).toEqual([]);
  });

  it('tells a reader whose scope narrowed what left it, and only them', async () => {
    const otherAt = (await drain(other, undefined, 200)).cursor;
    const all = await chunksAt(consumer, 'release/north/1.1');
    const visible = new Set(
      (await chunksAt(narrowed, 'release/north/1.1')).map((c) => c.id),
    );
    const hidden = all.map((c) => c.id).filter((id) => !visible.has(id));
    expect(hidden.length).toBeGreaterThan(0);
    const { events, cursor } = await drain(narrowed, start, 2);
    expect(summary(events)).toEqual(
      hidden.map((id) => `chunk.removed ${id} gone`),
    );
    // Nothing more, and nothing for anyone else.
    expect((await read(narrowed, cursor)).data).toEqual([]);
    expect((await read(other, otherAt)).data).toEqual([]);
    // Widened again: those chunks come back.
    const back = await drain(consumer, cursor, 200);
    expect(summary(back.events)).toEqual(
      hidden.map((id) => `chunk.upserted ${id}`),
    );
    start = back.cursor;
  });

  it('tells a deprecated and a deleted module as removed, per language', async () => {
    const charging = show('modules/en/charging.adoc');
    await commit('Deprecate charging, delete the internals', [
      {
        path: 'modules/en/charging.adoc',
        content: charging.replace(
          /^(:schema-version:.*)$/m,
          '$1\n:deprecated: No longer sold',
        ),
      },
      { path: 'modules/en/internals.adoc', content: null },
    ]);
    await cut('1.2');
    const { events, cursor } = await drain(consumer, start, 200);
    const removed = summary(events).filter((s) =>
      s.startsWith('chunk.removed'),
    );
    expect(removed).toEqual(
      expect.arrayContaining([
        'chunk.removed de/charging deprecated',
        'chunk.removed en/charging deprecated',
        'chunk.removed en/internals gone',
      ]),
    );
    start = cursor;
  });

  it('tells what a withdrawn release added as removed', async () => {
    await commit('Add a module', [
      {
        path: 'modules/en/extra.adoc',
        content: show('modules/en/safety-note.adoc'),
      },
    ]);
    const added = await cut('1.3');
    const before = await drain(consumer, start, 200);
    expect(summary(before.events)).toContain('chunk.upserted en/extra');
    t.actAs(publisher);
    const res = await t
      .post(`/releases/${added.id}/withdraw`)
      .send(JSON.stringify({ meta: { reason: 'Cut by mistake.' } }));
    expect(res.status).toBe(200);
    const after = await drain(consumer, before.cursor, 200);
    expect(summary(after.events)).toEqual([
      'release.withdrawn',
      'chunk.removed en/extra withdrawn',
    ]);
    start = after.cursor;
  });

  it('refuses another reader’s cursor, a changed one, a malformed one and other parameters', async () => {
    t.actAs(other);
    const theirs = await t.get(
      `/changes?page[cursor]=${encodeURIComponent(start)}`,
    );
    expect(theirs.status).toBe(400);
    expect(codeOf(theirs.body)).toBe('cursor-expired');
    const flipped = start.slice(0, -2) + (start.endsWith('AA') ? 'BB' : 'AA');
    t.actAs(consumer);
    const changed = await t.get(
      `/changes?page[cursor]=${encodeURIComponent(flipped)}`,
    );
    expect(changed.status).toBe(400);
    expect(codeOf(changed.body)).toBe('cursor-expired');
    const malformed = await t.get('/changes?page[cursor]=%7Bnot%7D');
    expect(malformed.status).toBe(400);
    expect(codeOf(malformed.body)).toBe('invalid-parameter');
    const number = await t.get('/changes?page[number]=2');
    expect(number.status).toBe(400);
    expect(codeOf(number.body)).toBe('unsupported-parameter');
    const size = await t.get('/changes?page[size]=0');
    expect(size.status).toBe(400);
    t.actAs(user('nobody', []));
    expect((await t.get('/changes')).status).toBe(403);
  });

  it('names a replacement only to a reader who may read it', async () => {
    const publicReader = user('public-consumer', ['content.read'], {
      maxAudience: 'public',
    });
    const theirs = (await drain(publicReader, undefined, 200)).cursor;
    const ours = (await drain(consumer, start, 200)).cursor;
    // As a merge into `main` writes it (#266), at a commit that has both.
    await t.database.db.insert(outbox).values({
      topic: 'module.deprecated',
      key: 'test/safety-note',
      payload: {
        moduleId: 'safety-note',
        lang: 'en',
        commit: first.attributes.commit,
        reason: 'Superseded',
        replacedBy: 'internals',
      },
    });
    const told = async (as: Actor, cursor: string) =>
      (await drain(as, cursor, 200)).events.map((e) => [
        e.attributes.event,
        e.attributes.data['replacedBy'],
      ]);
    expect(await told(consumer, ours)).toEqual([
      ['module.deprecated', 'internals'],
    ]);
    expect(await told(publicReader, theirs)).toEqual([
      ['module.deprecated', null],
    ]);
  });

  it('tells a deprecated manual only to a reader who may read it, naming the replacement only when they may read it too (#558)', async () => {
    const publicReader = user('public-manual-consumer', ['content.read'], {
      maxAudience: 'public',
    });
    const theirs = (await drain(publicReader, undefined, 200)).cursor;
    const ours = (await drain(consumer, start, 200)).cursor;
    // As a merge into `main` writes them (#266): a public and an internal manual.
    await t.database.db.insert(outbox).values([
      {
        topic: 'manual.deprecated',
        key: 'feed-test/operating',
        payload: {
          manualId: 'operating',
          reason: 'Merged.',
          replacedBy: 'service',
          changeSetId: 'feed-test',
          commit: first.attributes.commit,
        },
      },
      {
        topic: 'manual.deprecated',
        key: 'feed-test/service',
        payload: {
          manualId: 'service',
          reason: 'Merged.',
          replacedBy: null,
          changeSetId: 'feed-test',
          commit: first.attributes.commit,
        },
      },
    ]);
    const told = async (as: Actor, cursor: string) => {
      const { events, cursor: next } = await drain(as, cursor, 200);
      return {
        next,
        events: events.map((e) => [
          e.attributes.event,
          e.attributes.data['manualId'],
          e.attributes.data['replacedBy'],
        ]),
      };
    };
    const mine = await told(consumer, ours);
    expect(mine.events).toEqual(
      expect.arrayContaining([
        ['manual.deprecated', 'operating', 'service'],
        ['manual.deprecated', 'service', null],
      ]),
    );
    expect(mine.events).toHaveLength(2);
    expect((await told(publicReader, theirs)).events).toEqual([
      ['manual.deprecated', 'operating', null],
    ]);
    start = mine.next;
  });

  it('answers 410 cursor-gone for a cursor standing on a commit gone from the repository, and a fresh start resyncs (#558)', async () => {
    const german = user('gone-consumer', ['content.read'], {
      languages: ['de'],
    });
    const { cursor } = await drain(german, undefined, 200);
    // Push the chunks it read out of the kept states (the last 8), so they are read again.
    for (let i = 0; i < 8; i++) {
      await drain(
        user(`evicting-consumer-${i}`, ['content.read'], {
          languages: [`x${i}`],
        }),
        undefined,
        200,
      );
    }
    const standing = (
      await t.database.db
        .select({ id: releases.id, commit: releases.commit })
        .from(releases)
        .where(eq(releases.tag, 'release/north/1.2'))
    )[0];
    if (!standing) throw new Error('No release 1.2.');
    // Its commit gone, as after a history rewrite and a garbage collection: the
    // release names one the repository does not have (releases are immutable,
    // so only past their trigger).
    const pointAt = async (commit: string) => {
      await t.database.db.execute(
        sql`alter table releases disable trigger releases_immutable`,
      );
      try {
        await t.database.db
          .update(releases)
          .set({ commit })
          .where(eq(releases.id, standing.id));
      } finally {
        await t.database.db.execute(
          sql`alter table releases enable trigger releases_immutable`,
        );
      }
    };
    await pointAt('dead'.repeat(10));
    try {
      // Their scope widens: what they held at 1.2 is to be compared, and cannot be read.
      t.actAs(user('gone-consumer', ['content.read']));
      const res = await t.get(
        `/changes?page[cursor]=${encodeURIComponent(cursor)}`,
      );
      expect(res.status).toBe(410);
      expect(res.headers['content-type']).toContain('application/vnd.api+json');
      const [error] = ErrorDocument.parse(res.body).errors;
      expect(error).toMatchObject({
        status: '410',
        code: 'cursor-gone',
        source: { parameter: 'page[cursor]' },
      });
      // The documented resync: start again without a cursor.
      const fresh = await read(user('gone-consumer', ['content.read']));
      expect(fresh.meta.page.cursor).toBeTruthy();
    } finally {
      await pointAt(standing.commit);
    }
  });
});
