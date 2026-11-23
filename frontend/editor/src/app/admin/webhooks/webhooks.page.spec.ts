import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  type TestRequest,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../../api/api-interceptors';
import { MeService } from '../../permissions/me';
import { AdminActions } from '../admin-actions';
import { WebhooksPage } from './webhooks.page';
import { advance } from '../../testing/fake-time';

const links = { self: '', first: '', last: '', prev: null, next: null };
const page = (total: number, perPage = 10, lastPage = 1) => ({
  currentPage: 1,
  lastPage,
  perPage,
  total,
});

const HOOK = '0190a5c0-0000-7000-8000-000000000001';
const OTHER = '0190a5c0-0000-7000-8000-000000000002';
const DELIVERY = '0190a5c0-0000-7000-8000-0000000000d1';
const PING_ID = '0190a5c0-0000-7000-8000-0000000000d2';
const LONG_URL = `https://receiver.example/${'very-long-path-segment/'.repeat(12)}hook`;
const SECRET = `whsec_${'b'.repeat(64)}`;

const webhook = (
  id: string,
  over: {
    description?: string | null;
    url?: string;
    active?: boolean;
    disabledReason?: 'failing' | null;
    maxAudience?: string | null;
    owner?: string;
    lastDelivery?: unknown;
    consecutiveFailures?: number;
    headers?: unknown[];
  } = {},
) => ({
  type: 'Webhook',
  id,
  attributes: {
    url: over.url ?? 'https://portal.example/hooks',
    description:
      over.description === undefined ? 'Portal build' : over.description,
    events: ['manual.released', 'module.released'],
    maxAudience: over.maxAudience ?? null,
    active: over.active ?? true,
    owner: { kind: 'user', id: over.owner ?? 'jane' },
    headers: over.headers ?? [],
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    secretRotatedAt: '2026-11-01T10:00:00.000Z',
  },
  meta: {
    disabledReason: over.disabledReason ?? null,
    disabledAt: over.disabledReason ? '2026-11-02T10:00:00.000Z' : null,
    consecutiveFailures: over.consecutiveFailures ?? 0,
    previousSecretUntil: null,
    lastDelivery: over.lastDelivery ?? null,
  },
});

const delivery = (
  id: string,
  over: {
    event?: string;
    status?: string;
    attempts?: number;
    code?: number | null;
    error?: string | null;
    payload?: Record<string, unknown> | null;
  } = {},
) => ({
  type: 'WebhookDelivery',
  id,
  attributes: {
    event: over.event ?? 'module.released',
    idempotencyKey: `key-${id}`,
    payload:
      over.payload === undefined
        ? { type: 'module.released', data: {} }
        : over.payload,
    status: over.status ?? 'succeeded',
    attempts: over.attempts ?? 1,
    lastAttemptAt: '2026-11-03T10:00:00.000Z',
    lastStatusCode: over.code === undefined ? 200 : over.code,
    lastError: over.error ?? null,
    deliveredAt: null,
    createdAt: '2026-11-03T10:00:00.000Z',
  },
  relationships: { webhook: { data: { type: 'Webhook', id: HOOK } } },
});

const config = {
  data: {
    type: 'ProjectConfig',
    id: 'config',
    attributes: {
      languages: [],
      moduleTypes: [],
      audiences: [
        { id: 'public', label: 'Public' },
        { id: 'customer', label: 'Customer' },
        { id: 'internal', label: 'Internal' },
      ],
      facets: [],
      variantAttributes: [],
      textAttributes: [],
      safetySymbols: [],
    },
  },
};

async function render(url = '/webhooks', permissions = ['webhook.manage']) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'webhooks', component: WebhooksPage }]),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
      AdminActions,
    ],
  });
  TestBed.inject(MeService).set({
    id: 'jane',
    kind: 'user',
    name: 'Jane Doe',
    role: '',
    permissions: new Set(permissions),
  });
  const { RouterTestingHarness } = await import('@angular/router/testing');
  const harness = await RouterTestingHarness.create();
  // Fake time from here: a closed dialog is waited out on the fake clock. The fake clock runs every
  // timer due in the step, in order, however slow the machine is (#562).
  vi.useFakeTimers();
  const http = TestBed.inject(HttpTestingController);
  void harness.navigateByUrl(url);
  const settle = async () => {
    for (let i = 0; i < 4; i++) await advance();
  };
  await settle();
  http.expectOne((r) => r.url === '/api/config').flush(config);
  const el = () => harness.routeNativeElement as HTMLElement;
  const byText = (text: string, root: ParentNode = document) =>
    [
      ...root.querySelectorAll<HTMLElement>(
        'button, [role="menuitem"], z-dropdown-menu-item',
      ),
    ].find((b) => b.textContent?.trim() === text);
  return { http, settle, el, byText };
}

const listRequest = (http: HttpTestingController): TestRequest =>
  http.expectOne((r) => r.url === '/api/webhooks' && r.method === 'GET');
const logRequest = (http: HttpTestingController, id = HOOK): TestRequest =>
  http.expectOne((r) => r.url === `/api/webhooks/${id}/deliveries`);

const list = (...data: unknown[]) => ({
  data,
  meta: { page: page(data.length) },
  links,
});

describe('WebhooksPage', () => {
  describe('the subscriber list', () => {
    it('shows each subscriber as a card: name, wrapping URL, events, audience, state in words and the last result', async () => {
      const { http, settle, el } = await render();
      listRequest(http).flush(
        list(
          webhook(HOOK, {
            url: LONG_URL,
            maxAudience: 'customer',
            lastDelivery: {
              id: DELIVERY,
              event: 'ping',
              status: 'succeeded',
              attempts: 1,
              lastAttemptAt: '2026-11-03T10:00:00.000Z',
              lastStatusCode: 200,
              lastError: null,
              createdAt: '2026-11-03T10:00:00.000Z',
            },
          }),
          webhook(OTHER, {
            description: null,
            url: 'https://failing.example/hook',
            active: false,
            disabledReason: 'failing',
            consecutiveFailures: 5,
          }),
        ),
      );
      await settle();
      logRequest(http).flush({ data: [], meta: { page: page(0) }, links });
      await settle();

      const cards = el().querySelectorAll('[data-slot="webhook-card"]');
      expect(cards).toHaveLength(2);
      const [first, second] = [...cards] as HTMLElement[];
      expect(first!.textContent).toContain('Portal build');
      expect(first!.textContent).toContain(LONG_URL);
      expect(first!.textContent).toContain('manual.released');
      expect(first!.textContent).toContain('Audience filter: Public, Customer');
      expect(first!.textContent).toContain('Active');
      expect(
        first!.querySelector('[data-slot="webhook-last"]')?.textContent,
      ).toMatch(/ping · Delivered · 200/);
      // The URL breaks anywhere rather than widening the page.
      const url = [...first!.querySelectorAll('p')].find((p) =>
        p.textContent?.includes(LONG_URL),
      )!;
      expect(url.className).toContain('[overflow-wrap:anywhere]');
      // No description: named by its host. Failing says so in words, with Re-enable.
      expect(second!.textContent).toContain('failing.example');
      expect(second!.textContent).toContain('Failing');
      expect(second!.textContent).toContain(
        'Turned off after 5 failed deliveries in a row.',
      );
      expect(
        second!.querySelector('[data-slot="webhook-reenable"]'),
      ).toBeTruthy();
      // The first is chosen; its log beside it.
      expect(first!.getAttribute('aria-current')).toBe('true');
      expect(el().textContent).toContain('Recent deliveries · Portal build');
      // Rows scroll inside the frame; the pagination stays outside it.
      const frame = el().querySelector('of-list-frame')!;
      expect(frame.querySelector('[data-slot="list-scroller"]')).toBeTruthy();
      http.verify();
    });

    it('keeps the page and the chosen subscriber in the address', async () => {
      const { http, settle, el } = await render(
        `/webhooks?hook=${OTHER}&page=2`,
      );
      const req = listRequest(http);
      expect(req.request.params.get('page[number]')).toBe('2');
      req.flush({
        data: [webhook(HOOK), webhook(OTHER, { description: 'Search index' })],
        meta: { page: { currentPage: 2, lastPage: 2, perPage: 10, total: 12 } },
        links,
      });
      await settle();
      logRequest(http, OTHER).flush({
        data: [],
        meta: { page: page(0) },
        links,
      });
      await settle();
      expect(el().textContent).toContain('Recent deliveries · Search index');

      (
        el().querySelector(
          '[data-slot="webhook-card"] h3 button',
        ) as HTMLElement
      ).click();
      await settle();
      expect(TestBed.inject(Router).url).toContain(`hook=${HOOK}`);
      logRequest(http).flush({ data: [], meta: { page: page(0) }, links });
      await settle();
      expect(el().textContent).toContain('Recent deliveries · Portal build');
    });

    it('pauses a subscriber at once and offers Resume', async () => {
      const { http, settle, el, byText } = await render();
      listRequest(http).flush(list(webhook(HOOK)));
      await settle();
      logRequest(http).flush({ data: [], meta: { page: page(0) }, links });
      await settle();
      (
        el().querySelector(
          'button[aria-label="Actions for Portal build"]',
        ) as HTMLElement
      ).click();
      await settle();
      byText('Pause')!.click();
      await settle();
      const patch = http.expectOne(
        (r) => r.url === `/api/webhooks/${HOOK}` && r.method === 'PATCH',
      );
      expect(patch.request.body.data.attributes).toEqual({ active: false });
      patch.flush({ data: webhook(HOOK, { active: false }) });
      await settle();
      listRequest(http).flush(list(webhook(HOOK, { active: false })));
      await settle();
      expect(el().textContent).toContain('Paused');
    });

    it('deletes with Undo: hidden at once, sent only when the toast ends', async () => {
      const { http, settle, el, byText } = await render();
      listRequest(http).flush(list(webhook(HOOK)));
      await settle();
      logRequest(http).flush({ data: [], meta: { page: page(0) }, links });
      await settle();
      (
        el().querySelector(
          'button[aria-label="Actions for Portal build"]',
        ) as HTMLElement
      ).click();
      await settle();
      byText('Delete')!.click();
      await settle();
      expect(el().querySelectorAll('[data-slot="webhook-card"]')).toHaveLength(
        0,
      );
      http.expectNone((r) => r.method === 'DELETE');

      // Undo keeps it.
      const toast = TestBed.inject(ToastService);
      toast.runAction(toast.toasts().at(-1)!.id);
      await settle();
      expect(el().querySelectorAll('[data-slot="webhook-card"]')).toHaveLength(
        1,
      );
      http.expectNone((r) => r.method === 'DELETE');

      // Again, and this time the toast runs out.
      (
        el().querySelector(
          'button[aria-label="Actions for Portal build"]',
        ) as HTMLElement
      ).click();
      await settle();
      byText('Delete')!.click();
      await settle();
      toast.dismiss(toast.toasts().at(-1)!.id);
      await settle();
      http
        .expectOne(
          (r) => r.url === `/api/webhooks/${HOOK}` && r.method === 'DELETE',
        )
        .flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      listRequest(http).flush(list());
      await settle();
      expect(el().textContent).toContain('No subscribers yet');
    });
  });

  describe('the form and the one-time secret', () => {
    it('adds a subscriber, shows its secret once with Copy, and forgets it on Done', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });
      const { http, settle, el, byText } = await render();
      listRequest(http).flush(list());
      await settle();
      TestBed.inject(AdminActions).request('webhooks');
      await settle();

      const url = document.querySelector<HTMLInputElement>('#webhook-url')!;
      // Checked as the API checks it, before anything is sent.
      url.value = 'ftp://receiver.example/hook';
      url.dispatchEvent(new Event('input'));
      await settle();
      expect(document.body.textContent).toContain('Use an https:// URL.');
      url.value = 'https://receiver.example/hook';
      url.dispatchEvent(new Event('input'));
      const name = document.querySelector<HTMLInputElement>('#webhook-name')!;
      name.value = '  Receiver  ';
      name.dispatchEvent(new Event('input'));
      await settle();
      byText(
        'Add subscriber',
        document.querySelector('z-dialog-footer') ?? document,
      )!.click();
      await settle();

      const post = http.expectOne(
        (r) => r.url === '/api/webhooks' && r.method === 'POST',
      );
      expect(post.request.body.data.attributes).toEqual({
        url: 'https://receiver.example/hook',
        events: ['manual.released', 'module.released'],
        description: 'Receiver',
      });
      post.flush({
        data: webhook(HOOK, {
          url: 'https://receiver.example/hook',
          description: 'Receiver',
        }),
        meta: { secret: SECRET },
      });
      await settle();
      listRequest(http).flush(
        list(
          webhook(HOOK, {
            url: 'https://receiver.example/hook',
            description: 'Receiver',
          }),
        ),
      );
      await settle();
      logRequest(http).flush({ data: [], meta: { page: page(0) }, links });
      await settle();

      expect(document.querySelector('#webhook-secret')?.textContent).toBe(
        SECRET,
      );
      expect(document.body.textContent).toContain(
        "You won't see this secret again.",
      );
      // Never in the address, the browser's storage or the list.
      expect(TestBed.inject(Router).url).not.toContain(SECRET);
      expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET);
      expect(JSON.stringify({ ...sessionStorage })).not.toContain(SECRET);
      expect(el().textContent).not.toContain(SECRET);

      (
        document.querySelector(
          '[data-slot="webhook-secret-copy"]',
        ) as HTMLElement
      ).click();
      await settle();
      expect(writeText).toHaveBeenCalledWith(SECRET);

      byText('Done')!.click();
      await settle();
      await vi.advanceTimersByTimeAsync(300);
      await settle();
      expect(document.querySelector('#webhook-secret')).toBeNull();
      expect(document.body.textContent).not.toContain(SECRET);
      http.verify();
    });

    // #603: until the list is read again, the new subscriber is not on it; the log went to the
    // first listed meanwhile and read its deliveries, which may be gone by then (a 404).
    it('opens the new subscriber’s log at once, never the first listed one’s on the way', async () => {
      const NEW = '0190a5c0-0000-7000-8000-000000000003';
      const { http, settle, el, byText } = await render(
        `/webhooks?hook=${OTHER}`,
      );
      listRequest(http).flush(
        list(webhook(HOOK), webhook(OTHER, { description: 'Search index' })),
      );
      await settle();
      logRequest(http, OTHER).flush({
        data: [],
        meta: { page: page(0) },
        links,
      });
      await settle();
      TestBed.inject(AdminActions).request('webhooks');
      await settle();

      const url = document.querySelector<HTMLInputElement>('#webhook-url')!;
      url.value = 'https://receiver.example/hook';
      url.dispatchEvent(new Event('input'));
      const name = document.querySelector<HTMLInputElement>('#webhook-name')!;
      name.value = 'Receiver';
      name.dispatchEvent(new Event('input'));
      await settle();
      byText(
        'Add subscriber',
        document.querySelector('z-dialog-footer') ?? document,
      )!.click();
      await settle();
      const created = webhook(NEW, {
        url: 'https://receiver.example/hook',
        description: 'Receiver',
      });
      http
        .expectOne((r) => r.url === '/api/webhooks' && r.method === 'POST')
        .flush({ data: created, meta: { secret: SECRET } });
      await settle();

      // The list is being read again: the log is the new one's already.
      expect(TestBed.inject(Router).url).toContain(`hook=${NEW}`);
      expect(
        http.match((r) => r.url === `/api/webhooks/${HOOK}/deliveries`),
      ).toEqual([]);
      logRequest(http, NEW).flush({ data: [], meta: { page: page(0) }, links });
      listRequest(http).flush(
        list(
          webhook(HOOK),
          webhook(OTHER, { description: 'Search index' }),
          created,
        ),
      );
      await settle();
      expect(el().textContent).toContain('Recent deliveries · Receiver');
      byText('Done')!.click();
      await settle();
      await vi.advanceTimersByTimeAsync(300);
      await settle();
      http.verify();
    });

    it('says webhooks are off when the server has no secret key (not-configured), never "not found"', async () => {
      const { http, settle, byText } = await render();
      listRequest(http).flush(list());
      await settle();
      TestBed.inject(AdminActions).request('webhooks');
      await settle();
      const url = document.querySelector<HTMLInputElement>('#webhook-url')!;
      url.value = 'https://receiver.example/hook';
      url.dispatchEvent(new Event('input'));
      await settle();
      byText(
        'Add subscriber',
        document.querySelector('z-dialog-footer') ?? document,
      )!.click();
      await settle();
      http
        .expectOne((r) => r.url === '/api/webhooks' && r.method === 'POST')
        .flush(
          {
            errors: [
              {
                status: '404',
                title: 'Not configured',
                detail: 'Webhooks are off on this server.',
                code: 'not-configured',
              },
            ],
          },
          { status: 404, statusText: 'Not Found' },
        );
      await settle();
      const dialog = document.body;
      expect(dialog.textContent).toContain(
        'Webhooks are off on this server: it has no secret key to protect their secrets.',
      );
      expect(dialog.textContent).not.toContain('could not be found');
      // The dialog stays open, with what was typed.
      expect(
        document.querySelector<HTMLInputElement>('#webhook-url')?.value,
      ).toBe('https://receiver.example/hook');
      http.verify();
    });

    it('asks for an event, and lets a narrower manager change only the name', async () => {
      const { http, settle, el, byText } = await render();
      listRequest(http).flush(
        list(
          webhook(HOOK, {
            owner: 'someone-else',
            maxAudience: 'public',
          }),
        ),
      );
      await settle();
      logRequest(http).flush({ data: [], meta: { page: page(0) }, links });
      await settle();
      (
        el().querySelector(
          'button[aria-label="Actions for Portal build"]',
        ) as HTMLElement
      ).click();
      await settle();
      // Someone else's, and Jane's scope covers no owner's: no rotation offered.
      expect(byText('Rotate secret')).toBeUndefined();
      byText('Edit')!.click();
      await settle();

      expect(
        document.querySelector<HTMLInputElement>('#webhook-url')!.disabled,
      ).toBe(true);
      expect(document.body.textContent).toContain(
        'you may change only the name',
      );
      const name = document.querySelector<HTMLInputElement>('#webhook-name')!;
      name.value = 'Portal';
      name.dispatchEvent(new Event('input'));
      await settle();
      byText('Save changes')!.click();
      await settle();
      const patch = http.expectOne((r) => r.method === 'PATCH');
      // Only the name: nothing that would take it over or reshape it.
      expect(patch.request.body.data.attributes).toEqual({
        description: 'Portal',
      });
      patch.flush({
        data: webhook(HOOK, { owner: 'someone-else', description: 'Portal' }),
      });
      await settle();
      listRequest(http).flush(
        list(webhook(HOOK, { owner: 'someone-else', description: 'Portal' })),
      );
      await settle();
    });

    it('says a new URL takes someone else’s subscriber over, and then offers a new secret', async () => {
      const { http, settle, el, byText } = await render('/webhooks', [
        'webhook.manage',
        'content.read',
      ]);
      // Jane's role restricts nothing: she covers any owner's.
      TestBed.inject(MeService).set({
        ...TestBed.inject(MeService).me(),
        unrestricted: new Set(['webhook.manage', 'content.read']),
      });
      listRequest(http).flush(list(webhook(HOOK, { owner: 'someone-else' })));
      await settle();
      logRequest(http).flush({ data: [], meta: { page: page(0) }, links });
      await settle();
      (
        el().querySelector(
          'button[aria-label="Actions for Portal build"]',
        ) as HTMLElement
      ).click();
      await settle();
      byText('Edit')!.click();
      await settle();
      expect(
        document.querySelector('[data-slot="webhook-takeover"]'),
      ).toBeNull();
      const url = document.querySelector<HTMLInputElement>('#webhook-url')!;
      url.value = 'https://mine.example/hook';
      url.dispatchEvent(new Event('input'));
      await settle();
      expect(
        document.querySelector('[data-slot="webhook-takeover"]')?.textContent,
      ).toContain('makes you its owner');
      // No event: not sent.
      for (const box of document.querySelectorAll<HTMLInputElement>(
        'z-checkbox[data-event] input',
      )) {
        if (box.checked) box.click();
      }
      await settle();
      byText('Save changes')!.click();
      await settle();
      expect(document.body.textContent).toContain('Choose at least one event.');
      http.expectNone((r) => r.method === 'PATCH');
      document
        .querySelector<HTMLInputElement>(
          'z-checkbox[data-event="module.released"] input',
        )!
        .click();
      await settle();
      byText('Save changes')!.click();
      await settle();
      const patch = http.expectOne((r) => r.method === 'PATCH');
      expect(patch.request.body.data.attributes).toEqual({
        url: 'https://mine.example/hook',
        events: ['module.released'],
      });
      patch.flush({
        data: webhook(HOOK, { url: 'https://mine.example/hook' }),
      });
      await settle();
      // Now Jane's, with the earlier owner's secret: offered a new one.
      expect(document.body.textContent).toContain('Portal build is yours now');
      listRequest(http).flush(
        list(webhook(HOOK, { url: 'https://mine.example/hook' })),
      );
      await settle();
    });
    it('edits custom headers: a stored secret shows only "Set", Replace asks for a new value, a new URL asks for it again, unchanged ones are not sent (#457)', async () => {
      const { http, settle, el, byText } = await render();
      const stored = [
        { name: 'Authorization', secret: true, value: null },
        { name: 'X-Api-Version', secret: false, value: '2' },
      ];
      listRequest(http).flush(list(webhook(HOOK, { headers: stored })));
      await settle();
      logRequest(http).flush({ data: [], meta: { page: page(0) }, links });
      await settle();
      const openForm = async () => {
        (
          el().querySelector(
            'button[aria-label="Actions for Portal build"]',
          ) as HTMLElement
        ).click();
        await settle();
        byText('Edit')!.click();
        await settle();
      };
      await openForm();
      const rows = () => [
        ...document.querySelectorAll<HTMLElement>('[data-header="row"]'),
      ];
      expect(rows()).toHaveLength(2);
      // The secret one: never a value, only "Set".
      expect(
        rows()[0]!.querySelector('[data-header="set"]')?.textContent,
      ).toContain('Set');
      expect(rows()[0]!.querySelector('[data-header="value"]')).toBeNull();
      expect(
        rows()[1]!.querySelector<HTMLInputElement>('[data-header="value"]')!
          .value,
      ).toBe('2');

      // Only the name changed: the headers are not sent.
      const name = document.querySelector<HTMLInputElement>('#webhook-name')!;
      name.value = 'Portal';
      name.dispatchEvent(new Event('input'));
      await settle();
      byText('Save changes')!.click();
      await settle();
      const first = http.expectOne((r) => r.method === 'PATCH');
      expect(first.request.body.data.attributes).toEqual({
        description: 'Portal',
      });
      first.flush({ data: webhook(HOOK, { headers: stored }) });
      await settle();
      listRequest(http).flush(list(webhook(HOOK, { headers: stored })));
      await settle();

      // A new URL: the stored secret needs its value again.
      await openForm();
      const url = document.querySelector<HTMLInputElement>('#webhook-url')!;
      url.value = 'https://elsewhere.example/hook';
      url.dispatchEvent(new Event('input'));
      await settle();
      expect(rows()[0]!.textContent).toContain('enter the secret value again');
      byText('Save changes')!.click();
      await settle();
      http.expectNone((r) => r.method === 'PATCH');

      // Replace: a password field for the new value.
      (
        rows()[0]!.querySelector('[data-header="replace"]') as HTMLElement
      ).click();
      await settle();
      const value = rows()[0]!.querySelector<HTMLInputElement>(
        '[data-header="value"]',
      )!;
      expect(value.type).toBe('password');
      expect(value.value).toBe('');
      value.value = 'Bearer new-token';
      value.dispatchEvent(new Event('input'));
      // Remove the plain one, add another.
      (
        rows()[1]!.querySelector('[data-header="remove"]') as HTMLElement
      ).click();
      await settle();
      byText('Add header')!.click();
      await settle();
      const added = rows()[1]!;
      const addedName = added.querySelector<HTMLInputElement>(
        '[data-header="name"]',
      )!;
      addedName.value = 'Host';
      addedName.dispatchEvent(new Event('input'));
      await settle();
      expect(added.textContent).toContain('The server sets this header');
      addedName.value = 'X-Tenant';
      addedName.dispatchEvent(new Event('input'));
      const addedValue = added.querySelector<HTMLInputElement>(
        '[data-header="value"]',
      )!;
      addedValue.value = 'north';
      addedValue.dispatchEvent(new Event('input'));
      await settle();
      byText('Save changes')!.click();
      await settle();
      const patch = http.expectOne((r) => r.method === 'PATCH');
      expect(patch.request.body.data.attributes).toEqual({
        url: 'https://elsewhere.example/hook',
        headers: [
          { name: 'Authorization', value: 'Bearer new-token', secret: true },
          { name: 'X-Tenant', value: 'north', secret: false },
        ],
      });
      patch.flush({
        data: webhook(HOOK, {
          url: 'https://elsewhere.example/hook',
          headers: [
            { name: 'Authorization', secret: true, value: null },
            { name: 'X-Tenant', secret: false, value: 'north' },
          ],
        }),
      });
      await settle();
      listRequest(http).flush(list(webhook(HOOK)));
      await settle();
    });

    // #560: Keep after a rename went back to the stored value under the new name, which the API
    // refuses (`header-value-required`): Keep goes back to the stored header, its name included.
    it('Replace, a rename, then Keep goes back to the stored header, its name included', async () => {
      const { http, settle, el, byText } = await render();
      const stored = [{ name: 'Authorization', secret: true, value: null }];
      listRequest(http).flush(list(webhook(HOOK, { headers: stored })));
      await settle();
      logRequest(http).flush({ data: [], meta: { page: page(0) }, links });
      await settle();
      (
        el().querySelector(
          'button[aria-label="Actions for Portal build"]',
        ) as HTMLElement
      ).click();
      await settle();
      byText('Edit')!.click();
      await settle();
      const row = () =>
        document.querySelector<HTMLElement>('[data-header="row"]')!;
      (row().querySelector('[data-header="replace"]') as HTMLElement).click();
      await settle();
      const name = row().querySelector<HTMLInputElement>(
        '[data-header="name"]',
      )!;
      expect(name.readOnly).toBe(false);
      name.value = 'X-Api-Key';
      name.dispatchEvent(new Event('input'));
      await settle();
      (row().querySelector('[data-header="keep"]') as HTMLElement).click();
      await settle();
      expect(
        row().querySelector<HTMLInputElement>('[data-header="name"]')!.value,
      ).toBe('Authorization');
      expect(row().querySelector('[data-header="set"]')).not.toBeNull();
      // Something else changes, so the headers are sent: the stored one, as it was.
      byText('Add header')!.click();
      await settle();
      const added = document.querySelectorAll<HTMLElement>(
        '[data-header="row"]',
      )[1]!;
      const addedName = added.querySelector<HTMLInputElement>(
        '[data-header="name"]',
      )!;
      addedName.value = 'X-Tenant';
      addedName.dispatchEvent(new Event('input'));
      const addedValue = added.querySelector<HTMLInputElement>(
        '[data-header="value"]',
      )!;
      addedValue.value = 'north';
      addedValue.dispatchEvent(new Event('input'));
      await settle();
      byText('Save changes')!.click();
      await settle();
      const patch = http.expectOne((r) => r.method === 'PATCH');
      expect(patch.request.body.data.attributes).toEqual({
        headers: [
          { name: 'Authorization', secret: true },
          { name: 'X-Tenant', value: 'north', secret: false },
        ],
      });
      patch.flush({ data: webhook(HOOK, { headers: stored }) });
      await settle();
      listRequest(http).flush(list(webhook(HOOK, { headers: stored })));
      await settle();
    });

    it('turns Secret on for a credential’s name, and shows the API’s refusals on their rows (#560)', async () => {
      const { http, settle, byText } = await render();
      listRequest(http).flush(list());
      await settle();
      TestBed.inject(AdminActions).request('webhooks');
      await settle();
      const url = document.querySelector<HTMLInputElement>('#webhook-url')!;
      url.value = 'https://receiver.example/hook';
      url.dispatchEvent(new Event('input'));
      const rows = () => [
        ...document.querySelectorAll<HTMLElement>('[data-header="row"]'),
      ];
      const fill = async (row: HTMLElement, name: string, value: string) => {
        const n = row.querySelector<HTMLInputElement>('[data-header="name"]')!;
        n.value = name;
        n.dispatchEvent(new Event('input'));
        await settle();
        const v = row.querySelector<HTMLInputElement>('[data-header="value"]')!;
        v.value = value;
        v.dispatchEvent(new Event('input'));
        await settle();
      };
      const secretOn = (row: HTMLElement) =>
        row
          .querySelector('[data-header="secret"] button')!
          .getAttribute('aria-checked') === 'true';

      // A credential's name turns "Secret" on, in any case: its value is typed out of sight.
      byText('Add header')!.click();
      await settle();
      await fill(rows()[0]!, 'authorization', 'Bearer t');
      expect(secretOn(rows()[0]!)).toBe(true);
      expect(
        rows()[0]!.querySelector<HTMLInputElement>('[data-header="value"]')!
          .type,
      ).toBe('password');
      // It can still be turned off, and a rename then leaves it so.
      (
        rows()[0]!.querySelector('[data-header="secret"] button') as HTMLElement
      ).click();
      await settle();
      expect(secretOn(rows()[0]!)).toBe(false);
      await fill(rows()[0]!, 'X-Api-Key', 'k');
      expect(secretOn(rows()[0]!)).toBe(false);
      // Another name leaves it off.
      byText('Add header')!.click();
      await settle();
      await fill(rows()[1]!, 'X-Tenant', 'north');
      expect(secretOn(rows()[1]!)).toBe(false);

      byText(
        'Add subscriber',
        document.querySelector('z-dialog-footer') ?? document,
      )!.click();
      await settle();
      const post = http.expectOne((r) => r.method === 'POST');
      expect(post.request.body.data.attributes.headers).toEqual([
        { name: 'X-Api-Key', value: 'k', secret: false },
        { name: 'X-Tenant', value: 'north', secret: false },
      ]);
      post.flush(
        {
          errors: [
            {
              status: '422',
              title: 'Unprocessable Content',
              code: 'header-value-invalid',
              detail: 'Invalid.',
              source: { pointer: '/data/attributes/headers/1/value' },
            },
            {
              status: '422',
              title: 'Unprocessable Content',
              code: 'headers-too-large',
              detail: 'Too large.',
              source: { pointer: '/data/attributes/headers' },
              meta: { max: 8192 },
            },
          ],
        },
        { status: 422, statusText: 'Unprocessable Content' },
      );
      await settle();
      // On its row, never at the top of the form; the rows together below them.
      const problem = (row: HTMLElement) =>
        row.querySelector('[data-header="problem"]')?.textContent ?? '';
      expect(problem(rows()[0]!)).toBe('');
      expect(problem(rows()[1]!)).toContain('visible ASCII characters only');
      expect(
        rows()[1]!
          .querySelector('[data-header="value"]')!
          .getAttribute('aria-invalid'),
      ).toBe('true');
      expect(
        document.querySelector('[data-header="list-problem"]')?.textContent,
      ).toContain('may add up to at most 8,192 characters');
      expect(
        document.querySelector('#webhook-form > p[role="alert"]'),
      ).toBeNull();
      // Editing the row takes its problem away.
      await fill(rows()[1]!, 'X-Tenant', 'south');
      expect(problem(rows()[1]!)).toBe('');
      expect(document.querySelector('[data-header="list-problem"]')).toBeNull();
    });

    it('marks the row the API named as it was sent, though rows changed while it answered (#560)', async () => {
      const { http, settle, byText } = await render();
      listRequest(http).flush(list());
      await settle();
      TestBed.inject(AdminActions).request('webhooks');
      await settle();
      const url = document.querySelector<HTMLInputElement>('#webhook-url')!;
      url.value = 'https://receiver.example/hook';
      url.dispatchEvent(new Event('input'));
      const rows = () => [
        ...document.querySelectorAll<HTMLElement>('[data-header="row"]'),
      ];
      for (const [name, value] of [
        ['X-First', 'a'],
        ['X-Tenant', 'north'],
      ] as const) {
        byText('Add header')!.click();
        await settle();
        const row = rows().at(-1)!;
        const n = row.querySelector<HTMLInputElement>('[data-header="name"]')!;
        n.value = name;
        n.dispatchEvent(new Event('input'));
        const v = row.querySelector<HTMLInputElement>('[data-header="value"]')!;
        v.value = value;
        v.dispatchEvent(new Event('input'));
        await settle();
      }
      byText(
        'Add subscriber',
        document.querySelector('z-dialog-footer') ?? document,
      )!.click();
      await settle();
      const post = http.expectOne((r) => r.method === 'POST');
      // The first row is removed while the answer is on its way.
      (
        rows()[0]!.querySelector('[data-header="remove"]') as HTMLElement
      ).click();
      await settle();
      post.flush(
        {
          errors: [
            {
              status: '422',
              title: 'Unprocessable Content',
              code: 'header-value-invalid',
              detail: 'Invalid.',
              source: { pointer: '/data/attributes/headers/1/value' },
            },
          ],
        },
        { status: 422, statusText: 'Unprocessable Content' },
      );
      await settle();
      // Index 1 as sent is X-Tenant, now the only row.
      expect(rows()).toHaveLength(1);
      expect(
        rows()[0]!.querySelector('[data-header="problem"]')?.textContent,
      ).toContain('visible ASCII characters only');
      expect(document.querySelector('[data-header="list-problem"]')).toBeNull();
    });

    it('checks the headers’ size before sending (#560)', async () => {
      const { http, settle, byText } = await render();
      listRequest(http).flush(list());
      await settle();
      TestBed.inject(AdminActions).request('webhooks');
      await settle();
      const url = document.querySelector<HTMLInputElement>('#webhook-url')!;
      url.value = 'https://receiver.example/hook';
      url.dispatchEvent(new Event('input'));
      byText('Add header')!.click();
      await settle();
      const row = document.querySelector<HTMLElement>('[data-header="row"]')!;
      const name = row.querySelector<HTMLInputElement>('[data-header="name"]')!;
      name.value = 'X-Big';
      name.dispatchEvent(new Event('input'));
      const value = row.querySelector<HTMLInputElement>(
        '[data-header="value"]',
      )!;
      value.value = 'v'.repeat(8192);
      value.dispatchEvent(new Event('input'));
      await settle();
      expect(
        document.querySelector('[data-header="list-problem"]')?.textContent,
      ).toContain('may add up to at most 8,192 characters');
      byText(
        'Add subscriber',
        document.querySelector('z-dialog-footer') ?? document,
      )!.click();
      await settle();
      http.expectNone((r) => r.method === 'POST');
    });
  });

  describe('the delivery log', () => {
    it('sends a test event and shows its 200 inline, then the ping in the log', async () => {
      const { http, settle, el } = await render();
      listRequest(http).flush(list(webhook(HOOK)));
      await settle();
      logRequest(http).flush({ data: [], meta: { page: page(0) }, links });
      await settle();

      (el().querySelector('[data-slot="webhook-test"]') as HTMLElement).click();
      await settle();
      http
        .expectOne(
          (r) => r.url === `/api/webhooks/${HOOK}/test` && r.method === 'POST',
        )
        .flush({
          data: delivery(PING_ID, { event: 'ping', payload: { type: 'ping' } }),
        });
      await settle();
      expect(
        el().querySelector('[data-slot="webhook-test-result"]')?.textContent,
      ).toContain('Test event delivered: 200.');
      // The log and the list read again.
      logRequest(http).flush({
        data: [delivery(PING_ID, { event: 'ping', payload: { type: 'ping' } })],
        meta: { page: page(1) },
        links,
      });
      listRequest(http).flush(list(webhook(HOOK)));
      await settle();
      const row = el().querySelector('[data-slot="webhook-delivery"]')!;
      expect(row.textContent).toContain('ping');
      expect(row.textContent).toContain('Delivered');
      expect(row.textContent).toContain('200');
    });

    it('says when the receiver is busy, with the wait', async () => {
      const { http, settle, el } = await render();
      listRequest(http).flush(list(webhook(HOOK)));
      await settle();
      logRequest(http).flush({ data: [], meta: { page: page(0) }, links });
      await settle();
      (el().querySelector('[data-slot="webhook-test"]') as HTMLElement).click();
      await settle();
      http
        .expectOne((r) => r.url === `/api/webhooks/${HOOK}/test`)
        .flush(
          {
            errors: [
              {
                status: '429',
                title: 'Too many requests',
                detail: '',
                code: 'rate-limited',
              },
            ],
          },
          {
            status: 429,
            statusText: 'Too Many Requests',
            headers: { 'Retry-After': '12' },
          },
        );
      await settle();
      expect(
        el().querySelector('[data-slot="webhook-test-result"]')?.textContent,
      ).toContain('Try again in 12 s.');
    });

    it('opens a failed delivery to its attempts, headers and payload, and retries it', async () => {
      const { http, settle, el } = await render();
      listRequest(http).flush(list(webhook(HOOK)));
      await settle();
      logRequest(http).flush({
        data: [
          delivery(DELIVERY, {
            status: 'failed',
            attempts: 9,
            code: 503,
            error: 'http-status',
          }),
        ],
        meta: { page: page(1) },
        links,
      });
      await settle();
      const row = el().querySelector('[data-slot="webhook-delivery"]')!;
      (row.querySelector('button[aria-expanded]') as HTMLElement).click();
      await settle();
      expect(row.textContent).toContain('Failed');
      expect(row.textContent).toContain('503');
      expect(row.textContent).toContain('9');
      expect(row.textContent).toContain('X-Ccms-Signature: t=…,v1=…');
      expect(row.textContent).toContain(`Idempotency-Key: key-${DELIVERY}`);
      expect(
        row.querySelector('[data-slot="webhook-payload"]')?.textContent,
      ).toContain('"type": "module.released"');

      (row.querySelector('[data-slot="webhook-retry"]') as HTMLElement).click();
      await settle();
      http
        .expectOne(
          (r) =>
            r.url === `/api/webhooks/${HOOK}/deliveries/${DELIVERY}/retry` &&
            r.method === 'POST',
        )
        .flush({
          data: delivery(DELIVERY, {
            status: 'pending',
            attempts: 9,
            code: 503,
          }),
        });
      await settle();
      expect(row.textContent).toContain('Pending');
      logRequest(http).flush({
        data: [
          delivery(DELIVERY, { status: 'pending', attempts: 9, code: 503 }),
        ],
        meta: { page: page(1) },
        links,
      });
      listRequest(http).flush(list(webhook(HOOK)));
      await settle();
    });

    it('says a payload made for another owner is not shown, and filters by result in the address', async () => {
      const { http, settle, el } = await render();
      listRequest(http).flush(list(webhook(HOOK)));
      await settle();
      logRequest(http).flush({
        data: [delivery(DELIVERY, { payload: null })],
        meta: { page: page(1) },
        links,
      });
      await settle();
      const row = el().querySelector('[data-slot="webhook-delivery"]')!;
      (row.querySelector('button[aria-expanded]') as HTMLElement).click();
      await settle();
      expect(
        row.querySelector('[data-slot="webhook-payload-hidden"]')?.textContent,
      ).toContain('Not shown to you');
      expect(row.querySelector('[data-slot="webhook-retry"]')).toBeNull();

      const failed = [
        ...el().querySelectorAll<HTMLLabelElement>('of-segmented label'),
      ]
        .find((l) => l.textContent?.trim() === 'Failed')!
        .querySelector('input')!;
      failed.click();
      await settle();
      expect(TestBed.inject(Router).url).toContain('status=failed');
      const req = logRequest(http);
      expect(req.request.params.get('filter[status]')).toBe('failed');
      req.flush({ data: [], meta: { page: page(0) }, links });
      await settle();
      expect(el().textContent).toContain('No deliveries match');
    });
  });
});
