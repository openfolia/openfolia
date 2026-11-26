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
import { UsersPage } from './users.page';

const links = { self: '', first: '', last: '', prev: null, next: null };
const page = (total: number) => ({
  currentPage: 1,
  lastPage: 1,
  perPage: 25,
  total,
});

const user = (
  id: string,
  name: string,
  email: string | null,
  roles: string[],
  deactivatedAt: string | null = null,
) => ({
  type: 'User',
  id,
  attributes: { name, email, deactivatedAt },
  relationships: {
    roles: { data: roles.map((r) => ({ type: 'Role', id: r })) },
  },
});

const users = {
  data: [
    user('jane', 'Jane Doe', 'jane.doe.with.a.long.address@example.org', [
      'admin',
    ]),
    user('max', 'Max Muster', null, [], '2026-11-01T10:00:00.000Z'),
  ],
  meta: { page: page(2) },
  links,
};

const roles = {
  data: [
    {
      type: 'Role',
      id: 'admin',
      attributes: {
        name: 'Administrator',
        description: null,
        permissions: ['admin.roles'],
        scope: {},
      },
      meta: { holders: 1 },
    },
  ],
  meta: { page: { ...page(1), perPage: 200 } },
  links,
};

/** `GET /auth/options` (#610): password sign-in off unless a test turns it on. */
async function render(url = '/users', password = false) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'users', component: UsersPage }]),
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
  for (const req of http.match((r) => r.url === '/api/auth/options')) {
    req.flush({
      data: {
        type: 'SignInOptions',
        id: 'sign-in',
        attributes: { password, passwordReset: false, providers: 0 },
      },
    });
  }
  await settle();
  return {
    http,
    settle,
    el: () => harness.routeNativeElement as HTMLElement,
  };
}

const usersRequest = (http: HttpTestingController) =>
  http.expectOne((r) => r.url === '/api/users');
const rolesRequest = (http: HttpTestingController) =>
  http.expectOne((r) => r.url === '/api/roles');

const menuItems = () => [
  ...document.querySelectorAll<HTMLElement>(
    '.cdk-overlay-container [data-action]',
  ),
];

/** Opens the menu of a person's row; its actions. */
async function menuOf(
  el: HTMLElement,
  name: string,
  settle: () => Promise<void>,
) {
  el.querySelector<HTMLButtonElement>(
    `button[aria-label="More actions for ${name}"]`,
  )!.click();
  await settle();
  return menuItems().map((item) => item.dataset['action']);
}

async function choose(
  el: HTMLElement,
  name: string,
  action: string,
  settle: () => Promise<void>,
) {
  await menuOf(el, name, settle);
  menuItems()
    .find((item) => item.dataset['action'] === action)!
    .click();
  // The menu closes first (`afterMenu`).
  await new Promise((r) => setTimeout(r, 50));
  await settle();
}

describe('UsersPage', () => {
  it('marks a role held through a sign-in group apart from one given directly (#592)', async () => {
    const { http, settle, el } = await render();
    rolesRequest(http).flush({
      ...roles,
      data: [
        ...roles.data,
        {
          type: 'Role',
          id: 'author',
          attributes: {
            name: 'Author',
            description: null,
            permissions: ['content.edit'],
            scope: {},
          },
          meta: { holders: 1 },
        },
      ],
    });
    usersRequest(http).flush({
      ...users,
      data: [
        {
          ...user('lee', 'Lee Group', null, ['admin', 'author']),
          meta: { permissions: [], groupRoleIds: ['author'] },
        },
      ],
    });
    await settle();

    const badges = [...el().querySelectorAll('tbody z-badge')].map((b) => ({
      text: b.textContent?.replace(/\s+/g, ' ').trim(),
      via: b.getAttribute('data-via'),
    }));
    expect(badges).toEqual([
      { text: 'Administrator', via: null },
      { text: 'AuthorAuthor, through a sign-in group', via: 'group' },
      { text: 'Active', via: null },
    ]);
    expect(
      el().querySelector('[data-testid="group-legend"]')?.textContent,
    ).toContain('held through sign-in groups');
    http.verify();
  });

  it('explains no group mark when nobody listed holds a role through a group', async () => {
    const { http, settle, el } = await render();
    rolesRequest(http).flush(roles);
    usersRequest(http).flush(users);
    await settle();
    expect(el().querySelector('[data-via="group"]')).toBeNull();
    expect(el().querySelector('[data-testid="group-legend"]')).toBeNull();
    http.verify();
  });

  it('lists people with their email, roles by name and status', async () => {
    const { http, settle, el } = await render();
    rolesRequest(http).flush(roles);
    const req = usersRequest(http);
    expect(req.request.params.get('page[size]')).toBe('25');
    expect(req.request.params.has('filter[status]')).toBe(false);
    req.flush(users);
    await settle();

    const rows = [...el().querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) =>
        td.textContent?.replace(/\s+/g, ' ').trim(),
      ),
    );
    expect(rows).toEqual([
      [
        'Jane Doejane.doe.with.a.long.address@example.orgjane',
        'Administrator',
        'Active',
        'Edit',
      ],
      ['Max MusterNo email addressmax', 'No roles', 'Deactivated', 'Edit'],
    ]);
    http.verify();
  });

  it('keeps the search and status in the address and sends them as filters', async () => {
    const { http, settle } = await render('/users?q=jane&status=deactivated');
    rolesRequest(http).flush(roles);
    const req = usersRequest(http);
    expect(req.request.params.get('filter[q]')).toBe('jane');
    expect(req.request.params.get('filter[status]')).toBe('deactivated');
    req.flush(users);
    await settle();
    expect(TestBed.inject(Router).url).toBe('/users?q=jane&status=deactivated');
  });

  it('says how each person signs in and makes a reset link shown once (#610)', async () => {
    const { http, settle, el } = await render('/users', true);
    rolesRequest(http).flush(roles);
    const signIn = (
      password: boolean,
      provider: boolean,
      inviteExpiresAt: string | null = null,
    ) => ({ meta: { signIn: { password, provider, inviteExpiresAt } } });
    usersRequest(http).flush({
      data: [
        {
          ...user('jane', 'Jane Doe', 'jane@example.org', []),
          ...signIn(true, false),
        },
        {
          ...user('lee', 'Lee Invited', 'lee@example.org', []),
          ...signIn(false, false, '2999-01-01T00:00:00.000Z'),
        },
        { ...user('sam', 'Sam Provider', null, []), ...signIn(false, true) },
      ],
      meta: { page: page(3) },
      links,
    });
    await settle();
    const cells = [...el().querySelectorAll('td[data-sign-in]')].map((td) =>
      td.textContent?.trim(),
    );
    expect(cells).toEqual([
      'Password',
      'Invited, not yet signed in',
      'Provider',
    ]);
    expect(await menuOf(el(), 'Lee Invited', settle)).toEqual([
      'invite',
      'withdraw',
      'deactivate',
    ]);
    // Somebody without an address gets no link.
    expect(await menuOf(el(), 'Sam Provider', settle)).toEqual(['deactivate']);
    await choose(el(), 'Jane Doe', 'reset-link', settle);
    const req = http.expectOne('/api/users/jane/password-reset');
    expect(req.request.method).toBe('POST');
    req.flush({
      meta: {
        token: `ccms_pwl_${'a'.repeat(64)}`,
        url: `https://docs.example.com/set-password#ccms_pwl_${'a'.repeat(64)}`,
        expiresAt: '2026-11-21T11:00:00.000Z',
        emailed: false,
      },
    });
    await settle();
    expect(
      document.querySelector('[data-testid="sign-in-link"]')?.textContent,
    ).toContain('https://docs.example.com/set-password#ccms_pwl_');
    // The list is read again.
    usersRequest(http).flush(users);
  });

  it('resets another person’s second factor after asking, never one’s own (#611)', async () => {
    const { http, settle, el } = await render();
    rolesRequest(http).flush(roles);
    const withFactor = (id: string, name: string) => ({
      ...user(id, name, null, []),
      meta: {
        signIn: {
          password: true,
          provider: false,
          inviteExpiresAt: null,
          secondFactor: true,
        },
      },
    });
    usersRequest(http).flush({
      ...users,
      data: [withFactor('jane', 'Jane Doe'), withFactor('lee', 'Lee')],
    });
    await settle();
    expect(el().querySelectorAll('[data-slot="second-factor"]')).toHaveLength(
      2,
    );
    expect(await menuOf(el(), 'Jane Doe', settle)).not.toContain(
      'reset-second-factor',
    );
    vi.spyOn(
      TestBed.inject(ZardAlertDialogService),
      'confirm',
    ).mockImplementation((config) => {
      (config.zOnOk as () => void)();
      return undefined as never;
    });
    await choose(el(), 'Lee', 'reset-second-factor', settle);
    const req = http.expectOne('/api/users/lee/second-factor');
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
    await settle();
    expect(TestBed.inject(ToastService).toasts()[0]).toMatchObject({
      kind: 'success',
      message: { key: 'editor.admin.users.secondFactor.done' },
    });
    usersRequest(http).flush(users);
  });

  it('deactivates after asking, and says how many locks were released', async () => {
    const { http, settle, el } = await render();
    rolesRequest(http).flush(roles);
    usersRequest(http).flush(users);
    await settle();

    const dialogs = TestBed.inject(ZardAlertDialogService);
    const confirm = vi
      .spyOn(dialogs, 'confirm')
      .mockImplementation((config) => {
        (config.zOnOk as () => void)();
        return undefined as never;
      });
    await choose(el(), 'Jane Doe', 'deactivate', settle);
    expect(confirm).toHaveBeenCalledOnce();
    const req = http.expectOne('/api/users/jane/deactivate');
    expect(req.request.method).toBe('POST');
    req.flush({
      data: user('jane', 'Jane Doe', null, [], '2026-11-18T10:00:00.000Z'),
      meta: { locksReleased: 2 },
    });
    await settle();
    expect(TestBed.inject(ToastService).toasts()[0]).toMatchObject({
      kind: 'success',
      message: {
        key: 'editor.admin.users.deactivate.done',
        params: { name: 'Jane Doe', locks: 2 },
      },
    });
    // The list is read again.
    usersRequest(http).flush(users);
  });

  it('shows why the last admin cannot be deactivated', async () => {
    const { http, settle, el } = await render();
    rolesRequest(http).flush(roles);
    usersRequest(http).flush(users);
    await settle();
    vi.spyOn(
      TestBed.inject(ZardAlertDialogService),
      'confirm',
    ).mockImplementation((config) => {
      (config.zOnOk as () => void)();
      return undefined as never;
    });
    await choose(el(), 'Jane Doe', 'deactivate', settle);
    http.expectOne('/api/users/jane/deactivate').flush(
      {
        errors: [
          { status: '409', title: 'Conflict', detail: '', code: 'last-admin' },
        ],
      },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();
    expect(TestBed.inject(ToastService).toasts()[0]).toMatchObject({
      kind: 'error',
      message: { key: 'editor.apiErrors.codes.last-admin' },
    });
  });

  it('changes a person, keeping their ID', async () => {
    const { http, settle, el } = await render();
    rolesRequest(http).flush(roles);
    usersRequest(http).flush(users);
    await settle();

    const edit = el().querySelector<HTMLButtonElement>(
      'button[aria-label="Edit Max Muster"]',
    );
    edit?.click();
    await settle();
    const name = document.querySelector<HTMLInputElement>('#user-name');
    expect(name?.value).toBe('Max Muster');
    // An existing user's ID is not offered for change.
    expect(document.querySelector('#user-id')).toBeNull();
    const email = document.querySelector<HTMLInputElement>('#user-email');
    if (!email) throw new Error('no email field');
    email.value = 'max@example.org';
    email.dispatchEvent(new Event('input'));
    document
      .querySelector<HTMLFormElement>('#user-form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    const req = http.expectOne('/api/users/max');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({
      data: {
        type: 'User',
        id: 'max',
        // The roles were not changed: not sent.
        attributes: { name: 'Max Muster', email: 'max@example.org' },
      },
    });
    req.flush({ data: user('max', 'Max Muster', 'max@example.org', []) });
    await settle();
    usersRequest(http).flush(users);
  });
});
