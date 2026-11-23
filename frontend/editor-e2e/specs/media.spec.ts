import { unique } from '../src/api.ts';
import { chooseSegment, expect, signIn, test, USERS } from '../src/fixtures.ts';

/** A 2×2 PNG of its own each time (the colour differs), so its hash is new. */
function png(): Buffer {
  const pixel = Math.floor(Math.random() * 0xffffff);
  // A tiny valid PNG made with zlib's stored blocks would need a CRC; build it with node's zlib.
  return makePng(2, 2, [(pixel >> 16) & 255, (pixel >> 8) & 255, pixel & 255]);
}

import { deflateSync } from 'node:zlib';
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function makePng(width: number, height: number, [r, g, b]: number[]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.from([
    0,
    ...Array.from({ length: width }, () => [r ?? 0, g ?? 0, b ?? 0]).flat(),
  ]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// The media library (`/media`): upload, the unused filter, delete with undo.
test.describe('media library @area:media @api:assets @api:blobs', () => {
  test('uploads an image into a revision; a fresh upload is neither unused nor deletable yet', async ({
    page,
    api,
  }) => {
    const changeSet = await (
      await api(USERS.author)
    ).createChangeSet(unique('Media'));
    const name = `${unique('photo').replace(/\s/g, '-')}.png`;
    await signIn(page, USERS.author);
    await page.goto(`/media?cs=${changeSet.id}&view=table`);

    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Upload' }).click(),
    ]);
    await chooser.setFiles({ name, mimeType: 'image/png', buffer: png() });
    await expect(
      page.getByText(`${name} uploaded into the revision.`),
    ).toBeVisible();

    const files = page.getByRole('region', { name: 'Files' });
    await expect(files.getByText(name).first()).toBeVisible();

    // Its preview shows at once, in the table and in the grid (#468), from the revision's own
    // copy of the upload: no module names it yet.
    const preview = (scope: typeof files) =>
      expect(scope.locator('img')).toHaveJSProperty('complete', true);
    const row = files.locator('[data-slot="media-row"]', { hasText: name });
    await preview(row);
    await expect(row.locator('img')).toHaveJSProperty('naturalWidth', 2);
    await chooseSegment(page, 'View', 'Grid');
    const tile = files.getByRole('option', { name });
    await preview(tile);
    await expect(tile.locator('img')).toHaveJSProperty('naturalWidth', 2);
    await chooseSegment(page, 'View', 'Table');

    // A fresh upload is not "unused" yet: that filter waits a day, and says so.
    await page.getByRole('button', { name: 'Usage: All' }).click();
    await page.getByRole('menuitemradio', { name: /Unused/ }).click();
    await expect(
      files.getByText(/uploaded within the last 24 hours/),
    ).toBeVisible();
    await files.getByRole('button', { name: 'Reset filters' }).click();

    // Its details say why it cannot be deleted yet: it belongs to the open revision. (Delete
    // with Undo needs a file unused for a day, which a fresh stack does not have.)
    await files.getByRole('button', { name, exact: true }).click();
    const details = page.getByRole('complementary', { name: 'File details' });
    await expect(
      details.getByRole('heading', { level: 2, name }),
    ).toBeVisible();
    await expect(
      details.getByText(
        /can’t be deleted: it was uploaded into the open revision/,
      ),
    ).toBeVisible();
    await expect(
      details.getByRole('button', { name: `Delete ${name}` }),
    ).toHaveCount(0);
  });
});
