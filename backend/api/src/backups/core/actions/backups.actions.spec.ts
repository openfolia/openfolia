import { actorWith, NOBODY } from '../../../../tests/fakes/actors.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import {
  FakeBackupClock,
  FakeBackupIncidents,
  FakeBackupLock,
  FakeBackupStore,
} from '../../../../tests/fakes/fake-backup-store.js';
import {
  FakeSecretCipher,
  testKey,
} from '../../../../tests/fakes/fake-secret-key.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import {
  ConflictError,
  ForbiddenError,
  UnprocessableError,
  UnprocessableProblems,
} from '../../../base/core/errors.js';
import { BackupStatusSettings } from '../backup-clock.js';
import {
  BackupKeyMaker,
  BackupSource,
  BackupStepError,
  BackupTarget,
  BackupTargets,
  BackupVerifier,
  type EncryptedBackup,
  type PreparedBackup,
} from '../backup-ports.js';
import type { BackupLocation, BackupOverrides } from '../backup-settings.js';
import {
  backupIdentityContext,
  S3_SECRET_CONTEXT,
} from '../backup-settings.js';
import type { StoredBackup } from '../retention.js';
import {
  CreateBackupKeyAction,
  GetBackupSettingsAction,
  GetBackupStatusAction,
  ListBackupRunsAction,
  RequestBackupAction,
  UpdateBackupSettingsAction,
} from './manage-backups.action.js';
import {
  BackupEnvironment,
  BackupLog,
  BackupTickAction,
  RunBackupAction,
} from './run-backup.action.js';

const admin = { ...actorWith(['admin.backups']), id: 'sample-admin' };
const rolesAdmin = actorWith(['admin.roles']);
const SECRET = 'very-secret-s3-key-0123456789';

const RECIPIENT = `age1${'q'.repeat(58)}`;
class FakeKeyMaker extends BackupKeyMaker {
  made = 0;
  async generate() {
    this.made++;
    return {
      identity: `AGE-SECRET-KEY-1${String(this.made).padStart(58, 'X')}`,
      recipient: `age1${String(this.made).padStart(58, 'q')}`,
    };
  }
  async recipientOf() {
    return RECIPIENT;
  }
}

class FakeSource extends BackupSource {
  prepared: string[] = [];
  discarded: string[] = [];
  encryptedTo: string[] = [];
  failPrepare: Error | undefined;
  async prepare(runId: string): Promise<PreparedBackup> {
    if (this.failPrepare) throw this.failPrepare;
    this.prepared.push(runId);
    return {
      runId,
      dir: `/backups/.staging/${runId}`,
      manifest: {
        format: 1,
        runId,
        createdAt: new Date().toISOString(),
        database: { migrations: 1, rows: {} },
        content: null,
        blobs: null,
        secretKeyFile: null,
      },
    };
  }
  async encrypt(
    prepared: PreparedBackup,
    recipient: string,
  ): Promise<EncryptedBackup> {
    this.encryptedTo.push(recipient);
    return {
      path: `${prepared.dir}/backup.tar.age`,
      sizeBytes: 1234,
      sha256: 'a'.repeat(64),
    };
  }
  async discard(prepared: PreparedBackup): Promise<void> {
    this.discarded.push(prepared.runId);
  }
}

class FakeVerifier extends BackupVerifier {
  calls: (string | undefined)[] = [];
  fail = false;
  async verify(input: { identity: string | undefined }) {
    this.calls.push(input.identity);
    if (this.fail)
      throw new BackupStepError(
        'verify-failed',
        'The restored audit_events has 3 rows, the snapshot had 4.',
      );
    return input.identity
      ? ('decrypted' as const)
      : ('before-encryption' as const);
  }
}

class FakeTarget extends BackupTarget {
  readonly stored: StoredBackup[] = [];
  readonly deleted: string[] = [];
  testError: Error | undefined;
  constructor(readonly description: string) {
    super();
  }
  async put(_file: EncryptedBackup, name: string): Promise<void> {
    const match =
      /openfolia-backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(
        name,
      )!;
    this.stored.push({
      name,
      at: new Date(
        `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`,
      ),
    });
  }
  async list(): Promise<StoredBackup[]> {
    return this.stored.filter((b) => !this.deleted.includes(b.name));
  }
  async delete(name: string): Promise<void> {
    this.deleted.push(name);
  }
  async test(): Promise<void> {
    if (this.testError) throw this.testError;
  }
}

class FakeTargets extends BackupTargets {
  readonly opened: { location: BackupLocation; secret: string | undefined }[] =
    [];
  readonly targets = new Map<string, FakeTarget>();
  open(location: BackupLocation, secret: string | undefined): BackupTarget {
    this.opened.push({ location, secret });
    const key =
      location.kind === 'local'
        ? `local:${location.subfolder}`
        : `s3:${location.bucket}/${location.prefix}`;
    let t = this.targets.get(key);
    if (!t) {
      t = new FakeTarget(key);
      this.targets.set(key, t);
    }
    return t;
  }
}

class QuietLog extends BackupLog {
  readonly lines: string[] = [];
  info(m: string) {
    this.lines.push(m);
  }
  warn(m: string) {
    this.lines.push(m);
  }
}

function setup(overrides: BackupOverrides = {}) {
  const store = new FakeBackupStore();
  const clock = new FakeBackupClock();
  const audit = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const cipher = new FakeSecretCipher();
  const sealer = cipher.sealer(testKey(1));
  const maker = new FakeKeyMaker();
  const source = new FakeSource();
  const verifier = new FakeVerifier();
  const targets = new FakeTargets();
  const incidents = new FakeBackupIncidents();
  const lock = new FakeBackupLock();
  const log = new QuietLog();
  const env = new (class extends BackupEnvironment {
    readonly processId = 'test-process';
    readonly overrides = overrides;
    readonly s3Secret = undefined;
    readonly identity = undefined;
    readonly warnAfterHours = 26;
  })();
  const beat = () =>
    store.heartbeat({
      processId: 'test-process',
      startedAt: clock.now(),
      lastSeenAt: clock.now(),
      overrides,
      keyFingerprint: null,
    });
  const runBackup = new RunBackupAction(
    store,
    env,
    maker,
    sealer,
    source,
    verifier,
    targets,
    incidents,
    clock,
    log,
  );
  const tick = new BackupTickAction(
    store,
    env,
    lock,
    runBackup,
    targets,
    incidents,
    clock,
    log,
  );
  const statusSettings = new (class extends BackupStatusSettings {
    readonly warnAfterHours = 26;
  })();
  return {
    store,
    clock,
    audit,
    unit,
    sealer,
    maker,
    source,
    verifier,
    targets,
    incidents,
    lock,
    log,
    beat,
    tick,
    get: new GetBackupSettingsAction(store, clock),
    update: new UpdateBackupSettingsAction(store, sealer, audit, unit, clock),
    createKey: new CreateBackupKeyAction(
      store,
      maker,
      sealer,
      audit,
      unit,
      clock,
    ),
    request: new RequestBackupAction(store, audit, unit, clock),
    status: new GetBackupStatusAction(store, statusSettings, clock),
    runs: new ListBackupRunsAction(store),
  };
}

const s3 = {
  kind: 's3' as const,
  endpoint: 'http://seaweedfs:8333',
  region: 'us-east-1',
  bucket: 'openfolia-backups',
  prefix: 'nightly/',
  accessKeyId: 'backup-writer',
};

describe('backup settings', () => {
  it('starts off, daily at 02:00 UTC, local, verified, with no runs planned', async () => {
    const t = setup();
    const view = await t.get.handle({ actor: admin });
    expect(view.settings).toMatchObject({
      enabled: false,
      frequency: { kind: 'daily' },
      time: '02:00',
      timeZone: 'UTC',
      retention: { daily: 7, weekly: 4, monthly: 12 },
      location: { kind: 'local', subfolder: '' },
      verify: true,
      verifyByDecrypting: true,
    });
    expect(view.nextRuns).toEqual([]);
    expect(view.service.running).toBe(false);
  });

  it('needs admin.backups for every route, also from someone holding admin.roles', async () => {
    const t = setup();
    for (const actor of [NOBODY, rolesAdmin]) {
      await expect(t.get.handle({ actor })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(
        t.update.handle({ actor, changes: { enabled: true } }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        t.createKey.handle({ actor, rotate: false }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        t.request.handle({ actor, kind: 'run' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(t.status.handle({ actor })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
  });

  it('sets frequency, time, time zone, retention and an S3 location, audited with old and new values and never the secret', async () => {
    const t = setup();
    const view = await t.update.handle({
      actor: admin,
      changes: {
        enabled: true,
        frequency: { kind: 'weekly', weekday: 1 },
        time: '03:30',
        timeZone: 'Europe/Berlin',
        retention: { daily: 3, weekly: 2, monthly: 6 },
        location: { ...s3, secretAccessKey: SECRET },
      },
    });
    expect(view.settings.location).toEqual(s3);
    expect(view.s3SecretSet).toBe(true);
    expect(view.schedule).toBe('30 3 * * 1');
    // 2026-11-20 is a Friday: the next Mondays at 03:30 in Berlin (CET, UTC+1).
    expect(view.nextRuns.map((d) => d.toISOString())).toEqual([
      '2026-11-23T02:30:00.000Z',
      '2026-11-30T02:30:00.000Z',
      '2026-12-07T02:30:00.000Z',
    ]);
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(t.store.stored?.s3SecretSealed).toBe(
      t.sealer.seal(SECRET, S3_SECRET_CONTEXT),
    );
    const [event] = t.audit.events;
    expect(event).toMatchObject({
      action: 'backup-settings.update',
      subject: { type: 'backup-settings', id: 'instance' },
      data: {
        changes: {
          enabled: { from: false, to: true },
          time: { from: '02:00', to: '03:30' },
          location: { from: { kind: 'local', subfolder: '' }, to: s3 },
        },
        s3SecretAccessKey: 'set',
      },
    });
    expect(JSON.stringify(t.audit.events)).not.toContain(SECRET);
  });

  it('refuses a local subfolder that leaves the volume (422 backup-path-outside-volume)', async () => {
    const t = setup();
    for (const subfolder of [
      '../etc',
      '/srv/backups',
      'a/../../b',
      'a\\b',
      '.hidden',
      'a//b',
    ]) {
      const error = await t.update
        .handle({
          actor: admin,
          changes: { location: { kind: 'local', subfolder } },
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnprocessableProblems);
      expect((error as UnprocessableProblems).code).toBe(
        'backup-path-outside-volume',
      );
    }
    expect(t.audit.events).toEqual([]);
    await t.update.handle({
      actor: admin,
      changes: { location: { kind: 'local', subfolder: 'nightly/eu-1/' } },
    });
    expect((await t.get.handle({ actor: admin })).settings.location).toEqual({
      kind: 'local',
      subfolder: 'nightly/eu-1',
    });
  });

  it('validates a custom cron expression and a time zone', async () => {
    const t = setup();
    await expect(
      t.update.handle({
        actor: admin,
        changes: { frequency: { kind: 'cron', expression: '61 * * * *' } },
      }),
    ).rejects.toMatchObject({ code: 'invalid-schedule' });
    await expect(
      t.update.handle({
        actor: admin,
        changes: { frequency: { kind: 'cron', expression: '* * * * * *' } },
      }),
    ).rejects.toMatchObject({ code: 'invalid-schedule' });
    await expect(
      t.update.handle({ actor: admin, changes: { timeZone: 'Mars/Olympus' } }),
    ).rejects.toMatchObject({
      code: 'invalid-time-zone',
    });
    const view = await t.update.handle({
      actor: admin,
      changes: {
        enabled: true,
        frequency: { kind: 'cron', expression: '15 */6 * * *' },
      },
    });
    expect(view.nextRuns.map((d) => d.toISOString())).toEqual([
      '2026-11-20T12:15:00.000Z',
      '2026-11-20T18:15:00.000Z',
      '2026-11-21T00:15:00.000Z',
    ]);
  });

  it('refuses to change what the environment fixes (409), and shows it as fixed', async () => {
    const t = setup({
      enabled: { variable: 'CCMS_BACKUP_ENABLED', value: true },
    });
    await t.beat();
    const view = await t.get.handle({ actor: admin });
    expect(view.fixed).toEqual({ enabled: 'CCMS_BACKUP_ENABLED' });
    expect(view.settings.enabled).toBe(true);
    const error = await t.update
      .handle({ actor: admin, changes: { enabled: false } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({
      code: 'backup-setting-fixed-by-environment',
      meta: { setting: 'enabled', variable: 'CCMS_BACKUP_ENABLED' },
    });
    // Another setting still changes.
    await t.update.handle({ actor: admin, changes: { time: '04:00' } });
  });

  it('takes a retention count while another is fixed, and never stores the fixed one', async () => {
    const t = setup({
      'retention.weekly': {
        variable: 'CCMS_BACKUP_RETENTION_WEEKLY',
        value: 9,
      },
    });
    await t.beat();
    // As the page sends it: the whole retention, the fixed count as in force.
    await t.update.handle({
      actor: admin,
      changes: { retention: { daily: 3, weekly: 9, monthly: 12 } },
    });
    expect(t.store.stored?.retention).toEqual({
      daily: 3,
      weekly: 4,
      monthly: 12,
    });
    expect((await t.get.handle({ actor: admin })).settings.retention).toEqual({
      daily: 3,
      weekly: 9,
      monthly: 12,
    });
  });

  it('keeps the S3 secret only for the same endpoint, bucket and access key', async () => {
    const t = setup();
    await t.update.handle({
      actor: admin,
      changes: { location: { ...s3, secretAccessKey: SECRET } },
    });
    // Same server: kept without giving it again.
    await t.update.handle({
      actor: admin,
      changes: { location: { ...s3, prefix: 'weekly/' } },
    });
    expect(t.store.stored?.s3SecretSealed).not.toBeNull();
    await expect(
      t.update.handle({
        actor: admin,
        changes: { location: { ...s3, endpoint: 'https://elsewhere.example' } },
      }),
    ).rejects.toMatchObject({ code: 'secret-required' });
    await t.update.handle({
      actor: admin,
      changes: { location: { ...s3, secretAccessKey: null } },
    });
    expect(t.store.stored?.s3SecretSealed).toBeNull();
    expect(t.audit.events.at(-1)?.data).toMatchObject({
      s3SecretAccessKey: 'removed',
    });
  });

  it('drops the identity when verifying by decrypting is turned off, and needs a kept one to turn it on', async () => {
    const t = setup();
    await t.createKey.handle({ actor: admin, rotate: false });
    expect((await t.store.currentKey())?.identitySealed).not.toBeNull();
    await t.update.handle({
      actor: admin,
      changes: { verifyByDecrypting: false },
    });
    expect((await t.store.currentKey())?.identitySealed).toBeNull();
    await expect(
      t.update.handle({ actor: admin, changes: { verifyByDecrypting: true } }),
    ).rejects.toBeInstanceOf(UnprocessableError);
    // A rotation while it is off keeps no identity either.
    await t.createKey.handle({ actor: admin, rotate: true });
    expect((await t.store.currentKey())?.identitySealed).toBeNull();
  });
});

describe('the backup key', () => {
  it('is made once, answered once with its identity, sealed for its own ID, audited by fingerprint', async () => {
    const t = setup();
    const made = await t.createKey.handle({ actor: admin, rotate: false });
    expect(made.identity).toMatch(/^AGE-SECRET-KEY-1/);
    const key = (await t.store.currentKey())!;
    expect(key.identitySealed).toBe(
      t.sealer.seal(made.identity, backupIdentityContext(key.id)),
    );
    expect(made.key.fingerprint).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    expect(t.audit.events[0]).toMatchObject({
      action: 'backup-key.create',
      data: { fingerprint: made.key.fingerprint },
    });
    expect(JSON.stringify(t.audit.events)).not.toContain(made.identity);
    const view = await t.get.handle({ actor: admin });
    expect(JSON.stringify(view)).not.toContain(made.identity);
    await expect(
      t.createKey.handle({ actor: admin, rotate: false }),
    ).rejects.toMatchObject({ code: 'backup-key-exists' });
  });

  it('rotates explicitly: the old key is retired with its fingerprint, its identity dropped', async () => {
    const t = setup();
    const first = await t.createKey.handle({ actor: admin, rotate: false });
    const second = await t.createKey.handle({ actor: admin, rotate: true });
    expect(second.rotated).toBe(true);
    expect(second.key.fingerprint).not.toBe(first.key.fingerprint);
    expect(t.store.keyRows).toHaveLength(2);
    expect(t.store.keyRows[0]).toMatchObject({
      fingerprint: first.key.fingerprint,
      identitySealed: null,
    });
    expect(t.store.keyRows[0]?.retiredAt).not.toBeNull();
    expect(t.audit.events[1]).toMatchObject({
      action: 'backup-key.rotate',
      data: {
        fingerprint: second.key.fingerprint,
        previousFingerprint: first.key.fingerprint,
      },
    });
  });

  it('is refused when CCMS_BACKUP_KEY_FILE sets it', async () => {
    const t = setup({
      key: { variable: 'CCMS_BACKUP_KEY_FILE', value: 'abcd-abcd-abcd-abcd' },
    });
    await t.beat();
    await expect(
      t.createKey.handle({ actor: admin, rotate: false }),
    ).rejects.toMatchObject({
      code: 'backup-setting-fixed-by-environment',
    });
  });
});

describe('requests and status', () => {
  it('refuses a request while the backup service is not running, and a backup without a key', async () => {
    const t = setup();
    await expect(
      t.request.handle({ actor: admin, kind: 'test-location' }),
    ).rejects.toMatchObject({
      code: 'backup-service-not-running',
    });
    await t.beat();
    await expect(
      t.request.handle({ actor: admin, kind: 'run' }),
    ).rejects.toMatchObject({ code: 'backup-key-missing' });
    const test = await t.request.handle({
      actor: admin,
      kind: 'test-location',
    });
    expect(test.status).toBe('pending');
    // The same kind still waiting is answered again.
    expect(
      (await t.request.handle({ actor: admin, kind: 'test-location' })).id,
    ).toBe(test.id);
    expect(t.audit.events.map((e) => e.action)).toEqual(['backup.request']);
  });

  it('says "not set up", then "service not running", nothing before the first run is due, "overdue" once it is, all well, and "failed"', async () => {
    const t = setup();
    expect((await t.status.handle({ actor: admin })).warning).toBe(
      'not-set-up',
    );
    await t.createKey.handle({ actor: admin, rotate: false });
    await t.update.handle({ actor: admin, changes: { enabled: true } });
    expect((await t.status.handle({ actor: admin })).warning).toBe(
      'service-not-running',
    );
    await t.beat();
    // Just set up: not overdue before the limit has passed since the settings were saved.
    expect((await t.status.handle({ actor: admin })).warning).toBeNull();
    t.clock.advance(27 * 3_600_000);
    await t.beat();
    expect((await t.status.handle({ actor: admin })).warning).toBe('overdue');
    await t.request.handle({ actor: admin, kind: 'run' });
    await t.tick.handle();
    const ok = await t.status.handle({ actor: admin });
    expect(ok.warning).toBeNull();
    expect(ok.lastGoodRun?.verified).toBe(true);
    t.verifier.fail = true;
    t.clock.advance(60_000);
    await t.beat();
    await t.request.handle({ actor: admin, kind: 'run' });
    await t.tick.handle();
    expect((await t.status.handle({ actor: admin })).warning).toBe('failed');
    t.clock.advance(27 * 3_600_000);
    t.verifier.fail = false;
    await t.beat();
    expect((await t.status.handle({ actor: admin })).warning).toBe('failed');
  });
});

describe('the backup process', () => {
  async function ready(t: ReturnType<typeof setup>) {
    await t.createKey.handle({ actor: admin, rotate: false });
    await t.update.handle({
      actor: admin,
      changes: {
        enabled: true,
        frequency: { kind: 'daily' },
        time: '02:00',
        timeZone: 'Europe/Berlin',
        location: { ...s3, secretAccessKey: SECRET },
      },
    });
  }

  it('fails a request whose answer throws, so it never stays running and a new one can be asked', async () => {
    const t = setup();
    await ready(t);
    await t.beat();
    const first = await t.request.handle({ actor: admin, kind: 'run' });
    t.lock.broken = new Error('Connection terminated unexpectedly');
    await expect(t.tick.handle()).rejects.toThrow('Connection terminated');
    expect(await t.store.request(first.id)).toMatchObject({
      status: 'failed',
      errorDetail: expect.stringContaining('Connection terminated'),
    });
    t.lock.broken = undefined;
    const second = await t.request.handle({ actor: admin, kind: 'run' });
    expect(second.id).not.toBe(first.id);
  });

  it('runs at the set time and lands at the S3 location, encrypted to the key, verified by decrypting', async () => {
    const t = setup();
    await ready(t);
    // 10:00 UTC: the next run is 02:00 Berlin = 01:00 UTC tomorrow.
    expect(await t.tick.handle()).toBe('idle');
    t.clock.at = new Date('2026-11-21T00:59:59Z');
    expect(await t.tick.handle()).toBe('idle');
    t.clock.at = new Date('2026-11-21T01:00:05Z');
    expect(await t.tick.handle()).toBe('scheduled');
    expect(await t.tick.handle()).toBe('idle');
    const target = t.targets.targets.get('s3:openfolia-backups/nightly/')!;
    expect(target.stored.map((b) => b.name)).toEqual([
      expect.stringMatching(
        /^openfolia-backup-20261121T010005Z-[0-9a-f]{8}\.tar\.age$/,
      ),
    ]);
    expect(t.targets.opened.at(-1)?.secret).toBe(SECRET);
    const key = (await t.store.currentKey())!;
    expect(t.source.encryptedTo).toEqual([key.recipient]);
    expect(t.verifier.calls[0]).toMatch(/^AGE-SECRET-KEY-1/);
    const [run] = (
      await t.runs.handle({ actor: admin, page: { number: 1, size: 10 } })
    ).items;
    expect(run).toMatchObject({
      trigger: 'schedule',
      status: 'succeeded',
      scheduledFor: new Date('2026-11-21T01:00:00Z'),
      location: 's3:openfolia-backups/nightly/',
      keyFingerprint: key.fingerprint,
      verified: true,
      verifyMode: 'decrypted',
      sizeBytes: 1234,
    });
    expect(t.source.discarded).toEqual(t.source.prepared);
    // The next day's run.
    t.clock.at = new Date('2026-11-22T01:00:01Z');
    expect(await t.tick.handle()).toBe('scheduled');
  });

  it('applies a changed schedule at the next pass, without a restart', async () => {
    const t = setup();
    await ready(t);
    t.clock.at = new Date('2026-11-20T10:30:00Z');
    await t.update.handle({
      actor: admin,
      changes: { frequency: { kind: 'hours', every: 1 }, time: '00:45' },
    });
    expect(await t.tick.handle()).toBe('idle');
    t.clock.at = new Date('2026-11-20T10:45:30Z');
    expect(await t.tick.handle()).toBe('scheduled');
  });

  it('catches up once after a stop, not once per missed run', async () => {
    const t = setup();
    await ready(t);
    t.clock.at = new Date('2026-11-21T01:00:05Z');
    await t.tick.handle();
    t.clock.at = new Date('2026-11-25T12:00:00Z');
    expect(await t.tick.handle()).toBe('scheduled');
    expect(await t.tick.handle()).toBe('idle');
    expect(t.store.runRows.at(-1)?.scheduledFor).toEqual(
      new Date('2026-11-25T01:00:00Z'),
    );
  });

  it('never runs while another process holds the lock', async () => {
    const t = setup();
    await ready(t);
    t.clock.at = new Date('2026-11-21T01:00:05Z');
    t.lock.held = true;
    expect(await t.tick.handle()).toBe('idle');
    expect(t.store.runRows).toEqual([]);
  });

  it('refuses to back up without a key: never unencrypted; admins hear once per incident', async () => {
    const t = setup();
    await t.update.handle({ actor: admin, changes: { enabled: true } });
    await t.beat();
    t.clock.at = new Date('2026-11-21T02:00:05Z');
    await t.tick.handle();
    expect(t.store.runRows[0]).toMatchObject({
      status: 'failed',
      error: 'backup-key-missing',
    });
    expect(t.source.prepared).toEqual([]);
    t.clock.at = new Date('2026-11-22T02:00:05Z');
    await t.tick.handle();
    expect(
      t.incidents.emitted.filter((i) => i.topic === 'backup.failed'),
    ).toHaveLength(1);
  });

  it('marks a run whose check fails as failed and unverified, and never puts it at the location', async () => {
    const t = setup();
    await ready(t);
    t.verifier.fail = true;
    t.clock.at = new Date('2026-11-21T01:00:05Z');
    await t.tick.handle();
    expect(t.store.runRows[0]).toMatchObject({
      status: 'failed',
      error: 'verify-failed',
      verified: false,
      errorDetail: 'The restored audit_events has 3 rows, the snapshot had 4.',
    });
    expect(
      t.targets.targets.get('s3:openfolia-backups/nightly/')?.stored,
    ).toEqual([]);
    expect(t.source.discarded).toHaveLength(1);
    expect(t.incidents.emitted).toEqual([
      expect.objectContaining({
        topic: 'backup.failed',
        key: 'failed:none',
        payload: expect.objectContaining({ error: 'verify-failed' }),
      }),
    ]);
  });

  it('verifies before encryption when the server keeps no identity', async () => {
    const t = setup();
    await ready(t);
    await t.update.handle({
      actor: admin,
      changes: { verifyByDecrypting: false },
    });
    t.clock.at = new Date('2026-11-21T01:00:05Z');
    await t.tick.handle();
    expect(t.verifier.calls).toEqual([undefined]);
    expect(t.store.runRows[0]).toMatchObject({
      verified: true,
      verifyMode: 'before-encryption',
    });
  });

  it('answers "Back up now" and "Test location" with the exact error', async () => {
    const t = setup();
    await ready(t);
    await t.beat();
    const target = t.targets.open(s3, SECRET) as FakeTarget;
    target.testError = new Error(
      'Writing a test object failed: AccessDenied (HTTP 403): Access Denied.',
    );
    const test = await t.request.handle({
      actor: admin,
      kind: 'test-location',
    });
    expect(await t.tick.handle()).toBe('request');
    expect(await t.store.request(test.id)).toMatchObject({
      status: 'failed',
      error: 'location-test-failed',
      errorDetail:
        'Writing a test object failed: AccessDenied (HTTP 403): Access Denied.',
    });
    target.testError = undefined;
    const again = await t.request.handle({
      actor: admin,
      kind: 'test-location',
    });
    await t.tick.handle();
    expect((await t.store.request(again.id))?.status).toBe('done');
    const now = await t.request.handle({ actor: admin, kind: 'run' });
    await t.tick.handle();
    const done = await t.store.request(now.id);
    expect(done?.status).toBe('done');
    expect(t.store.runRows.find((r) => r.id === done?.runId)).toMatchObject({
      trigger: 'manual',
      status: 'succeeded',
    });
  });

  it('applies retention after a good run', async () => {
    const t = setup();
    await ready(t);
    await t.update.handle({
      actor: admin,
      changes: { retention: { daily: 2, weekly: 0, monthly: 0 } },
    });
    for (const day of ['21', '22', '23', '24']) {
      t.clock.at = new Date(`2026-11-${day}T01:00:05Z`);
      await t.tick.handle();
    }
    const target = t.targets.targets.get('s3:openfolia-backups/nightly/')!;
    expect(target.deleted).toHaveLength(2);
    expect(
      (await target.list()).map((b) => b.at.toISOString().slice(0, 10)),
    ).toEqual(['2026-11-23', '2026-11-24']);
  });

  it('tells admins once when the last good backup is older than the limit', async () => {
    const t = setup();
    await ready(t);
    t.clock.at = new Date('2026-11-21T01:00:05Z');
    await t.tick.handle();
    await t.update.handle({ actor: admin, changes: { enabled: false } });
    await t.update.handle({
      actor: admin,
      changes: {
        enabled: true,
        frequency: { kind: 'cron', expression: '0 0 1 1 *' },
      },
    });
    // 25 hours after the last good backup: within the limit.
    t.clock.at = new Date('2026-11-22T02:00:05Z');
    await t.tick.handle();
    expect(t.incidents.emitted).toEqual([]);
    t.clock.at = new Date('2026-11-22T03:30:00Z');
    await t.tick.handle();
    await t.tick.handle();
    expect(t.incidents.emitted.map((i) => i.topic)).toEqual(['backup.overdue']);
  });

  it('marks runs cut off by a stop as interrupted at the next start', async () => {
    const t = setup();
    await t.store.startRun({
      id: '00000000-0000-4000-8000-000000000001',
      trigger: 'schedule',
      scheduledFor: null,
      startedAt: t.clock.now(),
      processId: 'gone',
      requestId: null,
    });
    await t.tick.recover();
    expect(t.store.runRows[0]).toMatchObject({
      status: 'failed',
      error: 'interrupted',
    });
  });

  it('a failing source marks the run failed with its step', async () => {
    const t = setup();
    await ready(t);
    t.source.failPrepare = new BackupStepError(
      'database-dump-failed',
      'pg_dump exited with 1: connection refused',
    );
    t.clock.at = new Date('2026-11-21T01:00:05Z');
    await t.tick.handle();
    expect(t.store.runRows[0]).toMatchObject({
      status: 'failed',
      error: 'database-dump-failed',
      errorDetail: 'pg_dump exited with 1: connection refused',
    });
  });
});
