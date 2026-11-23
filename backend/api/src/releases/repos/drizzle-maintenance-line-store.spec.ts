import { eq, sql } from 'drizzle-orm';
import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import type { MaintenanceLine } from '../core/maintenance-line.js';
import { newMaintenanceLineId } from '../core/maintenance-line.js';
import { type NewRelease, newReleaseId } from '../core/release.js';
import { DrizzleMaintenanceLineStore } from './drizzle-maintenance-line-store.js';
import { DrizzleReleaseStore } from './drizzle-release-store.js';
import { maintenanceLines } from './maintenance-lines.tables.js';

const COMMIT = 'a'.repeat(40);
const PUBLISHER = { kind: 'user', id: 'sample-publisher' } as const;
let at = Date.parse('2026-03-01T10:00:00Z');
const release = (revision: string): NewRelease => {
  at += 1000;
  return {
    id: newReleaseId(at),
    product: 'north',
    productFacet: 'region',
    revision,
    tag: `release/north/${revision}`,
    commit: COMMIT,
    notes: null,
    notesByLanguage: {},
    major: false,
    publishedBy: PUBLISHER,
    publishedAt: new Date(at),
  };
};

describe('DrizzleMaintenanceLineStore', () => {
  let database: PgliteDatabase;
  let store: DrizzleMaintenanceLineStore;
  let releases: DrizzleReleaseStore;
  let unit: DrizzleUnitOfWork;
  const all = { number: 1, size: 50 };

  beforeEach(async () => {
    database = await createTestDatabase();
    store = new DrizzleMaintenanceLineStore(database);
    releases = new DrizzleReleaseStore(database);
    unit = new DrizzleUnitOfWork(database);
  });
  afterEach(() => database?.close());

  const published = async (revision: string) => {
    const r = release(revision);
    await unit.run(async (tx) => {
      await releases.reserve(tx, r);
      await releases.publish(tx, r.id, 'b'.repeat(40));
    });
    return r;
  };
  const lineOf = (base: NewRelease): MaintenanceLine => ({
    id: newMaintenanceLineId(),
    product: base.product,
    revision: base.revision,
    baseRelease: base.id,
    baseCommit: base.commit,
    branch: `maintenance/${base.product}/${base.revision}`,
    createdBy: PUBLISHER,
    createdAt: new Date(Math.floor(Date.now() / 1000) * 1000),
    closedAt: null,
    closedBy: null,
  });

  it('records a line once per release and per branch, reads and lists it', async () => {
    const base = await published('1.0');
    const line = lineOf(base);
    expect(await unit.run((tx) => store.insert(tx, line))).toBe(true);
    expect(
      await unit.run((tx) =>
        store.insert(tx, { ...line, id: newMaintenanceLineId() }),
      ),
    ).toBe(false);
    expect(await store.find(line.id)).toEqual(line);
    expect(await store.find('not-a-uuid')).toBeUndefined();
    expect(await store.findByBranch('MAINTENANCE/north/1.0')).toEqual(line);
    expect(await store.findByRelease(base.id)).toEqual(line);
    expect(await store.list({ product: 'north', state: 'open' }, all)).toEqual({
      total: 1,
      items: [line],
    });
    expect(await store.list({ state: 'closed' }, all)).toEqual({
      total: 0,
      items: [],
    });
  });

  it("finds a product's latest release (#450): the newest standing one of main, never a line's", async () => {
    expect(await releases.latest('north')).toBeUndefined();
    const one = await published('1.0');
    const two = await published('2.0');
    expect((await releases.latest('north'))?.id).toBe(two.id);
    expect(await releases.latest('south')).toBeUndefined();
    // A fix of 1.0 on its line, cut after 2.0: still not the latest.
    const line = lineOf(one);
    await unit.run((tx) => store.insert(tx, line));
    const fix = release('1.0.1');
    await unit.run(async (tx) => {
      await releases.reserve(tx, fix);
      await releases.publish(tx, fix.id, 'b'.repeat(40));
      await store.linkRelease(tx, line.id, fix.id);
    });
    expect((await releases.latest('north'))?.id).toBe(two.id);
    expect((await releases.findByRevision('north', '1.0.1'))?.id).toBe(fix.id);
    // The download centre's (#139): every product's latest, and main's releases newest first.
    expect((await releases.latestOfEach()).map((r) => r.id)).toEqual([two.id]);
    expect(await releases.mainLine('north', 5)).toMatchObject({
      releases: [{ id: two.id }, { id: one.id }],
      truncated: false,
    });
    expect(await releases.mainLine('north', 1)).toMatchObject({
      releases: [{ id: two.id }],
      truncated: true,
    });
    // Withdrawn: the one before it.
    await unit.run((tx) =>
      releases.withdraw(tx, two.id, {
        by: PUBLISHER,
        at: new Date(),
        reason: 'Wrong values.',
      }),
    );
    expect((await releases.latest('north'))?.id).toBe(one.id);
    expect((await releases.latestOfEach()).map((r) => r.id)).toEqual([one.id]);
    // Withdrawn ones are main's versions still.
    expect(
      (await releases.mainLine('north', 5)).releases.map((r) => r.id),
    ).toEqual([two.id, one.id]);
    expect(
      (await releases.findByRevision('north', '2.0'))?.withdrawal,
    ).not.toBeNull();
    expect(await releases.findByRevision('north', '9.9')).toBeUndefined();
    expect(await releases.findByRevision('south', '1.0')).toBeUndefined();
    // Reserved, not published: not there.
    const reserved = release('3.0');
    await unit.run((tx) => releases.reserve(tx, reserved));
    expect(await releases.findByRevision('north', '3.0')).toBeUndefined();
    expect((await releases.latest('north'))?.id).toBe(one.id);
  });

  it('closes once; the table refuses any other change, a delete and a truncate', async () => {
    const line = lineOf(await published('1.0'));
    await unit.run((tx) => store.insert(tx, line));
    const closing = { by: PUBLISHER, at: new Date() };
    expect(await unit.run((tx) => store.close(tx, line.id, closing))).toBe(
      true,
    );
    expect(await unit.run((tx) => store.close(tx, line.id, closing))).toBe(
      false,
    );
    expect((await store.find(line.id))?.closedAt).toEqual(expect.any(Date));
    await expect(
      database.db
        .update(maintenanceLines)
        .set({ closedAt: null, closedById: null, closedByKind: null })
        .where(eq(maintenanceLines.id, line.id)),
    ).rejects.toThrow();
    await expect(
      database.db
        .update(maintenanceLines)
        .set({ branch: 'maintenance/elsewhere' })
        .where(eq(maintenanceLines.id, line.id)),
    ).rejects.toThrow();
    await expect(
      database.db
        .delete(maintenanceLines)
        .where(eq(maintenanceLines.id, line.id)),
    ).rejects.toThrow();
    await expect(
      database.db.execute(sql`truncate maintenance_lines cascade`),
    ).rejects.toThrow();
    expect(await database.db.$count(maintenanceLines)).toBe(1);
  });

  it('links releases to a line, lists them, and counts a line’s previous within the line', async () => {
    const base = await published('1.0');
    const line = lineOf(base);
    await unit.run((tx) => store.insert(tx, line));
    const onMain = await published('2.0');
    const fix = release('1.0.1');
    await unit.run(async (tx) => {
      await releases.reserve(tx, fix);
      await store.linkRelease(tx, line.id, fix.id);
      await releases.publish(tx, fix.id, 'c'.repeat(40));
    });
    expect(await store.releasesOf(line.id, all)).toEqual({
      total: 1,
      items: [fix.id],
    });
    expect((await store.lineOfRelease(fix.id))?.id).toBe(line.id);
    expect(await store.lineOfRelease(onMain.id)).toBeUndefined();
    const later = await published('2.1');
    expect((await releases.previous(later, { line: null }))?.id).toBe(
      onMain.id,
    );
    expect((await releases.previous(later))?.id).toBe(fix.id);
    const again = release('1.0.2');
    await unit.run(async (tx) => {
      await releases.reserve(tx, again);
      await store.linkRelease(tx, line.id, again.id);
      await releases.publish(tx, again.id, 'd'.repeat(40));
    });
    expect((await releases.previous(again, { line: line.id }))?.id).toBe(
      fix.id,
    );
    expect(await releases.previous(fix, { line: line.id })).toBeUndefined();
    // The link never changes.
    await expect(
      database.db.execute(
        sql`update maintenance_line_releases set line_id = line_id`,
      ),
    ).rejects.toThrow();
  });
});
