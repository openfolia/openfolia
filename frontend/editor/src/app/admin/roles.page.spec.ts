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
import { RolesPage } from './roles.page';

const links = { self: '', first: '', last: '', prev: null, next: null };
const page = (total: number, perPage = 50) => ({
  currentPage: 1,
  lastPage: 1,
  perPage,
  total,
});

const role = (
  id: string,
  name: string,
  permissions: string[],
  holders: number,
  scope: Record<string, unknown> = {},
) => ({
  type: 'Role',
  id,
  attributes: { name, description: null, permissions, scope },
  meta: { holders },
});

const admin = role(
  'admin',
  'Administrator',
  ['content.read', 'admin.roles'],
  1,
);
const reader = role('reader', 'Reader', ['content.read'], 0, {
  languages: ['de'],
});
const roles = { data: [admin, reader], meta: { page: page(2) }, links };

const user = (id: string, name: string, roleIds: string[]) => ({
  type: 'User',
  id,
  attributes: { name, email: `${id}@example.org`, deactivatedAt: null },
  relationships: {
    roles: { data: roleIds.map((r) => ({ type: 'Role', id: r })) },
  },
});
const jane = user('jane', 'Jane Doe', ['admin']);
const max = user('max', 'Max Muster', []);
const serviceAccount = (id: string, name: string, roleIds: string[]) => ({
  type: 'ServiceAccount',
  id,
  attributes: {
    name,
    description: null,
    deactivatedAt: null,
    createdAt: '2026-11-01T10:00:00.000Z',
  },
  relationships: {
    roles: { data: roleIds.map((r) => ({ type: 'Role', id: r })) },
  },
});
const portal = serviceAccount('portal-build', 'Portal build', []);
const noServices = { data: [], meta: { page: page(0, 25) }, links };

const config = {
  data: {
    type: 'ProjectConfig',
    id: 'config',
    attributes: {
      languages: { source: 'en', targets: ['de'] },
      moduleTypes: [
        { id: 'task', label: 'Task', restricted: false, snippet: false },
      ],
      audiences: [{ id: 'operator', label: 'Operator' }],
      facets: [],
      variantAttributes: [],
      textAttributes: [],
    },
  },
};

async function render(url = '/roles') {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'roles', component: RolesPage }]),
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
  http.expectOne('/api/config').flush(config);
  http
    .expectOne((r) => r.url === '/api/users' && r.params.has('filter[status]'))
    .flush({ data: [jane, max], meta: { page: page(2, 200) }, links });
  http
    .expectOne(
      (r) =>
        r.url === '/api/service-accounts' && r.params.has('filter[status]'),
    )
    .flush({ data: [portal], meta: { page: page(1, 200) }, links });
  http.expectOne((r) => r.url === '/api/roles').flush(roles);
  await settle();
  return {
    http,
    settle,
    el: () => harness.routeNativeElement as HTMLElement,
  };
}

/** The role's holders: the people as given, the service accounts as given or none. */
const holders = (http: HttpTestingController, roleId: string) => ({
  flush: (people: unknown, services: unknown = noServices) => {
    http
      .expectOne(
        (r) =>
          r.url === '/api/users' && r.params.get('filter[role]') === roleId,
      )
      .flush(people as object);
    serviceHolders(http, roleId).flush(services as object);
  },
});
const serviceHolders = (http: HttpTestingController, roleId: string) =>
  http.expectOne(
    (r) =>
      r.url === '/api/service-accounts' &&
      r.params.get('filter[role]') === roleId,
  );

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  );

describe('RolesPage', () => {
  it('shows the first role, its permissions and who holds it; it cannot be deleted while held', async () => {
    const { http, settle, el } = await render();
    http.expectOne('/api/roles/admin').flush({ data: admin });
    await settle();
    holders(http, 'admin').flush({
      data: [jane],
      meta: { page: page(1, 25) },
      links,
    });
    await settle();

    const list = [...el().querySelectorAll('[aria-current="true"]')].map((b) =>
      b.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(list).toEqual(['AdministratorEditing']);
    expect(el().querySelector<HTMLInputElement>('#role-name')?.value).toBe(
      'Administrator',
    );
    expect(el().textContent).toContain('Create roles, assign people');
    expect(el().textContent).toContain('Jane Doe');
    expect(button(el(), 'Delete role')?.disabled).toBe(true);
    expect(el().textContent).toContain('Held by 1 person');
    // Nothing changed yet: nothing to save.
    expect(button(el(), 'Save changes')?.disabled).toBe(true);
    http.verify();
  });

  it('lists a holder through a sign-in group without a remove button, and links to the role’s group mappings (#592)', async () => {
    const { http, settle, el } = await render();
    http.expectOne('/api/roles/admin').flush({ data: admin });
    await settle();
    const viaGroup = {
      ...user('lee', 'Lee Group', ['admin']),
      meta: { permissions: [], groupRoleIds: ['admin'] },
    };
    holders(http, 'admin').flush({
      data: [jane, viaGroup],
      meta: { page: page(2, 25) },
      links,
    });
    await settle();

    expect(el().querySelector('[data-via="group"]')?.textContent?.trim()).toBe(
      'Through a sign-in group',
    );
    const removes = [
      ...el().querySelectorAll<HTMLButtonElement>('button[aria-label]'),
    ]
      .map((b) => b.getAttribute('aria-label'))
      .filter((label) => label?.startsWith('Take the role from'));
    expect(removes).toEqual(['Take the role from Jane Doe']);

    const link = [...el().querySelectorAll<HTMLAnchorElement>('a')].find(
      (a) => a.textContent?.trim() === 'Show the groups that give this role',
    );
    expect(link?.getAttribute('href')).toBe('/admin/group-mappings?role=admin');
    http.verify();
  });

  it('saves a changed role and keeps the choice in the address', async () => {
    const { http, settle, el } = await render('/roles?role=reader');
    http.expectOne('/api/roles/reader').flush({ data: reader });
    await settle();
    holders(http, 'reader').flush({
      data: [],
      meta: { page: page(0, 25) },
      links,
    });
    await settle();
    expect(TestBed.inject(Router).url).toBe('/roles?role=reader');

    const edit = el().querySelector<HTMLInputElement>('#perm-content\\.edit');
    edit?.click();
    await settle();
    const save = button(el(), 'Save changes');
    expect(save?.disabled).toBe(false);
    el()
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    const req = http.expectOne('/api/roles/reader');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({
      data: {
        type: 'Role',
        id: 'reader',
        attributes: {
          name: 'Reader',
          description: null,
          permissions: ['content.read', 'content.edit'],
          scope: { languages: ['de'] },
        },
      },
    });
    const saved = role(
      'reader',
      'Reader',
      ['content.read', 'content.edit'],
      0,
      {
        languages: ['de'],
      },
    );
    req.flush({ data: saved });
    await settle();
    expect(TestBed.inject(ToastService).toasts()[0]?.kind).toBe('success');
    http.expectOne((r) => r.url === '/api/roles').flush(roles);
    http.expectOne('/api/me').flush({
      data: {
        type: 'Me',
        id: 'jane',
        attributes: { name: 'Jane Doe', kind: 'user', roles: [] },
        meta: { permissions: [{ permission: 'admin.roles' }] },
      },
    });
  });

  it('starts a new role from the header, with an ID made from the name', async () => {
    const { http, settle, el } = await render();
    http.expectOne('/api/roles/admin').flush({ data: admin });
    await settle();
    holders(http, 'admin').flush({
      data: [],
      meta: { page: page(0, 25) },
      links,
    });
    await settle();

    TestBed.inject(AdminActions).request('roles');
    await settle();
    const name = el().querySelector<HTMLInputElement>('#role-name');
    if (!name) throw new Error('no name field');
    expect(name.value).toBe('');
    name.value = 'Safety approver';
    name.dispatchEvent(new Event('input'));
    await settle();
    expect(el().querySelector<HTMLInputElement>('#role-id')?.value).toBe(
      'safety-approver',
    );
    // A permission is needed first.
    el()
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(el().textContent).toContain('Choose at least one permission.');
    http.verify();
  });

  it('starts a new role at once: a name typed right after "New role" is the new role’s, never a prompt', async () => {
    const { http, settle, el } = await render();
    http.expectOne('/api/roles/admin').flush({ data: admin });
    await settle();
    holders(http, 'admin').flush({
      data: [],
      meta: { page: page(0, 25) },
      links,
    });
    await settle();
    const confirm = vi.spyOn(TestBed.inject(ZardAlertDialogService), 'confirm');

    // "New role", and the name typed in the same moment: before the page renders again, into
    // the field that still shows the first role.
    TestBed.inject(AdminActions).request('roles');
    const name = el().querySelector<HTMLInputElement>('#role-name');
    if (!name) throw new Error('no name field');
    name.value = 'Safety approver';
    name.dispatchEvent(new Event('input'));
    await settle();

    expect(confirm).not.toHaveBeenCalled();
    expect(el().querySelector<HTMLInputElement>('#role-name')?.value).toBe(
      'Safety approver',
    );
    expect(el().querySelector<HTMLInputElement>('#role-id')?.value).toBe(
      'safety-approver',
    );
    http.verify();
  });

  it('keeps a new role started while the first role is still read (#531)', async () => {
    const { http, settle, el } = await render();
    // The first role's read is open when "New role" is chosen.
    const read = http.expectOne('/api/roles/admin');
    TestBed.inject(AdminActions).request('roles');
    await settle();
    const name = el().querySelector<HTMLInputElement>('#role-name');
    if (!name) throw new Error('no name field');
    expect(name.value).toBe('');
    // The form appeared in place of the one still read, with its name field focused.
    expect(document.activeElement).toBe(name);
    name.value = 'Safety approver';
    name.dispatchEvent(new Event('input'));
    await settle();

    // Its late answer leaves the new role's form as it is.
    read.flush({ data: admin });
    await settle();
    expect(el().querySelector<HTMLInputElement>('#role-name')?.value).toBe(
      'Safety approver',
    );
    expect(el().querySelector<HTMLInputElement>('#role-id')?.value).toBe(
      'safety-approver',
    );
    expect(el().querySelector('[aria-current="true"]')).toBeNull();
    http.verify();
  });

  it('keeps a new role started while a saved role is still answered', async () => {
    const { http, settle, el } = await render('/roles?role=reader');
    http.expectOne('/api/roles/reader').flush({ data: reader });
    await settle();
    holders(http, 'reader').flush({
      data: [],
      meta: { page: page(0, 25) },
      links,
    });
    await settle();
    el().querySelector<HTMLInputElement>('#perm-content\\.edit')?.click();
    await settle();
    el()
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    const patch = http.expectOne('/api/roles/reader');
    expect(patch.request.method).toBe('PATCH');

    // "New role" while the save is open; the changes are not discarded silently, so answer yes.
    vi.spyOn(
      TestBed.inject(ZardAlertDialogService),
      'confirm',
    ).mockImplementation((config) => {
      (config.zOnOk as () => void)();
      return { isClosing: () => false } as never;
    });
    TestBed.inject(AdminActions).request('roles');
    await settle();
    expect(el().querySelector<HTMLInputElement>('#role-name')?.value).toBe('');

    patch.flush({
      data: role('reader', 'Reader', ['content.read', 'content.edit'], 0),
    });
    await settle();
    expect(el().querySelector<HTMLInputElement>('#role-name')?.value).toBe('');
    expect(el().querySelector('#role-id')).not.toBeNull();
  });

  it('keeps a save answered while the discard question is open, when the answer is no', async () => {
    const { http, settle, el } = await render('/roles?role=reader');
    http.expectOne('/api/roles/reader').flush({ data: reader });
    await settle();
    holders(http, 'reader').flush({
      data: [],
      meta: { page: page(0, 25) },
      links,
    });
    await settle();
    el().querySelector<HTMLInputElement>('#perm-content\\.edit')?.click();
    await settle();
    el()
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    const patch = http.expectOne('/api/roles/reader');

    // Another role chosen while the save is open: the question waits for an answer.
    let cancel: (() => void) | undefined;
    vi.spyOn(
      TestBed.inject(ZardAlertDialogService),
      'confirm',
    ).mockImplementation((config) => {
      cancel = config.zOnCancel as () => void;
      return { isClosing: () => false } as never;
    });
    [...el().querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('Administrator'))
      ?.click();
    await settle();
    expect(cancel).toBeDefined();

    patch.flush({
      data: role('reader', 'Reader', ['content.read', 'content.edit'], 0, {
        languages: ['de'],
      }),
    });
    await settle();
    cancel?.();
    await settle();
    expect(TestBed.inject(Router).url).toBe('/roles?role=reader');
    // Saved: nothing left to save, so "Discard" has nothing to undo.
    expect(button(el(), 'Save changes')?.disabled).toBe(true);
  });

  it('keeps a save answered before the role read a holder change began (#534)', async () => {
    const { http, settle, el } = await render('/roles?role=reader');
    http.expectOne('/api/roles/reader').flush({ data: reader });
    await settle();
    holders(http, 'reader').flush({
      data: [],
      meta: { page: page(0, 25) },
      links,
    });
    await settle();

    // A holder added: the role is read again, and that read is held.
    el()
      .querySelector<HTMLButtonElement>(
        'z-select[zSearchable] button, z-select[zsearchable] button',
      )
      ?.click();
    await settle();
    [...document.querySelectorAll<HTMLElement>('z-select-item')]
      .find((o) => o.textContent?.trim() === 'Max Muster')
      ?.click();
    await settle();
    http
      .expectOne('/api/users/max/relationships/roles')
      .flush({ data: [{ type: 'Role', id: 'reader' }] });
    await settle();
    holders(http, 'reader').flush({
      data: [user('max', 'Max Muster', ['reader'])],
      meta: { page: page(1, 25) },
      links,
    });
    http
      .expectOne(
        (r) => r.url === '/api/users' && r.params.has('filter[status]'),
      )
      .flush({ data: [jane, max], meta: { page: page(2, 200) }, links });
    const read = http.expectOne('/api/roles/reader');
    expect(read.request.method).toBe('GET');

    // Changed and saved before that read answers; the save's answer counts no holder yet.
    el().querySelector<HTMLInputElement>('#perm-content\\.edit')?.click();
    await settle();
    el()
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    const patch = http.expectOne('/api/roles/reader');
    expect(patch.request.method).toBe('PATCH');
    patch.flush({
      data: role('reader', 'Reader', ['content.read', 'content.edit'], 0, {
        languages: ['de'],
      }),
    });
    await settle();
    http.expectOne((r) => r.url === '/api/roles').flush(roles);
    http.expectOne('/api/me').flush({
      data: {
        type: 'Me',
        id: 'jane',
        attributes: { name: 'Jane Doe', kind: 'user', roles: [] },
        meta: { permissions: [{ permission: 'admin.roles' }] },
      },
    });
    await settle();

    // The read answers with the role as it was before the save, and its new holder.
    read.flush({
      data: role('reader', 'Reader', ['content.read'], 1, {
        languages: ['de'],
      }),
    });
    await settle();
    expect(
      el().querySelector<HTMLInputElement>('#perm-content\\.edit')?.checked,
    ).toBe(true);
    expect(button(el(), 'Save changes')?.disabled).toBe(true);
    // Its holders count: the role is held now, so it cannot be deleted.
    expect(button(el(), 'Delete role')?.disabled).toBe(true);
    expect(el().textContent).toContain('Held by 1 person');
    http.verify();
  });

  it('shows a save answered while the discard question is open as the API stored it', async () => {
    const { http, settle, el } = await render('/roles?role=reader');
    http.expectOne('/api/roles/reader').flush({ data: reader });
    await settle();
    holders(http, 'reader').flush({
      data: [],
      meta: { page: page(0, 25) },
      links,
    });
    await settle();
    el().querySelector<HTMLInputElement>('#perm-content\\.edit')?.click();
    await settle();
    el()
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    const patch = http.expectOne('/api/roles/reader');

    let cancel: (() => void) | undefined;
    vi.spyOn(
      TestBed.inject(ZardAlertDialogService),
      'confirm',
    ).mockImplementation((config) => {
      cancel = config.zOnCancel as () => void;
      return { isClosing: () => false } as never;
    });
    [...el().querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('Administrator'))
      ?.click();
    await settle();

    // The API stores more than was sent (here: a language added to the scope).
    patch.flush({
      data: role('reader', 'Reader', ['content.read', 'content.edit'], 0, {
        languages: ['de', 'en'],
      }),
    });
    await settle();
    cancel?.();
    await settle();
    expect(TestBed.inject(Router).url).toBe('/roles?role=reader');
    // Back on it, saved: the form shows what is stored, nothing to save.
    expect(button(el(), 'Save changes')?.disabled).toBe(true);
  });

  it('keeps a second new role started while the first one is still created', async () => {
    const { http, settle, el } = await render();
    http.expectOne('/api/roles/admin').flush({ data: admin });
    await settle();
    holders(http, 'admin').flush({
      data: [],
      meta: { page: page(0, 25) },
      links,
    });
    await settle();
    const actions = TestBed.inject(AdminActions);
    actions.request('roles');
    await settle();
    const name = el().querySelector<HTMLInputElement>('#role-name');
    if (!name) throw new Error('no name field');
    name.value = 'Safety approver';
    name.dispatchEvent(new Event('input'));
    el().querySelector<HTMLInputElement>('#perm-content\\.read')?.click();
    await settle();
    el()
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    const post = http.expectOne(
      (r) => r.url === '/api/roles' && r.method === 'POST',
    );

    vi.spyOn(
      TestBed.inject(ZardAlertDialogService),
      'confirm',
    ).mockImplementation((config) => {
      (config.zOnOk as () => void)();
      return { isClosing: () => false } as never;
    });
    actions.request('roles');
    await settle();
    expect(el().querySelector<HTMLInputElement>('#role-name')?.value).toBe('');

    post.flush({
      data: role('safety-approver', 'Safety approver', ['content.read'], 0),
    });
    await settle();
    expect(el().querySelector<HTMLInputElement>('#role-name')?.value).toBe('');
    expect(el().querySelector('#role-id')).not.toBeNull();
    expect(TestBed.inject(Router).url).toBe('/roles?role=admin');
  });

  it('asks before unsaved changes go when another role is chosen, and keeps them on no', async () => {
    const { http, settle, el } = await render('/roles?role=reader');
    http.expectOne('/api/roles/reader').flush({ data: reader });
    await settle();
    holders(http, 'reader').flush({
      data: [],
      meta: { page: page(0, 25) },
      links,
    });
    await settle();

    const name = el().querySelector<HTMLInputElement>('#role-name');
    if (!name) throw new Error('no name field');
    name.value = 'Reader (changed)';
    name.dispatchEvent(new Event('input'));
    await settle();

    let answer: 'ok' | 'cancel' = 'cancel';
    const confirm = vi
      .spyOn(TestBed.inject(ZardAlertDialogService), 'confirm')
      .mockImplementation((config) => {
        ((answer === 'ok' ? config.zOnOk : config.zOnCancel) as () => void)();
        return { isClosing: () => false } as never;
      });
    const adminRow = () =>
      [...el().querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes('Administrator'),
      );
    adminRow()?.click();
    await settle();
    expect(confirm).toHaveBeenCalledOnce();
    // Kept: the address is back on the role, the change still there.
    expect(TestBed.inject(Router).url).toBe('/roles?role=reader');
    expect(el().querySelector<HTMLInputElement>('#role-name')?.value).toBe(
      'Reader (changed)',
    );
    // Nothing read again that would overwrite them.
    http.verify();

    answer = 'ok';
    adminRow()?.click();
    await settle();
    http.expectOne('/api/roles/admin').flush({ data: admin });
    await settle();
    holders(http, 'admin').flush({
      data: [],
      meta: { page: page(0, 25) },
      links,
    });
    await settle();
    expect(el().querySelector<HTMLInputElement>('#role-name')?.value).toBe(
      'Administrator',
    );
    http.verify();
  });

  it('stays on a role chosen again before another one was read', async () => {
    const { http, settle, el } = await render('/roles?role=reader');
    http.expectOne('/api/roles/reader').flush({ data: reader });
    await settle();
    holders(http, 'reader').flush({
      data: [],
      meta: { page: page(0, 25) },
      links,
    });
    await settle();

    const row = (name: string) =>
      [...el().querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes(name),
      );
    row('Administrator')?.click();
    await settle();
    const late = http.expectOne('/api/roles/admin');
    row('Reader')?.click();
    await settle();
    late.flush({ data: admin });
    await settle();
    expect(TestBed.inject(Router).url).toBe('/roles?role=reader');
    expect(el().querySelector<HTMLInputElement>('#role-name')?.value).toBe(
      'Reader',
    );
    http.verify();
  });

  it('lists the service accounts holding a role, marked as such, and offers others', async () => {
    const { http, settle, el } = await render('/roles?role=reader');
    http.expectOne('/api/roles/reader').flush({ data: reader });
    await settle();
    const ci = serviceAccount('ci', 'Release pipeline', ['reader']);
    holders(http, 'reader').flush(
      { data: [jane], meta: { page: page(1, 25) }, links },
      { data: [ci], meta: { page: page(1, 25) }, links },
    );
    await settle();
    expect(el().textContent).toContain('Release pipeline');
    expect(el().textContent).toContain('Service account');

    // The picker offers people and service accounts, each marked.
    el()
      .querySelector<HTMLButtonElement>(
        'z-select[zSearchable] button, z-select[zsearchable] button',
      )
      ?.click();
    await settle();
    const options = [...document.querySelectorAll('z-select-item')].map((o) =>
      o.textContent?.trim(),
    );
    expect(options).toEqual([
      'Jane Doe',
      'Max Muster',
      'Portal build (service account)',
    ]);
    [...document.querySelectorAll<HTMLElement>('z-select-item')]
      .find((o) => o.textContent?.trim() === 'Portal build (service account)')
      ?.click();
    await settle();
    const req = http.expectOne(
      '/api/service-accounts/portal-build/relationships/roles',
    );
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      data: [{ type: 'Role', id: 'reader' }],
    });
    req.flush({ data: [{ type: 'Role', id: 'reader' }] });
    await settle();
    holders(http, 'reader').flush(
      { data: [jane], meta: { page: page(1, 25) }, links },
      { data: [ci], meta: { page: page(1, 25) }, links },
    );
    http
      .expectOne(
        (r) =>
          r.url === '/api/service-accounts' && r.params.has('filter[status]'),
      )
      .flush({ data: [], meta: { page: page(0, 200) }, links });
    http.expectOne('/api/roles/reader').flush({ data: reader });
  });

  it('offers no service account a role that manages access', async () => {
    const { http, settle, el } = await render();
    http.expectOne('/api/roles/admin').flush({ data: admin });
    await settle();
    holders(http, 'admin').flush({
      data: [jane],
      meta: { page: page(1, 25) },
      links,
    });
    await settle();
    expect(el().textContent).toContain(
      'It manages access (admin.roles), so no service account may hold it.',
    );
    el()
      .querySelector<HTMLButtonElement>(
        'z-select[zSearchable] button, z-select[zsearchable] button',
      )
      ?.click();
    await settle();
    const options = [...document.querySelectorAll('z-select-item')].map((o) =>
      o.textContent?.trim(),
    );
    expect(options).toEqual(['Max Muster']);
  });
});
