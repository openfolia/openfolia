import type { Page } from '@playwright/test';
import type { Json } from '../src/api.ts';
import {
  expect,
  expectNoSideways,
  signIn,
  test,
  USERS,
} from '../src/fixtures.ts';

/** The rail's groups and their pages, as a full admin sees them (#591). */
const FULL_RAIL: readonly (readonly [string, readonly [string, string][]])[] = [
  [
    'People and access',
    [
      ['Users', 'users'],
      ['Roles', 'roles'],
      ['Group mappings', 'group-mappings'],
      ['Service accounts', 'service-accounts'],
    ],
  ],
  [
    'Content',
    [
      ['Project settings', 'settings'],
      ['Variants', 'variants'],
      ['Page design', 'page-designs'],
      ['Import', 'import'],
    ],
  ],
  ['Look', [['Branding', 'branding']]],
  ['Integrations', [['Webhooks', 'webhooks']]],
  [
    'Operations',
    [
      ['System', 'system'],
      ['Backups', 'backups'],
      ['Audit log', 'audit'],
    ],
  ],
];

const rail = (page: Page) =>
  page.getByRole('navigation', { name: 'Admin sections' });

/** The group headings the rail shows, in order. */
const railGroups = (page: Page) =>
  rail(page)
    .getByRole('group')
    .evaluateAll((groups) =>
      groups.map((g) => g.querySelector('p')?.textContent?.trim() ?? ''),
    );

/**
 * `GET /me` answered as the signed-in admin holding only `permissions`: a role with some of the
 * admin permissions, without making one in the shared stack. The pages it opens still read as the
 * admin, so nothing they ask is refused.
 */
async function actAsLimitedRole(
  page: Page,
  permissions: readonly string[],
): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/me',
    async (route) => {
      const response = await route.fetch();
      const doc = (await response.json()) as Json;
      const keep = (p: string) => permissions.includes(p);
      doc['data'].meta.permissions = doc['data'].meta.permissions.filter(
        (p: Json) => keep(p['permission']),
      );
      for (const role of doc['data'].attributes.roles) {
        role.permissions = role.permissions.filter(keep);
      }
      await route.fulfill({ response, json: doc });
    },
  );
}

// Admin's side rail (#591): grouped, only the pages the role opens, every page in the palette,
// a select at phone width.
test.describe('admin rail @area:admin @area:shell @area:search @api:access', () => {
  test('a full admin sees five groups, and every page opens in one click', async ({
    page,
  }) => {
    await signIn(page, USERS.admin);
    await page.goto('/admin/users');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Users' }),
    ).toBeVisible();
    await expect
      .poll(() => railGroups(page))
      .toEqual(FULL_RAIL.map(([g]) => g));
    // The select is for phone width only.
    await expect(
      page.getByRole('combobox', { name: 'Admin sections' }),
    ).toBeHidden();

    for (const [group, pages] of FULL_RAIL) {
      const links = rail(page).getByRole('group', { name: group });
      await expect(links.getByRole('link')).toHaveText(
        pages.map(([label]) => label),
      );
      for (const [label, path] of pages) {
        await links.getByRole('link', { name: label, exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/admin/${path}(/|\\?|$)`));
        const current = rail(page).locator('a[aria-current="page"]');
        await expect(current).toHaveText(label);
      }
    }
    // Project settings opened its first topic and stays current on another one.
    await page.goto('/admin/settings/headings');
    await expect(rail(page).locator('a[aria-current="page"]')).toHaveText(
      'Project settings',
    );
    // Keyboard focus is visible on a rail link.
    const users = rail(page).getByRole('link', { name: 'Users' });
    await users.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(users).toBeFocused();
    expect(
      await users.evaluate((el) => getComputedStyle(el).boxShadow),
    ).not.toBe('none');
    await expectNoSideways(page);
  });

  test('a limited role sees only its pages, and a direct link to another shows no access', async ({
    page,
  }) => {
    await actAsLimitedRole(page, [
      'content.read',
      'content.read.draft',
      'webhook.manage',
      'admin.branding',
    ]);
    await signIn(page, USERS.admin);
    await page.goto('/admin');
    // The first page it may open.
    await expect(page).toHaveURL(/\/admin\/page-designs/);
    await expect
      .poll(() => railGroups(page))
      .toEqual(['Content', 'Look', 'Integrations']);
    await expect(rail(page).getByRole('link')).toHaveText([
      'Page design',
      'Branding',
      'Webhooks',
    ]);
    await rail(page).getByRole('link', { name: 'Webhooks' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Webhooks and API access' }),
    ).toBeVisible();

    // A page it cannot open: no access, naming the permission; the rail stays as it was.
    await page.goto('/admin/users');
    await expect(
      page.getByRole('heading', { name: 'No access' }),
    ).toBeVisible();
    await expect(page.getByText('Create roles, assign people')).toBeVisible();
    await expect(rail(page).getByRole('link')).toHaveCount(3);

    // The palette lists only its pages.
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog');
    await palette.getByRole('combobox', { name: /^Search/ }).fill('admin');
    await expect(palette.getByRole('option', { name: /Admin ›/ })).toHaveCount(
      3,
    );
    await expect(palette.getByText('Admin › People and access')).toHaveCount(0);
  });

  test('the palette finds "Languages" and opens the settings topic', async ({
    page,
  }) => {
    await signIn(page, USERS.admin);
    await page.goto('/content');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Content' }),
    ).toBeVisible();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog');
    await palette.getByRole('combobox', { name: /^Search/ }).fill('Languages');
    const option = palette.getByRole('option', {
      name: /Admin › Project settings › Languages/,
    });
    await expect(option).toBeVisible();
    await option.click();
    await expect(page).toHaveURL(/\/admin\/settings\/languages/);
    await expect(page.getByRole('region', { name: 'Languages' })).toContainText(
      'German',
    );
    await expect(rail(page).locator('a[aria-current="page"]')).toHaveText(
      'Project settings',
    );
  });

  test('a page name nothing matches lists no page', async ({ page }) => {
    await signIn(page, USERS.admin);
    await page.goto('/content');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Content' }),
    ).toBeVisible();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog');
    await palette
      .getByRole('combobox', { name: /^Search/ })
      .fill('zzz-no-page');
    await expect(palette.locator('[data-state=empty]')).toBeVisible();
    await expect(palette.getByRole('option', { name: /Admin ›/ })).toHaveCount(
      0,
    );
  });

  test('at phone width a select replaces the rail, and the page never scrolls sideways', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, USERS.admin);
    await page.goto('/admin/users');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Users' }),
    ).toBeVisible();
    await expect(rail(page)).toBeHidden();
    const select = page.getByRole('combobox', { name: /^Admin sections/ });
    await expect(select).toBeVisible();
    await expect(select).toContainText('Users');
    await expectNoSideways(page);

    await select.click();
    const list = page.getByRole('listbox');
    await expect(list.getByRole('group')).toHaveCount(FULL_RAIL.length);
    for (const [group] of FULL_RAIL) {
      await expect(list.getByText(group, { exact: true })).toBeVisible();
    }
    await expectNoSideways(page);
    await list.getByRole('option', { name: 'Audit log' }).click();
    await expect(page).toHaveURL(/\/admin\/audit/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Audit log' }),
    ).toBeVisible();
    await expect(select).toContainText('Audit log');
    await expectNoSideways(page);
  });
});
