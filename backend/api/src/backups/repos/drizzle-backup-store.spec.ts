import {
  createTestDatabase,
  type PgliteDatabase,
} from '../../../tests/database.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import { DEFAULT_SETTINGS } from '../core/backup-settings.js';
import { DrizzleBackupStore } from './drizzle-backup-store.js';
import { OutboxBackupIncidents } from './outbox-backup-incidents.js';
import {
  BackupIdentitySealedSecretSource,
  BackupS3SealedSecretSource,
} from './sealed-backup-secrets.js';

describe('DrizzleBackupStore', () => {
  let database: PgliteDatabase;
  let store: DrizzleBackupStore;
  let unit: DrizzleUnitOfWork;
  beforeAll(async () => {
    database = await createTestDatabase();
    store = new DrizzleBackupStore(database);
    unit = new DrizzleUnitOfWork(database);
  });
  afterAll(() => database?.close());

  it('answers the defaults until something is stored, then what was stored', async () => {
    expect(await store.settings()).toEqual(DEFAULT_SETTINGS);
    const updatedAt = new Date('2026-11-20T10:00:00Z');
    await unit.run(async (tx) => {
      await store.lockSettings(tx);
      await store.saveSettings(tx, {
        ...DEFAULT_SETTINGS,
        enabled: true,
        frequency: { kind: 'weekly', weekday: 3 },
        location: {
          kind: 's3',
          endpoint: 'http://seaweedfs:8333',
          region: 'us-east-1',
          bucket: 'b-1',
          prefix: 'p/',
          accessKeyId: 'k',
        },
        s3SecretSealed: 'v1.sealed',
        updatedAt,
      });
    });
    expect(await store.settings()).toMatchObject({
      enabled: true,
      frequency: { kind: 'weekly', weekday: 3 },
      location: { kind: 's3', bucket: 'b-1', prefix: 'p/' },
      s3SecretSealed: 'v1.sealed',
      updatedAt,
    });
  });

  it('keeps one current key; a new one retires it and drops its identity', async () => {
    const key = (n: number) => ({
      id: `00000000-0000-4000-8000-00000000000${n}`,
      recipient: `age1${String(n).padStart(58, 'q')}`,
      fingerprint: `000${n}-0000-0000-0000`,
      identitySealed: `sealed-${n}`,
      createdAt: new Date(`2026-11-2${n}T00:00:00Z`),
      retiredAt: null,
    });
    await unit.run((tx) => store.addKey(tx, key(1)));
    await unit.run((tx) => store.addKey(tx, key(2)));
    expect((await store.currentKey())?.id).toBe(key(2).id);
    const { items, total } = await store.keys({ number: 1, size: 10 });
    expect(total).toBe(2);
    expect(items[1]).toMatchObject({
      id: key(1).id,
      identitySealed: null,
      retiredAt: key(2).createdAt,
    });
    // The database holds one current key at most.
    await expect(
      database.client.exec(
        `insert into backup_keys (id, recipient, fingerprint, created_at) values ('00000000-0000-4000-8000-000000000009', 'age1${'z'.repeat(58)}', '0009-0000-0000-0000', now())`,
      ),
    ).rejects.toThrow();
  });

  it('records runs and requests, claims a request once, and interrupts what a stop cut off', async () => {
    const t0 = new Date('2026-11-20T01:00:00Z');
    await store.startRun({
      id: '10000000-0000-4000-8000-000000000001',
      trigger: 'schedule',
      scheduledFor: t0,
      startedAt: t0,
      processId: 'p',
      requestId: null,
    });
    await store.finishRun('10000000-0000-4000-8000-000000000001', {
      status: 'succeeded',
      finishedAt: new Date(t0.getTime() + 60_000),
      sizeBytes: 42,
      sha256: 'b'.repeat(64),
      location: 'local:/',
      name: 'openfolia-backup-20261120T010000Z-10000000.tar.age',
      keyFingerprint: '0002-0000-0000-0000',
      verified: true,
      verifyMode: 'decrypted',
    });
    const t1 = new Date('2026-11-21T01:00:00Z');
    await store.startRun({
      id: '10000000-0000-4000-8000-000000000002',
      trigger: 'manual',
      scheduledFor: null,
      startedAt: t1,
      processId: 'p',
      requestId: null,
    });
    expect((await store.latestRun())?.status).toBe('running');
    expect((await store.latestGoodRun())?.sizeBytes).toBe(42);
    expect(await store.lastScheduledFor()).toEqual(t0);
    expect(await store.interruptRuns(new Date())).toBe(1);
    expect((await store.latestRun())?.error).toBe('interrupted');

    const id = '20000000-0000-4000-8000-000000000001';
    await unit.run((tx) =>
      store.addRequest(tx, {
        id,
        kind: 'run',
        requestedBy: { kind: 'user', id: 'sample-admin' },
        createdAt: t1,
      }),
    );
    expect((await unit.run((tx) => store.pendingRequest(tx, 'run')))?.id).toBe(
      id,
    );
    const [a, b] = await Promise.all([
      store.claimRequest(t1),
      store.claimRequest(t1),
    ]);
    expect([a?.id, b?.id].filter(Boolean)).toEqual([id]);
    await store.finishRequest(id, {
      status: 'failed',
      finishedAt: t1,
      error: 'location-test-failed',
      errorDetail: 'AccessDenied',
    });
    expect(await store.request(id)).toMatchObject({
      status: 'failed',
      errorDetail: 'AccessDenied',
    });
    expect((await store.runs({ number: 1, size: 1 })).total).toBe(2);
  });

  it('keeps one heartbeat row and writes each incident once', async () => {
    const state = {
      processId: 'p',
      startedAt: new Date(),
      lastSeenAt: new Date(),
      overrides: { enabled: { variable: 'CCMS_BACKUP_ENABLED', value: true } },
      keyFingerprint: null,
    };
    await store.heartbeat(state);
    await store.heartbeat({ ...state, processId: 'q' });
    expect((await store.service())?.processId).toBe('q');
    const incidents = new OutboxBackupIncidents(database);
    const incident = {
      topic: 'backup.failed' as const,
      key: 'failed:none',
      payload: { runId: 'x', error: 'failed' },
    };
    expect(await incidents.emit(incident)).toBe(true);
    expect(await incidents.emit(incident)).toBe(false);
  });

  it("hands the sealed S3 secret and kept identities to the instance key's check and rotation", async () => {
    const s3 = new BackupS3SealedSecretSource();
    const ids = new BackupIdentitySealedSecretSource();
    const sampled = await unit.run(async (tx) => [
      ...(await s3.sample(tx, 10)),
      ...(await ids.sample(tx, 10)),
    ]);
    expect(sampled).toEqual([
      { sealed: 'v1.sealed', context: 'backup-s3-secret:v1' },
      {
        sealed: 'sealed-2',
        context: 'backup-key:v1:00000000-0000-4000-8000-000000000002',
      },
    ]);
    const n = await unit.run(
      async (tx) =>
        (await s3.reseal(tx, (v) => `re-${v.sealed}`)) +
        (await ids.reseal(tx, (v) => `re-${v.sealed}`)),
    );
    expect(n).toBe(2);
    expect((await store.settings()).s3SecretSealed).toBe('re-v1.sealed');
    expect((await store.currentKey())?.identitySealed).toBe('re-sealed-2');
  });
});
