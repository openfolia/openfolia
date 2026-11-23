// Its own file: it fills the branding's record up.
import sharp from 'sharp';
import type { Actor } from '../src/access/core/actor.js';
import { ErrorDocument, REQUEST_HEADER } from '../src/base/api/json-api.js';
import { BrandingImageDocument } from '../src/branding/api/branding.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

const brander: Actor = {
  ...actorWith(['admin.branding']),
  id: 'sample-brander',
};

/** A 1 × 1 PNG of its own colour per `n`: a different file each. */
const pixel = (n: number) =>
  sharp({
    create: {
      width: 1,
      height: 1,
      channels: 3,
      background: { r: n & 0xff, g: (n >> 8) & 0xff, b: 0 },
    },
  })
    .png()
    .toBuffer();

function upload(t: TestApp, file: Buffer) {
  t.actAs(brander);
  return t
    .post('/branding/images')
    .set('Content-Type', 'multipart/form-data')
    .set(REQUEST_HEADER, '1')
    .attach('file', file, 'logo.png');
}

async function uploaded(t: TestApp, file: Buffer): Promise<string> {
  const res = await upload(t, file);
  expect(res.status).toBe(201);
  return BrandingImageDocument.parse(res.body).data.id;
}

function remove(t: TestApp, hash: string) {
  t.actAs(brander);
  return t.delete(`/branding/images/${hash}`);
}

describe('branding uploads: the cap (#559)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t?.close());
  afterEach(() => t?.actAs(undefined));

  it('after 200 uploads, deleting an unused one makes room again', async () => {
    const hashes: string[] = [];
    for (let n = 0; n < 200; n++)
      hashes.push(await uploaded(t, await pixel(n)));
    const full = await upload(t, await pixel(1000));
    expect(full.status).toBe(409);
    expect(ErrorDocument.parse(full.body).errors[0]?.code).toBe(
      'too-many-uploads',
    );
    expect((await remove(t, hashes[0] ?? '')).status).toBe(204);
    expect((await upload(t, await pixel(1000))).status).toBe(201);
  }, 60_000);
});
