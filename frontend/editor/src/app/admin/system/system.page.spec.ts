import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';

import { apiErrorInterceptor } from '../../api/api-interceptors';
import { MeService } from '../../permissions/me';
import {
  fileLabel,
  formatShare,
  formatWait,
  percentUsed,
} from './storage-model';
import { SystemPage } from './system.page';

const links = { self: '', first: '', last: '', prev: null, next: null };
// Sizes are written in decimal units (#690): a megabyte is a million bytes.
const MB = 1_000_000;
const HASH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

function usage(
  over: {
    limit?: number | null;
    used?: number;
    level?: 'unlimited' | 'ok' | 'warning' | 'reached';
    git?: number | null;
  } = {},
) {
  const limit = over.limit === undefined ? null : over.limit;
  const used = over.used ?? 30 * MB;
  return {
    data: {
      type: 'StorageUsage' as const,
      id: 'instance',
      attributes: {
        media: { bytes: used - 10 * MB, files: 12 },
        archivedPdfs: { bytes: 10 * MB, files: 1 },
        gitContent: { bytes: over.git === undefined ? 4 * MB : over.git },
        database: { bytes: 8 * MB },
        limitBytes: limit,
        recountedAt: '2026-11-19T03:00:00.000Z',
      },
      meta: {
        usedBytes: used,
        usedShare: limit === null ? null : used / limit,
        level: over.level ?? (limit === null ? 'unlimited' : 'ok'),
        warnAt: 0.8,
      },
    },
  };
}

const file = (id: string, size: number, fileName: string | null) => ({
  type: 'StoredFile' as const,
  id,
  attributes: {
    reference: `sha256:${id}`,
    size,
    contentType: 'application/zip',
    fileName,
    lastUploadedAt: '2026-11-18T09:30:00.000Z',
  },
});

const files = {
  data: [
    file(HASH, 20 * MB, `${'very-long-file-name-'.repeat(8)}.zip`),
    file(OTHER, 2 * MB, null),
  ],
  meta: { page: { currentPage: 1, lastPage: 1, perPage: 10, total: 2 } },
  links,
};

const about = {
  data: {
    type: 'About',
    id: 'about',
    attributes: {
      license: 'AGPL-3.0-only',
      licenseUrl: 'https://www.gnu.org/licenses/agpl-3.0.html',
      sourceUrl: 'https://code.example/openfolia',
    },
  },
};

const KEY_FILE = `/srv/${'a-long-data-folder-name/'.repeat(4)}ccms-secret.key`;

function secretKey(
  attributes: {
    origin?: 'file' | 'environment' | 'none';
    file?: string | null;
    variable?: 'CCMS_SECRET_KEY' | 'CCMS_WEBHOOKS_SECRET_KEY' | null;
    generate?: boolean;
  } = {},
) {
  return {
    data: {
      type: 'SecretKey' as const,
      id: 'instance',
      attributes: {
        origin: 'file' as const,
        file: KEY_FILE,
        variable: null,
        generate: true,
        ...attributes,
      },
    },
  };
}

function jobs(
  over: Partial<{
    consumers: number;
    ready: number;
    running: number;
    lagSeconds: number;
    level: 'ok' | 'warning';
    lastConsumedAt: string | null;
  }> = {},
) {
  return {
    data: {
      type: 'JobsStatus' as const,
      id: 'jobs',
      attributes: {
        consumers: over.consumers ?? 2,
        lastConsumedAt:
          over.lastConsumedAt === undefined
            ? '2026-11-19T10:00:00.000Z'
            : over.lastConsumedAt,
        ready: over.ready ?? 0,
        running: over.running ?? 3,
        oldestReadyAt: over.ready ? '2026-11-19T09:00:00.000Z' : null,
      },
      meta: {
        checkedAt: '2026-11-19T10:00:05.000Z',
        lagSeconds: over.lagSeconds ?? 0,
        level: over.level ?? 'ok',
        stallSeconds: 300,
      },
    },
  };
}

function outboxStatus(blockedConsumers: string[] = []) {
  return {
    data: {
      type: 'OutboxStatus' as const,
      id: 'outbox',
      attributes: { blockedConsumers },
      meta: { level: blockedConsumers.length > 0 ? 'error' : 'ok' },
    },
  };
}

function mail(
  state: 'on' | 'off' | 'no-secret-key' = 'off',
  over: Record<string, unknown> = {},
) {
  const server = state !== 'off';
  return {
    data: {
      type: 'MailSettings' as const,
      id: 'instance',
      attributes: {
        state,
        host: server ? 'mail.example.com' : null,
        port: server ? 587 : null,
        tls: server ? ('starttls' as const) : null,
        authenticated: server,
        from: server ? 'docs@example.com' : null,
        senderName: 'Docs',
        language: 'en' as const,
        ...over,
      },
    },
  };
}

async function render(
  doc: ReturnType<typeof usage>,
  url = '/system',
  aboutDoc: object = about,
  keyDoc: object = secretKey(),
  permissions: readonly string[] = ['admin.roles'],
  jobsDoc: object = jobs(),
  mailDoc: object = mail(),
  outboxDoc: object = outboxStatus(),
) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'system', component: SystemPage },
        { path: 'media', children: [] },
      ]),
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
    permissions: new Set(permissions as never[]),
  });
  const { RouterTestingHarness } = await import('@angular/router/testing');
  const harness = await RouterTestingHarness.create();
  const http = TestBed.inject(HttpTestingController);
  void harness.navigateByUrl(url);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await harness.fixture.whenStable();
    }
  };
  await settle();
  http.expectOne((r) => r.url === '/api/about').flush(aboutDoc);
  http.expectOne((r) => r.url === '/api/secret-key').flush(keyDoc);
  http.expectOne((r) => r.url === '/api/storage-usage').flush(doc);
  http.expectOne((r) => r.url === '/api/mail').flush(mailDoc);
  const jobsRequest = http.expectOne((r) => r.url === '/api/jobs/status');
  if ('errors' in jobsDoc) {
    jobsRequest.flush(jobsDoc, {
      status: 503,
      statusText: 'Service Unavailable',
    });
  } else {
    jobsRequest.flush(jobsDoc);
  }
  http.expectOne((r) => r.url === '/api/outbox/status').flush(outboxDoc);
  const list = http.expectOne((r) => r.url === '/api/storage-usage/files');
  list.flush(files);
  await settle();
  return {
    http,
    harness,
    list,
    root: harness.routeNativeElement as HTMLElement,
    settle,
  };
}

describe('SystemPage', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('Email (#609)', () => {
    const renderMail = (doc: object) =>
      render(
        usage(),
        '/system',
        about,
        secretKey(),
        ['admin.roles'],
        jobs(),
        doc,
      );

    it('shows the mail server, its TLS and the sender, and sends a test email', async () => {
      const { root, http, settle } = await renderMail(mail('on'));
      const card = root.querySelector('[data-slot="mail-card"]');
      expect(card?.getAttribute('data-state')).toBe('on');
      expect(
        card?.querySelector('[data-slot="mail-server"]')?.textContent?.trim(),
      ).toBe('mail.example.com:587');
      expect(
        card?.querySelector('[data-slot="mail-tls"]')?.textContent,
      ).toContain('STARTTLS, required');
      expect(
        card?.querySelector('[data-slot="mail-sender"]')?.textContent?.trim(),
      ).toBe('Docs <docs@example.com>');
      expect(card?.textContent).not.toContain('password1');

      const button = card?.querySelector<HTMLButtonElement>(
        '[data-slot="mail-test"]',
      );
      button?.click();
      await settle();
      const sent = http.expectOne(
        (r) => r.url === '/api/mail/test' && r.method === 'POST',
      );
      expect(sent.request.body).toEqual({
        data: { type: 'MailTest', attributes: { language: 'en' } },
      });
      sent.flush(
        {
          data: {
            type: 'MailMessage',
            id: '0b3e4a5c-1d2e-4f60-8a7b-9c0d1e2f3a4b',
            attributes: {
              template: 'test',
              to: 'jane@example.com',
              language: 'en',
              status: 'queued',
            },
          },
        },
        { status: 202, statusText: 'Accepted' },
      );
      await settle();
      expect(
        card?.querySelector('[data-slot="mail-test-queued"]')?.textContent,
      ).toContain('jane@example.com');
    });

    it('says why there is no email without a mail server', async () => {
      const { root } = await renderMail(mail('off'));
      const off = root.querySelector('[data-slot="mail-off"]');
      expect(off?.textContent).toContain('no mail server is set');
      expect(off?.textContent).toContain('CCMS_MAIL_URL');
      expect(root.querySelector('[data-slot="mail-test"]')).toBeNull();
    });

    it('says email needs the secret key, and links to where it is set', async () => {
      const { root } = await renderMail(mail('no-secret-key'));
      const notice = root.querySelector('[data-slot="mail-no-secret-key"]');
      expect(notice?.textContent).toContain('it needs the instance secret key');
      expect(notice?.textContent).toContain('mail.example.com');
      expect(root.querySelector('[data-slot="mail-test"]')).toBeNull();
      const entry = root.querySelector<HTMLElement>('#system-secret-key');
      entry!.scrollIntoView = () => undefined;
      notice
        ?.querySelector<HTMLAnchorElement>('[data-slot="mail-secret-key-link"]')
        ?.click();
      expect(document.activeElement).toBe(entry);
    });

    it('shows no queued note when the test email is refused', async () => {
      const { root, http, settle } = await renderMail(mail('on'));
      root.querySelector<HTMLButtonElement>('[data-slot="mail-test"]')?.click();
      await settle();
      http
        .expectOne((r) => r.url === '/api/mail/test')
        .flush(
          {
            errors: [
              {
                status: '422',
                title: 'Unprocessable',
                detail: 'You have no email address.',
                code: 'no-email-address',
              },
            ],
          },
          { status: 422, statusText: 'Unprocessable Entity' },
        );
      await settle();
      expect(root.querySelector('[data-slot="mail-test-queued"]')).toBeNull();
      expect(
        root.querySelector<HTMLButtonElement>('[data-slot="mail-test"]')
          ?.disabled,
      ).toBe(false);
    });
  });

  it('shows the background work: workers, waiting and running jobs, the last job taken (#527)', async () => {
    const { root } = await render(usage());
    const card = root.querySelector('[data-slot="jobs-card"]');
    expect(card?.getAttribute('data-level')).toBe('ok');
    expect(
      card?.querySelector('[data-stat="consumers"]')?.textContent,
    ).toContain('2 running');
    expect(card?.querySelector('[data-stat="ready"]')?.textContent).toContain(
      '0',
    );
    expect(card?.querySelector('[data-stat="running"]')?.textContent).toContain(
      '3',
    );
    expect(card?.querySelector('[data-stat="lag"]')?.textContent).toContain(
      'None waiting',
    );
    expect(
      card?.querySelector('[data-slot="jobs-last-consumed"]')?.textContent,
    ).toContain('Last job taken');
    expect(card?.querySelector('[data-slot="jobs-warning"]')).toBeNull();
    expect(card?.querySelector('[data-slot="jobs-no-consumers"]')).toBeNull();
  });

  it('warns when jobs wait and no worker takes them (#527)', async () => {
    const { root } = await render(
      usage(),
      '/system',
      about,
      secretKey(),
      ['admin.roles'],
      jobs({
        consumers: 0,
        ready: 12,
        running: 0,
        lagSeconds: 900,
        level: 'warning',
        lastConsumedAt: null,
      }),
    );
    const card = root.querySelector('[data-slot="jobs-card"]');
    expect(card?.getAttribute('data-level')).toBe('warning');
    expect(
      card?.querySelector('[data-slot="jobs-warning"]')?.textContent,
    ).toContain('no worker takes them');
    expect(card?.querySelector('[data-stat="lag"]')?.textContent).toContain(
      '15 minutes',
    );
    expect(
      card?.querySelector('[data-stat="consumers"]')?.textContent,
    ).toContain('None running');
    expect(
      card?.querySelector('[data-slot="jobs-last-consumed"]')?.textContent,
    ).toContain('No job taken yet');
  });

  it('says no worker runs when none was heard from, before any warning (#527)', async () => {
    const { root } = await render(
      usage(),
      '/system',
      about,
      secretKey(),
      ['admin.roles'],
      jobs({ consumers: 0, running: 0 }),
    );
    expect(
      root.querySelector('[data-slot="jobs-no-consumers"]')?.textContent,
    ).toContain('No worker has been heard from');
  });

  it('says when a restore holds the outbox, naming what is held and linking to the guide (#619)', async () => {
    const { root } = await render(
      usage(),
      '/system',
      {
        data: {
          ...about.data,
          attributes: {
            ...about.data.attributes,
            docsUrl: 'https://docs.example.org/',
          },
        },
      },
      secretKey(),
      ['admin.roles'],
      jobs(),
      mail(),
      outboxStatus(['change-feed', 'notifications']),
    );
    const held = root.querySelector('[data-slot="outbox-held"]');
    expect(held?.getAttribute('role')).toBe('alert');
    expect(held?.textContent).toContain('Delivery is held after a restore');
    expect(held?.textContent).toContain('the change feed and notifications');
    expect(
      held
        ?.querySelector<HTMLAnchorElement>('[data-slot="outbox-held-link"]')
        ?.getAttribute('href'),
    ).toBe('https://docs.example.org/guide/self-hosting/after-a-restore');
  });

  it('says nothing of the outbox while nothing is held (#619)', async () => {
    const { root } = await render(usage());
    expect(root.querySelector('[data-slot="outbox-held"]')).toBeNull();
  });

  it('shows an error with a retry when the background work cannot be read (#527)', async () => {
    const { root, http, settle } = await render(
      usage(),
      '/system',
      about,
      secretKey(),
      ['admin.roles'],
      { errors: [{ status: '503', code: 'database-unavailable' }] },
    );
    const card = root.querySelector('[data-slot="jobs-card"]');
    const retry = card?.querySelector<HTMLButtonElement>(
      'of-error-state button',
    );
    expect(retry).toBeTruthy();
    retry?.click();
    await settle();
    http.expectOne((r) => r.url === '/api/jobs/status').flush(jobs());
    http.expectOne((r) => r.url === '/api/outbox/status').flush(outboxStatus());
    await settle();
    expect(card?.querySelector('of-error-state')).toBeNull();
    expect(card?.querySelector('[data-stat="running"]')?.textContent).toContain(
      '3',
    );
  });

  it('shows the storage used without a limit, per category, with the instance', async () => {
    const { root, list } = await render(usage());
    expect(list.request.params.get('page[size]')).toBe('10');
    const used = root.querySelector('[data-slot="storage-used"]');
    expect(used?.textContent).toContain('30 MB used');
    expect(used?.textContent).toContain('No storage limit');
    expect(root.querySelector('of-meter-bar')).toBeNull();
    expect(root.querySelector('[data-slot="storage-notice"]')).toBeNull();
    const media = root.querySelector('[data-category="media"]');
    expect(media?.textContent).toContain('20 MB');
    expect(media?.textContent).toContain('12 files');
    expect(root.querySelector('[data-category="pdfs"]')?.textContent).toContain(
      '1 file',
    );
    expect(root.querySelector('[data-category="git"]')?.textContent).toContain(
      '4 MB',
    );
    expect(
      root.querySelector('[data-slot="instance-source"]')?.getAttribute('href'),
    ).toBe('https://code.example/openfolia');
    expect(
      root.querySelector('[data-slot="instance-source-missing"]'),
    ).toBeNull();
  });

  it('tells the admin to set the source address when it is not set', async () => {
    const { root } = await render(usage(), '/system', {
      data: {
        ...about.data,
        attributes: { ...about.data.attributes, sourceUrl: null },
      },
    });
    expect(root.querySelector('[data-slot="instance-source"]')).toBeNull();
    expect(
      root.querySelector('[data-slot="instance-source-missing"]')?.textContent,
    ).toContain('Set CCMS_SOURCE_URL to the public address');
    expect(
      root.querySelector('[data-slot="instance-licence"]')?.textContent,
    ).toContain('AGPL-3.0-only');
  });

  it('shows used against the limit, and warns from 80 %', async () => {
    const { root } = await render(
      usage({ limit: 100 * MB, used: 85 * MB, level: 'warning' }),
    );
    expect(
      root.querySelector('[data-slot="storage-used"]')?.textContent,
    ).toContain('85 MB of 100 MB used');
    const meter = root.querySelector('of-meter-bar');
    expect(meter?.getAttribute('aria-valuenow')).toBe('85');
    expect(
      meter?.querySelector('[data-slot="meter-bar-fill"]')?.classList,
    ).toContain('bg-warning');
    const notice = root.querySelector('[data-slot="storage-notice"]');
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent).toContain('Storage is 85% full');
    const link = notice?.querySelector('[data-slot="storage-unused-link"]');
    expect(link?.getAttribute('href')).toBe('/media?usage=unused');
  });

  it('says so when the limit is reached', async () => {
    const { root } = await render(
      usage({ limit: 30 * MB, used: 30 * MB, level: 'reached' }),
    );
    expect(
      root
        .querySelector('[data-slot="storage-card"]')
        ?.getAttribute('data-level'),
    ).toBe('reached');
    expect(
      root.querySelector('[data-slot="storage-notice"]')?.textContent,
    ).toContain('The storage limit is reached');
    expect(
      root
        .querySelector('[data-slot="meter-bar-fill"]')
        ?.classList.contains('bg-destructive'),
    ).toBe(true);
  });

  it('lists the largest files, each linking to the media library, long names wrapping', async () => {
    const { root } = await render(usage({ git: null }));
    const rows = root.querySelectorAll('[data-slot="stored-file"]');
    expect(rows).toHaveLength(2);
    const first = rows[0]?.querySelector<HTMLAnchorElement>(
      '[data-slot="stored-file-link"]',
    );
    expect(first?.getAttribute('href')).toBe(`/media?q=${HASH}&file=${HASH}`);
    expect(first?.className).toContain('[overflow-wrap:anywhere]');
    expect(rows[0]?.textContent).toContain('20 MB');
    // Without a file name: the start of its hash.
    expect(rows[1]?.textContent).toContain(OTHER.slice(0, 12));
    expect(root.querySelector('[data-category="git"]')?.textContent).toContain(
      'Not known yet',
    );
  });

  it('says the key is in a file the server made, with its wrapping path and the backup hint', async () => {
    const { root } = await render(usage());
    const row = root.querySelector('[data-slot="instance-secret-key"]');
    expect(row?.textContent).toContain('Secret key');
    expect(row?.textContent).toContain(
      'Generated by the server, kept in this file:',
    );
    const path = row?.querySelector('[data-slot="secret-key-file"]');
    expect(path?.textContent).toBe(KEY_FILE);
    expect(path?.className).toContain('[overflow-wrap:anywhere]');
    expect(
      row?.querySelector('[data-slot="secret-key-backup"]')?.textContent,
    ).toContain("Back up this file. Without it, stored secrets can't be read.");
  });

  it('says the operator set the key, and asks to rename the old variable', async () => {
    const { root } = await render(
      usage(),
      '/system',
      about,
      secretKey({
        origin: 'environment',
        file: null,
        variable: 'CCMS_WEBHOOKS_SECRET_KEY',
      }),
    );
    const row = root.querySelector('[data-slot="instance-secret-key"]');
    expect(row?.textContent).toContain(
      'Set by the operator (CCMS_WEBHOOKS_SECRET_KEY)',
    );
    expect(
      row?.querySelector('[data-slot="secret-key-old-name"]')?.textContent,
    ).toContain('rename it to CCMS_SECRET_KEY');
    expect(row?.querySelector('[data-slot="secret-key-file"]')).toBeNull();
    expect(row?.querySelector('[data-slot="secret-key-backup"]')).toBeNull();
  });

  it('says webhooks are off when there is no key', async () => {
    const { root } = await render(
      usage(),
      '/system',
      about,
      secretKey({ origin: 'none', file: null, generate: false }),
    );
    expect(
      root.querySelector('[data-slot="secret-key-none"]')?.textContent,
    ).toContain('None: webhooks are off.');
  });

  it('shows a failed read with a retry', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'system', component: SystemPage }]),
        provideHttpClient(withInterceptors([apiErrorInterceptor])),
        provideHttpClientTesting(),
        provideZard(),
      ],
    });
    const { RouterTestingHarness } = await import('@angular/router/testing');
    const harness = await RouterTestingHarness.create();
    const http = TestBed.inject(HttpTestingController);
    void harness.navigateByUrl('/system');
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 0));
        await harness.fixture.whenStable();
      }
    };
    await settle();
    http.expectOne((r) => r.url === '/api/about').flush(about);
    http
      .expectOne((r) => r.url === '/api/secret-key')
      .flush(
        { errors: [{ status: '403', code: 'forbidden' }] },
        { status: 403, statusText: 'Forbidden' },
      );
    http
      .expectOne((r) => r.url === '/api/storage-usage')
      .flush(
        { errors: [{ status: '503', code: 'database-unavailable' }] },
        { status: 503, statusText: 'Service Unavailable' },
      );
    http.expectOne((r) => r.url === '/api/jobs/status').flush(jobs());
    http
      .expectOne((r) => r.url === '/api/outbox/status')
      .flush(
        { errors: [{ status: '503', code: 'database-unavailable' }] },
        { status: 503, statusText: 'Service Unavailable' },
      );
    http
      .expectOne((r) => r.url === '/api/mail')
      .flush(
        { errors: [{ status: '503', code: 'database-unavailable' }] },
        { status: 503, statusText: 'Service Unavailable' },
      );
    http.expectOne((r) => r.url === '/api/storage-usage/files').flush(files);
    await settle();
    const root = harness.routeNativeElement as HTMLElement;
    expect(root.querySelector('of-error-state')).not.toBeNull();
    // The email section's read failed on its own: its own error, with a retry.
    expect(
      root.querySelector('[data-slot="mail-card"] of-error-state'),
    ).not.toBeNull();
    // The secret key's place unread: said in its row, the rest of the card stands.
    expect(
      root.querySelector('[data-slot="secret-key-error"]')?.textContent?.trim(),
    ).not.toBe('');
    const retry = root.querySelector<HTMLButtonElement>(
      'of-error-state button',
    );
    retry?.click();
    await settle();
    http.expectOne((r) => r.url === '/api/secret-key').flush(secretKey());
    http.expectOne((r) => r.url === '/api/storage-usage').flush(usage());
    await settle();
    root
      .querySelector<HTMLButtonElement>(
        '[data-slot="mail-card"] of-error-state button',
      )
      ?.click();
    await settle();
    http.expectOne((r) => r.url === '/api/mail').flush(mail('off'));
    await settle();
    expect(root.querySelector('of-error-state')).toBeNull();
    expect(root.querySelector('[data-slot="mail-off"]')).not.toBeNull();
    expect(
      root.querySelector('[data-slot="storage-used"]')?.textContent,
    ).toContain('30 MB used');
  });
});

describe('storage model', () => {
  it('writes a wait in the largest whole unit (#527)', () => {
    expect(formatWait(42, 'en')).toBe('42 seconds');
    expect(formatWait(900, 'en')).toBe('15 minutes');
    expect(formatWait(7_300, 'en')).toBe('2 hours');
    expect(formatWait(2 * 86_400 + 5, 'de')).toBe('2 Tage');
  });

  it('gives the share as a percentage for the meter, 0 without a limit', () => {
    expect(percentUsed(usage({ limit: 200, used: 50 }).data)).toBe(25);
    expect(percentUsed(usage({ limit: 10, used: 50 }).data)).toBe(100);
    expect(percentUsed(usage().data)).toBe(0);
  });

  it('formats a share in the locale, keeping a decimal for small ones', () => {
    expect(formatShare(0.853, 'en')).toBe('85%');
    expect(formatShare(0.004, 'en')).toBe('0.4%');
    // Rounded down: 100 % only at the limit.
    expect(formatShare(0.996, 'en')).toBe('99%');
    expect(formatShare(0.29, 'en')).toBe('29%');
    expect(formatShare(0.85, 'de')).toMatch(/^85\s%$/);
  });

  it('names a file by its file name, else its hash', () => {
    expect(fileLabel(file(HASH, 1, 'a.zip'))).toBe('a.zip');
    expect(fileLabel(file(HASH, 1, null))).toBe(HASH.slice(0, 12));
  });

  it('shows the backup status to those holding admin.backups only', async () => {
    const without = await render(usage());
    expect(
      without.root.querySelector('[data-slot="system-backups"]'),
    ).toBeNull();
    without.http.expectNone('/api/backup-status');
    TestBed.resetTestingModule();

    const { root, http, settle } = await render(
      usage(),
      '/system',
      about,
      secretKey(),
      ['admin.roles', 'admin.backups'],
    );
    http.expectOne('/api/backup-status').flush({
      data: {
        type: 'BackupStatus',
        id: 'instance',
        attributes: {},
        meta: {
          enabled: true,
          keySet: true,
          service: { running: true, lastSeenAt: null },
          lastRun: null,
          lastGoodRun: null,
          warning: 'failed',
          warnAfterHours: 26,
        },
      },
    });
    await settle();
    const card = root.querySelector('[data-slot="system-backups"]');
    expect(card?.getAttribute('data-tone')).toBe('destructive');
    expect(card?.textContent).toContain('The last backup failed');
    expect(
      root
        .querySelector('[data-slot="system-backups-link"]')
        ?.getAttribute('href'),
    ).toBe('/admin/backups');
  });
});
