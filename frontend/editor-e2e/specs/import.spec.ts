import type { Page } from '@playwright/test';
import { unique } from '../src/api.ts';
import { ditaProject, exampleBundle } from '../src/import-bundle.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

/** A suffix for this test's IDs: lower case, as a module ID is. */
const suffixOf = () =>
  unique('e2e')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');

/** Chooses `bundle` as `name` in the file step, as the file dialog would. */
async function chooseFile(page: Page, name: string, bundle: Buffer) {
  await page.locator('#import-file-zone').setInputFiles({
    name,
    mimeType: 'application/zip',
    buffer: bundle,
  });
}

/** Waits for the import to end and opens its revision in review; the revision's ID. */
async function openInReview(page: Page): Promise<string> {
  const done = page.locator('[data-slot="done"]');
  await expect(done).toBeVisible({ timeout: 30_000 });
  const open = done.locator('[data-slot="open-review"]');
  await expect(open).toHaveText('Open in review');
  await open.click();
  await expect(page).toHaveURL(/\/review\?.*cs=/);
  return new URL(page.url()).searchParams.get('cs') ?? '';
}

// Import (`/admin/import`, #93): an admin brings a bundle in, reads its dry run and imports it
// into a revision for review.
//
// One test at a time: the server checks at most two imports at once (503 `import-busy`), and the
// tests here each check one or two.
test.describe.configure({ mode: 'serial' });

test.describe('import @area:admin @api:imports @api:change-sets', () => {
  test('dry-runs the example bundle, every item created, then imports it and opens the revision in review', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const suffix = suffixOf();
    await signIn(page, USERS.admin);
    await page.goto('/admin/import');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Import content' }),
    ).toBeVisible();
    // The documented format is first and chosen; the size limit is stated.
    const importers = page.locator('[data-importer]');
    await expect(importers.first()).toHaveAttribute('data-importer', 'bundle');
    await expect(
      page.getByRole('radio', { name: /Import bundle/ }),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('[data-slot="size-limit"]')).toContainText(
      /At most 64 MB per file/,
    );

    await chooseFile(page, `loading-${suffix}.zip`, exampleBundle(suffix));
    await page.getByRole('button', { name: 'Start dry run' }).click();

    // The report: three modules (one in two languages), a manual and two files, all created.
    const counts = page.locator('[data-slot="counts"]');
    await expect(counts.locator('[data-slot="count-create"]')).toContainText(
      '6',
    );
    await expect(counts.locator('[data-slot="count-refuse"]')).toContainText(
      '0',
    );
    await expect(page).toHaveURL(/import=[0-9a-f-]{36}/);
    const rows = page.locator('[data-slot="report-item"]');
    await expect(rows).toHaveCount(6);
    await expect(rows.locator('[data-slot="result"]')).toHaveText(
      Array(6).fill('Create'),
    );
    // The new ID beside the source system's.
    const module = rows.filter({ hasText: `tank-filling-${suffix}` }).first();
    await expect(module.locator('[data-slot="source-id"]')).toHaveText(
      'PAGE-1042',
    );

    // The rows scroll inside the frame; the page never scrolls sideways.
    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    expect(scrollWidth).toBeLessThanOrEqual(1440);

    await page.getByRole('button', { name: 'Import 6 items' }).click();
    const changeSet = await openInReview(page);
    admin.adopt(changeSet);
    // The revision named after the file, its modules and manual added.
    await expect(
      page.getByText(`Import of loading-${suffix}.zip`).first(),
    ).toBeVisible();
  });

  test('refuses an item with an unknown module type, and imports the rest only after confirming', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const suffix = suffixOf();
    const bundle = exampleBundle(suffix, (doc) => {
      const first = doc['modules']?.[2] as {
        id: string;
        meta: { type: string; source?: { id: string } };
      };
      const odd = structuredClone(first);
      odd.id = `odd-${suffix}`;
      odd.meta.type = 'no-such-type';
      if (odd.meta.source) odd.meta.source.id = 'PAGE-2000';
      doc['modules']?.push(odd);
    });
    await signIn(page, USERS.admin);
    await page.goto('/admin/import');
    await chooseFile(page, `loading-${suffix}.zip`, bundle);
    await page.getByRole('button', { name: 'Start dry run' }).click();

    await expect(page.locator('[data-slot="count-refuse"]')).toContainText('1');
    await page
      .getByRole('radiogroup', { name: 'Show' })
      .locator('label')
      .filter({ hasText: 'Refuse' })
      .click();
    await expect(page).toHaveURL(/result=refuse/);
    const refused = page.locator('[data-slot="report-item"]');
    await expect(refused).toHaveCount(1);
    await expect(refused).toContainText(`odd-${suffix}`);
    await expect(refused).toContainText(
      'Its module type is not configured in this project.',
    );

    // Nothing is imported until confirmed: Cancel keeps the report.
    const rest = page.getByRole('button', {
      name: 'Import 6 items without the refused',
    });
    await rest.click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('1 refused item is left out');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('[data-slot="counts"]')).toBeVisible();

    const uploads: string[] = [];
    page.on('request', (r) => {
      if (
        r.method() === 'POST' &&
        new URL(r.url()).pathname.endsWith('/imports')
      )
        uploads.push(r.url());
    });
    const apply = page.waitForRequest(
      (r) => r.method() === 'POST' && /\/imports\/[^/]+\/apply$/.test(r.url()),
    );
    await rest.click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Import the rest' })
      .click();
    // The server leaves the refused item out (#758): no second upload.
    expect((await apply).postDataJSON()).toEqual({
      meta: { skipRefused: true },
    });
    const changeSet = await openInReview(page);
    expect(uploads).toEqual([]);
    admin.adopt(changeSet);
    await expect(
      page.getByText(`Import of loading-${suffix}.zip`).first(),
    ).toBeVisible();
  });

  test('imports the rest of a DITA project without its refused topic, the server leaving it out (#758)', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const suffix = suffixOf();
    await signIn(page, USERS.admin);
    await page.goto('/admin/import');
    await page.getByRole('radio', { name: /DITA project/ }).click();
    await expect(page).toHaveURL(/importer=dita/);
    await chooseFile(page, `topics-${suffix}.zip`, ditaProject(suffix));
    await page.getByRole('button', { name: 'Start dry run' }).click();

    // The huge topic is larger than a module may be: refused; the other one stands without it.
    await expect(page.locator('[data-slot="count-create"]')).toContainText('1');
    await expect(page.locator('[data-slot="count-refuse"]')).toContainText('1');
    await page
      .getByRole('radiogroup', { name: 'Show' })
      .locator('label')
      .filter({ hasText: 'Refuse' })
      .click();
    const refused = page.locator('[data-slot="report-item"]');
    await expect(refused).toHaveCount(1);
    await expect(refused).toContainText(`huge-${suffix}`);
    await expect(page.locator('[data-slot="apply"]')).toHaveCount(0);

    const apply = page.waitForRequest(
      (r) => r.method() === 'POST' && /\/imports\/[^/]+\/apply$/.test(r.url()),
    );
    await page
      .getByRole('button', { name: 'Import 1 item without the refused' })
      .click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Import the rest' })
      .click();
    // One apply with the flag: no second upload, nothing rewritten in the browser.
    expect((await apply).postDataJSON()).toEqual({
      meta: { skipRefused: true },
    });
    const changeSet = await openInReview(page);
    admin.adopt(changeSet);
    await expect(
      page.getByText(`Import of topics-${suffix}.zip`).first(),
    ).toBeVisible();
  });

  test('keeps the dry run in the address, and asks before leaving it', async ({
    page,
  }) => {
    const suffix = suffixOf();
    await signIn(page, USERS.admin);
    await page.goto('/admin/import');
    await chooseFile(page, `loading-${suffix}.zip`, exampleBundle(suffix));
    await page.getByRole('button', { name: 'Start dry run' }).click();
    await expect(page.locator('[data-slot="count-create"]')).toContainText('6');
    // A reload shows the same report: it is kept on the server for an hour.
    await page.reload();
    await expect(page.locator('[data-slot="count-create"]')).toContainText('6');
    await expect(page.locator('[data-slot="summary"]')).toContainText(
      `loading-${suffix}.zip`,
    );
    // Leaving asks once; "Stay" stays.
    await page
      .locator('[data-slot="admin-rail"]')
      .getByRole('link', { name: 'Roles' })
      .click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Leave the import?');
    await dialog.getByRole('button', { name: 'Stay' }).click();
    await expect(page).toHaveURL(/\/admin\/import/);
  });

  test('never shows the tab to a role without admin.roles', async ({
    page,
  }) => {
    await signIn(page, USERS.author);
    await page.goto('/admin');
    await expect(page.locator('[data-slot="admin-rail"]')).toBeVisible();
    await expect(
      page.locator('[data-slot="admin-rail"] [data-page="import"]'),
    ).toHaveCount(0);
    await page.goto('/admin/import');
    await expect(page.getByRole('alert')).toContainText('No access');
    await expect(page.locator('[data-slot="step-importer"]')).toHaveCount(0);
  });
});

test.describe('import: a file it cannot read @area:admin @api:imports', () => {
  test.use({ consoleAllow: [/status of 422.*\/api\/imports/] });

  test('names why the server refused the file, under the file', async ({
    page,
  }) => {
    await signIn(page, USERS.admin);
    await page.goto('/admin/import');
    await chooseFile(page, 'notes.zip', Buffer.from('not a zip at all'));
    await page.getByRole('button', { name: 'Start dry run' }).click();
    await expect(page.locator('[data-slot="file-error"]')).toContainText(
      'This is not a ZIP file the importer can read safely.',
    );
    await expect(page).not.toHaveURL(/import=/);
  });
});
