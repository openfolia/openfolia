import type { BrowserContext, Page } from '@playwright/test';
import {
  expect,
  openAccountMenu,
  signIn,
  test,
  USERS,
} from '../src/fixtures.ts';

/**
 * The docs site this stack's API names (`GET /about`, `docsUrl`), read as the editor reads it;
 * its pages are answered by a stub in the browser, so no flow leaves the machine.
 */
async function docsSite(
  page: Page,
  context: BrowserContext,
  path: string,
): Promise<string> {
  const about = page.waitForResponse((r) => r.url().endsWith('/api/about'));
  await page.goto(path);
  const body = (await (await about).json()) as {
    data: { attributes: { docsUrl: string | null } };
  };
  const docsUrl = body.data.attributes.docsUrl;
  expect(docsUrl).toMatch(/^https?:\/\/.+\/$/);
  await context.route(`${docsUrl}**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>User guide</title><p>Guide page</p>',
    }),
  );
  return docsUrl ?? '';
}

/** The page a link opens in a new tab. */
async function opens(page: Page, click: () => Promise<void>): Promise<string> {
  const popup = page.waitForEvent('popup');
  await click();
  const opened = await popup;
  await opened.waitForLoadState();
  const url = opened.url();
  await opened.close();
  return url;
}

// In-app help (#221): each screen's guide page, the palette's Help group, the shortcut overlay.
test.describe('in-app help @area:shell @area:search @api:about', () => {
  test('a screen’s help link opens its page of the user guide, in English and in German', async ({
    page,
    context,
  }) => {
    await signIn(page, USERS.author);
    const docs = await docsSite(page, context, '/content');
    const help = page.getByRole('link', {
      name: 'Help: Find a module (opens in a new tab)',
    });
    await expect(help).toHaveAttribute(
      'href',
      `${docs}guide/writing/content-browser`,
    );
    await expect(help).toHaveAttribute('target', '_blank');
    expect(await opens(page, () => help.click())).toBe(
      `${docs}guide/writing/content-browser`,
    );

    // Another screen, its own page.
    await page.goto('/releases');
    await expect(
      page.getByRole('link', { name: /^Help: Cut a release/ }),
    ).toHaveAttribute('href', `${docs}guide/releases/overview`);

    // In German: the German page, its German title.
    await openAccountMenu(page, 'Sample Author');
    await page.getByRole('menuitemradio', { name: 'Deutsch' }).click();
    await page.keyboard.press('Escape');
    // The screen's link follows the language at once, before any reload.
    await expect(
      page.getByRole('link', {
        name: /^Hilfe: Eine Veröffentlichung erstellen/,
      }),
    ).toHaveAttribute('href', `${docs}de/guide/releases/overview`);
    await page.goto('/content');
    const hilfe = page.getByRole('link', {
      name: 'Hilfe: Ein Modul finden (öffnet in einem neuen Tab)',
    });
    await expect(hilfe).toHaveAttribute(
      'href',
      `${docs}de/guide/writing/content-browser`,
    );

    // The account menu opens the screen's page too.
    await openAccountMenu(page, 'Sample Author');
    expect(
      await opens(page, () =>
        page.getByRole('menuitem', { name: 'Hilfe zu dieser Seite' }).click(),
      ),
    ).toBe(`${docs}de/guide/writing/content-browser`);
  });

  test('the sign-in page links to signing in', async ({ page, context }) => {
    const docs = await docsSite(page, context, '/content');
    await expect(page).toHaveURL(/\/sign-in/);
    await expect(
      page.getByRole('link', { name: /^Help: Sign in/ }),
    ).toHaveAttribute('href', `${docs}guide/getting-started/sign-in`);
  });

  test('the palette’s Help group finds a guide page by a word that is not in its title', async ({
    page,
    context,
  }) => {
    await signIn(page, USERS.author);
    const docs = await docsSite(page, context, '/content');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Content' }),
    ).toBeVisible();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog');
    // "XLIFF" is in the summary of "Send a delta export", not in its title.
    await palette
      .getByRole('combobox', { name: /Search modules/ })
      .fill('xliff');
    const option = palette.getByRole('option', { name: /Send a delta export/ });
    await expect(option).toContainText('User guide');
    expect(await opens(page, () => option.click())).toBe(
      `${docs}guide/translations/export`,
    );
    await expect(palette).toBeHidden();

    // A word no guide page has: no Help group.
    await page.keyboard.press('Control+k');
    await palette
      .getByRole('combobox', { name: /Search modules/ })
      .fill('zzqx-nothing');
    await expect(palette.getByText(/Nothing found/).first()).toBeVisible();
    await expect(
      palette.getByRole('option', { name: /User guide/ }),
    ).toHaveCount(0);
  });

  test('? and the account menu open the shortcut overlay, made from the shortcut catalogue', async ({
    page,
    context,
  }) => {
    await signIn(page, USERS.author);
    const docs = await docsSite(page, context, '/content');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Content' }),
    ).toBeVisible();

    await page.keyboard.press('?');
    const overlay = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(overlay).toBeVisible();
    const palette = overlay.locator('[data-shortcut="palette"]');
    await expect(palette).toContainText('Open or close the search palette');
    // The suite's browser reports a non-Apple platform.
    await expect(palette.locator('kbd')).toHaveText(['Ctrl', 'K']);
    await expect(overlay.locator('[data-shortcut="redo"] kbd')).toHaveText([
      'Ctrl',
      'Shift',
      'Z',
      'Ctrl',
      'Y',
    ]);
    await expect(
      overlay.getByRole('heading', { name: 'Reviewing changes' }),
    ).toBeVisible();
    await expect(
      overlay.getByRole('link', {
        name: 'Keyboard shortcuts in the user guide',
      }),
    ).toHaveAttribute('href', `${docs}guide/reference/shortcuts`);
    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden();

    // `?` typed into a field is text.
    const search = page.getByRole('searchbox').first();
    await search.fill('');
    await search.press('?');
    await expect(overlay).toBeHidden();
    await expect(search).toHaveValue('?');

    await openAccountMenu(page, 'Sample Author');
    await page.getByRole('menuitem', { name: /Keyboard shortcuts/ }).click();
    await expect(overlay).toBeVisible();
  });

  test('with the help links turned off, no screen, menu or palette links to the guide', async ({
    page,
  }) => {
    await signIn(page, USERS.author);
    // The operator's `CCMS_DOCS_URL=off`, for this page only: the stack's API is shared.
    await page.route('**/api/about', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        data: { attributes: Record<string, unknown> };
      };
      body.data.attributes['docsUrl'] = null;
      await route.fulfill({ response, json: body });
    });
    const about = page.waitForResponse((r) => r.url().endsWith('/api/about'));
    await page.goto('/content');
    await about;
    await expect(
      page.getByRole('heading', { level: 1, name: 'Content' }),
    ).toBeVisible();
    await expect(page.locator('[data-slot="page-help"]')).toHaveCount(0);

    await openAccountMenu(page, 'Sample Author');
    await expect(
      page.getByRole('menuitem', { name: /Keyboard shortcuts/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('menuitem', { name: 'Help for this page' }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog');
    await palette
      .getByRole('combobox', { name: /Search modules/ })
      .fill('xliff');
    await expect(palette.getByText(/Nothing found/).first()).toBeVisible();
    await expect(
      palette.getByRole('option', { name: /Send a delta export/ }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();

    // At once, while the palette's exit animation still runs.
    await page.keyboard.press('?');
    const overlay = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(overlay).toBeVisible();
    await expect(overlay.getByRole('link')).toHaveCount(0);
  });
});
