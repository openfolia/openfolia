import { moduleId, paragraph, unique, type Block } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

/** A safety notice with `symbols`, as the API stores it. */
const notice = (symbols: string[]): Block => ({
  type: 'safety',
  id: 'hot',
  severity: 'warning',
  hazard: [{ type: 'text', text: 'Hot surface' }],
  symbols,
  blocks: [paragraph('cool', 'Let it cool down.')],
});

// Safety symbols' artwork (#208): `GET /symbols/:id`, in the module editor and in the preview.
test.describe('safety symbols @area:module-editor @area:manuals @api:assets @api:preview', () => {
  test('a notice shows its symbol’s artwork in the editor and in the preview', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Safety symbol'));
    const id = moduleId();
    await author.createModule(changeSet, {
      lang: 'en',
      moduleId: id,
      title: 'Hot parts',
      blocks: [notice(['w001'])],
    });

    await signIn(page, USERS.author);
    // The artwork is read only once the page has loaded the module and taken its lock: on a
    // busy machine that chain alone can take most of an expect's 10 s, so the flow waits for
    // the artwork's own answer first, then for it to be drawn (#523).
    const read = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/symbols/w001',
    );
    await page.goto(`/content/en/${id}?cs=${changeSet.id}`);
    expect((await read).status()).toBe(200);
    // Beside the signal word: the artwork (a PNG drawn from the SVG), its label as the alt text.
    const artwork = page
      .locator('of-safety-node [data-symbol]')
      .getByRole('img', { name: 'General warning' });
    await expect(artwork).toBeVisible();
    await expect(artwork).toHaveAttribute('src', /^blob:/);
    expect(
      await artwork.evaluate((img: HTMLImageElement) => img.naturalWidth),
    ).toBeGreaterThan(0);

    // The menu shows each configured symbol's artwork beside its label.
    await page.locator('of-safety-node button[z-dropdown]').click();
    const entry = page
      .getByRole('menuitemcheckbox')
      .filter({ hasText: 'General warning' });
    await expect(
      entry.getByRole('img', { name: 'General warning' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');

    // The preview: the HTML's symbol, read with the person's credentials and shown from a blob.
    await page.getByRole('button', { name: 'Preview' }).first().click();
    const frame = page.frameLocator('iframe[title^="Preview of"]');
    const symbol = frame.locator('img.of-safety__symbol');
    await expect(symbol).toHaveAttribute('alt', 'General warning');
    await expect(symbol).toHaveAttribute('src', /^blob:/);
    await expect
      .poll(() => symbol.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
  });

  test.describe('without artwork', () => {
    // The artwork's read is refused (404): the browser reports it.
    test.use({ consoleAllow: [/status of 404.*\/api\/symbols\/e2e-no-art/] });

    test('a symbol without artwork shows its label, marked, and the preview leaves it out', async ({
      page,
      api,
    }) => {
      // The admin's revision configures a symbol the repository has no artwork for.
      const admin = await api(USERS.admin);
      const changeSet = await admin.createChangeSet(
        unique('Symbol without art'),
      );
      // Another flow's revision may hold the configuration's lock a few seconds (the releases'
      // `ownProduct` merges one): try again until it is free.
      await expect(async () => {
        await admin.editConfig(changeSet.id, (config) => ({
          ...config,
          safetySymbols: [
            // Once, should an earlier try have written it already.
            ...config.safetySymbols.filter(
              (symbol: { id: string }) => symbol.id !== 'e2e-no-art',
            ),
            { id: 'e2e-no-art', label: 'Symbol without artwork' },
          ],
        }));
      }).toPass({ timeout: 30_000 });
      const id = moduleId();
      await admin.createModule(changeSet, {
        lang: 'en',
        moduleId: id,
        title: 'Unpainted sign',
        blocks: [notice(['w001', 'e2e-no-art'])],
      });

      await signIn(page, USERS.admin);
      // As above: the artwork's answer first (here a 404), then what the editor shows (#523).
      const read = page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname === '/api/symbols/e2e-no-art',
      );
      await page.goto(`/content/en/${id}?cs=${changeSet.id}`);
      expect((await read).status()).toBe(404);
      const symbols = page.locator('of-safety-node [data-symbol]');
      await expect(symbols).toHaveCount(2);
      await expect(symbols.nth(0)).toHaveAttribute('data-state', 'shown');
      const missing = symbols.nth(1);
      await expect(missing).toHaveAttribute('data-state', 'missing');
      await expect(missing).toContainText('Symbol without artwork');
      await expect(missing).toContainText('No artwork');
      await expect(missing.locator('img')).toHaveCount(0);

      await page.getByRole('button', { name: 'Preview' }).first().click();
      const frame = page.frameLocator('iframe[title^="Preview of"]');
      await expect(frame.getByText('Hot surface')).toBeVisible();
      await expect(frame.locator('img.of-safety__symbol')).toHaveCount(1);
      await expect(frame.locator('img.of-safety__symbol')).toHaveAttribute(
        'alt',
        'General warning',
      );
    });
  });
});
