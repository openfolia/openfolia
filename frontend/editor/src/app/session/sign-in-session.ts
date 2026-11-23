import { HttpClient } from '@angular/common/http';
import {
  DOCUMENT,
  inject,
  Injectable,
  InjectionToken,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import {
  API_BASE_URL,
  ApiClient,
  pageQuery,
  toApiError,
  type ApiError,
  type Schema,
} from '../api';

/** Where the browser goes next: a full page load, leaving the app (the provider's sign-in page). */
export const PAGE_NAVIGATION = new InjectionToken<(url: string) => void>(
  'PAGE_NAVIGATION',
  {
    providedIn: 'root',
    factory: () => {
      const location = inject(DOCUMENT).location;
      return (url: string) => location.assign(url);
    },
  },
);

/** An identity provider the sign-in page offers a button for (`GET /auth/providers`). */
export interface IdentityProviderChoice {
  readonly id: string;
  /** What the button names (`CCMS_OIDC_NAME`); null: the editor's own wording. */
  readonly name: string | null;
}

/**
 * Why a sign-in came back without a session (`/sign-in?error=<code>`, from the API's callback).
 * Anything else in the address is shown as `sign-in-failed`.
 */
export const SIGN_IN_ERRORS = [
  'provider-unavailable',
  'access-denied',
  'sign-in-failed',
  'sign-in-expired',
  'user-deactivated',
  'sign-in-not-allowed',
] as const;
export type SignInError = (typeof SIGN_IN_ERRORS)[number];

/** The text of each (a literal per key, so the translation check finds them). */
export const SIGN_IN_ERROR_TEXT: Record<SignInError, string> = {
  'provider-unavailable': 'editor.signIn.errors.provider-unavailable',
  'access-denied': 'editor.signIn.errors.access-denied',
  'sign-in-failed': 'editor.signIn.errors.sign-in-failed',
  'sign-in-expired': 'editor.signIn.errors.sign-in-expired',
  'user-deactivated': 'editor.signIn.errors.user-deactivated',
  'sign-in-not-allowed': 'editor.signIn.errors.sign-in-not-allowed',
};

export function signInErrorOf(raw: string | null): SignInError | null {
  if (raw === null || raw === '') return null;
  return (SIGN_IN_ERRORS as readonly string[]).includes(raw)
    ? (raw as SignInError)
    : 'sign-in-failed';
}

/** `loading` until `GET /auth/providers` answered; `failed` when it could not be asked. */
export type ProvidersStatus = 'loading' | 'ready' | 'failed';

/**
 * Sign-in with an identity provider (#37): which providers the API offers, the browser's trip
 * to one (a full page load to the API's `GET /auth/<id>/sign-in`, which sends it on to the
 * provider and back), and signing out (`POST /auth/sign-out`, then the provider's own sign-out
 * page when it has one). The session itself is an HttpOnly cookie the app never sees.
 */
@Injectable({ providedIn: 'root' })
export class SignInSession {
  private readonly api = inject(ApiClient);
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);
  private readonly navigate = inject(PAGE_NAVIGATION);

  private readonly state = signal<ProvidersStatus>('loading');
  private readonly list = signal<readonly IdentityProviderChoice[]>([]);
  private readonly failed = signal<ApiError | null>(null);
  private readonly leaving = signal(false);
  private asked: Promise<void> | null = null;

  constructor() {
    // Back from the provider with the browser's back button (a page from the cache): the
    // buttons work again.
    inject(DOCUMENT).defaultView?.addEventListener('pageshow', (event) => {
      if (event.persisted) this.leaving.set(false);
    });
  }

  readonly status = this.state.asReadonly();
  readonly providers = this.list.asReadonly();
  readonly failure = this.failed.asReadonly();
  /** True from the click until the browser has left (signing in or out). */
  readonly busy = this.leaving.asReadonly();

  /** Asks the API which providers it offers, once (`reload` asks again). */
  load(): Promise<void> {
    this.asked ??= this.read();
    return this.asked;
  }

  reload(): Promise<void> {
    this.asked = this.read();
    return this.asked;
  }

  /** The API's address that starts signing in with `providerId`, coming back to `returnUrl`. */
  signInUrl(providerId: string, returnUrl: string): string {
    const query =
      returnUrl === '/' ? '' : `?returnTo=${encodeURIComponent(returnUrl)}`;
    return `${this.base}/auth/${encodeURIComponent(providerId)}/sign-in${query}`;
  }

  /** Leaves for the provider's sign-in page. */
  signIn(providerId: string, returnUrl: string): void {
    this.leaving.set(true);
    this.navigate(this.signInUrl(providerId, returnUrl));
  }

  /**
   * Ends the session at the API, then goes to the provider's sign-out page (which comes back
   * to the sign-in page) or straight to the sign-in page. Rejects with an `ApiError` when the
   * API could not be asked; the session then still runs.
   */
  async signOut(): Promise<void> {
    this.leaving.set(true);
    try {
      const doc = await firstValueFrom(
        this.http.post<Schema<'SignedOutDocument'>>(
          `${this.base}/auth/sign-out`,
          {},
          {
            headers: {
              Accept: 'application/vnd.api+json',
              'Content-Type': 'application/vnd.api+json',
            },
          },
        ),
      );
      this.navigate(safeExternal(doc.meta.signOutUrl) ?? signInPage(this.base));
    } catch (error) {
      this.leaving.set(false);
      throw toApiError(error);
    }
  }

  private async read(): Promise<void> {
    this.state.set('loading');
    this.failed.set(null);
    try {
      const page = await firstValueFrom(
        this.api.get('/auth/providers', {
          query: pageQuery({ number: 1, size: 20 }),
        }),
      );
      this.list.set(
        page.data.map((item) => ({ id: item.id, name: item.attributes.name })),
      );
      this.state.set('ready');
    } catch (error) {
      this.failed.set(toApiError(error));
      this.state.set('failed');
    }
  }
}

/** The editor's own sign-in page, beside the API's base (`/api` → `/sign-in`). */
function signInPage(base: string): string {
  const root = base.replace(/\/?api\/?$/, '');
  return `${root}/sign-in`;
}

/** Only http(s): the address goes to `location.assign`, whatever the API answered. */
function safeExternal(url: string | null | undefined): string | undefined {
  if (!url || !URL.canParse(url)) return undefined;
  const { protocol } = new URL(url);
  return protocol === 'https:' || protocol === 'http:' ? url : undefined;
}
