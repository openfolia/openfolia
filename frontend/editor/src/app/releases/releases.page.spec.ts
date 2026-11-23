import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { provideZard } from '@openfolia/ui/core';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import type { ReleaseItem } from './releases-model';
import { ReleasesPage } from './releases.page';
import {
  answer,
  config,
  detail,
  LINE_ID,
  maintenanceLine,
  manual,
  OTHER_ID,
  output,
  paged,
  progress,
  release,
  RELEASE_ID,
} from './testing/releases';
import { advance } from '../testing/fake-time';

type Req = TestRequest['request'];

const releases = [
  release({ major: true }),
  release({
    id: OTHER_ID,
    product: 'south',
    revision: '1.0',
    tag: 'release/south/1.0',
    withdrawal: {
      reason: 'Wrong torque',
      by: { kind: 'user', id: 'publisher' },
      at: '2026-11-18T12:00:00Z',
    },
  } as never),
];

/** The files: 14 in all, 12 done, none failed, for the first; 2 done of 2 for the other. */
const outputsOf = (id: string) =>
  id === RELEASE_ID ? progress('rendering', 14, 12) : progress('done', 2, 2);

/** A release's own read, with where its files stand. */
const releaseRead = (req: Req, of = outputsOf) => {
  const id = req.url.split('/')[3] ?? '';
  const item = releases.find((r) => r.id === id) ?? release({ id });
  return detail(item, of(id));
};

/** The panel's done files. */
const doneFiles = () => paged([output('o1')], 1);

/** The list's answer: every release with where its files stand (#481). */
const listed = (list: readonly ReleaseItem[], of = outputsOf) =>
  paged(list.map((r) => detail(r, of(r.id)).data));

const handlers = (list: readonly ReleaseItem[] = releases, of = outputsOf) =>
  [
    [
      (r: Req) => r.url === '/api/config',
      () => ({
        data: { type: 'ProjectConfig', id: 'main', attributes: config() },
      }),
    ],
    [(r: Req) => r.url === '/api/releases', () => listed(list, of)],
    [(r: Req) => /^\/api\/releases\/[^/]+$/.test(r.url), releaseRead],
    [(r: Req) => /\/api\/releases\/[^/]+\/outputs$/.test(r.url), doneFiles],
    [
      (r: Req) => r.url === '/api/manuals',
      () => paged([manual('op', 'Operating')]),
    ],
    [(r: Req) => r.url === '/api/maintenance-lines', () => paged([])],
    [(r: Req) => r.url === '/api/refs', () => paged([])],
    [
      (r: Req) => r.url === '/api/manuals/op/checks',
      () => paged([], 0, { counts: { blocking: 0, warning: 0 }, commit: 'c1' }),
    ],
    [(r: Req) => r.url === '/api/translations/status', () => paged([], 0)],
  ] as const;

async function render(url: string, permissions = ['content.read']) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'releases', component: ReleasesPage },
        { path: 'releases/:releaseId', children: [] },
      ]),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'reader',
    kind: 'user',
    name: 'Reader',
    role: '',
    permissions: new Set(permissions),
  });
  const harness = await RouterTestingHarness.create();
  const http = TestBed.inject(HttpTestingController);
  void harness.navigateByUrl(url);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      // On fake time (a test of the polling), the fake clock runs what is due (#562).
      if (vi.isFakeTimers()) {
        await advance();
        continue;
      }
      await new Promise((r) => setTimeout(r, 0));
      await harness.fixture.whenStable();
    }
  };
  await settle();
  return {
    harness,
    http,
    settle,
    el: () => harness.routeNativeElement as HTMLElement,
    url: () => TestBed.inject(Router).url,
  };
}

const rows = (el: HTMLElement) =>
  [...el.querySelectorAll('[data-slot="release-row"]')].map((r) =>
    [...r.querySelectorAll('td')].map((td) =>
      td.textContent?.replace(/\s+/g, ' ').trim(),
    ),
  );

afterEach(() => vi.useRealTimers());

describe('ReleasesPage', () => {
  it('lists the releases with their product, version, files and status, read-only for a reader', async () => {
    const { http, settle, el } = await render('/releases');
    const seen = await answer(http, handlers(), settle);
    const list = seen.find((r) => r.url === '/api/releases');
    expect(list?.params.get('page[size]')).toBe('25');
    expect(list?.params.has('filter[state]')).toBe(false);
    // The list counts the files: no read per release (#481).
    expect(seen.filter((r) => r.url.startsWith('/api/releases/'))).toEqual([]);

    const [first, second] = rows(el());
    expect(first?.[0]).toContain('North');
    expect(first?.[1]).toContain('2.1');
    expect(first?.[1]).toContain('Major');
    expect(first?.[2]).toContain('12 of 14');
    expect(
      el().querySelector('[data-progress="rendering"]')?.getAttribute('title'),
    ).toBe('12 of 14 files ready');
    expect(first?.[3]).toContain('Published');
    expect(second?.[0]).toContain('South');
    expect(second?.[2]).toContain('Ready');
    expect(second?.[3]).toContain('Withdrawn');
    // Without `release.publish`: no way to publish.
    expect(
      el().querySelector<HTMLElement>('[data-slot="new-release"]')?.hidden,
    ).toBe(true);
  });

  it('filters by product and status from the address', async () => {
    const { http, settle } = await render(
      '/releases?product=north&state=withdrawn&page=2',
    );
    const seen = await answer(http, handlers([]), settle);
    const list = seen.filter((r) => r.url === '/api/releases');
    expect(list[0]?.params.get('filter[product]')).toBe('north');
    expect(list[0]?.params.get('filter[state]')).toBe('withdrawn');
    expect(list[0]?.params.get('page[number]')).toBe('2');
  });

  it('names failed files in the progress', async () => {
    const { http, settle, el } = await render('/releases');
    await answer(
      http,
      handlers([releases[0] as never], () => progress('failed', 14, 12, 2)),
      settle,
    );
    expect(rows(el())[0]?.[2]).toContain('2 failed');
    expect(
      el().querySelector('[data-progress="failed"]')?.getAttribute('title'),
    ).toBe('2 files failed, 12 of 14 ready');
  });

  it('says a fresh release’s files are being prepared, not that there are none', async () => {
    const { http, settle, el } = await render('/releases');
    await answer(
      http,
      handlers([releases[0] as never], () => progress('planning')),
      settle,
    );
    expect(rows(el())[0]?.[2]).toContain('Preparing');
    expect(rows(el())[0]?.[2]).not.toContain('No files');
  });

  it('opens a release in the panel, its choice in the address, and withdraws it with a reason', async () => {
    const { http, settle, el, harness, url } = await render('/releases', [
      'content.read',
      'release.publish',
    ]);
    await answer(http, handlers(), settle);
    expect(
      el().querySelector<HTMLElement>('[data-slot="new-release"]')?.hidden,
    ).toBe(false);
    (
      el().querySelector(
        '[data-slot="release-row"] button, [data-slot="release-row"]',
      ) as HTMLElement
    ).click();
    await settle();
    await answer(http, handlers(), settle);
    expect(url()).toContain(`release=${RELEASE_ID}`);
    const panel = el().querySelector(
      '[data-slot="release-panel"]',
    ) as HTMLElement;
    expect(panel.textContent).toContain('North 2.1');

    (
      panel.querySelector('[data-slot="withdraw"]') as HTMLButtonElement
    ).click();
    await settle();
    const confirm = document.querySelector(
      '[data-slot="withdraw-confirm"]',
    ) as HTMLButtonElement;
    confirm.click();
    await settle();
    // No reason: nothing is sent, and the field says why.
    expect(http.match((r) => r.url.endsWith('/withdraw'))).toHaveLength(0);
    expect(document.body.textContent).toContain(
      'Say why the release is withdrawn.',
    );

    const reason = document.querySelector(
      '#withdraw-reason',
    ) as HTMLTextAreaElement;
    reason.value = 'Wrong torque';
    reason.dispatchEvent(new Event('input'));
    await settle();
    confirm.click();
    await settle();
    const req = http.expectOne(`/api/releases/${RELEASE_ID}/withdraw`);
    expect(req.request.body).toEqual({ meta: { reason: 'Wrong torque' } });
    req.flush({
      data: release({
        major: true,
        withdrawal: {
          reason: 'Wrong torque',
          by: { kind: 'user', id: 'reader' },
          at: '2026-11-19T09:00:00Z',
        },
      } as never),
    });
    await settle();
    await answer(http, handlers(), settle);
    expect(rows(el())[0]?.[3]).toContain('Withdrawn');
    harness.fixture.destroy();
  });

  it('names the panel’s files by the manual’s title and the variant’s label at the release’s tag (#691)', async () => {
    const { http, settle, el } = await render(
      `/releases?release=${RELEASE_ID}`,
    );
    const atTag = handlers().map(([test, body]) =>
      test({ url: '/api/manuals' } as Req)
        ? ([
            test,
            () => paged([manual('operating', 'Operating manual')]),
          ] as const)
        : ([test, body] as const),
    );
    const seen = await answer(http, atTag, settle);
    // The manuals as they were at the release's tag, as on the release's page.
    expect(
      seen.some(
        (r) =>
          r.url === '/api/manuals' &&
          r.params.get('ref') === 'release/north/2.1',
      ),
    ).toBe(true);
    const file = el().querySelector(
      '[data-slot="release-panel"] li button',
    ) as HTMLButtonElement;
    expect(file.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Operating manual · Large · English',
    );
    expect(file.getAttribute('aria-label')).toBe(
      'Download Operating manual · Large · English',
    );
  });

  it('names a panel’s file by its IDs when its manual is not at the tag', async () => {
    const { http, settle, el } = await render(
      `/releases?release=${RELEASE_ID}`,
    );
    await answer(http, handlers(), settle);
    const file = el().querySelector(
      '[data-slot="release-panel"] li button',
    ) as HTMLButtonElement;
    expect(file.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'operating · model=large · English',
    );
  });

  it('never opens a release read for the person before in the panel of the one acting now (#706)', async () => {
    const outsideId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d';
    const { http, settle, el } = await render(`/releases?release=${outsideId}`);
    // The list (without the chosen release) and the rest answer; the chosen release's own read
    // for the first person stays open.
    const isOutside = (r: Req) => r.url === `/api/releases/${outsideId}`;
    const others = handlers().filter(
      ([test]) => !test({ url: `/api/releases/${outsideId}` } as Req),
    );
    for (let round = 0; round < 4; round++) {
      for (const req of http.match((r) => !isOutside(r))) {
        const handler = others.find(([test]) => test(req.request));
        req.flush(handler ? handler[1](req.request) : paged([]));
      }
      await settle();
    }
    const [before] = http.match(isOutside);
    expect(before).toBeDefined();

    // Another person acts now: they may not read that release.
    TestBed.inject(MeService).set({
      id: 'other',
      kind: 'user',
      name: 'Other',
      role: '',
      permissions: new Set(['content.read']),
    });
    await settle();
    before?.flush(
      detail(
        release({
          id: outsideId,
          revision: '9.9',
          withdrawal: {
            reason: 'Only the first person reads this.',
            by: { kind: 'user', id: 'publisher' },
            at: '2026-11-18T12:00:00Z',
          },
        } as never),
      ),
    );
    await settle();
    expect(el().textContent).not.toContain('Only the first person reads this.');
    expect(el().querySelector('[data-slot="release-panel"]')).toBeNull();
    // Their own reads: the release is not theirs to read.
    for (let round = 0; round < 4; round++) {
      for (const req of http.match(() => true)) {
        if (isOutside(req.request)) {
          req.flush(
            {
              errors: [
                { status: '404', title: 'x', detail: 'x', code: 'not-found' },
              ],
            },
            { status: 404, statusText: 'Not Found' },
          );
          continue;
        }
        const handler = others.find(([test]) => test(req.request));
        req.flush(handler ? handler[1](req.request) : paged([]));
      }
      await settle();
    }
    expect(el().textContent).not.toContain('Only the first person reads this.');
  });

  it('opens no "New release" from the address for a reader', async () => {
    const { http, settle } = await render('/releases?create=open');
    await answer(http, handlers(), settle);
    expect(document.body.textContent).not.toContain('Product and version');
  });

  it('counts rendering files again until they are ready, and stops when the page goes', async () => {
    vi.useFakeTimers();
    const { http, settle, harness } = await render('/releases');
    await answer(http, handlers([releases[0] as never]), settle);
    // 12 of 14: the list read again after 10 s, one request for all of them (#481).
    await vi.advanceTimersByTimeAsync(10_100);
    const isRead = (r: Req) => r.url.startsWith('/api/releases');
    const again = http.match(isRead);
    expect(again.map((r) => r.request.url)).toEqual(['/api/releases']);
    harness.fixture.destroy();
    for (const req of again)
      req.flush(
        listed([releases[0] as never], () => progress('rendering', 14, 13)),
      );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(http.match(isRead)).toHaveLength(0);
  });

  it('opens "New release" from the address, and closing it forgets it', async () => {
    const { http, settle, url } = await render('/releases?create=open', [
      'content.read',
      'release.publish',
    ]);
    await answer(http, handlers(), settle);
    expect(document.body.textContent).toContain('Create release');
    (
      [...document.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Cancel',
      ) as HTMLButtonElement
    ).click();
    await settle();
    expect(url()).toBe('/releases');
  });
  describe('maintenance (#250)', () => {
    const PUBLISHER = ['content.read', 'content.read.draft', 'release.publish'];
    const button = (name: string) =>
      [...document.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === name,
      ) as HTMLButtonElement | undefined;

    it('a published release’s panel starts maintenance; the lines are asked for though the panel only shows a skeleton until then', async () => {
      const { http, settle, el } = await render(
        `/releases?release=${RELEASE_ID}`,
        PUBLISHER,
      );
      const seen = await answer(http, handlers(), settle);
      expect(seen.some((r) => r.url === '/api/maintenance-lines')).toBe(true);
      const section = el().querySelector('[data-slot="maintenance"]');
      expect(section?.textContent).toContain('Start maintenance');
      button('Start maintenance')?.click();
      await settle();
      const posted = http.expectOne(
        (r) => r.url === '/api/maintenance-lines' && r.method === 'POST',
      );
      expect(posted.request.body).toEqual({
        data: {
          type: 'MaintenanceLine',
          relationships: {
            baseRelease: { data: { type: 'Release', id: RELEASE_ID } },
          },
        },
      });
      posted.flush({ data: maintenanceLine() });
      await settle();
      await answer(
        http,
        handlers().map(([test, body]) =>
          test({ url: '/api/maintenance-lines' } as Req)
            ? ([test, () => paged([maintenanceLine()])] as const)
            : ([test, body] as const),
        ),
        settle,
      );
      expect(section?.textContent).toContain('Maintenance line open since');
      expect(document.body.textContent).not.toContain('maintenance/north');
    });

    it('the Maintenance tab lists the lines by product and version, never by branch, and closes one after asking', async () => {
      const { http, settle, el, url } = await render(
        '/releases?tab=maintenance',
        PUBLISHER,
      );
      const withLine = handlers().map(([test, body]) =>
        test({ url: '/api/maintenance-lines' } as Req)
          ? ([test, () => paged([maintenanceLine()])] as const)
          : ([test, body] as const),
      );
      await answer(http, withLine, settle);
      expect(url()).toContain('tab=maintenance');
      // One tab bar: Maintenance is the current tab, not Releases (#139).
      expect(
        el()
          .querySelector('[data-tab="maintenance"]')
          ?.getAttribute('aria-current'),
      ).toBe('page');
      expect(
        el()
          .querySelector('[data-tab="releases"]')
          ?.getAttribute('aria-current'),
      ).toBeNull();
      const row = el().querySelector('[data-slot="line-row"]');
      const cells = [...(row?.querySelectorAll('td') ?? [])].map((td) =>
        td.textContent?.replace(/\s+/g, ' ').trim(),
      );
      expect(cells.slice(0, 4)).toEqual(['North', '2.1', 'North 2.1', 'Open']);
      expect(el().textContent).not.toContain('maintenance/north');
      (
        row?.querySelector('[data-slot="close-line"]') as HTMLButtonElement
      ).click();
      await settle();
      expect(document.body.textContent).toContain(
        'Close the maintenance line North 2.1?',
      );
      button('Close line')?.click();
      await settle();
      // Closed on screen at once, before the API answers.
      expect(
        row?.querySelector('[data-slot="line-state"]')?.textContent,
      ).toContain('Closed');
      const closed = http.expectOne(`/api/maintenance-lines/${LINE_ID}/close`);
      closed.flush({
        data: maintenanceLine({ state: 'closed' }),
      });
      await settle();
      await answer(http, withLine, settle);
    });

    it('a reader without drafts has no Maintenance tab', async () => {
      const { http, settle, el } = await render('/releases');
      await answer(http, handlers(), settle);
      expect(el().querySelector('[data-tab="maintenance"]')).toBeNull();
      expect(
        el()
          .querySelector('[data-tab="releases"]')
          ?.getAttribute('aria-current'),
      ).toBe('page');
    });
  });
});
