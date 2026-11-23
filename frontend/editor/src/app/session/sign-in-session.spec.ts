import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/startup';

import { provideApi } from '../api';
import {
  PAGE_NAVIGATION,
  SignInSession,
  signInErrorOf,
} from './sign-in-session';
import { SignOutMenuItemComponent } from './sign-out-menu-item.component';

const settled = () => new Promise((resolve) => setTimeout(resolve));

const providers = (...items: { id: string; name: string | null }[]) => ({
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

describe('signing in with an identity provider (#37)', () => {
  let http: HttpTestingController;
  let navigations: string[];

  beforeEach(() => {
    navigations = [];
    TestBed.configureTestingModule({
      providers: [
        provideZard(),
        provideApi(),
        provideHttpClientTesting(),
        {
          provide: PAGE_NAVIGATION,
          useValue: (url: string) => navigations.push(url),
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
  });

  it('reads the providers once, and leaves for one with the address to come back to', async () => {
    const session = TestBed.inject(SignInSession);
    const loaded = session.load();
    void session.load();
    expect(session.status()).toBe('loading');
    http
      .expectOne((r) => r.url === '/api/auth/providers')
      .flush(providers({ id: 'oidc', name: 'Example ID' }));
    await loaded;
    expect(session.status()).toBe('ready');
    expect(session.providers()).toEqual([{ id: 'oidc', name: 'Example ID' }]);

    session.signIn('oidc', '/manuals?x=1');
    expect(navigations).toEqual([
      '/api/auth/oidc/sign-in?returnTo=%2Fmanuals%3Fx%3D1',
    ]);
    expect(session.busy()).toBe(true);
    expect(session.signInUrl('oidc', '/')).toBe('/api/auth/oidc/sign-in');
  });

  it('says when the providers could not be read', async () => {
    const session = TestBed.inject(SignInSession);
    const loaded = session.load();
    http
      .expectOne((r) => r.url === '/api/auth/providers')
      .error(new ProgressEvent('error'), { status: 0 });
    await loaded;
    expect(session.status()).toBe('failed');
    expect(session.failure()?.kind).toBe('network');
  });

  it('signs out at the API, then at the provider, or on to the sign-in page', async () => {
    const session = TestBed.inject(SignInSession);
    let out = session.signOut();
    const first = http.expectOne('/api/auth/sign-out');
    expect(first.request.method).toBe('POST');
    expect(first.request.headers.get('Content-Type')).toBe(
      'application/vnd.api+json',
    );
    first.flush({
      meta: { signOutUrl: 'https://id.example.org/logout?x=1' },
    });
    await out;
    expect(navigations).toEqual(['https://id.example.org/logout?x=1']);

    out = session.signOut();
    http.expectOne('/api/auth/sign-out').flush({ meta: { signOutUrl: null } });
    await out;
    // Never anything but http(s), whatever the API answered.
    out = session.signOut();
    http
      .expectOne('/api/auth/sign-out')
      .flush({ meta: { signOutUrl: 'javascript:alert(1)' } });
    await out;
    expect(navigations.slice(1)).toEqual(['/sign-in', '/sign-in']);
  });

  it('keeps the session when signing out fails, and says so with a retry', async () => {
    const toast = TestBed.inject(ToastService);
    const error = vi.spyOn(toast, 'error');
    const fixture = TestBed.createComponent(SignOutMenuItemComponent);
    fixture.detectChanges();
    const item = (
      fixture.nativeElement as HTMLElement
    ).querySelector<HTMLElement>('[data-testid="sign-out"]');
    expect(item?.textContent?.trim()).toBe('Sign out');
    item?.click();
    http
      .expectOne('/api/auth/sign-out')
      .flush(
        { errors: [{ status: '503', title: 'x', detail: 'x', code: 'x' }] },
        { status: 503, statusText: 'x' },
      );
    await settled();
    expect(navigations).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(TestBed.inject(SignInSession).busy()).toBe(false);
  });

  it('reads why a sign-in came back refused, and nothing else', () => {
    expect(signInErrorOf(null)).toBeNull();
    expect(signInErrorOf('')).toBeNull();
    expect(signInErrorOf('user-deactivated')).toBe('user-deactivated');
    expect(signInErrorOf('<script>')).toBe('sign-in-failed');
  });
});
