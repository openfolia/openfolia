import { SignInOptionsDocument } from '../src/access/api/password.resources.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { createTestApp, type TestApp } from './test-app.js';

/** Password sign-in off (#610). Its own file: the settings are read once per file. */
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ CCMS_PASSWORD_SIGN_IN: 'off' });
});
afterAll(() => t?.close());

const error = (body: unknown) => ErrorDocument.parse(body).errors[0];
const post = (path: string, body: unknown) =>
  t
    .anonymous()
    .post(path)
    .set('Content-Type', JSON_API)
    .send(JSON.stringify(body));

describe('password sign-in off (#610)', () => {
  it('offers neither the form nor "Forgot password"', async () => {
    const res = await t.anonymous().get('/auth/options').expect(200);
    expect(SignInOptionsDocument.parse(res.body).data.attributes).toEqual({
      password: false,
      passwordReset: false,
      emailCode: false,
      providers: 0,
    });
  });

  it('refuses signing in, setting a password and resets', async () => {
    const signIn = await post('/auth/password/sign-in', {
      data: {
        type: 'PasswordSignIn',
        attributes: {
          email: 'pat@example.org',
          password: 'a long and quiet river',
        },
      },
    });
    expect([signIn.status, error(signIn.body)?.code]).toEqual([
      409,
      'password-sign-in-off',
    ]);
    const set = await post('/auth/password/set', {
      data: {
        type: 'PasswordSet',
        attributes: {
          token: `ccms_pwl_${'0'.repeat(64)}`,
          password: 'a long and quiet river',
        },
      },
    });
    expect([set.status, error(set.body)?.code]).toEqual([
      409,
      'password-sign-in-off',
    ]);
    const forgot = await post('/auth/password/forgot', {
      data: { type: 'PasswordReset', attributes: { email: 'pat@example.org' } },
    });
    expect([forgot.status, error(forgot.body)?.code]).toEqual([
      404,
      'not-configured',
    ]);
  });
});
