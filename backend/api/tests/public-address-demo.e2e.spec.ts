import { get, INTERNAL, PAGE, publicApp, seen } from './public-addresses.js';
import { TOKEN, type TestApp } from './test-app.js';

/** A `public` stable address in demo mode answers the user `X-Ccms-User` names as anyone (#608). */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe('a public address in demo mode (#608)', () => {
  let t: TestApp;
  beforeAll(async () => {
    ({ t } = await publicApp({ CCMS_AUTH_MODE: 'demo' }));
  });
  afterAll(() => t?.close());

  it('answers the user X-Ccms-User names as anyone', async () => {
    const anyone = seen(await get(t, PAGE));
    expect(anyone.status).toBe(200);
    const demo = await get(t, PAGE)
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('X-Ccms-User', 'pat');
    expect(seen(demo)).toEqual(anyone);
    expect(
      (
        await get(t, INTERNAL)
          .set('Authorization', `Bearer ${TOKEN}`)
          .set('X-Ccms-User', 'pat')
      ).status,
    ).toBe(404);
  });
});
