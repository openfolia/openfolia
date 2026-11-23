import type { Page } from '@playwright/test';

import { renamedFont, themeFont } from '../src/fonts.ts';
import { unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

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

const LICENCE =
  'This Font Software is licensed under the SIL Open Font License, Version 1.1.';

// Admin › Page design, the fonts (#555): an uploaded font is picked for the headings, its licence
// shown, and the preview uses it. All in the flow's own design and draft.
test.describe('page design fonts @area:admin @api:assets @api:page-designs', () => {
  // The file that is no font is refused on purpose.
  test.use({ consoleAllow: [/status of 422.*\/assets\?kind=font/] });

  test('uploads a font, picks it for the headings, and the preview uses it', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Fonts'));
    const id = designId('fonts');
    await author.createPageDesign(changeSet, { id, name: unique('Fonts') });
    // A family nothing else has: the theme's Geist (SIL OFL 1.1, no reserved name), renamed.
    const family = unique('Flow Sans').replace(/[^A-Za-z0-9 ]/g, ' ');
    const font = Buffer.from(
      renamedFont(themeFont('ttf/Geist-Regular.ttf'), family, {
        copyright: 'Copyright 2026 The Geist Project Authors',
        licence: LICENCE,
      }),
    );

    await signIn(page, USERS.author);
    await page.goto(`/admin/page-designs/${id}?cs=${changeSet.id}`);
    const fonts = page.locator('[data-section="fonts"]');
    const preview = page.locator('[data-slot="design-preview-pages"]');
    await expect(preview.locator('img')).toHaveCount(2, { timeout: 30_000 });

    // A file that is no font: refused, said so, nothing listed.
    await fonts.locator('[data-slot="font-upload-input"]').setInputFiles({
      name: 'notes.ttf',
      mimeType: 'font/ttf',
      buffer: Buffer.from('These are notes, not a font.'),
    });
    await expect(
      page.getByText(/notes\.ttf could not be uploaded: .*no font/),
    ).toBeVisible();

    // The font: uploaded, offered for the headings with its licence.
    const posted = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        r.url().includes('/assets?kind=font') &&
        r.status() === 201,
      { timeout: 30_000 },
    );
    await fonts.locator('[data-slot="font-upload-input"]').setInputFiles({
      name: 'flow-sans.ttf',
      mimeType: 'font/ttf',
      buffer: font,
    });
    await posted;
    await expect(page.getByText('flow-sans.ttf is uploaded.')).toBeVisible();
    const fontSaved = saved(page, id);
    await fonts.locator('[data-slot="font-pick-heading"]').click();
    await page.getByRole('option', { name: family }).click();
    const content = (await fontSaved).request().postDataJSON().data
      .attributes.content;
    expect(content.fonts.heading).toEqual({
      family,
      regular: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    const heading = fonts.locator('[data-font="heading"]');
    await expect(heading.locator('[data-slot="font-faces"]')).toContainText(
      'Regular',
    );
    await expect(
      heading.locator('[data-slot="font-licence-text"]'),
    ).toContainText('SIL Open Font License');

    // Confirming the licence embeds it: the preview renders again with the font.
    const before = await preview.locator('img').first().getAttribute('src');
    const confirmed = saved(page, id);
    const shown = rendered(page, id);
    await fonts.locator('[data-slot="fonts-licence"]').click();
    expect(
      (await confirmed).request().postDataJSON().data.attributes.content.fonts
        .embeddingAllowed,
    ).toBe(true);
    await shown;
    await expect(preview.locator('img').first()).not.toHaveAttribute(
      'src',
      before ?? '',
    );
    // The PDF itself: `design-fonts.e2e.spec.ts` (the API) and the page sketch in
    // `render-typst`'s `design.spec.ts`; no shared manual is changed here.
  });
});
