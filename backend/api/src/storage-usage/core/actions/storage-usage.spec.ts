import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import {
  FakeInstanceSizes,
  FakeMeter,
  FakeStorageUsage,
  fakeQuota,
} from '../../../../tests/fakes/fake-storage-usage.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { ForbiddenError } from '../../../base/core/errors.js';
import {
  REFUSAL_AUDIT_EVERY_MS,
  StorageLimitReachedError,
} from '../storage-quota.js';
import { NO_USAGE } from '../storage-usage.js';
import { GetStorageUsageAction, levelOf } from './get-storage-usage.action.js';
import { ListStoredFilesAction } from './list-stored-files.action.js';
import { RecordStorageLimitAction } from './record-storage-limit.action.js';
import {
  RECOUNT_CLAIM_MS,
  RecountStorageAction,
} from './recount-storage.action.js';

const ADMIN = actorWith(['admin.roles']);
const HOUR = 3_600_000;

function setUp(limitBytes: number | null = null) {
  const unit = new FakeUnitOfWork();
  const auditLog = new FakeAuditLog();
  const usage = new FakeStorageUsage();
  const { quota, settings } = fakeQuota({ limitBytes, usage, auditLog, unit });
  const media = new FakeMeter();
  const pdfs = new FakeMeter();
  const sizes = new FakeInstanceSizes();
  return {
    unit,
    auditLog,
    usage,
    quota,
    media,
    pdfs,
    sizes,
    get: new GetStorageUsageAction(usage, quota, unit),
    list: new ListStoredFilesAction(usage),
    recount: new RecountStorageAction(
      usage,
      media,
      pdfs,
      sizes,
      settings,
      unit,
    ),
    recordLimit: new RecordStorageLimitAction(usage, settings, auditLog, unit),
  };
}

describe('the kept totals', () => {
  it('move with every upload and delete, and a recount corrects a deliberately wrong total', async () => {
    const t = setUp();
    await t.unit.run((tx) => t.quota.addMedia(tx, 'h', 1_000));
    await t.unit.run((tx) => t.quota.addMedia(tx, 'h', 500));
    await t.unit.run((tx) => t.quota.removeMedia(tx, 'h', 1_000));
    await t.unit.run((tx) => t.quota.addPdf(tx, 300));
    expect(t.usage.totals).toMatchObject({
      media: { bytes: 500, files: 1 },
      pdfs: { bytes: 300, files: 1 },
    });
    // Drifted: wrong on purpose.
    t.usage.totals = {
      ...t.usage.totals,
      media: { bytes: 123_456, files: 99 },
    };
    t.media.usage = { bytes: 500, files: 1 };
    t.pdfs.usage = { bytes: 300, files: 1 };
    t.sizes.git = 4_096;
    t.sizes.database = 8_192;
    const now = new Date('2026-11-19T10:00:00Z');
    expect(await t.recount.handle({ now })).toBe(true);
    expect(t.usage.totals).toEqual({
      media: { bytes: 500, files: 1 },
      pdfs: { bytes: 300, files: 1 },
      gitBytes: 4_096,
      databaseBytes: 8_192,
      recountedAt: now,
    });
  });

  it('never go below 0', async () => {
    const t = setUp();
    await t.unit.run((tx) => t.quota.removeMedia(tx, 'h', 10));
    expect(t.usage.totals.media).toEqual({ bytes: 0, files: 0 });
  });

  it('are left as they were when the work rolls back', async () => {
    const t = setUp();
    await expect(
      t.unit.run(async (tx) => {
        await t.quota.addMedia(tx, 'h', 10);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(t.usage.totals.media).toEqual({ bytes: 0, files: 0 });
  });
});

describe('StorageQuota', () => {
  it('has no room limit and refuses nothing without a limit', async () => {
    const t = setUp();
    t.usage.totals = {
      ...t.usage.totals,
      media: { bytes: 10 ** 15, files: 1 },
    };
    expect(await t.quota.room()).toBeUndefined();
    await t.unit.run((tx) => t.quota.addMedia(tx, 'h', 10 ** 12));
  });

  it('gives the room left, counting media and archived PDFs, and none at the limit', async () => {
    const t = setUp(1_000);
    t.usage.totals = {
      ...t.usage.totals,
      media: { bytes: 600, files: 1 },
      pdfs: { bytes: 300, files: 1 },
    };
    expect(await t.quota.room()).toBe(100);
    t.usage.totals = { ...t.usage.totals, pdfs: { bytes: 400, files: 1 } };
    await expect(t.quota.room()).rejects.toBeInstanceOf(
      StorageLimitReachedError,
    );
  });

  it('refuses a file counted past the limit, rolling its transaction back', async () => {
    const t = setUp(1_000);
    await t.unit.run((tx) => t.quota.addMedia(tx, 'h', 1_000));
    const error = await t.unit
      .run((tx) => t.quota.addMedia(tx, 'h', 1))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageLimitReachedError);
    expect(error).toMatchObject({
      code: 'storage-limit-reached',
      meta: { limit: 1_000 },
      used: 1_000,
    });
    expect(t.usage.totals.media).toEqual({ bytes: 1_000, files: 1 });
  });

  it('audits refused uploads at most once per actor every ten minutes, counting the others into the next', async () => {
    const t = setUp(10);
    let clock = 0;
    t.quota.now = () => clock;
    const error = new StorageLimitReachedError(10, 10);
    const other = { ...ADMIN, id: 'someone-else' };
    for (let i = 0; i < 5; i++) {
      await t.quota.refused(READER, error, { changeSetId: 'c' });
    }
    await t.quota.refused(other, error, { changeSetId: 'd' });
    clock = REFUSAL_AUDIT_EVERY_MS;
    await t.quota.refused(READER, error, { changeSetId: 'c' });
    expect(t.auditLog.events.map((e) => [e.actor.id, e.data])).toEqual([
      [READER.id, { changeSetId: 'c', limit: 10, used: 10 }],
      [other.id, { changeSetId: 'd', limit: 10, used: 10 }],
      [
        READER.id,
        { changeSetId: 'c', limit: 10, used: 10, refusedMeanwhile: 4 },
      ],
    ]);
  });

  it('never refuses an archived PDF, also past the limit', async () => {
    const t = setUp(10);
    await t.unit.run((tx) => t.quota.addPdf(tx, 100));
    expect(t.usage.totals.pdfs.bytes).toBe(100);
  });
});

describe('RecountStorageAction', () => {
  it('recounts only when due, and once while a claim holds', async () => {
    const t = setUp();
    const start = new Date('2026-11-19T10:00:00Z');
    t.media.usage = { bytes: 1, files: 1 };
    expect(await t.recount.handle({ now: start })).toBe(true);
    // Not due again within the day.
    expect(
      await t.recount.handle({ now: new Date(start.getTime() + HOUR) }),
    ).toBe(false);
    const due = new Date(start.getTime() + 24 * HOUR);
    // Another server's claim holds it, until it is stale.
    t.usage.claimedAt = due;
    expect(
      await t.recount.handle({ now: new Date(due.getTime() + 1_000) }),
    ).toBe(false);
    expect(
      await t.recount.handle({
        now: new Date(due.getTime() + RECOUNT_CLAIM_MS),
      }),
    ).toBe(true);
  });

  it('reports a size it cannot read as unknown, and recounts all the same', async () => {
    const t = setUp();
    t.sizes.gitBytes = async () => {
      throw new Error('gone');
    };
    t.media.usage = { bytes: 7, files: 1 };
    expect(await t.recount.handle({ now: new Date() })).toBe(true);
    expect(t.usage.totals).toMatchObject({
      media: { bytes: 7, files: 1 },
      gitBytes: null,
    });
  });

  it('keeps what was added while it counted, which its listing missed', async () => {
    const t = setUp();
    t.media.usage = { bytes: 100, files: 2 };
    // An upload counted after the listing passed it, a delete too.
    t.media.measure = async () => {
      await t.unit.run((tx) => t.quota.addMedia(tx, 'late', 30));
      await t.unit.run((tx) => t.quota.removeMedia(tx, 'old', 10));
      return { bytes: 100, files: 2 };
    };
    expect(await t.recount.handle({ now: new Date() })).toBe(true);
    // Added on top: at worst counted twice, never lost.
    expect(t.usage.totals.media).toEqual({ bytes: 130, files: 3 });
    expect(t.usage.added).toEqual({ media: NO_USAGE, pdfs: NO_USAGE });
    // Outside a recount nothing is gathered apart.
    await t.unit.run((tx) => t.quota.addMedia(tx, 'next', 5));
    expect(t.usage.added.media).toEqual(NO_USAGE);
  });

  it('stops when its signal aborts (shutdown, or its deadline), keeping the totals', async () => {
    const t = setUp();
    t.usage.totals = { ...t.usage.totals, media: { bytes: 5, files: 1 } };
    const stop = new AbortController();
    t.media.measure = async (signal) => {
      stop.abort(new Error('shutting down'));
      signal?.throwIfAborted();
      return { bytes: 1, files: 1 };
    };
    await expect(
      t.recount.handle({ now: new Date(), signal: stop.signal }),
    ).rejects.toThrow('shutting down');
    expect(t.usage.totals.media).toEqual({ bytes: 5, files: 1 });
  });

  it('keeps the totals when a store does not answer (its claim lapses after RECOUNT_CLAIM_MS)', async () => {
    const t = setUp();
    t.usage.totals = { ...t.usage.totals, media: { bytes: 5, files: 1 } };
    t.media.measure = async () => {
      throw new Error('the blob store does not answer');
    };
    await expect(t.recount.handle({ now: new Date() })).rejects.toThrow();
    expect(t.usage.totals.media).toEqual({ bytes: 5, files: 1 });
    expect(t.usage.claimedAt).not.toBeNull();
  });
});

describe('RecordStorageLimitAction', () => {
  it('records nothing for an installation that never sets a limit', async () => {
    const t = setUp();
    expect(await t.recordLimit.handle()).toBe(false);
    expect(t.auditLog.events).toEqual([]);
  });

  it('records a change of the limit once, audited by the server', async () => {
    const t = setUp(50_000);
    expect(await t.recordLimit.handle()).toBe(true);
    expect(await t.recordLimit.handle()).toBe(false);
    expect(t.usage.limit).toBe(50_000);
    expect(t.auditLog.events).toEqual([
      expect.objectContaining({
        action: 'storage.limit-change',
        actor: { kind: 'service', id: 'service:storage' },
        subject: { type: 'storage', id: 'instance' },
        data: { from: null, to: 50_000 },
      }),
    ]);
    // Taken away again at a later start.
    const later = new RecordStorageLimitAction(
      t.usage,
      { limitBytes: null, recountEveryMs: HOUR },
      t.auditLog,
      t.unit,
    );
    expect(await later.handle()).toBe(true);
    expect(t.auditLog.events.at(-1)?.data).toEqual({ from: 50_000, to: null });
  });
});

describe('GetStorageUsageAction', () => {
  it('answers the totals, the limit and the level for an administrator', async () => {
    const t = setUp(1_000);
    t.usage.totals = {
      ...t.usage.totals,
      media: { bytes: 700, files: 3 },
      pdfs: { bytes: 150, files: 1 },
    };
    expect(await t.get.handle({ actor: ADMIN })).toEqual({
      totals: t.usage.totals,
      limit: 1_000,
      used: 850,
      level: 'warning',
    });
  });

  it('refuses anyone but an administrator', async () => {
    const t = setUp();
    await expect(t.get.handle({ actor: READER })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      t.list.handle({ actor: READER, page: { number: 1, size: 10 } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('names the level: unlimited, ok, a warning from 80 %, reached', () => {
    expect(levelOf(10 ** 12, null)).toBe('unlimited');
    expect(levelOf(799, 1_000)).toBe('ok');
    expect(levelOf(800, 1_000)).toBe('warning');
    expect(levelOf(1_000, 1_000)).toBe('reached');
  });
});

describe('ListStoredFilesAction', () => {
  it('lists the uploaded files largest first, paged', async () => {
    const t = setUp();
    const at = new Date();
    t.usage.files = [
      {
        sha256: 'b'.repeat(64),
        size: 10,
        contentType: 'image/png',
        lastUploadedAt: at,
      },
      {
        sha256: 'a'.repeat(64),
        size: 30,
        contentType: 'image/png',
        lastUploadedAt: at,
      },
      {
        sha256: 'c'.repeat(64),
        size: 20,
        contentType: 'image/png',
        lastUploadedAt: at,
      },
    ];
    const page = await t.list.handle({
      actor: ADMIN,
      page: { number: 1, size: 2 },
    });
    expect(page.total).toBe(3);
    expect(page.items.map((f) => f.size)).toEqual([30, 20]);
  });
});
