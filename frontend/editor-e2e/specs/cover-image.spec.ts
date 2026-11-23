import { deflateSync } from 'node:zlib';

import type { Page } from '@playwright/test';

import { type Api, unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

// A manual's cover image (#394), in the manual builder's settings: chosen from an upload into the
// revision, its alternative text required before it is saved and translatable, and the media
// library naming the manual as using it. Everything is the flow's own: a design, a manual (a copy
// of the service manual) and a revision; main is not changed.

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

/** An image-led design and a manual using it, both the change set's own. */
async function ownManual(
  admin: Api,
  changeSet: { id: string; baseCommit: string },
): Promise<{ id: string; title: string }> {
  const design = { id: slug('cover-design'), name: unique('Cover design') };
  await admin.createPageDesign(changeSet, { ...design, preset: 'image-led' });
  const id = slug('cover-manual');
  const title = unique('Cover manual');
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
              design: design.id,
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

/** The manual's working copy saved, answered: its cover image as sent. */
async function savedCover(
  page: Page,
  manual: string,
  act: () => Promise<void>,
) {
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === 'PUT' &&
      r.url().endsWith(`/manuals/${manual}/working-copy`),
  );
  await act();
  const answer = await saved;
  expect(answer.status()).toBe(200);
  return answer.request().postDataJSON().data.attributes.content.coverImage;
}

test.describe('a manual’s cover image @area:manuals @area:media @api:manuals @api:assets', () => {
  test('is chosen from an upload, waits for its alternative text, is translated, and counts as a use in the media library', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const changeSet = await admin.createChangeSet(unique('Cover image'));
    const manual = await ownManual(admin, changeSet);
    await signIn(page, USERS.admin);
    await page.goto(`/manuals?manual=${manual.id}&cs=${changeSet.id}`);
    await page.getByTestId('settings-open').click();
    const settings = page.getByTestId('settings-cover');
    const own = settings.locator('[data-cover="manual"]');
    await expect(own.getByTestId('cover-status')).toHaveText(
      "The design's image, if any",
    );

    // Choose: an upload into the revision, chosen in the image dialog.
    await own.getByRole('button', { name: /Choose a cover image/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Choose an image' });
    const name = `${slug('cover')}.png`;
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      dialog.getByRole('button', { name: 'Upload' }).click(),
    ]);
    await chooser.setFiles({ name, mimeType: 'image/png', buffer: png() });
    const choose = dialog.getByRole('button', { name: 'Choose', exact: true });
    await expect(choose).toBeEnabled();
    await choose.click();
    await expect(dialog).toBeHidden();

    // Nothing is saved without the alternative text.
    const pending = own.getByTestId('cover-pending');
    const use = pending.getByRole('button', { name: 'Use image' });
    await expect(use).toBeDisabled();
    await pending
      .getByRole('textbox', { name: 'Alternative text (English)' })
      .fill('The lifter from the front');
    const cover = await savedCover(page, manual.id, () => use.click());
    expect(cover.default.alt).toEqual({ en: 'The lifter from the front' });
    expect(cover.default.asset).toMatch(/^sha256:[0-9a-f]{64}$/);
    await expect(own.getByTestId('cover-status')).toHaveText('Its own image');

    // The source language's text may not be emptied: refused, said, and put back.
    const english = own.getByRole('textbox', {
      name: 'Alternative text (English)',
    });
    await english.fill('');
    await english.blur();
    await expect(own.getByTestId('cover-alt-error')).toContainText(
      'Describe the image in English',
    );
    await expect(english).toHaveValue('The lifter from the front');

    // Another language's text is saved beside it.
    const german = own.getByRole('textbox', {
      name: 'Alternative text (German)',
    });
    const translated = await savedCover(page, manual.id, async () => {
      await german.fill('Der Heber von vorn');
      await german.blur();
    });
    expect(translated.default.alt).toEqual({
      en: 'The lifter from the front',
      de: 'Der Heber von vorn',
    });

    // In the media library, the manual uses it.
    await admin.savePoint(changeSet.id);
    await page.goto(`/media?cs=${changeSet.id}&view=table`);
    const files = page.getByRole('region', { name: 'Files' });
    const row = files.locator('[data-slot="media-row"]', { hasText: name });
    await expect(row.getByText('Used', { exact: true })).toBeVisible();
    await files.getByRole('button', { name, exact: true }).click();
    const details = page.getByRole('complementary', { name: 'File details' });
    const usedBy = details.locator('[data-slot="usage-manuals"]');
    await expect(usedBy).toContainText('Cover image of');
    await expect(
      usedBy.getByRole('link', { name: manual.title }),
    ).toBeVisible();
  });
});
