import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../../api/api-interceptors';
import { MeService } from '../../permissions/me';
import { AuditLogPage } from './audit-log.page';

const links = { self: '', first: '', last: '', prev: null, next: null };
const page = (total: number, perPage = 25) => ({
  currentPage: 1,
  lastPage: 1,
  perPage,
  total,
});

const event = (
  id: string,
  action: string,
  subject: { type: string; id: string },
  actor: { kind: 'user' | 'service'; id: string },
  extra: { comment?: string | null; data?: Record<string, unknown> } = {},
) => ({
  type: 'AuditEvent',
  id,
  attributes: {
    at: '2026-11-18T09:30:00.000Z',
    actor,
    action,
    subject,
    comment: extra.comment ?? null,
    data: extra.data ?? {},
  },
});

const events = {
  data: [
    event(
      '3',
      'change-set.merge',
      { type: 'change-set', id: 'cs-1' },
      { kind: 'user', id: 'pat' },
      { data: { from: 'approved', to: 'merged', commit: 'abc123' } },
    ),
    event(
      '2',
      'change-set.approve',
      { type: 'change-set', id: 'cs-1' },
      { kind: 'user', id: 'rey' },
      { comment: 'Looks right.', data: { from: 'in-review', to: 'approved' } },
    ),
    event(
      '1',
      'thing.happened',
      { type: 'gadget', id: 'g-1' },
      { kind: 'service', id: 'portal-build' },
    ),
  ],
  meta: { page: page(3) },
  links,
};

const users = {
  data: [
    {
      type: 'User',
      id: 'pat',
      attributes: { name: 'Pat Publisher', email: null, deactivatedAt: null },
      relationships: { roles: { data: [] } },
    },
    {
      type: 'User',
      id: 'rey',
      attributes: { name: 'Rey Reviewer', email: null, deactivatedAt: null },
      relationships: { roles: { data: [] } },
    },
  ],
  meta: { page: page(2, 200) },
  links,
};

const services = {
  data: [
    {
      type: 'ServiceAccount',
      id: 'portal-build',
      attributes: {
        name: 'Portal build',
        description: null,
        createdAt: '2026-11-01T10:00:00.000Z',
        deactivatedAt: null,
      },
      relationships: { roles: { data: [] } },
      meta: { activeTokens: 0 },
    },
  ],
  meta: { page: page(1, 200) },
  links,
};

async function render(url = '/audit') {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'audit', component: AuditLogPage },
        { path: 'review', children: [] },
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
    permissions: new Set(['admin.roles']),
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
  http.expectOne((r) => r.url === '/api/users').flush(users);
  http.expectOne((r) => r.url === '/api/service-accounts').flush(services);
  return {
    http,
    settle,
    router: TestBed.inject(Router),
    el: () => harness.routeNativeElement as HTMLElement,
  };
}

const eventsRequest = (http: HttpTestingController) =>
  http.expectOne((r) => r.url === '/api/audit-events');

const text = (node: Element | null | undefined) =>
  node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
/** A cell's text, its parts (name, ID, badge) apart. */
const cellText = (td: Element | null | undefined): string =>
  td && td.children.length > 0
    ? [...td.children].map(text).filter(Boolean).join(' ')
    : text(td);

describe('AuditLogPage', () => {
  it('lists events newest first with who, what, the subject and the comment', async () => {
    const { http, settle, el } = await render();
    const req = eventsRequest(http);
    expect(req.request.params.get('page[size]')).toBe('25');
    expect(req.request.params.has('filter[subject]')).toBe(false);
    req.flush(events);
    await settle();

    const rows = [...el().querySelectorAll('[data-slot="audit-row"]')];
    expect(rows.map((r) => r.getAttribute('data-event'))).toEqual([
      '3',
      '2',
      '1',
    ]);
    const cells = (row: Element) =>
      [...row.querySelectorAll('td')].map((td) => cellText(td));
    const [, time, actor, action, subject, comment] = cells(rows[1]!);
    expect(time).toMatch(/2026/);
    expect(actor).toBe('Rey Reviewer rey');
    expect(action).toBe('Revision approved change-set.approve');
    expect(subject).toBe('Revision cs-1');
    expect(comment).toBe('Looks right.');

    // An unknown action and subject type are shown as their keys; a service is marked.
    const [, , actor1, action1, subject1, comment1] = cells(rows[2]!);
    expect(actor1).toBe('Portal build portal-build Service account');
    expect(action1).toBe('thing.happened');
    expect(subject1).toBe('gadget g-1');
    expect(comment1).toBe('No comment');

    const link = rows[1]!.querySelector('[data-slot="audit-subject-link"]');
    expect(link?.getAttribute('href')).toBe('/review?cs=cs-1');
    expect(rows[2]!.querySelector('[data-slot="audit-subject-link"]')).toBe(
      null,
    );
  });

  it('opens a row to show its details as a key-value list', async () => {
    const { http, settle, el } = await render();
    eventsRequest(http).flush(events);
    await settle();

    const toggle = el().querySelector<HTMLButtonElement>(
      '[data-event="3"] [data-slot="audit-toggle"]',
    )!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(el().querySelector('[data-slot="audit-details"]')).toBe(null);
    toggle.click();
    await settle();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const details = el().querySelector('[data-slot="audit-details"]')!;
    const terms = [...details.querySelectorAll('dt')].map(text);
    const values = [...details.querySelectorAll('dd')].map(text);
    expect(terms).toEqual(['from', 'to', 'commit']);
    expect(values).toEqual(['approved', 'merged', 'abc123']);

    toggle.click();
    await settle();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(
      el().querySelector('#audit-details-3')?.getAttribute('data-state'),
    ).toBe('closed');
  });

  it('reads the filters and the page from the address', async () => {
    const { http } = await render(
      '/audit?actor=user/rey&type=change-set&id=cs-1&action=change-set.approve&page=2&size=50',
    );
    const req = eventsRequest(http);
    expect(req.request.params.get('filter[actor]')).toBe('user/rey');
    expect(req.request.params.get('filter[subject]')).toBe('change-set/cs-1');
    expect(req.request.params.get('filter[action]')).toBe('change-set.approve');
    expect(req.request.params.get('page[number]')).toBe('2');
    expect(req.request.params.get('page[size]')).toBe('50');
    req.flush({ ...events, data: [] });
  });

  it('reads a range of days from the address, both days whole, in local time', async () => {
    const { http, settle, router } = await render(
      '/audit?from=2026-03-01&to=2026-03-31',
    );
    const req = eventsRequest(http);
    expect(req.request.params.get('filter[from]')).toBe(
      new Date(2026, 2, 1).toISOString(),
    );
    expect(req.request.params.get('filter[to]')).toBe(
      new Date(2026, 3, 1).toISOString(),
    );
    req.flush(events);
    await settle();
    expect(router.url).toBe('/audit?from=2026-03-01&to=2026-03-31');
  });

  it('drops a day that does not exist', async () => {
    const { http, settle, router } = await render(
      '/audit?from=2026-02-30&to=soon',
    );
    const req = eventsRequest(http);
    expect(req.request.params.has('filter[from]')).toBe(false);
    expect(req.request.params.has('filter[to]')).toBe(false);
    req.flush(events);
    await settle();
    expect(router.url).toBe('/audit');
  });

  it('puts a chosen day into the address', async () => {
    const { http, settle, router, el } = await render();
    eventsRequest(http).flush(events);
    await settle();
    const from = el().querySelector<HTMLInputElement>('[data-filter="from"]')!;
    from.value = '2026-01-15';
    from.dispatchEvent(new Event('change'));
    await settle();
    expect(router.url).toBe('/audit?from=2026-01-15');
    expect(eventsRequest(http).request.params.get('filter[from]')).toBe(
      new Date(2026, 0, 15).toISOString(),
    );
  });

  it('exports what the filters select, as the format chosen', async () => {
    const created = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:audit');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const { http, settle, el } = await render(
      '/audit?actor=user/rey&from=2026-03-01',
    );
    eventsRequest(http).flush(events);
    await settle();
    for (const format of ['csv', 'jsonl'] as const) {
      el().querySelector<HTMLElement>('[data-slot="audit-export"]')!.click();
      await settle();
      document
        .querySelector<HTMLElement>(`[data-action="export-${format}"]`)!
        .click();
      await settle();
      const req = http.expectOne((r) => r.url === '/api/audit-events/export');
      expect(req.request.params.get('format')).toBe(format);
      expect(req.request.params.get('filter[actor]')).toBe('user/rey');
      expect(req.request.params.get('filter[from]')).toBe(
        new Date(2026, 2, 1).toISOString(),
      );
      expect(req.request.params.has('page[number]')).toBe(false);
      req.flush(new Blob(['id\r\n']), {
        headers: {
          'Content-Disposition': `attachment; filename="audit-log.${format}"`,
        },
      });
      await settle();
    }
    expect(created).toHaveBeenCalledTimes(2);
  });

  it('says so when the export fails', async () => {
    const { http, settle, el } = await render();
    eventsRequest(http).flush(events);
    await settle();
    const toast = vi.spyOn(TestBed.inject(ToastService), 'error');
    el().querySelector<HTMLElement>('[data-slot="audit-export"]')!.click();
    await settle();
    document.querySelector<HTMLElement>('[data-action="export-csv"]')!.click();
    await settle();
    http
      .expectOne((r) => r.url === '/api/audit-events/export')
      .flush(new Blob(['{}']), { status: 500, statusText: 'Server Error' });
    await settle();
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('filters by a subject type alone, and drops an invalid filter', async () => {
    const { http, settle, router } = await render(
      '/audit?type=module&actor=robot',
    );
    const req = eventsRequest(http);
    expect(req.request.params.get('filter[subject]')).toBe('module');
    expect(req.request.params.has('filter[actor]')).toBe(false);
    req.flush({ ...events, data: [] });
    await settle();
    expect(router.url).toBe('/audit?type=module');
  });

  it('says so when nothing matches, and clears the filters', async () => {
    const { http, settle, el, router } = await render(
      '/audit?type=change-set&id=cs-9',
    );
    eventsRequest(http).flush({ ...events, data: [], meta: { page: page(0) } });
    await settle();
    expect(text(el())).toContain('No events match');

    el().querySelector<HTMLButtonElement>('[data-slot="audit-clear"]')!.click();
    await settle();
    expect(router.url).toBe('/audit');
    const req = eventsRequest(http);
    expect(req.request.params.has('filter[subject]')).toBe(false);
    req.flush(events);
    await settle();
    // Hidden, its place kept: the bar doesn't move (#385).
    const clear = el().querySelector('[data-slot="audit-clear"]');
    expect(clear?.hasAttribute('inert')).toBe(true);
    expect(clear?.classList).toContain('invisible');
  });

  it('types a subject ID into the address, within the chosen type', async () => {
    const { http, settle, router, el } = await render('/audit?type=module');
    eventsRequest(http).flush(events);
    await settle();
    const input = el().querySelector<HTMLInputElement>(
      '[data-filter="subject-id"]',
    )!;
    expect(input.disabled).toBe(false);
    input.value = 'en/intro';
    input.dispatchEvent(new Event('input'));
    await settle();
    expect(router.url).toBe('/audit?type=module&id=en%2Fintro');
    expect(eventsRequest(http).request.params.get('filter[subject]')).toBe(
      'module/en/intro',
    );
  });

  it('turns the subject ID off until a type is chosen', async () => {
    const { http, settle, el } = await render();
    eventsRequest(http).flush(events);
    await settle();
    expect(
      el().querySelector<HTMLInputElement>('[data-filter="subject-id"]')!
        .disabled,
    ).toBe(true);
  });

  it('shows the error with a retry', async () => {
    const { http, settle, el } = await render();
    eventsRequest(http).flush(
      {
        errors: [
          { status: '503', title: 'Unavailable', code: 'database-unavailable' },
        ],
      },
      { status: 503, statusText: 'Unavailable' },
    );
    await settle();
    const retry = [...el().querySelectorAll('button')].find(
      (b) => text(b) === 'Try again',
    );
    expect(retry).toBeDefined();
    retry!.click();
    await settle();
    eventsRequest(http).flush(events);
    await settle();
    expect(el().querySelectorAll('[data-slot="audit-row"]').length).toBe(3);
  });

  it('names actors by ID when people and service accounts cannot be read', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'audit', component: AuditLogPage }]),
        provideHttpClient(withInterceptors([apiErrorInterceptor])),
        provideHttpClientTesting(),
        provideZard(),
      ],
    });
    const { RouterTestingHarness } = await import('@angular/router/testing');
    const harness = await RouterTestingHarness.create();
    const http = TestBed.inject(HttpTestingController);
    void harness.navigateByUrl('/audit');
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 0));
        await harness.fixture.whenStable();
      }
    };
    await settle();
    http
      .expectOne((r) => r.url === '/api/users')
      .flush(null, { status: 500, statusText: 'Error' });
    http.expectOne((r) => r.url === '/api/service-accounts').flush(services);
    eventsRequest(http).flush(events);
    await settle();
    const el = harness.routeNativeElement as HTMLElement;
    const actor = el.querySelector('[data-event="2"] td:nth-child(3)');
    expect(cellText(actor)).toBe('rey');
    const service = el.querySelector('[data-event="1"] td:nth-child(3)');
    expect(cellText(service)).toBe('Portal build portal-build Service account');
  });
});
