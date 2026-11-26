import { expect, type Page, test } from '@playwright/test';
import { LONG_STEP_TITLE, UPDATE_GUIDE_ID } from '../testing/fixture-repo.ts';
import { site, watchErrors } from './sites.ts';

/**
 * An update guide's page (#907) on the internal fixture site (the guide is internal, so a reader
 * picks the public or the internal level): the pickers pick exactly the steps of a jump, the
 * address keeps the choice, the checklist is kept in this browser, and without script the whole
 * guide shows. Every page loads without a console error and never scrolls sideways.
 */

const GUIDE = (lang = 'en', query = '') =>
  site('internal', `${lang}/alpha/${UPDATE_GUIDE_ID}/${query}`);

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

/** The titles of the steps shown in a phase, in order; none when the phase is hidden. */
const shown = (page: Page, phase: 'before' | 'during' | 'after') =>
  page
    .locator(`[data-phase-section="${phase}"]:visible li.step:visible h3`)
    .allTextContents();

const count = (page: Page) => page.locator('[data-guide-count]');

test('a range shows exactly its steps per phase, for the level and setup picked', async ({
  page,
}) => {
  await page.goto(GUIDE());
  // The defaults: the second-newest version to the newest, at the first level, no cluster.
  await expect(page.getByLabel('From version')).toHaveValue('3.1');
  await expect(page.getByLabel('To version')).toHaveValue('4.0');
  await expect(page.getByLabel('Level')).toHaveValue('public');
  await expect(count(page)).toHaveText('2 steps');
  await expect(page.getByText('Without JavaScript')).toBeHidden();
  expect(await shown(page, 'before')).toEqual([]);
  expect(await shown(page, 'after')).toEqual([
    'Remove the old files',
    LONG_STEP_TITLE[0],
  ]);

  await page.getByLabel('From version').selectOption('1.1');
  await page.getByLabel('To version').selectOption('3.0');
  await expect(count(page)).toHaveText('5 steps');
  expect(await shown(page, 'before')).toEqual([
    'Back up the settings',
    'Stop the service',
    'Check the system requirements',
  ]);
  // The internal steps are the public level's to skip: no "during" at all.
  await expect(page.locator('[data-phase-section="during"]')).toBeHidden();
  expect(await shown(page, 'after')).toEqual([
    'Renew the licence key',
    'Sign in again',
  ]);
  // Each step names the version that brought it.
  await expect(
    page.locator('li.step:visible').first().locator('.step__version'),
  ).toHaveText(/2\.0/);

  await page.getByLabel('Level').selectOption('internal');
  await page.getByLabel('Cluster setup').selectOption('yes');
  await expect(count(page)).toHaveText('8 steps');
  expect(await shown(page, 'during')).toEqual([
    'Migrate the database',
    'Convert the configuration',
  ]);
  expect(await shown(page, 'after')).toEqual([
    'Renew the licence key',
    'Reconnect the cluster nodes',
    'Sign in again',
  ]);

  // "To" offers only the versions after "from".
  await page.getByLabel('From version').selectOption('3.0');
  const to = page.getByLabel('To version');
  await expect(to.locator('option:not([disabled])')).toHaveText(['3.1', '4.0']);

  // Nothing to change: the designed empty state, the count says so too.
  await to.selectOption('3.1');
  await expect(count(page)).toHaveText('0 steps');
  await expect(page.locator('[data-guide-empty]')).toContainText(
    'Nothing to change between 3.0 and 3.1 for this setup.',
  );

  // The whole jump: forty steps.
  await page.getByLabel('From version').selectOption('1.0');
  await to.selectOption('4.0');
  await expect(count(page)).toHaveText('40 steps');
});

test('the address keeps the choice, and an invalid one falls back with a quiet note', async ({
  page,
}) => {
  await page.goto(GUIDE());
  await page.getByLabel('From version').selectOption('2.0');
  await page.getByLabel('Level').selectOption('internal');
  await page.getByLabel('Cluster setup').selectOption('yes');
  await expect(page).toHaveURL(
    /\?from=2\.0&to=4\.0&level=internal&opt=cluster%3Ayes$/,
  );
  await expect(page.locator('[data-guide-invalid]')).toBeHidden();

  await page.goto(
    GUIDE('en', '?from=1.1&to=2.1&level=internal&opt=cluster:yes'),
  );
  await expect(page.getByLabel('From version')).toHaveValue('1.1');
  await expect(page.getByLabel('To version')).toHaveValue('2.1');
  await expect(page.getByLabel('Level')).toHaveValue('internal');
  await expect(page.getByLabel('Cluster setup')).toHaveValue('yes');
  expect(await shown(page, 'after')).toEqual([
    'Renew the licence key',
    'Reconnect the cluster nodes',
  ]);

  for (const query of [
    '?from=4.0&to=2.0',
    '?from=9.9',
    '?level=nobody',
    '?opt=cluster',
    '?opt=cluster:maybe',
  ]) {
    await page.goto(GUIDE('en', query));
    await expect(page.locator('[data-guide-invalid]')).toBeVisible();
    await expect(page.getByLabel('From version')).toHaveValue('3.1');
    await expect(page.getByLabel('To version')).toHaveValue('4.0');
    await expect(page.getByLabel('Level')).toHaveValue('public');
    await expect(page.getByLabel('Cluster setup')).toHaveValue('');
    await expect(count(page)).toHaveText('2 steps');
  }

  // A hash that is no valid percent-encoding names nothing: the page still works.
  await page.goto(GUIDE('en', '#%E0%A4%A'));
  await expect(count(page)).toHaveText('2 steps');
  await expect(page.locator('[data-guide-picker]')).toBeVisible();
});

test('the checklist is kept per range across reloads, and Reset clears it', async ({
  page,
}) => {
  await page.goto(GUIDE('en', '?from=1.1&to=3.0'));
  const step = page.getByRole('checkbox', { name: 'Stop the service' });
  await step.check();
  await expect(page.locator('[data-guide-done]')).toHaveText('1 of 5 done');
  await page.reload();
  await expect(step).toBeChecked();
  await expect(page.locator('[data-guide-done]')).toHaveText('1 of 5 done');

  // Another range has a checklist of its own.
  await page.getByLabel('To version').selectOption('4.0');
  await expect(
    page.getByRole('checkbox', { name: 'Stop the service' }),
  ).not.toBeChecked();
  await page.getByLabel('To version').selectOption('3.0');
  await expect(step).toBeChecked();

  await page.getByRole('button', { name: 'Reset the checklist' }).click();
  await expect(step).not.toBeChecked();
  await expect(page.locator('[data-guide-done]')).toHaveText('0 of 5 done');
  await page.reload();
  await expect(step).not.toBeChecked();
});

test('a search result leads to its step, with the step’s version as "to"', async ({
  page,
}) => {
  await page.goto(site('internal', 'en/search/?q=migration'));
  const passage = page.getByRole('link', { name: /Migrate the database/ });
  await passage.first().click();
  await expect(page).toHaveURL(/\?from=1\.1&to=2\.0&level=internal#/);
  await expect(
    page.getByRole('heading', { name: 'Migrate the database' }),
  ).toBeVisible();
});

test('the guide is linked from the start page and the manual list, marked as one', async ({
  page,
}) => {
  await page.goto(site('internal', 'de/'));
  const entry = page.locator('#product-alpha .entry', {
    hasText: 'Leitfaden für Software-Updates',
  });
  await expect(entry.locator('.kind-tag')).toHaveText('Update-Leitfaden');
  await page.goto(site('internal', 'de/manuals/'));
  const row = page
    .locator('.row', { hasText: 'Leitfaden für Software-Updates' })
    .first();
  await expect(row.locator('.kind-tag')).toHaveText('Update-Leitfaden');
  await row
    .getByRole('link', { name: 'Leitfaden für Software-Updates' })
    .click();
  await expect(page).toHaveURL(/\/de\/(alpha|beta)\/software-update\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Leitfaden für Software-Updates',
  );
  await expect(page.locator('[data-guide-count]')).toHaveText('2 Schritte');
  await expect(
    page.getByRole('heading', { name: 'Nach dem Update' }),
  ).toBeVisible();
});

test.describe('without script', () => {
  test.use({ javaScriptEnabled: false });

  test('the whole guide shows, by version, with a note', async ({ page }) => {
    await page.goto(GUIDE());
    await expect(
      page.getByText('Without JavaScript this page shows the whole guide'),
    ).toBeVisible();
    await expect(page.locator('[data-guide-picker]')).toBeHidden();
    await expect(page.locator('li.step:visible')).toHaveCount(40);
    await expect(
      page.getByRole('heading', { level: 2, name: /^Version / }),
    ).toHaveText([
      'Version 1.1',
      'Version 2.0',
      'Version 2.1',
      'Version 3.0',
      'Version 4.0',
    ]);
  });
});
