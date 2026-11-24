// The launcher test's visitors (deploy/launcher-test.sh): run in the launcher container's network
// namespace, as `node --input-type=module - < launcher-client.mjs`, with LAUNCHER_URL, the
// launcher's public URL (http://localhost:<port>). Two visitors each start a sandbox and reach it;
// one without a cookie gets the start page. Prints the two cookies as one JSON line.
const base = process.env.LAUNCHER_URL.replace(/\/$/, '');
const origin = new URL(base).origin;
const check = (ok, what) => {
  if (!ok) throw new Error(`launcher-client: ${what}`);
  console.error(`ok - ${what}`);
};

async function call(path, { cookie, method = 'GET', body } = {}) {
  const headers = { accept: 'text/html,application/json' };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers.origin = origin;
    headers['sec-fetch-site'] = 'same-origin';
  }
  return fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
}

/** The start page's work: a challenge, its proof (bits 0 here), the start; the cookie set. */
async function start(lang) {
  const began = Date.now();
  const challenge = await (
    await call('/_demo/api/challenge', { method: 'POST', body: {} })
  ).json();
  check(typeof challenge.challenge === 'string', `a challenge (${lang})`);
  const res = await call('/_demo/api/start', {
    method: 'POST',
    body: { challenge: challenge.challenge, nonce: '0', lang },
  });
  check(
    res.status === 201,
    `a sandbox started (${lang}): ${res.status} ${await res.clone().text()}`,
  );
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0];
  check(
    /^__Host-openfolia-demo=[A-Za-z0-9_-]{43}$/.test(cookie),
    'the cookie is a random key',
  );
  check(
    /HttpOnly/.test(setCookie) &&
      /Secure/.test(setCookie) &&
      /SameSite=Strict/.test(setCookie),
    'the cookie is HttpOnly, Secure, SameSite=Strict',
  );
  const ms = Date.now() - began;
  check(ms < 10_000, `ready in ${ms} ms (under 10 s)`);
  return cookie;
}

/** The API as the editor's page asks it (its origin, so the sandbox's proxy adds its token). */
async function api(path, cookie) {
  return fetch(`${base}/api${path}`, {
    headers: {
      cookie,
      origin,
      accept: 'application/vnd.api+json',
      'x-ccms-user': 'demo-author',
    },
    redirect: 'manual',
  });
}

const a = await start('en');
const b = await start('de');
const editor = await call('/', { cookie: a });
check(
  editor.status === 200 && (await editor.text()).includes('<of-root'),
  "the editor at / with the visitor's cookie",
);
for (const [cookie, who] of [
  [a, 'first'],
  [b, 'second'],
]) {
  const res = await api('/sandbox', cookie);
  check(
    res.status === 200,
    `the ${who} visitor's GET /api/sandbox through the launcher: ${res.status}`,
  );
}

const nobody = await call('/modules/en/x');
check(
  nobody.status === 303 && nobody.headers.get('location') === '/',
  'a sandbox address without the cookie: to the start page',
);
const page = await call('/');
check(
  page.status === 200 && (await page.text()).includes('data-start-form'),
  'the start page without a cookie',
);
const proxied = await call('/', { cookie: a });
check(
  proxied.headers.get('cache-control')?.startsWith('private') ?? false,
  'proxied answers are private',
);
check(
  /Cookie/.test(proxied.headers.get('vary') ?? ''),
  'proxied answers vary by cookie',
);

console.log(JSON.stringify({ a, b }));
