import type { Page } from '@playwright/test';
import { Api, type Json, unique } from '../src/api.ts';
import {
  expect,
  expectNoSideways,
  signIn,
  test,
  USERS,
} from '../src/fixtures.ts';

/**
 * Admin's tables fit the screen (#692): at a 1280 and a 1024 px window every column of a table,
 * its actions last, shows without scrolling the table sideways; long values wrap instead. At
 * phone width a table may scroll sideways inside its frame, never the page.
 */

/** The admin pages showing a table, and a row each page always has. */
const TABLES: readonly {
  readonly path: string;
  readonly title: string;
  readonly region: string;
  readonly row?: RegExp;
}[] = [
  { path: 'users', title: 'Users', region: 'Users', row: /^Sample Admin/ },
  {
    path: 'service-accounts',
    title: 'Service accounts',
    region: 'Service accounts',
  },
  { path: 'group-mappings', title: 'Group mappings', region: 'Group mappings' },
  { path: 'audit', title: 'Audit log', region: 'Audit events' },
];

const WIDTHS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
] as const;

/** A service account and a group mapping of the run's own, so neither table is empty. */
async function someRows(): Promise<() => Promise<void>> {
  const admin = await Api.as(USERS.admin);
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // A service account cannot be deleted; its ID is the test's own.
  await admin.json(
    admin.send('POST', '/service-accounts', {
      data: {
        type: 'ServiceAccount',
        id: `e2e-tables-${suffix}`,
        attributes: {
          name: unique('E2E table service account with a long name'),
          description: null,
        },
        relationships: { roles: { data: [{ type: 'Role', id: 'reader' }] } },
      },
    }),
    201,
  );
  const { data } = await admin.json<{ data: { id: string } }>(
    admin.send('POST', '/group-mappings', {
      data: {
        type: 'GroupMapping',
        attributes: { group: `e2e-tables-${suffix}` },
        relationships: { role: { data: { type: 'Role', id: 'reader' } } },
      },
    }),
    201,
  );
  return async () => {
    try {
      await admin.json(admin.send('DELETE', `/group-mappings/${data.id}`), 204);
    } finally {
      await admin.dispose();
    }
  };
}

/** How far the page's table reaches past its frame's scroller, in pixels (0: it fits). */
async function sideways(page: Page, region: string): Promise<number> {
  const scroller = page.getByRole('region', { name: region, exact: true });
  await expect(scroller.locator('tbody tr').first()).toBeVisible();
  return scroller.evaluate((el) => el.scrollWidth - el.clientWidth);
}

test.describe('admin tables @area:admin @api:access @api:audit @narrow', () => {
  let cleanUp: (() => Promise<void>) | undefined;
  test.beforeAll(async () => {
    cleanUp = await someRows();
  });
  test.afterAll(async () => {
    await cleanUp?.();
  });

  for (const table of TABLES) {
    test(`${table.path}: the table fits the window`, async ({ page }) => {
      await signIn(page, USERS.admin);
      const narrow = test.info().project.name === 'narrow';
      for (const size of narrow ? [] : WIDTHS) {
        await page.setViewportSize(size);
        await page.goto(`/admin/${table.path}`);
        await expect(
          page.getByRole('heading', { level: 1, name: table.title }),
        ).toBeVisible();
        if (table.row) {
          await expect(
            page
              .getByRole('region', { name: table.region, exact: true })
              .getByRole('row', { name: table.row }),
          ).toBeVisible();
        }
        expect(
          await sideways(page, table.region),
          `${table.path} at ${size.width} px scrolls sideways`,
        ).toBeLessThanOrEqual(0);
        await expectNoSideways(page);
      }
      if (narrow) {
        await page.goto(`/admin/${table.path}`);
        await expect(
          page
            .getByRole('region', { name: table.region, exact: true })
            .locator('tbody tr')
            .first(),
        ).toBeVisible();
        await expectNoSideways(page);
      }
    });
  }

  test('users: the widest rows fit, with password sign-in, in German', async ({
    page,
  }) => {
    // The stack runs without password sign-in: its options as with it on, and every person
    // invited with a long address, so each row shows the sign-in column and its actions.
    await page.addInitScript(() => {
      try {
        localStorage.setItem('of-language', 'de');
      } catch {
        // Storage off: the test then fails on the English text, which says so.
      }
    });
    await page.route('**/api/auth/options', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/vnd.api+json',
        body: JSON.stringify({
          data: {
            type: 'SignInOptions',
            id: 'sign-in',
            attributes: { password: true, passwordReset: true, providers: 1 },
          },
        }),
      }),
    );
    await page.route(
      (url) => url.pathname === '/api/users',
      async (route) => {
        const response = await route.fetch();
        const doc = (await response.json()) as Json;
        for (const user of doc['data']) {
          user.attributes.email = `${user.id}.with-a-rather-long-address@docs.example.org`;
          user.meta = {
            ...user.meta,
            signIn: {
              password: false,
              provider: false,
              inviteExpiresAt: '2999-01-01T00:00:00.000Z',
            },
          };
        }
        await route.fulfill({ response, json: doc });
      },
    );
    await signIn(page, USERS.admin);
    const narrow = test.info().project.name === 'narrow';
    for (const size of narrow ? [] : WIDTHS) {
      await page.setViewportSize(size);
      await page.goto('/admin/users');
      const users = page.getByRole('region', { name: 'Benutzer', exact: true });
      const row = users.getByRole('row', { name: /^Sample Admin/ });
      await expect(
        row.getByRole('button', { name: 'Sample Admin bearbeiten' }),
      ).toBeVisible();
      await expect(
        row.getByRole('button', { name: 'Weitere Aktionen für Sample Admin' }),
      ).toBeVisible();
      expect(
        await sideways(page, 'Benutzer'),
        `users at ${size.width} px scrolls sideways`,
      ).toBeLessThanOrEqual(0);
      await expectNoSideways(page);
    }
    if (narrow) {
      await page.goto('/admin/users');
      await expect(
        page
          .getByRole('region', { name: 'Benutzer', exact: true })
          .locator('tbody tr')
          .first(),
      ).toBeVisible();
      await expectNoSideways(page);
    }
  });

  test('names a group mapping added and removed in the audit log', async ({
    page,
    api,
  }) => {
    // A mapping of the test's own, added and removed again: two events about it.
    const admin = await api(USERS.admin);
    const { data } = await admin.json<{ data: { id: string } }>(
      admin.send('POST', '/group-mappings', {
        data: {
          type: 'GroupMapping',
          attributes: { group: unique('e2e-audit-group').replace(' ', '-') },
          relationships: { role: { data: { type: 'Role', id: 'reader' } } },
        },
      }),
      201,
    );
    await admin.json(admin.send('DELETE', `/group-mappings/${data.id}`), 204);

    await signIn(page, USERS.admin);
    await page.goto(`/admin/audit?type=group-mapping&id=${data.id}`);
    const rows = page
      .getByRole('region', { name: 'Audit events', exact: true })
      .locator('[data-slot="audit-row"]');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'Group mapping added' })).toHaveCount(
      1,
    );
    await expect(rows.filter({ hasText: 'Group mapping removed' })).toHaveCount(
      1,
    );
    // The subject's type by its name too (the fifth column: subject).
    await expect(rows.first().locator('td').nth(4)).toContainText(
      'Group mapping',
    );
  });
});
