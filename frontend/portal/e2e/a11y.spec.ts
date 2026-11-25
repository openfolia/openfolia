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
      if (name.includes('ticked'))
        await page.locator('li.step:visible [data-step-check]').first().check();
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
