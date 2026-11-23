import { createHash } from 'node:crypto';
import { buffer } from 'node:stream/consumers';
import type { Module } from '@openfolia/content-model';
import { actorWith, READER } from '../../../tests/fakes/actors.js';
import {
  fakeRenditions,
  RecordingImageResizer,
  RENDITION_SETTINGS,
} from '../../../tests/fakes/fake-asset-renditions.js';
import { FakeBlobStore } from '../../../tests/fakes/fake-blob-store.js';
import { module, readable } from '../../../tests/fakes/fake-content.js';
import {
  InvalidParameterError,
  NotFoundError,
  UnavailableError,
  UnprocessableError,
} from '../../base/core/errors.js';
import { GetAssetAction } from './actions/get-asset.action.js';
import { TIMED_OUT_KEPT_MS } from './renditions.js';
import type { ImageResizer } from './image-resizer.js';

const sha256 = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

const showing = (id: string, lang: string, ...hashes: string[]): Module => ({
  ...module(id, lang),
  blocks: hashes.map((h, n) => ({
    type: 'image',
    id: `image-${n}`,
    asset: `sha256:${h}`,
    alt: 'An image',
  })),
});

function setUp(options: { resizer?: ImageResizer; concurrency?: number } = {}) {
  const blobs = new FakeBlobStore();
  const resizer = options.resizer ?? new RecordingImageResizer();
  const { service, renditions } = fakeRenditions(blobs, {
    resizer,
    settings: {
      ...RENDITION_SETTINGS,
      concurrency: options.concurrency ?? 2,
    },
  });
  const action = new GetAssetAction(blobs, service, RENDITION_SETTINGS);
  const store = (data: Buffer, contentType: string) =>
    blobs.blobs.set(sha256(data), { data, contentType });
  return { action, blobs, renditions, resizer, service, store };
}

describe('Renditions (GET /assets/:hash?width=)', () => {
  const png = sha256(PNG);
  const svg = sha256(SVG);
  const snapshot = readable({
    modules: [showing('a', 'en', png, svg), showing('b', 'de', 'f'.repeat(64))],
  });

  it('makes a WebP on the first request and serves it from the store after', async () => {
    const { action, blobs, renditions, resizer, store } = setUp();
    store(PNG, 'image/png');
    const first = await action.handle({
      actor: READER,
      snapshot,
      hash: png,
      width: 640,
    });
    expect(first.type).toBe('image/webp');
    const bytes = await buffer(first.stream);
    expect(bytes.toString()).toBe(`RIFF....WEBP 640 of ${PNG.length}`);
    expect(renditions.renditions).toEqual([
      expect.objectContaining({
        sourceSha256: png,
        width: 640,
        sha256: sha256(bytes),
      }),
    ]);
    expect(blobs.blobs.get(sha256(bytes))?.contentType).toBe('image/webp');
    const second = await action.handle({
      actor: READER,
      snapshot,
      hash: png,
      width: 640,
    });
    expect((await buffer(second.stream)).equals(bytes)).toBe(true);
    // Made once; another width is another rendition.
    expect((resizer as RecordingImageResizer).calls).toHaveLength(1);
    await action.handle({ actor: READER, snapshot, hash: png, width: 320 });
    expect((resizer as RecordingImageResizer).calls).toHaveLength(2);
  });

  it('makes one rendition for requests at the same time', async () => {
    const { action, resizer, store } = setUp();
    store(PNG, 'image/png');
    await Promise.all(
      [1, 2, 3].map(() =>
        action.handle({ actor: READER, snapshot, hash: png, width: 1280 }),
      ),
    );
    expect((resizer as RecordingImageResizer).calls).toHaveLength(1);
  });

  it('is 404 outside the reader’s scope, like the original, before anything is read', async () => {
    const { action, resizer, store } = setUp();
    store(PNG, 'image/png');
    const german = actorWith(['content.read'], { languages: ['de'] });
    await expect(
      action.handle({
        actor: german,
        snapshot: readable(
          { modules: [showing('a', 'en', png), showing('b', 'de')] },
          german,
        ),
        hash: png,
        width: 320,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((resizer as RecordingImageResizer).calls).toEqual([]);
  });

  it('has none for an SVG or another non-image (400 invalid-parameter)', async () => {
    const { action, store } = setUp();
    store(SVG, 'image/svg+xml');
    const refused = await action
      .handle({ actor: READER, snapshot, hash: svg, width: 320 })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(InvalidParameterError);
    expect(refused).toMatchObject({ parameter: 'width' });
  });

  it('does not try a source that failed again for a while', async () => {
    const resizer = new RecordingImageResizer();
    resizer.failure = new UnprocessableError('unprocessable-image', 'no');
    const { action, store } = setUp({ resizer });
    store(PNG, 'image/png');
    for (const width of [320, 640] as const) {
      await expect(
        action.handle({ actor: READER, snapshot, hash: png, width }),
      ).rejects.toMatchObject({ code: 'unprocessable-image' });
    }
    expect(resizer.calls).toHaveLength(1);
  });

  it('does not try a source that timed out again for a shorter while', async () => {
    const resizer = new RecordingImageResizer();
    resizer.failure = new UnavailableError('rendition-timeout', 'slow', 30);
    const { action, service, store } = setUp({ resizer });
    let now = Date.now();
    service.now = () => now;
    store(PNG, 'image/png');
    const ask = () =>
      expect(
        action.handle({ actor: READER, snapshot, hash: png, width: 320 }),
      ).rejects.toMatchObject({ code: 'rendition-timeout' });
    await ask();
    await ask();
    expect(resizer.calls).toHaveLength(1);
    now += TIMED_OUT_KEPT_MS + 1;
    await ask();
    expect(resizer.calls).toHaveLength(2);
  });

  it('refuses past its queue (503 rendition-busy)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    class Slow extends RecordingImageResizer {
      override async toWebp(source: Uint8Array, width: number) {
        await gate;
        return super.toWebp(source, width);
      }
    }
    const { action, blobs } = setUp({ resizer: new Slow(), concurrency: 1 });
    const hashes = Array.from({ length: 7 }, (_, n) => {
      const data = Buffer.concat([PNG, Buffer.from([n])]);
      blobs.blobs.set(sha256(data), { data, contentType: 'image/png' });
      return sha256(data);
    });
    const many = readable({ modules: [showing('a', 'en', ...hashes)] });
    const results = hashes.map((hash) =>
      action.handle({ actor: READER, snapshot: many, hash, width: 320 }).then(
        () => 'made',
        (e: unknown) => e,
      ),
    );
    // One at work, four waiting, the rest refused.
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const outcomes = await Promise.all(results);
    expect(outcomes.filter((o) => o === 'made')).toHaveLength(5);
    for (const refused of outcomes.filter((o) => o !== 'made')) {
      expect(refused).toBeInstanceOf(UnavailableError);
      expect(refused).toMatchObject({ code: 'rendition-busy' });
    }
  });
});
