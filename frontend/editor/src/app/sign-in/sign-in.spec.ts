import { HttpTestingController } from '@angular/common/http/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import type { TestRequest } from '@angular/common/http/testing';
import { inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { firstValueFrom } from 'rxjs';

import { provideZard } from '@openfolia/ui/core';

import { ApiClient, API_DEMO_USER, provideApi } from '../api';
import { routes } from '../app.routes';
import { MeService, provideSessionEnd } from '../permissions/me';
import { DemoSession } from '../session/demo-session';
import { PAGE_NAVIGATION } from '../session/sign-in-session';
import { safeReturnUrl } from './sign-in.guards';

/** How the fake API answers. */
interface Server {
  /** `GET /demo/users`: the seeded users (demo mode), or `off` (404, token mode). */
  demo: readonly string[] | 'off' | 'down';
  /** `GET /me` without `X-Ccms-User`: the token's service, or a refused token. */
  token: 'service' | 'session' | 401 | 'down';
  /** Every other call refused 401 too (a session that ended). */
  refuseAll?: boolean;
  /** `GET /auth/providers` (#37): none unless set. */
  providers?: readonly { id: string; name: string | null }[];
  /** `GET /auth/options` (#610): password sign-in on, with "Forgot password" or not. */
  password?: { reset: boolean };
  /** `POST /auth/password/sign-in`: the password is right (then `/me` is the session) or not. */
  passwordRight?: boolean;
  /** `GET /auth/options` (#634): "Email me a code" offered. */
  emailCode?: boolean;
  /** `POST /auth/email-code/sign-in`: the code is right (then `/me` is the session) or not. */
  codeRight?: boolean;
  /** The bodies the code routes got (#634). */
  codeRequests?: unknown[];
}

const users = (ids: readonly string[]) => ({
  data: ids.map((id) => ({
    type: 'User',
    id,
    attributes: { name: `Name ${id}` },
    relationships: { roles: { data: [{ type: 'Role', id: 'author' }] } },
    meta: {
      permissions: ['content.read', 'content.read.draft', 'content.edit'],
    },
  })),
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 200, total: ids.length },
  },
  links: {},
});
const actor = (id: string, kind: 'user' | 'service') => ({
  data: {
    type: 'Actor',
    id,
    attributes: {
      kind,
      name: kind === 'user' ? `Name ${id}` : 'API token',
      roles: [
        { id: 'r', name: 'Role R', permissions: ['content.read'], scope: {} },
      ],
    },
    meta: { permissions: [{ permission: 'content.read', scopes: [{}] }] },
  },
});
const emptyPage = {
  data: [],
  meta: { page: { currentPage: 1, lastPage: 1, perPage: 200, total: 0 } },
  links: {},
};
const error = (status: number) => ({
  errors: [{ status: String(status), title: 'x', detail: 'x', code: 'x' }],
});

function answer(request: TestRequest, server: Server): void {
  const { url, headers } = request.request;
  const down = () => request.error(new ProgressEvent('error'), { status: 0 });
  if (url === '/api/demo/users') {
    if (server.demo === 'down') return down();
    if (server.demo === 'off') {
      return request.flush(error(404), { status: 404, statusText: 'x' });
    }
    return request.flush(users(server.demo));
  }
  if (url === '/api/auth/providers') {
    const items = server.providers ?? [];
    return request.flush({
      data: items.map(({ id, name }) => ({
        type: 'IdentityProvider',
        id,
        attributes: { name },
        links: { signIn: `auth/${id}/sign-in` },
      })),
      meta: {
        page: { currentPage: 1, lastPage: 1, perPage: 20, total: items.length },
      },
      links: {},
    });
  }
  if (
    url === '/api/auth/options' &&
    (server.password || server.emailCode !== undefined)
  ) {
    return request.flush({
      data: {
        type: 'SignInOptions',
        id: 'sign-in',
        attributes: {
          password: server.password !== undefined,
          passwordReset: server.password?.reset ?? false,
          emailCode: server.emailCode ?? false,
          providers: server.providers?.length ?? 0,
        },
      },
    });
  }
  if (url === '/api/auth/email-code/request') {
    server.codeRequests?.push(request.request.body);
    return request.flush(
      { meta: { message: 'If the address is known, a code is on its way.' } },
      { status: 202, statusText: 'Accepted' },
    );
  }
  if (url === '/api/auth/email-code/sign-in') {
    server.codeRequests?.push(request.request.body);
    if (!server.codeRight) {
      return request.flush(
        {
          errors: [
            {
              status: '401',
              title: 'Unauthorized',
              detail: 'x',
              code: 'invalid-code',
            },
          ],
        },
        { status: 401, statusText: 'x' },
      );
    }
    server.token = 'session';
    return request.flush({ meta: { userId: 'pat' } });
  }
  if (url === '/api/auth/password/sign-in') {
    if (!server.passwordRight) {
      return request.flush(
        {
          errors: [
            {
              status: '401',
              title: 'Unauthorized',
              detail: 'x',
              code: 'invalid-credentials',
            },
          ],
        },
        { status: 401, statusText: 'x' },
      );
    }
    server.token = 'session';
    return request.flush({ meta: { userId: 'pat' } });
  }
  if (url === '/api/me') {
    const user = headers.get('X-Ccms-User');
    if (user) return request.flush(actor(user, 'user'));
    if (server.token === 'down') return down();
    if (server.token === 'session') {
      const signedIn = actor('pat', 'user');
      return request.flush({
        ...signedIn,
        data: {
          ...signedIn.data,
          meta: {
            ...signedIn.data.meta,
            session: { provider: 'oidc', expiresAt: '2030-01-01T00:00:00Z' },
          },
        },
      });
    }
    if (server.token === 401) {
      return request.flush(error(401), { status: 401, statusText: 'x' });
    }
    return request.flush(actor('service:api-token', 'service'));
  }
  if (server.refuseAll) {
    return request.flush(error(401), { status: 401, statusText: 'x' });
  }
  request.flush(emptyPage);
}

/** Where the app sent the browser away to (a full page load). */
let navigations: string[] = [];
beforeEach(() => {
  navigations = [];
});

const tick = () => new Promise((resolve) => setTimeout(resolve));

/** Answers every request the app makes, until it makes no more. */
async function serve(http: HttpTestingController, server: Server) {
  for (let round = 0; round < 20; round++) {
    await tick();
    const open = http.match(() => true);
    if (open.length === 0) return;
    for (const request of open) answer(request, server);
  }
}

/** The app as `main.ts` starts it: the start-up reads first, then the first navigation. */
async function boot(server: Server, url: string) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes),
      provideZard(),
      provideApi(),
      provideHttpClientTesting(),
      {
        provide: API_DEMO_USER,
        useFactory: () => inject(DemoSession).actingAs,
      },
      provideSessionEnd(),
      {
        provide: PAGE_NAVIGATION,
        useValue: (url: string) => navigations.push(url),
      },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const started = TestBed.inject(DemoSession).start();
  await serve(http, server);
  await started;
  const harness = await RouterTestingHarness.create();
  const navigated = harness.navigateByUrl(url);
  await serve(http, server);
  await navigated.catch(() => undefined);
  await harness.fixture.whenStable();
  // The page's own reads (the providers, #37) start once its lazy chunk has loaded.
  await serve(http, server);
  await harness.fixture.whenStable();
  const el = harness.fixture.nativeElement as HTMLElement;
  const router = TestBed.inject(Router);
  const settle = async () => {
    await serve(http, server);
    await harness.fixture.whenStable();
  };
  return { harness, http, el, router, settle };
}

const view = (el: HTMLElement) =>
  el.querySelector('[data-view]')?.getAttribute('data-view');

describe('sign-in', () => {
  it('sends any editor address to the sign-in page in token mode, saying sign-in is not set up', async () => {
    const { el, router } = await boot(
      { demo: 'off', token: 'service' },
      '/manuals?x=1',
    );
    expect(router.url).toBe('/sign-in?returnUrl=%2Fmanuals%3Fx%3D1');
    expect(el.querySelector('of-shell')).toBeNull();
    expect(view(el)).toBe('not-configured');
    expect(el.textContent).toContain("Sign-in isn't set up on this server");
    expect(el.textContent).toContain('CCMS_AUTH_MODE=demo');
    expect(el.textContent).toContain('api:db-seed -- --example');
    // No user picker outside demo mode.
    expect(el.querySelector('ul[aria-label="Demo users"]')).toBeNull();
  });

  it('says a refused token, without a picker or a retry', async () => {
    const { el, router } = await boot({ demo: 'off', token: 401 }, '/');
    expect(router.url).toBe('/sign-in');
    expect(view(el)).toBe('refused');
    expect(el.querySelector('of-no-access')).toBeTruthy();
    expect(el.querySelector('ul[aria-label="Demo users"]')).toBeNull();
  });

  it('in demo mode lists the users; picking one signs in and returns to the address', async () => {
    const { el, router, harness, settle } = await boot(
      { demo: ['u1', 'u2'], token: 'service' },
      '/review',
    );
    expect(router.url).toBe('/sign-in?returnUrl=%2Freview');
    expect(view(el)).toBe('users');
    const buttons = [
      ...el.querySelectorAll<HTMLButtonElement>(
        'ul[aria-label="Demo users"] button',
      ),
    ];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.textContent).toContain('Name u1');
    expect(buttons[1]?.textContent).toContain('Name u2');
    expect(buttons[1]?.textContent).toContain('author');
    buttons[1]?.click();
    await settle();
    await tick();
    await harness.fixture.whenStable();
    expect(router.url).toBe('/review');
    expect(TestBed.inject(MeService).me().id).toBe('u2');
    expect(localStorage.getItem('openfolia.demo-user')).toBe('u2');
    expect(el.querySelector('of-shell')).toBeTruthy();
    expect(el.querySelector('of-account-menu')?.textContent).toContain(
      'Name u2',
    );
  });

  it('in demo mode with nobody seeded says how to seed', async () => {
    const { el } = await boot({ demo: [], token: 'service' }, '/');
    expect(view(el)).toBe('empty');
    expect(el.textContent).toContain('No demo users yet');
    expect(el.textContent).toContain('pnpm nx run api:db-seed -- --example');
  });

  it('shows a failure to reach the API with a retry that asks again', async () => {
    const server: Server = { demo: 'down', token: 'down' };
    const { el, settle } = await boot(server, '/sign-in');
    expect(view(el)).toBe('failed');
    const retry = el.querySelector<HTMLButtonElement>('of-error-state button');
    expect(retry).toBeTruthy();
    server.demo = ['u1'];
    server.token = 'service';
    retry?.click();
    await settle();
    expect(view(el)).toBe('users');
  });

  it('lets a person acting go on past the sign-in page', async () => {
    localStorage.setItem('openfolia.demo-user', 'u1');
    const { router, el } = await boot(
      { demo: ['u1'], token: 'service' },
      '/sign-in?returnUrl=%2Fmanuals',
    );
    expect(router.url).toBe('/manuals');
    expect(el.querySelector('of-shell')).toBeTruthy();
  });

  it('opens the shell with the failure and a retry when /me cannot be read', async () => {
    const { el, router } = await boot(
      { demo: 'off', token: 'down' },
      '/manuals',
    );
    expect(router.url).toBe('/manuals');
    expect(el.querySelector('of-shell of-error-state')).toBeTruthy();
    // The nav and the account menu are placeholders, never empty.
    expect(el.querySelector('nav [data-state="loading"]')).toBeTruthy();
    expect(el.querySelector('of-account-menu')).toBeNull();
    expect(
      el.querySelector('z-sidebar-footer [data-state="loading"]'),
    ).toBeTruthy();
  });

  it('goes to the sign-in page when the person stops acting in the shell', async () => {
    localStorage.setItem('openfolia.demo-user', 'u1');
    const { router, settle } = await boot(
      { demo: ['u1'], token: 'service' },
      '/manuals',
    );
    expect(router.url).toBe('/manuals');
    const me = TestBed.inject(MeService);
    me.set({ ...me.me(), kind: 'service' });
    await settle();
    expect(router.url).toBe('/sign-in?returnUrl=%2Fmanuals');
  });
});

describe('sign-in with an identity provider (#37)', () => {
  it('offers a button per provider, which leaves for it with the address to come back to', async () => {
    const { el } = await boot(
      {
        demo: 'off',
        token: 401,
        providers: [{ id: 'oidc', name: 'Example ID' }],
      },
      '/manuals?x=1',
    );
    expect(view(el)).toBe('providers');
    expect(el.querySelector('of-no-access')).toBeNull();
    const button = el.querySelector<HTMLButtonElement>(
      'button[data-provider="oidc"]',
    );
    expect(button?.textContent).toContain('Sign in with Example ID');
    button?.click();
    expect(navigations).toEqual([
      '/api/auth/oidc/sign-in?returnTo=%2Fmanuals%3Fx%3D1',
    ]);
  });

  it('offers the password form (#610), says a wrong password, and signs in with the right one', async () => {
    const server: Server = {
      demo: 'off',
      token: 401,
      providers: [{ id: 'oidc', name: 'Example ID' }],
      password: { reset: false },
    };
    const { el, router, settle } = await boot(server, '/manuals?x=1');
    expect(view(el)).toBe('providers');
    const form = el.querySelector<HTMLFormElement>(
      '[data-testid="password-form"]',
    );
    expect(form).not.toBeNull();
    // "Forgot password" only when email can carry the link.
    expect(el.querySelector('[data-testid="forgot-password"]')).toBeNull();
    // The provider's button stays beside it.
    expect(el.querySelector('button[data-provider="oidc"]')).not.toBeNull();
    const type = (id: string, value: string) => {
      const input = el.querySelector<HTMLInputElement>(`#${id}`)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    type('sign-in-email', 'pat@example.org');
    type('sign-in-password', 'not the password');
    form!.requestSubmit();
    await settle();
    expect(
      el.querySelector('[data-testid="password-error"]')?.textContent,
    ).toContain('The email address or the password is not right.');
    expect(router.url).toBe('/sign-in?returnUrl=%2Fmanuals%3Fx%3D1');

    server.passwordRight = true;
    type('sign-in-password', 'a long and quiet river');
    form!.requestSubmit();
    await settle();
    await settle();
    expect(router.url).toBe('/manuals?x=1');
  });

  it('links "Forgot password" when the API offers it (#610)', async () => {
    const { el } = await boot(
      { demo: 'off', token: 401, password: { reset: true } },
      '/',
    );
    expect(view(el)).toBe('providers');
    expect(
      el.querySelector('[data-testid="forgot-password"]')?.getAttribute('href'),
    ).toBe('/forgot-password');
  });

  it('offers "Email me a code" only when the API does (#634)', async () => {
    const off = await boot(
      { demo: 'off', token: 401, password: { reset: false }, emailCode: false },
      '/',
    );
    expect(off.el.querySelector('[data-testid="email-code"]')).toBeNull();
    TestBed.resetTestingModule();
    // Without passwords too: the code alone is a way in.
    const { el } = await boot(
      { demo: 'off', token: 401, emailCode: true },
      '/manuals',
    );
    expect(view(el)).toBe('providers');
    expect(el.querySelector('[data-testid="password-form"]')).toBeNull();
    expect(
      el.querySelector('[data-testid="email-code"]')?.getAttribute('href'),
    ).toBe('/sign-in-code?returnUrl=%2Fmanuals');
  });

  it('asks for a code, says a wrong one, and signs in with the right one (#634)', async () => {
    const server: Server = {
      demo: 'off',
      token: 401,
      password: { reset: false },
      emailCode: true,
      codeRequests: [],
    };
    const { el, router, settle } = await boot(
      server,
      '/sign-in-code?returnUrl=%2Fmanuals',
    );
    expect(router.url).toBe('/sign-in-code?returnUrl=%2Fmanuals');
    const type = (id: string, value: string) => {
      const input = el.querySelector<HTMLInputElement>(`#${id}`)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    type('email-code-email', ' pat@example.org ');
    await settle();
    el.querySelector<HTMLFormElement>(
      '[data-testid="email-code-request"]',
    )!.requestSubmit();
    await settle();
    expect(
      el.querySelector('[data-testid="email-code-sent"]')?.textContent,
    ).toContain('If pat@example.org is known here, a code is on its way.');
    expect(server.codeRequests?.[0]).toEqual({
      data: {
        type: 'EmailCodeRequest',
        attributes: { email: 'pat@example.org', language: 'en' },
      },
    });
    const form = el.querySelector<HTMLFormElement>(
      '[data-testid="email-code-form"]',
    )!;
    // Not six digits: said before anything is sent.
    type('email-code-code', '12');
    form.requestSubmit();
    await settle();
    expect(
      el.querySelector('[data-testid="email-code-error"]')?.textContent,
    ).toContain('Enter the six digits from the email.');
    expect(server.codeRequests).toHaveLength(1);
    type('email-code-code', '123 456');
    form.requestSubmit();
    await settle();
    expect(
      el.querySelector('[data-testid="email-code-error"]')?.textContent,
    ).toContain(
      'The email address or the code is not right, or the code has run out.',
    );
    expect(router.url).toBe('/sign-in-code?returnUrl=%2Fmanuals');

    server.codeRight = true;
    type('email-code-code', '123456');
    form.requestSubmit();
    await settle();
    await settle();
    expect(server.codeRequests?.at(-1)).toEqual({
      data: {
        type: 'EmailCodeSignIn',
        attributes: { email: 'pat@example.org', code: '123456' },
      },
    });
    expect(router.url).toBe('/manuals');
  });

  it('goes to the sign-in page once a refused call shows the session ended', async () => {
    const server: Server = {
      demo: 'off',
      token: 'session',
      providers: [{ id: 'oidc', name: 'Example ID' }],
    };
    const { router, el, settle } = await boot(server, '/manuals');
    expect(router.url).toBe('/manuals');
    expect(TestBed.inject(MeService).me().session?.provider).toBe('oidc');
    server.token = 401;
    server.refuseAll = true;
    const refused = firstValueFrom(
      TestBed.inject(ApiClient).get('/manuals'),
    ).catch(() => undefined);
    await settle();
    await refused;
    await settle();
    await settle();
    expect(router.url).toBe('/sign-in?returnUrl=%2Fmanuals');
    expect(view(el)).toBe('providers');
  });

  it('names an unnamed provider in its own words', async () => {
    const { el } = await boot(
      { demo: 'off', token: 401, providers: [{ id: 'oidc', name: null }] },
      '/sign-in',
    );
    expect(
      el.querySelector('button[data-provider="oidc"]')?.textContent,
    ).toContain('Continue to sign-in');
  });

  it('says why a sign-in came back refused', async () => {
    const { el } = await boot(
      { demo: 'off', token: 401, providers: [{ id: 'oidc', name: 'X' }] },
      '/sign-in?error=user-deactivated',
    );
    expect(
      el.querySelector('[data-testid="sign-in-error"]')?.textContent,
    ).toContain('Your account is deactivated');
  });

  it('says nothing went wrong when nothing did', async () => {
    const { el } = await boot(
      { demo: 'off', token: 401, providers: [{ id: 'oidc', name: 'X' }] },
      '/sign-in',
    );
    expect(el.querySelector('[data-testid="sign-in-error"]')).toBeNull();
  });
});

describe('safeReturnUrl', () => {
  it('keeps a path inside the editor', () => {
    expect(safeReturnUrl('/content/en/a?x=1#b')).toBe('/content/en/a?x=1#b');
  });

  it('drops anything else, and the sign-in page itself', () => {
    for (const raw of [
      undefined,
      null,
      '',
      'https://example.org/',
      '//example.org/',
      '/\\example.org',
      'javascript:alert(1)',
      '/sign-in',
      '/sign-in?returnUrl=%2Fx',
    ]) {
      expect(safeReturnUrl(raw)).toBe('/');
    }
  });
});
