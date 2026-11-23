import { FakeAssetReferenceStore } from '../../../../tests/fakes/fake-asset-reference-store.js';
import { AssetReferenceIndex } from '../asset-reference-index.js';
import { createHash } from 'node:crypto';
import type { Module } from '@openfolia/content-model';
import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeAssetRenditions } from '../../../../tests/fakes/fake-asset-renditions.js';
import { FakeArchivedFiles } from '../../../../tests/fakes/fake-archived-files.js';
import { FakeHeldBlobs } from '../../../../tests/fakes/fake-held-blobs.js';
import { FakeAssetUploads } from '../../../../tests/fakes/fake-asset-uploads.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeBlobStore } from '../../../../tests/fakes/fake-blob-store.js';
import { FakeChangeSetStore } from '../../../../tests/fakes/fake-change-set-store.js';
import { FakeSnapshot, module } from '../../../../tests/fakes/fake-content.js';
import { FakeRepository } from '../../../../tests/fakes/fake-repository.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { FakeWorkingCopyStore } from '../../../../tests/fakes/fake-working-copy-store.js';
import { fakeQuota } from '../../../../tests/fakes/fake-storage-usage.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../base/core/errors.js';
import { AssetInfoReader } from '../asset-info.js';
import { AssetReferences } from '../asset-references.js';
import { UNUSED_GRACE_MS } from '../unused.js';
import { DeleteAssetAction } from './delete-asset.action.js';

const editor = actorWith([
  'content.read',
  'content.read.draft',
  'content.edit',
]);
const sha256 = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
const DAY = UNUSED_GRACE_MS;

function setUp() {
  const blobs = new FakeBlobStore();
  const uploads = new FakeAssetUploads();
  const renditions = new FakeAssetRenditions();
  const auditLog = new FakeAuditLog();
  const mainModules: Module[] = [];
  const held = new FakeHeldBlobs();
  const archived = new FakeArchivedFiles();
  const { quota, usage } = fakeQuota();
  const repository = new FakeRepository(
    new FakeSnapshot({ modules: mainModules }),
  );
  const references = new AssetReferences(
    repository,
    new FakeChangeSetStore(),
    new FakeWorkingCopyStore(),
    uploads,
    held,
    new AssetReferenceIndex(repository, new FakeAssetReferenceStore()),
  );
  const action = new DeleteAssetAction(
    new FakeUnitOfWork(),
    uploads,
    renditions,
    references,
    blobs,
    new AssetInfoReader(blobs),
    auditLog,
    held,
    quota,
    archived,
  );
  const store = (text: string, storedAt = new Date(Date.now() - 2 * DAY)) => {
    const data = Buffer.from(text);
    blobs.blobs.set(sha256(data), { data, contentType: 'image/png', storedAt });
    return sha256(data);
  };
  return {
    action,
    blobs,
    uploads,
    renditions,
    auditLog,
    mainModules,
    store,
    held,
    archived,
    usage,
  };
}

const showing = (hash: string): Module => ({
  ...module('m', 'en'),
  blocks: [{ type: 'image', id: 'i', asset: `sha256:${hash}`, alt: 'x' }],
});

describe('DeleteAssetAction', () => {
  it('deletes an unused file with its renditions and upload records, audited', async () => {
    const { action, blobs, uploads, renditions, auditLog, store, usage } =
      setUp();
    const hash = store('old and unused');
    usage.totals = { ...usage.totals, media: { bytes: 100, files: 5 } };
    const small = store('its rendition');
    const old = new Date(Date.now() - 2 * DAY);
    uploads.uploads.push({
      changeSetId: 'c',
      sha256: hash,
      size: 14,
      contentType: 'image/png',
      uploadedBy: { kind: 'user', id: 'someone' },
      uploadedAt: old,
      lastUploadedAt: old,
    });
    renditions.renditions.push({
      sourceSha256: hash,
      width: 320,
      sha256: small,
      size: 13,
      createdAt: old,
    });
    await action.handle({ actor: editor, hash });
    expect(blobs.blobs.has(hash)).toBe(false);
    expect(blobs.blobs.has(small)).toBe(false);
    expect(uploads.uploads).toEqual([]);
    expect(renditions.renditions).toEqual([]);
    // Marked: a working copy naming it is refused from now on.
    expect(uploads.deleted).toEqual(new Set([hash]));
    expect(auditLog.events).toEqual([
      expect.objectContaining({
        action: 'asset.delete',
        subject: { type: 'asset', id: hash },
        data: {
          size: 14,
          contentType: 'image/png',
          uploads: 1,
          renditions: 1,
          fileKept: false,
        },
      }),
    ]);
    // Off the storage used (#404); a rendition never counted.
    expect(usage.totals.media).toEqual({ bytes: 86, files: 4 });
  });

  it.each(['pdf', 'bundle'] as const)(
    'keeps the bytes an archived release PDF or an import bundle (%s) shares, and the media totals, when its uploads are deleted (#404)',
    async (apart) => {
      const { action, blobs, uploads, auditLog, archived, store, usage } =
        setUp();
      const hash = store('a release file uploaded as an attachment');
      usage.apart.set(hash, apart);
      if (apart === 'pdf') archived.files.add(hash);
      usage.totals = {
        ...usage.totals,
        media: { bytes: 100, files: 5 },
        pdfs: { bytes: 41, files: 1 },
      };
      const old = new Date(Date.now() - 2 * DAY);
      uploads.uploads.push({
        changeSetId: 'c',
        sha256: hash,
        size: 41,
        contentType: 'application/pdf',
        uploadedBy: { kind: 'user', id: 'someone' },
        uploadedAt: old,
        lastUploadedAt: old,
      });
      await action.handle({ actor: editor, hash });
      expect(uploads.uploads).toEqual([]);
      // The archived file stays, counted as a PDF, never as media.
      expect(blobs.blobs.has(hash)).toBe(true);
      expect(usage.totals.media).toEqual({ bytes: 100, files: 5 });
      expect(usage.totals.pdfs).toEqual({ bytes: 41, files: 1 });
      // The audit says the file was kept (#429).
      expect(auditLog.events).toEqual([
        expect.objectContaining({
          action: 'asset.delete',
          data: expect.objectContaining({ uploads: 1, fileKept: true }),
        }),
      ]);
    },
  );

  it('refuses an archived release PDF no upload records, unaudited, also when found only under the lock (409, #429)', async () => {
    const { action, blobs, uploads, auditLog, archived, store, usage } =
      setUp();
    const hash = store('an archived release PDF');
    archived.files.add(hash);
    usage.apart.set(hash, 'pdf');
    usage.totals = {
      ...usage.totals,
      media: { bytes: 100, files: 5 },
      pdfs: { bytes: 22, files: 1 },
    };
    await expect(action.handle({ actor: editor, hash })).rejects.toMatchObject({
      code: 'asset-in-use',
      meta: { usedIn: [{ in: 'release-output' }] },
    });
    // Archived after the first look: the step under the hash's lock sees it.
    archived.files.delete(hash);
    const places = vi.spyOn(
      (action as unknown as { references: AssetReferences }).references,
      'placesOf',
    );
    places.mockImplementationOnce(async () => new Map());
    places.mockImplementationOnce(async () => {
      archived.files.add(hash);
      return new Map();
    });
    await expect(action.handle({ actor: editor, hash })).rejects.toMatchObject({
      code: 'asset-in-use',
      meta: { usedIn: [{ in: 'release-output' }] },
    });
    expect(blobs.blobs.has(hash)).toBe(true);
    expect(uploads.deleted.size).toBe(0);
    expect(auditLog.events).toEqual([]);
    expect(usage.totals.media).toEqual({ bytes: 100, files: 5 });
    expect(usage.totals.pdfs).toEqual({ bytes: 22, files: 1 });
  });

  it('refuses a file content refers to, naming where (409)', async () => {
    const { action, blobs, mainModules, store } = setUp();
    const hash = store('used in main');
    mainModules.push(showing(hash));
    const refused = await action
      .handle({ actor: editor, hash })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConflictError);
    expect(refused).toMatchObject({
      code: 'asset-in-use',
      meta: { usedIn: [{ in: 'main', ref: 'main' }] },
    });
    expect(blobs.blobs.has(hash)).toBe(true);
  });

  it('refuses an image uploaded for the branding (409), also when found only under the lock', async () => {
    const { action, blobs, held, store } = setUp();
    const hash = store('a logo');
    held.branding.add(hash);
    await expect(action.handle({ actor: editor, hash })).rejects.toMatchObject({
      code: 'asset-in-use',
      meta: { usedIn: [{ in: 'branding' }] },
    });
    held.branding.delete(hash);
    const places = vi.spyOn(
      (action as unknown as { references: AssetReferences }).references,
      'placesOf',
    );
    places.mockImplementationOnce(async () => new Map());
    places.mockImplementationOnce(async () => {
      held.branding.add(hash);
      return new Map();
    });
    await expect(action.handle({ actor: editor, hash })).rejects.toMatchObject({
      code: 'asset-in-use',
      meta: { usedIn: [{ in: 'branding' }] },
    });
    expect(blobs.blobs.has(hash)).toBe(true);
  });

  it('refuses a kept import’s uploaded bundle, also one recorded after its last look (409)', async () => {
    const { action, blobs, uploads, held, store } = setUp();
    const hash = store('an import’s bundle');
    held.hashes.add(hash);
    await expect(action.handle({ actor: editor, hash })).rejects.toMatchObject({
      code: 'asset-in-use',
      meta: { usedIn: [{ in: 'import' }] },
    });
    // Recorded after where it is used was read for the last time: the step under
    // the hash's lock still sees it.
    held.hashes.delete(hash);
    const places = vi.spyOn(
      (action as unknown as { references: AssetReferences }).references,
      'placesOf',
    );
    places.mockImplementationOnce(async () => new Map());
    places.mockImplementationOnce(async () => {
      held.hashes.add(hash);
      return new Map();
    });
    await expect(action.handle({ actor: editor, hash })).rejects.toMatchObject({
      code: 'asset-in-use',
      meta: { usedIn: [{ in: 'import' }] },
    });
    expect(blobs.blobs.has(hash)).toBe(true);
    expect(uploads.deleted.size).toBe(0);
  });

  it('marks the file before its last check, and clears the mark when that finds a use', async () => {
    const { action, blobs, uploads, mainModules, store } = setUp();
    const hash = store('used once the mark is in');
    // The first look finds nothing; a use appears before the second.
    const places = vi.spyOn(
      (action as unknown as { references: AssetReferences }).references,
      'placesOf',
    );
    places.mockImplementationOnce(async () => new Map());
    places.mockImplementationOnce(async () => {
      expect(uploads.deleted.has(hash)).toBe(true);
      mainModules.push(showing(hash));
      return new Map([[hash, [{ in: 'working-copy' }]]]);
    });
    await expect(action.handle({ actor: editor, hash })).rejects.toMatchObject({
      code: 'asset-in-use',
      meta: { usedIn: [{ in: 'working-copy' }] },
    });
    expect(uploads.deleted.size).toBe(0);
    expect(blobs.blobs.has(hash)).toBe(true);
  });

  it('clears the mark and keeps the records when the last step fails', async () => {
    const { action, blobs, uploads, auditLog, store } = setUp();
    const hash = store('the store fails');
    const old = new Date(Date.now() - 2 * DAY);
    uploads.uploads.push({
      changeSetId: 'c',
      sha256: hash,
      size: 15,
      contentType: 'image/png',
      uploadedBy: { kind: 'user', id: 'someone' },
      uploadedAt: old,
      lastUploadedAt: old,
    });
    vi.spyOn(blobs, 'delete').mockRejectedValueOnce(new Error('store down'));
    await expect(action.handle({ actor: editor, hash })).rejects.toThrow(
      'store down',
    );
    // The file is whole and usable: a working copy naming it saves.
    expect(blobs.blobs.has(hash)).toBe(true);
    expect(uploads.uploads).toHaveLength(1);
    expect(uploads.deleted.size).toBe(0);
    expect(auditLog.events).toEqual([]);
  });

  it('refuses a file uploaded or stored within the grace period, and a rendition', async () => {
    const { action, renditions, store } = setUp();
    const fresh = store('fresh', new Date());
    await expect(
      action.handle({ actor: editor, hash: fresh }),
    ).rejects.toMatchObject({
      code: 'asset-in-use',
      meta: {
        usedIn: [{ in: 'recent-upload' }],
        deletableAt: expect.any(String),
      },
    });
    const small = store('a rendition');
    renditions.renditions.push({
      sourceSha256: 'a'.repeat(64),
      width: 640,
      sha256: small,
      size: 1,
      createdAt: new Date(),
    });
    await expect(
      action.handle({ actor: editor, hash: small }),
    ).rejects.toMatchObject({
      code: 'asset-in-use',
      meta: { usedIn: [{ in: 'rendition' }] },
    });
  });

  it('keeps a rendition blob another source shares', async () => {
    const { action, blobs, renditions, store } = setUp();
    const a = store('source a');
    const b = store('source b');
    const shared = store('the same rendition');
    for (const source of [a, b]) {
      renditions.renditions.push({
        sourceSha256: source,
        width: 320,
        sha256: shared,
        size: 1,
        createdAt: new Date(),
      });
    }
    await action.handle({ actor: editor, hash: a });
    expect(blobs.blobs.has(a)).toBe(false);
    expect(blobs.blobs.has(shared)).toBe(true);
  });

  it('keeps a rendition blob content mentions, and one recorded after its last look', async () => {
    const { action, blobs, renditions, mainModules, store } = setUp();
    const source = store('a source');
    const mentioned = store('a rendition content mentions');
    const late = store('a rendition recorded late');
    const rendition = (sha256: string, width: 320 | 640) =>
      renditions.renditions.push({
        sourceSha256: source,
        width,
        sha256,
        size: 1,
        createdAt: new Date(),
      });
    rendition(mentioned, 320);
    mainModules.push(showing(mentioned));
    const placesOf = vi.spyOn(
      (action as unknown as { references: AssetReferences }).references,
      'placesOf',
    );
    let looks = 0;
    const read = AssetReferences.prototype.placesOf;
    placesOf.mockImplementation(async function (this: AssetReferences, hashes) {
      const found = await read.call(this, hashes);
      // After the last look, before the delete: not among what it read.
      if (++looks === 2) rendition(late, 640);
      return found;
    });
    await action.handle({ actor: editor, hash: source });
    expect(looks).toBe(2);
    expect(blobs.blobs.has(source)).toBe(false);
    expect(blobs.blobs.has(mentioned)).toBe(true);
    expect(blobs.blobs.has(late)).toBe(true);
    expect(renditions.renditions).toEqual([]);
  });

  it('keeps a rendition blob a done release output, an import or the branding took on after its last look (#602)', async () => {
    const { action, blobs, uploads, renditions, held, archived, store } =
      setUp();
    const source = store('a source');
    const pdf = store('a rendition a release output records');
    const bundle = store('a rendition an import holds');
    const brand = store('a rendition the branding holds');
    for (const [sha256, width] of [
      [pdf, 320],
      [bundle, 640],
      [brand, 1280],
    ] as const) {
      renditions.renditions.push({
        sourceSha256: source,
        width,
        sha256,
        size: 1,
        createdAt: new Date(),
      });
    }
    const placesOf = vi.spyOn(
      (action as unknown as { references: AssetReferences }).references,
      'placesOf',
    );
    let looks = 0;
    const read = AssetReferences.prototype.placesOf;
    placesOf.mockImplementation(async function (this: AssetReferences, hashes) {
      const found = await read.call(this, hashes);
      // After the last look, before the delete: not among what it read.
      if (++looks === 2) {
        archived.files.add(pdf);
        held.hashes.add(bundle);
        held.branding.add(brand);
      }
      return found;
    });
    await action.handle({ actor: editor, hash: source });
    expect(looks).toBe(2);
    expect(blobs.blobs.has(source)).toBe(false);
    expect(blobs.blobs.has(pdf)).toBe(true);
    expect(blobs.blobs.has(bundle)).toBe(true);
    expect(blobs.blobs.has(brand)).toBe(true);
    // Each rendition's own hash lock is taken too, not only the source's.
    expect(uploads.lockedHashes).toEqual(
      expect.arrayContaining([...[source, pdf, bundle, brand].sort()]),
    );
  });

  it('is 404 for a file it has no trace of', async () => {
    const { action } = setUp();
    await expect(
      action.handle({ actor: editor, hash: 'f'.repeat(64) }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('needs content.read.draft and content.edit in a role whose scope restricts nothing', async () => {
    const { action, store, blobs } = setUp();
    const hash = store('unused');
    for (const actor of [
      actorWith(['content.read']),
      // A contributor: unused files include other people's draft uploads (#137).
      actorWith(['content.read', 'content.edit']),
      // Drafts read only in some languages, beside an unrestricted contributor role.
      {
        ...actorWith(['content.read', 'content.edit']),
        roles: [
          ...actorWith(['content.read', 'content.edit']).roles,
          ...actorWith(['content.read.draft'], { languages: ['de'] }).roles,
        ],
      },
      ...[
        { languages: ['en'] },
        { moduleTypes: ['concept'] },
        { maxAudience: 'public' },
        { facets: { region: ['north'] } },
      ].map((scope) =>
        actorWith(
          ['content.read', 'content.read.draft', 'content.edit'],
          scope,
        ),
      ),
    ]) {
      await expect(action.handle({ actor, hash })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    expect(blobs.blobs.has(hash)).toBe(true);
  });
});
