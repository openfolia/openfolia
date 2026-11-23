import { deflateSync } from 'node:zlib';

import { type Api, unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

// Translations › a manual's cover image text (#656): a row of the status matrix of its own, its
// cell's panel with each cover image's text as plain text, a way to the manual, and the chosen
// rows named by kind. Everything is the flow's own: a manual (a copy of the service manual) with
// a cover image in a revision of its own, so neither the matrix on main nor its jobs change.

const slug = (prefix: string) =>
  unique(prefix)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');

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
/** A 4×3 PNG of a colour of its own, so its hash is new. */
function png(): Buffer {
  const pixel = Math.floor(Math.random() * 0xffffff);
  const rgb = [(pixel >> 16) & 255, (pixel >> 8) & 255, pixel & 255];
  const header = Buffer.alloc(13);
  header.writeUInt32BE(4, 0);
  header.writeUInt32BE(3, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.from([0, ...Array.from({ length: 4 }, () => rgb).flat()]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat([row, row, row]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A manual of the change set's own with a cover image whose text looks like markup. */
async function ownManual(
  admin: Api,
  changeSet: { id: string; baseCommit: string },
  alt: string,
): Promise<{ id: string; title: string }> {
  const asset = await admin.uploadImage(changeSet.id, png());
  const id = slug('cover-text');
  const title = unique('Cover text manual');
  const { data } = await admin.json(
    admin.get(`/change-sets/${changeSet.id}/manuals/service/working-copy`),
  );
  await admin.lock(changeSet.id, { type: 'manual', manualId: id });
  await admin.json(
    admin.send(
      'PUT',
      `/change-sets/${changeSet.id}/manuals/${id}/working-copy`,
      {
        data: {
          type: 'WorkingCopy',
          attributes: {
            content: {
              ...data.attributes.content,
              id,
              title,
              coverImage: { default: { asset, alt }, variants: [] },
            },
          },
        },
        meta: { version: 0, baseCommit: changeSet.baseCommit },
      },
    ),
  );
  await admin.savePoint(changeSet.id);
  return { id, title };
}

test.describe('cover image text translations @area:translations @area:manuals @api:translations @api:manuals', () => {
  test('a manual’s cover image text is a row of the matrix, its panel showing the text as text', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const changeSet = await admin.createChangeSet(unique('Cover text'));
    const alt = 'The vehicle <b>#set</b>';
    const manual = await ownManual(admin, changeSet, alt);

    await signIn(page, USERS.translator);
    await page.goto(
      `/translations?cs=${changeSet.id}&lang=de&q=${encodeURIComponent(manual.title)}`,
    );
    const row = page.locator(`[data-row="manuals/${manual.id}"]`);
    await expect(row.getByRole('link', { name: manual.title })).toHaveAttribute(
      'href',
      new RegExp(`/manuals\\?.*manual=${manual.id}`),
    );
    await expect(row.locator('[data-slot="manual-kind"]')).toContainText(
      'Manual text',
    );

    // Chosen: the count names what it is.
    await row.locator('[data-slot="choose-row"]').click();
    await expect(page.locator('[data-slot="chosen-count"]')).toHaveText(
      '1 manual’s text chosen',
    );

    await row.locator(`[data-cell="de/manuals/${manual.id}"]`).click();
    const panel = page.locator('[data-slot="cell-panel"]');
    await expect(
      panel.getByRole('heading', { name: manual.title }),
    ).toBeVisible();
    const unit = panel.locator('[data-block="coverImage.default"]');
    await expect(unit.locator('[data-slot="block-label"]')).toHaveText(
      'The manual’s cover image',
    );
    // The markup-like text is shown as it is, never as markup.
    await expect(unit.locator('[data-slot="block-source"]')).toHaveText(alt);
    await expect(unit.locator('b')).toHaveCount(0);
    const open = panel.locator('[data-slot="open-manual"]');
    await expect(open).toHaveText(/Open the manual/);
    await expect(open).toHaveAttribute(
      'href',
      new RegExp(`/manuals\\?.*manual=${manual.id}`),
    );
  });

  test.describe('refused', () => {
    test.use({ consoleAllow: [/status of 404/] });

    test('a manual that is not there opens an error in the panel', async ({
      page,
    }) => {
      await signIn(page, USERS.translator);
      await page.goto('/translations?cell=de/manuals/no-such-manual');
      const panel = page.locator('[data-slot="cell-panel"]');
      await expect(panel.getByRole('alert').first()).toBeVisible();
    });
  });
});
