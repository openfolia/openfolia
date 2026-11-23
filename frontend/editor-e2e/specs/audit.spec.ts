import { readFile } from 'node:fs/promises';

import { expect, signIn, test, USERS } from '../src/fixtures.ts';

/** Today as the date field takes it (`YYYY-MM-DD`), in the browser's time zone (the host's). */
function today(): string {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

// Admin › Audit log (`/admin/audit`): the export (#379).
test.describe('audit log export @area:admin @api:audit', () => {
  test('exports the filtered log as CSV and JSON Lines, and the export is logged', async ({
    page,
  }, testInfo) => {
    await signIn(page, USERS.admin);
    await page.goto('/admin/audit');
    const from = page.locator('[data-filter="from"]');
    await from.fill(today());
    await expect(page).toHaveURL(new RegExp(`[?&]from=${today()}`));

    const exportButton = page.getByRole('button', { name: 'Export' });
    await exportButton.click();
    const [csv] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: 'CSV (spreadsheet)' }).click(),
    ]);
    expect(csv.suggestedFilename()).toMatch(/^audit-log-\d{8}T\d{6}Z\.csv$/);
    const csvFile = testInfo.outputPath(csv.suggestedFilename());
    await csv.saveAs(csvFile);
    const lines = (await readFile(csvFile, 'utf8')).split('\r\n');
    expect(lines[0]).toBe(
      'id,at,actor kind,actor id,action,subject type,subject id,comment,data',
    );
    // The export is recorded before the file is read, so today's file holds it.
    expect(lines.some((l) => l.includes(',audit-log.export,audit-log,'))).toBe(
      true,
    );

    await exportButton.click();
    const [jsonl] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: 'JSON Lines' }).click(),
    ]);
    expect(jsonl.suggestedFilename()).toMatch(/\.jsonl$/);
    const jsonlFile = testInfo.outputPath(jsonl.suggestedFilename());
    await jsonl.saveAs(jsonlFile);
    const events = (await readFile(jsonlFile, 'utf8'))
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { action: string; data: unknown });
    expect(events[0]).toMatchObject({
      action: 'audit-log.export',
      data: { format: 'jsonl', filter: { from: expect.any(String) } },
    });

    // The list shows the exports too, in words.
    await page.reload();
    await expect(
      page
        .locator('[data-slot="audit-row"]')
        .filter({ hasText: 'Audit log exported' })
        .first(),
    ).toBeVisible();
  });

  test.describe('the export fails', () => {
    test.use({ consoleAllow: [/status of 500.*\/api\/audit-events\/export/] });

    test('says so, and the page stays as it was', async ({ page }) => {
      await page.route(
        (url) => url.pathname === '/api/audit-events/export',
        (route) =>
          route.fulfill({
            status: 500,
            contentType: 'application/vnd.api+json',
            body: JSON.stringify({
              errors: [
                { status: '500', code: 'internal-error', title: 'Error' },
              ],
            }),
          }),
      );
      await signIn(page, USERS.admin);
      await page.goto('/admin/audit');
      await page.getByRole('button', { name: 'Export' }).click();
      await page.getByRole('menuitem', { name: 'CSV (spreadsheet)' }).click();
      await expect(
        page.getByText('The audit log could not be exported. Try again.'),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Export' })).toBeEnabled();
    });
  });

  // Retention (#379): the database removes old events and records each removal. The removal
  // shows in words, and the note says that only retention removes events.
  test('shows a retention removal in words, and the note names retention', async ({
    page,
  }) => {
    await page.route(
      (url) => url.pathname === '/api/audit-events',
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as { data: unknown[] };
        // In front of what the log holds: a removal as the database records it.
        body.data.unshift({
          type: 'AuditEvent',
          id: '999999',
          attributes: {
            at: new Date().toISOString(),
            actor: { kind: 'service', id: 'audit-retention' },
            action: 'audit-log.prune',
            subject: { type: 'audit-log', id: 'audit-events' },
            comment: null,
            data: {
              before: '2025-11-20T00:00:00.000Z',
              removed: 3,
              firstId: '1',
              lastId: '3',
            },
          },
        });
        await route.fulfill({ response, json: body });
      },
    );
    await signIn(page, USERS.admin);
    await page.goto('/admin/audit');
    await expect(
      page
        .locator('[data-slot="audit-row"]')
        .filter({ hasText: 'Old audit events removed' }),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Only retention, when the operator sets a period, removes old events',
      ),
    ).toBeVisible();
  });
});
