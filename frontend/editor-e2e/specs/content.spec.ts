import type { Locator } from '@playwright/test';
import {
  type Api,
  moduleId,
  paragraph,
  unique,
  type UserId,
} from '../src/api.ts';
import {
  expect,
  expectNoSideways,
  signIn,
  test,
  USERS,
} from '../src/fixtures.ts';

// The content browser (`/content`): filters in the address, paging, deleted modules.
test.describe('content browser @area:content @api:modules @narrow', () => {
  test('a filter goes into the address, outlives a reload and narrows the list', async ({
    page,
  }) => {
    await signIn(page, USERS.author);
    await page.goto('/content');
    const modules = page.getByRole('region', { name: 'Modules' });
    await expect(modules.getByRole('link', { name: 'Storage' })).toBeVisible();
    await expectNoSideways(page);

    await page.getByRole('button', { name: 'Type: All' }).click();
    await page.getByRole('menuitemradio', { name: 'Procedure' }).click();
    await expect(page).toHaveURL(/[?&]type=procedure(&|$)/);
    await expect(modules.getByRole('link', { name: 'Charging' })).toBeVisible();
    await expect(modules.getByRole('link', { name: 'Storage' })).toHaveCount(0);

    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Type: Procedure' }),
    ).toBeVisible();
    await expect(modules.getByRole('link', { name: 'Storage' })).toHaveCount(0);
    await page.goBack();
    await expect(page).not.toHaveURL(/type=/);
  });

  test('an invalid filter in the address is dropped, not an error', async ({
    page,
  }) => {
    await signIn(page, USERS.author);
    await page.goto('/content?type=No%20Such%20Type!&page=-3');
    await expect(page).not.toHaveURL(/type=|page=/);
    await expect(
      page
        .getByRole('region', { name: 'Modules' })
        .getByRole('link', { name: 'Storage' }),
    ).toBeVisible();
  });
});

test.describe('content browser paging @area:content @api:modules', () => {
  test('the last audience level also finds the modules without an audience (#699)', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Unset audience'));
    const title = unique('Unset audience');
    // Made without an audience: it counts as the last level, Internal.
    await author.createModule(changeSet, {
      lang: 'en',
      moduleId: moduleId('unset'),
      title,
      blocks: [paragraph('p1', 'No audience given.')],
    });

    await signIn(page, USERS.author);
    await page.goto(
      `/content?cs=${changeSet.id}&q=${encodeURIComponent(title)}`,
    );
    const modules = page.getByRole('region', { name: 'Modules' });
    await expect(modules.getByRole('link', { name: title })).toBeVisible();

    await page.getByRole('button', { name: 'Audience: All' }).click();
    await page
      .getByRole('menuitemradio', { name: 'Internal + not set' })
      .click();
    await expect(page).toHaveURL(/[?&]audience=internal(&|$)/);
    await expect(
      page.getByRole('button', { name: 'Audience: Internal + not set' }),
    ).toBeVisible();
    await expect(modules.getByRole('link', { name: title })).toBeVisible();

    await page
      .getByRole('button', { name: 'Audience: Internal + not set' })
      .click();
    await page.getByRole('menuitemradio', { name: 'Public' }).click();
    await expect(page).toHaveURL(/[?&]audience=public(&|$)/);
    await expect(modules.getByRole('link', { name: title })).toHaveCount(0);
  });

  test('pages through a revision with more modules than a page holds, and shows deleted ones on request', async ({
    page,
    api,
  }) => {
    test.slow();
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Many modules'));
    const prefix = moduleId('page');
    for (let i = 0; i < 26; i++) {
      await author.createModule(
        changeSet,
        {
          lang: 'en',
          moduleId: `${prefix}-${String(i).padStart(2, '0')}`,
          title: `Paged ${String(i).padStart(2, '0')}`,
          blocks: [paragraph('p1', `Page test ${i}.`)],
        },
        { savePoint: false },
      );
    }
    await author.savePoint(changeSet.id);

    await signIn(page, USERS.author);
    await page.goto(`/content?cs=${changeSet.id}&q=Paged&size=25`);
    const pagination = page.getByRole('navigation', { name: 'Pagination' });
    await expect(pagination).toContainText('Page 1 of 2');
    await pagination.getByRole('button', { name: 'Next' }).click();
    await expect(page).toHaveURL(/[?&]page=2(&|$)/);
    await expect(pagination).toContainText('Page 2 of 2');
    // The pagination stays in view: the rows scroll in their own box.
    await expect(pagination).toBeInViewport();

    const deleted = page.getByRole('switch', { name: 'Show deleted' });
    await deleted.click();
    await expect(deleted).toBeChecked();
    await page.reload();
    await expect(
      page.getByRole('switch', { name: 'Show deleted' }),
    ).toBeChecked();
  });
});

// Each row's translations with their state from the translation status (#694).
test.describe('content browser translations @area:content @api:modules @api:translations', () => {
  /** A revision with a module of its own in English and a German version without a record. */
  async function outdatedTranslation(api: (user: UserId) => Promise<Api>) {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Outdated'));
    const id = moduleId('outdated');
    const title = unique('Outdated translation');
    await author.createModule(
      changeSet,
      {
        lang: 'en',
        moduleId: id,
        title,
        blocks: [paragraph('p1', 'The source text.')],
      },
      { savePoint: false },
    );
    // No translation record: every block of it counts as outdated.
    await author.createModule(changeSet, {
      lang: 'de',
      moduleId: id,
      title: `${title} (de)`,
      blocks: [paragraph('p1', 'Der Ausgangstext.')],
    });
    return { changeSet, title };
  }

  /** A row's chip of one language: the code, then its state for screen readers. */
  const badge = (row: Locator, lang: string) =>
    row
      .locator('of-language-badge')
      .filter({ has: row.page().getByText(lang, { exact: true }) });

  test('an outdated translation is listed as outdated (#694)', async ({
    page,
    api,
  }) => {
    const { changeSet, title } = await outdatedTranslation(api);
    await signIn(page, USERS.author);
    await page.goto(
      `/content?cs=${changeSet.id}&q=${encodeURIComponent(title)}`,
    );
    const modules = page.getByRole('region', { name: 'Modules' });
    const row = modules.getByRole('row').filter({
      has: page.getByRole('link', { name: title }),
    });
    await expect(badge(row, 'de')).toHaveAttribute('data-state', 'outdated');
    await expect(badge(row, 'de')).toHaveAttribute('title', 'Outdated');
    await expect(badge(row, 'en')).toHaveAttribute('data-state', 'up-to-date');
    await expect(badge(row, 'fr')).toHaveAttribute(
      'data-state',
      'not-translated',
    );
  });

  test.describe('the translation status cannot be read', () => {
    test.use({ consoleAllow: [/status of 500.*\/api\/translations\/status/] });

    test('the rows are listed, their translations there without a state (#694)', async ({
      page,
      api,
    }) => {
      const { changeSet, title } = await outdatedTranslation(api);
      await page.route(
        (url) => url.pathname === '/api/translations/status',
        (route) =>
          route.fulfill({
            status: 500,
            contentType: 'application/vnd.api+json',
            body: JSON.stringify({
              errors: [
                { status: '500', code: 'internal-error', title: 'Error' },
              ],
            }),
          }),
      );
      await signIn(page, USERS.author);
      await page.goto(
        `/content?cs=${changeSet.id}&q=${encodeURIComponent(title)}`,
      );
      const row = page
        .getByRole('region', { name: 'Modules' })
        .getByRole('row')
        .filter({ has: page.getByRole('link', { name: title }) });
      await expect(badge(row, 'de')).toHaveAttribute(
        'data-state',
        'translated',
      );
      await expect(badge(row, 'de')).toHaveAttribute('title', 'Translated');
    });
  });
});
