import { describe, expect, it } from 'vitest';
import { FakeBlobStore } from '../../../tests/fakes/fake-blob-store.js';
import { Sandbox } from '../../sandbox/core/sandbox.js';
import { SandboxBlobStore } from './sandbox-blob-store.js';

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield new TextEncoder().encode(part);
}

const sandbox = () =>
  Sandbox.on({
    limits: {
      moduleBytes: 1_000,
      commentLength: 10,
      changeSets: 5,
      modules: 5,
      manuals: 5,
      releasesPerHour: 5,
      renderJobs: 1,
      writeBytes: 10,
    },
    lifetime: { idleMinutes: 30, maxMinutes: 90 },
  });

describe('SandboxBlobStore (#826)', () => {
  it('spends every byte put; past the budget the put fails and stores nothing', async () => {
    const box = sandbox();
    const inner = new FakeBlobStore();
    const store = new SandboxBlobStore(inner, box);
    const options = { contentType: 'application/pdf', maxBytes: 1_000 };
    const put = await store.put(chunks('abc', 'def'), options);
    expect(box.status()?.writtenBytes).toBe(6);
    expect(await store.head(put.sha256)).toBeDefined();
    await expect(
      store.put(chunks('ghi', 'jkl'), options),
    ).rejects.toMatchObject({
      code: 'sandbox-limit-reached',
      meta: { limit: 'writeBytes', max: 10 },
    });
    expect(inner.blobs.size).toBe(1);
  });
});
