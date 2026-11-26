import type { Page } from '@playwright/test';

import { Api, moduleId, paragraph, unique, type UserId } from '../src/api.ts';
import { idleOutSessions } from '../src/database.ts';
import { expect, test, tipsOff, USERS } from '../src/fixtures.ts';

/**
 * A session that ends while someone writes (#378), in the browser: the editor in front of the API
 * with sign-in on (`stack/`, 5.). It goes to the sign-in page without a question, and what was
 * typed is there again after signing in.
 */
const SIGN_IN_URL = process.env['E2E_SIGN_IN_URL'] ?? '';
/** Their sessions are ended: no other flow signs in as them, nor do two of these. */
const WRITER = 'e2e-ended' as UserId;
const AWAY = 'e2e-away';

async function signInAtProvider(page: Page, login: string): Promise<void> {
  await page
    .getByRole('button', { name: 'Sign in with Mock provider' })
    .click();
  await page.getByLabel('Login').fill(login);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('a session that ends @area:shell @area:module-editor @api:access', () => {
  test.use({
    baseURL: SIGN_IN_URL,
    // Before signing in and once the session has ended the reads are refused (401), and there is
    // no demo (404): by design.
    consoleAllow: [
      /status of (401 \(Unauthorized\)|404 \(Not Found\) \(http:\/\/127\.0\.0\.1:\d+\/api\/demo\/users)/,
    ],
  });

  test.beforeAll(async () => {
    const admin = await Api.as(USERS.admin);
    try {
      const res = await admin.send('POST', '/group-mappings', {
        data: {
          type: 'GroupMapping',
          attributes: { group: 'e2e-writers' },
          relationships: { role: { data: { type: 'Role', id: 'author' } } },
        },
      });
      // 409: made by another flow.
      expect([201, 409]).toContain(res.status());
    } finally {
      await admin.dispose();
    }
  });

  test('goes to sign-in at once and gives the unsaved text back after it', async ({
    page,
  }) => {
    await tipsOff(page);
    await page.goto('/sign-in');
    await signInAtProvider(page, WRITER);
    await expect(page).not.toHaveURL(/\/sign-in/);

    const writer = await Api.as(WRITER);
    try {
      const changeSet = await writer.createChangeSet(unique('Session end'));
      const id = moduleId();
      await writer.createModule(changeSet, {
        lang: 'en',
        moduleId: id,
        title: 'Battery care',
        blocks: [paragraph('p1', 'Charge it.')],
      });
      await page.goto(`/content/en/${id}?cs=${changeSet.id}`);
      await expect(page.getByText('Locked by you')).toBeVisible();
      const editor = page.getByRole('textbox', { name: 'Module Battery care' });

      // Idle for too long, then the person comes back and types on.
      await idleOutSessions(WRITER);
      await editor.getByText('Charge it.').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' Typed after the session ended.');

      // No question on the way: the text is kept here.
      await expect(page).toHaveURL(/\/sign-in\?returnUrl=/);
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expect(page.getByTestId('session-ended')).toHaveText(
        'Your session has ended. Sign in to go on.',
      );
      // The provider knows them still: it sends them straight back.
      await page
        .getByRole('button', { name: 'Sign in with Mock provider' })
        .click();

      await expect(page).toHaveURL(new RegExp(`/content/en/${id}`));
      await expect(
        editor.getByText('Charge it. Typed after the session ended.'),
      ).toBeVisible();
      await expect(
        page.getByRole('status').filter({ hasText: /^Saved/ }),
      ).toBeVisible();
    } finally {
      await writer.cleanUp();
      await writer.dispose();
    }
  });

  test('an open tab nobody uses lets its session end', async ({ page }) => {
    // The bell asks every 30 seconds while the tab is visible: not a person.
    await page.clock.install();
    await page.goto('/sign-in');
    await signInAtProvider(page, AWAY);
    await expect(page).not.toHaveURL(/\/sign-in/);
    const poll = async () => {
      const asked = page.waitForRequest((request) =>
        request.url().endsWith('/me/notifications/unread-count'),
      );
      await page.clock.runFor(31_000);
      const request = await asked;
      await request.response();
      return request.headers()['x-ccms-background'];
    };
    await poll();
    await poll();
    expect(await poll()).toBe('1');
    // Someone is back: the next one counts again.
    await page.mouse.move(200, 200);
    expect(await poll()).toBeUndefined();
  });
});
