import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { actorWith, NOBODY } from '../../../../tests/fakes/actors.js';
import { FakeAssetUploads } from '../../../../tests/fakes/fake-asset-uploads.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeBlobStore } from '../../../../tests/fakes/fake-blob-store.js';
import { FakeBrandingStore } from '../../../../tests/fakes/fake-branding-store.js';
import { fakeQuota } from '../../../../tests/fakes/fake-storage-usage.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  UnprocessableProblems,
} from '../../../base/core/errors.js';
import { type BrandingImage, MAX_BRANDING_IMAGES } from '../branding.js';
import { GetBrandingAction } from './get-branding.action.js';
import { GetBrandingImageAction } from './get-branding-image.action.js';
import { UpdateBrandingAction } from './update-branding.action.js';
import { UploadBrandingImageAction } from './upload-branding-image.action.js';

const brander = { ...actorWith(['admin.branding']), id: 'brander' };

async function* bytesOf(...chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  yield* chunks;
}

const png = (width: number, height = width) =>
  sharp({ create: { width, height, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();

function setup({ limitBytes = null }: { limitBytes?: number | null } = {}) {
  const store = new FakeBrandingStore();
  const blobs = new FakeBlobStore();
  const audit = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const uploads = new FakeAssetUploads();
  const { quota, usage } = fakeQuota({ limitBytes, auditLog: audit, unit });
  return {
    store,
    blobs,
    audit,
    unit,
    uploads,
    usage,
    get: new GetBrandingAction(store),
    image: new GetBrandingImageAction(store, blobs),
    update: new UpdateBrandingAction(store, audit, unit),
    upload: new UploadBrandingImageAction(
      store,
      blobs,
      audit,
      unit,
      uploads,
      quota,
    ),
  };
}

/** `still` with an animation control chunk (`acTL`, two frames) after its header: an APNG. */
function animatedPng(still: Buffer): Buffer {
  const data = Buffer.alloc(8);
  data.writeUInt32BE(2, 0);
  const type = Buffer.from('acTL', 'latin1');
  const chunk = Buffer.alloc(20);
  chunk.writeUInt32BE(8, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 16);
  // After the signature (8 bytes) and the IHDR chunk (25 bytes).
  return Buffer.concat([still.subarray(0, 33), chunk, still.subarray(33)]);
}

const image = (sha256: string, width = 32, height = width): BrandingImage => ({
  sha256,
  contentType: 'image/png',
  size: 100,
  width,
  height,
  uploadedBy: { kind: 'user', id: 'brander' },
  uploadedAt: new Date(0),
});

describe('GetBrandingAction', () => {
  it('answers the defaults, no tokens, before any change', async () => {
    const { get } = setup();
    const view = await get.handle();
    expect(view.version).toBe(0);
    expect(view.branding.primary).toBeNull();
    expect(view.derived.tokens).toBeNull();
  });
});

describe('UpdateBrandingAction', () => {
  it('needs admin.branding', async () => {
    const { update, store } = setup();
    for (const actor of [NOBODY, actorWith(['admin.roles'])]) {
      await expect(
        update.handle({ actor, changes: { productName: 'X' } }),
      ).rejects.toThrow(ForbiddenError);
    }
    expect(store.locks).toBe(0);
  });

  it('changes the fields given, under the lock, and audits each from and to', async () => {
    const { update, store, audit } = setup();
    store.images.set('a'.repeat(64), image('a'.repeat(64)));
    const view = await update.handle({
      actor: brander,
      changes: {
        productName: 'Docs',
        favicon: 'a'.repeat(64),
        primary: '#1d4ed8',
      },
    });
    expect(store.locks).toBe(1);
    expect(view.version).toBe(1);
    expect(store.stored.branding).toMatchObject({
      productName: 'Docs',
      favicon: 'a'.repeat(64),
      primary: '#1d4ed8',
      accent: null,
    });
    expect(view.derived.tokens?.light.primary).toBe('#1d4ed8');
    expect(audit.events).toEqual([
      expect.objectContaining({
        action: 'branding.update',
        actor: { kind: 'user', id: 'brander' },
        subject: { type: 'branding', id: 'branding' },
        data: {
          changed: {
            productName: { from: null, to: 'Docs' },
            favicon: { from: null, to: 'a'.repeat(64) },
            primary: { from: null, to: '#1d4ed8' },
          },
        },
      }),
    ]);
  });

  it('writes and audits nothing when nothing changes', async () => {
    const { update, audit, store } = setup();
    const view = await update.handle({
      actor: brander,
      changes: { productName: null },
    });
    expect(view.version).toBe(0);
    expect(audit.events).toEqual([]);
    expect(store.stored.version).toBe(0);
  });

  it('refuses a colour pair below its contrast, naming each, and writes nothing', async () => {
    const { update, store, audit } = setup();
    const refused = await update
      .handle({ actor: brander, changes: { primary: '#ffff00' } })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(UnprocessableProblems);
    const problems = (refused as UnprocessableProblems).problems;
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((p) => p.code === 'insufficient-contrast')).toBe(
      true,
    );
    expect(problems[0]).toMatchObject({
      pointer: '/data/attributes/primary',
      meta: { theme: 'light', pair: 'primary/background', required: 4.5 },
    });
    expect(store.stored.version).toBe(0);
    expect(audit.events).toEqual([]);
  });

  it('refuses an image hash never uploaded and a favicon or app icon that is not square', async () => {
    const { update, store } = setup();
    store.images.set('c'.repeat(64), image('c'.repeat(64), 64, 32));
    const refused = (await update
      .handle({
        actor: brander,
        changes: {
          mark: 'd'.repeat(64),
          favicon: 'c'.repeat(64),
          appIcon: 'c'.repeat(64),
          // A wide logo is fine.
          logoLight: 'c'.repeat(64),
        },
      })
      .catch((e: unknown) => e)) as UnprocessableProblems;
    expect(refused.problems.map((p) => [p.code, p.pointer])).toEqual([
      ['unknown-image', '/data/attributes/mark'],
      ['image-not-square', '/data/attributes/favicon'],
      ['image-not-square', '/data/attributes/appIcon'],
    ]);
  });
});

describe('UploadBrandingImageAction', () => {
  it('needs admin.branding, and reads nothing before', async () => {
    const { upload } = setup();
    const file = vi.fn(() => bytesOf());
    await expect(upload.handle({ actor: NOBODY, file })).rejects.toThrow(
      ForbiddenError,
    );
    expect(file).not.toHaveBeenCalled();
  });

  it('stores a PNG, records its size and audits it once', async () => {
    const { upload, blobs, audit, store } = setup();
    const bytes = await png(48, 24);
    const first = await upload.handle({
      actor: brander,
      file: () => bytesOf(bytes),
    });
    expect(first.created).toBe(true);
    expect(first.image).toMatchObject({
      contentType: 'image/png',
      width: 48,
      height: 24,
      size: bytes.byteLength,
    });
    expect(blobs.blobs.get(first.image.sha256)?.contentType).toBe('image/png');
    const again = await upload.handle({
      actor: brander,
      file: () => bytesOf(bytes),
    });
    // The same record, its upload time moved (#559).
    expect(again).toEqual({
      image: { ...first.image, uploadedAt: expect.any(Date) },
      created: false,
    });
    expect(audit.events.map((e) => e.action)).toEqual([
      'branding.image-upload',
    ]);
    expect(store.images.size).toBe(1);
  });

  it('refuses SVG and anything not PNG or WebP before storing a byte', async () => {
    const { upload, blobs } = setup();
    for (const bytes of [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      Buffer.from('GIF89a\x01\x00\x01\x00'),
      Buffer.from('plain text'),
    ]) {
      const refused = await upload
        .handle({ actor: brander, file: () => bytesOf(bytes) })
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(UnprocessableError);
      expect((refused as UnprocessableError).code).toBe(
        'unsupported-image-type',
      );
    }
    expect(blobs.created).toEqual([]);
  });

  it('stops reading past 1 MiB', async () => {
    const { upload, blobs } = setup();
    let read = 0;
    async function* endless(): AsyncGenerator<Uint8Array> {
      for (;;) {
        read++;
        yield new Uint8Array(256 * 1024);
      }
    }
    const refused = await upload
      .handle({ actor: brander, file: endless })
      .catch((e: unknown) => e);
    expect((refused as UnprocessableError).code).toBe('too-large');
    expect(read).toBe(5);
    expect(blobs.created).toEqual([]);
  });

  it('refuses an image larger than 4096 pixels a side', async () => {
    const { upload } = setup();
    const refused = await upload
      .handle({
        actor: brander,
        file: () => bytesOf(Buffer.from(pngHeader(5000, 10))),
      })
      .catch((e: unknown) => e);
    expect((refused as UnprocessableError).code).toBe('image-too-large');
  });

  it('records an image under its hash lock, and refuses one whose blob a clean-up removed meanwhile (#623)', async () => {
    const { upload, uploads, blobs, store, audit } = setup();
    const bytes = await png(20);
    // The same bytes stored already (`created: false`); a clean-up of them
    // (an asset upload that failed to record, say) removes them after the
    // put found them there, just before the record takes the hash lock.
    const lock = uploads.lockHash.bind(uploads);
    uploads.lockHash = async (tx, hash) => {
      blobs.blobs.delete(hash);
      return lock(tx, hash);
    };
    await expect(
      upload.handle({ actor: brander, file: () => bytesOf(bytes) }),
    ).rejects.toMatchObject({ code: 'upload-interrupted' });
    // The record's lock, then the clean-up's, which finds nothing to remove.
    expect(uploads.lockedHashes).toHaveLength(2);
    expect(store.images.size).toBe(0);
    expect(audit.events).toEqual([]);
    // Uploaded again: stored again, and recorded under the lock.
    uploads.lockHash = lock;
    const { image: recorded, created } = await upload.handle({
      actor: brander,
      file: () => bytesOf(bytes),
    });
    expect(created).toBe(true);
    expect(blobs.blobs.has(recorded.sha256)).toBe(true);
    expect(uploads.lockedHashes).toEqual([
      recorded.sha256,
      recorded.sha256,
      recorded.sha256,
    ]);
    expect(store.images.has(recorded.sha256)).toBe(true);
  });

  it('moves the upload time of an image uploaded again, so the sweep keeps it another day (#559)', async () => {
    const { upload, store } = setup();
    const bytes = await png(10);
    const { image: first } = await upload.handle({
      actor: brander,
      file: () => bytesOf(bytes),
    });
    store.images.set(first.sha256, { ...first, uploadedAt: new Date(0) });
    await upload.handle({ actor: brander, file: () => bytesOf(bytes) });
    expect(
      store.images.get(first.sha256)?.uploadedAt.getTime(),
    ).toBeGreaterThan(0);
  });

  it('refuses an animated PNG or WebP with animated-image, storing nothing (#559)', async () => {
    const { upload, blobs, store } = setup();
    const frame = (background: string) =>
      sharp({ create: { width: 8, height: 8, channels: 3, background } })
        .png()
        .toBuffer();
    const webp = await sharp([await frame('#f00'), await frame('#0f0')], {
      join: { animated: true },
    })
      .webp()
      .toBuffer();
    for (const bytes of [animatedPng(await png(8)), webp]) {
      const refused = await upload
        .handle({ actor: brander, file: () => bytesOf(bytes) })
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(UnprocessableError);
      expect((refused as UnprocessableError).code).toBe('animated-image');
    }
    expect(blobs.created).toEqual([]);
    expect(store.images.size).toBe(0);
    // A still WebP with an alpha channel (`VP8X`, no animation flag) is taken.
    const still = await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#f008' },
    })
      .webp()
      .toBuffer();
    await expect(
      upload.handle({ actor: brander, file: () => bytesOf(still) }),
    ).resolves.toMatchObject({ created: true });
  });

  it('refuses a PNG cut off before its end as no PNG (#559)', async () => {
    const { upload, blobs } = setup();
    const bytes = await png(16);
    const refused = await upload
      .handle({
        actor: brander,
        file: () => bytesOf(bytes.subarray(0, bytes.byteLength - 12)),
      })
      .catch((e: unknown) => e);
    expect((refused as UnprocessableError).code).toBe('unsupported-image-type');
    expect(blobs.created).toEqual([]);
  });

  it('counts a new image towards the storage used, once (#559)', async () => {
    const { upload, usage, uploads } = setup();
    const bytes = await png(20);
    await upload.handle({ actor: brander, file: () => bytesOf(bytes) });
    await upload.handle({ actor: brander, file: () => bytesOf(bytes) });
    expect(usage.totals.media).toEqual({ bytes: bytes.byteLength, files: 1 });
    // Bytes an asset upload recorded (and counted) already add nothing.
    const other = await png(24);
    const sha256 = createHash('sha256').update(other).digest('hex');
    uploads.uploads.push({
      changeSetId: '01900000-0000-7000-8000-000000000001',
      sha256,
      size: other.byteLength,
      contentType: 'image/png',
      uploadedBy: { kind: 'user', id: 'author' },
      uploadedAt: new Date(0),
      lastUploadedAt: new Date(0),
    });
    await upload.handle({ actor: brander, file: () => bytesOf(other) });
    expect(usage.totals.media).toEqual({ bytes: bytes.byteLength, files: 1 });
  });

  it('refuses an image past the storage limit, recording nothing, and audits the refusal (#559)', async () => {
    const small = await png(8);
    const { upload, usage, store, audit } = setup({
      limitBytes: small.byteLength + 10,
    });
    await upload.handle({ actor: brander, file: () => bytesOf(small) });
    const large = await png(64);
    const refused = await upload
      .handle({ actor: brander, file: () => bytesOf(large) })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConflictError);
    expect((refused as ConflictError).code).toBe('storage-limit-reached');
    expect(store.images.size).toBe(1);
    expect(usage.totals.media).toEqual({ bytes: small.byteLength, files: 1 });
    expect(audit.events.map((e) => [e.action, e.data])).toEqual([
      ['branding.image-upload', expect.anything()],
      [
        'storage.upload-refused',
        {
          target: 'branding',
          limit: small.byteLength + 10,
          used: small.byteLength,
        },
      ],
    ]);
  });

  it('refuses once the record is full, before reading', async () => {
    const { upload, store } = setup();
    // Uploaded within the day: they count.
    for (let i = 0; i < MAX_BRANDING_IMAGES; i++) {
      const hash = i.toString(16).padStart(64, '0');
      store.images.set(hash, { ...image(hash), uploadedAt: new Date() });
    }
    const file = vi.fn(() => bytesOf());
    const refused = await upload
      .handle({ actor: brander, file })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConflictError);
    expect((refused as ConflictError).code).toBe('too-many-uploads');
    expect(file).not.toHaveBeenCalled();
  });
});

describe('UploadBrandingImageAction: the cap (#559)', () => {
  const fill = (store: FakeBrandingStore, uploadedAt: (i: number) => Date) => {
    for (let i = 0; i < MAX_BRANDING_IMAGES; i++) {
      const hash = i.toString(16).padStart(64, '0');
      store.images.set(hash, { ...image(hash), uploadedAt: uploadedAt(i) });
    }
  };

  it('does not count unused images uploaded more than a day ago', async () => {
    const { upload, store } = setup();
    fill(store, () => new Date(0));
    const bytes = await png(12);
    await expect(
      upload.handle({ actor: brander, file: () => bytesOf(bytes) }),
    ).resolves.toMatchObject({ created: true });
    expect(store.images.size).toBe(MAX_BRANDING_IMAGES + 1);
  });

  it('counts an image a field names however old, and the recent ones', async () => {
    const { upload, store } = setup();
    // One old image in use, the others recent.
    fill(store, (i) => (i === 0 ? new Date(0) : new Date()));
    const oldest = '0'.padStart(64, '0');
    store.stored = {
      ...store.stored,
      branding: { ...store.stored.branding, mark: oldest },
    };
    const file = vi.fn(() => bytesOf());
    await expect(upload.handle({ actor: brander, file })).rejects.toMatchObject(
      { code: 'too-many-uploads' },
    );
    expect(file).not.toHaveBeenCalled();
    // A day later, the recent ones no longer count.
    upload.now = () => Date.now() + 2 * 24 * 60 * 60 * 1000;
    const bytes = await png(12);
    await expect(
      upload.handle({ actor: brander, file: () => bytesOf(bytes) }),
    ).resolves.toMatchObject({ created: true });
  });
});

describe('GetBrandingImageAction', () => {
  it('serves only an image a branding field names, as the type recorded', async () => {
    const { image: get, upload, update } = setup();
    const { image: uploaded } = await upload.handle({
      actor: brander,
      file: async function* () {
        yield await png(16);
      },
    });
    await expect(get.handle({ sha256: uploaded.sha256 })).rejects.toThrow(
      NotFoundError,
    );
    await update.handle({ actor: brander, changes: { mark: uploaded.sha256 } });
    const served = await get.handle({ sha256: uploaded.sha256 });
    expect(served?.contentType).toBe('image/png');
    served?.stream.destroy();
    // A reader holding the bytes: nothing read while it is in use, 404 once not.
    await expect(
      get.handle({ sha256: uploaded.sha256, cached: true }),
    ).resolves.toBeNull();
    await update.handle({ actor: brander, changes: { mark: null } });
    await expect(
      get.handle({ sha256: uploaded.sha256, cached: true }),
    ).rejects.toThrow(NotFoundError);
    await update.handle({ actor: brander, changes: { mark: uploaded.sha256 } });
    await expect(get.handle({ sha256: 'not a hash' })).rejects.toThrow(
      NotFoundError,
    );
    await expect(get.handle({ sha256: 'e'.repeat(64) })).rejects.toThrow(
      NotFoundError,
    );
  });
});

/** The first bytes of a PNG stating `width` × `height`: enough for the header checks. */
function pngHeader(width: number, height: number): Uint8Array {
  const data = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data, 0);
  data.writeUInt32BE(13, 8);
  data.write('IHDR', 12, 'latin1');
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}
