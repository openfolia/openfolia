import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { ZardAlertDialogService } from '@openfolia/ui/alert-dialog';
import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../../api/api-interceptors';
import { SingleSignOnTopicPage } from './single-sign-on-topic.component';

interface State {
  singleSignOn?: 'optional' | 'required';
  account?: string | null;
  problem?: string | null;
  available?: boolean;
  idle?: number | null;
  max?: number | null;
}
const doc = (s: State = {}) => ({
  data: {
    type: 'InstallationSettings',
    id: 'installation',
    attributes: {
      selfApproval: 'never',
      secondFactor: 'optional',
      singleSignOn: s.singleSignOn ?? 'optional',
      sessionIdleMinutes: s.idle ?? null,
      sessionMaxHours: s.max ?? null,
      updatedAt: null,
    },
    relationships: {
      breakGlassAccount: {
        data: s.account ? { type: 'User', id: s.account } : null,
      },
    },
    meta: {
      singleSignOnAvailable: s.available ?? true,
      breakGlassProblem: s.problem ?? null,
      serverSessionIdleMinutes: 480,
      serverSessionMaxHours: 168,
    },
  },
});
const refusal = (code: string, meta?: object) =>
  [
    {
      errors: [
        {
          status: '409',
          code,
          title: 'Conflict',
          detail: 'x',
          ...(meta && { meta }),
        },
      ],
    },
    { status: 409, statusText: 'Conflict' },
  ] as const;
const user = (
  id: string,
  name: string,
  { password = true, admin = true } = {},
) => ({
  type: 'User',
  id,
  attributes: { name, email: `${id}@example.org`, deactivatedAt: null },
  relationships: { roles: { data: [] } },
  meta: {
    permissions: admin ? ['admin.roles'] : ['content.read'],
    groupRoleIds: [],
    signIn: {
      password,
      provider: false,
      inviteExpiresAt: null,
      secondFactor: false,
    },
  },
});

async function render(state: State = {}) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'x', component: SingleSignOnTopicPage }]),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  const { RouterTestingHarness } = await import('@angular/router/testing');
  const harness = await RouterTestingHarness.create();
  const http = TestBed.inject(HttpTestingController);
  void harness.navigateByUrl('/x');
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await harness.fixture.whenStable();
    }
  };
  await settle();
  http.expectOne('/api/settings').flush(doc(state));
  await settle();
  if (state.account) {
    http
      .expectOne(`/api/users/${state.account}`)
      .flush({ data: user(state.account, 'Rescue Person') });
    await settle();
  }
  const root = harness.routeNativeElement as HTMLElement;
  const confirm = vi
    .spyOn(TestBed.inject(ZardAlertDialogService), 'confirm')
    .mockReturnValue(undefined as never);
  return {
    http,
    settle,
    root,
    confirm,
    toast: vi.spyOn(TestBed.inject(ToastService), 'error'),
    at: (id: string) =>
      root.querySelector<HTMLElement>(`[data-testid="${id}"]`),
  };
}

/** Says yes to the confirmation that opened. */
const yes = (confirm: Awaited<ReturnType<typeof render>>['confirm']) =>
  (confirm.mock.calls[0]?.[0].zOnOk as () => void)();
const option = (root: HTMLElement, value: string) =>
  root.querySelector<HTMLElement>(`[data-option="${value}"] [role="radio"]`)!;
const text = (el: Element | null) => el?.textContent?.trim() ?? '';

describe('SingleSignOnTopicPage (#378)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('requires single sign-on only after a yes, and keeps the saved rule until then', async () => {
    const { http, settle, root, confirm } = await render({ account: 'rescue' });
    option(root, 'required').click();
    await settle();
    expect(option(root, 'optional').getAttribute('aria-checked')).toBe('true');
    expect(confirm).toHaveBeenCalledTimes(1);
    http.expectNone('/api/settings');
    yes(confirm);
    await settle();
    const req = http.expectOne('/api/settings');
    expect(req.request.body.data.attributes).toEqual({
      singleSignOn: 'required',
    });
    req.flush(doc({ singleSignOn: 'required', account: 'rescue' }));
    await settle();
    expect(option(root, 'required').getAttribute('aria-checked')).toBe('true');
    // What the sign-in page offers follows it.
    http.expectOne('/api/auth/options');
  });

  it('says where it is refused what keeps the admin in, once', async () => {
    const { http, settle, root, confirm, toast, at } = await render();
    option(root, 'required').click();
    await settle();
    yes(confirm);
    await settle();
    http
      .expectOne('/api/settings')
      .flush(...refusal('single-sign-on-own-first'));
    await settle();
    expect(option(root, 'optional').getAttribute('aria-checked')).toBe('true');
    expect(text(at('single-sign-on-refused'))).toContain(
      'Sign in with the identity provider first',
    );
    expect(toast).not.toHaveBeenCalled();
  });

  it('cannot be required without a provider, and says so', async () => {
    const { settle, root, confirm } = await render({ available: false });
    option(root, 'required').click();
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    expect(root.textContent).toContain('No identity provider is set up');
  });

  it('shows the emergency account by name, and why it is no way in any more', async () => {
    const { at } = await render({ account: 'rescue', problem: 'deactivated' });
    expect(text(at('emergency-account'))).toBe('Rescue Person');
    expect(text(at('emergency-account-problem'))).toContain('deactivated');
    expect(at('emergency-account-link')).toBeNull();
  });

  it('names a person found by search, and offers nobody who could not be it', async () => {
    const { http, settle, at } = await render();
    at('emergency-account-choose')!.click();
    // No word that there is nobody before there is an answer, from the first frame on.
    TestBed.tick();
    expect(
      document.querySelector('[data-testid="emergency-account-people"]')
        ?.textContent ?? '',
    ).not.toContain('Nobody found');
    await settle();
    // Typed in at once.
    expect(document.activeElement?.getAttribute('role')).toBe('combobox');
    const req = http.expectOne((r) => r.url === '/api/users');
    expect(req.request.params.get('filter[status]')).toBe('active');
    req.flush({
      data: [
        user('rescue', 'Rescue Person'),
        user('root', 'Root', { password: false }),
        user('pat', 'Pat', { admin: false }),
      ],
      meta: { page: { total: 30, lastPage: 2 } },
    });
    await settle();
    expect(
      document.querySelector('[data-testid="emergency-account-people"]')
        ?.textContent,
    ).toContain('More people than shown here');
    const options = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid="emergency-account-people"] [role="option"]',
      ),
    ];
    expect(options.map((o) => o.getAttribute('aria-disabled'))).toEqual([
      null,
      'true',
      'true',
    ]);
    options[1]!.click();
    http.expectNone('/api/settings');
    options[0]!.click();
    await settle();
    const patch = http.expectOne('/api/settings');
    expect(patch.request.body.data).toMatchObject({
      relationships: {
        breakGlassAccount: { data: { type: 'User', id: 'rescue' } },
      },
    });
    patch.flush(doc({ account: 'rescue' }));
    await settle();
    http.match('/api/users/rescue');
    expect(text(at('emergency-account'))).toBe('Rescue Person');
  });

  it('says why the API refuses the account chosen, and keeps the one before', async () => {
    const { http, settle, at, toast } = await render({ account: 'rescue' });
    at('emergency-account-remove')!.click();
    await settle();
    http
      .expectOne('/api/settings')
      .flush(...refusal('break-glass-not-usable', { problem: 'no-password' }));
    await settle();
    expect(text(at('emergency-account'))).toBe('Rescue Person');
    expect(text(at('emergency-account-problem'))).toContain('no password');
    expect(toast).not.toHaveBeenCalled();
  });

  it('gives the focus on when the account is removed', async () => {
    const { http, settle, at } = await render({ account: 'rescue' });
    at('emergency-account-remove')!.focus();
    at('emergency-account-remove')!.click();
    await settle();
    http.expectOne('/api/settings').flush(doc());
    await settle();
    expect(document.activeElement).toBe(at('emergency-account-choose'));
  });

  it('shows the saved limit again when the API refuses the chosen one', async () => {
    const { http, settle, root } = await render();
    const select = root.querySelector<HTMLElement>(
      '[data-slot="sessionMaxHours"]',
    )!;
    expect(text(select)).toContain('The server’s setting (7 days)');
    select.querySelector<HTMLElement>('button')!.click();
    await settle();
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((o) => text(o) === '12 hours')!
      .click();
    await settle();
    expect(text(select)).toContain('12 hours');
    http.expectOne('/api/settings').flush(...refusal('session-limits-crossed'));
    await settle();
    expect(text(select)).toContain('The server’s setting (7 days)');
  });

  it('shows the server’s own limits until one is set', async () => {
    const { root } = await render({ max: 12 });
    const value = (setting: string) =>
      text(root.querySelector(`[data-slot="${setting}"]`));
    expect(value('sessionIdleMinutes')).toContain(
      'The server’s setting (8 hours)',
    );
    expect(value('sessionMaxHours')).toContain('12 hours');
  });
});
