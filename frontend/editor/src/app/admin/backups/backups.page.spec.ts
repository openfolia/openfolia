import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';

import { apiErrorInterceptor } from '../../api/api-interceptors';
import { MeService } from '../../permissions/me';
import type {
  BackupRunItem,
  BackupSettingsResource,
  BackupStatusMeta,
} from './backups-model';
import { BackupsPage } from './backups.page';
import { advance } from '../../testing/fake-time';

const IDENTITY = `AGE-SECRET-KEY-1${'Q'.repeat(58)}`;
const FINGERPRINT = '1a2b-3c4d-5e6f-7a8b';

const settings = (
  over: Partial<BackupSettingsResource['attributes']> = {},
  meta: Partial<BackupSettingsResource['meta']> = {},
): { data: BackupSettingsResource } => ({
  data: {
    type: 'BackupSettings',
    id: 'instance',
    attributes: {
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
        prefix: '',
        accessKeyId: 'writer',
        secretAccessKeySet: true,
      },
      verify: true,
      verifyByDecrypting: true,
      ...over,
    },
    meta: {
      fixed: {},
      schedule: '0 2 * * *',
      nextRuns: [
        '2026-11-21T02:00:00.000Z',
        '2026-11-22T02:00:00.000Z',
        '2026-11-23T02:00:00.000Z',
      ],
      service: { running: true, lastSeenAt: '2026-11-20T08:00:00.000Z' },
      key: {
        fingerprint: FINGERPRINT,
        recipient: `age1${'q'.repeat(58)}`,
        createdAt: '2026-11-19T08:00:00.000Z',
        identityKept: true,
        fixedBy: null,
      },
      updatedAt: '2026-11-19T08:00:00.000Z',
      ...meta,
    },
  },
});

const run: BackupRunItem = {
  type: 'BackupRun',
  id: '00000000-0000-4000-8000-000000000001',
  attributes: {
    trigger: 'schedule',
    status: 'succeeded',
    scheduledFor: '2026-11-20T02:00:00.000Z',
    startedAt: '2026-11-20T02:00:00.000Z',
    finishedAt: '2026-11-20T02:01:05.000Z',
    sizeBytes: 4096,
    sha256: 'a'.repeat(64),
    location: 's3:backups/',
    name: 'openfolia-backup-20261120T020000Z-00000000.tar.age',
    keyFingerprint: FINGERPRINT,
    verified: true,
    verifyMode: 'decrypted',
    error: null,
    errorDetail: null,
  },
};

const status = (over: Partial<BackupStatusMeta> = {}) => ({
  data: {
    type: 'BackupStatus',
    id: 'instance',
    attributes: {},
    meta: {
      enabled: true,
      keySet: true,
      service: { running: true, lastSeenAt: '2026-11-20T08:00:00.000Z' },
      lastRun: run,
      lastGoodRun: run,
      warning: null,
      warnAfterHours: 26,
      ...over,
    },
  },
});

const runs = (items: BackupRunItem[]) => ({
  data: items,
  meta: {
    page: { number: 1, size: 10, total: items.length, totalPages: 1 },
  },
  links: {},
});

async function render(initial = settings()) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'backups', component: BackupsPage }]),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'jane',
    kind: 'user',
    name: 'Jane Doe',
    role: '',
    permissions: new Set(['admin.backups']),
  });
  const { RouterTestingHarness } = await import('@angular/router/testing');
  const harness = await RouterTestingHarness.create();
  // Fake time from here: a closed dialog is waited out on the fake clock. The fake clock runs every
  // timer due in the step, in order, however slow the machine is (#562).
  vi.useFakeTimers();
  const http = TestBed.inject(HttpTestingController);
  void harness.navigateByUrl('/backups');
  const settle = async () => {
    for (let i = 0; i < 6; i++) await advance();
  };
  await settle();
  http.expectOne('/api/backup-settings').flush(initial);
  http.expectOne('/api/backup-status').flush(status());
  await settle();
  for (const req of http.match((r) => r.url.startsWith('/api/backup-runs'))) {
    req.flush(runs([run]));
  }
  await settle();
  const root = harness.routeNativeElement as HTMLElement;
  const slot = <T extends HTMLElement = HTMLElement>(name: string) =>
    root.querySelector<T>(`[data-slot="${name}"]`);
  return { http, settle, root, slot };
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

function body(req: TestRequest): Record<string, unknown> {
  return (req.request.body as { data: { attributes: Record<string, unknown> } })
    .data.attributes;
}

describe('BackupsPage', () => {
  afterEach(() => {
    // A save reads the status and the history again: answered here, as they say nothing new.
    const http = TestBed.inject(HttpTestingController);
    for (const r of http.match('/api/backup-status')) r.flush(status());
    for (const r of http.match((r) => r.url.startsWith('/api/backup-runs'))) {
      r.flush(runs([run]));
    }
    http.verify();
  });

  it('shows the status, the key by fingerprint, the next runs, the history, and the secret only as "Set"', async () => {
    const { root, slot } = await render();
    expect(slot('backup-status-title')?.textContent).toContain('Last backup:');
    expect(slot('backup-status-title')?.textContent).toContain('verified');
    expect(slot('backup-key-fingerprint')?.textContent?.trim()).toBe(
      FINGERPRINT,
    );
    expect(
      root.querySelectorAll('[data-slot="backup-next-runs"] li'),
    ).toHaveLength(3);
    expect(slot('backup-s3-secret-set')).not.toBeNull();
    expect(
      root.querySelector('input[aria-labelledby="backup-s3-secret-label"]'),
    ).toBeNull();
    const row = slot('backup-run');
    expect(row?.getAttribute('data-status')).toBe('succeeded');
    expect(row?.textContent).toContain('Verified');
    expect(slot('backup-run-key')?.textContent).toContain(FINGERPRINT);
  });

  it('shows a setting the backup service fixes as read-only, naming its variable, and never sends it', async () => {
    const { root, slot, http, settle } = await render(
      settings({}, { fixed: { timeZone: 'CCMS_BACKUP_TIME_ZONE' } }),
    );
    const zone = root.querySelector<HTMLInputElement>('#backup-time-zone');
    expect(zone?.disabled).toBe(true);
    expect(root.textContent).toContain('CCMS_BACKUP_TIME_ZONE');
    type(root.querySelector<HTMLInputElement>('#backup-time')!, '04:15');
    await settle();
    slot<HTMLButtonElement>('backup-save')?.click();
    await settle();
    const req = http.expectOne('/api/backup-settings');
    expect(req.request.method).toBe('PATCH');
    expect(body(req)).toEqual({ time: '04:15' });
    req.flush(
      settings(
        { time: '04:15' },
        { fixed: { timeZone: 'CCMS_BACKUP_TIME_ZONE' } },
      ),
    );
    await settle();
  });

  it('replaces the secret write-only, and clears it from the form once saved', async () => {
    const { root, slot, http, settle } = await render();
    slot<HTMLButtonElement>('backup-s3-secret-replace')?.click();
    await settle();
    type(
      root.querySelector<HTMLInputElement>(
        'input[aria-labelledby="backup-s3-secret-label"]',
      )!,
      'n3w-s3cr3t',
    );
    await settle();
    slot<HTMLButtonElement>('backup-save')?.click();
    await settle();
    const req = http.expectOne('/api/backup-settings');
    expect(body(req)['location']).toMatchObject({
      kind: 's3',
      secretAccessKey: 'n3w-s3cr3t',
    });
    req.flush(settings());
    await settle();
    expect(
      root.querySelector('input[aria-labelledby="backup-s3-secret-label"]'),
    ).toBeNull();
    expect(slot('backup-s3-secret-set')).not.toBeNull();
    expect(document.body.innerHTML).not.toContain('n3w-s3cr3t');
  });

  it('says a refused subfolder under its field', async () => {
    const { root, slot, http, settle } = await render(
      settings({ location: { kind: 'local', subfolder: '' } }),
    );
    type(root.querySelector<HTMLInputElement>('#backup-subfolder')!, '../etc');
    await settle();
    slot<HTMLButtonElement>('backup-save')?.click();
    await settle();
    http.expectOne('/api/backup-settings').flush(
      {
        errors: [
          {
            status: '422',
            title: 'Unprocessable Content',
            detail: 'The path leaves the backup volume.',
            code: 'backup-path-outside-volume',
            source: { pointer: '/data/attributes/location/subfolder' },
          },
        ],
      },
      { status: 422, statusText: 'Unprocessable Content' },
    );
    await settle();
    expect(slot('backup-subfolder-error')?.textContent).toContain(
      'inside the backup volume',
    );
    expect(
      root.querySelector('#backup-subfolder')?.getAttribute('aria-invalid'),
    ).toBe('true');
  });

  it('makes the key and shows it once; it is gone from the page once the dialog is closed', async () => {
    const { slot, http, settle } = await render(settings({}, { key: null }));
    slot<HTMLButtonElement>('backup-key-create')?.click();
    await settle();
    const req = http.expectOne('/api/backup-keys');
    expect(req.request.method).toBe('POST');
    req.flush(
      {
        data: {
          type: 'BackupKey',
          id: 'current',
          attributes: {
            fingerprint: FINGERPRINT,
            recipient: `age1${'q'.repeat(58)}`,
            createdAt: '2026-11-20T08:00:00.000Z',
          },
        },
        meta: { identity: IDENTITY, rotated: false, identityKept: true },
      },
      { status: 201, statusText: 'Created' },
    );
    await settle();
    // The page reads the settings again for the new key.
    for (const r of http.match('/api/backup-settings')) r.flush(settings());
    for (const r of http.match('/api/backup-status')) r.flush(status());
    await settle();
    const shown = document.querySelector('[data-slot="backup-key"]');
    expect(shown?.textContent?.trim()).toBe(IDENTITY);
    const done = document.querySelector<HTMLButtonElement>(
      '[data-slot="backup-key-done"]',
    );
    expect(done?.disabled).toBe(true);
    document
      .querySelector<HTMLElement>(
        '[data-slot="backup-key-kept"] input[type="checkbox"]',
      )
      ?.click();
    await settle();
    expect(done?.disabled).toBe(false);
    done?.click();
    await settle();
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    expect(document.body.innerHTML).not.toContain(IDENTITY);
  });
});
