import { holdOutboxConsumer, releaseOutboxConsumer } from '../src/database.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

// Admin › System when a restore onto another database server holds the outbox (#619). Holding a
// consumer is installation-wide state: every flow on the System page would see the alert, so this
// spec runs in the `isolated` project (`isolated.ts`), alone and after the others.
test.describe('outbox after a restore @area:admin @api:outbox @api:jobs', () => {
  test('says when a restore holds the outbox, and links to finishing it (#619)', async ({
    page,
  }) => {
    const name = `e2e-held-${Date.now().toString(36)}`;
    await holdOutboxConsumer(name);
    try {
      await signIn(page, USERS.admin);
      await page.goto('/admin/system');
      const jobs = page.getByRole('region', { name: 'Background work' });
      const held = jobs.getByRole('alert');
      await expect(held).toContainText('Delivery is held after a restore');
      await expect(held).toContainText(name);
      await expect(
        held.getByRole('link', { name: 'How to finish the restore' }),
      ).toHaveAttribute('href', /guide\/self-hosting\/after-a-restore$/);
    } finally {
      await releaseOutboxConsumer(name);
    }
    await page.reload();
    await expect(
      page
        .getByRole('region', { name: 'Background work' })
        .getByRole('definition')
        .first(),
    ).toHaveText(/\d+ running/);
    await expect(
      page.getByText('Delivery is held after a restore'),
    ).toHaveCount(0);
  });

  test.describe('the outbox state cannot be read', () => {
    test.use({ consoleAllow: [/status of 503.*\/api\/outbox\/status/] });

    test('leaves the background work as it is (#619)', async ({ page }) => {
      await page.route(
        (url) => url.pathname === '/api/outbox/status',
        (route) =>
          route.fulfill({
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
          }),
      );
      await signIn(page, USERS.admin);
      await page.goto('/admin/system');
      const jobs = page.getByRole('region', { name: 'Background work' });
      await expect(jobs.getByRole('definition').first()).toHaveText(
        /\d+ running/,
      );
      await expect(jobs.getByRole('alert')).toHaveCount(0);
    });
  });
});
