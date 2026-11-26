import { expect, type Page, test } from '@playwright/test';
import {
  NEWEST_REVISION,
  OLDER_REVISIONS,
  OLDER_WORD,
  PUBLIC_WORD,
  UPDATE_GUIDE_ID,
} from '../testing/fixture-repo.ts';
import { DWELL_MS } from '../src/scripts/release-switch.ts';
import { BRAND_NAME } from '../testing/fixture-brand.ts';
import { OPERATING, site, watchErrors } from './sites.ts';

/**
 * Older releases (#896) on the internal fixture site, built with alpha's three newest releases
 * (`CCMS_PORTAL_RELEASES_PER_PRODUCT=3`): the newest at today's addresses, the older ones under
 * `alpha/v/<release>/` with a notice, a canonical link and `noindex`; the release switch keeps the
 * manual, variant and section, and says when a release lacks them; search stays in the release.
 * The public site keeps the default (the newest only): no switch, no older pages. Every page
 * loads without a console error and never scrolls sideways.
 */

const [OLD, LONG] = OLDER_REVISIONS;
const OLDER = (lang: string, path: string, release: string = OLD) =>
  site('internal', `${lang}/alpha/v/${release}/${path}`);
const LARGE = 'model=large,power=battery';

const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  errors.set(page, watchErrors(page));
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
});

const releaseSwitch = (page: Page) => page.locator('.masthead .relswitch');
const openSwitch = async (page: Page) => {
  await releaseSwitch(page).locator('summary').click();
  await expect(releaseSwitch(page).locator('.relswitch__menu')).toBeVisible();
};
const option = (page: Page, revision: string) =>
  releaseSwitch(page)
    .locator('.relswitch__list a')
    .filter({ has: page.locator('.relswitch__name', { hasText: revision }) });
/** The contents' entry marked as in view (the narrow screens' contents start closed, but mark it too). */
const inView = (page: Page) =>
  page.locator('[data-toc-nav] a[aria-current="location"]');

test('today’s addresses show the newest release, with the switch listing every built one', async ({
  page,
}) => {
  await page.goto(site('internal', OPERATING('en', LARGE)));
  await expect(page.locator('.older-notice')).toHaveCount(0);
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
  const summary = releaseSwitch(page).locator('summary');
  await expect(summary).toContainText(`Release ${NEWEST_REVISION}`);
  await expect(summary).toContainText('Latest');

  await openSwitch(page);
  await expect(releaseSwitch(page).locator('.relswitch__name')).toHaveText([
    NEWEST_REVISION,
    LONG,
    OLD,
  ]);
  await expect(option(page, NEWEST_REVISION)).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(option(page, NEWEST_REVISION)).toContainText('Latest');
  // Escape closes the menu, focus back on its button.
  await page.keyboard.press('Escape');
  await expect(releaseSwitch(page).locator('.relswitch__menu')).toBeHidden();
  await expect(summary).toBeFocused();

  // Beta has one release built: no switch, the colophon as before.
  await page.goto(site('internal', OPERATING('en', LARGE, 'beta')));
  await expect(releaseSwitch(page)).toHaveCount(0);
  await expect(page.locator('.masthead__colophon')).toContainText(
    `Release ${NEWEST_REVISION}`,
  );
});

test('an older release’s page says so, links the latest, and is canonical to it and noindex', async ({
  page,
}) => {
  await page.goto(OLDER('en', `operating/${LARGE}/`));
  const notice = page.locator('.older-notice');
  await expect(notice).toContainText(
    `You are reading release ${OLD}. The latest is release ${NEWEST_REVISION}.`,
  );
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    'noindex',
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    `/en/alpha/operating/${LARGE}/`,
  );
  await expect(page).toHaveTitle(
    `Operating manual (Large · Battery), release ${OLD} · ${BRAND_NAME}`,
  );
  // The older release's own text: the module the newest dropped.
  await expect(
    page.getByRole('heading', { name: 'Release the transport latch' }),
  ).toBeVisible();

  await notice.getByRole('link', { name: 'Read the latest' }).click();
  await expect(page).toHaveURL(site('internal', OPERATING('en', LARGE)));
});

test('the switch keeps the manual, variant and section in another release', async ({
  page,
}) => {
  await page.goto(site('internal', OPERATING('en', LARGE)));
  await expect(inView(page)).toHaveText('Welcome');
  await openSwitch(page);
  await option(page, OLD).click();
  await expect(page).toHaveURL(OLDER('en', `operating/${LARGE}/#of-welcome`));
  await expect(page.locator('#of-welcome')).toBeInViewport();
  await expect(page.locator('[data-release-notice]')).toBeHidden();

  // Back to the latest, from the older release's own switch.
  await openSwitch(page);
  await expect(option(page, OLD)).toHaveAttribute('aria-current', 'page');
  await option(page, NEWEST_REVISION).click();
  await expect(page).toHaveURL(
    site('internal', `${OPERATING('en', LARGE)}#of-welcome`),
  );

  // After reading further down, the section read stays the place, though the way back up to the
  // switch passes others.
  await page.evaluate(() =>
    document.getElementById('of-_glossary')!.scrollIntoView(),
  );
  await expect(inView(page)).toHaveText('Glossary');
  // Longer than the switch waits before it takes a section as the one being read.
  await page.waitForTimeout(DWELL_MS * 2);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(inView(page)).toHaveText('Welcome');
  await openSwitch(page);
  await option(page, OLD).click();
  await expect(page).toHaveURL(OLDER('en', `operating/${LARGE}/#of-_glossary`));
  await expect(page.locator('#of-_glossary')).toBeInViewport();
});

test('a release without the section opens the manual’s start with a note; one without the variant says so first', async ({
  page,
}) => {
  await page.goto(site('internal', `${OPERATING('en', LARGE)}#of-charging`));
  await expect(inView(page)).toHaveText('Charging');
  await openSwitch(page);
  await option(page, OLD).click();
  // No `#of-charging` in 0.8: its start, the mark dropped from the address.
  await expect(page).toHaveURL(OLDER('en', `operating/${LARGE}/`));
  const notice = page.locator('[data-release-notice]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(
    'The section you were reading is not in this release, so the manual opens at its start.',
  );
  await expect(page.locator('[data-release-status]')).toHaveText(
    /not in this release/,
  );
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await notice.getByRole('button', { name: 'Dismiss notice' }).click();
  await expect(notice).toBeHidden();
  // A reload shows the page plain.
  await page.reload();
  await expect(notice).toBeHidden();

  // 0.8 has no large model on mains: the option names the variant it opens instead.
  await page.goto(site('internal', OPERATING('en', 'model=large,power=mains')));
  await openSwitch(page);
  await expect(option(page, OLD)).toContainText('only as Large · Battery');
  await expect(option(page, OLD)).toHaveAccessibleName(
    new RegExp(`^${OLD}.*, only as Large · Battery$`),
  );
  await option(page, OLD).click();
  await expect(page).toHaveURL(
    new RegExp(`/alpha/v/${OLD}/operating/${LARGE}/`),
  );
});

test('search in an older release finds that release’s text, and offers the latest instead', async ({
  page,
}) => {
  // The newest release has no such text.
  await page.goto(site('internal', `en/search/?q=${OLDER_WORD}`));
  await expect(page.locator('[data-status]')).toContainText('Nothing matches');
  await expect(page.locator('[data-search-scope]')).toBeHidden();

  // The running head of an older page searches that release only.
  await page.goto(OLDER('en', `operating/${LARGE}/`));
  const field = page.locator('#head-q');
  if (await field.isVisible()) {
    await field.fill(OLDER_WORD);
    await expect(page.getByRole('listbox')).toContainText('transport latch');
    await field.press('Enter');
  } else {
    // Phones: the running head has no field, its search link keeps the release.
    await page.getByRole('link', { name: 'Search', exact: true }).click();
    await page.locator('#search-q').fill(OLDER_WORD);
  }
  await expect(page).toHaveURL(/\/en\/search\/\?/);
  await expect(page).toHaveURL(/release=alpha%2F0\.8/);
  const scope = page.locator('[data-search-scope]');
  await expect(scope).toContainText(`Searching release ${OLD} of Alpha only.`);
  const result = page.locator('.result').first();
  await expect(result).toBeVisible();
  await expect(result.locator('a').first()).toHaveAttribute(
    'href',
    new RegExp(`/en/alpha/v/${OLD}/operating/`),
  );

  // The latest instead: the same words, the newest's index.
  await scope.getByRole('link', { name: 'Search the latest instead' }).click();
  await expect(page).toHaveURL(site('internal', `en/search/?q=${OLDER_WORD}`));
  await expect(page.locator('[data-status]')).toContainText('Nothing matches');

  // A word both have: the older release's search links only its own pages.
  await page.goto(
    site('internal', `en/search/?q=${PUBLIC_WORD}&release=alpha/${OLD}`),
  );
  await expect(page.locator('.result').first()).toBeVisible();
  for (const href of await page
    .locator('.result a')
    .evaluateAll((links) => links.map((a) => a.getAttribute('href'))))
    expect(href).toMatch(new RegExp(`/en/alpha/v/${OLD}/`));
});

test('the start page leads to the older releases, each with a page of its manuals', async ({
  page,
}) => {
  await page.goto(site('internal', 'en/'));
  const alpha = page.locator('#product-alpha');
  const older = alpha.locator('.older-releases');
  await expect(older).toContainText('Older releases');
  await expect(older.getByRole('link')).toHaveText([LONG, OLD]);
  await expect(page.locator('#product-beta .older-releases')).toHaveCount(0);

  await older.getByRole('link', { name: OLD, exact: true }).click();
  await expect(page).toHaveURL(OLDER('en', ''));
  await expect(
    page.getByRole('heading', { level: 1, name: 'Alpha' }),
  ).toBeVisible();
  await expect(page.locator('.older-notice')).toBeVisible();
  await page.getByRole('link', { name: 'Software update guide' }).click();
  await expect(page).toHaveURL(OLDER('en', `${UPDATE_GUIDE_ID}/`));
});

test('an older release’s update guide works, and the switch keeps its range', async ({
  page,
}) => {
  await page.goto(OLDER('en', `${UPDATE_GUIDE_ID}/?from=1.0&to=4.0`));
  await expect(page.locator('[data-update-guide][data-ready]')).toBeAttached();
  await expect(page.locator('.older-notice')).toBeVisible();
  await openSwitch(page);
  await option(page, NEWEST_REVISION).click();
  await expect(page).toHaveURL(
    site('internal', `en/alpha/${UPDATE_GUIDE_ID}/?from=1.0&to=4.0`),
  );
  await expect(page.locator('[data-guide-from]')).toHaveValue('1.0');
  await expect(page.locator('[data-guide-to]')).toHaveValue('4.0');
});

test('in German, and the language switch keeps the release', async ({
  page,
}) => {
  await page.goto(OLDER('en', `operating/${LARGE}/`));
  await page.locator('.langs a[hreflang="de"]').click();
  await expect(page).toHaveURL(OLDER('de', `operating/${LARGE}/`));
  await expect(page.locator('.older-notice')).toContainText(
    `Sie lesen Version ${OLD}. Die aktuelle ist Version ${NEWEST_REVISION}.`,
  );
  await expect(page.locator('.older-notice')).toContainText(
    'Zur aktuellen Version',
  );
  await openSwitch(page);
  await expect(releaseSwitch(page).locator('.relswitch__title')).toHaveText(
    'Versionen von Alpha',
  );
  await expect(option(page, NEWEST_REVISION)).toContainText('Aktuell');
});

test('the public site, built with the default, has no switch and no older pages', async ({
  page,
}) => {
  await page.goto(site('public', OPERATING('en', LARGE)));
  await expect(page.locator('.relswitch')).toHaveCount(0);
  await expect(page.locator('.masthead__colophon')).toContainText(
    `Release ${NEWEST_REVISION}`,
  );
  await page.goto(site('public', 'en/'));
  await expect(page.locator('.older-releases')).toHaveCount(0);
  // No older pages in the files either (`leaks.spec.ts`).
});
