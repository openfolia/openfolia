import {
  expect,
  expectNoSideways,
  signIn,
  test,
  USERS,
} from '../src/fixtures.ts';
import { SANDBOX_MINUTES, SANDBOX_PORTAL_URL } from '../stack/stack.ts';

/**
 * The public sandbox (#826) in the browser: the editor in front of an API with
 * `CCMS_PUBLIC_SANDBOX=on` (`stack/`, 6.). Its banner on every screen with the time left, the
 * upload and import controls left out with why, and the API refusing what the screens no longer
 * offer. The demo editor beside it (no sandbox) shows none of it.
 */
const SANDBOX_URL = process.env['E2E_SANDBOX_URL'] ?? '';
const BANNER_TEXT =
  'A private sandbox: only you see it, and it is deleted after the session.';

test.describe('the public sandbox @area:shell @area:media @area:admin @api:sandbox @narrow', () => {
  test.use({ baseURL: SANDBOX_URL });

  test('shows the banner with the time left, on the sign-in page and every screen', async ({
    page,
  }) => {
    await page.goto('/sign-in');
    const banner = page.getByRole('complementary', { name: 'Sandbox' });
    await expect(banner).toContainText(BANNER_TEXT);
    await expect(banner.getByTestId('sandbox-time-left')).toHaveText(
      /^\s*\d+ min left\s*$/,
    );
    await expectNoSideways(page);

    await signIn(page, USERS.author);
    for (const path of ['/content', '/review', '/admin']) {
      await page.goto(path);
      await expect(banner).toContainText(BANNER_TEXT);
      // The stack's sandbox lasts a day (`SANDBOX_MINUTES`), idle or not: a page just loaded
      // shows nearly all of it, whatever ran before.
      const left = await banner.getByTestId('sandbox-time-left').textContent();
      const minutes = Number(left?.match(/\d+/)?.[0]);
      expect(minutes).toBeLessThanOrEqual(SANDBOX_MINUTES);
      expect(minutes).toBeGreaterThan(SANDBOX_MINUTES - 120);
      await expectNoSideways(page);
    }
    // The banner sits above the page's own heading, inside the page column.
    await page.goto('/content');
    const heading = page.getByRole('heading', { level: 1, name: 'Content' });
    await expect(heading).toBeVisible();
    const [b, h] = await Promise.all([
      banner.boundingBox(),
      heading.boundingBox(),
    ]);
    expect((b?.y ?? 0) + (b?.height ?? 0)).toBeLessThanOrEqual(h?.y ?? 0);
  });

  test('links the reader portal from the banner, in a new tab (#837)', async ({
    page,
  }) => {
    await page.goto('/sign-in');
    const banner = page.getByRole('complementary', { name: 'Sandbox' });
    const link = banner.getByRole('link', { name: /See the reader portal/ });
    await expect(link).toHaveAttribute('href', SANDBOX_PORTAL_URL);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await link.focus();
    await expect(link).toBeFocused();
    await expectNoSideways(page);
    // A button-styled link (#843): a tap-sized box with a border, not bare text.
    const box = await link.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(28);
    await expect(link).toHaveCSS('border-top-width', '1px');
    // Next to the time left, on one banner: neither is pushed out.
    await expect(banner.getByTestId('sandbox-time-left')).toBeVisible();
  });

  test('leaves out uploads and imports, and says why', async ({ page }) => {
    await signIn(page, USERS.admin);
    await page.goto('/media');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Media library' }),
    ).toBeVisible();
    await expect(page.getByTestId('sandbox-off')).toHaveText(
      'Uploads are off in this sandbox.',
    );
    await expect(page.getByRole('button', { name: 'Upload' })).toHaveCount(0);
    await expectNoSideways(page);

    await page.goto('/admin/import');
    await expect(page.getByTestId('sandbox-off-state')).toContainText(
      'Imports are off in this sandbox',
    );
    await expect(page.locator('input[type="file"]')).toHaveCount(0);

    await page.goto('/admin/users');
    await expect(page.getByTestId('sandbox-off')).toHaveText(
      'Adding users and sign-in links are off in this sandbox: it is yours alone.',
    );
    await expect(page.getByRole('button', { name: 'New user' })).toHaveCount(0);
    // No invitation or reset link on any row: the API refuses them (invitations).
    await expect(
      page.getByRole('button', { name: 'Edit' }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: /^(Invite |Make a password reset link for )/,
      }),
    ).toHaveCount(0);

    await page.goto('/admin/service-accounts');
    await expect(page.getByTestId('sandbox-off').first()).toContainText(
      'Service accounts are off in this sandbox',
    );
    await expect(
      page.getByRole('button', { name: 'New service account' }),
    ).toHaveCount(0);

    // Email is off: the card says so, and offers no test email.
    await page.goto('/admin/system');
    await expect(
      page.locator('[data-slot="mail-card"]').getByTestId('sandbox-off'),
    ).toHaveText(
      'Email is off in this sandbox: every message is dropped, none is sent.',
    );
    await expect(page.locator('[data-slot="mail-test"]')).toHaveCount(0);

    await page.goto('/admin/webhooks');
    await expect(page.getByTestId('sandbox-off-state')).toContainText(
      'Webhooks are off in this sandbox',
    );

    // A template is read, never changed, with why.
    await page.goto('/admin/page-designs/templates/example');
    await expect(page.locator('[data-slot="read-reason"]')).toHaveText(
      'Templates cannot be changed in this sandbox: you see them as they are.',
    );
  });

  test('the API refuses what the screens leave out', async ({ page }) => {
    await signIn(page, USERS.admin);
    await page.goto('/content');
    await expect(
      page.getByRole('complementary', { name: 'Sandbox' }),
    ).toBeVisible();
    // Through the editor's own proxy, as the page would send it.
    const refused = await page.request.post('/api/users', {
      headers: {
        'Content-Type': 'application/vnd.api+json',
        Accept: 'application/vnd.api+json',
        'X-Ccms-Request': '1',
        'X-Ccms-User': USERS.admin,
      },
      data: {
        data: {
          type: 'User',
          id: 'e2e-sandbox-stranger',
          attributes: { name: 'Stranger', email: 'stranger@example.org' },
          relationships: { roles: { data: [{ type: 'Role', id: 'author' }] } },
        },
      },
    });
    expect(refused.status()).toBe(403);
    const body = await refused.json();
    expect(body.errors[0]).toMatchObject({
      code: 'sandbox-not-allowed',
      meta: { refused: 'users' },
    });
  });
});

test.describe('a normal instance has no sandbox @area:shell @api:sandbox', () => {
  test('shows no banner and offers uploads', async ({ page }) => {
    await signIn(page, USERS.author);
    await page.goto('/media');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Media library' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload' })).toBeVisible();
    await expect(
      page.getByRole('complementary', { name: 'Sandbox' }),
    ).toHaveCount(0);
  });
});
