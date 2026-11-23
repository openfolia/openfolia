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

import { apiErrorInterceptor } from '../../api/api-interceptors';
import { MeService } from '../../permissions/me';
import { AdminActions } from '../admin-actions';
import { GroupMappingsPage } from './group-mappings.page';

const links = { self: '', first: '', last: '', prev: null, next: null };
const page = (total: number, perPage = 25, currentPage = 1) => ({
  currentPage,
  lastPage: Math.max(1, Math.ceil(total / perPage)),
  perPage,
  total,
});

const role = (id: string, name: string) => ({
  type: 'Role',
  id,
  attributes: { name, description: null, permissions: [], scope: {} },
  meta: { holders: 0 },
});
const roles = {
  data: [role('admin', 'Administrator'), role('author', 'Author')],
  meta: { page: page(2, 200) },
  links,
};

const LONG_GROUP =
  'cn=technical-writing-department-europe,ou=groups,dc=example,dc=org';
const mapping = (id: string, group: string, roleId: string) => ({
  type: 'GroupMapping',
  id,
  attributes: { group, createdAt: '2026-11-20T09:30:00.000Z' },
  relationships: { role: { data: { type: 'Role', id: roleId } } },
});
const mappings = {
  data: [mapping('m1', LONG_GROUP, 'author'), mapping('m2', 'leads', 'admin')],
  meta: { page: page(2) },
  links,
};

async function render(url = '/group-mappings', providers = 1) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'group-mappings', component: GroupMappingsPage }]),
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
        attributes: { password: false, passwordReset: false, providers },
      },
    });
  }
  http.expectOne((r) => r.url === '/api/roles').flush(roles);
  await settle();
  // A refresh of one's own permissions after a change: answered, and not checked here.
  const answerMe = () => {
    for (const req of http.match((r) => r.url === '/api/me')) {
      req.flush({}, { status: 500, statusText: 'Server Error' });
    }
  };
  return {
    http,
    settle,
    answerMe,
    el: () => harness.routeNativeElement as HTMLElement,
  };
}

const mappingsRequest = (http: HttpTestingController) =>
  http.expectOne((r) => r.url === '/api/group-mappings');

const conflict = (code: string) => ({
  errors: [{ status: '409', title: 'Conflict', detail: '', code }],
});

describe('GroupMappingsPage (#592)', () => {
  it('lists the mappings with the role by name; a long group name wraps', async () => {
    const { http, settle, el } = await render();
    const req = mappingsRequest(http);
    expect(req.request.params.get('page[size]')).toBe('25');
    expect(req.request.params.has('filter[role]')).toBe(false);
    req.flush(mappings);
    await settle();

    const rows = [...el().querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')]
        .slice(0, 2)
        .map((td) => td.textContent?.replace(/\s+/g, ' ').trim()),
    );
    expect(rows).toEqual([
      [LONG_GROUP, 'Author'],
      ['leads', 'Administrator'],
    ]);
    const group = el().querySelector('tbody td');
    expect(group?.className).toContain('[overflow-wrap:anywhere]');
    expect(group?.className).toContain('whitespace-normal');
    // An identity provider is set up: no note that the mappings wait for one.
    expect(el().querySelector('[data-testid="no-provider"]')).toBeNull();
    http.verify();
  });

  it('filters by the role in the address, and says when no group gives it', async () => {
    const { http, settle, el } = await render('/group-mappings?role=author');
    const req = mappingsRequest(http);
    expect(req.request.params.get('filter[role]')).toBe('author');
    req.flush({ data: [], meta: { page: page(0) }, links });
    await settle();
    expect(el().textContent).toContain('No group gives this role');
    expect(TestBed.inject(Router).url).toBe('/group-mappings?role=author');
  });

  it('ignores a role filter that is no role ID', async () => {
    const { http } = await render('/group-mappings?role=Not%20a%20role');
    const req = mappingsRequest(http);
    expect(req.request.params.has('filter[role]')).toBe(false);
    req.flush(mappings);
  });

  it('says the mappings wait for an identity provider when none is set up', async () => {
    const { http, settle, el } = await render('/group-mappings', 0);
    mappingsRequest(http).flush(mappings);
    await settle();
    expect(
      el().querySelector('[data-testid="no-provider"]')?.textContent,
    ).toContain('No identity provider is set up');
  });

  it('adds a mapping from the header’s action, with the filtered role chosen', async () => {
    const { http, settle, answerMe } = await render(
      '/group-mappings?role=author',
    );
    mappingsRequest(http).flush({ data: [], meta: { page: page(0) }, links });
    await settle();

    TestBed.inject(AdminActions).request('group-mappings');
    await settle();
    const group = document.querySelector<HTMLInputElement>(
      '#group-mapping-group',
    );
    if (!group) throw new Error('no group field');
    // Nothing typed: the dialog says what is missing and sends nothing.
    const form = () =>
      document.querySelector<HTMLFormElement>('#group-mapping-form');
    form()?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(document.body.textContent).toContain('Enter the group’s name.');

    group.value = '  Writers ';
    group.dispatchEvent(new Event('input'));
    form()?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    const req = http.expectOne('/api/group-mappings');
    expect(req.request.method).toBe('POST');
    // Sent without the spaces at the ends, for the role filtered by.
    expect(req.request.body).toEqual({
      data: {
        type: 'GroupMapping',
        attributes: { group: 'Writers' },
        relationships: { role: { data: { type: 'Role', id: 'author' } } },
      },
    });
    req.flush({ data: mapping('m3', 'Writers', 'author') });
    await settle();
    answerMe();
    expect(TestBed.inject(ToastService).toasts()[0]).toMatchObject({
      kind: 'success',
      message: {
        key: 'editor.admin.groupMappings.added',
        params: { group: 'Writers', role: 'Author' },
      },
    });
    expect(document.querySelector('#group-mapping-form')).toBeNull();
    // The list is read again.
    mappingsRequest(http).flush({
      data: [mapping('m3', 'Writers', 'author')],
      meta: { page: page(1) },
      links,
    });
  });

  it('keeps the dialog open and says why when the group gives the role already', async () => {
    const { http, settle } = await render('/group-mappings?role=author');
    mappingsRequest(http).flush(mappings);
    await settle();
    TestBed.inject(AdminActions).request('group-mappings');
    await settle();
    const group = document.querySelector<HTMLInputElement>(
      '#group-mapping-group',
    );
    if (!group) throw new Error('no group field');
    group.value = LONG_GROUP;
    group.dispatchEvent(new Event('input'));
    document
      .querySelector<HTMLFormElement>('#group-mapping-form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    http
      .expectOne('/api/group-mappings')
      .flush(conflict('group-mapping-exists'), {
        status: 409,
        statusText: 'Conflict',
      });
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'This group gives this role already.',
    );
    expect(document.querySelector('#group-mapping-form')).not.toBeNull();
    http.verify();
  });

  it('removes a mapping after asking', async () => {
    const { http, settle, el, answerMe } = await render();
    mappingsRequest(http).flush(mappings);
    await settle();
    const confirm = vi
      .spyOn(TestBed.inject(ZardAlertDialogService), 'confirm')
      .mockImplementation((config) => {
        (config.zOnOk as () => void)();
        return undefined as never;
      });
    el()
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Remove the mapping of leads to Administrator"]',
      )
      ?.click();
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0].zDescription).toContain(
      'Members of “leads” lose the role “Administrator” at once',
    );
    const req = http.expectOne('/api/group-mappings/m2');
    expect(req.request.method).toBe('DELETE');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    answerMe();
    expect(TestBed.inject(ToastService).toasts()[0]).toMatchObject({
      kind: 'success',
      message: { key: 'editor.admin.groupMappings.remove.done' },
    });
    mappingsRequest(http).flush({
      data: [mappings.data[0]],
      meta: { page: page(1) },
      links,
    });
  });

  it('shows a group name with markup as literal text in the confirmation', async () => {
    const { http, settle, el } = await render();
    const markup = '<a href="https://example.org">admins</a><img src=x>';
    mappingsRequest(http).flush({
      data: [mapping('m9', markup, 'admin')],
      meta: { page: page(1) },
      links,
    });
    await settle();
    // The real dialog: the name shows as typed, never as markup.
    el().querySelector<HTMLButtonElement>('tbody button')?.click();
    await settle();
    const description = document.querySelector(
      '[data-testid="z-alert-description"]',
    );
    expect(description?.textContent).toContain(`Members of “${markup}” lose`);
    expect(description?.querySelector('a, img')).toBeNull();
    http.verify();
  });

  it('explains in plain words why the last admins’ mapping stays (409 last-admin)', async () => {
    const { http, settle, el } = await render();
    mappingsRequest(http).flush(mappings);
    await settle();
    const dialogs = TestBed.inject(ZardAlertDialogService);
    vi.spyOn(dialogs, 'confirm').mockImplementation((config) => {
      (config.zOnOk as () => void)();
      return undefined as never;
    });
    const warning = vi
      .spyOn(dialogs, 'warning')
      .mockImplementation(() => undefined as never);
    el()
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Remove the mapping of leads to Administrator"]',
      )
      ?.click();
    http
      .expectOne('/api/group-mappings/m2')
      .flush(conflict('last-admin'), { status: 409, statusText: 'Conflict' });
    await settle();
    expect(warning).toHaveBeenCalledOnce();
    const shown = warning.mock.calls[0]?.[0];
    expect(shown?.zTitle).toBe('This mapping stays');
    expect(shown?.zDescription).toContain(
      'Removing it would leave nobody who can manage roles',
    );
    expect(shown?.zDescription).toContain('“leads”');
    // Nothing was removed: no toast, the list not read again.
    expect(TestBed.inject(ToastService).toasts()).toEqual([]);
    http.verify();
  });

  it('goes back a page when the last mapping of a later page is removed', async () => {
    const { http, settle, el, answerMe } = await render(
      '/group-mappings?page=2',
    );
    mappingsRequest(http).flush({
      data: [mapping('m26', 'zeta', 'author')],
      meta: { page: page(26, 25, 2) },
      links,
    });
    await settle();
    vi.spyOn(
      TestBed.inject(ZardAlertDialogService),
      'confirm',
    ).mockImplementation((config) => {
      (config.zOnOk as () => void)();
      return undefined as never;
    });
    el()
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Remove the mapping of zeta to Author"]',
      )
      ?.click();
    http
      .expectOne('/api/group-mappings/m26')
      .flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    answerMe();
    const req = mappingsRequest(http);
    expect(req.request.params.get('page[number]')).toBe('1');
    req.flush(mappings);
  });
});
