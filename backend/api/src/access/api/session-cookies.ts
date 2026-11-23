import type { Request, Response } from 'express';

/**
 * The cookie holding a person's session (#37): `__Host-` (only from a
 * secure origin, no `Domain`, `Path=/`), `Secure`, `HttpOnly` (no script
 * reads it), `SameSite=Lax` (sent on the provider's redirect back, not with
 * a cross-site form). The working name in it is this one constant's (#372).
 */
export const SESSION_COOKIE = '__Host-openfolia-session';

/**
 * The cookie keeping a sign-in begun until the provider sends the browser
 * back: sealed (`SecretSealer`), for ten minutes, one sign-in. The working
 * name in it is this one constant's (#372).
 */
export const SIGN_IN_COOKIE = '__Host-openfolia-sign-in';

/** What a sign-in's sealed cookie is bound to (with the provider's ID). */
export const SIGN_IN_SEAL_CONTEXT = 'sign-in:v1';

/** How long a begun sign-in may take, in seconds. */
export const SIGN_IN_SECONDS = 600;

/** The value of the cookie `name` the request carries; undefined for none (or several). */
export function cookieOf(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  let found: string | undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    // Two of one name (one set by another path or host): trust neither.
    if (found !== undefined) return undefined;
    found = part.slice(eq + 1).trim();
  }
  return found === '' ? undefined : found;
}

const ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Lax';

/** Sets the cookie `name` (its value cookie-safe already) for `maxAgeSeconds`, or for the browser's session. */
export function setCookie(
  res: Response,
  name: string,
  value: string,
  maxAgeSeconds?: number,
): void {
  res.append(
    'Set-Cookie',
    `${name}=${value}; ${ATTRIBUTES}${maxAgeSeconds === undefined ? '' : `; Max-Age=${maxAgeSeconds}`}`,
  );
}

/** Removes the cookie `name` from the browser. */
export function clearCookie(res: Response, name: string): void {
  res.append('Set-Cookie', `${name}=; ${ATTRIBUTES}; Max-Age=0`);
}
