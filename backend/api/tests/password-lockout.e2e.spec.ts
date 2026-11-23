import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Failed password sign-ins (#610) with a low limit per account (`CCMS_PASSWORD_FAILURES_MAX`),
 * apart from the client addresses' limit (off here, as behind a shared address). Its own file:
 * the settings are read once per file.
 */
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({
    CCMS_PASSWORD_SIGN_IN: 'on',
    CCMS_AUTH_FAILURES_MAX: '0',
    CCMS_PASSWORD_FAILURES_MAX: '3',
    // "Forgot password" offered (nothing is sent: the jobs never run here).
    CCMS_MAIL_URL: 'smtp://127.0.0.1:2525',
    CCMS_MAIL_FROM: 'docs@example.com',
    CCMS_PUBLIC_URL: 'https://docs.example.com/',
  });
});
afterAll(() => t?.close());

const error = (body: unknown) => ErrorDocument.parse(body).errors[0];
const attempt = (email: string, password: string) =>
  t
    .anonymous()
    .post('/auth/password/sign-in')
    .set('Content-Type', JSON_API)
    .send(
      JSON.stringify({
        data: { type: 'PasswordSignIn', attributes: { email, password } },
      }),
    );

describe('failed password sign-ins (#610)', () => {
  it('answer 429 with Retry-After past the account limit, whatever the password, for that account only', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await attempt('someone@example.org', `wrong guess ${i}`);
      expect([res.status, error(res.body)?.code]).toEqual([
        401,
        'invalid-credentials',
      ]);
    }
    const res = await attempt('someone@example.org', 'the right one perhaps');
    expect([res.status, error(res.body)?.code]).toEqual([
      429,
      'too-many-failed-attempts',
    ]);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    // Another account, from the same address, is still checked.
    const other = await attempt('another@example.org', 'wrong guess');
    expect([other.status, error(other.body)?.code]).toEqual([
      401,
      'invalid-credentials',
    ]);
  });

  it('keeps "Forgot password" and failed sign-ins apart: neither blocks the other, known or not', async () => {
    const forgot = (email: string) =>
      t
        .anonymous()
        .post('/auth/password/forgot')
        .set('Content-Type', JSON_API)
        .send(
          JSON.stringify({
            data: { type: 'PasswordReset', attributes: { email } },
          }),
        );
    // Whether anyone has the address changes nothing.
    for (const email of ['pat@example.org', 'unknown@example.org']) {
      for (let i = 0; i < 3; i++) {
        expect((await attempt(email, `wrong guess ${i}`)).status).toBe(401);
      }
      expect((await attempt(email, 'one more')).status).toBe(429);
      // Locked out of signing in, a reset can still be asked for, up to its own limit.
      for (let i = 0; i < 3; i++)
        expect((await forgot(email)).status).toBe(202);
      const res = await forgot(email);
      expect([res.status, error(res.body)?.code]).toEqual([
        429,
        'too-many-failed-attempts',
      ]);
    }
    // And the other way round: resets used up, signing in is still checked.
    for (let i = 0; i < 3; i++) {
      expect((await forgot('lee@example.org')).status).toBe(202);
    }
    expect((await forgot('lee@example.org')).status).toBe(429);
    expect((await attempt('lee@example.org', 'wrong guess')).status).toBe(401);
  });
});
