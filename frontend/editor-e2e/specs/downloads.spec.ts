import {
  expect,
  expectPageFits,
  signIn,
  test,
  USERS,
} from '../src/fixtures.ts';

// The download centre (#139), the Releases section's Downloads tab. Read only: it lists what
// other flows' releases hold, so it never counts rows or relies on one being there.
test.describe('downloads @area:releases @api:downloads @narrow', () => {
  test('opens from the Releases tabs, filters from the address, and shows a file’s versions', async ({
    page,
  }) => {
    await signIn(page, USERS.reader);
    await page.goto('/releases');
    const tabs = page.getByRole('navigation', { name: 'Releases sections' });
    await expect(
      tabs.getByRole('link', { name: 'Releases', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    // One tab bar; a reader of released content only has no Maintenance tab (#250).
    await expect(tabs.getByRole('link')).toHaveText(['Releases', 'Downloads']);
    const answered = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/downloads',
    );
    await tabs.getByRole('link', { name: 'Downloads' }).click();
    await expect(page).toHaveURL(/\/releases\/downloads$/);
    expect((await answered).status()).toBe(200);
    await expect(tabs.getByRole('link', { name: 'Downloads' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    const list = page.locator('[data-slot="downloads"]');
    const rows = list.locator('[data-slot="download-row"]');
    const none = page.getByRole('heading', { name: 'No downloads yet' });
    await expect(rows.first().or(none)).toBeVisible();
    await expectPageFits(page);

    if (await rows.first().isVisible()) {
      // One file's versions: read beside the list, newest first, each with its state.
      const read = page.waitForResponse((r) =>
        /^\/api\/downloads\/[^/]+\/versions$/.test(new URL(r.url()).pathname),
      );
      await rows.first().getByRole('button').first().click();
      expect((await read).status()).toBe(200);
      const panel = page.locator('[data-slot="download-panel"]');
      await expect(
        panel.getByRole('heading', { name: 'Versions' }),
      ).toBeVisible();
      await expect(
        panel.locator('[data-slot="download-version"]').first(),
      ).toBeVisible();
      await expect(page).toHaveURL(/[?&]download=/);
      await expectPageFits(page);
      await panel.getByRole('button', { name: 'Close the versions' }).click();
      await expect(page).not.toHaveURL(/[?&]download=/);
    }

    // Words no file has: the filters say so, and the address keeps them.
    const filtered = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/downloads' &&
        new URL(r.url()).searchParams.get('filter[q]') === 'zzqx-nothing',
    );
    await page
      .getByRole('searchbox', { name: 'Search downloads' })
      .fill('zzqx-nothing');
    expect((await filtered).status()).toBe(200);
    await expect(
      page.getByRole('heading', { name: 'No downloads match' }),
    ).toBeVisible();
    await expect(page).toHaveURL(/[?&]q=zzqx-nothing/);
  });

  test('ignores a download in the address that names none, and a kind it does not know', async ({
    page,
  }) => {
    await signIn(page, USERS.reader);
    const answered = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/downloads',
    );
    await page.goto(
      '/releases/downloads?kind=image&download=attachment:north:no-such-module:none:en',
    );
    const read = await answered;
    expect(read.status()).toBe(200);
    // An unknown kind is no filter: the request names none.
    expect(new URL(read.url()).searchParams.has('filter[kind]')).toBe(false);
    const list = page.locator('[data-slot="downloads"]');
    await expect(
      list
        .locator('[data-slot="download-row"]')
        .first()
        .or(page.getByRole('heading', { name: 'No downloads yet' })),
    ).toBeVisible();
    await expect(page.locator('[data-slot="download-panel"]')).toHaveCount(0);
    await expectPageFits(page);
  });
});
