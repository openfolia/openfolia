import { FakeAssetReferenceStore } from '../../../../tests/fakes/fake-asset-reference-store.js';
import { AssetReferenceIndex } from '../asset-reference-index.js';
import { FakeAssetRenditions } from '../../../../tests/fakes/fake-asset-renditions.js';
import { FakeRepository } from '../../../../tests/fakes/fake-repository.js';
import { FakeWorkingCopyStore } from '../../../../tests/fakes/fake-working-copy-store.js';
import { AssetReferences } from '../asset-references.js';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
import type { Module } from '@openfolia/content-model';
import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import { FakeArchivedFiles } from '../../../../tests/fakes/fake-archived-files.js';
import { FakeHeldBlobs } from '../../../../tests/fakes/fake-held-blobs.js';
import { FakeAssetUploads } from '../../../../tests/fakes/fake-asset-uploads.js';
import { FakeBlobStore } from '../../../../tests/fakes/fake-blob-store.js';
import { FakeChangeSetStore } from '../../../../tests/fakes/fake-change-set-store.js';
import {
  FakeSnapshot,
  module,
  readable,
} from '../../../../tests/fakes/fake-content.js';
import type { Actor } from '../../../access/core/actor.js';
import {
  ForbiddenError,
  NotFoundError,
  UnavailableError,
} from '../../../base/core/errors.js';
import {
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from '../../../change-sets/core/change-set.js';
import { AssetInfoReader, MISSING_KEPT_MS } from '../asset-info.js';
import type { UploadType } from '../asset-upload.js';
import { ListAssetsAction, USED_IN_SHOWN } from './list-assets.action.js';

/** A real 1×1 PNG, and one stating 1920×1080 (bytes differ, so does the hash). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const WIDE = Buffer.from(PNG);
WIDE.writeUInt32BE(1920, 16);
WIDE.writeUInt32BE(1080, 20);
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x30, 0x00, 0x40, 0x03,
]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const sha256 = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

const page = { number: 1, size: 50 };

/** A module showing the images `hashes`, of type `type`. */
const showing = (
  id: string,
  lang: string,
  hashes: string[],
  type = 'concept',
): Module => {
  const base = module(id, lang);
  return {
    ...base,
    meta: { ...base.meta, type },
    blocks: hashes.map((hash, n) => ({
      type: 'image',
      id: `image-${n}`,
      asset: `sha256:${hash}`,
      alt: 'An image',
    })),
  };
};

const EDITING = ['content.read', 'content.edit'] as const;
/** An author limited to concepts: the restricted module is outside their scope. */
const author: Actor = {
  ...actorWith([...EDITING], { moduleTypes: ['concept'] }),
  id: 'sample-author',
};
const other: Actor = { ...author, id: 'sample-other' };
const draftReader: Actor = {
  ...actorWith([...EDITING, 'content.read.draft']),
  id: 'sample-reviewer',
};

function changeSet(by: Actor): ChangeSet {
  const id = newChangeSetId();
  const now = new Date();
  return {
    id,
    title: 'Images',
    description: null,
    author: { kind: by.kind, id: by.id },
    baseRef: 'main',
    baseCommit: 'a'.repeat(40),
    baseReleased: true,
    branch: changeSetBranch(id),
    state: 'draft',
    createdAt: now,
    updatedAt: now,
  };
}

function setUp(...changeSets: ChangeSet[]) {
  const blobs = new FakeBlobStore();
  const uploads = new FakeAssetUploads();
  const changeSetStore = new FakeChangeSetStore(changeSets);
  const workingCopies = new FakeWorkingCopyStore();
  const held = new FakeHeldBlobs();
  const archived = new FakeArchivedFiles();
  // `main` of the repository the unused check reads: modules pushed here count.
  const mainModules: Module[] = [];
  const repository = new FakeRepository(
    new FakeSnapshot({ modules: mainModules }),
  );
  const renditions = new FakeAssetRenditions();
  const action = new ListAssetsAction(
    new AssetInfoReader(blobs),
    changeSetStore,
    uploads,
    new AssetReferences(
      repository,
      changeSetStore,
      workingCopies,
      uploads,
      held,
      new AssetReferenceIndex(repository, new FakeAssetReferenceStore()),
    ),
    renditions,
    blobs,
    archived,
  );
  const store = (data: Buffer, contentType: string) =>
    blobs.blobs.set(sha256(data), { data, contentType });
  const upload = (
    changeSetId: string,
    data: Buffer,
    contentType: UploadType | string,
    at: Date,
    fileName?: string,
  ) => {
    store(data, contentType);
    uploads.uploads.push({
      changeSetId,
      sha256: sha256(data),
      size: data.byteLength,
      contentType,
      ...(fileName !== undefined ? { fileName } : {}),
      uploadedBy: { kind: 'user', id: author.id },
      uploadedAt: at,
      lastUploadedAt: at,
    });
  };
  return {
    action,
    blobs,
    store,
    upload,
    mainModules,
    workingCopies,
    renditions,
    held,
    archived,
  };
}

describe('ListAssetsAction', () => {
  const png = sha256(PNG);
  const wide = sha256(WIDE);
  const jpeg = sha256(JPEG);
  const svg = sha256(SVG);
  const content = {
    modules: [
      showing('b-pictures', 'en', [wide, png]),
      showing('b-pictures', 'de', [wide]),
      showing('a-intro', 'en', [png, png]),
      showing('c-secret', 'en', [jpeg], 'restricted'),
      showing('d-old', 'en', [svg]),
      showing('e-broken', 'en', ['not-a-hash']),
    ],
    assets: { [svg]: SVG },
  };

  it('lists the images readable modules show, with their facts and uses', async () => {
    const { action, store } = setUp();
    store(PNG, 'image/png');
    store(WIDE, 'image/png');
    store(JPEG, 'image/jpeg');
    const result = await action.handle({
      actor: READER,
      snapshot: readable(content),
      page,
    });
    expect(result.total).toBe(4);
    expect(result.items.map((a) => a.sha256)).toEqual([png, wide, jpeg, svg]);
    const [first, second, third, fourth] = result.items;
    expect(first).toEqual({
      sha256: png,
      info: {
        contentType: 'image/png',
        size: PNG.byteLength,
        dimensions: { width: 1, height: 1 },
      },
      usedIn: [
        {
          moduleId: 'a-intro',
          lang: 'en',
          title: 'Title of a-intro',
          // Shown twice there: both blocks' alt texts.
          descriptions: ['An image', 'An image'],
          asImage: true,
          fileNames: [],
          searchText: 'a-intro\ntitle of a-intro\nan image\nan image',
        },
        {
          moduleId: 'b-pictures',
          lang: 'en',
          title: 'Title of b-pictures',
          descriptions: ['An image'],
          asImage: true,
          fileNames: [],
          searchText: 'b-pictures\ntitle of b-pictures\nan image',
        },
      ],
      usedInCount: 2,
      usedInManuals: [],
      languages: ['en'],
      uploaded: false,
      usedAsImage: true,
      usedAsAttachment: false,
    });
    expect(second?.languages).toEqual(['de', 'en']);
    expect(second?.info?.dimensions).toEqual({ width: 1920, height: 1080 });
    expect(second?.usedIn.map((u) => u.lang)).toEqual(['de', 'en']);
    expect(third?.info?.dimensions).toEqual({ width: 64, height: 48 });
    // The old layout: from the repository, its type sniffed, no pixel size.
    expect(fourth?.info).toEqual({
      contentType: 'image/svg+xml',
      size: SVG.byteLength,
    });
  });

  it('lists a referenced image neither store holds as missing', async () => {
    const { action } = setUp();
    const result = await action.handle({
      actor: READER,
      snapshot: readable(content),
      page,
    });
    expect(result.items[0]).toMatchObject({ sha256: png, usedInCount: 2 });
    expect(result.items[0]?.info).toBeUndefined();
  });

  it('never lists or counts what lies outside the reader’s scope', async () => {
    const { action, store } = setUp();
    store(JPEG, 'image/jpeg');
    const scoped = actorWith(['content.read'], {
      moduleTypes: ['concept'],
      languages: ['de'],
    });
    const result = await action.handle({
      actor: scoped,
      snapshot: readable(content, scoped),
      page,
    });
    // Only the German module is in scope: one image, one use.
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sha256: wide,
      usedIn: [{ moduleId: 'b-pictures', lang: 'de' }],
      usedInCount: 1,
    });
  });

  it('filters by type before paging', async () => {
    const { action, store } = setUp();
    store(PNG, 'image/png');
    store(WIDE, 'image/png');
    store(JPEG, 'image/jpeg');
    const snapshot = readable(content);
    const pngs = await action.handle({
      actor: READER,
      snapshot,
      type: 'image/png',
      page: { number: 2, size: 1 },
    });
    expect(pngs.total).toBe(2);
    expect(pngs.items.map((a) => a.sha256)).toEqual([wide]);
    const images = await action.handle({
      actor: READER,
      snapshot,
      type: 'image',
      page,
    });
    expect(images.total).toBe(4);
    const none = await action.handle({
      actor: READER,
      snapshot,
      type: 'application',
      page,
    });
    expect(none).toEqual({ items: [], total: 0 });
  });

  describe('with a query', () => {
    /** A module of `type` showing `hash` with this alt text and title. */
    const described = (
      id: string,
      hash: string,
      alt: string,
      title?: string,
      type = 'concept',
    ): Module => ({
      ...showing(id, 'en', [], type),
      blocks: [
        {
          type: 'image',
          id: 'image',
          asset: `sha256:${hash}`,
          alt,
          ...(title === undefined
            ? {}
            : { title: [{ type: 'text', text: title }] }),
        },
      ],
    });
    const searchable = {
      modules: [
        described('charger', png, 'Ladegerät am Fahrzeug', 'Figure: plug'),
        described('overview', wide, 'Overview of the hall'),
        described(
          'secret-plan',
          jpeg,
          'Ladegerät, geheim',
          undefined,
          'restricted',
        ),
        // Shows `wide` too, which `overview` shows to a concepts-only reader.
        described(
          'secret-wide',
          wide,
          'Streng geheim',
          undefined,
          'restricted',
        ),
      ],
    };
    const find = async (
      query: string,
      actor = READER,
      more: Partial<{ type: string; changeSetId: string }> = {},
      { action, store } = setUp(),
    ) => {
      store(PNG, 'image/png');
      store(WIDE, 'image/png');
      store(JPEG, 'image/jpeg');
      return action.handle({
        actor,
        snapshot: readable(searchable, actor),
        query,
        ...more,
        page,
      });
    };
    const ids = (result: { items: { sha256: string }[] }) =>
      result.items.map((a) => a.sha256);

    it('finds by alt text, image title, module title and ID, case and diacritics aside', async () => {
      expect(ids(await find('LADEGERAT'))).toEqual([png, jpeg]);
      expect(ids(await find('plug'))).toEqual([png]);
      expect(ids(await find('title of overview'))).toEqual([wide]);
      expect(ids(await find('secret-pl'))).toEqual([jpeg]);
      const none = await find('nothing like it');
      expect(none).toEqual({ items: [], total: 0 });
    });

    it('never finds an image through a module outside the reader’s scope, nor counts it', async () => {
      const concepts = actorWith(['content.read'], {
        moduleTypes: ['concept'],
      });
      const found = await find('ladegerat', concepts);
      expect(ids(found)).toEqual([png]);
      expect(found.total).toBe(1);
      expect(await find('secret', concepts)).toEqual({ items: [], total: 0 });
    });

    it('never finds an image a reader sees through a hidden module’s words', async () => {
      const concepts = actorWith(['content.read'], {
        moduleTypes: ['concept'],
      });
      // `wide` is visible (overview) but "geheim" is only a hidden module's.
      expect(await find('geheim', concepts)).toEqual({ items: [], total: 0 });
      const seen = await find('overview', concepts);
      expect(seen.items.map((a) => [a.sha256, a.usedInCount])).toEqual([
        [wide, 1],
      ]);
      // A reader who sees both modules finds it.
      expect(ids(await find('geheim'))).toEqual([wide, jpeg]);
    });

    it('finds a file by its whole hash, only among the files the reader may see (#404)', async () => {
      expect(ids(await find(png.toUpperCase()))).toEqual([png]);
      const concepts = actorWith(['content.read'], {
        moduleTypes: ['concept'],
      });
      // Only a restricted module shows `jpeg`: not found by its hash either.
      expect(await find(jpeg, concepts)).toEqual({ items: [], total: 0 });
      // A part of a hash is no file name: nothing.
      expect(await find(png.slice(0, 12))).toEqual({ items: [], total: 0 });
    });

    it('folds whitespace as the texts, and a query of marks finds nothing', async () => {
      expect(ids(await find('title   of\toverview'))).toEqual([wide]);
      expect(await find('\u0301')).toEqual({ items: [], total: 0 });
    });

    it('combines with the type filter and pages the matches', async () => {
      const jpegs = await find('ladegerat', READER, { type: 'image/jpeg' });
      expect(ids(jpegs)).toEqual([jpeg]);
      expect(jpegs.total).toBe(1);
      const { action, store } = setUp();
      store(PNG, 'image/png');
      store(JPEG, 'image/jpeg');
      const second = await action.handle({
        actor: READER,
        snapshot: readable(searchable),
        query: 'ladegerat',
        page: { number: 2, size: 1 },
      });
      expect(second).toMatchObject({ total: 2 });
      expect(ids(second)).toEqual([jpeg]);
    });

    it('finds an upload only through a module showing it', async () => {
      const own = changeSet(author);
      const setup = setUp(own);
      setup.upload(own.id, PNG, 'image/png', new Date());
      setup.upload(own.id, SVG as Buffer, 'image/png', new Date());
      const found = await find(
        'ladegerat',
        author,
        { changeSetId: own.id },
        setup,
      );
      expect(found.items.map((a) => [a.sha256, a.uploaded])).toEqual([
        [png, true],
      ]);
    });
  });

  it('pages, reading only the page’s files without a type filter', async () => {
    const { action, store, blobs } = setUp();
    store(PNG, 'image/png');
    store(WIDE, 'image/png');
    const asked: string[] = [];
    const get = blobs.get.bind(blobs);
    blobs.get = async (hash) => {
      asked.push(hash);
      return get(hash);
    };
    const result = await action.handle({
      actor: READER,
      snapshot: readable(content),
      page: { number: 2, size: 1 },
    });
    expect(result.total).toBe(4);
    expect(result.items.map((a) => a.sha256)).toEqual([wide]);
    expect(asked).toEqual([wide]);
  });

  it('reads a file once: its facts are kept', async () => {
    const { action, store, blobs } = setUp();
    store(PNG, 'image/png');
    let reads = 0;
    const get = blobs.get.bind(blobs);
    blobs.get = async (hash) => {
      reads++;
      return get(hash);
    };
    const snapshot = readable({ modules: [showing('m', 'en', [png])] });
    await action.handle({ actor: READER, snapshot, page });
    await action.handle({ actor: READER, snapshot, page });
    expect(reads).toBe(1);
  });

  it('reads no more of a stored file than its header', async () => {
    const { action, blobs } = setUp();
    const big = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]);
    const hash = sha256(big);
    let pulled = 0;
    let destroyed = false;
    blobs.get = async () => {
      const stream = Readable.from(
        (function* () {
          for (let at = 0; at < big.length; at += 64 * 1024) {
            pulled++;
            yield big.subarray(at, at + 64 * 1024);
          }
        })(),
      );
      stream.on('close', () => (destroyed = true));
      return {
        sha256: hash,
        size: big.length,
        contentType: 'image/png',
        storedAt: new Date(0),
        stream,
      };
    };
    const result = await action.handle({
      actor: READER,
      snapshot: readable({ modules: [showing('m', 'en', [hash])] }),
      page,
    });
    expect(result.items[0]?.info?.dimensions).toEqual({ width: 1, height: 1 });
    expect(pulled).toBeLessThan(4);
    await new Promise((resolve) => setImmediate(resolve));
    expect(destroyed).toBe(true);
  });

  it('keeps "missing" for a minute and a misnamed old-layout file per commit', async () => {
    const blobs = new FakeBlobStore();
    let now = 0;
    const reader = new AssetInfoReader(blobs);
    reader.now = () => now;
    const misnamed = 'f'.repeat(64);
    const snapshot = readable({
      modules: [showing('m', 'en', [png, misnamed])],
      assets: { [misnamed]: PNG },
    });
    let reads = 0;
    const get = blobs.get.bind(blobs);
    blobs.get = async (hash) => {
      reads++;
      return get(hash);
    };
    expect(await reader.info(snapshot, png)).toBeUndefined();
    expect((await reader.info(snapshot, misnamed))?.contentType).toBe(
      'image/png',
    );
    expect(reads).toBe(2);
    now = MISSING_KEPT_MS - 1;
    await reader.info(snapshot, png);
    await reader.info(snapshot, misnamed);
    expect(reads).toBe(2);
    // Stored meanwhile: seen once "missing" has run out.
    blobs.blobs.set(png, { data: PNG, contentType: 'image/png' });
    now = MISSING_KEPT_MS;
    expect((await reader.info(snapshot, png))?.size).toBe(PNG.byteLength);
    // Another commit asks again for what was kept per commit.
    const later = readable({
      modules: [showing('m', 'en', [misnamed])],
      assets: { [misnamed]: SVG },
    });
    expect((await reader.info(later, misnamed))?.contentType).toBe(
      'image/svg+xml',
    );
  });

  it('answers "unavailable" when a stored file fails while being read', async () => {
    const { action, store, blobs } = setUp();
    store(PNG, 'image/png');
    const get = blobs.get.bind(blobs);
    blobs.get = async (hash) => {
      const blob = await get(hash);
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
    };
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      await expect(
        action.handle({
          actor: READER,
          snapshot: readable({ modules: [showing('m', 'en', [png])] }),
          page,
        }),
      ).rejects.toBeInstanceOf(UnavailableError);
    } finally {
      error.mockRestore();
    }
  });

  it('never hands one reader what the repository gave another of other scope', async () => {
    const blobs = new FakeBlobStore();
    const reader = new AssetInfoReader(blobs);
    // An old-layout file whose bytes are not its name: kept per reader.
    const misnamed = 'e'.repeat(64);
    const content = new FakeSnapshot({
      modules: [showing('wide-only', 'en', [misnamed], 'restricted')],
      assets: { [misnamed]: PNG },
    });
    const narrow = actorWith(['content.read'], { moduleTypes: ['concept'] });
    // The narrow reader first: "missing" for them, on the same commit.
    expect(
      await reader.info(readable(content, narrow), misnamed),
    ).toBeUndefined();
    expect(
      (await reader.info(readable(content, READER), misnamed))?.contentType,
    ).toBe('image/png');
    // And the other way round: the wide reader's facts are not the narrow one's.
    expect(
      await reader.info(readable(content, narrow), misnamed),
    ).toBeUndefined();
  });

  it('starts no more reads once one fails', async () => {
    const { action, blobs } = setUp();
    let reads = 0;
    blobs.get = async () => {
      reads++;
      throw new UnavailableError('blob-store-unavailable', 'Down.', 5);
    };
    const many = Array.from({ length: 40 }, (_, n) =>
      showing(`m-${n}`, 'en', [sha256(Buffer.from(`image ${n}`))]),
    );
    await expect(
      action.handle({
        actor: READER,
        snapshot: readable({ modules: many }),
        type: 'image',
        page,
      }),
    ).rejects.toBeInstanceOf(UnavailableError);
    expect(reads).toBeLessThanOrEqual(8);
  });

  it('fails as the blob store does, never answering "missing"', async () => {
    const { action, blobs } = setUp();
    blobs.down = true;
    await expect(
      action.handle({ actor: READER, snapshot: readable(content), page }),
    ).rejects.toBeInstanceOf(UnavailableError);
  });

  describe('with a change set', () => {
    it('lists its uploads first, last uploaded first, also before a module shows them', async () => {
      const own = changeSet(author);
      const { action, upload, store } = setUp(own);
      store(WIDE, 'image/png');
      upload(own.id, JPEG, 'image/jpeg', new Date('2026-01-01'));
      upload(own.id, PNG, 'image/png', new Date('2026-02-01'));
      const result = await action.handle({
        actor: author,
        snapshot: readable(content, author),
        changeSetId: own.id,
        page,
      });
      expect(result.items.map((a) => [a.sha256, a.uploaded])).toEqual([
        [png, true],
        [jpeg, true],
        [wide, false],
        [svg, false],
      ]);
      // An upload a readable module shows has its uses; the restricted one's are not listed.
      expect(result.items[0]?.usedInCount).toBe(2);
      expect(result.items[1]).toMatchObject({ usedIn: [], usedInCount: 0 });
      expect(result.items[1]?.info?.contentType).toBe('image/jpeg');
    });

    it('is its author’s only: 403 for a reader of drafts, 404 for anyone else', async () => {
      const own = changeSet(author);
      const { action, upload } = setUp(own);
      upload(own.id, JPEG, 'image/jpeg', new Date());
      await expect(
        action.handle({
          actor: draftReader,
          snapshot: readable(content, draftReader),
          changeSetId: own.id,
          page,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      for (const changeSetId of [own.id, newChangeSetId(), 'nope']) {
        await expect(
          action.handle({
            actor: other,
            snapshot: readable(content, other),
            changeSetId,
            page,
          }),
        ).rejects.toBeInstanceOf(NotFoundError);
      }
    });

    it('does not list another change set’s uploads without it', async () => {
      const own = changeSet(author);
      const { action, upload } = setUp(own);
      upload(own.id, JPEG, 'image/jpeg', new Date());
      const result = await action.handle({
        actor: author,
        snapshot: readable({ modules: [] }, author),
        page,
      });
      expect(result).toEqual({ items: [], total: 0 });
    });
  });

  it('keeps at most a few dozen uses per image', async () => {
    const { action, store } = setUp();
    store(PNG, 'image/png');
    const many = Array.from({ length: USED_IN_SHOWN + 5 }, (_, n) =>
      showing(`m-${String(n).padStart(3, '0')}`, 'en', [png]),
    );
    const result = await action.handle({
      actor: READER,
      snapshot: readable({ modules: many }),
      page,
    });
    expect(result.items[0]?.usedIn).toHaveLength(USED_IN_SHOWN);
    expect(result.items[0]?.usedInCount).toBe(USED_IN_SHOWN + 5);
  });

  it('refuses an actor who may not read', async () => {
    const { action } = setUp();
    const nobody = actorWith([]);
    await expect(
      action.handle({ actor: nobody, snapshot: readable(content), page }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('ListAssetsAction, attachments', () => {
  const ZIP = Buffer.concat([
    Buffer.from('PK\x03\x04', 'latin1'),
    Buffer.alloc(8),
  ]);
  const JSON_FILE = Buffer.from('{"a":1}');
  const zip = sha256(ZIP);
  const png = sha256(PNG);
  const attaching = (id: string, hash: string, over = {}): Module => ({
    ...module(id, 'en'),
    blocks: [
      {
        type: 'attachment',
        id: 'file',
        asset: `sha256:${hash}`,
        name: 'Charger settings',
        description: 'For the service tool.',
        fileName: 'settings-v2.zip',
        mediaType: 'application/zip',
        size: ZIP.byteLength,
        ...over,
      },
    ],
  });

  it('lists attached files with their file name and how they are used', async () => {
    const { action, store } = setUp();
    store(ZIP, 'application/zip');
    store(PNG, 'image/png');
    const snapshot = readable({
      modules: [attaching('a-files', zip), showing('b-pictures', 'en', [png])],
    });
    const result = await action.handle({ actor: author, snapshot, page });
    expect(
      result.items.map((a) => [
        a.sha256,
        a.fileName,
        a.usedAsImage,
        a.usedAsAttachment,
      ]),
    ).toEqual([
      [zip, 'settings-v2.zip', false, true],
      [png, undefined, true, false],
    ]);
    const attachments = await action.handle({
      actor: author,
      snapshot,
      type: 'attachment',
      page,
    });
    expect(attachments.items.map((a) => a.sha256)).toEqual([zip]);
    expect(attachments.total).toBe(1);
  });

  it('finds attachments by name, description and file name', async () => {
    const { action, store } = setUp();
    store(ZIP, 'application/zip');
    const snapshot = readable({ modules: [attaching('a-files', zip)] });
    for (const query of ['charger', 'SERVICE tool', 'settings-v2']) {
      const result = await action.handle({
        actor: author,
        snapshot,
        query,
        page,
      });
      expect([query, result.total]).toEqual([query, 1]);
    }
  });

  it('lists a change set’s attachment uploads, found by file name, under the attachment filter', async () => {
    const mine = changeSet(author);
    const { action, upload } = setUp(mine);
    upload(mine.id, JSON_FILE, 'application/json', new Date(2), 'sample.json');
    upload(mine.id, PNG, 'image/png', new Date(1), 'photo.png');
    const snapshot = readable({ modules: [] });
    const all = await action.handle({
      actor: author,
      snapshot,
      changeSetId: mine.id,
      page,
    });
    expect(all.items.map((a) => a.fileName)).toEqual([
      'sample.json',
      'photo.png',
    ]);
    const attachments = await action.handle({
      actor: author,
      snapshot,
      changeSetId: mine.id,
      type: 'attachment',
      page,
    });
    expect(attachments.items.map((a) => a.sha256)).toEqual([sha256(JSON_FILE)]);
    const found = await action.handle({
      actor: author,
      snapshot,
      changeSetId: mine.id,
      query: 'SAMPLE',
      page,
    });
    expect(found.items.map((a) => a.sha256)).toEqual([sha256(JSON_FILE)]);
  });
});

describe('ListAssetsAction: languages', () => {
  it('names the languages that use a file, and filters by one', async () => {
    const { action, store } = setUp();
    store(PNG, 'image/png');
    store(WIDE, 'image/png');
    const snapshot = readable({
      modules: [
        showing('a', 'en', [sha256(PNG)]),
        showing('a', 'de', [sha256(PNG), sha256(WIDE)]),
      ],
    });
    const all = await action.handle({ actor: READER, snapshot, page });
    expect(all.items.map((item) => [item.sha256, item.languages])).toEqual([
      [sha256(PNG), ['de', 'en']],
      [sha256(WIDE), ['de']],
    ]);
    const english = await action.handle({
      actor: READER,
      snapshot,
      lang: 'en',
      page,
    });
    expect(english.items.map((item) => item.sha256)).toEqual([sha256(PNG)]);
    expect(english.total).toBe(1);
  });
});

describe('ListAssetsAction: unused', () => {
  const editor = actorWith([
    'content.read',
    'content.read.draft',
    'content.edit',
  ]);
  const DAY = 24 * 60 * 60 * 1000;
  const old = new Date(Date.now() - 2 * DAY);
  const file = (text: string) => Buffer.concat([PNG, Buffer.from(text)]);

  it('needs content.read.draft and content.edit in a role whose scope restricts nothing', async () => {
    const { action } = setUp();
    for (const actor of [
      READER,
      // A contributor: unused files include other people's draft uploads (#137).
      actorWith(['content.read', 'content.edit']),
      actorWith(['content.read', 'content.read.draft', 'content.edit'], {
        languages: ['en'],
      }),
    ]) {
      await expect(
        action.handle({ actor, snapshot: readable({}), unused: true, page }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    // Any restriction of the scope: no unused files (#255's review).
    const scoped = actorWith(
      ['content.read', 'content.read.draft', 'content.edit'],
      { moduleTypes: ['concept'] },
    );
    await expect(
      action.handle({
        actor: scoped,
        snapshot: readable({}),
        unused: true,
        page,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      action.handle({
        actor: editor,
        snapshot: readable({}),
        unused: true,
        page,
      }),
    ).resolves.toEqual({ items: [], total: 0 });
  });

  it('lists old uploads and blobs nothing refers to, and nothing else', async () => {
    // Merged: its uploads count only where content refers to them.
    const mine: ChangeSet = { ...changeSet(author), state: 'merged' };
    const drafting = changeSet(other);
    const {
      action,
      blobs,
      upload,
      mainModules,
      workingCopies,
      renditions,
      held,
      archived,
    } = setUp(mine, drafting);
    // An open change set's upload is its author's draft: never listed.
    upload(drafting.id, file('a draft'), 'image/png', old, 'draft.png');
    const unused = file('unused');
    const recent = file('recent');
    const inMain = file('in main');
    const inCopy = file('in a working copy');
    const orphan = file('a blob without an upload');
    const rendition = file('a rendition');
    upload(mine.id, unused, 'image/png', old, 'unused.png');
    upload(mine.id, recent, 'image/png', new Date());
    upload(mine.id, inMain, 'image/png', old);
    upload(mine.id, inCopy, 'image/png', old);
    blobs.blobs.set(sha256(orphan), { data: orphan, contentType: 'image/png' });
    // A kept import's uploaded bundle, stored long ago: no file of content.
    const bundle = file('an import’s bundle');
    blobs.blobs.set(sha256(bundle), {
      data: bundle,
      contentType: 'application/octet-stream',
    });
    held.hashes.add(sha256(bundle));
    // An archived release PDF no upload records: kept for good (#429).
    const releasePdf = file('an archived release PDF');
    blobs.blobs.set(sha256(releasePdf), {
      data: releasePdf,
      contentType: 'application/pdf',
    });
    archived.files.add(sha256(releasePdf));
    // One uploaded as an attachment too: its upload can go.
    const attachedPdf = file('a release PDF uploaded as an attachment');
    const older = new Date(Date.now() - 3 * DAY);
    upload(mine.id, attachedPdf, 'application/pdf', older, 'manual.pdf');
    archived.files.add(sha256(attachedPdf));
    blobs.blobs.set(sha256(rendition), {
      data: rendition,
      contentType: 'image/webp',
    });
    renditions.renditions.push({
      sourceSha256: sha256(inMain),
      width: 320,
      sha256: sha256(rendition),
      size: rendition.length,
      createdAt: old,
    });
    mainModules.push(showing('m', 'en', [sha256(inMain)]));
    workingCopies.copies.set('copy', {
      changeSetId: mine.id,
      subject: { type: 'module', id: 'm', lang: 'de' },
      content: showing('m', 'de', [sha256(inCopy)]),
      baseCommit: 'c'.repeat(40),
      version: 1,
      updatedBy: { kind: 'user', id: author.id },
      createdAt: old,
      updatedAt: old,
    } as never);
    const listed = await action.handle({
      actor: editor,
      snapshot: readable({}),
      unused: true,
      page,
    });
    // Last uploaded first; the orphan blob was stored long ago.
    expect(listed.items.map((item) => item.sha256)).toEqual([
      sha256(unused),
      sha256(attachedPdf),
      sha256(orphan),
    ]);
    expect(listed.items[0]).toMatchObject({
      fileName: 'unused.png',
      usedIn: [],
      languages: [],
      info: { contentType: 'image/png' },
    });
    const named = await action.handle({
      actor: editor,
      snapshot: readable({}),
      unused: true,
      query: 'UNUSED',
      page,
    });
    expect(named.items.map((item) => item.sha256)).toEqual([sha256(unused)]);
    const byHash = await action.handle({
      actor: editor,
      snapshot: readable({}),
      unused: true,
      query: sha256(orphan),
      page,
    });
    expect(byHash.items.map((item) => item.sha256)).toEqual([sha256(orphan)]);
    const inLanguage = await action.handle({
      actor: editor,
      snapshot: readable({}),
      unused: true,
      lang: 'en',
      page,
    });
    expect(inLanguage.total).toBe(0);
  });
});
