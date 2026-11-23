import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { sql } from 'drizzle-orm';
import { DrizzleAssetUploads } from '../../assets/repos/drizzle-asset-uploads.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import {
  drizzleOf,
  DrizzleUnitOfWork,
} from '../../database/drizzle-unit-of-work.js';
import { newReleaseId } from '../core/release.js';
import { newOutputId } from '../core/release-output.js';
import { DrizzleReleaseOutputStore } from './drizzle-release-output-store.js';
import { DrizzleReleaseStore } from './drizzle-release-store.js';

describe('DrizzleReleaseOutputStore refusals (#477)', () => {
  let database: PgliteDatabase;
  let outputs: DrizzleReleaseOutputStore;
  let unit: DrizzleUnitOfWork;
  let releaseId: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    outputs = new DrizzleReleaseOutputStore(database);
    unit = new DrizzleUnitOfWork(database);
    const releases = new DrizzleReleaseStore(database);
    releaseId = newReleaseId(Date.parse('2026-03-01T10:00:00Z'));
    await unit.run((tx) =>
      releases.reserve(tx, {
        id: releaseId,
        product: 'north',
        productFacet: 'region',
        revision: '1.0',
        tag: 'release/north/1.0',
        commit: 'a'.repeat(40),
        notes: null,
        notesByLanguage: {},
        major: false,
        publishedBy: { kind: 'user', id: 'sample-publisher' },
        publishedAt: new Date(),
      }),
    );
  });
  afterEach(() => database?.close());

  const tooMany = (wanted: number, max: number) =>
    ({ reason: 'too-many-outputs', wanted, max }) as const;

  it('records a refusal once, replaces it for another limit and forgets it in a transaction', async () => {
    expect(await outputs.refusal(releaseId)).toBeUndefined();
    expect(await outputs.refusal('not-a-uuid')).toBeUndefined();
    expect(await outputs.refuse(releaseId, tooMany(12, 10))).toBe(true);
    // The same again: nothing new to tell.
    expect(await outputs.refuse(releaseId, tooMany(12, 10))).toBe(false);
    expect(await outputs.refusal(releaseId)).toMatchObject(tooMany(12, 10));
    expect(await outputs.refuse(releaseId, tooMany(12, 11))).toBe(true);
    expect(await outputs.refusal(releaseId)).toMatchObject(tooMany(12, 11));
    // Rolled back: kept.
    await expect(
      unit.run(async (tx) => {
        await outputs.clearRefusal(tx, releaseId);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await outputs.refusal(releaseId)).toBeDefined();
    await unit.run((tx) => outputs.clearRefusal(tx, releaseId));
    expect(await outputs.refusal(releaseId)).toBeUndefined();
    // Refused again once forgotten: recorded anew.
    expect(await outputs.refuse(releaseId, tooMany(12, 11))).toBe(true);
  });
});

describe('DrizzleReleaseOutputStore scheduling and reuse groups (#497)', () => {
  let database: PgliteDatabase;
  let outputs: DrizzleReleaseOutputStore;
  let unit: DrizzleUnitOfWork;
  let releases: DrizzleReleaseStore;

  beforeEach(async () => {
    database = await createTestDatabase();
    outputs = new DrizzleReleaseOutputStore(database);
    unit = new DrizzleUnitOfWork(database);
    releases = new DrizzleReleaseStore(database);
  });
  afterEach(() => database?.close());

  /** A release cut at `at`, with `count` queued outputs in group `group(i)` (default: each its own). */
  async function release(
    revision: string,
    at: string,
    count: number,
    group?: (i: number, id: string) => string,
    product = 'north',
  ) {
    const id = newReleaseId(Date.parse(at));
    await unit.run((tx) =>
      releases.reserve(tx, {
        id,
        product,
        productFacet: 'region',
        revision,
        tag: `release/${product}/${revision}`,
        commit: 'a'.repeat(40),
        notes: null,
        notesByLanguage: {},
        major: false,
        publishedBy: { kind: 'user', id: 'sample-publisher' },
        publishedAt: new Date(at),
      }),
    );
    const rows = Array.from({ length: count }, (_, i) => {
      const outputId = newOutputId();
      return {
        id: outputId,
        releaseId: id,
        manualId: `m${String(i).padStart(3, '0')}`,
        variant: 'model=large',
        lang: 'en',
        kind: 'pdf' as const,
        audience: null,
        state: 'queued' as const,
        sha256: null,
        size: null,
        reusedFrom: null,
        reuseGroup: group?.(i, outputId) ?? outputId,
        qrCode: null,
      };
    });
    await unit.run((tx) => outputs.insertMissing(tx, rows));
    return {
      id,
      publishedAt: new Date(at),
      product,
      productFacet: 'region',
      rows,
    };
  }

  it('finds one manual’s output across releases (#139)', async () => {
    const one = await release('1.0', '2026-03-01T10:00:00Z', 2);
    const two = await release('2.0', '2026-03-02T10:00:00Z', 1);
    const of = {
      manualId: 'm000',
      variant: 'model=large',
      lang: 'en',
      kind: 'pdf' as const,
    };
    const found = await outputs.across([one.id, two.id, 'not-a-release'], of);
    expect(found.map((o) => o.id).sort()).toEqual(
      [one.rows[0]!.id, two.rows[0]!.id].sort(),
    );
    expect(
      await outputs.across([one.id], { ...of, manualId: 'm001' }),
    ).toHaveLength(1);
    expect(await outputs.across([two.id], { ...of, manualId: 'm001' })).toEqual(
      [],
    );
    expect(await outputs.across([one.id], { ...of, lang: 'de' })).toEqual([]);
    expect(await outputs.across([], of)).toEqual([]);
  });

  it('keeps an output’s QR code as planned (#450)', async () => {
    const r = await release('1.0', '2026-03-01T10:00:00Z', 1);
    const id = newOutputId();
    const qrCode = {
      url: 'https://docs.example.com/d/north/m/model=large/en',
      placement: 'back-cover' as const,
    };
    await unit.run((tx) =>
      outputs.insertMissing(tx, [
        { ...r.rows[0]!, id, manualId: 'with-qr', reuseGroup: id, qrCode },
      ]),
    );
    expect((await outputs.find(id))?.qrCode).toEqual(qrCode);
    expect((await outputs.find(r.rows[0]!.id))?.qrCode).toBeNull();
  });

  it('schedules a release’s outputs in list order, never more than the limit at once', async () => {
    const r = await release('1.0', '2026-03-01T10:00:00Z', 7);
    const first = await unit.run((tx) => outputs.schedule(tx, r.id, 3));
    expect(first.map((o) => o.manualId)).toEqual(['m000', 'm001', 'm002']);
    expect(first.every((o) => o.scheduledAt !== null)).toBe(true);
    // Full: nothing more until one ends.
    expect(await unit.run((tx) => outputs.schedule(tx, r.id, 3))).toEqual([]);
    expect((await outputs.scheduled(r.id)).map((o) => o.manualId)).toEqual([
      'm000',
      'm001',
      'm002',
    ]);
    // Rendering still counts; done does not.
    await outputs.start(first[0]!.id, 0);
    await outputs.finish(first[1]!.id, { sha256: 'b'.repeat(64), size: 2 });
    const next = await unit.run((tx) => outputs.schedule(tx, r.id, 3));
    expect(next.map((o) => o.manualId)).toEqual(['m003']);
    // Rolled back: not scheduled.
    await outputs.finish(first[2]!.id, { sha256: 'b'.repeat(64), size: 2 });
    await expect(
      unit.run(async (tx) => {
        await outputs.schedule(tx, r.id, 3);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(
      (await unit.run((tx) => outputs.schedule(tx, r.id, 3))).map(
        (o) => o.manualId,
      ),
    ).toEqual(['m004']);
  });

  it('moves an output up once, only while queued, and never more of a release than the limit at a time', async () => {
    const r = await release('1.0', '2026-03-01T10:00:00Z', 5);
    const [a, b, c, d, e] = r.rows;
    const promote = (id: string) =>
      unit.run((tx) => outputs.promote(tx, id, 2));
    // Scheduled already: moved up, its job the caller's to raise.
    await unit.run((tx) => outputs.schedule(tx, r.id, 1));
    expect(await promote(a!.id)).toMatchObject({
      output: { id: a!.id, state: 'queued' },
      scheduled: false,
    });
    expect(await promote(a!.id)).toBeUndefined();
    // Not scheduled yet: scheduled now, its job the caller's to queue.
    const second = await promote(b!.id);
    expect(second?.scheduled).toBe(true);
    expect(second?.output.scheduledAt).not.toBeNull();
    expect(second?.output.promotedAt).not.toBeNull();
    // The limit: a reader asking for every file moves only two at a time.
    expect(await promote(c!.id)).toBeUndefined();
    expect((await outputs.find(c!.id))?.scheduledAt).toBeNull();
    // One ends: room for the next.
    await outputs.finish(a!.id, { sha256: 'b'.repeat(64), size: 2 });
    expect((await promote(c!.id))?.output.id).toBe(c!.id);
    await outputs.finish(d!.id, { sha256: 'b'.repeat(64), size: 2 });
    expect(await promote(d!.id)).toBeUndefined();
    expect(await promote('nope')).toBeUndefined();
    // Rolled back: not moved up.
    await outputs.finish(b!.id, { sha256: 'b'.repeat(64), size: 2 });
    await expect(
      unit.run(async (tx) => {
        await outputs.promote(tx, e!.id, 2);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect((await outputs.find(e!.id))?.promotedAt).toBeNull();
  });

  it('finishes every output of a group still to render with one file, and finds a done one', async () => {
    const older = await release('1.0', '2026-03-01T10:00:00Z', 2);
    const newer = await release(
      '1.1',
      '2026-03-02T10:00:00Z',
      2,
      (i) => older.rows[i]!.id,
    );
    const member = newer.rows[0]!;
    expect(await outputs.doneIn(member)).toBeUndefined();
    // The group's oldest still to render is the one its file is made for.
    expect((await outputs.oldestPendingIn(member))?.id).toBe(older.rows[0]!.id);
    await outputs.finish(older.rows[0]!.id, {
      sha256: 'c'.repeat(64),
      size: 3,
    });
    expect((await outputs.oldestPendingIn(member))?.id).toBe(member.id);
    expect((await outputs.doneIn(member))?.id).toBe(older.rows[0]!.id);
    // Only for the very same inputs, whatever the group ID says.
    expect(
      await outputs.doneIn({ ...member, variant: 'model=small' }),
    ).toBeUndefined();
    const from = { releaseId: older.id, outputId: older.rows[0]!.id };
    expect(
      await outputs.finishGroup(
        { ...member, lang: 'de' },
        { sha256: 'c'.repeat(64), size: 3 },
        from,
      ),
    ).toEqual([]);
    expect(
      await outputs.finishGroup(
        member,
        { sha256: 'c'.repeat(64), size: 3 },
        from,
      ),
    ).toMatchObject([{ id: member.id, state: 'done' }]);
    expect(await outputs.find(member.id)).toMatchObject({
      state: 'done',
      sha256: 'c'.repeat(64),
      size: 3,
      reusedFrom: from,
    });
    // The other group is left alone.
    expect((await outputs.find(older.rows[1]!.id))?.state).toBe('queued');
    expect((await outputs.find(newer.rows[1]!.id))?.state).toBe('queued');
  });

  it('finishes an output once, saying what it was: a failed one a late file finishes, in a transaction (#551)', async () => {
    const r = await release('1.0', '2026-03-01T10:00:00Z', 1);
    const id = r.rows[0]!.id;
    await unit.run((tx) => outputs.fail(tx, id, undefined, 0));
    const file = { sha256: 'd'.repeat(64), size: 4 };
    // Rolled back: still failed.
    await expect(
      unit.run(async (tx) => {
        expect(await outputs.finish(id, file, tx)).toMatchObject({
          state: 'failed',
        });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect((await outputs.find(id))?.state).toBe('failed');
    const before = await unit.run((tx) => outputs.finish(id, file, tx));
    expect(before).toMatchObject({
      id,
      state: 'failed',
      error: { code: 'render-error' },
    });
    expect(await outputs.find(id)).toMatchObject({
      state: 'done',
      sha256: file.sha256,
      error: null,
    });
    // Done already: nothing.
    expect(await outputs.finish(id, file)).toBeUndefined();
  });

  /** The advisory locks `tx` holds now, as their keys. */
  async function advisoryLocks(tx: Transaction): Promise<string[]> {
    const result = await drizzleOf(tx).execute<{ key: string }>(
      sql`select ((classid::bigint << 32) | objid::bigint)::text as key from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted order by key`,
    );
    return result.rows.map((row) => row.key);
  }

  /** The keys of the hash locks `AssetUploads.lockHash` takes for `hashes`. */
  async function hashLocks(hashes: readonly string[]): Promise<string[]> {
    return unit.run(async (tx) => {
      await new DrizzleAssetUploads(database).lockHashes(tx, hashes);
      return advisoryLocks(tx);
    });
  }

  it('records a file under its hash lock, the one a file delete takes, for the output and its group’s members (#593)', async () => {
    const older = await release('1.0', '2026-03-01T10:00:00Z', 1);
    const newer = await release(
      '1.1',
      '2026-03-02T10:00:00Z',
      1,
      (i) => older.rows[i]!.id,
    );
    const file = { sha256: 'e'.repeat(64), size: 5 };
    const expected = await hashLocks([file.sha256]);
    expect(expected).toHaveLength(1);
    expect(await hashLocks([file.sha256, 'f'.repeat(64)])).toHaveLength(2);
    const from = { releaseId: older.id, outputId: older.rows[0]!.id };
    const held = await unit.run(async (tx) => {
      expect(await advisoryLocks(tx)).toEqual([]);
      await outputs.finish(older.rows[0]!.id, file, tx);
      const afterFinish = await advisoryLocks(tx);
      const members = await outputs.finishGroup(newer.rows[0]!, file, from, tx);
      expect(members.map((m) => m.id)).toEqual([newer.rows[0]!.id]);
      return { afterFinish, afterGroup: await advisoryLocks(tx) };
    });
    expect(held).toEqual({ afterFinish: expected, afterGroup: expected });
    // A group's members alone, as a reuse records them: under the lock too.
    const third = await release(
      '1.2',
      '2026-03-03T10:00:00Z',
      1,
      (i) => older.rows[i]!.id,
    );
    expect(
      await unit.run(async (tx) => {
        await outputs.finishGroup(third.rows[0]!, file, from, tx);
        return advisoryLocks(tx);
      }),
    ).toEqual(expected);
    expect(await outputs.find(third.rows[0]!.id)).toMatchObject({
      state: 'done',
      sha256: file.sha256,
    });
    // Let go of with the transaction; and without one, each takes its own.
    expect(await unit.run((tx) => advisoryLocks(tx))).toEqual([]);
    const fourth = await release(
      '1.3',
      '2026-03-04T10:00:00Z',
      1,
      (i) => older.rows[i]!.id,
    );
    expect(await outputs.finishGroup(fourth.rows[0]!, file, from)).toHaveLength(
      1,
    );
  });

  it('fills a group forward only: a file never goes to a release cut before its own', async () => {
    const older = await release('1.0', '2026-03-01T10:00:00Z', 1);
    const newer = await release(
      '1.1',
      '2026-03-02T10:00:00Z',
      1,
      () => older.rows[0]!.id,
    );
    const [o] = older.rows;
    const [n] = newer.rows;
    // The newer one rendered first: the older one keeps rendering its own.
    await outputs.finish(n!.id, { sha256: 'e'.repeat(64), size: 5 });
    expect(
      await outputs.finishGroup(
        n!,
        { sha256: 'e'.repeat(64), size: 5 },
        { releaseId: newer.id, outputId: n!.id },
      ),
    ).toEqual([]);
    expect(await outputs.doneIn(o!)).toBeUndefined();
    expect((await outputs.find(o!.id))?.state).toBe('queued');
    // The older one's file does serve the newer one.
    expect((await outputs.doneIn(n!))?.id).toBe(n!.id);
  });

  it('finds the releases whose outputs still to render stopped moving, the longest first', async () => {
    const a = await release('1.0', '2026-03-01T10:00:00Z', 2);
    const b = await release('1.1', '2026-03-02T10:00:00Z', 1);
    const done = await release('1.2', '2026-03-03T10:00:00Z', 1);
    await outputs.finish(done.rows[0]!.id, { sha256: 'f'.repeat(64), size: 6 });
    const later = new Date(Date.now() + 60_000);
    expect(await outputs.stalled(later, 10)).toEqual(
      expect.arrayContaining([a.id, b.id]),
    );
    expect(await outputs.stalled(later, 10)).not.toContain(done.id);
    // By release ID, page by page after a cursor.
    expect(await outputs.stalled(later, 1)).toEqual([a.id]);
    expect(await outputs.stalled(later, 1, a.id)).toEqual([b.id]);
    expect(await outputs.stalled(later, 1, b.id)).toEqual([]);
    expect(await outputs.stalled(new Date(Date.now() - 60_000), 10)).toEqual(
      [],
    );
  });

  it('keeps where the sweep stopped, moved by compare-and-swap (#527)', async () => {
    expect(await outputs.sweepCursor()).toEqual({ version: 0 });
    const id = '0190a3a0-0000-7000-8000-0000000000aa';
    expect(await outputs.moveSweepCursor(0, id)).toBe(true);
    // A second first move (another server, same reading) loses.
    expect(await outputs.moveSweepCursor(0, undefined)).toBe(false);
    expect(await outputs.sweepCursor()).toEqual({ after: id, version: 1 });
    expect(await outputs.moveSweepCursor(0, undefined)).toBe(false);
    expect(await outputs.moveSweepCursor(1, undefined)).toBe(true);
    expect(await outputs.sweepCursor()).toEqual({ version: 2 });
  });

  it('counts what later releases still render, ahead of a release', async () => {
    const older = await release('1.0', '2026-03-01T10:00:00Z', 3);
    const newer = await release('1.1', '2026-03-02T10:00:00Z', 4);
    const newest = await release('1.2', '2026-03-03T10:00:00Z', 2);
    expect(await outputs.ahead(older)).toBe(6);
    expect(await outputs.ahead(newer)).toBe(2);
    expect(await outputs.ahead(newest)).toBe(0);
    await outputs.start(newest.rows[0]!.id, 0);
    await outputs.finish(newest.rows[1]!.id, {
      sha256: 'd'.repeat(64),
      size: 4,
    });
    // Rendering counts, done does not.
    expect(await outputs.ahead(newer)).toBe(1);
  });

  it('tells which releases have outputs: planned, wholly or in part', async () => {
    const planned = await release('1.0', '2026-03-01T10:00:00Z', 2);
    const empty = await release('1.1', '2026-03-02T10:00:00Z', 0);
    expect(
      await outputs.planned([
        planned.id,
        empty.id,
        newReleaseId(),
        'not-a-uuid',
      ]),
    ).toEqual(new Set([planned.id]));
    expect(await outputs.planned([])).toEqual(new Set());
  });

  it('records a release planned to the end once, with the database’s time (#527)', async () => {
    const one = await release('1.0', '2026-03-01T10:00:00Z', 2);
    const two = await release('1.1', '2026-03-02T10:00:00Z', 2);
    expect(await outputs.plannedWholly([one.id, two.id])).toEqual(new Map());
    await outputs.markPlanned(one.id);
    const first = (await outputs.plannedWholly([one.id]))?.get(one.id);
    expect(first).toBeInstanceOf(Date);
    // Again: kept as it was.
    await outputs.markPlanned(one.id);
    const wholly = await outputs.plannedWholly([one.id, two.id, 'not-a-uuid']);
    expect([...wholly.keys()]).toEqual([one.id]);
    expect(wholly.get(one.id)).toEqual(first);
    expect(await outputs.plannedWholly([])).toEqual(new Map());
  });

  it('joins a group into another for the very same inputs only, in a transaction (#497)', async () => {
    const older = await release('1.0', '2026-03-01T10:00:00Z', 2);
    const newer = await release(
      '1.1',
      '2026-03-02T10:00:00Z',
      2,
      (i) => older.rows[i]!.id,
    );
    const into = newOutputId();
    const join = (
      over: Partial<
        Omit<(typeof older.rows)[number], 'audience'> & {
          audience: string | null;
        }
      > = {},
    ) => {
      const row = { ...older.rows[0]!, ...over };
      return {
        from: older.rows[0]!.id,
        into,
        manualId: row.manualId,
        variant: row.variant,
        lang: row.lang,
        kind: row.kind,
        audience: row.audience,
      };
    };
    const groupOf = async (id: string) => (await outputs.find(id))?.reuseGroup;
    // Another language or audience: not the same inputs, nothing moves.
    await unit.run((tx) =>
      outputs.joinGroups(tx, [join({ lang: 'de' }), join({ audience: 'x' })]),
    );
    expect(await groupOf(newer.rows[0]!.id)).toBe(older.rows[0]!.id);
    // Rolled back: nothing moves.
    await expect(
      unit.run(async (tx) => {
        await outputs.joinGroups(tx, [join()]);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await groupOf(newer.rows[0]!.id)).toBe(older.rows[0]!.id);
    await unit.run((tx) => outputs.joinGroups(tx, [join()]));
    // Both members of the group, and nothing else.
    expect(await groupOf(older.rows[0]!.id)).toBe(into);
    expect(await groupOf(newer.rows[0]!.id)).toBe(into);
    expect(await groupOf(newer.rows[1]!.id)).toBe(older.rows[1]!.id);
    // A file of the joined group serves every member, as any group's.
    await outputs.finish(older.rows[0]!.id, {
      sha256: 'e'.repeat(64),
      size: 5,
    });
    const member = (await outputs.find(newer.rows[0]!.id))!;
    expect((await outputs.doneIn(member))?.id).toBe(older.rows[0]!.id);
  });

  it('counts only the same product’s later releases', async () => {
    const north = await release('1.0', '2026-03-01T10:00:00Z', 3);
    await release('7.0', '2026-03-02T10:00:00Z', 5, undefined, 'south');
    expect(await outputs.ahead(north)).toBe(0);
    await release('1.1', '2026-03-03T10:00:00Z', 2);
    expect(await outputs.ahead(north)).toBe(2);
  });
});
