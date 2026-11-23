import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
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
  ['manual', 'alpha/operating/model=large/'],
  ['search with results', `search/?q=${PUBLIC_WORD}`],
  ['page not found', '404.html'],
] as const;

for (const lang of ['en', 'de'])
  for (const [name, path] of PAGES)
    test(`${name} (${lang}) meets WCAG 2.1 AA`, async ({ page }) => {
      // No transitions (there are none under reduced motion): colours are measured as shown.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(site('public', `${lang}/${path}`));
      if (path.startsWith('search'))
        await expect(page.locator('.result').first()).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(
        results.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map(
            (n) => `${n.target.join(' ')}: ${n.failureSummary ?? ''}`,
          ),
        })),
      ).toEqual([]);
    });
