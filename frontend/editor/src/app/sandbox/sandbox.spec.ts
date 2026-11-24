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
  SANDBOX_NAVIGATE,
  SANDBOX_REFRESH_MS,
  SandboxSession,
} from './sandbox-session';

const START = Date.parse('2026-11-24T10:00:00Z');
const MINUTE = 60_000;

/** Lets the session's promise chain finish. */
const settled = () => new Promise((resolve) => setTimeout(resolve));

const sandbox = (endsAt: number, portalUrl?: string, endUrl?: string) => ({
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
      ...(endUrl === undefined ? {} : { endUrl }),
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
  const went: string[] = [];

  beforeEach(() => {
    clock.now = START;
    went.length = 0;
    // Only the intervals are faked: the HTTP answers and promises run as always.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    TestBed.configureTestingModule({
      providers: [
        provideZard(),
        provideApi(),
        provideHttpClientTesting(),
        { provide: SANDBOX_CLOCK, useValue: () => clock.now },
        {
          provide: SANDBOX_NAVIGATE,
          useValue: (url: string) => went.push(url),
        },
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
        {
          provide: SANDBOX_NAVIGATE,
          useValue: (url: string) => went.push(url),
        },
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

  describe('"End demo" (#846)', () => {
    const END = '/_demo/api/end';
    /** The request to the end address, resolved against the page's. */
    const toEnd = (r: { url: string }) => new URL(r.url).pathname === END;
    const overlay = () =>
      document.querySelector<HTMLElement>('.cdk-overlay-container');
    afterEach(() => {
      overlay()?.replaceChildren();
    });

    it('is offered only when the API names an end address', async () => {
      await start(sandbox(START + 23 * MINUTE));
      expect(
        banner().el.querySelector('[data-testid="sandbox-end"]'),
      ).toBeNull();
    });

    it('posts the language to the end address, then goes to the page its answer names', async () => {
      const session = await start(sandbox(START + 23 * MINUTE, undefined, END));
      const view = banner();
      const button = view.el.querySelector<HTMLButtonElement>(
        '[data-testid="sandbox-end"]',
      );
      expect(button?.textContent).toContain('End demo');
      expect(button?.getAttribute('aria-haspopup')).toBe('dialog');
      const ended = session.end();
      const request = http.expectOne(toEnd);
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({ lang: 'en' });
      request.flush({ status: 'ended', next: '/?ended=closed&lang=en' });
      await ended;
      expect(went).toHaveLength(1);
      expect(new URL(went[0]!).pathname + new URL(went[0]!).search).toBe(
        '/?ended=closed&lang=en',
      );
    });

    it('follows no next on another origin, and goes to the "it expired" dialog when there is nothing left to end', async () => {
      const session = await start(sandbox(START + 23 * MINUTE, undefined, END));
      let ended = session.end();
      http.expectOne(toEnd).flush({ next: 'https://evil.example/' });
      await ended;
      expect(new URL(went[0]!).host).not.toBe('evil.example');
      expect(new URL(went[0]!).pathname).toBe('/');
      ended = session.end();
      const gone = http.expectOne(toEnd);
      gone.flush(
        { code: 'no-sandbox' },
        { status: 404, statusText: 'Not Found' },
      );
      await ended;
      expect(new URL(went[1]!).pathname).toBe('/');
      expect(new URL(went[1]!).search).toBe('?ended=expired&lang=en');
    });

    it('asks first; a failure is said in the dialog, which stays open', async () => {
      await start(sandbox(START + 23 * MINUTE, undefined, END));
      const view = banner();
      view.el
        .querySelector<HTMLButtonElement>('[data-testid="sandbox-end"]')!
        .click();
      view.fixture.detectChanges();
      await view.fixture.whenStable();
      const dialog = overlay()?.querySelector('[role="alertdialog"]');
      expect(dialog?.textContent).toContain('End your sandbox?');
      expect(dialog?.textContent).toContain('Everything in it is deleted');
      http.expectNone(toEnd);
      dialog!
        .querySelector<HTMLButtonElement>(
          '[data-testid="sandbox-end-confirm"]',
        )!
        .click();
      http
        .expectOne(toEnd)
        .flush(
          { code: 'start-failed' },
          { status: 502, statusText: 'Bad Gateway' },
        );
      await settled();
      view.fixture.detectChanges();
      expect(
        overlay()?.querySelector('[data-testid="sandbox-end-error"]')
          ?.textContent,
      ).toContain('could not be ended');
      expect(overlay()?.querySelector('[role="alertdialog"]')).not.toBeNull();
      expect(went).toEqual([]);
    });

    it('once the session has ended, offers the way back to the start page, without asking and ending nothing', async () => {
      await start(sandbox(START + MINUTE, undefined, END));
      clock.now = START + 2 * MINUTE;
      vi.advanceTimersByTime(5_000);
      const view = banner();
      expect(view.el.querySelector('[data-testid="sandbox-end"]')).toBeNull();
      view.el
        .querySelector<HTMLButtonElement>('[data-testid="sandbox-start-page"]')!
        .click();
      http.expectNone(toEnd);
      expect(new URL(went[0]!).search).toBe('?ended=expired&lang=en');
    });

    it('takes a 404 once on as the sandbox gone: the session has ended', async () => {
      const session = await start(sandbox(START + 60 * MINUTE, undefined, END));
      expect(session.minutesLeft()).toBe(60);
      vi.advanceTimersByTime(SANDBOX_REFRESH_MS);
      http
        .expectOne('/api/sandbox')
        .flush(
          { code: 'no-sandbox' },
          { status: 404, statusText: 'Not Found' },
        );
      await settled();
      expect(session.on()).toBe(true);
      expect(session.minutesLeft()).toBe(0);
      // Answered again (another tab's new sandbox): it runs after all.
      vi.advanceTimersByTime(SANDBOX_REFRESH_MS);
      http
        .expectOne('/api/sandbox')
        .flush(sandbox(START + 90 * MINUTE, undefined, END));
      await settled();
      expect(session.minutesLeft()).toBeGreaterThan(0);
    });
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
