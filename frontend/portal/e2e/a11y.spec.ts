import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { PUBLIC_WORD } from '../testing/fixture-repo.ts';
import { site } from './sites.ts';

/**
 * WCAG 2.1 AA (axe's `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` rules) on every kind of page, in
 * English and German, at desktop and phone width, in light and dark (the projects). Run in
 * `pnpm check` (the `e2e` target).
 */
const PAGES = [
  ['start page', ''],
  ['manual list', 'manuals/'],
  ['manual', 'alpha/operating/model=large,power=battery/'],
  // After a variant switch that changed another attribute: the notice by the switch.
  [
    'manual with the switch notice',
    'alpha/operating/model=large,power=mains/?switched=power&changed=model',
  ],
  ['search with results', `search/?q=${PUBLIC_WORD}`],
  ['page not found', '404.html'],
] as const;

/** Axe's WCAG 2.1 AA violations on the page as it stands. */
const violations = async (page: Page) => {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.map((v) => ({
    id: v.id,
    nodes: v.nodes.map(
      (n) => `${n.target.join(' ')}: ${n.failureSummary ?? ''}`,
    ),
  }));
};

for (const lang of ['en', 'de'])
  for (const [name, path] of PAGES)
    test(`${name} (${lang}) meets WCAG 2.1 AA`, async ({ page }) => {
      // No transitions (there are none under reduced motion): colours are measured as shown.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(site('public', `${lang}/${path}`));
      if (path.startsWith('search'))
        await expect(page.locator('.result').first()).toBeVisible();
      if (path.includes('switched='))
        await expect(page.locator('.switch-notice.is-open')).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });

// An update guide (#907, internal): the pickers and checklist, many steps, and the empty state.
for (const lang of ['en', 'de'])
  for (const [name, query] of [
    ['update guide', ''],
    [
      'update guide with many steps, one ticked',
      '?from=1.0&to=4.0&level=internal&opt=cluster:yes',
    ],
    ['update guide with nothing to change', '?from=3.0&to=3.1'],
  ] as const)
    test(`${name} (${lang}) meets WCAG 2.1 AA`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(
        site('internal', `${lang}/alpha/software-update/${query}`),
      );
      await expect(
        page.locator('[data-update-guide][data-ready]'),
      ).toBeAttached();
      if (name.includes('ticked')) {
        await page.locator('li.step:visible [data-step-check]').first().check();
        // Ticking enables the reset button, which fades from the disabled button's 0.45 opacity
        // to 1 (1 ms under reduced motion). Axe measures the colour as it is drawn: wait for the
        // end of the fade, or it reads the in-between one (contrast 3.89, #933).
        const reset = page.locator('[data-guide-reset]');
        await expect(reset).toBeEnabled();
        await expect
          .poll(() => reset.evaluate((el) => getComputedStyle(el).opacity))
          .toBe('1');
      }
      expect(await violations(page)).toEqual([]);
    });

// The internal site's start page (#897): more cards, an update guide's and an older release's
// among them, under the brand's colours; and the default one, where none is authored.
for (const [audience, path] of [
  ['internal', 'en/'],
  ['internal', 'de/'],
  ['plain', 'en/'],
] as const)
  test(`the ${audience} start page (${path}) meets WCAG 2.1 AA`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(site(audience, path));
    expect(await violations(page)).toEqual([]);
  });

// Older releases (#896, the internal site): an older page with its notice and the release
// switch open, an older release's own page, and search within it.
for (const lang of ['en', 'de'])
  for (const [name, path, open] of [
    [
      'older release’s manual, its switch open',
      'alpha/v/0.8/operating/model=large,power=battery/',
      true,
    ],
    ['older release’s page', 'alpha/v/0.8/', false],
    [
      'search in an older release',
      `search/?q=${PUBLIC_WORD}&release=alpha/0.8`,
      false,
    ],
  ] as const)
    test(`${name} (${lang}) meets WCAG 2.1 AA`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(site('internal', `${lang}/${path}`));
      if (open) {
        await page.locator('.masthead .relswitch summary').click();
        await expect(page.locator('.relswitch__menu')).toBeVisible();
      }
      if (path.startsWith('search'))
        await expect(page.locator('.result').first()).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });

// The typeahead open under the start page's field, a row selected (#845).
for (const lang of ['en', 'de'])
  test(`the open typeahead (${lang}) meets WCAG 2.1 AA`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(site('public', `${lang}/`));
    const field = page.locator('#start-q');
    await field.fill(lang === 'de' ? 'laden' : 'charg');
    await expect(page.getByRole('listbox')).toBeVisible();
    await field.press('ArrowDown');
    await expect(
      page.locator('[role="option"][aria-selected="true"]'),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
