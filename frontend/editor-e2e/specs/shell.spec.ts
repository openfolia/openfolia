import type { Locator, Page } from '@playwright/test';
import {
  expect,
  expectNoSideways,
  openAccountMenu,
  signIn,
  test,
  USERS,
} from '../src/fixtures.ts';

// Sign-in and the shell: sidebar, account menu (user switch, theme, language), search palette.
test.describe('shell @area:shell @narrow', () => {
  test('signs in on the sign-in page, then switches the user in the account menu', async ({
    page,
  }) => {
    await page.goto('/content');
    await expect(page).toHaveURL(/\/sign-in\?returnUrl=%2Fcontent/);
    await page.getByRole('button', { name: /Sample Author/ }).click();

    await expect(page).toHaveURL(/\/content$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Content' }),
    ).toBeVisible();
    await expectNoSideways(page);

    await openAccountMenu(page, 'Sample Author');
    await page.getByRole('menuitemradio', { name: /Sample Reviewer/ }).click();
    await page.keyboard.press('Escape');
    await openAccountMenu(page, 'Sample Reviewer');
    await expect(
      page.getByRole('menuitemradio', { name: /Sample Reviewer/ }),
    ).toBeChecked();
  });

  test('switches the theme and the language from the account menu', async ({
    page,
  }) => {
    await signIn(page, USERS.author);
    await page.goto('/content');
    await openAccountMenu(page, 'Sample Author');
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await page.keyboard.press('Escape');
    await expectNoSideways(page);

    await openAccountMenu(page, 'Sample Author');
    await page.getByRole('menuitemradio', { name: 'Deutsch' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Inhalte' }),
    ).toBeVisible();
    // Both choices outlive a reload.
    await page.reload();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Inhalte' }),
    ).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  });
});

test.describe('shell @area:shell @area:search', () => {
  test('the search palette opens with the keyboard and goes to a module', async ({
    page,
  }) => {
    await signIn(page, USERS.author);
    await page.goto('/content');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Content' }),
    ).toBeVisible();

    // The suite's browser reports a non-Apple platform: Ctrl+K.
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog');
    await palette
      .getByRole('combobox', { name: /Search modules/ })
      .fill('Charging');
    await palette
      .getByRole('option', { name: /Charging/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/content\/en\/charging/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Charging' }),
    ).toBeVisible();
  });

  test('a reader without admin rights sees no access on Admin', async ({
    page,
  }) => {
    await signIn(page, USERS.reader);
    await page.goto('/admin/users');
    await expect(
      page.getByRole('heading', { name: 'No access' }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: 'Admin' }),
    ).toHaveCount(0);
  });
});

/** A box once it stopped moving: the sidebar's width runs for 200 ms after a toggle. */
async function settledBox(target: Locator) {
  let last = '';
  await expect
    .poll(async () => {
      const found = await target.boundingBox();
      expect(found, 'the element has a box').not.toBeNull();
      const box = JSON.stringify(found);
      const same = box === last;
      last = box;
      return same;
    })
    .toBe(true);
  return JSON.parse(last) as { x: number; y: number; width: number };
}

/** The computed opacity of `target`, once its transition (if any) has ended. */
function opacityOf(target: Locator) {
  return target.evaluate((el) => getComputedStyle(el).opacity);
}

/** The two layers of the collapsed mark, logo first, stacked in the button's one cell. */
function markLayers(page: Page) {
  const mark = page
    .locator('z-sidebar')
    .getByRole('button', { name: 'Expand sidebar' });
  const layers = mark.locator(':scope > span');
  return { mark, logo: layers.nth(0), icon: layers.nth(1) };
}

// The sidebar's header (#484): the logo and the expand icon crossfade, nothing jumps.
test.describe('shell @area:shell', () => {
  test('the collapsed mark crossfades into the expand icon and expands the sidebar', async ({
    page,
  }) => {
    await signIn(page, USERS.author);
    await page.goto('/content');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Content' }),
    ).toBeVisible();
    const search = page.locator('of-search-trigger button');
    const expandedSearch = await settledBox(search);

    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    const { mark, logo, icon } = markLayers(page);
    await expect(mark).toBeVisible();
    // The header keeps its height: the search field below it stays where it was.
    expect((await settledBox(search)).y).toBe(expandedSearch.y);

    // Both layers stay in the layout, the icon only faded out.
    const before = await settledBox(mark);
    expect(await logo.boundingBox()).not.toBeNull();
    expect(await icon.boundingBox()).not.toBeNull();
    await expect.poll(() => opacityOf(logo)).toBe('1');
    await expect.poll(() => opacityOf(icon)).toBe('0');

    await mark.hover();
    await expect.poll(() => opacityOf(icon)).toBe('1');
    await expect.poll(() => opacityOf(logo)).toBe('0');
    expect(await mark.boundingBox()).toEqual(before);

    await page.mouse.move(800, 600);
    await expect.poll(() => opacityOf(icon)).toBe('0');
    await expect.poll(() => opacityOf(logo)).toBe('1');

    await mark.click();
    await expect(page.locator('z-sidebar')).toHaveAttribute(
      'data-state',
      'expanded',
    );
    await expect(
      page.getByRole('button', { name: 'Collapse sidebar' }),
    ).toBeVisible();
    // The collapsed mark has faded out and is out of reach.
    const markLayer = page.locator('[data-header="mark"]');
    await expect(markLayer).toHaveAttribute('inert', '');
    await expect.poll(() => opacityOf(markLayer)).toBe('0');
    expect((await settledBox(search)).y).toBe(expandedSearch.y);
  });

  test('the keyboard reaches the expand icon, and focus follows the toggle', async ({
    page,
  }) => {
    await signIn(page, USERS.author);
    await page.goto('/content');
    const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
    await collapse.focus();
    await page.keyboard.press('Enter');

    // Focus moves to the mark, which shows the expand icon while focused.
    const { mark, logo, icon } = markLayers(page);
    await expect(mark).toBeFocused();
    await expect.poll(() => opacityOf(icon)).toBe('1');
    await expect.poll(() => opacityOf(logo)).toBe('0');

    await page.keyboard.press('Enter');
    await expect(collapse).toBeFocused();
  });

  test('with reduced motion, the swap has no transition', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signIn(page, USERS.author);
    await page.goto('/review');
    const { mark, logo, icon } = markLayers(page);
    await expect(mark).toBeVisible();
    for (const layer of [
      logo,
      icon,
      page.locator('[data-header="mark"]'),
      page.locator('[data-header="full"]'),
    ]) {
      expect(
        await layer.evaluate((el) => getComputedStyle(el).transitionProperty),
      ).toBe('none');
    }
    await mark.hover();
    // No transition: the icon is there at once.
    expect(await opacityOf(icon)).toBe('1');
  });
});
