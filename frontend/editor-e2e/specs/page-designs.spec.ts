import type { Page } from '@playwright/test';

import { type Api, unique } from '../src/api.ts';
import { chooseSegment, expect, signIn, test, USERS } from '../src/fixtures.ts';

/** A design ID of the test's own (a slug), so no other test waits for its lock. */
const designId = (prefix: string) =>
  unique(prefix)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');

/** The working copy's save of the design, answered. */
const saved = (page: Page, id: string) =>
  page.waitForResponse(
    (r) =>
      r.request().method() === 'PUT' &&
      r.url().endsWith(`/page-designs/${id}/working-copy`),
  );

/** The preview's next rendering of a page with the design under edit. */
const rendered = (page: Page, id: string) =>
  page.waitForResponse((r) => {
    const url = new URL(r.url());
    return (
      /\/pdf\/pages\/\d+\.png$/.test(url.pathname) &&
      url.searchParams.get('design') === id &&
      url.searchParams.get('workingCopy') === 'true' &&
      r.status() === 200
    );
  });

/** The page boxes' and the rendered pages' height over width in the preview. */
async function previewRatios(
  page: Page,
): Promise<{ boxes: number[]; images: number[] }> {
  return page
    .locator('[data-slot="design-preview-pages"]')
    .evaluate((pages) => ({
      boxes: Array.from(pages.querySelectorAll('figure > div')).map((box) => {
        const { width, height } = box.getBoundingClientRect();
        return height / width;
      }),
      images: Array.from(pages.querySelectorAll('img')).map(
        (img) => img.naturalHeight / img.naturalWidth,
      ),
    }));
}

/**
 * A manual of the change set's own, a copy of the service manual with a long German title, so
 * the running header (the manual's title on the left) is cut short.
 */
async function longTitledManual(
  author: Api,
  changeSet: { id: string; baseCommit: string },
): Promise<{ id: string; title: string }> {
  const id = designId('handbuch');
  const title =
    'Betriebsanleitung für die Instandhaltung der Hochdruckreinigungsanlage mit Sicherheitsunterweisung und Wartungsplan';
  const { data } = await author.json(
    author.get(`/change-sets/${changeSet.id}/manuals/service/working-copy`),
  );
  await author.lock(changeSet.id, { type: 'manual', manualId: id });
  await author.json(
    author.send(
      'PUT',
      `/change-sets/${changeSet.id}/manuals/${id}/working-copy`,
      {
        data: {
          type: 'WorkingCopy',
          attributes: { content: { ...data.attributes.content, id, title } },
        },
        meta: { version: 0, baseCommit: changeSet.baseCommit },
      },
    ),
  );
  await author.savePoint(changeSet.id);
  return { id, title };
}

// Admin › Page design (`/admin/page-designs`, #392): the PDF's page designs, each edited in a
// revision of one's own with a live preview of a manual's title page and an inner page, and
// read-only (with why) for everyone else who reads drafts.
test.describe('page designs @area:admin @api:page-designs @api:manuals @api:change-sets', () => {
  test('makes a design, chooses a layout, changes a colour and sees the preview follow', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Page design'));
    const name = unique('E2E design');
    await signIn(page, USERS.author);
    // The list reads the designs once and pages them itself (#557).
    const listReads: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/page-designs') {
        listReads.push(r.url());
      }
    });
    const listed = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/page-designs',
    );
    await page.goto(`/admin/page-designs?cs=${changeSet.id}`);
    await expect(
      page.getByRole('heading', { name: 'Page design', level: 1 }),
    ).toBeVisible();
    await listed;
    // A second read would follow the first at once (the default's choice, the IDs taken).
    await page.waitForLoadState('networkidle');
    expect(listReads).toHaveLength(1);

    await page.getByRole('button', { name: 'New design' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
    const id = await dialog.getByRole('textbox', { name: 'ID' }).inputValue();
    expect(id).toMatch(/^e2e-design-/);
    await dialog.getByRole('button', { name: 'Create design' }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/page-designs/${id}\\?`));
    await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue(name);

    // The first rendering, at once: the title page and an inner page.
    const preview = page.locator('[data-slot="design-preview-pages"]');
    await expect(preview.locator('img')).toHaveCount(2, { timeout: 30_000 });

    // A layout: saved into the working copy, the preview renders it.
    const layout = page.getByRole('radiogroup', { name: 'Layout' });
    await expect(
      layout.getByRole('radio', { name: /Classic/ }),
    ).toHaveAttribute('aria-checked', 'true');
    const presetSaved = saved(page, id);
    const presetShown = rendered(page, id);
    await layout.getByRole('radio', { name: /Image-led/ }).click();
    expect((await presetSaved).status()).toBe(200);
    expect(
      (await presetSaved).request().postDataJSON().data.attributes.content
        .preset,
    ).toBe('image-led');
    await presetShown;
    await expect(
      layout.getByRole('radio', { name: /Image-led/ }),
    ).toHaveAttribute('aria-checked', 'true');

    // A colour too dark to read on white: the contrast warning, then the preview follows.
    const before = await preview.locator('img').first().getAttribute('src');
    const primary = page.locator('#pd-colour-primary');
    const colourSaved = saved(page, id);
    const colourShown = rendered(page, id);
    await primary.fill('#ffee00');
    await primary.press('Enter');
    const save = await colourSaved;
    expect(save.status()).toBe(200);
    expect(
      save.request().postDataJSON().data.attributes.content.colours.primary,
    ).toBe('#ffee00');
    await expect(page.locator('[data-contrast="primary"]')).toContainText(
      'too low for text',
    );
    await colourShown;
    await expect(preview.locator('img').first()).not.toHaveAttribute(
      'src',
      before ?? '',
    );

    // Undo puts the colour back, saved as well.
    const undone = saved(page, id);
    await page.getByRole('button', { name: 'Undo' }).click();
    expect(
      (await undone).request().postDataJSON().data.attributes.content.colours
        .primary,
    ).toBe('#1f4e79');
    await expect(primary).toHaveValue('#1f4e79');

    // The fixed safety settings, read-only with why.
    await expect(page.locator('[data-fixed="safety-colours"]')).toContainText(
      'cannot be changed',
    );

    // Listed in the revision, once there.
    await page.locator('[data-slot="designs-back"]').click();
    await expect(page.locator(`[data-design="${id}"]`)).toContainText(name);
  });

  test('warns that the running header is cut short for a manual with a long German title', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Long title'));
    const id = designId('long-head');
    await author.createPageDesign(changeSet, {
      id,
      name: unique('Long head'),
      preset: 'classic',
      header: { default: { left: [{ type: 'placeholder', key: 'title' }] } },
    });
    const manual = await longTitledManual(author, changeSet);

    await signIn(page, USERS.author);
    await page.goto(`/admin/page-designs/${id}?cs=${changeSet.id}`);
    await page.getByRole('combobox', { name: /^Manual:/ }).click();
    await page.getByRole('option', { name: manual.title }).click();
    await page.getByRole('combobox', { name: /^Language:/ }).click();
    await page.getByRole('option', { name: /\(de\)$/ }).click();

    const warnings = page.locator('[data-slot="layout-warnings"]');
    await expect(warnings.locator('[data-at^="header"]').first()).toContainText(
      'running header is cut short',
      { timeout: 30_000 },
    );
  });

  test('picks A5 for a short document: saved, and the preview takes its shape (#668)', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('A5 design'));
    const id = designId('leaflet');
    await author.createPageDesign(changeSet, { id, name: unique('Leaflet') });

    await signIn(page, USERS.author);
    await page.goto(`/admin/page-designs/${id}?cs=${changeSet.id}`);
    const preview = page.locator('[data-slot="design-preview-pages"]');
    await expect(preview.locator('img')).toHaveCount(2, { timeout: 30_000 });
    const size = page.getByRole('radiogroup', { name: 'Page size' });
    await expect(
      size.getByRole('radio', { name: 'A4', exact: true }),
    ).toBeChecked();

    const sizeSaved = saved(page, id);
    const shown = rendered(page, id);
    await chooseSegment(page, 'Page size', 'A5');
    const save = await sizeSaved;
    expect(save.status()).toBe(200);
    expect(
      save.request().postDataJSON().data.attributes.content.page.size,
    ).toBe('a5');
    await shown;
    await expect(
      size.getByRole('radio', { name: 'A5', exact: true }),
    ).toBeChecked();
    // A5 is 148 × 210 mm: the boxes at once, the rendered pages once they are in.
    await expect(async () => {
      const { boxes, images } = await previewRatios(page);
      expect(boxes).toHaveLength(2);
      // A4 is 1.414, A5 1.419: two places tell them apart.
      for (const ratio of boxes) expect(ratio).toBeCloseTo(210 / 148, 2);
      expect(images).toHaveLength(2);
      for (const ratio of images) expect(ratio).toBeCloseTo(210 / 148, 2);
    }).toPass({ timeout: 30_000 });
  });

  test('shows the design read-only, with why, to a reviewer, in someone else’s revision', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Reviewed design'));
    const id = designId('reviewed');
    await author.createPageDesign(changeSet, { id, name: unique('Reviewed') });

    await signIn(page, USERS.reviewer);
    await page.goto(`/admin/page-designs?cs=${changeSet.id}`);
    // Viewing needs only `content.read.draft`; making a design needs `content.edit`.
    await expect(page.getByRole('button', { name: 'New design' })).toHaveCount(
      0,
    );
    await page.locator(`[data-design="${id}"]`).click();
    await expect(page.locator('[data-slot="read-reason"]')).toContainText(
      'started by someone else',
    );
    await expect(page.locator('#pd-name-input')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);
  });
});

// A new design whose first save fails leaves no lock behind (#557): the screen releases the lock
// it took, so the ID can be used again at once, not only once the lock expires.
test.describe('page designs, a failed first save @area:admin @api:page-designs @api:change-sets', () => {
  test.use({
    consoleAllow: [/status of 503.*\/page-designs\/.*\/working-copy/],
  });

  test('releases the lock again, and the design can be made after all', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Failed design'));
    const name = unique('Failed design');
    let refuse = true;
    await page.route(
      (url) =>
        /\/api\/change-sets\/[^/]+\/page-designs\/[^/]+\/working-copy$/.test(
          url.pathname,
        ),
      (route) =>
        refuse && route.request().method() === 'PUT'
          ? route.fulfill({
              status: 503,
              contentType: 'application/vnd.api+json',
              body: JSON.stringify({
                errors: [{ status: '503', code: 'unavailable', title: 'Busy' }],
              }),
            })
          : route.fallback(),
    );
    await signIn(page, USERS.author);
    await page.goto(`/admin/page-designs?cs=${changeSet.id}`);
    await page.getByRole('button', { name: 'New design' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
    const id = await dialog.getByRole('textbox', { name: 'ID' }).inputValue();
    const released = page.waitForResponse(
      (r) =>
        r.request().method() === 'DELETE' &&
        /\/api\/locks\/[^/?]+\?ifUnchanged=true$/.test(r.url()),
    );
    await dialog.getByRole('button', { name: 'Create design' }).click();
    expect((await released).status()).toBe(204);
    await expect(
      page.getByText('The page design could not be created'),
    ).toBeVisible();
    await expect(dialog).toBeVisible();
    const { data } = await author.json(
      author.get(`/locks?filter[subject]=design/${id}`),
    );
    expect(data).toEqual([]);

    // The save goes through on a second try: no lock is in the way.
    refuse = false;
    await dialog.getByRole('button', { name: 'Create design' }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/page-designs/${id}\\?`));
    await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue(name);
  });
});

// Picking A5 when the save is refused (#668): the size the revision holds comes back, the
// person is told, and a retry saves it once the API takes it again.
test.describe('page designs, A5 refused @area:admin @api:page-designs @api:change-sets', () => {
  test.use({
    consoleAllow: [/status of 422.*\/page-designs\/.*\/working-copy/],
  });

  test('puts the size back, says so, and saves A5 on retry', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('A5 refused'));
    const id = designId('refused-a5');
    await author.createPageDesign(changeSet, { id, name: unique('Refused') });
    let refuse = true;
    await page.route(
      (url) =>
        url.pathname.endsWith(
          `/change-sets/${changeSet.id}/page-designs/${id}/working-copy`,
        ),
      (route) =>
        refuse && route.request().method() === 'PUT'
          ? route.fulfill({
              status: 422,
              contentType: 'application/vnd.api+json',
              body: JSON.stringify({
                errors: [
                  {
                    status: '422',
                    code: 'invalid-working-copy',
                    title: 'Invalid working copy',
                  },
                ],
              }),
            })
          : route.fallback(),
    );

    await signIn(page, USERS.author);
    await page.goto(`/admin/page-designs/${id}?cs=${changeSet.id}`);
    const size = page.getByRole('radiogroup', { name: 'Page size' });
    await expect(
      size.getByRole('radio', { name: 'A4', exact: true }),
    ).toBeChecked();

    const refused = saved(page, id);
    await chooseSegment(page, 'Page size', 'A5');
    expect((await refused).status()).toBe(422);
    await expect(
      page.getByText('The page design could not be saved'),
    ).toBeVisible();
    await expect(
      size.getByRole('radio', { name: 'A4', exact: true }),
    ).toBeChecked();

    refuse = false;
    const retried = saved(page, id);
    await page.getByRole('button', { name: 'Retry' }).click();
    const save = await retried;
    expect(save.status()).toBe(200);
    expect(
      save.request().postDataJSON().data.attributes.content.page.size,
    ).toBe('a5');
    await expect(
      size.getByRole('radio', { name: 'A5', exact: true }),
    ).toBeChecked();
  });
});
