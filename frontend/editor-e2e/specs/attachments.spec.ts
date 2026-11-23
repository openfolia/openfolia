import type { Page } from '@playwright/test';
import { moduleId, paragraph, unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

/** Opens Insert › Attachment from a new paragraph after the module's text. */
async function openAttachDialog(page: Page, title: string, after: string) {
  await page
    .getByRole('textbox', { name: `Module ${title}` })
    .getByText(after)
    .click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/attac');
  await page.getByRole('option', { name: /Attachment/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Attach file' });
  const pagination = dialog.locator('[data-slot="list-pagination"]');
  const none = dialog.getByRole('heading', { name: 'No files yet' });
  await expect(pagination.or(none)).toBeVisible();
  // The list's total, as its pagination says it; none while the list is empty.
  const found = /\((\d+) in total\)/.exec(
    (await none.isVisible()) ? '(0 in total)' : await pagination.innerText(),
  );
  expect(found).not.toBeNull();
  return { dialog, pagination, before: Number(found![1]) };
}

// Insert › Attachment (the attach-file dialog) in the module editor, in a revision of its own.
test.describe('attachments @area:module-editor @api:assets @api:change-sets', () => {
  test('an upload is counted in the list’s total, its size in bytes, and inserted (#690)', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Attach'));
    const id = moduleId();
    await author.createModule(changeSet, {
      lang: 'en',
      moduleId: id,
      title: 'Charger settings',
      blocks: [paragraph('p1', 'Download the settings.')],
    });
    await signIn(page, USERS.author);
    await page.goto(`/content/en/${id}?cs=${changeSet.id}`);
    await expect(page.getByText('Locked by you')).toBeVisible();
    const { dialog, pagination, before } = await openAttachDialog(
      page,
      'Charger settings',
      'Download the settings.',
    );

    const fileName = `${unique('settings').replace(/\s/g, '-')}.txt`;
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      dialog.getByRole('button', { name: 'Upload' }).click(),
    ]);
    await chooser.setFiles({
      name: fileName,
      mimeType: 'text/plain',
      buffer: Buffer.from('x'.repeat(68)),
    });
    const row = dialog.getByRole('radio', { name: new RegExp(fileName) });
    await expect(row).toContainText('68 bytes');
    await expect(dialog.getByText('Uploading…')).toHaveCount(0);
    await expect(pagination).toContainText(`(${before + 1} in total)`);

    await dialog.locator('#attachment-name').fill('Charger settings file');
    await dialog.getByRole('button', { name: 'Insert' }).click();
    await expect(dialog).toBeHidden();
    const block = page.locator('of-attachment-node').first();
    await expect(block.getByText('Charger settings file')).toBeVisible();
    await expect(block).toContainText('68 bytes');
  });

  test.describe('refused', () => {
    test.use({ consoleAllow: [/status of 422/] });

    test('a refused upload is taken back: neither a row nor counted', async ({
      page,
      api,
    }) => {
      const author = await api(USERS.author);
      const changeSet = await author.createChangeSet(unique('Attach refused'));
      const id = moduleId();
      await author.createModule(changeSet, {
        lang: 'en',
        moduleId: id,
        title: 'Setup program',
        blocks: [paragraph('p1', 'Run the setup.')],
      });
      await signIn(page, USERS.author);
      await page.goto(`/content/en/${id}?cs=${changeSet.id}`);
      await expect(page.getByText('Locked by you')).toBeVisible();
      const { dialog, pagination, before } = await openAttachDialog(
        page,
        'Setup program',
        'Run the setup.',
      );
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        dialog.getByRole('button', { name: 'Upload' }).click(),
      ]);
      const refused = page.waitForResponse(
        (r) =>
          r.url().includes(`/change-sets/${changeSet.id}/assets`) &&
          r.request().method() === 'POST',
      );
      await chooser.setFiles({
        name: 'setup.exe',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from('MZ\x90\x00\x03\x00\x00\x00'),
      });
      expect((await refused).status()).toBe(422);
      await expect(
        page.getByText(/Files of this type can run code/),
      ).toBeVisible();
      await expect(
        dialog.getByRole('radio', { name: /setup\.exe/ }),
      ).toHaveCount(0);
      // The list as it was: empty, or its total unchanged.
      await expect(
        before === 0
          ? dialog.getByRole('heading', { name: 'No files yet' })
          : pagination,
      ).toContainText(before === 0 ? 'No files yet' : `(${before} in total)`);
    });
  });
});
