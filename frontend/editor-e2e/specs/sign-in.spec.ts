import { Api } from '../src/api.ts';
import {
  expect,
  openAccountMenu,
  signIn,
  test,
  USERS,
} from '../src/fixtures.ts';

/**
 * Sign-in with OpenID Connect (#37), in the browser: the editor in front of the API with
 * sign-in on (`stack/`, 5.), a local provider, and a group mapping that gives the person a role.
 * The provider's sign-in page takes a login name, no password.
 */
const SIGN_IN_URL = process.env['E2E_SIGN_IN_URL'] ?? '';

test.describe('sign-in with an identity provider @area:shell @area:admin @api:access', () => {
  test.use({
    baseURL: SIGN_IN_URL,
    // Before signing in the editor's reads are refused (401), and there is no demo (404): by
    // design, as a deployment with sign-in answers them.
    consoleAllow: [
      /status of (401 \(Unauthorized\)|404 \(Not Found\) \(http:\/\/127\.0\.0\.1:\d+\/api\/demo\/users)/,
    ],
  });

  test.beforeAll(async () => {
    // Done in the demo API, on the same database: the writers' group gives the author role.
    const admin = await Api.as(USERS.admin);
    try {
      const res = await admin.send('POST', '/group-mappings', {
        data: {
          type: 'GroupMapping',
          attributes: { group: 'e2e-writers' },
          relationships: { role: { data: { type: 'Role', id: 'author' } } },
        },
      });
      // 409: made by a run's earlier try.
      expect([201, 409]).toContain(res.status());
      // A person an admin made before their first sign-in, with the admin role.
      const lead = await admin.send('POST', '/users', {
        data: {
          type: 'User',
          id: 'e2e-lead-user',
          attributes: { name: 'Lead (made)', email: 'e2e-lead@example.org' },
          relationships: { roles: { data: [{ type: 'Role', id: 'admin' }] } },
        },
      });
      expect([201, 409]).toContain(lead.status());
    } finally {
      await admin.dispose();
    }
  });

  test('signs in at the provider, comes back where it was going, and signs out', async ({
    page,
  }) => {
    await page.goto('/content');
    await expect(page).toHaveURL(/\/sign-in\?returnUrl=%2Fcontent/);
    await page
      .getByRole('button', { name: 'Sign in with Mock provider' })
      .click();

    // The provider's own page.
    await expect(
      page.getByRole('heading', { name: 'Mock provider' }),
    ).toBeVisible();
    await page.getByLabel('Login').fill('e2e-writer');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Back, signed in, with the role the group gives.
    await expect(page).toHaveURL(/\/content$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Content' }),
    ).toBeVisible();
    // The session survives a reload: it is a cookie, not the page's state.
    await page.reload();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Content' }),
    ).toBeVisible();

    await openAccountMenu(page, 'E2E Writer');
    // No demo switcher with sign-in.
    await expect(page.getByText('Switch user')).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Sign out' }).click();

    // Signed out here and at the provider, back on the sign-in page.
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(
      page.getByRole('button', { name: 'Sign in with Mock provider' }),
    ).toBeVisible();
    const me = await page.request.get('/api/me');
    expect(me.status()).toBe(401);
  });

  test('marks the role the group gives on the Users page (#592)', async ({
    page,
    browser,
  }) => {
    // Signed in at the provider: the writers' group gives the author role.
    await page.goto('/sign-in');
    await page
      .getByRole('button', { name: 'Sign in with Mock provider' })
      .click();
    await page.getByLabel('Login').fill('e2e-writer');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).not.toHaveURL(/\/sign-in/);

    // An admin of the demo editor, on the same database, sees it marked apart.
    const context = await browser.newContext({
      baseURL: process.env['E2E_BASE_URL'],
    });
    try {
      const admin = await context.newPage();
      await signIn(admin, USERS.admin);
      await admin.goto('/admin/users?q=e2e-writer');
      const row = admin
        .getByRole('region', { name: 'Users' })
        .getByRole('row', { name: /^E2E Writer/ });
      await expect(
        row.getByText('Author, through a sign-in group'),
      ).toBeAttached();
      await expect(admin.getByTestId('group-legend')).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('says why a sign-in came back without a session, in German and dark too', async ({
    page,
  }) => {
    // A callback with no sign-in begun in this browser: refused, never a session.
    await page.goto('/api/auth/oidc/callback?code=forged&state=forged');
    await expect(page).toHaveURL(/\/sign-in\?error=sign-in-expired$/);
    await expect(page.getByRole('alert')).toContainText(
      'That sign-in took too long',
    );

    await page.getByText('Dark', { exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await page.getByText('Deutsch', { exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Die Anmeldung hat zu lange gedauert',
    );
    await expect(
      page.getByRole('button', { name: 'Mit Mock provider anmelden' }),
    ).toBeVisible();
  });

  test('signs in the person an admin made for them, by their verified address', async ({
    page,
  }) => {
    await page.goto('/sign-in');
    await page
      .getByRole('button', { name: 'Sign in with Mock provider' })
      .click();
    await page.getByLabel('Login').fill('e2e-lead');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).not.toHaveURL(/\/sign-in/);
    const me = await page.request.get('/api/me');
    const body = (await me.json()) as {
      data: { id: string; attributes: { roles: { id: string }[] } };
    };
    // The user made before, with their roles, not a new one.
    expect(body.data.id).toBe('e2e-lead-user');
    expect(body.data.attributes.roles.map((r) => r.id)).toContain('admin');
    await expect(page.getByRole('link', { name: 'Admin' })).toBeVisible();
  });

  test('signs in someone the provider knows but no group gives a role', async ({
    page,
  }) => {
    await page.goto('/sign-in');
    await page
      .getByRole('button', { name: 'Sign in with Mock provider' })
      .click();
    await page.getByLabel('Login').fill('e2e-outsider');
    await page.getByRole('button', { name: 'Sign in' }).click();
    // Signed in, but with no role: the shell says what is missing rather than failing.
    await expect(page).not.toHaveURL(/\/sign-in/);
    const me = await page.request.get('/api/me');
    expect(me.status()).toBe(200);
    const body = (await me.json()) as {
      data: { attributes: { name: string; roles: unknown[] } };
    };
    expect(body.data.attributes).toMatchObject({
      name: 'E2E Outsider',
      roles: [],
    });
  });
});
