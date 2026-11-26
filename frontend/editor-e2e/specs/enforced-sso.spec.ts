import type { Browser, Page } from '@playwright/test';

import { Api, unique } from '../src/api.ts';
import { expect, test, tipsOff, USERS } from '../src/fixtures.ts';

/**
 * Single sign-on required (#378), in the browser: the editor in front of the API with sign-in on
 * (`stack/`, 5.). An administrator names the emergency account and requires single sign-on; who
 * signed in with a password is out at once, the emergency account gets in and everyone
 * responsible learns of it. Isolated (`isolated.ts`): it changes installation settings (put back
 * after each test) and adds people.
 */
const SIGN_IN_URL = process.env['E2E_SIGN_IN_URL'] ?? '';
const PASSWORD = 'a long and quiet river';

test.describe.configure({ mode: 'serial' });
test.use({
  baseURL: SIGN_IN_URL,
  // Before signing in and once a session has ended the reads are refused (401), there is no demo
  // (404), and requiring single sign-on from a password session is a 409, on purpose.
  consoleAllow: [
    /status of (401 \(Unauthorized\)|404 \(Not Found\) \(http:\/\/127\.0\.0\.1:\d+\/api\/demo\/users|409 \(Conflict\) \(http:\/\/127\.0\.0\.1:\d+\/api\/settings)/,
  ],
});

const headers = {
  'Content-Type': 'application/vnd.api+json',
  Origin: SIGN_IN_URL,
};

async function signInAtProvider(page: Page): Promise<void> {
  await page.goto('/sign-in');
  await page
    .getByRole('button', { name: 'Sign in with Mock provider' })
    .click();
  await page.getByLabel('Login').fill('e2e-pw-admin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
}

async function fillPassword(page: Page, email: string): Promise<void> {
  const form = page.getByTestId('password-form');
  await form.getByLabel('Email address').fill(email);
  await form.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await form.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** A person signed in with the password they chose from their invite, in a browser of their own. */
async function withPassword(
  admin: Page,
  browser: Browser,
  label: string,
  role: string,
) {
  const name = unique(label);
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const email = `${id}@example.org`;
  const made = await admin.request.post('/api/users', {
    headers,
    data: {
      data: {
        type: 'User',
        id,
        attributes: { name, email },
        relationships: { roles: { data: [{ type: 'Role', id: role }] } },
      },
    },
  });
  expect(made.status()).toBe(201);
  const invite = await admin.request.post(`/api/users/${id}/invite`, {
    headers,
    data: {},
  });
  expect(invite.ok()).toBe(true);
  const { token } = (await invite.json()).meta as { token: string };
  const context = await browser.newContext({ baseURL: SIGN_IN_URL });
  const page = await context.newPage();
  await tipsOff(page);
  await page.goto(`/set-password#${token}`);
  await page.getByLabel('New password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Repeat the password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Set password and sign in' }).click();
  await expect(page).not.toHaveURL(/\/(sign-in|set-password)/);
  return { id, name, email, page, context };
}

/** Chooses the emergency account by searching its name. */
async function nameEmergencyAccount(page: Page, name: string): Promise<void> {
  await page.getByTestId('emergency-account-choose').click();
  await page.getByPlaceholder('Search people').fill(name);
  await page
    .getByTestId('emergency-account-people')
    .getByRole('option', { name })
    .click();
  await expect(page.getByTestId('emergency-account')).toHaveText(name);
}

test.beforeAll(async () => {
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

test.describe('single sign-on required @area:shell @area:admin @api:access @api:settings', () => {
  test.afterEach(async () => {
    const admin = await Api.as(USERS.admin);
    try {
      await admin.json(
        admin.send('PATCH', '/settings', {
          data: {
            type: 'InstallationSettings',
            id: 'installation',
            attributes: {
              singleSignOn: 'optional',
              sessionIdleMinutes: null,
              sessionMaxHours: null,
            },
            relationships: { breakGlassAccount: { data: null } },
          },
        }),
      );
    } finally {
      await admin.dispose();
    }
  });

  test('ends password sessions at once, lets the emergency account in and tells the administrators', async ({
    page: admin,
    browser,
  }) => {
    await signInAtProvider(admin);
    const writer = await withPassword(admin, browser, 'Writer', 'author');
    const rescue = await withPassword(admin, browser, 'Rescue', 'admin');
    try {
      await admin.goto('/admin/settings/single-sign-on');
      await nameEmergencyAccount(admin, rescue.name);

      // Asked first; Cancel keeps it as it was.
      const required = admin.locator('[data-option="required"]');
      await required.click();
      const question = admin.getByRole('alertdialog');
      await expect(question).toContainText('signed out at once');
      await question.getByRole('button', { name: 'Cancel' }).click();
      await expect(question).toBeHidden();
      await expect(required.getByRole('radio')).not.toBeChecked();
      await required.click();
      const saved = admin.waitForResponse(
        (r) =>
          r.url().endsWith('/api/settings') && r.request().method() === 'PATCH',
      );
      await question
        .getByRole('button', { name: 'Require single sign-on' })
        .click();
      expect((await saved).status()).toBe(200);
      await expect(required.getByRole('radio')).toBeChecked();

      // Who signed in with a password is out, and is told so.
      expect((await writer.page.request.get('/api/me')).status()).toBe(401);
      await writer.page.reload();
      await expect(writer.page).toHaveURL(/\/sign-in/);
      await expect(
        writer.page.getByRole('button', { name: 'Sign in with Mock provider' }),
      ).toBeVisible();
      await expect(writer.page.getByTestId('password-form')).toHaveCount(0);

      // The emergency sign-in is for the one account: another's right password is refused.
      await writer.page.getByTestId('emergency-sign-in').click();
      await fillPassword(writer.page, writer.email);
      await expect(writer.page.getByTestId('password-error')).toContainText(
        'The email address or the password is not right',
      );
      expect((await writer.page.request.get('/api/me')).status()).toBe(401);

      // It gets in with its password, in another browser.
      const context = await browser.newContext({ baseURL: SIGN_IN_URL });
      const page = await context.newPage();
      await tipsOff(page);
      await page.goto('/sign-in');
      await page.getByTestId('emergency-sign-in').click();
      await fillPassword(page, rescue.email);
      await expect(page).not.toHaveURL(/\/sign-in/);

      // Recorded, and told: the audit log and the bell.
      await page.goto('/admin/audit?action=user.break-glass-sign-in');
      await expect(
        page
          .getByRole('row')
          .filter({ hasText: rescue.name })
          .filter({ hasText: 'Emergency sign-in' }),
      ).toBeVisible();
      await context.close();
      await expect(async () => {
        const res = await admin.request.get(
          '/api/me/notifications?page[size]=5',
        );
        expect(JSON.stringify(await res.json())).toContain(
          'sign-in.break-glass',
        );
      }).toPass();

      // Turned off again here: everyone's ways are back, the ended session is not.
      await admin.goto('/admin/settings/single-sign-on');
      await admin.locator('[data-option="optional"]').click();
      await expect(
        admin.locator('[data-option="optional"]').getByRole('radio'),
      ).toBeChecked();
      await expect(admin.getByRole('alertdialog')).toHaveCount(0);
      await expect(async () => {
        const res = await admin.request.get('/api/auth/options');
        expect(await res.text()).toContain('"singleSignOn":false');
      }).toPass();
      expect((await writer.page.request.get('/api/me')).status()).toBe(401);
      await writer.page.goto('/sign-in');
      await fillPassword(writer.page, writer.email);
      await expect(writer.page).not.toHaveURL(/\/sign-in/);
    } finally {
      await writer.context.close();
      await rescue.context.close();
    }
  });

  test('is not required by someone it would lock out, and says what to do', async ({
    page: admin,
    browser,
  }) => {
    await signInAtProvider(admin);
    const other = await withPassword(admin, browser, 'Local admin', 'admin');
    try {
      const { page } = other;
      await page.goto('/admin/settings/single-sign-on');
      await page.locator('[data-option="required"]').click();
      const question = page.getByRole('alertdialog');
      await expect(question).toContainText('There is no emergency account');
      await question
        .getByRole('button', { name: 'Require single sign-on' })
        .click();
      await expect(page.getByTestId('single-sign-on-refused')).toContainText(
        'Sign in with the identity provider first',
      );
      await expect(
        page.locator('[data-option="optional"]').getByRole('radio'),
      ).toBeChecked();
      expect((await page.request.get('/api/me')).status()).toBe(200);
      // As the emergency account, they stay in.
      await nameEmergencyAccount(page, other.name);
      await page.locator('[data-option="required"]').click();
      await question
        .getByRole('button', { name: 'Require single sign-on' })
        .click();
      await expect(
        page.locator('[data-option="required"]').getByRole('radio'),
      ).toBeChecked();
      await expect(page.getByTestId('single-sign-on-refused')).toHaveCount(0);
      expect((await page.request.get('/api/me')).status()).toBe(200);
    } finally {
      await other.context.close();
    }
  });

  test('session limits are offered by name and kept within each other', async ({
    page: admin,
  }) => {
    await signInAtProvider(admin);
    await admin.goto('/admin/settings/single-sign-on');
    const max = admin.locator('[data-slot="sessionMaxHours"]');
    await expect(max).toContainText('The server’s setting (7 days)');
    await max.getByRole('combobox').click();
    await admin.getByRole('option', { name: '12 hours' }).click();
    await expect(max).toContainText('12 hours');
    const idle = admin.locator('[data-slot="sessionIdleMinutes"]');
    await idle.getByRole('combobox').click();
    // Longer than the lifetime: not to be chosen.
    await expect(
      admin.getByRole('option', { name: '1 day', exact: true }),
    ).toBeDisabled();
    await admin.getByRole('option', { name: '30 minutes' }).click();
    await expect(idle).toContainText('30 minutes');
    await admin.reload();
    await expect(idle).toContainText('30 minutes');
    await expect(max).toContainText('12 hours');
  });
});
