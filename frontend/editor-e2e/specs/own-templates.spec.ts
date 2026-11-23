import type { Page } from '@playwright/test';

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

// Admin › Page design, an own template (#396): the sample content's `example` and `broken`
// templates (`SAMPLE_TEMPLATES`, read only) are chosen for the flow's own design in its own draft;
// the broken one's error is shown with its file and line, and the example renders again.
test.describe('page design own templates @area:admin @api:page-designs @api:manuals', () => {
  // The broken template is refused on purpose: its preview pages answer 422.
  test.use({ consoleAllow: [/status of 422.*\/pdf\/pages\//] });

  test('chooses a template, sees its error with file and line, and chooses one that compiles', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Template'));
    const id = designId('template');
    await author.createPageDesign(changeSet, {
      id,
      name: unique('Template'),
      preset: 'classic',
    });

    await signIn(page, USERS.author);
    await page.goto(`/admin/page-designs/${id}?cs=${changeSet.id}`);
    const layout = page.locator('[data-section="layout"]');
    const preview = page.locator('[data-slot="design-preview-pages"]');
    await expect(preview.locator('img')).toHaveCount(2, { timeout: 30_000 });
    const select = layout.locator('[data-slot="template-select"]');
    await expect(select).toContainText("The layout's template");

    // The broken template: saved into the design, its error where the pages were.
    const broken = saved(page, id);
    await select.click();
    await page.getByRole('option', { name: 'broken', exact: true }).click();
    expect(
      (await broken).request().postDataJSON().data.attributes.content.template,
    ).toBe('broken');
    const problems = page.locator('[data-slot="template-problems"]');
    await expect(problems).toBeVisible({ timeout: 30_000 });
    await expect(problems).toContainText(
      'The template broken does not compile',
    );
    await expect(
      problems.locator('[data-slot="template-problem"]').first(),
    ).toContainText(/templates\/broken\/manual\.typ, line \d+, column \d+:/);
    await expect(preview.locator('img')).toHaveCount(0);

    // The example template: it compiles, the pages are back and the error is gone.
    const example = saved(page, id);
    await select.click();
    await page.getByRole('option', { name: 'example', exact: true }).click();
    expect(
      (await example).request().postDataJSON().data.attributes.content.template,
    ).toBe('example');
    await expect(preview.locator('img')).toHaveCount(2, { timeout: 30_000 });
    await expect(problems).toBeHidden();

    // None of its own: the layout's template again, and nothing named.
    const none = saved(page, id);
    await select.click();
    await page.getByRole('option', { name: "The layout's template" }).click();
    expect(
      (await none).request().postDataJSON().data.attributes.content,
    ).not.toHaveProperty('template');
  });
});
