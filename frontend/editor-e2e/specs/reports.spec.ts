import { type Locator } from '@playwright/test';

import { expect, signIn, test, USERS } from '../src/fixtures.ts';

/**
 * Whether the select's chosen value shows in full, not cut off with an ellipsis: its text is no
 * wider than its box. Measured unrounded, as a fraction of a pixel already cuts it.
 */
const showsInFull = (select: Locator) =>
  select.locator('[data-slot="select-value"] span').evaluate((value) => {
    const text = document.createRange();
    text.selectNodeContents(value);
    return (
      text.getBoundingClientRect().width <=
      value.getBoundingClientRect().width + 0.05
    );
  });

// The Reports page's filters (#694): the Language filter shows "All languages" in full.
test.describe('reports @area:translations @api:reports', () => {
  test('the translation report’s filters show their values in full', async ({
    page,
  }) => {
    await signIn(page, USERS.admin);
    await page.goto('/reports/translations');
    const language = page.locator('[data-filter="lang"] button');
    await expect(language).toContainText('All languages');
    expect(await showsInFull(language)).toBe(true);
    const manual = page.locator('[data-filter="manual"] button');
    await expect(manual).toContainText('All manuals');
    expect(await showsInFull(manual)).toBe(true);
  });

  test.describe('when the report cannot be read', () => {
    test.use({
      consoleAllow: [/status of 503.*\/api\/reports\/translations/],
    });

    test('says why, its filters still in full', async ({ page }) => {
      await page.route(
        (url) => url.pathname === '/api/reports/translations',
        (route) =>
          route.fulfill({
            status: 503,
            contentType: 'application/vnd.api+json',
            body: JSON.stringify({
              errors: [
                {
                  status: '503',
                  title: 'Service Unavailable',
                  detail: 'The database is not available.',
                  code: 'database-unavailable',
                },
              ],
            }),
          }),
      );
      await signIn(page, USERS.admin);
      await page.goto('/reports/translations');
      await expect(
        page.getByText('The database is not available. Try again in a moment.'),
      ).toBeVisible();
      const language = page.locator('[data-filter="lang"] button');
      await expect(language).toContainText('All languages');
      expect(await showsInFull(language)).toBe(true);
    });
  });
});
