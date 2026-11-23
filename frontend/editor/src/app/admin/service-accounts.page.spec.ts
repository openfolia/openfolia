import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { ZardAlertDialogService } from '@openfolia/ui/alert-dialog';
import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { AdminActions } from './admin-actions';
import { ServiceAccountsPage } from './service-accounts.page';
import { advance } from '../testing/fake-time';

const links = { self: '', first: '', last: '', prev: null, next: null };
const page = (total: number, perPage = 25) => ({
  currentPage: 1,
  lastPage: 1,
  perPage,
  total,
});

const account = (
  id: string,
  name: string,
  description: string | null,
  roles: string[],
  deactivatedAt: string | null = null,
) => ({
  type: 'ServiceAccount',
  id,
  attributes: {
    name,
    description,
    deactivatedAt,
    createdAt: '2026-11-01T10:00:00.000Z',
  },
  relationships: {
    roles: { data: roles.map((r) => ({ type: 'Role', id: r })) },
  },
});

const portal = account('portal-build', 'Portal build', 'Nightly portal build', [
  'reader',
]);
const old = account('old-ci', 'Old CI', null, [], '2026-11-02T10:00:00.000Z');
const accounts = { data: [portal, old], meta: { page: page(2) }, links };

const role = (id: string, name: string, permissions: string[]) => ({
  type: 'Role',
  id,
  attributes: { name, description: null, permissions, scope: {} },
  meta: { holders: 0 },
});
const roles = {
  data: [
    role('admin', 'Administrator', ['admin.roles']),
    role('reader', 'Reader', ['content.read']),
  ],
  meta: { page: page(2, 200) },
  links,
};

/** A token far in the future: "active" whatever day the test runs. */
const token = (id: string, name: string, revokedAt: string | null = null) => ({
  type: 'ServiceToken',
  id,
  attributes: {
    name,
    createdAt: '2026-11-01T10:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
    lastUsedAt: null,
    revokedAt,
  },
  relationships: {
    serviceAccount: { data: { type: 'ServiceAccount', id: 'portal-build' } },
  },
});
const SECRET = `ccms_sat_0123456789abcdef_${'a'.repeat(64)}`;

async function render(url = '/service-accounts') {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'service-accounts', component: ServiceAccountsPage },
      ]),
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
    permissions: new Set(['admin.roles']),
  });
  const { RouterTestingHarness } = await import('@angular/router/testing');
  const harness = await RouterTestingHarness.create();
  // Fake time from here: a closed sheet is waited out on the fake clock. The fake clock runs every
  // timer due in the step, in order, however slow the machine is (#562).
  vi.useFakeTimers();
  const http = TestBed.inject(HttpTestingController);
  void harness.navigateByUrl(url);
  const settle = async () => {
    for (let i = 0; i < 4; i++) await advance();
  };
  await settle();
  http.expectOne((r) => r.url === '/api/roles').flush(roles);
  return {
    http,
    settle,
    el: () => harness.routeNativeElement as HTMLElement,
  };
}

const accountsRequest = (http: HttpTestingController) =>
  http.expectOne((r) => r.url === '/api/service-accounts');
const tokensRequest = (http: HttpTestingController) =>
  http.expectOne((r) => r.url === '/api/service-accounts/portal-build/tokens');

const byLabel = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const byText = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  );
const type = (selector: string, value: string) => {
  const input = document.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`no ${selector}`);
  input.value = value;
  input.dispatchEvent(new Event('input'));
};

/** Opens the tokens of Portal build, with the tokens given. */
async function openTokens(
  http: HttpTestingController,
  settle: () => Promise<void>,
  tokens: unknown[] = [],
) {
  byLabel('Tokens of Portal build')?.click();
  await settle();
  tokensRequest(http).flush({
    data: tokens,
    meta: { page: page(tokens.length, 10) },
    links,
  });
  await settle();
}

/** Issues a token named "portal, production" and answers it with `SECRET`. */
async function issue(http: HttpTestingController, settle: () => Promise<void>) {
  byText('Issue token')?.click();
  await settle();
  type('#token-name', 'portal, production');
  document
    .querySelector<HTMLFormElement>('#token-form')
    ?.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  const req = http.expectOne('/api/service-accounts/portal-build/tokens');
  expect(req.request.method).toBe('POST');
  const issued = token('0123456789abcdef', 'portal, production');
  req.flush(
    { data: issued, meta: { token: SECRET } },
    { status: 201, statusText: 'Created' },
  );
  await settle();
  return { issued, body: req.request.body };
}

describe('ServiceAccountsPage', () => {
  it('lists service accounts with their description, roles by name and status', async () => {
    const { http, settle, el } = await render();
    const req = accountsRequest(http);
    expect(req.request.params.get('page[size]')).toBe('25');
    req.flush(accounts);
    await settle();

    const rows = [...el().querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) =>
        td.textContent?.replace(/\s+/g, ' ').trim(),
      ),
    );
    expect(rows).toEqual([
      [
        'Portal buildportal-build',
        'Nightly portal build',
        'Reader',
        'Active',
        'Tokens Edit Deactivate',
      ],
      [
        'Old CIold-ci',
        'No description',
        'No roles',
        'Deactivated',
        'Tokens Edit Reactivate',
      ],
    ]);
    http.verify();
  });

  it('keeps the search and status in the address and sends them as filters', async () => {
    const { http, settle } = await render(
      '/service-accounts?q=portal&status=active',
    );
    const req = accountsRequest(http);
    expect(req.request.params.get('filter[q]')).toBe('portal');
    expect(req.request.params.get('filter[status]')).toBe('active');
    req.flush(accounts);
    await settle();
  });

  it('adds a service account from the header and shows why a role was refused', async () => {
    const { http, settle } = await render();
    accountsRequest(http).flush(accounts);
    await settle();
    TestBed.inject(AdminActions).request('service-accounts');
    await settle();

    type('#service-account-name', 'Search index');
    await settle();
    expect(
      document.querySelector<HTMLInputElement>('#service-account-id')?.value,
    ).toBe('search-index');
    document
      .querySelector<HTMLFormElement>('#service-account-form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    const req = http.expectOne('/api/service-accounts');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      data: {
        type: 'ServiceAccount',
        id: 'search-index',
        attributes: { name: 'Search index', description: null },
        relationships: { roles: { data: [] } },
      },
    });
    req.flush(
      {
        errors: [
          {
            status: '422',
            title: 'Unprocessable',
            detail: '',
            code: 'admin-role-for-service-account',
            meta: { roles: ['admin'] },
          },
        ],
      },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    await settle();
    // The dialog stays open and says why, in words.
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'A role that manages access (admin.roles) cannot be given to a service account.',
    );
  });

  it('shows a new token once, copies it, and forgets it on Done', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const { http, settle } = await render();
    accountsRequest(http).flush(accounts);
    await settle();
    await openTokens(http, settle);

    const { issued, body } = await issue(http, settle);
    expect(body.data.attributes.name).toBe('portal, production');
    // 90 days by default, within the API's 366.
    const days =
      (new Date(body.data.attributes.expiresAt).getTime() - Date.now()) /
      86_400_000;
    expect(Math.round(days)).toBe(90);
    // The list is read again, holding the new token (never the token itself).
    tokensRequest(http).flush({
      data: [issued],
      meta: { page: page(1, 10) },
      links,
    });
    await settle();

    expect(document.querySelector('#issued-token')?.textContent).toBe(SECRET);
    expect(document.body.textContent).toContain(
      'is shown only this once and cannot be shown again',
    );
    // Never in the address or the browser's storage.
    expect(TestBed.inject(Router).url).not.toContain(SECRET);
    expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(SECRET);

    byText('Copy token')?.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith(SECRET);
    expect(byText('Copied')).toBeTruthy();

    byText('Done')?.click();
    await settle();
    expect(document.querySelector('#issued-token')).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET);
    http.verify();
  });

  it('forgets a new token when the sheet closes', async () => {
    const { http, settle } = await render();
    accountsRequest(http).flush(accounts);
    await settle();
    await openTokens(http, settle);
    const { issued } = await issue(http, settle);
    tokensRequest(http).flush({
      data: [issued],
      meta: { page: page(1, 10) },
      links,
    });
    await settle();
    expect(document.body.textContent).toContain(SECRET);

    document
      .querySelector<HTMLButtonElement>('[data-slot="sheet-close"]')
      ?.click();
    await settle();
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    // Opened again: the list, never the token.
    await openTokens(http, settle, [issued]);
    expect(document.querySelector('#issued-token')).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('revokes a token after a clear question, and says it is refused from now on', async () => {
    const { http, settle } = await render();
    accountsRequest(http).flush(accounts);
    await settle();
    const live = token('0123456789abcdef', 'portal, production');
    await openTokens(http, settle, [live]);

    const confirm = vi
      .spyOn(TestBed.inject(ZardAlertDialogService), 'confirm')
      .mockImplementation((config) => {
        (config.zOnOk as () => void)();
        return undefined as never;
      });
    byLabel('Revoke portal, production')?.click();
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0].zDescription).toContain(
      'A revoked token cannot be restored',
    );
    const req = http.expectOne(
      '/api/service-accounts/portal-build/tokens/0123456789abcdef/revoke',
    );
    expect(req.request.method).toBe('POST');
    const revoked = token(
      '0123456789abcdef',
      'portal, production',
      '2026-11-18T12:00:00.000Z',
    );
    req.flush({ data: revoked });
    await settle();
    expect(TestBed.inject(ToastService).toasts()[0]).toMatchObject({
      kind: 'success',
      message: {
        key: 'editor.admin.serviceAccounts.revoke.done',
        params: { name: 'portal, production' },
      },
    });
    // Shown revoked at once, before the list is read again.
    expect(document.body.textContent).toContain('Revoked');
    expect(byLabel('Revoke portal, production')).toBeNull();
    tokensRequest(http).flush({
      data: [revoked],
      meta: { page: page(1, 10) },
      links,
    });
  });

  it('issues no token to a deactivated service account', async () => {
    const { http, settle } = await render();
    accountsRequest(http).flush(accounts);
    await settle();
    byLabel('Tokens of Old CI')?.click();
    await settle();
    http
      .expectOne((r) => r.url === '/api/service-accounts/old-ci/tokens')
      .flush({ data: [], meta: { page: page(0, 10) }, links });
    await settle();
    expect(byText('Issue token')?.disabled).toBe(true);
    expect(document.body.textContent).toContain(
      'Deactivated: reactivate it to issue tokens.',
    );
  });
});
