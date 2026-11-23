import type { Page } from '@playwright/test';
import { Api, unique } from '../src/api.ts';
import {
  expect,
  expectNoSideways,
  signIn,
  test,
  USERS,
} from '../src/fixtures.ts';

/**
 * Admin's group mappings (#592): which identity-provider group's members hold which role. Each
 * flow maps a group of its own (`unique()`), which nobody in the run is a member of, so no one's
 * roles change; and removes it again, through the API when the flow itself did not.
 */

/** Makes a mapping of the flow's own through the API; answers its ID. */
async function mapGroup(group: string, roleId: string): Promise<string> {
  const admin = await Api.as(USERS.admin);
  try {
    const { data } = await admin.json<{ data: { id: string } }>(
      admin.send('POST', '/group-mappings', {
        data: {
          type: 'GroupMapping',
          attributes: { group },
          relationships: { role: { data: { type: 'Role', id: roleId } } },
        },
      }),
      201,
    );
    return data.id;
  } finally {
    await admin.dispose();
  }
}

/** The mappings of `group` left in the database (removed here, so a failed flow leaves none). */
async function unmapGroup(group: string): Promise<number> {
  const admin = await Api.as(USERS.admin);
  try {
    const { data } = await admin.json<{ data: { id: string }[] }>(
      admin.get(`/group-mappings?filter[group]=${encodeURIComponent(group)}`),
    );
    for (const { id } of data) {
      await admin.json(admin.send('DELETE', `/group-mappings/${id}`), 204);
    }
    return data.length;
  } finally {
    await admin.dispose();
  }
}

const table = (page: Page) =>
  page.getByRole('region', { name: 'Group mappings' });

test.describe('group mappings @area:admin @api:access', () => {
  // The API's refusals the flows provoke: a mapping added twice, the last admins' mapping.
  test.use({
    consoleAllow: [
      /status of 409 \(Conflict\) \(http:\/\/127\.0\.0\.1:\d+\/api\/group-mappings/,
    ],
  });

  test('adds a mapping from the rail, refuses the same one twice, and removes it', async ({
    page,
  }) => {
    const group = unique('e2e-group');
    try {
      await signIn(page, USERS.admin);
      await page.goto('/admin/users');
      await page
        .getByRole('navigation', { name: 'Admin sections' })
        .getByRole('link', { name: 'Group mappings' })
        .click();
      await expect(
        page.getByRole('heading', { level: 1, name: 'Group mappings' }),
      ).toBeVisible();
      // Filtered to the role used here: the list other flows add to stays short.
      await page.getByRole('combobox', { name: 'Role' }).click();
      await page.getByRole('option', { name: 'Reader', exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/group-mappings\?role=reader$/);

      const add = async () => {
        await page.getByRole('button', { name: 'Add mapping' }).first().click();
        const dialog = page.getByRole('dialog', { name: 'Add group mapping' });
        await dialog.getByRole('textbox', { name: 'Group' }).fill(group);
        await dialog.getByRole('combobox', { name: 'Role' }).click();
        await page.getByRole('option', { name: 'Reader', exact: true }).click();
        const created = page.waitForResponse(
          (r) =>
            r.url().endsWith('/api/group-mappings') &&
            r.request().method() === 'POST',
        );
        await dialog.getByRole('button', { name: 'Add mapping' }).click();
        return { dialog, response: await created };
      };

      // Added: the row shows the group and the role by name.
      const first = await add();
      expect(first.response.status()).toBe(201);
      await expect(first.dialog).toHaveCount(0);
      const row = table(page).getByRole('row').filter({ hasText: group });
      await expect(row).toBeVisible();
      await expect(row).toContainText('Reader');
      await expectNoSideways(page);

      // The same group and role again: refused, said in the dialog, which stays open.
      const again = await add();
      expect(again.response.status()).toBe(409);
      await expect(again.dialog.getByRole('alert')).toHaveText(
        'This group gives this role already.',
      );
      await again.dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(again.dialog).toHaveCount(0);

      // Removed after asking: the row goes.
      await row.getByRole('button', { name: /^Remove the mapping of/ }).click();
      const confirm = page.getByRole('alertdialog');
      await expect(confirm).toContainText(
        `Members of “${group}” lose the role “Reader” at once`,
      );
      const removed = page.waitForResponse(
        (r) =>
          r.url().includes('/api/group-mappings/') &&
          r.request().method() === 'DELETE',
      );
      await confirm.getByRole('button', { name: 'Remove' }).click();
      expect((await removed).status()).toBe(204);
      await expect(row).toHaveCount(0);
      // Gone through the screen: nothing left to remove.
      expect(await unmapGroup(group)).toBe(0);
    } finally {
      // None left behind if a step failed (never hiding that step's error).
      await unmapGroup(group).catch(() => 0);
    }
  });

  test('opens filtered to a role from the Roles page', async ({ page }) => {
    const group = unique('e2e-filter');
    await mapGroup(group, 'reviewer');
    try {
      await signIn(page, USERS.admin);
      await page.goto('/admin/roles?role=reviewer');
      await page
        .getByRole('link', { name: 'Show the groups that give this role' })
        .click();
      await expect(page).toHaveURL(/\/admin\/group-mappings\?role=reviewer$/);
      await expect(
        page.getByRole('combobox', { name: 'Role' }).first(),
      ).toContainText('Reviewer');
      await expect(
        table(page).getByRole('row').filter({ hasText: group }),
      ).toBeVisible();
    } finally {
      await unmapGroup(group).catch(() => 0);
    }
  });

  test('says in plain words why a removal that would leave no admin is refused (409 last-admin)', async ({
    page,
  }) => {
    const group = unique('e2e-last-admin');
    const id = await mapGroup(group, 'reader');
    try {
      // The run's admins hold their role directly, so the API would remove it: the refusal it
      // sends when the group's members are the last admins is answered here instead.
      await page.route(
        (url) => url.pathname === `/api/group-mappings/${id}`,
        (route) =>
          route.request().method() === 'DELETE'
            ? route.fulfill({
                status: 409,
                contentType: 'application/vnd.api+json',
                body: JSON.stringify({
                  errors: [
                    {
                      status: '409',
                      title: 'Conflict',
                      detail:
                        'This would leave no active user who can manage roles.',
                      code: 'last-admin',
                    },
                  ],
                }),
              })
            : route.continue(),
      );
      await signIn(page, USERS.admin);
      await page.goto('/admin/group-mappings?role=reader');
      const row = table(page).getByRole('row').filter({ hasText: group });
      await row.getByRole('button', { name: /^Remove the mapping of/ }).click();
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Remove' })
        .click();

      const refusal = page.getByRole('alertdialog', {
        name: 'This mapping stays',
      });
      await expect(refusal).toContainText(
        'Removing it would leave nobody who can manage roles',
      );
      await expect(refusal).toContainText(`“${group}”`);
      await refusal.getByRole('button', { name: 'Understood' }).click();
      await expect(refusal).toHaveCount(0);
      // Nothing was removed.
      await expect(row).toBeVisible();
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      // Still there after the refusal: removed here.
      expect(await unmapGroup(group)).toBe(1);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await unmapGroup(group).catch(() => 0);
    }
  });
});
