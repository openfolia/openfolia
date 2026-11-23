import type { Page } from '@playwright/test';

import { unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

/** A design ID of the test's own (a slug), so no other test waits for its lock. */
const designId = (prefix: string) =>
  unique(prefix)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');

/** The first save of `what`'s working copy from now on whose content `holds` (its JSON), answered. */
const savedWith = (
  page: Page,
  what: string,
  holds: (content: never) => boolean,
) =>
  page.waitForResponse(
    (r) =>
      r.request().method() === 'PUT' &&
      r.url().endsWith(`/${what}/working-copy`) &&
      r.ok() &&
      holds(r.request().postDataJSON().data.attributes.content as never),
  );

// Admin › Project settings › Manufacturer, and a page design's back page (#395): the details the
// back page prints, kept in the revision's configuration; a website that is no address said and
// not saved; the back page turned on and put on the inside of the title page.
test.describe('back page and manufacturer @area:admin @api:page-designs @api:config @api:change-sets', () => {
  test('enters the manufacturer, refuses a website that is no address, and puts the back page inside the cover', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const changeSet = await admin.createChangeSet(unique('Back page'));
    const id = designId('back-page');
    await admin.createPageDesign(changeSet, {
      id,
      name: unique('Imprint'),
      preset: 'classic',
    });
    // Another flow's revision may hold the configuration's lock a few seconds (the releases'
    // `ownProduct` merges one): take it for this revision first, trying until it is free.
    await expect(async () => {
      await admin.lock(changeSet.id, { type: 'config' });
    }).toPass({ timeout: 30_000 });

    await signIn(page, USERS.admin);
    await page.goto(`/admin/settings/manufacturer?cs=${changeSet.id}`);
    const form = page.locator('[data-slot="manufacturer"]');
    const name = form.getByLabel('Name', { exact: true });
    await expect(name).toBeEditable();

    // A contact without a name: said, nothing saved until the name is there.
    await form.getByLabel('Contact', { exact: true }).fill('info@example.com');
    await form.getByLabel('Contact', { exact: true }).blur();
    await expect(page.locator('[data-slot="manufacturer-problem"]')).toHaveText(
      /A name is needed/,
    );
    const named = savedWith(
      page,
      'config',
      (c: { manufacturer?: { name: string } }) =>
        c.manufacturer?.name === 'Example Works Ltd',
    );
    await name.fill('Example Works Ltd');
    await name.blur();
    await named;
    await expect(
      page.locator('[data-slot="manufacturer-problem"]'),
    ).toHaveCount(0);
    const addressed = savedWith(
      page,
      'config',
      (c: { manufacturer?: { address: string[] } }) =>
        c.manufacturer?.address.length === 2,
    );
    const address = form.getByLabel('Address', { exact: true });
    await address.fill('1 Sample Street\n12345 Sample Town');
    await address.blur();
    expect(
      (await (await addressed).request().postDataJSON()).data.attributes.content
        .manufacturer,
    ).toEqual({
      name: 'Example Works Ltd',
      address: ['1 Sample Street', '12345 Sample Town'],
      contact: 'info@example.com',
    });

    // A website without its scheme is no address: said at the field, not saved.
    const website = form.getByLabel('Website', { exact: true });
    await website.fill('example.com');
    await website.blur();
    await expect(website).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('[data-slot="manufacturer-problem"]')).toHaveText(
      /full address/,
    );
    const linked = savedWith(
      page,
      'config',
      (c: { manufacturer?: { website?: string } }) =>
        c.manufacturer?.website === 'https://example.com',
    );
    await website.fill('https://example.com');
    await website.blur();
    await linked;
    await expect(website).not.toHaveAttribute('aria-invalid', 'true');

    // The check: every manual warns while there are no details.
    const checked = savedWith(
      page,
      'config',
      (c: { release?: { checkManufacturer?: boolean } }) =>
        c.release?.checkManufacturer === true,
    );
    await page
      .locator('[data-slot="manufacturer-check"]')
      .getByRole('switch')
      .click();
    await checked;

    // A save point puts them in the revision's commit, where the design is checked against them.
    await admin.savePoint(changeSet.id);

    // The design's back page prints them.
    await page.goto(`/admin/page-designs/${id}?cs=${changeSet.id}`);
    const back = page.locator('[data-section="back-page"]');
    await expect(
      back.getByRole('heading', { name: 'Back page' }),
    ).toBeVisible();
    const on = savedWith(
      page,
      `page-designs/${id}`,
      (d: { backPage?: unknown }) => d.backPage !== undefined,
    );
    await back.getByRole('switch', { name: 'Print a back page' }).click();
    await on;
    await expect(back.locator('[data-slot="manufacturer-name"]')).toHaveText(
      'Example Works Ltd',
    );
    await expect(
      back.locator('[data-issue="missing-manufacturer"]'),
    ).toHaveCount(0);
    const inside = savedWith(
      page,
      `page-designs/${id}`,
      (d: { backPage?: { position: string } }) =>
        d.backPage?.position === 'inside-cover',
    );
    await back
      .getByRole('radiogroup', { name: 'Where it goes' })
      .getByText('Inside the cover')
      .click();
    await inside;
    await expect(back).toContainText('On the back of the title page');

    // Read again: the back page stays inside the cover.
    await page.reload();
    await expect(
      back
        .getByRole('radiogroup', { name: 'Where it goes' })
        .getByRole('radio', { name: 'Inside the cover' }),
    ).toBeChecked();
  });
});
