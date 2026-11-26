import { unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

// Admin (`/admin`): roles, users, project settings, system; terminology (`/terminology`).
test.describe('admin @area:admin @api:access @api:storage-usage @api:jobs', () => {
  test('creates a role, and finds a user by name', async ({ page }) => {
    const name = unique('E2E role');
    await signIn(page, USERS.admin);
    await page.goto('/admin/roles');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Roles and permissions' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'New role' }).click();
    await page.getByRole('textbox', { name: 'Role name' }).fill(name);
    await page
      .getByRole('group', { name: 'Permissions' })
      .getByRole('checkbox')
      .first()
      .click();
    await page.getByRole('button', { name: 'Create role' }).click();
    await expect(
      page.getByRole('region', { name: 'Roles' }).getByText(name).first(),
    ).toBeVisible();

    await page.goto('/admin/users');
    await page
      .getByRole('searchbox', { name: 'Search name, email or ID' })
      .fill('reviewer');
    const users = page.getByRole('region', { name: 'Users' });
    await expect(
      users.getByRole('row', { name: /^Sample Reviewer/ }),
    ).toBeVisible();
    await expect(users.getByRole('row', { name: /^Sample Admin/ })).toHaveCount(
      0,
    );
  });

  test('makes the role a directory provisions with, and gives it to a service account (#377)', async ({
    page,
    api,
  }) => {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const name = unique('E2E directory');
    const accountName = unique('E2E SCIM client');
    const admin = await api(USERS.admin);
    await admin.json(
      admin.send('POST', '/service-accounts', {
        data: {
          type: 'ServiceAccount',
          id: `e2e-scim-${suffix}`,
          attributes: { name: accountName },
        },
      }),
      201,
    );
    await signIn(page, USERS.admin);
    await page.goto('/admin/roles');
    await page.getByRole('button', { name: 'New role' }).click();
    await page.getByRole('textbox', { name: 'Role name' }).fill(name);
    const permissions = page.getByRole('group', { name: 'Permissions' });
    await expect(
      permissions.getByText(
        'Provision users and groups from a directory (SCIM)',
      ),
    ).toBeVisible();
    await permissions
      .getByRole('checkbox', { name: 'scim.provision', exact: true })
      .click();
    // A global permission: no scope applies to it, and the page says so.
    await expect(
      page.getByText(/scim\.provision always apply everywhere/),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Create role' }).click();
    await expect(
      page.getByRole('region', { name: 'Roles' }).getByText(name).first(),
    ).toBeVisible();

    await page
      .getByRole('combobox', { name: /^Add person or service account/ })
      .click();
    await page
      .getByRole('option', { name: `${accountName} (service account)` })
      .click();
    await expect(
      page.getByRole('button', { name: 'Delete role' }),
    ).toBeDisabled();
  });

  test('starts a new role at once: a name typed right after "New role" never meets a discard prompt', async ({
    page,
  }) => {
    const name = unique('E2E quick role');
    await signIn(page, USERS.admin);
    await page.goto('/admin/roles');
    const field = page.getByRole('textbox', { name: 'Role name' });
    // The first role is shown: its name is in the field.
    await expect(field).not.toHaveValue('');
    // "New role" and the name typed in one go, before the page can render again: the
    // fastest typist, every time.
    await page.evaluate((typed) => {
      const button = [...document.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'New role',
      );
      const input = document.querySelector<HTMLInputElement>('#role-name');
      if (!button || !input)
        throw new Error('no New role button or name field');
      button.click();
      input.value = typed;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, name);
    await expect(field).toHaveValue(name);
    await expect(
      page.getByRole('button', { name: 'Create role' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete role' })).toHaveCount(
      0,
    );
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });

  test('keeps a new role started while the first role is still read (#531)', async ({
    page,
  }) => {
    const name = unique('E2E held role');
    // The first role's read is held until the new role's name is typed.
    const held = Promise.withResolvers<void>();
    const asked = Promise.withResolvers<void>();
    let holding = true;
    await page.route(
      (url) => /^\/api\/roles\/[^/]+$/.test(url.pathname),
      async (route) => {
        if (holding && route.request().method() === 'GET') {
          holding = false;
          asked.resolve();
          await held.promise;
        }
        await route.continue();
      },
    );
    await signIn(page, USERS.admin);
    await page.goto('/admin/roles');
    await asked.promise;
    const field = page.getByRole('textbox', { name: 'Role name' });
    let answered: Promise<unknown>;
    try {
      await page.getByRole('button', { name: 'New role' }).click();
      // The form appears in place of the one still read, with its name field focused.
      await expect(field).toBeFocused();
      await field.fill(name);
      answered = page.waitForResponse(
        (r) =>
          r.request().method() === 'GET' &&
          /\/api\/roles\/[^/]+$/.test(new URL(r.url()).pathname),
      );
    } finally {
      // Released however the steps above end, so the read never outlives the test.
      held.resolve();
    }
    await answered;
    await expect(field).toHaveValue(name);
    await page
      .getByRole('group', { name: 'Permissions' })
      .getByRole('checkbox')
      .first()
      .click();
    const created = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname === '/api/roles',
    );
    await page.getByRole('button', { name: 'Create role' }).click();
    expect((await created).status()).toBe(201);
    await expect(
      page.getByRole('region', { name: 'Roles' }).getByText(name).first(),
    ).toBeVisible();
  });

  test('keeps a save answered before the role read a holder change began (#534)', async ({
    page,
    api,
  }) => {
    // A role and a service account of this test's own: the holder it gets is no one else's.
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const roleId = `e2e-reload-${suffix}`;
    const accountName = unique('E2E holder');
    const admin = await api(USERS.admin);
    await admin.json(
      admin.send('POST', '/roles', {
        data: {
          type: 'Role',
          id: roleId,
          attributes: {
            name: unique('E2E reload role'),
            description: null,
            permissions: ['content.read'],
            scope: {},
          },
        },
      }),
      201,
    );
    await admin.json(
      admin.send('POST', '/service-accounts', {
        data: {
          type: 'ServiceAccount',
          id: `e2e-holder-${suffix}`,
          attributes: { name: accountName },
        },
      }),
      201,
    );

    const isRead = (method: string, pathname: string) =>
      method === 'GET' && pathname === `/api/roles/${roleId}`;
    await signIn(page, USERS.admin);
    const first = page.waitForResponse((r) =>
      isRead(r.request().method(), new URL(r.url()).pathname),
    );
    await page.goto(`/admin/roles?role=${roleId}`);
    await first;
    const edit = page.getByRole('checkbox', {
      name: 'content.edit',
      exact: true,
    });
    await expect(edit).not.toBeChecked();

    // The read the holder change starts is answered by the API at once (the role before the
    // save), and that answer is held from the page until the save has answered.
    const held = Promise.withResolvers<void>();
    const asked = Promise.withResolvers<void>();
    let holding = true;
    await page.route(
      (url) => url.pathname === `/api/roles/${roleId}`,
      async (route) => {
        if (!holding || route.request().method() !== 'GET') {
          await route.continue();
          return;
        }
        holding = false;
        const response = await route.fetch();
        asked.resolve();
        await held.promise;
        await route.fulfill({ response });
      },
    );
    let answered: Promise<unknown>;
    try {
      await page
        .getByRole('combobox', { name: /^Add person or service account/ })
        .click();
      await page
        .getByRole('option', { name: `${accountName} (service account)` })
        .click();
      await asked.promise;
      await edit.click();
      const saved = page.waitForResponse(
        (r) =>
          r.request().method() === 'PATCH' &&
          new URL(r.url()).pathname === `/api/roles/${roleId}`,
      );
      await page.getByRole('button', { name: 'Save changes' }).click();
      expect((await saved).status()).toBe(200);
      // The page has taken the save's answer before the held read is let through.
      await expect(
        page.getByRole('button', { name: 'Save changes' }),
      ).toBeDisabled();
      answered = page.waitForResponse((r) =>
        isRead(r.request().method(), new URL(r.url()).pathname),
      );
    } finally {
      // Released however the steps above end, so the read never outlives the test.
      held.resolve();
    }
    await answered;
    // The save stays: still checked, nothing left to save; the new holder counts.
    await expect(edit).toBeChecked();
    await expect(
      page.getByRole('button', { name: 'Save changes' }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Delete role' }),
    ).toBeDisabled();
  });

  test('project settings and the system page', async ({ page }) => {
    await signIn(page, USERS.admin);
    await page.goto('/admin/settings');
    await expect(page.getByRole('region', { name: 'Languages' })).toContainText(
      'German',
    );
    await page.goto('/admin/system');
    await expect(
      page.getByRole('heading', { level: 2, name: 'Storage' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Instance' }),
    ).toBeVisible();
    // Background work (#527): the suite's API runs every role, so it consumes the jobs itself.
    const jobs = page.getByRole('region', { name: 'Background work' });
    await expect(jobs.getByRole('definition').first()).toHaveText(
      /\d+ running/,
    );
    await expect(jobs.getByText('no worker takes them')).toHaveCount(0);
  });

  test.describe('the background work cannot be read', () => {
    test.use({ consoleAllow: [/status of 503.*\/api\/jobs\/status/] });

    test('says so and tries again (#527)', async ({ page }) => {
      let refuse = true;
      await page.route(
        (url) => url.pathname === '/api/jobs/status',
        (route) =>
          refuse
            ? route.fulfill({
                status: 503,
                contentType: 'application/vnd.api+json',
                body: JSON.stringify({
                  errors: [
                    {
                      status: '503',
                      code: 'database-unavailable',
                      title: 'Unavailable',
                    },
                  ],
                }),
              })
            : route.continue(),
      );
      await signIn(page, USERS.admin);
      await page.goto('/admin/system');
      const jobs = page.getByRole('region', { name: 'Background work' });
      await expect(
        jobs.getByText('The state of the background work could not be loaded'),
      ).toBeVisible();
      refuse = false;
      await jobs.getByRole('button', { name: 'Try again' }).click();
      await expect(jobs.getByRole('definition').first()).toHaveText(
        /\d+ running/,
      );
    });
  });
});

test.describe('terminology @area:terminology @api:terms', () => {
  test('lists the terms and searches them', async ({ page }) => {
    await signIn(page, USERS.author);
    await page.goto('/terminology');
    const terms = page.getByRole('region', { name: 'Terms' });
    await expect(terms.getByRole('button', { name: 'battery' })).toBeVisible();
    await page
      .getByRole('searchbox', { name: 'Search terms and definitions' })
      .fill('charger');
    await expect(page).toHaveURL(/[?&]q=charger/);
    await expect(terms.getByRole('button', { name: 'charger' })).toBeVisible();
    await expect(terms.getByRole('button', { name: 'housing' })).toHaveCount(0);
  });
});
