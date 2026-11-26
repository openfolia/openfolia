import { InjectionToken, type Signal } from '@angular/core';

/**
 * Where the API is reached from the browser. `/api` by default: the dev server proxies it
 * (`proxy.conf.mjs`, which also adds the token), a deployment puts a reverse proxy there.
 * The token is never part of the bundle.
 */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', {
  providedIn: 'root',
  factory: () => '/api',
});

/**
 * Slot for the demo identity: while it holds a user name, every API call carries it as
 * `X-Ccms-User` (the shared token is still required; the header only picks the seeded user).
 * `DemoSession` provides it, and only while the API is in demo mode.
 */
export const API_DEMO_USER = new InjectionToken<Signal<string | null>>(
  'API_DEMO_USER',
);

// Compatibility: keeps the working name from before the product was named OpenFolia (`X-Ccms-*`: the API's contract).
export const DEMO_USER_HEADER = 'X-Ccms-User';

/**
 * Called when an API call other than `GET /me` is refused 401 (#37): a signed-in session may have
 * ended (idle, its longest lifetime, signed out in another tab). `MeService.sessionRefused`
 * provides it, reading `/me` again so the shell goes to the sign-in page once the session is gone.
 */
export const API_UNAUTHORIZED = new InjectionToken<() => void>(
  'API_UNAUTHORIZED',
);

/** Sent with what the app asks while nobody uses the tab: it does not keep a session alive (#378). */
export const BACKGROUND_HEADER = 'X-Ccms-Background';

/** The JSON:API media type: `Accept` on every call, `Content-Type` on every state-changing one. */
export const JSON_API = 'application/vnd.api+json';

/**
 * Sent with an upload (`multipart/form-data`), which a cross-site form could send too: the API
 * refuses such a request without it (`stateChangeInterceptor`).
 */
export const REQUEST_HEADER = 'X-Ccms-Request';
