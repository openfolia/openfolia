import { expect, test } from '@playwright/test';
import { OPERATING, site } from './sites.ts';

/**
 * The copy button on code blocks (#895): one real button per literal block, copying the block's
 * exact text, saying so, and falling back to selecting the text when the clipboard is refused.
 */

const CONFIG = 'charger:\n  mode: fast\n\n  limit: 80';

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
});

const clipboard = (page: import('@playwright/test').Page) =>
  page.evaluate(() => navigator.clipboard.readText());

test('copies the block’s exact text, says so and clears again', async ({
  page,
}) => {
  await page.goto(site('public', OPERATING('en')));
  const block = page.locator('.code-copy', {
    has: page.locator('#of-charging--config'),
  });
  const button = block.getByRole('button', { name: 'Copy code' });
  await expect(button).toBeEnabled();
  await button.click();
  expect(await clipboard(page)).toBe(CONFIG);
  await expect(button).toHaveAttribute('data-state', 'copied');
  await expect(block.getByRole('status')).toHaveText('Copied');
  await expect(button).not.toHaveAttribute('data-state', 'copied', {
    timeout: 4_000,
  });
  await expect(block.getByRole('status')).toHaveText('');
});

test('Tab reaches the button and Enter copies', async ({ page }) => {
  await page.goto(site('public', OPERATING('en')));
  const block = page.locator('.code-copy', {
    has: page.locator('#of-charging--config'),
  });
  const button = block.getByRole('button', { name: 'Copy code' });
  await button.focus();
  await expect(button).toBeVisible();
  await expect(button).toHaveCSS('opacity', '1');
  await page.keyboard.press('Enter');
  expect(await clipboard(page)).toBe(CONFIG);
  await expect(button).toHaveAttribute('data-state', 'copied');
});

test('speaks German on a German page', async ({ page }) => {
  await page.goto(site('public', OPERATING('de')));
  await expect(
    page.getByRole('button', { name: 'Code kopieren' }).first(),
  ).toBeAttached();
});

test('a long line scrolls inside the block and the button stays put', async ({
  page,
}) => {
  await page.goto(site('public', OPERATING('en')));
  const block = page.locator('.code-copy', {
    has: page.locator('#of-charging--long'),
  });
  const pre = block.locator('pre');
  const button = block.getByRole('button', { name: 'Copy code' });
  expect(await pre.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  await pre.hover();
  const before = await button.boundingBox();
  await pre.evaluate((e) => (e.scrollLeft = 200));
  expect(await button.boundingBox()).toEqual(before);
});

test('the idle button is a square with its icon centred', async ({ page }) => {
  await page.goto(site('public', OPERATING('en')));
  const button = page
    .locator('.code-copy', { has: page.locator('#of-charging--config') })
    .getByRole('button', { name: 'Copy code' });
  await button.focus();
  // Both boxes in one frame: focusing scrolls the page smoothly, so two reads could disagree.
  const { box, icon } = await button.evaluate((b) => ({
    box: b.getBoundingClientRect().toJSON() as DOMRect,
    icon: b
      .querySelector('.code-copy__icon--copy')!
      .getBoundingClientRect()
      .toJSON() as DOMRect,
  }));
  expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(0.5);
  expect(
    Math.abs(icon.x + icon.width / 2 - (box.x + box.width / 2)),
  ).toBeLessThanOrEqual(0.5);
  expect(
    Math.abs(icon.y + icon.height / 2 - (box.y + box.height / 2)),
  ).toBeLessThanOrEqual(0.5);
});

test('a refused clipboard says so and selects the text', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
  });
  await page.goto(site('public', OPERATING('en')));
  const block = page.locator('.code-copy', {
    has: page.locator('#of-charging--config'),
  });
  const button = block.getByRole('button', { name: 'Copy code' });
  await button.click();
  await expect(button).toHaveAttribute('data-state', 'failed');
  await expect(block.getByRole('status')).toHaveText(
    /Press Ctrl\+C|Copy failed/,
  );
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    CONFIG,
  );
});

test('the button is not printed', async ({ page }) => {
  await page.goto(site('public', OPERATING('en')));
  await page.emulateMedia({ media: 'print' });
  await expect(
    page.getByRole('button', { name: 'Copy code' }).first(),
  ).toBeHidden();
});
