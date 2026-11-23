import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * The client address's limit on password requests (#610), under requests at once: counted
 * before anything is awaited, so a burst from one address cannot all pass it. Its own file:
 * the settings are read once per file.
 */
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({
    CCMS_PASSWORD_SIGN_IN: 'on',
    CCMS_AUTH_FAILURES_MAX: '3',
    // "Forgot password" offered (nothing is sent: the jobs never run here).
    CCMS_MAIL_URL: 'smtp://127.0.0.1:2525',
    CCMS_MAIL_FROM: 'docs@example.com',
    CCMS_PUBLIC_URL: 'https://docs.example.com/',
  });
});
afterAll(() => t?.close());

const post = (path: string, attributes: Record<string, string>, type: string) =>
  t
    .anonymous()
    .post(path)
    .set('Content-Type', JSON_API)
    .send(JSON.stringify({ data: { type, attributes } }));

describe('the client address limit on password requests (#610)', () => {
  it('lets at most the limit through from a burst across many addresses', async () => {
    const answers = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        post(
          '/auth/password/forgot',
          { email: `someone-${i}@example.org` },
          'PasswordReset',
        ),
      ),
    );
    const statuses = answers.map((a) => a.status).sort();
    expect(statuses).toEqual([202, 202, 202, 429, 429, 429, 429, 429]);
    const refused = answers.find((a) => a.status === 429);
    expect(ErrorDocument.parse(refused?.body).errors[0]?.code).toBe(
      'too-many-failed-attempts',
    );

    const signIns = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        post(
          '/auth/password/sign-in',
          { email: `other-${i}@example.org`, password: 'a wrong guess here' },
          'PasswordSignIn',
        ),
      ),
    );
    const counts = signIns.map((a) => a.status).sort();
    expect(counts.filter((s) => s === 401).length).toBeLessThanOrEqual(3);
    expect(counts.filter((s) => s === 429).length).toBeGreaterThanOrEqual(3);
  });
});
