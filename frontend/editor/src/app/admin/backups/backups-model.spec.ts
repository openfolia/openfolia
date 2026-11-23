import {
  type BackupRunItem,
  type BackupSettings,
  type BackupStatusMeta,
  backupErrorText,
  changesOf,
  draftOf,
  fieldOfError,
  fixedVariable,
  formatDuration,
  keyFileName,
  keyFileText,
  rebaseDraft,
  statusSummary,
} from './backups-model';

const SAVED: BackupSettings = {
  enabled: true,
  frequency: { kind: 'daily' },
  time: '02:00',
  timeZone: 'UTC',
  retention: { daily: 7, weekly: 4, monthly: 12 },
  location: {
    kind: 's3',
    endpoint: 'https://s3.example.com',
    region: 'us-east-1',
    bucket: 'backups',
    prefix: 'nightly/',
    accessKeyId: 'writer',
    secretAccessKeySet: true,
  },
  verify: true,
  verifyByDecrypting: true,
};

const run = (
  over: Partial<BackupRunItem['attributes']> = {},
): BackupRunItem => ({
  type: 'BackupRun',
  id: 'r1',
  attributes: {
    trigger: 'schedule',
    status: 'succeeded',
    scheduledFor: null,
    startedAt: '2026-11-20T02:00:00.000Z',
    finishedAt: '2026-11-20T02:01:00.000Z',
    sizeBytes: 4096,
    sha256: null,
    location: 'local:',
    name: 'b.tar.age',
    keyFingerprint: '0000-0000-0000-0000',
    verified: true,
    verifyMode: 'decrypted',
    error: null,
    errorDetail: null,
    ...over,
  },
});

const status = (over: Partial<BackupStatusMeta> = {}): BackupStatusMeta => ({
  enabled: true,
  keySet: true,
  service: { running: true, lastSeenAt: '2026-11-20T08:00:00.000Z' },
  lastRun: null,
  lastGoodRun: null,
  warning: null,
  warnAfterHours: 26,
  ...over,
});

describe('changesOf', () => {
  it('sends nothing for the saved settings, the secret kept', () => {
    expect(changesOf(SAVED, draftOf(SAVED))).toEqual({});
  });

  it('sends only what changed, the frequency and location whole', () => {
    const draft = {
      ...draftOf(SAVED),
      frequency: 'weekly' as const,
      weekday: 0,
      daily: 3,
      bucket: ' other ',
    };
    expect(changesOf(SAVED, draft)).toEqual({
      frequency: { kind: 'weekly', weekday: 0 },
      retention: { daily: 3, weekly: 4, monthly: 12 },
      location: {
        kind: 's3',
        endpoint: 'https://s3.example.com',
        region: 'us-east-1',
        bucket: 'other',
        prefix: 'nightly/',
        accessKeyId: 'writer',
      },
    });
  });

  it('sends the secret only when it is replaced or removed', () => {
    const replaced = changesOf(SAVED, {
      ...draftOf(SAVED),
      secret: { kind: 'replace', value: 's3cr3t' },
    });
    expect(replaced.location).toMatchObject({ secretAccessKey: 's3cr3t' });
    const removed = changesOf(SAVED, {
      ...draftOf(SAVED),
      secret: { kind: 'remove' },
    });
    expect(removed.location).toMatchObject({ secretAccessKey: null });
  });

  it('sends a changed retention count while another is fixed, the fixed one as in force', () => {
    const draft = { ...draftOf(SAVED), daily: 10 };
    expect(
      changesOf(SAVED, draft, {
        'retention.weekly': 'CCMS_BACKUP_RETENTION_WEEKLY',
      }),
    ).toEqual({ retention: { daily: 10, weekly: 4, monthly: 12 } });
  });

  it('never sends a setting the backup service fixes', () => {
    const draft = { ...draftOf(SAVED), enabled: false, time: '04:00' };
    expect(changesOf(SAVED, draft, { enabled: 'CCMS_BACKUP_ENABLED' })).toEqual(
      { time: '04:00' },
    );
    expect(fixedVariable({ schedule: 'CCMS_BACKUP_SCHEDULE' }, 'weekday')).toBe(
      'CCMS_BACKUP_SCHEDULE',
    );
    expect(fixedVariable({}, 'weekday')).toBeNull();
  });
});

describe('rebaseDraft', () => {
  it('keeps the fields edited and takes the others from the settings read again', () => {
    const base = draftOf(SAVED);
    const edited = { ...base, time: '05:00' };
    const next = { ...base, daily: 9, time: '02:30' };
    expect(rebaseDraft(base, edited, next)).toEqual({
      ...base,
      daily: 9,
      time: '05:00',
    });
  });
});

describe('errors', () => {
  it('places a refusal under its field and words the known codes', () => {
    const error = {
      status: '422',
      title: 'Unprocessable',
      detail: 'The path leaves the backup volume.',
      code: 'backup-path-outside-volume',
      source: { pointer: '/data/attributes/location/subfolder' },
    };
    expect(fieldOfError(error)).toBe('subfolder');
    expect(backupErrorText(error)?.key).toBe(
      'editor.admin.backups.errors.outsideVolume',
    );
    expect(
      fieldOfError({ ...error, source: { pointer: '/data/id' } }),
    ).toBeNull();
    expect(backupErrorText({ ...error, code: 'something-else' })).toBeNull();
  });
});

describe('statusSummary', () => {
  const now = new Date('2026-11-20T08:00:00.000Z');

  it('says the last good backup and that it was verified', () => {
    const s = statusSummary(status({ lastGoodRun: run() }), now, 'en');
    expect(s.tone).toBe('ok');
    expect(s.title.key).toBe('editor.admin.backups.status.lastVerified');
    expect(s.title.params?.['ago']).toMatch(/6 hours ago/);
  });

  it('warns when overdue, saying since when, or that there was none', () => {
    const late = statusSummary(
      status({ warning: 'overdue', lastGoodRun: run() }),
      new Date('2026-11-22T08:00:00.000Z'),
      'en',
    );
    expect(late.tone).toBe('warning');
    expect(late.title.key).toBe('editor.admin.backups.status.overdue');
    expect(late.detail?.key).toBe('editor.admin.backups.status.overdueDetail');
    const none = statusSummary(status({ warning: 'overdue' }), now, 'en');
    expect(none.title.key).toBe('editor.admin.backups.status.never');
    expect(none.detail?.key).toBe(
      'editor.admin.backups.status.neverOverdueDetail',
    );
  });

  it('is loud after a failure and quiet before the set-up', () => {
    expect(statusSummary(status({ warning: 'failed' }), now, 'en').tone).toBe(
      'destructive',
    );
    expect(
      statusSummary(status({ warning: 'not-set-up' }), now, 'en').title.key,
    ).toBe('editor.admin.backups.status.notSetUp');
  });
});

describe('the key file and durations', () => {
  it('names the file by fingerprint and puts the identity on a line of its own', () => {
    expect(keyFileName('1a2b-3c4d-5e6f-7a8b')).toBe(
      'openfolia-backup-key-1a2b-3c4d-5e6f-7a8b.txt',
    );
    const text = keyFileText(
      'AGE-SECRET-KEY-1ABC',
      '1a2b-3c4d-5e6f-7a8b',
      '2026-11-20T08:00:00.000Z',
    );
    expect(text.split('\n')).toContain('AGE-SECRET-KEY-1ABC');
    expect(text).toContain('1a2b-3c4d-5e6f-7a8b');
  });

  it('says how long a run took', () => {
    expect(formatDuration(65_000, 'en')).toMatch(/1.*m.*5.*s/);
  });
});
