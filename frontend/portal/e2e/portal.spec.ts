import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  INTERNAL_CANARY,
  PUBLIC_WORD,
  RESTRICTED_CANARY,
} from '../testing/fixture-repo.ts';
import { BRAND_NAME, BRAND_PRIMARY } from '../testing/fixture-brand.ts';
import { OPERATING, site } from './sites.ts';

/**
 * The portal in the browser, on the built fixture sites: the manual list and its filters, a
 * manual, search, the language switch and light and dark mode. Every page loads without a
 * console error (a blocked script or style under the Content Security Policy is one) and never
 * scrolls sideways.
 */

const errors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const seen: string[] = [];
  errors.set(page, seen);
  page.on('console', (message) => {
    if (message.type() === 'error') seen.push(message.text());
  });
  page.on('pageerror', (error) => seen.push(error.message));
});

/** Opens a `details` that starts closed on narrow screens. */
const openDisclosure = async (panel: Locator) => {
  await expect(panel).toBeVisible();
  if (!(await panel.evaluate((d: HTMLDetailsElement) => d.open)))
    await panel.locator('summary').click();
  await expect(panel).toHaveAttribute('open', '');
};

test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
  const sideways = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(sideways).toBeLessThanOrEqual(0);
});

test('the start page leads with search and lists each product’s manuals', async ({
  page,
}) => {
  await page.goto(site('public', 'en/'));
  await expect(
    page.getByRole('heading', { level: 1, name: 'Documentation' }),
  ).toBeVisible();
  for (const product of ['Alpha', 'Beta'])
    await expect(
      page.getByRole('heading', { level: 2, name: product }),
    ).toBeVisible();
  // The public site is built with the branding off: the default marks, no brand colours.
  await expect(page.locator('link[href$="brand.css"]')).toHaveCount(0);
  await expect(page.locator('.brand__logo')).toHaveCount(0);

  // With the typeahead the field is a combobox; Enter with no row chosen searches.
  const field = page.getByRole('combobox', { name: 'Search all manuals' });
  await field.fill(PUBLIC_WORD);
  await field.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/en/search/\\?q=${PUBLIC_WORD}$`));
  await expect(page.locator('.result').first()).toBeVisible();
});

test('the internal site shows the organisation’s branding', async ({
  page,
}, info) => {
  await page.goto(site('internal', 'en/'));
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    'href',
    /\/assets\/[0-9a-f]{64}\.png$/,
  );
  await expect(
    page.getByRole('heading', { level: 1, name: BRAND_NAME }),
  ).toBeVisible();
  const dark = info.project.use.colorScheme === 'dark';
  const logo = page.locator(`.brand__logo--${dark ? 'dark' : 'light'}`);
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute('alt', BRAND_NAME);
  await expect(
    page.locator(`.brand__logo--${dark ? 'light' : 'dark'}`),
  ).toBeHidden();
  // The brand's colour is the primary in light mode (the dark one is derived from it).
  if (!dark)
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--primary')
          .trim(),
      ),
    ).toBe(BRAND_PRIMARY);
});

test('the manual list filters by product and variant, scrolling inside its own frame', async ({
  page,
}) => {
  await page.goto(site('public', 'en/manuals/'));
  await expect(
    page.getByRole('heading', { level: 1, name: 'All manuals' }),
  ).toBeVisible();
  // On a phone the filters start closed, behind one button.
  await openDisclosure(page.locator('[data-filters-panel]'));
  const rows = page.locator('.row:visible');
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole('main').getByRole('status')).toHaveText(
    '2 manuals',
  );

  await page.getByRole('combobox', { name: 'Product' }).selectOption('beta');
  await expect(rows).toHaveCount(1);
  await expect(page.getByRole('main').getByRole('status')).toHaveText(
    '1 manual',
  );
  await expect(rows.first()).toContainText('Beta');

  await page.getByRole('combobox', { name: 'Product' }).selectOption('');
  await page.getByRole('combobox', { name: 'Model' }).selectOption('small');
  await expect(rows).toHaveCount(2);
  await expect(
    page.locator('.row__variants li[data-values]:visible'),
  ).toHaveCount(2);
  await expect(
    page.locator('.row__variants li[data-values]:visible').first(),
  ).toHaveText('Small · Battery');

  await page.getByLabel('Title contains').fill('nothing like it');
  await expect(rows).toHaveCount(0);
  await expect(
    page.getByText('No manual matches these filters.'),
  ).toBeVisible();

  // The page itself never scrolls: the list does, inside its frame.
  const page_ = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight,
  );
  expect(page_).toBeLessThanOrEqual(1);
  await expect(page.locator('[data-list]')).toHaveCSS('overflow-y', 'auto');
});

test('a product link on the start page opens the list on that product', async ({
  page,
}) => {
  await page.goto(site('public', 'en/manuals/?product=beta'));
  await expect(page.getByRole('main').getByRole('status')).toHaveText(
    '1 manual',
  );
  await openDisclosure(page.locator('[data-filters-panel]'));
  await expect(page.getByRole('combobox', { name: 'Product' })).toHaveValue(
    'beta',
  );
});

test('a manual shows its public modules, its variants and its contents', async ({
  page,
}) => {
  await page.goto(site('public', OPERATING('en')));
  await expect(
    page.getByRole('heading', { level: 1, name: 'Operating manual' }),
  ).toBeVisible();
  await expect(page.getByText('The Model A docks itself')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(INTERNAL_CANARY);
  await expect(page.locator('body')).not.toContainText(RESTRICTED_CANARY);
  // The safety symbol is the PNG the build drew from its SVG.
  const symbol = page.getByRole('img', { name: 'General warning' });
  await expect(symbol).toHaveAttribute('src', /\/assets\/[0-9a-f]{64}\.png$/);
  expect(
    await symbol.evaluate((img: HTMLImageElement) => img.naturalWidth),
  ).toBeGreaterThan(0);

  const variants = page.getByRole('navigation', { name: 'Variants' });
  await expect(variants.getByRole('link', { name: 'Large' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await variants.getByRole('link', { name: 'Small' }).click();
  await expect(page).toHaveURL(/model=small,power=battery\/$/);
  await expect(variants.getByRole('link', { name: 'Small' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(page.getByText('The Model B docks itself')).toBeVisible();

  // On a phone the contents start closed, a panel to open.
  const contents = page.getByRole('navigation', { name: 'Contents' });
  await openDisclosure(page.locator('[data-toc]'));
  await expect(contents).toBeVisible();
  await contents.getByRole('link', { name: 'Glossary' }).click();
  await expect(
    page.getByRole('heading', { name: 'Glossary' }),
  ).toBeInViewport();
  // The contents mark where the reader is.
  await expect(
    contents.getByRole('link', { name: 'Glossary' }),
  ).toHaveAttribute('aria-current', 'location');
});

test('the variant switch says when a combination is not published, before and after the click', async ({
  page,
}) => {
  // Small is published on battery only: Mains adapter leads to the large one.
  await page.goto(site('public', OPERATING('en', 'model=small,power=battery')));
  const variants = page.getByRole('navigation', { name: 'Variants' });
  const mains = variants.getByRole('link', {
    name: 'Mains adapter only as Large',
  });
  await expect(mains).toBeVisible();
  // An option that keeps the other values has no hint.
  await expect(
    variants.getByRole('link', { name: 'Large', exact: true }),
  ).toBeVisible();
  const notice = page.locator('[data-switch-notice]');
  await expect(notice).toBeHidden();

  await mains.click();
  // The address is the variant's own: a reload or a shared link shows no notice.
  await expect(page).toHaveURL(/model=large,power=mains\/$/);
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText(
    'Mains adapter is published as Large only, so Model changed to Large.',
  );
  await expect(page.locator('[data-switch-status]')).toHaveText(
    'Mains adapter is published as Large only, so Model changed to Large.',
  );
  // Over the page, not pushing it down: the manual starts where it always does.
  await expect(notice).toHaveCSS('position', 'absolute');
  await page.getByRole('button', { name: 'Dismiss notice' }).click();
  await expect(notice).toBeHidden();
  await expect(page.locator('[data-switch-status]')).toHaveText('');
  await expect(
    variants.getByRole('link', { name: 'Mains adapter' }),
  ).toBeFocused();

  // A switch that keeps the other values shows no notice.
  await variants.getByRole('link', { name: 'Battery', exact: true }).click();
  await expect(page).toHaveURL(/model=large,power=battery\/$/);
  await expect(page.locator('.variants a[aria-current="true"]')).toHaveText([
    'Large',
    'Battery',
  ]);
  await expect(notice).toBeHidden();
});

test('the switch notice is in German on the German site, and a query naming no attribute shows none', async ({
  page,
}) => {
  await page.goto(
    site('public', `${OPERATING('de', 'model=small,power=battery')}`),
  );
  await page
    .getByRole('navigation', { name: 'Varianten' })
    .getByRole('link', { name: 'Netzteil nur als Large' })
    .click();
  await expect(page.locator('[data-switch-notice]')).toHaveText(
    'Netzteil ist nur als Large veröffentlicht, daher wurde Model auf Large umgestellt.',
  );
  // Escape closes it from inside.
  await page.getByRole('button', { name: 'Hinweis schließen' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-switch-notice]')).toBeHidden();
  await page.goto(
    site(
      'public',
      `${OPERATING('de', 'model=large,power=mains')}?switched=power&changed=nothing`,
    ),
  );
  await expect(page).toHaveURL(/model=large,power=mains\/$/);
  await expect(page.locator('[data-switch-notice]')).toBeHidden();
});

test('an excerpt around a glossary term reads as the page does (#852)', async ({
  page,
}) => {
  await page.goto(site('public', 'en/search/'));
  await page
    .getByRole('searchbox', { name: 'Search all manuals' })
    .fill('battery');
  const result = page.locator('.result').first();
  await expect(result).toBeVisible();
  // The term's definition is a tooltip, not text of the passage around it (the glossary's own
  // passage holds it), and the words keep their spaces.
  const excerpt = result.locator('.result__excerpt', { hasText: 'Keep the' });
  await expect(excerpt.first()).toContainText('Keep the battery charged.');
  await expect(excerpt.first()).not.toContainText('rechargeable');
});

test('search finds public text and nothing above the audience', async ({
  page,
}) => {
  await page.goto(site('public', 'en/search/'));
  const field = page.getByRole('searchbox', { name: 'Search all manuals' });
  await expect(page.getByText('Type a word to search')).toBeVisible();
  await field.fill(PUBLIC_WORD);
  const results = page.locator('.result');
  await expect(results.first()).toBeVisible();
  await expect(results.first()).toContainText('Operating manual');
  // The passage marks the word; the text around it keeps its spaces.
  await expect(results.first().locator('mark').first()).toBeVisible();
  // The address keeps the search, for the back button and for sharing.
  await expect(page).toHaveURL(new RegExp(`q=${PUBLIC_WORD}`));
  // The results scroll inside their own frame; the page stays put.
  await expect(page.locator('[data-results-frame]')).toHaveCSS(
    'overflow-y',
    'auto',
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    ),
  ).toBeLessThanOrEqual(1);
  for (const word of [INTERNAL_CANARY, RESTRICTED_CANARY]) {
    await field.fill(word);
    await expect(page.getByRole('status')).toContainText('Nothing matches');
    await expect(results).toHaveCount(0);
  }
});

test('the internal site finds internal text', async ({ page }) => {
  await page.goto(site('internal', `en/search/?q=${INTERNAL_CANARY}`));
  await expect(page.locator('.result').first()).toContainText(/Service manual/);
  await page
    .getByRole('searchbox', { name: 'Search all manuals' })
    .fill(RESTRICTED_CANARY);
  await expect(page.getByRole('status')).toContainText('Nothing matches');
});

test('the start page’s typeahead: the arrow keys pick a passage, Enter opens it', async ({
  page,
}) => {
  await page.goto(site('public', 'en/'));
  const field = page.getByRole('combobox', { name: 'Search all manuals' });
  await field.pressSequentially('charg', { delay: 20 });
  const list = page.getByRole('listbox', { name: 'Suggestions' });
  await expect(list).toBeVisible();
  await expect(field).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByRole('status').filter({ hasText: 'matches' }),
  ).toHaveText(/^\d+ matches\. Choose one with the arrow keys\.$/);
  const options = list.getByRole('option');
  await expect(options.last()).toHaveText(/All results for “charg”/);
  await expect(options.first().locator('mark').first()).toBeVisible();
  // Never wider than the screen: the popover stays inside the viewport.
  const box = (await list.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  await field.press('ArrowDown');
  await field.press('ArrowDown');
  const second = options.nth(1);
  await expect(second).toHaveAttribute('aria-selected', 'true');
  await expect(field).toHaveAttribute(
    'aria-activedescendant',
    (await second.getAttribute('id'))!,
  );
  const target = (await second.getAttribute('href'))!;
  expect(target).toMatch(/#/);
  await field.press('Enter');
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return url.pathname + url.hash;
    })
    .toBe(target);
  await expect(page.locator('[data-pagefind-body]')).toBeVisible();
});

test('the typeahead closes on Escape, clears on a second, and says when nothing matches', async ({
  page,
}) => {
  await page.goto(site('public', 'de/'));
  const field = page.getByRole('combobox', {
    name: 'Alle Anleitungen durchsuchen',
  });
  await field.fill('xylophonquarz');
  const popover = page.locator('.typeahead');
  await expect(popover).toContainText('Keine Stelle passt zu „xylophonquarz“.');
  const all = page.getByRole('option', {
    name: 'Alle Treffer für „xylophonquarz“',
  });
  await expect(all).toHaveAttribute('href', /\/de\/search\/\?q=xylophonquarz$/);
  await field.press('Escape');
  await expect(popover).toBeHidden();
  await expect(field).toHaveValue('xylophonquarz');
  await field.press('Escape');
  await expect(field).toHaveValue('');
  // A click elsewhere closes it too.
  await field.fill('laden');
  await expect(popover).toBeVisible();
  await page.getByRole('heading', { level: 1 }).click();
  await expect(popover).toBeHidden();
});

test('the running head’s typeahead finds a passage from a manual page', async ({
  page,
}, info) => {
  test.skip(
    info.project.name.startsWith('phone'),
    'the running head has no search field on narrow screens',
  );
  await page.goto(site('public', OPERATING('en')));
  const field = page.getByRole('combobox', { name: 'Search all manuals' });
  await field.fill('contacts');
  const list = page.getByRole('listbox', { name: 'Suggestions' });
  await expect(list.getByRole('option').first()).toContainText('Charging');
  await field.press('ArrowUp');
  await expect(list.getByRole('option').last()).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await field.press('Enter');
  await expect(page).toHaveURL(/\/en\/search\/\?q=contacts$/);
  await expect(page.locator('.result').first()).toBeVisible();
});

test('a page that does not exist offers search and the way back', async ({
  page,
}) => {
  await page.goto(site('public', 'en/404.html'));
  await expect(
    page.getByRole('heading', { level: 1, name: 'Page not found' }),
  ).toBeVisible();
  await expect(
    page.getByRole('combobox', { name: 'Search all manuals' }),
  ).toBeVisible();
  await page.getByRole('link', { name: /Back to the manuals/ }).click();
  await expect(page).toHaveURL(/\/en\/manuals\/$/);
});

test('the language switch opens the same page in German, with German texts', async ({
  page,
}) => {
  await page.goto(site('public', OPERATING('en')));
  await page
    .getByRole('navigation', { name: 'Language' })
    .getByRole('link', { name: 'Deutsch' })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/${OPERATING('de').replace(/[/=]/g, '\\$&')}$`),
  );
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.getByText('Das Model A dockt selbst')).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Hauptnavigation' })
      .getByRole('link', { name: 'Anleitungen' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Glossar' })).toBeAttached();
});

test('dark mode switches, and the choice is kept', async ({ page }, info) => {
  await page.goto(site('public', 'en/'));
  const html = page.locator('html');
  const dark = info.project.use.colorScheme === 'dark';
  await expect(html).toHaveClass(dark ? /dark/ : /^(?!.*dark)/);
  const toggle = page.getByRole('button', { name: 'Dark mode' });
  await expect(toggle).toHaveAttribute('aria-pressed', String(dark));
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', String(!dark));
  await page.goto(site('public', OPERATING('en')));
  await expect(page.locator('html')).toHaveClass(dark ? /^(?!.*dark)/ : /dark/);
});
