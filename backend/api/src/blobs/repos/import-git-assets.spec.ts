import { rmSync } from 'node:fs';
import { ContentRepo } from '@openfolia/content-repo';
import {
  createBareSampleRepo,
  PNG,
  PNG_HASH,
} from '@openfolia/content-repo/testing';
import { FakeBlobStore } from '../../../tests/fakes/fake-blob-store.js';
import { importGitAssets } from './import-git-assets.js';

describe('importGitAssets', () => {
  const sample = createBareSampleRepo();
  const repo = ContentRepo.open(sample.dir);
  afterAll(() => {
    repo.close();
    rmSync(sample.dir, { recursive: true, force: true });
  });

  it('puts every image under assets/ into the store once, with its sniffed type', async () => {
    const blobs = new FakeBlobStore();
    const report = await importGitAssets(repo, blobs);
    expect(report).toEqual({ imported: [PNG_HASH], skipped: [] });
    expect(await blobs.head(PNG_HASH)).toEqual({
      sha256: PNG_HASH,
      size: PNG.length,
      contentType: 'image/png',
      storedAt: expect.any(Date),
    });
    // Again: nothing changes.
    expect((await importGitAssets(repo, blobs)).imported).toEqual([PNG_HASH]);
    expect(blobs.blobs.size).toBe(1);
  });
});
