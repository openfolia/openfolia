import { Api, unique } from '../src/api.ts';
import { expect, openAccountMenu, test, USERS } from '../src/fixtures.ts';
import type { Page } from '@playwright/test';

/**
 * Signing in with an email address and a password (#610), in the browser: the editor in front
 * of the API with sign-in on (`stack/`, 5.), where password sign-in is on by default. An admin
 * (signed in at the local provider) invites a person, who opens the one-time link, chooses a
 * password and is signed in; then signs out and in again with it, is told about a wrong one,
 * and changes it. "Forgot password" runs against a mocked API (the email itself: the API's
 * `tests/password-sign-in.e2e.spec.ts`, from an SMTP server). Isolated (`isolated.ts`): it adds
 * people.
 */
const SIGN_IN_URL = process.env['E2E_SIGN_IN_URL'] ?? '';
const PASSWORD = 'a long and quiet river';
const NEWER = 'another long sentence here';

test.use({
  baseURL: SIGN_IN_URL,
  // Before signing in the editor's reads are refused (401), there is no demo (404), a wrong
  // password is 401 and an unknown link 404, on purpose.
  consoleAllow: [
    /status of (401 \(Unauthorized\)|404 \(Not Found\) \(http:\/\/127\.0\.0\.1:\d+\/api\/(demo\/users|auth\/password\/link))/,
  ],
});

test.beforeAll(async () => {
  // In the demo API, on the same database: the admin the provider's account links to.
  const admin = await Api.as(USERS.admin);
  try {
    const res = await admin.send('POST', '/users', {
      data: {
        type: 'User',
        id: 'e2e-pw-admin-user',
        attributes: {
          name: 'Password Admin',
          email: 'e2e-pw-admin@example.org',
        },
        relationships: { roles: { data: [{ type: 'Role', id: 'admin' }] } },
      },
    });
    expect([201, 409]).toContain(res.status());
  } finally {
    await admin.dispose();
  }
});

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto('/sign-in');
  await page
    .getByRole('button', { name: 'Sign in with Mock provider' })
    .click();
  await page.getByLabel('Login').fill('e2e-pw-admin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
}

async function signInWithPassword(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/sign-in');
  const form = page.getByTestId('password-form');
  await form.getByLabel('Email address').fill(email);
  await form.getByLabel('Password', { exact: true }).fill(password);
  await form.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test.describe('sign-in with a password @area:shell @api:access', () => {
  test('an admin invites a person, who sets a password, signs out and in again; another tab follows a sign-in', async ({
    page,
    browser,
  }) => {
    const name = unique('Invited');
    const email = `${name.split(' ')[1]}@example.org`;
    await signInAsAdmin(page);
    await page.goto('/admin/users');
    await page.getByRole('button', { name: 'New user' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByLabel('Email address').fill(email);
    await dialog.getByRole('button', { name: 'Add user' }).click();

    // The invite, shown once.
    await expect(
      page.getByRole('heading', { name: `Invite for ${name}` }),
    ).toBeVisible();
    const link = (await page.getByTestId('sign-in-link').textContent()) ?? '';
    const token = /set-password#(ccms_pwl_[0-9a-f]{64})/.exec(link)?.[1];
    expect(token).toBeDefined();
    await page.getByTestId('sign-in-link-done').click();
    // The list says how they sign in.
    await page
      .getByRole('searchbox', { name: 'Search name, email or ID' })
      .fill(email);
    await expect(
      page
        .getByRole('region', { name: 'Users' })
        .getByText('Invited, not yet signed in'),
    ).toBeVisible();

    // The person, in a browser of their own.
    const theirs = await browser.newContext({ baseURL: SIGN_IN_URL });
    const person = await theirs.newPage();
    try {
      await person.goto(`/set-password#${token}`);
      await expect(
        person.getByRole('heading', { name: `Welcome, ${name}` }),
      ).toBeVisible();
      // The token left the address at once.
      expect(person.url()).not.toContain('ccms_pwl_');
      await person.getByLabel('New password').fill(PASSWORD);
      await person.getByLabel('Repeat the password').fill(PASSWORD);
      await person
        .getByRole('button', { name: 'Set password and sign in' })
        .click();
      await expect(person).not.toHaveURL(/\/(sign-in|set-password)/);
      const me = await person.request.get('/api/me');
      expect(me.status()).toBe(200);

      // Sign out, then in again with the password.
      await openAccountMenu(person, name);
      await person.getByRole('menuitem', { name: 'Sign out' }).click();
      await expect(person).toHaveURL(/\/sign-in$/);
      await signInWithPassword(person, email, PASSWORD);
      await expect(person).not.toHaveURL(/\/sign-in/);

      // Change the password from the account menu.
      await openAccountMenu(person, name);
      await person.getByRole('menuitem', { name: 'Change password' }).click();
      const change = person.getByRole('dialog');
      await change.getByLabel('Current password').fill(PASSWORD);
      await change.getByLabel('New password', { exact: true }).fill(NEWER);
      await change.getByLabel('Repeat the new password').fill(NEWER);
      await change.getByRole('button', { name: 'Change password' }).click();
      // Done: the dialog closes (with a toast saying how many other sessions ended).
      await expect(change).toBeHidden();

      // The old one no longer works, and says so.
      await openAccountMenu(person, name);
      await person.getByRole('menuitem', { name: 'Sign out' }).click();
      await expect(person).toHaveURL(/\/sign-in$/);
      await signInWithPassword(person, email, PASSWORD);
      await expect(person.getByTestId('password-error')).toHaveText(
        'The email address or the password is not right.',
      );
      await signInWithPassword(person, email, NEWER);
      await expect(person).not.toHaveURL(/\/sign-in/);

      // Someone else signs in in another tab of the same browser (#716): the session cookie is
      // theirs now, and this tab follows at once, without a reload, rather than keep showing
      // (and keying what it read on) the person before.
      const other = await theirs.newPage();
      await other.goto('/');
      await openAccountMenu(other, name);
      await other.getByRole('menuitem', { name: 'Sign out' }).click();
      await expect(other).toHaveURL(/\/sign-in$/);
      await signInAsAdmin(other);
      await openAccountMenu(person, 'E2E Password Admin');
      await expect(
        person.getByRole('menuitem', { name: 'Sign out' }),
      ).toBeVisible();
    } finally {
      await theirs.close();
    }
  });

  test('a wrong password shows an error, in German and dark too', async ({
    page,
  }) => {
    await signInWithPassword(page, 'nobody@example.org', 'not the password');
    await expect(page.getByTestId('password-error')).toHaveText(
      'The email address or the password is not right.',
    );
    await page.getByText('Dark', { exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await page.getByText('Deutsch', { exact: true }).click();
    await expect(page.getByLabel('E-Mail-Adresse')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Anmelden', exact: true }),
    ).toBeVisible();
  });

  test('"Forgot password" always answers the same (mocked email)', async ({
    page,
  }) => {
    // Email is not set up on the stack: the API's options and answer, as with email.
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
    let asked = '';
    await page.route('**/api/auth/password/forgot', (route) => {
      asked = route.request().postData() ?? '';
      return route.fulfill({
        status: 202,
        contentType: 'application/vnd.api+json',
        body: JSON.stringify({
          meta: { message: 'If the address is known, an email is on its way.' },
        }),
      });
    });
    await page.goto('/sign-in');
    await page.getByTestId('forgot-password').click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await page.getByLabel('Email address').fill('someone@example.org');
    await page.getByRole('button', { name: 'Send the link' }).click();
    await expect(page.getByTestId('forgot-sent')).toContainText(
      'If the address is known, an email is on its way.',
    );
    expect(JSON.parse(asked)).toEqual({
      data: {
        type: 'PasswordReset',
        attributes: { email: 'someone@example.org' },
      },
    });
  });

  test('a used or unknown link says so', async ({ page }) => {
    await page.goto(`/set-password#ccms_pwl_${'0'.repeat(64)}`);
    await expect(
      page.getByRole('heading', { name: 'This link does not work' }),
    ).toBeVisible();
    await page.getByText('Go to sign-in').click();
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});
