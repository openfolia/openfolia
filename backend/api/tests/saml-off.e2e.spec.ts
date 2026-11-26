import { IdentityProviderPageDocument } from '../src/access/api/sign-in.resources.js';
import { createTestApp, type TestApp } from './test-app.js';

/** SAML sign-in not set up (#376): nothing of it shows, and its routes are not there. */
describe('sign-in with SAML 2.0, not set up', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('offers no SAML button and answers its routes 404', async () => {
    const res = await t.anonymous().get('/auth/providers').expect(200);
    expect(IdentityProviderPageDocument.parse(res.body).data).toEqual([]);
    await t.anonymous().get('/auth/saml/sign-in').expect(404);
    await t.anonymous().get('/auth/saml/metadata').expect(404);
    await t
      .anonymous()
      .post('/auth/saml/callback')
      .type('form')
      .send({ SAMLResponse: 'x' })
      .expect(404);
  });
});
