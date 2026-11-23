import { inject, Injector } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { type CanMatchFn, Router, type UrlTree } from '@angular/router';
import { filter, firstValueFrom } from 'rxjs';

import { MeService, type Presence } from '../permissions/me';

/** The sign-in page's path, outside the shell. */
export const SIGN_IN_PATH = 'sign-in';
/** The query parameter holding the address to go back to after signing in. */
export const RETURN_PARAM = 'returnUrl';

/**
 * The address to go back to after signing in: a path inside the editor (one `/`, not `//` or
 * `/\`, which a browser reads as another host), never the sign-in page itself; anything else is
 * the start page. The router only navigates within the app, so this is belt and braces.
 */
export function safeReturnUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return '/';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  const path = raw.split(/[?#]/, 1)[0] ?? '';
  if (path === `/${SIGN_IN_PATH}` || path.startsWith(`/${SIGN_IN_PATH}/`)) {
    return '/';
  }
  return raw;
}

/** The sign-in page, remembering `returnUrl` (when it is one worth going back to). */
export function signInTree(router: Router, returnUrl: string): UrlTree {
  const back = safeReturnUrl(returnUrl);
  return router.createUrlTree(
    [`/${SIGN_IN_PATH}`],
    back === '/' ? {} : { queryParams: { [RETURN_PARAM]: back } },
  );
}

/** Resolves once `GET /me` has answered (the app initializer usually has by now). */
async function known(): Promise<Presence> {
  const me = inject(MeService);
  const now = me.presence();
  if (now !== 'pending') return now;
  return firstValueFrom(
    toObservable(me.presence, { injector: inject(Injector) }).pipe(
      filter((presence) => presence !== 'pending'),
    ),
  );
}

/**
 * The shell's guard: it matches only once `GET /me` has answered, so the sections' own
 * permission checks see the person. Nobody signed in (the token's service, a refused identity)
 * goes to the sign-in page, remembering where they were going. A failed read still opens the
 * shell, which shows the failure with a retry.
 */
export const personActing: CanMatchFn = async () => {
  const router = inject(Router);
  const target = router.currentNavigation()?.extractedUrl;
  const presence = await known();
  if (presence !== 'nobody') return true;
  return signInTree(router, target ? router.serializeUrl(target) : '/');
};

/** The sign-in page's guard: a person already acting goes on to where they were going. */
export const nobodyActing: CanMatchFn = async () => {
  const router = inject(Router);
  const target = router.currentNavigation()?.extractedUrl;
  const presence = await known();
  if (presence !== 'person') return true;
  return router.parseUrl(
    safeReturnUrl(target?.queryParamMap.get(RETURN_PARAM)),
  );
};
