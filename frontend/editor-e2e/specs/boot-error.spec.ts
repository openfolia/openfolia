import type { Page } from '@playwright/test';
import {
  expect,
  expectNoSideways,
  openSidebar,
  signIn,
  test,
  USERS,
} from '../src/fixtures.ts';

// The start-up's error state (#870, frontend/editor/src/index.html): when the editor's own files
// do not load (a launcher's 429, a network blip), the page shows a calm error with a retry in
// place of an empty page; once the first screen is open, it is never shown.

/** Answers the editor's build files (main-<hash>.js, chunk-<hash>.js) with `status` until undone. */
async function failCode(page: Page, status: number, only = /\/main-/) {
  const pattern = /\/(?:main|chunk)-[A-Za-z0-9_-]{8}\.js$/;
  const handler = (route: Parameters<Parameters<Page['route']>[1]>[0]) =>
    only.test(route.request().url())
      ? route.fulfill({ status, contentType: 'application/json', body: '{}' })
      : route.continue();
  await page.route(pattern, handler);
  return () => page.unroute(pattern, handler);
}

test.describe('start-up error state @area:shell @narrow', () => {
  test.use({ consoleAllow: [/status of (429|503)/] });

  test('shows a calm error when the editor’s code does not load, and opens it on a retry', async ({
    page,
  }) => {
    await signIn(page, USERS.author);
    const undo = await failCode(page, 429);
    await page.goto('/content');

    const error = page.getByRole('alert');
    await expect(
      error.getByRole('heading', { level: 1, name: 'The editor didn’t load' }),
    ).toBeVisible();
    await expect(error).toContainText('Nothing you saved is lost.');
    await expect(error.getByRole('heading', { level: 1 })).toBeFocused();
    await expectNoSideways(page);

    await undo();
    await error.getByRole('button', { name: 'Try again' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Content' }),
    ).toBeVisible();
    await expect(page.locator('#of-boot-error')).toBeHidden();
  });

  test('speaks the chosen language, in the chosen theme, when a chunk fails', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('of-language', 'de');
      localStorage.setItem('of-theme', 'dark');
    });
    await signIn(page, USERS.author);
    await failCode(page, 503, /\/chunk-/);
    await page.goto('/content');

    const error = page.getByRole('alert');
    await expect(
      error.getByRole('heading', {
        level: 1,
        name: 'Der Editor wurde nicht geladen',
      }),
    ).toBeVisible();
    await expect(
      error.getByRole('button', { name: 'Erneut versuchen' }),
    ).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await expect(page.locator('#of-boot-error')).toHaveAttribute('lang', 'de');
  });

  test.describe('once the editor is open', () => {
    // One pattern: a list of two would be read as Playwright's [value, options].
    test.use({
      consoleAllow: [
        /status of 503|Failed to fetch dynamically imported module/,
      ],
    });

    test('stays out of the way once the editor is open', async ({ page }) => {
      await signIn(page, USERS.author);
      await page.goto('/content');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Content' }),
      ).toBeVisible();
      // A screen's code that fails later is that screen's own error, never the start-up's.
      await failCode(page, 503, /\/chunk-/);
      await openSidebar(page);
      await page.getByRole('link', { name: 'Manuals' }).first().click();
      await expect(page.locator('#of-boot-error')).toBeHidden();
      await expect(page.locator('of-root')).toBeVisible();
    });
  });
});
