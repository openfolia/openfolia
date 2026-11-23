// Signs in through the mock provider without a browser (#37): follows the redirects from the
// API's sign-in route through the provider's sign-in page and back to the API's callback, with a
// cookie jar per origin, and answers the cookies the API set. For the API's tests.
//
// Imports only Node itself, never another file of this repository, so Node runs it as it is.

/** Cookies by origin, by name. */
export type CookieJar = Map<string, Map<string, string>>;

export interface SignInResult {
  /** Where the sign-in ended (the editor's address, with `?error=` on a refusal). */
  readonly finalUrl: string;
  readonly jar: CookieJar;
  /** The cookies of `origin` as a `Cookie` header. */
  cookieHeader(origin: string): string;
}

const MAX_STEPS = 20;

function remember(jar: CookieJar, url: URL, response: Response): void {
  const cookies = jar.get(url.origin) ?? new Map<string, string>();
  for (const line of response.headers.getSetCookie()) {
    const [pair = '', ...attributes] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const expired = attributes.some((a) => {
      const [key = '', v = ''] = a.split('=').map((s) => s.trim());
      return key.toLowerCase() === 'max-age' && Number(v) <= 0;
    });
    if (expired || value === '') cookies.delete(name);
    else cookies.set(name, value);
  }
  jar.set(url.origin, cookies);
}

function header(jar: CookieJar, origin: string): string {
  return [...(jar.get(origin) ?? new Map<string, string>())]
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

/**
 * Starts at `signInUrl` (the API's `GET /auth/<provider>/sign-in`, as the editor reaches it),
 * signs in on the mock's page as `login`, and follows the redirects until one leaves both the
 * provider and the API's `/auth/` routes (the editor). `jar` carries cookies in (e.g. a session
 * to replace) and out.
 */
export async function signInThroughMock({
  signInUrl,
  login,
  jar = new Map(),
}: {
  signInUrl: string;
  login: string;
  jar?: CookieJar;
}): Promise<SignInResult> {
  let url = new URL(signInUrl);
  let init: RequestInit = { method: 'GET' };
  for (let step = 0; step < MAX_STEPS; step++) {
    const headers = new Headers(init.headers);
    const cookie = header(jar, url.origin);
    if (cookie) headers.set('Cookie', cookie);
    const response = await fetch(url, { ...init, headers, redirect: 'manual' });
    remember(jar, url, response);
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, url);
      await response.body?.cancel();
      url = next;
      init = { method: 'GET' };
      continue;
    }
    const type = response.headers.get('content-type') ?? '';
    if (/^\/interaction\//.test(url.pathname) && type.includes('html')) {
      const html = await response.text();
      if (init.method === 'POST') {
        const alert = /<p role="alert">([^<]*)<\/p>/.exec(html)?.[1];
        throw new Error(
          `the mock provider refused "${login}": ${alert ?? response.status}`,
        );
      }
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ login }).toString(),
      };
      continue;
    }
    // An HTML page that posts itself (the provider's sign-out confirmation): not expected here.
    const finalUrl = url.href;
    await response.body?.cancel();
    return {
      finalUrl,
      jar,
      cookieHeader: (origin: string) => header(jar, origin),
    };
  }
  throw new Error(`no end after ${MAX_STEPS} redirects`);
}
