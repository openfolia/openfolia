import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { provideZard } from '@openfolia/ui/core';
import { ToasterComponent } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { NotificationBellComponent } from './notification-bell.component';
import { NotificationCenter, POLL_MS } from './notification-center';
import type { NotificationItem } from './notification-model';
import { notification } from './testing/notifications';
import { NotificationsSheetComponent } from './notifications-sheet.component';
import { advance } from '../testing/fake-time';

/** The shell's wiring: the bell in the header, the sheet beside the page. */
@Component({
  selector: 'of-test-host',
  imports: [
    NotificationBellComponent,
    NotificationsSheetComponent,
    ToasterComponent,
  ],
  template: `
    <button type="button" id="before">before</button>
    <of-notification-bell [open]="sheet.visible()" (pressed)="sheet.toggle()" />
    <of-notifications-sheet #sheet />
    <of-toaster />
  `,
})
class HostPage {}

@Component({ selector: 'of-test-other', template: '' })
class OtherPage {}

const links = { self: '', first: '', last: '', prev: null, next: null };
const pageOf = (
  items: NotificationItem[],
  unreadCount: number,
  currentPage = 1,
  lastPage = 1,
) => ({
  data: items,
  meta: {
    page: { currentPage, lastPage, perPage: 20, total: items.length },
    unreadCount,
  },
  links,
});

const hour = 3600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const returned = notification(
  'n-1',
  'change-set.return',
  {
    changeSetId: 'cs-7',
    title: 'Battery charging',
    by: { kind: 'user', id: 'u-r' },
  },
  { createdAt: ago(60_000) },
);
const approved = notification(
  'n-2',
  'change-set.approve',
  {
    changeSetId: 'cs-8',
    title: 'Safety notes',
    by: { kind: 'user', id: 'u-r' },
  },
  { createdAt: ago(30 * 24 * hour), readAt: ago(29 * 24 * hour) },
);

async function render(url = '/x') {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'x', component: HostPage },
        { path: 'review', component: OtherPage },
      ]),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'u-a',
    kind: 'user',
    name: 'Ann Author',
    role: 'Author',
    permissions: new Set(['content.read']),
  });
  const harness = await RouterTestingHarness.create();
  // Fake time: the sheet's leave transition and the count's poll run on the fake clock. The fake
  // clock runs every timer due in the step, in order, however slow the machine is (#562).
  vi.useFakeTimers();
  const http = TestBed.inject(HttpTestingController);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(0);
      await advance();
    }
  };
  await harness.navigateByUrl(url);
  await settle();
  const count = (unreadCount: number, latest: string | null = 'n-1') =>
    http
      .expectOne((r) => r.url === '/api/me/notifications/unread-count')
      .flush({ meta: { unreadCount, latest } });
  const list = () => http.expectOne((r) => r.url === '/api/me/notifications');
  return {
    http,
    settle,
    harness,
    count,
    list,
    router: TestBed.inject(Router),
    root: () => harness.fixture.nativeElement as HTMLElement,
    /** The sheet lives in the overlay container, outside the host. */
    sheet: () =>
      document.querySelector<HTMLElement>('[data-slot="sheet-content"]'),
    bell: () =>
      document.querySelector<HTMLButtonElement>(
        '[data-testid="notification-bell"]',
      )!,
  };
}

describe('Notifications', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).match(() => true);
    document.querySelector('.cdk-overlay-container')?.replaceChildren();
  });

  describe('the bell', () => {
    it('shows the unread count as a number, and in its name', async () => {
      const t = await render();
      t.count(3);
      await t.settle();
      expect(
        t.root().querySelector('[data-testid="notification-count"]')
          ?.textContent,
      ).toBe('3');
      expect(t.bell().getAttribute('aria-label')).toBe(
        'Notifications, 3 unread',
      );
      expect(t.bell().getAttribute('aria-keyshortcuts')).toBe('Alt+Shift+N');
    });

    it('shows no number at 0 and caps it at 99+', async () => {
      const t = await render();
      t.count(0);
      await t.settle();
      expect(
        t.root().querySelector('[data-testid="notification-count"]'),
      ).toBeNull();
      expect(t.bell().getAttribute('aria-label')).toBe('Notifications');
      void TestBed.inject(NotificationCenter).refreshCount();
      t.count(250);
      await t.settle();
      expect(
        t.root().querySelector('[data-testid="notification-count"]')
          ?.textContent,
      ).toBe('99+');
    });

    it('polls the count every 30 seconds while the tab is visible', async () => {
      const t = await render();
      t.count(0);
      await t.settle();
      vi.advanceTimersByTime(POLL_MS);
      t.count(1, 'n-9');
      await t.settle();
      expect(
        t.root().querySelector('[data-testid="notification-count"]')
          ?.textContent,
      ).toBe('1');
      // And at once when the window gets the focus back.
      window.dispatchEvent(new Event('focus'));
      t.count(2, 'n-10');
      await t.settle();
      expect(t.bell().getAttribute('aria-label')).toBe(
        'Notifications, 2 unread',
      );
    });
  });

  describe('the sheet', () => {
    it('opens from the bell, in the address, grouped by Today and Earlier', async () => {
      const t = await render();
      t.count(1);
      await t.settle();
      t.bell().click();
      await t.settle();
      expect(t.router.url).toBe('/x?notifications=all');
      const request = t.list();
      expect(request.request.params.get('page[size]')).toBe('20');
      expect(request.request.params.has('filter[unread]')).toBe(false);
      request.flush(pageOf([returned, approved], 1));
      await t.settle();
      const sheet = t.sheet()!;
      expect(sheet.getAttribute('role')).toBe('dialog');
      expect(
        [...sheet.querySelectorAll('h3')].map((h) => h.textContent?.trim()),
      ).toEqual(['Today', 'Earlier']);
      const rows = [...sheet.querySelectorAll<HTMLElement>('li a')];
      const parts = (a: HTMLElement) =>
        [...a.querySelectorAll('span.sr-only, span.text-sm, time')]
          .map((e) => e.textContent?.trim())
          .join('|');
      expect(rows.map(parts)).toEqual([
        'Unread:|A reviewer returned “Battery charging” with changes requested|1 minute ago',
        'A reviewer approved “Safety notes”|last month',
      ]);
      expect(rows[0]?.hasAttribute('data-unread')).toBe(true);
      expect(rows[1]?.hasAttribute('data-unread')).toBe(false);
      expect(t.bell().getAttribute('aria-expanded')).toBe('true');
    });

    it('marks one read on click and opens its subject, clearing the count', async () => {
      const t = await render('/x?notifications=all');
      t.count(1);
      t.list().flush(pageOf([returned], 1));
      await t.settle();
      const row = t.sheet()!.querySelector<HTMLAnchorElement>('li a')!;
      row.click();
      await t.settle();
      // Eager: the count is gone before the API answers.
      expect(
        t.root().querySelector('[data-testid="notification-count"]'),
      ).toBeNull();
      const mark: TestRequest = t.http.expectOne(
        (r) => r.url === '/api/me/notifications/read',
      );
      expect(mark.request.method).toBe('POST');
      expect(mark.request.body).toEqual({ meta: { ids: ['n-1'] } });
      mark.flush({ meta: { marked: 1, unreadCount: 0 } });
      await t.settle();
      expect(t.router.url).toBe('/review?cs=cs-7');
    });

    it('does not offer "mark all as read" while nothing is unread', async () => {
      const t = await render('/x?notifications=all');
      t.count(0);
      t.list().flush(pageOf([], 0));
      await t.settle();
      expect(
        t.sheet()!.querySelector('[data-testid="mark-all-read"]'),
      ).toBeNull();
    });

    it('offers "mark all as read" as an icon with a label, so a long translation never squeezes the title', async () => {
      const t = await render('/x?notifications=all');
      t.count(2);
      t.list().flush(pageOf([returned], 2));
      await t.settle();
      const mark = t
        .sheet()!
        .querySelector<HTMLButtonElement>('[data-testid="mark-all-read"]')!;
      expect(mark.getAttribute('aria-label')).toBeTruthy();
      expect(mark.getAttribute('title')).toBe(mark.getAttribute('aria-label'));
      expect(mark.textContent!.trim()).toBe('');

      // Once clicked nothing is unread, so the button goes, and focus stays in the sheet.
      mark.click();
      await t.settle();
      expect(
        t.sheet()!.querySelector('[data-testid="mark-all-read"]'),
      ).toBeNull();
      expect(t.sheet()!.contains(document.activeElement)).toBe(true);
      t.http
        .expectOne((r) => r.url === '/api/me/notifications/read')
        .flush({ meta: { marked: 2, unreadCount: 0 } });
      await t.settle();
    });

    it('puts the count and the row back, with a toast, when marking fails', async () => {
      const t = await render('/x?notifications=all');
      t.count(2);
      t.list().flush(pageOf([returned], 2));
      await t.settle();
      t.sheet()!
        .querySelector<HTMLButtonElement>('[data-testid="mark-all-read"]')!
        .click();
      await t.settle();
      expect(
        t.sheet()!.querySelector('li a')!.hasAttribute('data-unread'),
      ).toBe(false);
      t.http
        .expectOne((r) => r.url === '/api/me/notifications/read')
        .flush(
          { errors: [{ status: '503', title: 'Busy', code: 'unavailable' }] },
          { status: 503, statusText: 'Busy' },
        );
      await t.settle();
      expect(
        t.sheet()!.querySelector('li a')!.hasAttribute('data-unread'),
      ).toBe(true);
      expect(t.bell().getAttribute('aria-label')).toBe(
        'Notifications, 2 unread',
      );
      expect(t.root().textContent).toContain(
        "Couldn't mark the notification read.",
      );
    });

    it('drops an answer for the previous person after a switch', async () => {
      const t = await render('/x?notifications=all');
      t.count(1);
      const stale = t.list();
      TestBed.inject(MeService).set({
        id: 'u-b',
        kind: 'user',
        name: 'Ben',
        role: 'Author',
        permissions: new Set(['content.read']),
      });
      await t.settle();
      stale.flush(pageOf([returned], 1));
      await t.settle();
      expect(t.sheet()!.querySelectorAll('li a').length).toBe(0);
      t.count(0, null);
      for (const request of t.http.match(
        (r) => r.url === '/api/me/notifications',
      )) {
        request.flush(pageOf([], 0));
      }
      await t.settle();
      expect(t.sheet()!.textContent).toContain('Nothing new');
      expect(
        t.root().querySelector('[data-testid="notification-count"]'),
      ).toBeNull();
    });

    it('puts one row back when marking it read fails', async () => {
      const t = await render('/x?notifications=all');
      t.count(1);
      t.list().flush(pageOf([returned], 1));
      await t.settle();
      t.sheet()!.querySelector<HTMLAnchorElement>('li a')!.click();
      await t.settle();
      t.http
        .expectOne((r) => r.url === '/api/me/notifications/read')
        .flush(
          { errors: [{ status: '503', title: 'Busy', code: 'unavailable' }] },
          { status: 503, statusText: 'Busy' },
        );
      await t.settle();
      // The row opened its subject meanwhile; the count and the row are back.
      const center = TestBed.inject(NotificationCenter);
      expect(center.unread()).toBe(1);
      expect(center.items()[0]?.attributes.readAt).toBeNull();
    });

    it('filters to the unread ones, in the address', async () => {
      const t = await render('/x?notifications=all');
      t.count(1);
      t.list().flush(pageOf([returned, approved], 1));
      await t.settle();
      const unreadOnly = [
        ...t.sheet()!.querySelectorAll<HTMLInputElement>('input[type=radio]'),
      ][1]!;
      unreadOnly.click();
      await t.settle();
      expect(t.router.url).toBe('/x?notifications=unread');
      const request = t.list();
      expect(request.request.params.get('filter[unread]')).toBe('true');
      request.flush(pageOf([], 0));
      await t.settle();
      expect(t.sheet()!.textContent).toContain('Nothing new');
    });

    it('loads more below, the button outside the scroller', async () => {
      const t = await render('/x?notifications=all');
      t.count(1);
      t.list().flush(pageOf([returned], 1, 1, 2));
      await t.settle();
      const more = t
        .sheet()!
        .querySelector<HTMLButtonElement>('[data-testid="load-more"]')!;
      expect(
        t
          .sheet()!
          .querySelector('[data-testid="notification-scroller"]')!
          .contains(more),
      ).toBe(false);
      more.click();
      await t.settle();
      const next = t.list();
      expect(next.request.params.get('page[number]')).toBe('2');
      next.flush(pageOf([approved], 1, 2, 2));
      await t.settle();
      expect(t.sheet()!.querySelectorAll('li').length).toBe(2);
      expect(t.sheet()!.querySelector('[data-testid="load-more"]')).toBeNull();
    });

    it('adds what arrives while it is open at the top', async () => {
      const t = await render('/x?notifications=all');
      t.count(1, 'n-2');
      t.list().flush(pageOf([approved], 0));
      await t.settle();
      void TestBed.inject(NotificationCenter).refreshCount();
      t.count(1, 'n-1');
      await t.settle();
      t.list().flush(pageOf([returned, approved], 1));
      await t.settle();
      expect(
        [...t.sheet()!.querySelectorAll('li a')].map((a) =>
          a.hasAttribute('data-unread'),
        ),
      ).toEqual([true, false]);
    });

    it('shows a failed load with a retry', async () => {
      const t = await render('/x?notifications=all');
      t.count(0);
      t.list().flush(
        { errors: [{ status: '503', title: 'Busy', code: 'unavailable' }] },
        { status: 503, statusText: 'Busy' },
      );
      await t.settle();
      expect(t.sheet()!.textContent).toContain(
        "Couldn't load your notifications",
      );
      t.sheet()!
        .querySelector<HTMLButtonElement>('[data-state="error"] button')!
        .click();
      await t.settle();
      t.list().flush(pageOf([], 0));
      await t.settle();
      expect(t.sheet()!.textContent).toContain('Nothing new');
    });

    it('toggles with Alt+Shift+N; Escape closes it and gives the focus back', async () => {
      const t = await render();
      t.count(0);
      await t.settle();
      const before = t.root().querySelector<HTMLButtonElement>('#before')!;
      before.focus();
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          code: 'KeyN',
          key: 'Ñ',
          altKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      );
      await t.settle();
      expect(t.router.url).toBe('/x?notifications=all');
      t.list().flush(pageOf([returned], 1));
      await t.settle();
      const sheet = t.sheet()!;
      sheet.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await t.settle();
      expect(t.router.url).toBe('/x');
      await vi.advanceTimersByTimeAsync(250);
      await t.settle();
      expect(t.sheet()).toBeNull();
      expect(document.activeElement).toBe(before);
    });
  });
});
