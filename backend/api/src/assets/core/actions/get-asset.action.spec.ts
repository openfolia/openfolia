import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import type { Module } from '@openfolia/content-model';
import { FakeBlobStore } from '../../../../tests/fakes/fake-blob-store.js';
import {
  fakeRenditions,
  RENDITION_SETTINGS,
} from '../../../../tests/fakes/fake-asset-renditions.js';
import { actorWith, READER } from '../../../../tests/fakes/actors.js';
import { module, readable } from '../../../../tests/fakes/fake-content.js';
import { NotFoundError } from '../../../base/core/errors.js';
import { GetAssetAction } from './get-asset.action.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0]);
const blobs = new FakeBlobStore();
const action = new GetAssetAction(
  blobs,
  fakeRenditions(blobs).service,
  RENDITION_SETTINGS,
);
const read = async (asset: { stream: Readable }) => buffer(asset.stream);

/** A module showing the images `hashes`. */
const showing = (id: string, lang: string, ...hashes: string[]): Module => ({
  ...module(id, lang),
  blocks: hashes.map((hash, n) => ({
    type: 'image',
    id: `image-${n}`,
    asset: `sha256:${hash}`,
    alt: 'An image',
  })),
});

const content = {
  modules: [
    showing('pictures', 'en', 'png', 'svg'),
    showing('bild', 'de', 'de-only'),
  ],
  assets: {
    png: PNG,
    svg: new TextEncoder().encode('<svg></svg>'),
    'de-only': PNG,
    unreferenced: PNG,
  },
};

describe('GetAssetAction', () => {
  const snapshot = readable(content);

  it('returns the data with the type sniffed from the content', async () => {
    const png = await action.handle({ actor: READER, snapshot, hash: 'png' });
    expect(png).toMatchObject({ type: 'image/png', size: PNG.byteLength });
    expect(new Uint8Array(await read(png))).toEqual(PNG);
    expect(
      (await action.handle({ actor: READER, snapshot, hash: 'svg' })).type,
    ).toBe('image/svg+xml');
  });

  it('is not found for an unknown hash, or one no module refers to', async () => {
    for (const hash of ['nope', 'unreferenced']) {
      await expect(
        action.handle({ actor: READER, snapshot, hash }),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it('serves only images a module the reader may see refers to', async () => {
    const german = actorWith(['content.read'], { languages: ['de'] });
    const scoped = readable(content, german);
    const found = await action.handle({
      actor: german,
      snapshot: scoped,
      hash: 'de-only',
    });
    expect(new Uint8Array(await read(found))).toEqual(PNG);
    await expect(
      action.handle({ actor: german, snapshot: scoped, hash: 'png' }),
    ).rejects.toThrow('No asset "png".');
  });

  describe('from the blob store', () => {
    const bytes = new TextEncoder().encode('stored image bytes');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const withStored = {
      modules: [showing('pictures', 'en', hash), showing('bild', 'de')],
      assets: {},
    };

    beforeAll(async () => {
      await blobs.put(Readable.from([bytes]), {
        contentType: 'image/webp',
        maxBytes: 1_000,
      });
    });

    it('streams a stored image with its stored type', async () => {
      const asset = await action.handle({
        actor: READER,
        snapshot: readable(withStored),
        hash,
      });
      expect(asset).toMatchObject({ type: 'image/webp', size: bytes.length });
      expect(new Uint8Array(await read(asset))).toEqual(bytes);
    });

    it('never serves a stored image no visible module refers to', async () => {
      const german = actorWith(['content.read'], { languages: ['de'] });
      await expect(
        action.handle({
          actor: german,
          snapshot: readable(withStored, german),
          hash,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        action.handle({ actor: READER, snapshot: readable(content), hash }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('is unavailable, not missing, while the store is down', async () => {
      blobs.down = true;
      try {
        await expect(
          action.handle({
            actor: READER,
            snapshot: readable(withStored),
            hash,
          }),
        ).rejects.toMatchObject({ code: 'blob-store-unavailable' });
      } finally {
        blobs.down = false;
      }
    });
  });
});

describe('GetAssetAction, attachments', () => {
  const attaching = (
    id: string,
    lang: string,
    hash: string,
    fileName: string,
  ): Module => ({
    ...module(id, lang),
    blocks: [
      {
        type: 'attachment',
        id: 'file',
        asset: `sha256:${hash}`,
        name: 'Configuration',
        fileName,
        mediaType: 'application/zip',
        size: 9,
      },
    ],
  });

  it('sends an attached file as a download named by the first attachment block', async () => {
    const snapshot = readable({
      modules: [
        attaching('b-second', 'en', 'zip', 'second.zip'),
        attaching('a-first', 'en', 'zip', 'first.zip'),
        showing('pictures', 'en', 'png'),
      ],
      assets: { zip: ZIP, png: PNG },
    });
    const zip = await action.handle({ actor: READER, snapshot, hash: 'zip' });
    expect(zip.download).toEqual({ fileName: 'first.zip' });
    zip.stream.destroy();
    const png = await action.handle({ actor: READER, snapshot, hash: 'png' });
    expect(png.download).toBeUndefined();
    png.stream.destroy();
  });

  it('downloads a file an image shows too, when an attachment attaches it', async () => {
    const snapshot = readable({
      modules: [
        showing('a-pictures', 'en', 'png'),
        attaching('b-files', 'en', 'png', 'photo.png'),
      ],
      assets: { png: PNG },
    });
    const png = await action.handle({ actor: READER, snapshot, hash: 'png' });
    expect(png.download).toEqual({ fileName: 'photo.png' });
    png.stream.destroy();
  });

  it('never offers a file under a name a block gives it that does not fit what is stored', async () => {
    const bytes = Buffer.concat([Buffer.from(ZIP), Buffer.from('named')]);
    const { sha256: zip } = await blobs.put(Readable.from([bytes]), {
      contentType: 'application/zip',
      maxBytes: 1_000,
    });
    const named = (...fileNames: string[]) =>
      readable({
        modules: fileNames.map((fileName, n) =>
          attaching(`m-${n}`, 'en', zip, fileName),
        ),
        assets: {},
      });
    for (const [names, expected] of [
      [['evil.html'], {}],
      [['x.svg', 'logo.png', 'run.exe'], {}],
      [['evil.html', 'config.zip'], { fileName: 'config.zip' }],
      [['report.docx'], { fileName: 'report.docx' }],
      [['settings'], { fileName: 'settings' }],
      [['notes.cfg'], { fileName: 'notes.cfg' }],
    ] as const) {
      const asset = await action.handle({
        actor: READER,
        snapshot: named(...names),
        hash: zip,
      });
      expect(asset.type).toBe('application/zip');
      expect(asset.download).toEqual(expected);
      asset.stream.destroy();
    }
  });
});
