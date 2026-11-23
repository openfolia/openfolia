import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { crossSiteRefusal } from './proxy-origin.mjs';

const req = (headers) => ({ headers: { host: 'localhost:4200', ...headers } });

describe("the dev proxy's origin check", () => {
  it('passes a request without Origin, and one from the dev server itself', () => {
    assert.equal(crossSiteRefusal(req({})), undefined);
    assert.equal(
      crossSiteRefusal(req({ origin: 'http://localhost:4200' })),
      undefined,
    );
  });

  it('refuses another site, another port, null and anything that is no origin', () => {
    for (const origin of [
      'https://evil.example',
      'http://localhost:4201',
      'http://localhost',
      'null',
      'file://',
      '',
    ]) {
      const refusal = crossSiteRefusal(req({ origin }));
      assert.equal(refusal?.errors[0]?.code, 'cross-origin-request', origin);
      assert.equal(refusal?.errors[0]?.status, '403');
    }
  });

  it('refuses an Origin sent twice', () => {
    const refusal = crossSiteRefusal(
      req({ origin: ['http://localhost:4200', 'https://evil.example'] }),
    );
    assert.equal(refusal?.errors[0]?.code, 'cross-origin-request');
  });

  it('refuses when the request names no host', () => {
    const refusal = crossSiteRefusal({
      headers: { origin: 'http://localhost:4200' },
    });
    assert.equal(refusal?.errors[0]?.code, 'cross-origin-request');
  });
});
