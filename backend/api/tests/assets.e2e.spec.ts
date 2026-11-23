import { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { PNG, PNG_HASH } from '@openfolia/content-repo/testing';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { FakeBlobStore } from './fakes/fake-blob-store.js';
import { createTestApp, type TestApp } from './test-app.js';

/** `GET /assets/:sha256` when the blob store fails (the rest: api.e2e.spec.ts). */
describe('assets from a failing store', () => {
  /** Holds the image, but its stream breaks at once. */
  class BrokenStream extends FakeBlobStore {
    override async get(sha256: string) {
      const blob = await super.get(sha256);
      return (
        blob && {
          ...blob,
          stream: new Readable({
            read() {
              this.destroy(new Error('connection reset'));
            },
          }),
        }
      );
    }
  }

  // The app starts in the hook, under the hook timeout, not the test's.
  let broken: TestApp;
  beforeAll(async () => {
    const blobs = new BrokenStream();
    await blobs.put(Readable.from([PNG]), {
      contentType: 'image/png',
      maxBytes: 10_000,
    });
    broken = await createTestApp({}, { blobs });
  });
  afterAll(() => broken?.close());

  it('answers 503, never cacheable, when the store fails before the first byte', async () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      const res = await broken.get(`/assets/${PNG_HASH}`);
      expect(res.status).toBe(503);
      expect(res.headers['content-type']).toBe(JSON_API);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe(
        'blob-store-unavailable',
      );
    } finally {
      error.mockRestore();
    }
  });
});
