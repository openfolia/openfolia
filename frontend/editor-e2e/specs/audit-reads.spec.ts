import { request } from '@playwright/test';

import { unique } from '../src/api.ts';
import { chooseSegment, expect, signIn, test, USERS } from '../src/fixtures.ts';

// Admin › Audit log (`/admin/audit`): the reads of service accounts (#877), one event per
// request their tokens make, filtered by kind and by account.
test.describe('audit log reads @area:admin @api:audit @api:access', () => {
  test('shows a service account’s reads, with the client and a refused status, filtered by kind and account', async ({
    page,
    api,
  }) => {
    // A role, a service account and a token of this test's own: its reads are no one else's.
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const roleId = `e2e-reads-${suffix}`;
    const accountId = `e2e-reader-${suffix}`;
    const accountName = unique('E2E reader');
    const admin = await api(USERS.admin);
    await admin.json(
      admin.send('POST', '/roles', {
        data: {
          type: 'Role',
          id: roleId,
          attributes: {
            name: unique('E2E reads role'),
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
          id: accountId,
          attributes: { name: accountName },
          relationships: {
            roles: { data: [{ type: 'Role', id: roleId }] },
          },
        },
      }),
      201,
    );
    const issued = await admin.json<{ meta: { token: string } }>(
      admin.send('POST', `/service-accounts/${accountId}/tokens`, {
        data: { type: 'ServiceToken', attributes: { name: 'E2E reads' } },
      }),
      201,
    );

    // Two reads with the account's token, as the MCP server makes them: one answered, one not.
    const asAccount = await request.newContext({
      baseURL: process.env['E2E_API_URL'],
      extraHTTPHeaders: {
        Authorization: `Bearer ${issued.meta.token}`,
        Accept: 'application/vnd.api+json',
        'X-OpenFolia-Client': 'mcp/search',
      },
    });
    try {
      expect((await asAccount.get('/me')).status()).toBe(200);
      expect((await asAccount.get('/modules/en/no-such-module')).status()).toBe(
        404,
      );
    } finally {
      await asAccount.dispose();
    }

    await signIn(page, USERS.admin);
    await page.goto('/admin/audit');
    await chooseSegment(page, 'Kind of event', 'Reads');
    await expect(page).toHaveURL(/[?&]kind=read/);
    await page.getByRole('combobox', { name: /^Actor/ }).click();
    await page
      .getByRole('option', { name: new RegExp(`^${accountName}`) })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`[?&]actor=service%2F${accountId}`),
    );

    const rows = page.locator('[data-slot="audit-row"]');
    // Recorded once each answer is out: a reload may be needed to see the second.
    await expect(async () => {
      await page.reload();
      await expect(rows).toHaveCount(2);
    }).toPass({ timeout: 15_000 });
    await expect(rows.filter({ hasText: 'Read over the API' })).toHaveCount(2);
    const refused = rows.filter({ hasText: '/modules/en/no-such-module' });
    await expect(refused.locator('[data-slot="audit-read-status"]')).toHaveText(
      'Answered 404',
    );
    await expect(refused.locator('[data-slot="audit-read-client"]')).toHaveText(
      // The label is for screen readers; the badge shows the client.
      'Client: mcp/search',
    );
    const me = rows.filter({ hasText: '/me' });
    await expect(me.locator('[data-slot="audit-read-status"]')).toHaveCount(0);
    await expect(me).toContainText('API route');

    // The details give the token's ID, never the token.
    await me.getByRole('button', { name: 'Show details' }).click();
    const details = page.locator('[data-slot="audit-details"]').first();
    await expect(details).toContainText('tokenId');
    await expect(page.getByText(issued.meta.token)).toHaveCount(0);

    // Changes only: the account changed nothing.
    await chooseSegment(page, 'Kind of event', 'Changes');
    await expect(page).toHaveURL(/[?&]kind=write/);
    await expect(page.getByText('No events match')).toBeVisible();
  });

  test.describe('the list fails', () => {
    test.use({ consoleAllow: [/status of 500.*\/api\/audit-events/] });

    test('says so with a retry, and keeps the filter', async ({ page }) => {
      let fail = true;
      await page.route(
        (url) =>
          url.pathname === '/api/audit-events' &&
          url.searchParams.get('filter[kind]') === 'read',
        (route) =>
          fail
            ? route.fulfill({
                status: 500,
                contentType: 'application/vnd.api+json',
                body: JSON.stringify({
                  errors: [
                    { status: '500', code: 'internal-error', title: 'Error' },
                  ],
                }),
              })
            : route.fallback(),
      );
      await signIn(page, USERS.admin);
      await page.goto('/admin/audit?kind=read');
      const retry = page.getByRole('button', { name: 'Try again' });
      await expect(retry).toBeVisible();
      await expect(
        page.getByRole('radio', { name: 'Reads', exact: true }),
      ).toBeChecked();
      fail = false;
      await retry.click();
      await expect(retry).toHaveCount(0);
      await expect(page).toHaveURL(/[?&]kind=read/);
    });
  });
});
