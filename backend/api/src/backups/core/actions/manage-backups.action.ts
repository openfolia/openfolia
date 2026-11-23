import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  NotFoundError,
  type Problem,
  UnprocessableError,
  UnprocessableProblems,
} from '../../../base/core/errors.js';
import type { PageRequest, Paginated } from '../../../base/core/paging.js';
import { SecretSealer } from '../../../base/core/secret-sealer.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { BackupClock, BackupStatusSettings } from '../backup-clock.js';
import { normalSubfolder, subfolderProblem } from '../backup-paths.js';
import {
  type BackupKey,
  BackupKeyMaker,
  BackupStore,
} from '../backup-ports.js';
import {
  type BackupRequest,
  type BackupRequestKind,
  type BackupRun,
  SERVICE_STALE_MS,
} from '../backup-run.js';
import {
  type BackupLocation,
  type BackupOverrides,
  type BackupSettings,
  backupIdentityContext,
  type Frequency,
  isTimeZone,
  type Overridable,
  type Retention,
  S3_SECRET_CONTEXT,
  type StoredBackupSettings,
} from '../backup-settings.js';
import {
  checkedOverrides,
  effectiveSettings,
  fingerprintOf,
  fixedBy,
} from '../effective-settings.js';
import { cronOf, nextRuns, scheduleProblem } from '../schedule.js';
import { endpointProblem, reportedAllowPrivate } from '../backup-endpoint.js';

/** Everything about backups needs this (#529): a global permission. */
export const MANAGE_BACKUPS = 'admin.backups' satisfies Permission;

/** The audit subject of the settings. */
export const SETTINGS_SUBJECT = { type: 'backup-settings', id: 'instance' };

/** The backup process, as the page sees it. */
export interface BackupServiceView {
  readonly running: boolean;
  readonly lastSeenAt: Date | null;
}

/** The key in force, as the page shows it: never its identity. */
export interface BackupKeyView {
  readonly fingerprint: string;
  readonly recipient: string | null;
  readonly createdAt: Date | null;
  /** Whether the server keeps its identity sealed (to verify by decrypting). */
  readonly identityKept: boolean;
  /** The variable that sets it, when the environment does. */
  readonly fixedBy: string | null;
}

export interface BackupSettingsView {
  readonly settings: BackupSettings;
  /** Whether an S3 secret key is set (never the key). */
  readonly s3SecretSet: boolean;
  /** Per setting the environment fixes, its variable. */
  readonly fixed: Readonly<Record<string, string>>;
  /** The cron expression in force. */
  readonly schedule: string;
  /** The next three scheduled runs (none while off). */
  readonly nextRuns: readonly Date[];
  readonly service: BackupServiceView;
  readonly key: BackupKeyView | null;
  readonly updatedAt: Date | null;
}

async function overridesOf(
  store: BackupStore,
  now: Date,
): Promise<{
  overrides: BackupOverrides;
  service: BackupServiceView;
  envKeyFingerprint: string | null;
  allowPrivate: boolean;
}> {
  const state = await store.service();
  return {
    allowPrivate: reportedAllowPrivate(state?.overrides),
    overrides: checkedOverrides(state?.overrides),
    service: serviceView(state?.lastSeenAt ?? null, now),
    envKeyFingerprint: state?.keyFingerprint ?? null,
  };
}

function serviceView(lastSeenAt: Date | null, now: Date): BackupServiceView {
  return {
    running:
      lastSeenAt !== null &&
      now.getTime() - lastSeenAt.getTime() < SERVICE_STALE_MS,
    lastSeenAt,
  };
}

function keyView(
  key: BackupKey | undefined,
  overrides: BackupOverrides,
  envKeyFingerprint: string | null,
): BackupKeyView | null {
  if (overrides.key) {
    return {
      fingerprint:
        envKeyFingerprint ?? (overrides.key.value as string | undefined) ?? '',
      recipient: null,
      createdAt: null,
      identityKept: true,
      fixedBy: overrides.key.variable,
    };
  }
  if (!key) return null;
  return {
    fingerprint: key.fingerprint,
    recipient: key.recipient,
    createdAt: key.createdAt,
    identityKept: key.identitySealed !== null,
    fixedBy: null,
  };
}

/** `GET /backup-settings`: the settings in force, what fixes them, the next runs, the key. */
@Injectable()
export class GetBackupSettingsAction extends ActorAction<
  { actor: Actor },
  BackupSettingsView
> {
  readonly policy = MANAGE_BACKUPS;

  constructor(
    private readonly store: BackupStore,
    private readonly clock: BackupClock,
  ) {
    super();
  }

  protected async run(): Promise<BackupSettingsView> {
    const [stored, key, env] = await Promise.all([
      this.store.settings(),
      this.store.currentKey(),
      overridesOf(this.store, this.clock.now()),
    ]);
    return viewOf(stored, key, env, this.clock.now());
  }
}

function viewOf(
  stored: StoredBackupSettings,
  key: BackupKey | undefined,
  env: Awaited<ReturnType<typeof overridesOf>>,
  now: Date,
): BackupSettingsView {
  const settings = effectiveSettings(stored, env.overrides);
  const schedule = cronOf(settings.frequency, settings.time);
  return {
    settings,
    s3SecretSet: stored.s3SecretSealed !== null,
    fixed: fixedBy(env.overrides),
    schedule,
    nextRuns: settings.enabled
      ? nextRuns(schedule, settings.timeZone, now, 3)
      : [],
    service: env.service,
    key: keyView(key, env.overrides, env.envKeyFingerprint),
    updatedAt: stored.updatedAt,
  };
}

/** An S3 location as `PATCH` gives it: the secret key too, write-only. */
export type LocationChange =
  | { readonly kind: 'local'; readonly subfolder: string }
  | {
      readonly kind: 's3';
      readonly endpoint: string | null;
      readonly region: string;
      readonly bucket: string;
      readonly prefix: string;
      readonly accessKeyId: string;
      /** A string sets or replaces it, null removes it, left out keeps it. */
      readonly secretAccessKey?: string | null;
    };

export interface BackupSettingsChanges {
  readonly enabled?: boolean;
  readonly frequency?: Frequency;
  readonly time?: string;
  readonly timeZone?: string;
  readonly retention?: Retention;
  readonly location?: LocationChange;
  readonly verify?: boolean;
  readonly verifyByDecrypting?: boolean;
}

/** An S3 bucket name (the common rules: 3 to 63 lowercase letters, digits, `.` and `-`). */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX = /^[A-Za-z0-9!_.*'()/-]{0,500}$/;

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * `PATCH /backup-settings`: changes what the page sets, recorded with the
 * old and new values (`backup-settings.update`; the S3 secret key only as
 * `set`, `replaced` or `removed`). A setting the environment fixes cannot
 * be changed here (409 `backup-setting-fixed-by-environment`). The local
 * subfolder never leaves the backup volume (422
 * `backup-path-outside-volume`); the backup process checks it on disk too.
 * An S3 location pointed at another endpoint or bucket needs its secret
 * key again (422 `secret-required`), so a secret never goes to a server it
 * was not given for. Turning "verify by decrypting" off drops the key's
 * sealed identity; turning it on needs a key whose identity is kept (422
 * `backup-identity-missing`: rotate the key).
 */
@Injectable()
export class UpdateBackupSettingsAction extends ActorAction<
  { actor: Actor; changes: BackupSettingsChanges },
  BackupSettingsView
> {
  readonly policy = MANAGE_BACKUPS;

  constructor(
    private readonly store: BackupStore,
    private readonly sealer: SecretSealer,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly clock: BackupClock,
  ) {
    super();
  }

  protected async run({
    actor,
    changes,
  }: {
    actor: Actor;
    changes: BackupSettingsChanges;
  }): Promise<BackupSettingsView> {
    const env = await overridesOf(this.store, this.clock.now());
    checkChanges(changes, env.allowPrivate);
    await this.unit.run(async (tx) => {
      const before = await this.store.lockSettings(tx);
      refuseFixed(before, changes, env.overrides);
      const key = await this.store.currentKey(tx);
      const location = this.nextLocation(before, changes.location);
      const after: StoredBackupSettings = {
        enabled: changes.enabled ?? before.enabled,
        frequency: changes.frequency ?? before.frequency,
        time: changes.time ?? before.time,
        timeZone: changes.timeZone ?? before.timeZone,
        // A count the environment fixes keeps its stored value: handed back as in force, it
        // is no change, and it must not outlive the variable.
        retention: changes.retention
          ? {
              daily: env.overrides['retention.daily']
                ? before.retention.daily
                : changes.retention.daily,
              weekly: env.overrides['retention.weekly']
                ? before.retention.weekly
                : changes.retention.weekly,
              monthly: env.overrides['retention.monthly']
                ? before.retention.monthly
                : changes.retention.monthly,
            }
          : before.retention,
        location: location.location,
        verify: changes.verify ?? before.verify,
        verifyByDecrypting:
          changes.verifyByDecrypting ?? before.verifyByDecrypting,
        s3SecretSealed: location.sealed,
        updatedAt: this.clock.now(),
      };
      if (
        after.verifyByDecrypting &&
        !before.verifyByDecrypting &&
        key &&
        key.identitySealed === null
      ) {
        throw new UnprocessableError(
          'backup-identity-missing',
          'The server keeps no identity of the current backup key, so it cannot decrypt to verify. Rotate the key to make one whose identity is kept.',
        );
      }
      const diff: Record<string, { from: unknown; to: unknown }> = {};
      for (const name of [
        'enabled',
        'frequency',
        'time',
        'timeZone',
        'retention',
        'location',
        'verify',
        'verifyByDecrypting',
      ] as const) {
        if (!same(before[name], after[name])) {
          diff[name] = { from: before[name], to: after[name] };
        }
      }
      const secret = location.secretChange;
      if (Object.keys(diff).length === 0 && secret === undefined) return;
      await this.store.saveSettings(tx, after);
      if (
        !after.verifyByDecrypting &&
        before.verifyByDecrypting &&
        key?.identitySealed
      ) {
        await this.store.dropIdentity(tx, key.id);
      }
      await this.auditLog.record(tx, actor, {
        action: 'backup-settings.update',
        subject: SETTINGS_SUBJECT,
        data: {
          changes: diff,
          ...(secret !== undefined && { s3SecretAccessKey: secret }),
        },
      });
    }, BOUNDED);
    const [stored, key] = await Promise.all([
      this.store.settings(),
      this.store.currentKey(),
    ]);
    return viewOf(stored, key, env, this.clock.now());
  }

  private nextLocation(
    before: StoredBackupSettings,
    change: LocationChange | undefined,
  ): {
    location: BackupLocation;
    sealed: string | null;
    secretChange?: 'set' | 'replaced' | 'removed';
  } {
    if (change === undefined) {
      return { location: before.location, sealed: before.s3SecretSealed };
    }
    if (change.kind === 'local') {
      return {
        location: {
          kind: 'local',
          subfolder: normalSubfolder(change.subfolder),
        },
        sealed: null,
        ...(before.s3SecretSealed !== null && {
          secretChange: 'removed' as const,
        }),
      };
    }
    const location: BackupLocation = {
      kind: 's3',
      endpoint: change.endpoint,
      region: change.region,
      bucket: change.bucket,
      prefix: change.prefix,
      accessKeyId: change.accessKeyId,
    };
    const prior = before.location.kind === 's3' ? before.location : undefined;
    if (change.secretAccessKey === null) {
      return {
        location,
        sealed: null,
        ...(before.s3SecretSealed !== null && {
          secretChange: 'removed' as const,
        }),
      };
    }
    if (change.secretAccessKey !== undefined) {
      if (!this.sealer.available) {
        throw new ConflictError(
          'secret-key-missing',
          'The instance has no secret key to seal the S3 secret key with (CCMS_SECRET_KEY_GENERATE=false and none set).',
        );
      }
      return {
        location,
        sealed: this.sealer.seal(change.secretAccessKey, S3_SECRET_CONTEXT),
        secretChange: before.s3SecretSealed === null ? 'set' : 'replaced',
      };
    }
    // Kept: only for the same server and bucket it was given for.
    if (
      before.s3SecretSealed !== null &&
      (!prior ||
        prior.endpoint !== location.endpoint ||
        prior.bucket !== location.bucket ||
        prior.accessKeyId !== location.accessKeyId)
    ) {
      throw new UnprocessableProblems(
        'secret-required',
        'Pointing the S3 location at another endpoint, bucket or access key needs its secret key again.',
        [
          {
            code: 'secret-required',
            detail:
              'Give the secret key again for the new endpoint, bucket or access key, or remove it.',
            pointer: '/data/attributes/location/secretAccessKey',
          },
        ],
      );
    }
    return { location, sealed: before.s3SecretSealed };
  }
}

/** The checks of the values themselves, before the settings are locked. */
function checkChanges(
  changes: BackupSettingsChanges,
  allowPrivate: boolean,
): void {
  const problems: Problem[] = [];
  const at = (field: string) => `/data/attributes/${field}`;
  if (changes.frequency?.kind === 'cron') {
    const problem = scheduleProblem(changes.frequency.expression);
    if (problem) {
      problems.push({
        code: 'invalid-schedule',
        detail: problem,
        pointer: at('frequency/expression'),
      });
    }
  }
  if (changes.timeZone !== undefined && !isTimeZone(changes.timeZone)) {
    problems.push({
      code: 'invalid-time-zone',
      detail: `"${changes.timeZone.slice(0, 64)}" is no time zone (an IANA name such as Europe/Berlin, or UTC).`,
      pointer: at('timeZone'),
    });
  }
  const location = changes.location;
  if (location?.kind === 'local') {
    const problem = subfolderProblem(normalSubfolder(location.subfolder));
    if (problem) {
      problems.push({
        code: 'backup-path-outside-volume',
        detail: problem,
        pointer: at('location/subfolder'),
      });
    }
  } else if (location?.kind === 's3') {
    if (location.endpoint !== null) {
      const problem = endpointProblem(location.endpoint, allowPrivate);
      if (problem) {
        problems.push({
          code: 'invalid-endpoint',
          detail: problem,
          pointer: at('location/endpoint'),
        });
      }
    }
    if (!BUCKET.test(location.bucket)) {
      problems.push({
        code: 'invalid-bucket',
        detail:
          'A bucket name has 3 to 63 lowercase letters, digits, "." and "-".',
        pointer: at('location/bucket'),
      });
    }
    if (!PREFIX.test(location.prefix) || location.prefix.includes('..')) {
      problems.push({
        code: 'invalid-prefix',
        detail: 'A prefix has letters, digits and !_.*\'()/-, and no "..".',
        pointer: at('location/prefix'),
      });
    }
  }
  if (problems.length === 1) {
    const [p] = problems as [Problem];
    throw new UnprocessableProblems(p.code!, p.detail, problems);
  }
  if (problems.length > 1) {
    throw new UnprocessableProblems(
      'invalid-backup-settings',
      'Some settings cannot be used.',
      problems,
    );
  }
}

/** Refuses a change to a setting the environment fixes. */
function refuseFixed(
  stored: StoredBackupSettings,
  changes: BackupSettingsChanges,
  overrides: BackupOverrides,
): void {
  // Against what is in force, so handing back a fixed value unchanged is no change.
  const before = effectiveSettings(stored, overrides);
  const changed: [Overridable, boolean][] = [
    [
      'enabled',
      changes.enabled !== undefined && changes.enabled !== before.enabled,
    ],
    [
      'schedule',
      (changes.frequency !== undefined &&
        !same(changes.frequency, before.frequency)) ||
        (changes.time !== undefined && changes.time !== before.time),
    ],
    [
      'timeZone',
      changes.timeZone !== undefined && changes.timeZone !== before.timeZone,
    ],
    [
      'retention.daily',
      changes.retention !== undefined &&
        changes.retention.daily !== before.retention.daily,
    ],
    [
      'retention.weekly',
      changes.retention !== undefined &&
        changes.retention.weekly !== before.retention.weekly,
    ],
    [
      'retention.monthly',
      changes.retention !== undefined &&
        changes.retention.monthly !== before.retention.monthly,
    ],
    [
      'location',
      changes.location !== undefined &&
        !same(
          { ...changes.location, secretAccessKey: undefined },
          { ...before.location, secretAccessKey: undefined },
        ),
    ],
    [
      'verify',
      changes.verify !== undefined && changes.verify !== before.verify,
    ],
    [
      'verifyByDecrypting',
      changes.verifyByDecrypting !== undefined &&
        changes.verifyByDecrypting !== before.verifyByDecrypting,
    ],
  ];
  for (const [name, isChanged] of changed) {
    const fixed = overrides[name];
    if (isChanged && fixed) {
      throw new ConflictError(
        'backup-setting-fixed-by-environment',
        `${fixed.variable} fixes this setting in the backup service's environment; change it there.`,
        { setting: name, variable: fixed.variable },
      );
    }
  }
}

/** A new key, answered once with its identity. */
export interface MadeBackupKey {
  readonly key: BackupKeyView;
  /** The identity (`AGE-SECRET-KEY-1…`): shown only now. */
  readonly identity: string;
  readonly rotated: boolean;
}

/**
 * `POST /backup-keys`: makes the backup key on first setup, or, with
 * `rotate`, a new one in place of the current (the old backups stay
 * readable with the old key, which the admin keeps). The identity is
 * answered once; the server keeps it sealed only while "verify by
 * decrypting" is on. Recorded as `backup-key.create` or `backup-key.rotate`
 * (fingerprints only).
 */
@Injectable()
export class CreateBackupKeyAction extends ActorAction<
  { actor: Actor; rotate: boolean },
  MadeBackupKey
> {
  readonly policy = MANAGE_BACKUPS;

  constructor(
    private readonly store: BackupStore,
    private readonly maker: BackupKeyMaker,
    private readonly sealer: SecretSealer,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly clock: BackupClock,
  ) {
    super();
  }

  protected async run({
    actor,
    rotate,
  }: {
    actor: Actor;
    rotate: boolean;
  }): Promise<MadeBackupKey> {
    const env = await overridesOf(this.store, this.clock.now());
    if (env.overrides.key) {
      throw new ConflictError(
        'backup-setting-fixed-by-environment',
        `${env.overrides.key.variable} sets the backup key in the backup service's environment; change it there.`,
        { setting: 'key', variable: env.overrides.key.variable },
      );
    }
    const { identity, recipient } = await this.maker.generate();
    const id = randomUUID();
    return this.unit.run(async (tx) => {
      const settings = await this.store.lockSettings(tx);
      const current = await this.store.currentKey(tx);
      if (current && !rotate) {
        throw new ConflictError(
          'backup-key-exists',
          'There is a backup key already; rotate it to make a new one.',
          { fingerprint: current.fingerprint },
        );
      }
      const keep = effectiveSettings(
        settings,
        env.overrides,
      ).verifyByDecrypting;
      if (keep && !this.sealer.available) {
        throw new ConflictError(
          'secret-key-missing',
          'The instance has no secret key to seal the backup key with (CCMS_SECRET_KEY_GENERATE=false and none set).',
        );
      }
      const key: BackupKey = {
        id,
        recipient,
        fingerprint: fingerprintOf(recipient),
        identitySealed: keep
          ? this.sealer.seal(identity, backupIdentityContext(id))
          : null,
        createdAt: this.clock.now(),
        retiredAt: null,
      };
      await this.store.addKey(tx, key);
      await this.auditLog.record(tx, actor, {
        action: current ? 'backup-key.rotate' : 'backup-key.create',
        subject: { type: 'backup-key', id },
        data: {
          fingerprint: key.fingerprint,
          ...(current && { previousFingerprint: current.fingerprint }),
        },
      });
      return {
        key: keyView(key, {}, null)!,
        identity,
        rotated: current !== undefined,
      };
    }, BOUNDED);
  }
}

/** `GET /backup-keys`: every key, newest first (fingerprints, never an identity). */
@Injectable()
export class ListBackupKeysAction extends ActorAction<
  { actor: Actor; page: PageRequest },
  Paginated<BackupKey>
> {
  readonly policy = MANAGE_BACKUPS;

  constructor(private readonly store: BackupStore) {
    super();
  }

  protected run({
    page,
  }: {
    page: PageRequest;
  }): Promise<Paginated<BackupKey>> {
    return this.store.keys(page);
  }
}

/** `GET /backup-runs`: the history, newest first. */
@Injectable()
export class ListBackupRunsAction extends ActorAction<
  { actor: Actor; page: PageRequest },
  Paginated<BackupRun>
> {
  readonly policy = MANAGE_BACKUPS;

  constructor(private readonly store: BackupStore) {
    super();
  }

  protected run({
    page,
  }: {
    page: PageRequest;
  }): Promise<Paginated<BackupRun>> {
    return this.store.runs(page);
  }
}

/**
 * `POST /backup-requests`: asks the backup process to back up now
 * (`run`) or to test the location (`test-location`). It takes the request
 * within a few seconds; the client reads its result. Refused while the
 * process is not running (409 `backup-service-not-running`), and a backup
 * without a key (409 `backup-key-missing`). A request of the same kind
 * still waiting is answered instead of a second one. Recorded as
 * `backup.request`.
 */
@Injectable()
export class RequestBackupAction extends ActorAction<
  { actor: Actor; kind: BackupRequestKind },
  BackupRequest
> {
  readonly policy = MANAGE_BACKUPS;

  constructor(
    private readonly store: BackupStore,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly clock: BackupClock,
  ) {
    super();
  }

  protected async run({
    actor,
    kind,
  }: {
    actor: Actor;
    kind: BackupRequestKind;
  }): Promise<BackupRequest> {
    const now = this.clock.now();
    const state = await this.store.service();
    if (!serviceView(state?.lastSeenAt ?? null, now).running) {
      throw new ConflictError(
        'backup-service-not-running',
        'The backup service is not running: start it (docker compose --profile backup up -d) and try again.',
      );
    }
    if (
      kind === 'run' &&
      !state?.keyFingerprint &&
      !(await this.store.currentKey())
    ) {
      throw new ConflictError(
        'backup-key-missing',
        'There is no backup key yet: create one first.',
      );
    }
    const id = randomUUID();
    const waiting = await this.unit.run(async (tx) => {
      await this.store.lockSettings(tx);
      const pending = await this.store.pendingRequest(tx, kind);
      if (pending) return pending;
      await this.store.addRequest(tx, {
        id,
        kind,
        requestedBy: { kind: actor.kind, id: actor.id },
        createdAt: now,
      });
      await this.auditLog.record(tx, actor, {
        action: 'backup.request',
        subject: { type: 'backup-request', id },
        data: { kind },
      });
      return undefined;
    }, BOUNDED);
    if (waiting) return waiting;
    const made = await this.store.request(id);
    if (!made) throw new Error('The request just made is not there.');
    return made;
  }
}

/** `GET /backup-requests/{id}`: a request and its result. */
@Injectable()
export class GetBackupRequestAction extends ActorAction<
  { actor: Actor; id: string },
  BackupRequest
> {
  readonly policy = MANAGE_BACKUPS;

  constructor(private readonly store: BackupStore) {
    super();
  }

  protected async run({ id }: { id: string }): Promise<BackupRequest> {
    // Checked here, after the permission: an ID that is no UUID names no request.
    const request = UUID.test(id) ? await this.store.request(id) : undefined;
    if (!request) throw new NotFoundError('There is no such backup request.');
    return request;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why the status warns, if it does. */
export type BackupWarning =
  'not-set-up' | 'service-not-running' | 'failed' | 'overdue' | null;

export interface BackupStatus {
  readonly enabled: boolean;
  readonly keySet: boolean;
  readonly service: BackupServiceView;
  readonly lastRun: BackupRun | null;
  readonly lastGoodRun: BackupRun | null;
  readonly warning: BackupWarning;
  readonly warnAfterHours: number;
}

/**
 * `GET /backup-status`: for the admin overview: the last run, the last
 * good one, and a warning when backups are not set up, the process is not
 * running, the last run failed, or the last good backup is older than
 * `CCMS_BACKUP_WARN_AFTER_HOURS`.
 */
@Injectable()
export class GetBackupStatusAction extends ActorAction<
  { actor: Actor },
  BackupStatus
> {
  readonly policy = MANAGE_BACKUPS;

  constructor(
    private readonly store: BackupStore,
    private readonly settings: BackupStatusSettings,
    private readonly clock: BackupClock,
  ) {
    super();
  }

  protected async run(): Promise<BackupStatus> {
    const now = this.clock.now();
    const [stored, key, state, lastRun, lastGoodRun] = await Promise.all([
      this.store.settings(),
      this.store.currentKey(),
      this.store.service(),
      this.store.latestRun(),
      this.store.latestGoodRun(),
    ]);
    const overrides = checkedOverrides(state?.overrides);
    const enabled = effectiveSettings(stored, overrides).enabled;
    const keySet = key !== undefined || overrides.key !== undefined;
    const service = serviceView(state?.lastSeenAt ?? null, now);
    const limit = this.settings.warnAfterHours * 3_600_000;
    // As the process counts it: from the last good backup, or, before the first one, from when
    // the settings were last saved (a fresh setup is not overdue at once).
    const since = lastGoodRun?.startedAt ?? stored.updatedAt;
    const warning: BackupWarning =
      !enabled || !keySet
        ? 'not-set-up'
        : !service.running
          ? 'service-not-running'
          : lastRun?.status === 'failed'
            ? 'failed'
            : since && now.getTime() - since.getTime() > limit
              ? 'overdue'
              : null;
    return {
      enabled,
      keySet,
      service,
      lastRun: lastRun ?? null,
      lastGoodRun: lastGoodRun ?? null,
      warning,
      warnAfterHours: this.settings.warnAfterHours,
    };
  }
}
