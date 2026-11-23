import { READER } from './fakes/actors.js';
import {
  ADDRESS,
  anonymous,
  appWith,
  expectLimited,
  PAGE,
} from './delivery-addresses.js';
import type { TestApp } from './test-app.js';

// Cuts a release.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe('the rate limit on /d/ without a trusted proxy (#574)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await appWith({ CCMS_DELIVERY_PER_MINUTE: '3' });
  });
  afterAll(() => t?.close());
  afterEach(() => t?.actAs(undefined));

  it('keys on the socket’s address: a forged X-Forwarded-For changes nothing', async () => {
    for (const forged of ['203.0.113.1', '203.0.113.2', undefined]) {
      expect((await anonymous(t, PAGE, forged)).status).toBe(200);
    }
    expectLimited(await anonymous(t, PAGE, '203.0.113.3'));
    // One budget for the pages, PDFs and QR codes alike.
    expectLimited(await anonymous(t, `${PAGE}/qr.svg`, '203.0.113.4'));
    expectLimited(await anonymous(t, `${PAGE}/pdf`));
    // A page's stylesheets never count.
    expect((await anonymous(t, '/d/-/page.css')).status).toBe(200);
  });

  it('counts a token on a public address against the address, as anyone’s (#608)', async () => {
    t.actAs(READER);
    expectLimited(await t.get(PAGE).set('Accept', '*/*'));
  });

  it('documents the 429 on the routes it limits', async () => {
    const openapi = (await t.anonymous().get('/openapi.json')).body as {
      paths: Record<string, { get?: { responses: object } }>;
    };
    for (const path of [
      ADDRESS,
      `${ADDRESS}/pdf`,
      `${ADDRESS}/qr.svg`,
      `${ADDRESS}/qr.png`,
      `${ADDRESS}/pdf/qr.svg`,
      `${ADDRESS}/pdf/qr.png`,
    ]) {
      expect(Object.keys(openapi.paths[path]?.get?.responses ?? {})).toContain(
        '429',
      );
    }
  });
});
