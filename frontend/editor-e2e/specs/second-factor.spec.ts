import { createHmac } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';

import { Api, unique } from '../src/api.ts';
import {
  expect,
  openAccountMenu,
  test,
  tipsOff,
  USERS,
} from '../src/fixtures.ts';

/**
 * Two-factor sign-in (#611), in the browser: the editor in front of the API with sign-in on
 * (`stack/`, 5.). A person sets it up in the account menu, signs in with a code and with a
 * recovery code, and an admin resets it; where the installation requires it, a new person sets
 * it up before anything else. Isolated (`isolated.ts`): it changes an installation setting (put
 * back after each test) and adds people.
 */
const SIGN_IN_URL = process.env['E2E_SIGN_IN_URL'] ?? '';
const PASSWORD = 'a long and quiet river';

test.describe.configure({ mode: 'serial' });
test.use({
  baseURL: SIGN_IN_URL,
  // Before signing in the editor's reads are refused (401) and there is no demo (404); a wrong
  // code is 403 and no open second step 410, on purpose.
  consoleAllow: [
    /status of (401 \(Unauthorized\)|404 \(Not Found\) \(http:\/\/127\.0\.0\.1:\d+\/api\/demo\/users|403 \(Forbidden\) \(http:\/\/127\.0\.0\.1:\d+\/api\/auth\/second-factor|410 \(Gone\) \(http:\/\/127\.0\.0\.1:\d+\/api\/auth\/second-factor)/,
  ],
});

/** The code an authenticator app shows for `secret`, `ahead` steps of 30 seconds from now. */
function appCode(secret: string, ahead = 0): string {
  const bits = [...secret.replace(/\s/g, '')]
    .map((c) =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
        .indexOf(c)
        .toString(2)
        .padStart(5, '0'),
    )
    .join('');
  const key = Buffer.from(
    (bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)),
  );
  const step = Buffer.alloc(8);
  step.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + ahead));
  const mac = createHmac('sha1', key).update(step).digest();
  const at = (mac.at(-1) ?? 0) & 15;
  return String((mac.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(
    6,
    '0',
  );
}

/** Six digits that are no code of now or the steps around it. */
function wrongCode(secret: string): string {
  const right = [-2, -1, 0, 1, 2].map((ahead) => appCode(secret, ahead));
  return ['000000', '111111', '222222', '333333', '444444', '555555'].find(
    (code) => !right.includes(code),
  )!;
}

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto('/sign-in');
  await page
    .getByRole('button', { name: 'Sign in with Mock provider' })
    .click();
  await page.getByLabel('Login').fill('e2e-pw-admin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
}

async function passwordStep(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  const form = page.getByTestId('password-form');
  await form.getByLabel('Email address').fill(email);
  await form.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await form.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function signOut(page: Page, name: string): Promise<void> {
  await openAccountMenu(page, name);
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
}

/** A person invited by the admin, with a browser of their own at their invite. */
async function invited(admin: Page, browser: Browser) {
  const name = unique('Two-step');
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const email = `${id}@example.org`;
  const headers = {
    'Content-Type': 'application/vnd.api+json',
    Origin: SIGN_IN_URL,
  };
  const made = await admin.request.post('/api/users', {
    headers,
    data: {
      data: {
        type: 'User',
        id,
        attributes: { name, email },
        relationships: { roles: { data: [{ type: 'Role', id: 'author' }] } },
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
  const context = await browser.newContext({
    baseURL: SIGN_IN_URL,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  await tipsOff(page);
  await page.goto(`/set-password#${token}`);
  await page.getByLabel('New password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Repeat the password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Set password and sign in' }).click();
  return { id, name, email, page, context };
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

test.describe('two-factor sign-in @area:shell @area:admin @api:access @api:settings', () => {
  test.afterEach(async () => {
    const admin = await Api.as(USERS.admin);
    try {
      await admin.json(
        admin.send('PATCH', '/settings', {
          data: {
            type: 'InstallationSettings',
            id: 'installation',
            attributes: { secondFactor: 'optional' },
          },
        }),
      );
    } finally {
      await admin.dispose();
    }
  });

  test('a person sets it up, signs in with a code and a recovery code, and an admin resets it', async ({
    page: admin,
    browser,
  }) => {
    await signInAsAdmin(admin);
    const person = await invited(admin, browser);
    const { page } = person;
    try {
      await expect(page).not.toHaveURL(/\/(sign-in|set-password)/);

      // Set up in the account menu: the password first, then the app.
      await openAccountMenu(page, person.name);
      await page.getByRole('menuitem', { name: 'Two-factor sign-in' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Your password').fill('not the password');
      await dialog.getByTestId('second-factor-submit').click();
      await expect(dialog.getByRole('alert')).toHaveText(
        'Your current password is not right.',
      );
      await dialog.getByLabel('Your password').fill(PASSWORD);
      await dialog.getByTestId('second-factor-submit').click();
      await expect(dialog.getByTestId('second-factor-qr')).toBeVisible();
      const secret =
        (await dialog.getByTestId('second-factor-secret').textContent()) ?? '';
      const code = dialog.getByLabel('Code from your authenticator app');
      await expect(code).toBeFocused();
      await code.fill(wrongCode(secret));
      await dialog.getByTestId('second-factor-submit').click();
      await expect(dialog.getByRole('alert')).toContainText(
        'The code is not right',
      );
      await code.fill(appCode(secret));
      await dialog.getByTestId('second-factor-submit').click();

      // Ten recovery codes, shown once.
      const codes = dialog.getByTestId('recovery-codes').getByRole('listitem');
      await expect(codes).toHaveCount(10);
      const recovery = (await codes.allTextContents()).map((c) => c.trim());
      await dialog.getByTestId('recovery-codes-copy').click();
      await expect(dialog.getByTestId('recovery-codes-copy')).toHaveText(
        /Codes copied/,
      );
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        recovery.join('\n'),
      );
      const download = page.waitForEvent('download');
      await dialog.getByTestId('recovery-codes-download').click();
      expect((await download).suggestedFilename()).toBe('recovery-codes.txt');
      // Every way to close them asks first, Back too: it leaves the page only then.
      const here = page.url();
      const question = page.getByRole('alertdialog');
      for (const way of ['Back', 'Escape', 'X']) {
        if (way === 'Back') await page.goBack();
        else if (way === 'Escape') await page.keyboard.press('Escape');
        else await dialog.getByTestId('z-close-header-button').click();
        await expect(question).toBeVisible();
        await question
          .getByRole('button', { name: 'Back to the codes' })
          .click();
        await expect(question).toBeHidden();
        expect(page.url()).toBe(here);
        await expect(codes).toHaveCount(10);
      }
      await dialog.getByTestId('second-factor-done').click();
      await expect(dialog).toBeHidden();
      await signOut(page, person.name);

      // The password alone signs nobody in: no session, no API, no other page.
      await passwordStep(page, person.email);
      await expect(page).toHaveURL(/\/sign-in-two-factor$/);
      expect((await page.request.get('/api/me')).status()).toBe(401);
      await page.goto('/admin/users');
      await expect(page).toHaveURL(/\/sign-in\?/);
      await page.goto('/sign-in-two-factor');
      const second = page.getByLabel('Code from your authenticator app');
      await expect(second).toBeFocused();
      await second.fill(wrongCode(secret));
      await second.press('Enter');
      await expect(page.getByTestId('second-factor-error')).toContainText(
        'The code is not right',
      );
      await expect(second).toBeFocused();
      // The next code (this step's was used to turn it on), pasted whole with a space.
      const next = appCode(secret, 1);
      await page.evaluate(
        (text) => navigator.clipboard.writeText(text),
        `${next.slice(0, 3)} ${next.slice(3)}`,
      );
      await second.press('ControlOrMeta+v');
      await second.press('Enter');
      await expect(page).not.toHaveURL(/\/sign-in/);
      expect((await page.request.get('/api/me')).status()).toBe(200);
      await signOut(page, person.name);

      // Without the phone: a recovery code, once.
      for (const works of [true, false]) {
        await passwordStep(page, person.email);
        await page.getByTestId('second-factor-other-way').click();
        const field = page.getByLabel('Recovery code');
        await expect(field).toBeFocused();
        await field.fill((recovery[0] ?? '').toLowerCase());
        await field.press('Enter');
        if (works) {
          await expect(page).not.toHaveURL(/\/sign-in/);
          await openAccountMenu(page, person.name);
          await page
            .getByRole('menuitem', { name: 'Two-factor sign-in' })
            .click();
          await expect(page.getByText('9 recovery codes left')).toBeVisible();
          await page.keyboard.press('Escape');
          await expect(page.getByRole('dialog')).toBeHidden();
          await signOut(page, person.name);
        } else {
          await expect(page.getByTestId('second-factor-error')).toContainText(
            'This recovery code is not right',
          );
        }
      }

      // The phone is lost: an admin resets it, and the password is enough again.
      await admin.goto(`/admin/users?q=${person.id}`);
      const menu = admin.getByTestId('user-menu');
      // By keyboard: Escape at the question gives the focus back to the row's menu button.
      await menu.focus();
      await admin.keyboard.press('Enter');
      const reset = admin.getByRole('menuitem', { name: 'Reset two-factor' });
      await expect(reset).toBeVisible();
      await expect(async () => {
        await admin.keyboard.press('ArrowDown');
        await expect(reset).toBeFocused({ timeout: 100 });
      }).toPass();
      await admin.keyboard.press('Enter');
      await expect(admin.getByRole('alertdialog')).toBeVisible();
      await admin.keyboard.press('Escape');
      await expect(admin.getByRole('alertdialog')).toBeHidden();
      await expect(menu).toBeFocused();
      await menu.click();
      await reset.click();
      await admin
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Reset two-factor' })
        .click();
      await expect(
        admin.getByText(`Two-factor sign-in of ${person.name} reset.`),
      ).toBeVisible();
      await expect(admin.locator('[data-slot="second-factor"]')).toBeHidden();
      await passwordStep(page, person.email);
      await expect(page).not.toHaveURL(/\/sign-in/);
      expect((await page.request.get('/api/me')).status()).toBe(200);
    } finally {
      await person.context.close();
    }
  });

  test('where it is required, a new person sets it up before anything else', async ({
    page: admin,
    browser,
  }) => {
    await signInAsAdmin(admin);
    await admin.goto('/admin/settings/two-factor');
    const saved = admin.waitForResponse(
      (r) =>
        r.url().endsWith('/api/settings') && r.request().method() === 'PATCH',
    );
    await admin.locator('[data-option="everyone"]').click();
    expect((await saved).status()).toBe(200);

    const person = await invited(admin, browser);
    const { page } = person;
    try {
      await expect(
        page.getByRole('heading', { name: 'Set up two-factor sign-in' }),
      ).toBeVisible();
      // Nothing else first.
      expect((await page.request.get('/api/me')).status()).toBe(401);
      await page.goto('/');
      await expect(page).toHaveURL(/\/sign-in$/);
      await passwordStep(page, person.email);
      const secret =
        (await page.getByTestId('second-factor-secret').textContent()) ?? '';
      const code = page.getByLabel('Code from your authenticator app');
      await code.fill(appCode(secret));
      await page.getByRole('button', { name: 'Turn on and sign in' }).click();
      await expect(
        page.getByTestId('recovery-codes').getByRole('listitem'),
      ).toHaveCount(10);
      await page.getByTestId('second-factor-continue').click();
      await expect(page).not.toHaveURL(/\/sign-in/);
      expect((await page.request.get('/api/me')).status()).toBe(200);
    } finally {
      await person.context.close();
    }
  });

  test('without an open second step the page starts again, in German and dark too', async ({
    page,
  }) => {
    await page.goto('/sign-in-two-factor');
    await expect(
      page.getByRole('heading', { name: 'Sign in again' }),
    ).toBeVisible();
    await page.getByText('Dark', { exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await page.getByText('Deutsch', { exact: true }).click();
    await expect(page.getByTestId('second-factor-again')).toHaveText(
      'Zurück zur Anmeldung',
    );
    await page.getByTestId('second-factor-again').click();
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});
