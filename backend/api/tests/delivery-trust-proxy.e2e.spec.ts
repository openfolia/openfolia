import {
  anonymous,
  appWith,
  expectLimited,
  PAGE,
} from './delivery-addresses.js';
import type { TestApp } from './test-app.js';

// Cuts a release.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe('the rate limit on /d/ behind a trusted proxy (#574)', () => {
  let t: TestApp;
  beforeAll(async () => {
    // The test client connects from the loopback address: the proxy in front.
    t = await appWith({
      CCMS_DELIVERY_PER_MINUTE: '2',
      CCMS_TRUST_PROXY: 'loopback',
    });
  });
  afterAll(() => t?.close());

  it('limits the clients behind it one by one', async () => {
    expect((await anonymous(t, PAGE, '203.0.113.1')).status).toBe(200);
    expect((await anonymous(t, `${PAGE}/qr.png`, '203.0.113.1')).status).toBe(
      200,
    );
    expectLimited(await anonymous(t, PAGE, '203.0.113.1'));
    // What the proxy appended wins over what the client sent before it.
    expectLimited(await anonymous(t, PAGE, '198.51.100.9, 203.0.113.1'));
    // Another client behind the same proxy has its own budget, and so has the proxy itself.
    expect((await anonymous(t, PAGE, '203.0.113.2')).status).toBe(200);
    expect((await anonymous(t, PAGE)).status).toBe(200);
  });

  it('counts no revalidation of a page', async () => {
    const first = await anonymous(t, PAGE, '203.0.113.5');
    expect(first.status).toBe(200);
    const etag = first.headers['etag'] as string;
    for (let i = 0; i < 4; i++) {
      const again = await anonymous(t, PAGE, '203.0.113.5').set(
        'If-None-Match',
        etag,
      );
      expect(again.status).toBe(304);
    }
    expect((await anonymous(t, PAGE, '203.0.113.5')).status).toBe(200);
    expectLimited(await anonymous(t, PAGE, '203.0.113.5'));
  });
});
