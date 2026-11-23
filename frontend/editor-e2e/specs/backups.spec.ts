import type { Page } from '@playwright/test';

import {
  answerBackupRequest,
  beatBackupService,
  resetBackups,
} from '../src/database.ts';
import {
  chooseSegment,
  expect,
  expectNoSideways,
  signIn,
  test,
  USERS,
} from '../src/fixtures.ts';

const SECRET = 'e2e-s3-secret-value-0123456789';

const saved = (page: Page) =>
  page.waitForResponse(
    (r) =>
      r.request().method() === 'PATCH' &&
      r.url().endsWith('/api/backup-settings'),
  );

/** The backup key, made in the page and shown once: kept, then the dialog closed. */
async function makeKey(page: Page): Promise<string> {
  const made = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' && r.url().endsWith('/api/backup-keys'),
  );
  await page.getByRole('button', { name: 'Create backup key' }).click();
  expect((await made).status()).toBe(201);
  const dialog = page.getByRole('dialog', { name: 'Your backup key' });
  await expect(dialog).toContainText('the only time the key is shown');
  const identity =
    (await dialog.locator('[data-slot="backup-key"]').textContent()) ?? '';
  expect(identity.trim()).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/);
  // Done waits until the key was copied, downloaded or said to be kept.
  const done = dialog.getByRole('button', { name: 'Done' });
  await expect(done).toBeDisabled();
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toMatch(
    /^openfolia-backup-key-[0-9a-f-]{19}\.txt$/,
  );
  await expect(done).toBeEnabled();
  await done.click();
  await expect(dialog).toBeHidden();
  return identity.trim();
}

// Admin → Backups (`/admin/backups`, #529): the backup key made and shown once, the schedule,
// retention and an S3 location whose secret is write-only, "Test location" and "Back up now"
// answered by the backup service, and the history. The settings are the installation's, so the
// flows run one after the other and start from none. No backup service runs in this suite (it
// needs the Postgres client tools): the flows play its part in the database (`src/database.ts`).
test.describe('backups @area:admin @api:backups', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ consoleAllow: [/status of 4(09|22)/] });

  test.beforeEach(async () => {
    await resetBackups();
  });
  test.afterAll(async () => {
    await resetBackups();
  });

  test('sets up a key, a weekly schedule and an S3 location; the secret is never shown again', async ({
    page,
  }) => {
    await signIn(page, USERS.admin);
    await page.goto('/admin/backups');
    const status = page.locator('[data-slot="backup-status"]');
    await expect(status).toContainText('Backups are not set up');

    const identity = await makeKey(page);
    await expect(
      page.locator('[data-slot="backup-key-fingerprint"]'),
    ).toHaveText(/^\s*[0-9a-f]{4}(-[0-9a-f]{4}){3}\s*$/);

    await page.getByRole('switch', { name: 'Backups on' }).click();
    await chooseSegment(page, 'How often', 'Weekly');
    await page.getByRole('combobox', { name: 'Day' }).click();
    await page.getByRole('option', { name: 'Monday' }).click();
    await page.getByLabel('Time', { exact: true }).fill('03:30');
    await page.getByLabel('Time zone').fill('Europe/Berlin');
    await page.getByRole('spinbutton', { name: 'Daily' }).fill('5');
    await chooseSegment(page, 'Location', 'S3-compatible');
    await page.getByLabel('Endpoint').fill('https://s3.example.com');
    await page.getByLabel('Bucket').fill('openfolia-backups');
    await page.getByLabel('Prefix').fill('nightly/');
    await page.getByLabel('Access key ID').fill('backup-writer');
    await page.getByLabel('Secret access key').fill(SECRET);

    const answer = saved(page);
    await page.getByRole('button', { name: 'Save changes' }).click();
    const response = await answer;
    expect(response.status()).toBe(200);
    expect(await response.text()).not.toContain(SECRET);

    // Three next runs, on Mondays.
    const next = page.locator('[data-slot="backup-next-runs"] li');
    await expect(next).toHaveCount(3);
    // Write-only: "Set", with Replace and Remove; the value is nowhere in the page.
    await expect(
      page.locator('[data-slot="backup-s3-secret-set"]'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Replace' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible();
    expect(await page.content()).not.toContain(SECRET);
    expect(await page.content()).not.toContain(identity);

    // Kept for the next load.
    await page.reload();
    await expect(page.getByLabel('Bucket')).toHaveValue('openfolia-backups');
    await expect(page.getByLabel('Time', { exact: true })).toHaveValue('03:30');
    await expect(page.getByLabel('Time zone')).toHaveValue('Europe/Berlin');
    await expect(page.getByRole('combobox', { name: 'Day' })).toContainText(
      'Monday',
    );
    await expect(
      page.locator('[data-slot="backup-s3-secret-set"]'),
    ).toBeVisible();
    // Without the service: the requests are not offered, and the page says why.
    await expect(
      page.getByRole('button', { name: 'Back up now' }),
    ).toBeDisabled();
    await expect(page.getByText('need the backup service')).toBeVisible();
  });

  test('refuses a local subfolder outside the backup volume, under the field', async ({
    page,
  }) => {
    await signIn(page, USERS.admin);
    await page.goto('/admin/backups');
    const field = page.getByLabel('Subfolder of the backup volume');
    await field.fill('../../etc');
    const answer = saved(page);
    await page.getByRole('button', { name: 'Save changes' }).click();
    expect((await answer).status()).toBe(422);
    await expect(
      page.locator('[data-slot="backup-subfolder-error"]'),
    ).toContainText('inside the backup volume');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    // Fixed and saved.
    await field.fill('nightly');
    const fixed = saved(page);
    await page.getByRole('button', { name: 'Save changes' }).click();
    expect((await fixed).status()).toBe(200);
    await expect(
      page.locator('[data-slot="backup-subfolder-error"]'),
    ).toHaveCount(0);
  });

  test('tests the location and backs up now, answered by the backup service; the run is in the history', async ({
    page,
  }) => {
    await beatBackupService();
    await signIn(page, USERS.admin);
    await page.goto('/admin/backups');
    await makeKey(page);
    const fingerprint =
      (
        await page.locator('[data-slot="backup-key-fingerprint"]').textContent()
      )?.trim() ?? '';
    await page.getByRole('switch', { name: 'Backups on' }).click();
    const on = saved(page);
    await page.getByRole('button', { name: 'Save changes' }).click();
    expect((await on).status()).toBe(200);
    await expect(page.locator('[data-slot="backup-service"]')).toHaveAttribute(
      'data-running',
      'true',
    );

    // A failing test says the exact error.
    await page.getByRole('button', { name: 'Test location' }).click();
    await answerBackupRequest('test-location', {
      failed:
        'Writing a test object failed: AccessDenied (HTTP 403): Access Denied.',
    });
    const outcome = page.locator('[data-slot="backup-request-outcome"]');
    await expect(outcome).toHaveAttribute('data-state', 'failed');
    await expect(outcome).toContainText('AccessDenied (HTTP 403)');

    await page.getByRole('button', { name: 'Test location' }).click();
    await answerBackupRequest('test-location', {});
    await expect(outcome).toHaveAttribute('data-state', 'done');
    await expect(outcome).toContainText('The location works');

    await page.getByRole('button', { name: 'Back up now' }).click();
    await answerBackupRequest('run', {
      fingerprint,
      location: 'local:nightly',
    });
    await expect(outcome).toHaveAttribute('data-kind', 'run');
    await expect(outcome).toHaveAttribute('data-state', 'done');
    const run = page.locator('[data-slot="backup-run"]').first();
    await expect(run).toHaveAttribute('data-status', 'succeeded');
    await expect(run).toContainText('Verified');
    await expect(run).toContainText('local:nightly');
    await expect(run.locator('[data-slot="backup-run-key"]')).toContainText(
      fingerprint,
    );
    await expect(
      page.locator('[data-slot="backup-status-title"]'),
    ).toContainText('verified');
  });

  test('keeps the page and the history within a phone screen', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await beatBackupService();
    await signIn(page, USERS.admin);
    await page.goto('/admin/backups');
    await makeKey(page);
    await page.getByRole('switch', { name: 'Backups on' }).click();
    const on = saved(page);
    await page.getByRole('button', { name: 'Save changes' }).click();
    expect((await on).status()).toBe(200);
    await page.getByRole('button', { name: 'Back up now' }).click();
    await answerBackupRequest('run', { location: 'local:nightly' });
    await expect(page.locator('[data-slot="backup-run"]')).toHaveCount(1);
    await expectNoSideways(page);
  });

  test('is not offered to someone without admin.backups', async ({ page }) => {
    await signIn(page, USERS.author);
    await page.goto('/admin/backups');
    await expect(page.getByTestId('no-access-page')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back up now' })).toHaveCount(
      0,
    );
  });
});
