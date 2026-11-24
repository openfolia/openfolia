import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { provideZard } from '@openfolia/ui/core';
import { injectTranslate } from '@openfolia/ui/i18n';

import { ApiError, provideApi } from '../api';
import { apiErrorText } from '../i18n';
import { SandboxBannerComponent } from './sandbox-banner.component';
import {
  SANDBOX_CLOCK,
  SANDBOX_REFRESH_MS,
  SandboxSession,
} from './sandbox-session';

const START = Date.parse('2026-11-24T10:00:00Z');
const MINUTE = 60_000;

/** Lets the session's promise chain finish. */
const settled = () => new Promise((resolve) => setTimeout(resolve));

const sandbox = (endsAt: number, portalUrl?: string) => ({
  data: {
    type: 'Sandbox',
    id: 'current',
    attributes: {
      limits: {
        moduleBytes: 131_072,
        commentLength: 2_000,
        changeSets: 20,
        modules: 50,
        manuals: 10,
        releasesPerHour: 4,
        renderJobs: 1,
        writeBytes: 67_108_864,
      },
      idleMinutes: 30,
      maxMinutes: 90,
      ...(portalUrl === undefined ? {} : { portalUrl }),
    },
    meta: {
      used: {
        changeSets: 1,
        modules: 0,
        manuals: 0,
        releasesLastHour: 0,
        writtenBytes: 0,
      },
      startedAt: new Date(START).toISOString(),
      endsAt: new Date(endsAt).toISOString(),
    },
  },
});

const notFound = {
  errors: [{ status: '404', code: 'not-configured', title: 'Not found' }],
};

describe('the public sandbox (#826)', () => {
  let http: HttpTestingController;
  const clock = { now: START };

  beforeEach(() => {
    clock.now = START;
    // Only the intervals are faked: the HTTP answers and promises run as always.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    TestBed.configureTestingModule({
      providers: [
        provideZard(),
        provideApi(),
        provideHttpClientTesting(),
        { provide: SANDBOX_CLOCK, useValue: () => clock.now },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  const start = async (answer: object, status = 200) => {
    const session = TestBed.inject(SandboxSession);
    const started = session.start();
    const request = http.expectOne('/api/sandbox');
    if (status === 200) request.flush(answer);
    else if (status === 0)
      request.error(new ProgressEvent('error'), { status });
    else request.flush(answer, { status, statusText: 'Not Found' });
    await started;
    return session;
  };

  const banner = () => {
    const fixture = TestBed.createComponent(SandboxBannerComponent);
    fixture.detectChanges();
    return {
      fixture,
      el: fixture.nativeElement as HTMLElement,
      text: (id: string) =>
        (fixture.nativeElement as HTMLElement)
          .querySelector(`[data-testid="${id}"]`)
          ?.textContent?.replace(/\s+/g, ' ')
          .trim() ?? null,
    };
  };

  it('is off on a normal instance (404): no banner, and not asked again', async () => {
    const session = await start(notFound, 404);
    expect(session.status()).toBe('off');
    expect(session.on()).toBe(false);
    expect(session.minutesLeft()).toBeNull();
    expect(banner().el.querySelector('[data-testid="sandbox-banner"]')).toBe(
      null,
    );
    vi.advanceTimersByTime(SANDBOX_REFRESH_MS * 3);
    http.expectNone('/api/sandbox');
  });

  it('links the reader portal in a new tab when the API names one, and not otherwise (#837)', async () => {
    await start(sandbox(START + 23 * MINUTE));
    expect(
      banner().el.querySelector('[data-testid="sandbox-portal-link"]'),
    ).toBeNull();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZard(),
        provideApi(),
        provideHttpClientTesting(),
        { provide: SANDBOX_CLOCK, useValue: () => clock.now },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    await start(sandbox(START + 23 * MINUTE, 'https://manuals.example.org/'));
    const link = banner().el.querySelector<HTMLAnchorElement>(
      '[data-testid="sandbox-portal-link"]',
    );
    expect(link?.getAttribute('href')).toBe('https://manuals.example.org/');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noopener noreferrer');
    expect(link?.textContent).toContain('See the reader portal');
  });

  it('shows the banner with the time left, counting down and read again every minute', async () => {
    const session = await start(sandbox(START + 23 * MINUTE));
    expect(session.on()).toBe(true);
    const view = banner();
    expect(view.text('sandbox-banner')).toContain(
      'A private sandbox: only you see it, and it is deleted after the session.',
    );
    expect(view.text('sandbox-time-left')).toBe('23 min left');
    expect(view.el.querySelector('aside')?.getAttribute('aria-label')).toBe(
      'Sandbox',
    );

    // Counted down between reads.
    clock.now = START + 10 * MINUTE + 1;
    vi.advanceTimersByTime(5_000);
    view.fixture.detectChanges();
    expect(view.text('sandbox-time-left')).toBe('13 min left');

    // Read again: a request elsewhere moved the end.
    clock.now = START + 11 * MINUTE;
    vi.advanceTimersByTime(SANDBOX_REFRESH_MS);
    http.expectOne('/api/sandbox').flush(sandbox(START + 41 * MINUTE));
    await settled();
    view.fixture.detectChanges();
    expect(view.text('sandbox-time-left')).toBe('30 min left');
  });

  it('counts the time left in the browser’s clock, whatever the server’s says', async () => {
    const session = TestBed.inject(SandboxSession);
    const started = session.start();
    // The server's clock is 10 minutes ahead of this device's.
    const serverNow = START + 10 * MINUTE;
    http.expectOne('/api/sandbox').flush(sandbox(serverNow + 20 * MINUTE), {
      headers: { Date: new Date(serverNow).toUTCString() },
    });
    await started;
    expect(session.minutesLeft()).toBe(20);
  });

  it('marks the last minutes, and announces only the end', async () => {
    await start(sandbox(START + 4 * MINUTE));
    const view = banner();
    const time = view.el.querySelector('[data-testid="sandbox-time-left"]');
    expect(time?.hasAttribute('data-soon')).toBe(true);
    // The live region is there from the start, empty, so filling it is heard.
    const status = () =>
      view.el.querySelector('[data-testid="sandbox-ended-status"]');
    expect(status()?.getAttribute('role')).toBe('status');
    expect(status()?.textContent?.trim()).toBe('');
    clock.now = START + 5 * MINUTE;
    vi.advanceTimersByTime(5_000);
    view.fixture.detectChanges();
    expect(status()?.textContent?.trim()).not.toBe('');
  });

  it('says when the session has ended', async () => {
    await start(sandbox(START + MINUTE));
    clock.now = START + 2 * MINUTE;
    vi.advanceTimersByTime(5_000);
    const view = banner();
    expect(view.text('sandbox-time-left')).toBe('The session has ended');
  });

  it('is off while it cannot be asked, and asks again', async () => {
    const session = await start({}, 0);
    expect(session.status()).toBe('off');
    vi.advanceTimersByTime(SANDBOX_REFRESH_MS);
    http.expectOne('/api/sandbox').flush(sandbox(START + 30 * MINUTE));
    await settled();
    expect(session.on()).toBe(true);
  });

  it('says what a sandbox refused and which cap was reached', () => {
    const t = TestBed.runInInjectionContext(() => injectTranslate());
    const say = (
      code: string,
      status: number,
      meta: Record<string, unknown>,
    ) => {
      const text = apiErrorText(
        new ApiError(
          status === 403 ? 'unauthorized' : 'invalid',
          status,
          code,
          '',
          undefined,
          undefined,
          [
            {
              status: String(status),
              code,
              title: '',
              detail: '',
              meta: { ...meta },
            },
          ],
        ),
      );
      return t(text.key, text.params);
    };
    expect(say('sandbox-not-allowed', 403, { refused: 'uploads' })).toBe(
      'Uploads are off in this sandbox.',
    );
    expect(say('sandbox-not-allowed', 403, { refused: 'tokens' })).toBe(
      'Issuing tokens is off in this sandbox: nothing outside may reach it.',
    );
    // ICU keys hold no hyphen: `service-accounts` is selected as `serviceAccounts`.
    expect(
      say('sandbox-not-allowed', 403, { refused: 'service-accounts' }),
    ).toBe(
      'Service accounts are off in this sandbox: nothing outside may reach it.',
    );
    expect(
      say('sandbox-limit-reached', 422, { limit: 'changeSets', max: 20 }),
    ).toBe('This sandbox has made as many revisions as it may (20).');
    expect(
      say('sandbox-limit-reached', 422, { limit: 'commentLength', max: 2000 }),
    ).toContain('at most 2,000 characters');
    expect(
      say('sandbox-limit-reached', 422, { limit: 'writeBytes', max: 64 }),
    ).toBe('This sandbox has written as much as it may over its session.');
  });
});
