import { Api } from '../src/api.ts';
import { expect, openAccountMenu, test, USERS } from '../src/fixtures.ts';

/**
 * Sign-in with SAML 2.0 (#376), in the browser: the editor in front of the API with sign-in on
 * (`stack/`, 5.), beside OpenID Connect, a local SAML identity provider
 * (`backend/api/scripts/mock-saml.ts`) whose page takes a login name and posts a signed answer
 * back from its own origin, and a group mapping that gives the person a role.
 */
const SIGN_IN_URL = process.env['E2E_SIGN_IN_URL'] ?? '';

test.describe('sign-in with SAML @area:shell @api:access', () => {
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
      // 409: made by another flow or an earlier try.
      expect([201, 409]).toContain(res.status());
    } finally {
      await admin.dispose();
    }
  });

  test('signs in at the SAML provider, comes back where it was going, and signs out', async ({
    page,
  }) => {
    await page.goto('/content');
    await expect(page).toHaveURL(/\/sign-in\?returnUrl=%2Fcontent/);
    // Both providers are offered, each with its own button.
    await expect(
      page.getByRole('button', { name: 'Sign in with Mock provider' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Sign in with Mock SAML' }).click();

    // The identity provider's own page; it posts the answer back from its origin.
    await expect(
      page.getByRole('heading', { name: 'Mock SAML provider' }),
    ).toBeVisible();
    await page.getByLabel('Login').fill('e2e-saml-writer');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Back, signed in, with the role the group gives.
    await expect(page).toHaveURL(/\/content$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Content' }),
    ).toBeVisible();
    const me = await page.request.get('/api/me');
    const body = (await me.json()) as {
      data: {
        attributes: { roles: { id: string }[] };
        meta: { session?: { provider: string } };
      };
    };
    expect(body.data.meta.session?.provider).toBe('saml');
    expect(body.data.attributes.roles.map((r) => r.id)).toContain('author');

    await openAccountMenu(page, 'E2E SAML Writer');
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    // No single logout: signed out here, back on the sign-in page.
    await expect(page).toHaveURL(/\/sign-in$/);
    expect((await page.request.get('/api/me')).status()).toBe(401);
  });

  test('refuses an answer to no sign-in begun here, and says why', async ({
    page,
    request,
  }) => {
    // Where the SAML button sends the browser: the identity provider (asked apart from the page,
    // so this browser keeps no sign-in begun).
    const begun = await request.get('/api/auth/saml/sign-in', {
      maxRedirects: 0,
    });
    const provider = new URL(begun.headers()['location'] ?? '').origin;
    // IdP-initiated sign-in is off: the provider's unsolicited answer is refused.
    await page.goto(`${provider}/sso/start?login=e2e-saml-writer`);
    await expect(page).toHaveURL(/\/sign-in\?error=sign-in-expired$/);
    await expect(page.getByRole('alert')).toContainText(
      'That sign-in took too long',
    );
    await expect(
      page.getByRole('button', { name: 'Sign in with Mock SAML' }),
    ).toBeVisible();
    expect((await page.request.get('/api/me')).status()).toBe(401);
  });

  test('says when too many answers from a network were refused, in German too', async ({
    page,
  }) => {
    // Where the API sends the browser past the limit (its own tests reach it).
    await page.goto('/sign-in?error=too-many-failed-attempts');
    await expect(page.getByRole('alert')).toContainText(
      'Too many sign-ins from your network failed',
    );
    await expect(
      page.getByRole('button', { name: 'Sign in with Mock SAML' }),
    ).toBeVisible();
    await page.getByText('Deutsch', { exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Zu viele Anmeldungen aus Ihrem Netzwerk sind fehlgeschlagen',
    );
  });
});
