import { actorWith, NOBODY } from '../../../tests/fakes/actors.js';
import { FakeAssetUploads } from '../../../tests/fakes/fake-asset-uploads.js';
import { FakeAuditLog } from '../../../tests/fakes/fake-audit-log.js';
import { FakeBlobStore } from '../../../tests/fakes/fake-blob-store.js';
import { FakeBrandingStore } from '../../../tests/fakes/fake-branding-store.js';
import { fakeQuota } from '../../../tests/fakes/fake-storage-usage.js';
import { FakeUnitOfWork } from '../../../tests/fakes/fake-unit-of-work.js';
import type {
  AssetReferences,
  ReferencePlace,
} from '../../assets/core/asset-references.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../base/core/errors.js';
import { DeleteBrandingImageAction } from './actions/delete-branding-image.action.js';
import { ListBrandingImagesAction } from './actions/list-branding-images.action.js';
import { SweepBrandingImagesAction } from './actions/sweep-branding-images.action.js';
import type { BrandingImage } from './branding.js';
import { BrandingImageRemoval } from './branding-image-removal.js';

const brander = { ...actorWith(['admin.branding']), id: 'brander' };
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-20T12:00:00Z');

const image = (n: number, uploadedAt = new Date(0)): BrandingImage => ({
  sha256: n.toString(16).padStart(64, '0'),
  contentType: 'image/png',
  size: 100,
  width: 8,
  height: 8,
  uploadedBy: { kind: 'user', id: 'brander' },
  uploadedAt,
});

/** What happens while the removal looks for uses (once). */
setup.during = undefined as (() => Promise<void>) | undefined;

function setup() {
  const store = new FakeBrandingStore();
  const uploads = new FakeAssetUploads();
  const blobs = new FakeBlobStore();
  const audit = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  const { quota, usage } = fakeQuota({ auditLog: audit, unit });
  const places = new Map<string, ReferencePlace[]>();
  const references = {
    placesOf: async (hashes: readonly string[]) => {
      await setup.during?.();
      setup.during = undefined;
      return new Map([...places].filter(([hash]) => hashes.includes(hash)));
    },
  } as unknown as AssetReferences;
  const removal = new BrandingImageRemoval(
    store,
    uploads,
    references,
    blobs,
    quota,
    audit,
    unit,
  );
  /** `image` on record, its bytes stored and counted. */
  const add = async (recorded: BrandingImage) => {
    store.images.set(recorded.sha256, recorded);
    blobs.blobs.set(recorded.sha256, {
      contentType: 'image/png',
      size: recorded.size,
      storedAt: recorded.uploadedAt,
      bytes: Buffer.alloc(recorded.size),
    } as never);
    usage.totals = {
      ...usage.totals,
      media: {
        bytes: usage.totals.media.bytes + recorded.size,
        files: usage.totals.media.files + 1,
      },
    };
  };
  return {
    store,
    uploads,
    blobs,
    audit,
    usage,
    places,
    removal,
    add,
    unitOf: unit,
    remove: new DeleteBrandingImageAction(removal),
    list: new ListBrandingImagesAction(store),
    sweep: new SweepBrandingImagesAction(store, removal),
  };
}

describe('DeleteBrandingImageAction', () => {
  it('needs admin.branding', async () => {
    const { remove } = setup();
    await expect(
      remove.handle({ actor: NOBODY, sha256: 'a'.repeat(64) }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('removes an unused image with its bytes, off the storage used, audited', async () => {
    const { remove, add, store, blobs, usage, audit } = setup();
    const unused = image(1);
    await add(unused);
    await remove.handle({ actor: brander, sha256: unused.sha256 });
    expect(store.images.has(unused.sha256)).toBe(false);
    expect(blobs.blobs.has(unused.sha256)).toBe(false);
    expect(usage.totals.media).toEqual({ bytes: 0, files: 0 });
    expect(audit.events).toEqual([
      expect.objectContaining({
        action: 'branding.image-delete',
        subject: { type: 'branding', id: 'branding' },
        data: expect.objectContaining({
          sha256: unused.sha256,
          fileKept: false,
        }),
      }),
    ]);
  });

  it('refuses one a field names, and a hash never uploaded or malformed', async () => {
    const { remove, add, store } = setup();
    const used = image(2);
    await add(used);
    store.stored = {
      ...store.stored,
      branding: {
        ...store.stored.branding,
        favicon: used.sha256,
        mark: used.sha256,
      },
    };
    const refused = await remove
      .handle({ actor: brander, sha256: used.sha256 })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConflictError);
    expect(refused).toMatchObject({
      code: 'branding-image-in-use',
      meta: { usedIn: ['mark', 'favicon'] },
    });
    expect(store.images.has(used.sha256)).toBe(true);
    for (const sha256 of ['f'.repeat(64), 'not a hash']) {
      await expect(remove.handle({ actor: brander, sha256 })).rejects.toThrow(
        NotFoundError,
      );
    }
  });

  it('keeps the bytes a content upload records, or content refers to, and their count', async () => {
    const { remove, add, uploads, places, blobs, usage, audit } = setup();
    const recorded = image(3);
    const referred = image(4);
    await add(recorded);
    await add(referred);
    uploads.uploads.push({
      changeSetId: '01900000-0000-7000-8000-000000000001',
      sha256: recorded.sha256,
      size: 100,
      contentType: 'image/png',
      uploadedBy: { kind: 'user', id: 'author' },
      uploadedAt: new Date(0),
      lastUploadedAt: new Date(0),
    });
    places.set(referred.sha256, [{ in: 'main', ref: 'main' }]);
    await remove.handle({ actor: brander, sha256: recorded.sha256 });
    await remove.handle({ actor: brander, sha256: referred.sha256 });
    expect(blobs.blobs.has(recorded.sha256)).toBe(true);
    expect(blobs.blobs.has(referred.sha256)).toBe(true);
    expect(usage.totals.media.files).toBe(2);
    expect(audit.events.map((e) => e.data?.['fileKept'])).toEqual([true, true]);
  });
});

describe('BrandingImageRemoval while another deletion is under way', () => {
  it('changes nothing and leaves the other mark: 503 branding-image-busy', async () => {
    const { remove, add, uploads, unitOf, store, blobs } = setup();
    const busy = image(20);
    await add(busy);
    await unitOf.run((tx) => uploads.markDeleted(tx, busy.sha256));
    await expect(
      remove.handle({ actor: brander, sha256: busy.sha256 }),
    ).rejects.toMatchObject({ code: 'branding-image-busy' });
    expect(store.images.has(busy.sha256)).toBe(true);
    expect(blobs.blobs.has(busy.sha256)).toBe(true);
    expect(
      await unitOf.run((tx) => uploads.deletedAmong(tx, [busy.sha256])),
    ).toEqual([busy.sha256]);
  });

  it('keeps the bytes when a content upload cleared its mark while it looked', async () => {
    const { remove, add, uploads, unitOf, blobs } = setup();
    const raced = image(21);
    await add(raced);
    // The look is where the content upload lands: it records and clears the mark.
    setup.during = async () => {
      await unitOf.run(async (tx) => {
        await uploads.clearDeleted(tx, raced.sha256);
      });
    };
    await remove.handle({ actor: brander, sha256: raced.sha256 });
    expect(blobs.blobs.has(raced.sha256)).toBe(true);
  });
});

describe('ListBrandingImagesAction', () => {
  it('lists the uploads last first, with the fields naming each, for admin.branding', async () => {
    const { list, add, store } = setup();
    await add(image(5, new Date(1_000)));
    await add(image(6, new Date(2_000)));
    store.stored = {
      ...store.stored,
      branding: { ...store.stored.branding, logoDark: image(5).sha256 },
    };
    const page = await list.handle({
      actor: brander,
      page: { number: 1, size: 10 },
    });
    expect(page.total).toBe(2);
    expect(page.items.map((i) => [i.image.sha256, i.usedIn])).toEqual([
      [image(6).sha256, []],
      [image(5).sha256, ['logoDark']],
    ]);
    await expect(
      list.handle({ actor: NOBODY, page: { number: 1, size: 10 } }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('SweepBrandingImagesAction', () => {
  it('removes unused images a day old as service:branding, keeping used and recent ones', async () => {
    const { sweep, add, store, audit } = setup();
    const old = image(7, new Date(NOW.getTime() - 2 * DAY));
    const recent = image(8, new Date(NOW.getTime() - DAY / 2));
    const used = image(9, new Date(0));
    for (const i of [old, recent, used]) await add(i);
    store.stored = {
      ...store.stored,
      branding: { ...store.stored.branding, appIcon: used.sha256 },
    };
    const report = await sweep.handle({ now: NOW });
    expect(report).toEqual({ removed: [old.sha256], failed: [] });
    expect([...store.images.keys()].sort()).toEqual(
      [recent.sha256, used.sha256].sort(),
    );
    expect(audit.events[0]?.actor).toEqual({
      kind: 'service',
      id: 'service:branding',
    });
  });

  it('stops between images once aborted or past its deadline', async () => {
    const { sweep, add, store } = setup();
    for (let n = 10; n < 13; n++) await add(image(n));
    const aborted = new AbortController();
    aborted.abort();
    expect(
      (await sweep.handle({ now: NOW, signal: aborted.signal })).removed,
    ).toEqual([]);
    let clock = 0;
    sweep.clock = () => (clock += 3 * 60_000);
    // Past five minutes after the first.
    expect((await sweep.handle({ now: NOW })).removed).toHaveLength(1);
    expect(store.images.size).toBe(2);
  });

  it('reports one that fails and goes on', async () => {
    const { sweep, add, blobs, store } = setup();
    await add(image(14));
    await add(image(15, new Date(1)));
    const del = blobs.delete.bind(blobs);
    blobs.delete = async (sha256) => {
      if (sha256 === image(14).sha256) throw new Error('the store is down');
      return del(sha256);
    };
    const report = await sweep.handle({ now: NOW });
    expect(report.removed).toEqual([image(15).sha256]);
    expect(report.failed.map((f) => f.sha256)).toEqual([image(14).sha256]);
    expect(store.images.has(image(14).sha256)).toBe(true);
  });
});
