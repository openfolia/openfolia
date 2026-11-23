import type { Actor } from '../src/access/core/actor.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import {
  BackupKeyPageDocument,
  BackupRequestDocument,
  BackupRunPageDocument,
  BackupSettingsDocument,
  BackupStatusDocument,
  MadeBackupKeyDocument,
} from '../src/backups/api/backup.resources.js';
import { DrizzleBackupStore } from '../src/backups/repos/drizzle-backup-store.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const admin: Actor = { ...actorWith(['admin.backups']), id: 'sample-admin' };
const rolesAdmin: Actor = { ...actorWith(['admin.roles']), id: 'sample-roles' };
const SECRET = 'e2e-very-secret-s3-key-abcdef';

const body = (attributes: Record<string, unknown>) =>
  JSON.stringify({
    data: { type: 'BackupSettings', id: 'instance', attributes },
  });

describe('backups (#529)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t?.close());
  afterEach(() => t?.actAs(undefined));

  it('answers 403 on every route without admin.backups, also to an admin.roles holder', async () => {
    t.actAs(rolesAdmin);
    const calls = [
      t.get('/backup-settings'),
      t.patch('/backup-settings').send(body({ enabled: true })),
      t.get('/backup-keys'),
      t.post('/backup-keys').send(JSON.stringify({})),
      t.get('/backup-runs'),
      t.post('/backup-requests').send(
        JSON.stringify({
          data: { type: 'BackupRequest', attributes: { kind: 'run' } },
        }),
      ),
      t.get('/backup-requests/00000000-0000-4000-8000-000000000000'),
      t.get('/backup-status'),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(403);
      expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe('forbidden');
    }
  });

  it('reads the defaults, then sets an S3 location whose secret is never answered nor audited', async () => {
    t.actAs(admin);
    const first = await t.get('/backup-settings');
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toBe(JSON_API);
    expect(
      BackupSettingsDocument.parse(first.body).data.attributes,
    ).toMatchObject({
      enabled: false,
      location: { kind: 'local', subfolder: '' },
      verify: true,
    });
    const set = await t.patch('/backup-settings').send(
      body({
        enabled: true,
        frequency: { kind: 'daily' },
        time: '03:15',
        timeZone: 'Europe/Berlin',
        retention: { daily: 5, weekly: 3, monthly: 6 },
        location: {
          kind: 's3',
          endpoint: 'http://seaweedfs:8333',
          region: 'us-east-1',
          bucket: 'openfolia-backups',
          prefix: 'nightly/',
          accessKeyId: 'backup-writer',
          secretAccessKey: SECRET,
        },
      }),
    );
    expect(set.status).toBe(200);
    const doc = BackupSettingsDocument.parse(set.body).data;
    expect(doc.attributes.location).toMatchObject({
      kind: 's3',
      secretAccessKeySet: true,
    });
    expect(doc.meta.nextRuns).toHaveLength(3);
    expect(doc.meta.schedule).toBe('15 3 * * *');
    expect(JSON.stringify(set.body)).not.toContain(SECRET);
    expect(
      JSON.stringify((await t.get('/backup-settings')).body),
    ).not.toContain(SECRET);
    t.actAs({ ...admin, roles: [...admin.roles, ...rolesAdmin.roles] });
    const audit = await t.get(
      '/audit-events?filter[action]=backup-settings.update',
    );
    expect(audit.status).toBe(200);
    expect(JSON.stringify(audit.body)).toContain('"s3SecretAccessKey":"set"');
    expect(JSON.stringify(audit.body)).not.toContain(SECRET);
  });

  it('refuses an S3 endpoint at a link-local or metadata address, in any spelling (422 invalid-endpoint)', async () => {
    t.actAs(admin);
    for (const endpoint of [
      'https://169.254.169.254',
      'https://[::ffff:a9fe:a9fe]',
      'https://[::ffff:169.254.169.254]',
      'https://[64:ff9b::a9fe:a9fe]',
      'https://[fd00:ec2::254]',
      'https://[fe80::1]',
    ]) {
      const res = await t.patch('/backup-settings').send(
        body({
          location: {
            kind: 's3',
            endpoint,
            region: 'us-east-1',
            bucket: 'openfolia-backups',
            prefix: '',
            accessKeyId: 'backup-writer',
            secretAccessKey: SECRET,
          },
        }),
      );
      expect([
        endpoint,
        res.status,
        ErrorDocument.parse(res.body).errors[0]?.code,
      ]).toEqual([endpoint, 422, 'invalid-endpoint']);
    }
  });

  it('refuses a private or loopback S3 address unless the backup service reports CCMS_BACKUP_S3_ALLOW_PRIVATE', async () => {
    t.actAs(admin);
    const save = (endpoint: string) =>
      t.patch('/backup-settings').send(
        body({
          location: {
            kind: 's3',
            endpoint,
            region: 'us-east-1',
            bucket: 'openfolia-backups',
            prefix: '',
            accessKeyId: 'backup-writer',
            secretAccessKey: SECRET,
          },
        }),
      );
    const literals = [
      'http://10.0.0.5:9000',
      'http://127.0.0.1:9000',
      'http://[::1]:9000',
      'http://[::ffff:10.0.0.5]:9000',
      'http://[64:ff9b::a00:5]:9000',
      'http://[fd12::5]:9000',
    ];
    const store = new DrizzleBackupStore(t.database);
    const beat = (allowPrivate: boolean) =>
      // Long stale: what it reported still counts, the service is not running.
      store.heartbeat({
        processId: 'e2e',
        startedAt: new Date(0),
        lastSeenAt: new Date(0),
        overrides: allowPrivate
          ? {
              's3.allowPrivate': {
                variable: 'CCMS_BACKUP_S3_ALLOW_PRIVATE',
                value: true,
              },
            }
          : {},
        keyFingerprint: null,
      });
    for (const allowPrivate of [undefined, false]) {
      if (allowPrivate !== undefined) await beat(allowPrivate);
      for (const endpoint of literals) {
        const res = await save(endpoint);
        expect([
          endpoint,
          res.status,
          ErrorDocument.parse(res.body).errors[0]?.code,
        ]).toEqual([endpoint, 422, 'invalid-endpoint']);
      }
    }
    // A name is checked by the backup service on connecting, against what it resolves to.
    expect((await save('http://s3.internal:9000')).status).toBe(200);
    await beat(true);
    for (const endpoint of literals) {
      expect([endpoint, (await save(endpoint)).status]).toEqual([
        endpoint,
        200,
      ]);
    }
    // Never a link-local one, with the setting too.
    expect((await save('http://[::ffff:a9fe:a9fe]')).status).toBe(422);
  });

  it('refuses a local path outside the backup volume (422 backup-path-outside-volume)', async () => {
    t.actAs(admin);
    for (const subfolder of ['../../etc', '/var/lib/postgresql']) {
      const res = await t
        .patch('/backup-settings')
        .send(body({ location: { kind: 'local', subfolder } }));
      expect(res.status).toBe(422);
      const [error] = ErrorDocument.parse(res.body).errors;
      expect(error?.code).toBe('backup-path-outside-volume');
      expect(error?.source?.pointer).toBe(
        '/data/attributes/location/subfolder',
      );
    }
    const cron = await t
      .patch('/backup-settings')
      .send(body({ frequency: { kind: 'cron', expression: 'every night' } }));
    expect(cron.status).toBe(422);
    expect(ErrorDocument.parse(cron.body).errors[0]?.code).toBe(
      'invalid-schedule',
    );
  });

  it('makes the key once, answers its identity once (no-store), and lists it by fingerprint', async () => {
    t.actAs(admin);
    const made = await t.post('/backup-keys').send(JSON.stringify({}));
    expect(made.status).toBe(201);
    expect(made.headers['cache-control']).toBe('no-store');
    const doc = MadeBackupKeyDocument.parse(made.body);
    expect(doc.meta.identity).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/);
    expect(doc.data.attributes.recipient).toMatch(/^age1/);
    const again = await t.post('/backup-keys').send(JSON.stringify({}));
    expect(again.status).toBe(409);
    expect(ErrorDocument.parse(again.body).errors[0]?.code).toBe(
      'backup-key-exists',
    );
    const listed = await t.get('/backup-keys');
    expect(listed.status).toBe(200);
    const page = BackupKeyPageDocument.parse(listed.body);
    expect(page.data[0]?.attributes.fingerprint).toBe(
      doc.data.attributes.fingerprint,
    );
    expect(JSON.stringify(listed.body)).not.toContain(doc.meta.identity);
    expect(
      JSON.stringify((await t.get('/backup-settings')).body),
    ).not.toContain(doc.meta.identity);
    const rotated = await t
      .post('/backup-keys')
      .send(JSON.stringify({ meta: { rotate: true } }));
    expect(rotated.status).toBe(201);
    expect(MadeBackupKeyDocument.parse(rotated.body).meta.rotated).toBe(true);
  });

  it('refuses a request while the backup service is not running; takes one once it is', async () => {
    t.actAs(admin);
    const req = () =>
      t.post('/backup-requests').send(
        JSON.stringify({
          data: {
            type: 'BackupRequest',
            attributes: { kind: 'test-location' },
          },
        }),
      );
    const off = await req();
    expect(off.status).toBe(409);
    expect(ErrorDocument.parse(off.body).errors[0]?.code).toBe(
      'backup-service-not-running',
    );
    await new DrizzleBackupStore(t.database).heartbeat({
      processId: 'e2e',
      startedAt: new Date(),
      lastSeenAt: new Date(),
      overrides: {},
      keyFingerprint: null,
    });
    const on = await req();
    expect(on.status).toBe(202);
    const request = BackupRequestDocument.parse(on.body).data;
    expect(on.headers['location']).toBe(`/backup-requests/${request.id}`);
    const read = await t.get(`/backup-requests/${request.id}`);
    expect(BackupRequestDocument.parse(read.body).data.attributes.status).toBe(
      'pending',
    );
    expect(
      (await t.get('/backup-requests/00000000-0000-4000-8000-000000000000'))
        .status,
    ).toBe(404);
    expect((await t.get('/backup-requests/not-a-uuid')).status).toBe(404);
  });

  it('answers the status and a paged, empty history', async () => {
    t.actAs(admin);
    const status = await t.get('/backup-status');
    expect(status.status).toBe(200);
    expect(BackupStatusDocument.parse(status.body).data.meta).toMatchObject({
      enabled: true,
      keySet: true,
      // Set up a moment ago: no backup yet, but none overdue either.
      warning: null,
      warnAfterHours: 26,
    });
    const runs = await t.get('/backup-runs?page[size]=5');
    expect(runs.status).toBe(200);
    expect(BackupRunPageDocument.parse(runs.body).meta.page).toMatchObject({
      total: 0,
      perPage: 5,
    });
  });

  it('refuses to change a setting the backup service’s environment fixes (409)', async () => {
    t.actAs(admin);
    await new DrizzleBackupStore(t.database).heartbeat({
      processId: 'e2e',
      startedAt: new Date(),
      lastSeenAt: new Date(),
      overrides: { verify: { variable: 'CCMS_BACKUP_VERIFY', value: true } },
      keyFingerprint: null,
    });
    const fixed = BackupSettingsDocument.parse(
      (await t.get('/backup-settings')).body,
    ).data.meta.fixed;
    expect(fixed).toEqual({ verify: 'CCMS_BACKUP_VERIFY' });
    const res = await t.patch('/backup-settings').send(body({ verify: false }));
    expect(res.status).toBe(409);
    expect(ErrorDocument.parse(res.body).errors[0]).toMatchObject({
      code: 'backup-setting-fixed-by-environment',
      meta: { setting: 'verify', variable: 'CCMS_BACKUP_VERIFY' },
    });
  });
});
