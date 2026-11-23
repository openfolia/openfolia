import { get, INTERNAL, PAGE, publicApp, seen } from './public-addresses.js';
import { TOKEN, type TestApp } from './test-app.js';

/**
 * A `public` stable address answers as the public reader, always (#608): a session, a token or
 * `X-Ccms-User` that comes with the request changes nothing, neither the body nor the caching.
 * A `signed-in` address still reads as the person (`sign-in.e2e.spec.ts`).
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe('a public address answers as the public (#608)', () => {
  let t: TestApp;
  let cookie: string;
  beforeAll(async () => {
    ({ t, cookie } = await publicApp({
      CCMS_PASSWORD_SIGN_IN: 'on',
      CCMS_AUTH_FAILURES_MAX: '5',
    }));
  });
  afterAll(() => t?.close());

  it('answers a session, a token and anyone alike', async () => {
    for (const path of [PAGE, `${PAGE}/qr.svg`, '/d/-/page.css']) {
      const anyone = seen(await get(t, path));
      expect(anyone.status).toBe(200);
      expect(anyone.cacheControl).toMatch(/^public\b/);
      expect(anyone.vary ?? '').not.toMatch(
        /Cookie|Authorization|X-Ccms-User/i,
      );
      expect(seen(await get(t, path).set('Cookie', cookie))).toEqual(anyone);
      expect(
        seen(await get(t, path).set('Authorization', `Bearer ${TOKEN}`)),
      ).toEqual(anyone);
    }
  });

  it('shows a signed-in person nothing the public may not read', async () => {
    expect((await get(t, INTERNAL)).status).toBe(404);
    expect((await get(t, INTERNAL).set('Cookie', cookie)).status).toBe(404);
    expect(
      (await get(t, INTERNAL).set('Authorization', `Bearer ${TOKEN}`)).status,
    ).toBe(404);
  });

  it('ignores credentials that would not authenticate: nothing refused, nothing counted', async () => {
    const anyone = seen(await get(t, PAGE));
    for (let i = 0; i < 12; i++) {
      const res = await get(t, PAGE).set('Authorization', 'Bearer wrong');
      expect(seen(res)).toEqual(anyone);
    }
    expect(seen(await get(t, PAGE).set('X-Ccms-User', 'pat'))).toEqual(anyone);
    // Nothing was counted against this address: a wrong token elsewhere is a 401, not a 429
    // (locked out past 5 failures), and a valid one still acts.
    const elsewhere = await t
      .anonymous()
      .get('/me')
      .set('Authorization', 'Bearer wrong');
    expect(elsewhere.status).toBe(401);
    expect((await t.get('/me')).status).toBe(200);
  });
});
