import { eq, sql } from 'drizzle-orm';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import { type NewRelease, newReleaseId } from '../core/release.js';
import { DrizzleReleaseStore } from './drizzle-release-store.js';
import { releases, releaseWithdrawals } from './releases.tables.js';

const COMMIT = 'a'.repeat(40);
const TAG_OBJECT = 'b'.repeat(40);

let at = Date.parse('2026-03-01T10:00:00Z');
const release = (over: Partial<NewRelease> = {}): NewRelease => {
  at += 1000;
  const product = over.product ?? 'north';
  const revision = over.revision ?? '1.0';
  return {
    id: newReleaseId(at),
    product,
    productFacet: 'region',
    revision,
    tag: `release/${product}/${revision}`,
    commit: COMMIT,
    notes: 'What changed.',
    notesByLanguage: {},
    major: false,
    publishedBy: { kind: 'user', id: 'sample-publisher' },
    publishedAt: new Date(at),
    ...over,
  };
};

describe('DrizzleReleaseStore', () => {
  let database: PgliteDatabase;
  let store: DrizzleReleaseStore;
  let unit: DrizzleUnitOfWork;
  const all = { number: 1, size: 50 };

  beforeEach(async () => {
    database = await createTestDatabase();
    store = new DrizzleReleaseStore(database);
    unit = new DrizzleUnitOfWork(database);
  });
  afterEach(() => database?.close());

  const reserve = (r: NewRelease) => unit.run((tx) => store.reserve(tx, r));
  const publish = (id: string, tagObject = TAG_OBJECT) =>
    unit.run((tx) => store.publish(tx, id, tagObject));

  it('reserves, then publishes; only published releases are read and listed', async () => {
    const first = release();
    expect(await reserve(first)).toBe(true);
    expect(await store.find(first.id)).toBeUndefined();
    expect(await store.list({}, all)).toEqual({ total: 0, items: [] });
    expect(await store.findByName('north', '1.0', first.tag)).toEqual({
      ...first,
      tagObject: null,
    });
    expect(await publish(first.id)).toBe(true);
    expect(await publish(first.id)).toBe(false);
    expect(await store.find(first.id)).toEqual({
      ...first,
      tagObject: TAG_OBJECT,
      withdrawal: null,
    });
    expect(await store.find('not-a-uuid')).toBeUndefined();
  });

  it('holds a name once: product and revision, or the tag in any case', async () => {
    const first = release();
    expect(await reserve(first)).toBe(true);
    expect(await reserve(release())).toBe(false);
    expect(
      await reserve(release({ revision: '2.0', tag: first.tag.toUpperCase() })),
    ).toBe(false);
    expect(await reserve(release({ revision: '2.0' }))).toBe(true);
    expect(await database.db.$count(releases)).toBe(2);
    expect(
      (await store.findByName('south', '9', 'RELEASE/NORTH/1.0'))?.id,
    ).toBe(first.id);
  });

  it('lists newest first, filtered by product, paged', async () => {
    const made = [
      release({ revision: '1' }),
      release({ product: 'south', revision: '1' }),
      release({ revision: '2' }),
    ];
    for (const r of made) {
      await reserve(r);
      await publish(r.id);
    }
    await reserve(release({ revision: '3' }));
    const listed = await store.list({}, all);
    expect(listed.total).toBe(3);
    expect(listed.items.map((r) => `${r.product}/${r.revision}`)).toEqual([
      'north/2',
      'south/1',
      'north/1',
    ]);
    const north = await store.list(
      { product: 'north' },
      { number: 2, size: 1 },
    );
    expect(north.total).toBe(2);
    expect(north.items.map((r) => r.revision)).toEqual(['1']);
  });

  it('keeps notes per language and major, and filters by major', async () => {
    const major = release({
      revision: '1',
      notesByLanguage: { de: 'Was sich änderte.' },
      major: true,
    });
    const minor = release({ revision: '2' });
    for (const r of [major, minor]) {
      await reserve(r);
      await publish(r.id);
    }
    expect(await store.find(major.id)).toMatchObject({
      notesByLanguage: { de: 'Was sich änderte.' },
      major: true,
    });
    expect(
      (await store.list({ major: true }, all)).items.map((r) => r.id),
    ).toEqual([major.id]);
    expect(
      (await store.list({ major: false }, all)).items.map((r) => r.id),
    ).toEqual([minor.id]);
  });

  it('withdraws once, keeps the release, and finds the previous release that stands', async () => {
    const [one, two, three, other] = [
      release({ revision: '1' }),
      release({ revision: '2' }),
      release({ revision: '3' }),
      release({ product: 'south', revision: '1' }),
    ];
    for (const r of [one, two, three, other]) {
      await reserve(r);
      await publish(r.id);
    }
    expect((await store.previous(three))?.id).toBe(two.id);
    expect(await store.previous(one)).toBeUndefined();
    const withdrawal = {
      by: { kind: 'user' as const, id: 'sample-publisher' },
      at: new Date('2026-03-02T10:00:00Z'),
      reason: 'Wrong torque values.',
    };
    expect(await unit.run((tx) => store.withdraw(tx, two.id, withdrawal))).toBe(
      true,
    );
    expect(
      await unit.run((tx) =>
        store.withdraw(tx, two.id, { ...withdrawal, reason: 'Again.' }),
      ),
    ).toBe(false);
    expect(await store.find(two.id)).toEqual({
      ...two,
      tagObject: TAG_OBJECT,
      withdrawal,
    });
    expect(
      (await store.list({}, all)).items.find((r) => r.id === two.id),
    ).toMatchObject({ withdrawal });
    expect((await store.previous(three))?.id).toBe(one.id);
    const withdrawn = await store.list({ withdrawn: true }, all);
    expect(withdrawn.items.map((r) => r.id)).toEqual([two.id]);
    expect(withdrawn.total).toBe(1);
    const standing = await store.list(
      { withdrawn: false, product: 'north' },
      all,
    );
    expect(standing.items.map((r) => r.id)).toEqual([three.id, one.id]);
    expect(standing.total).toBe(2);
    // Final, held by the database.
    await expect(
      database.db
        .update(releaseWithdrawals)
        .set({ reason: 'rewritten' })
        .where(eq(releaseWithdrawals.releaseId, two.id)),
    ).rejects.toMatchObject({ cause: { message: /withdrawal is final/ } });
    await expect(
      database.db
        .delete(releaseWithdrawals)
        .where(eq(releaseWithdrawals.releaseId, two.id)),
    ).rejects.toMatchObject({ cause: { message: /withdrawal is final/ } });
    await expect(
      database.db.execute(sql`truncate release_withdrawals`),
    ).rejects.toThrow();
  });

  it('lists the product’s published releases cut after one, withdrawn ones too, oldest first (#497)', async () => {
    const [one, two, three, four, other] = [
      release({ revision: '1' }),
      release({ revision: '2' }),
      release({ revision: '3' }),
      release({ revision: '4' }),
      release({ product: 'south', revision: '1' }),
    ];
    for (const r of [one, two, three, other]) {
      await reserve(r);
      await publish(r.id);
    }
    // Reserved only: not published, not listed.
    await reserve(four);
    await unit.run((tx) =>
      store.withdraw(tx, two.id, {
        by: { kind: 'user', id: 'sample-publisher' },
        at: new Date(),
        reason: 'Wrong.',
      }),
    );
    expect((await store.after(one, 10)).map((r) => r.id)).toEqual([
      two.id,
      three.id,
    ]);
    expect((await store.after(one, 1)).map((r) => r.id)).toEqual([two.id]);
    expect(await store.after(three, 10)).toEqual([]);
    // Before: the nearest ones, oldest first (#527).
    expect((await store.before(three, 10)).map((r) => r.id)).toEqual([
      one.id,
      two.id,
    ]);
    expect((await store.before(three, 1)).map((r) => r.id)).toEqual([two.id]);
    expect(await store.before(one, 10)).toEqual([]);
  });

  it('drops a reservation, never a published release', async () => {
    const reserved = release({ revision: '1' });
    const published = release({ revision: '2' });
    await reserve(reserved);
    await reserve(published);
    await publish(published.id);
    await unit.run(async (tx) => {
      await store.discard(tx, reserved.id);
      await store.discard(tx, published.id);
    });
    expect(
      (await database.db.select({ id: releases.id }).from(releases)).map(
        (r) => r.id,
      ),
    ).toEqual([published.id]);
  });

  it('refuses to change or delete a published release at the database', async () => {
    const published = release({ revision: '1' });
    const reserved = release({ revision: '2' });
    await reserve(published);
    await publish(published.id);
    await reserve(reserved);
    const { db } = database;
    await expect(
      db
        .update(releases)
        .set({ notes: 'rewritten' })
        .where(eq(releases.id, published.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(releases)
        .set({ tagObject: 'c'.repeat(40) })
        .where(eq(releases.id, published.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(releases).where(eq(releases.id, published.id)),
    ).rejects.toThrow();
    await expect(db.execute(sql`truncate releases`)).rejects.toThrow();
    // A reservation may only be published: nothing else of it changes.
    await expect(
      db
        .update(releases)
        .set({ tagObject: TAG_OBJECT, commit: 'd'.repeat(40) })
        .where(eq(releases.id, reserved.id)),
    ).rejects.toThrow();
    await expect(
      database.client.query(
        `delete from releases where tag_object is not null`,
      ),
    ).rejects.toThrow(/is published: DELETE is not allowed/);
    expect(await store.find(published.id)).toEqual({
      ...published,
      tagObject: TAG_OBJECT,
      withdrawal: null,
    });
    expect(await db.$count(releases)).toBe(2);
  });

  it('refuses malformed rows in the database itself', async () => {
    const insert = (over: Partial<typeof releases.$inferInsert>) =>
      database.db.insert(releases).values({
        id: newReleaseId(),
        product: 'north',
        productFacet: 'region',
        revision: '1',
        tag: 'release/north/1',
        commit: COMMIT,
        publishedByKind: 'user',
        publishedById: 'someone',
        publishedAt: new Date(),
        ...over,
      });
    await expect(insert({ revision: '1..2' })).rejects.toThrow();
    await expect(insert({ product: 'North' })).rejects.toThrow();
    await expect(insert({ tag: 'refs/tags/x' })).rejects.toThrow();
    await expect(insert({ commit: 'main' })).rejects.toThrow();
    await expect(insert({ notes: '' })).rejects.toThrow();
    await expect(insert({ publishedByKind: 'robot' })).rejects.toThrow();
    await expect(insert({})).resolves.toBeDefined();
  });
});
