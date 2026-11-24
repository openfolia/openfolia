// The start page in a browser: two visitors in two browsers get a sandbox each and neither
// reaches the other; the page's states (ready, starting, full, error). With SHOTS set, each state
// is also saved in light and dark and at 360 px (the PR's screenshots).
import { expect, type Page, test } from '@playwright/test';
import { join } from 'node:path';
import { filmsDir, startLauncher, type TestLauncher } from './launcher.js';

/** A 1 × 1 grey JPEG: a stand-in poster when the real films are not at hand (FILMS). */
const POSTER = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);
const SHOTS = process.env['SHOTS'];

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.evaluate(() => document.fonts.ready);
  // The page's own policy refuses an injected style: its reduced-motion rules stop the motion.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(
      (dark) => document.documentElement.classList.toggle('dark', dark),
      theme === 'dark',
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({
      path: join(SHOTS, `${name}-${theme}.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 360, height: 780 });
    await page.screenshot({
      path: join(SHOTS, `${name}-${theme}-360.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
}

test.describe('two visitors', () => {
  let launcher: TestLauncher;
  test.beforeAll(async () => {
    launcher = await startLauncher({ CCMS_LAUNCHER_MAX_SANDBOXES: '3' });
  });
  test.afterAll(async () => launcher.close());

  test('each gets a sandbox of their own, and neither reaches the other', async ({
    browser,
  }) => {
    const a = await browser.newContext();
    const b = await browser.newContext();
    const pageA = await a.newPage();
    const pageB = await b.newPage();

    await pageA.goto(launcher.url);
    await expect(pageA.getByRole('heading', { level: 1 })).toContainText(
      'Try OpenFolia in a sandbox',
    );
    await expect(pageA.locator('[data-live-text]')).toHaveText(
      'Live demo · 3 of 3 sandboxes free',
    );
    await shoot(pageA, 'ready');
    const began = Date.now();
    await pageA.getByRole('button', { name: 'Start the demo' }).click();
    await expect(pageA.locator('body')).toContainText(
      /^sandbox [0-9a-f]{16} \(en\) GET \/$/,
    );
    expect(Date.now() - began).toBeLessThan(10_000);
    const idA = launcher.runtime.started[0]!.id;

    await pageB.goto(`${launcher.url}/?lang=de`);
    await pageB.getByLabel('Deutsch').check({ force: true });
    await pageB.getByRole('button', { name: 'Demo starten' }).click();
    await expect(pageB.locator('body')).toContainText(
      /^sandbox [0-9a-f]{16} \(de\)/,
    );
    const idB = launcher.runtime.started[1]!.id;
    expect(idB).not.toBe(idA);

    // Each browser stays in its own sandbox, wherever it goes.
    await pageA.goto(`${launcher.url}/modules/en/setting-the-clock`);
    await expect(pageA.locator('body')).toContainText(`sandbox ${idA}`);
    await pageB.goto(`${launcher.url}/modules/en/setting-the-clock`);
    await expect(pageB.locator('body')).toContainText(`sandbox ${idB}`);
    // The cookie is not the page's to read or pass on.
    expect(await pageA.evaluate(() => document.cookie)).toBe('');
    const [cookie] = await a.cookies();
    expect(cookie).toMatchObject({
      name: '__Host-openfolia-demo',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    });

    // A third browser with the sandbox's address gets the start page.
    const c = await browser.newContext();
    const pageC = await c.newPage();
    await pageC.goto(`${launcher.url}/modules/en/setting-the-clock`);
    await expect(pageC).toHaveURL(`${launcher.url}/`);
    await expect(
      pageC.getByRole('button', { name: 'Start the demo' }),
    ).toBeVisible();
    for (const id of [idA, idB])
      expect(
        launcher.runtime.seen
          .get(id)!
          .every(
            (s) => !String(s.headers.cookie ?? '').includes('openfolia-demo'),
          ),
      ).toBe(true);
    await Promise.all([a.close(), b.close(), c.close()]);
  });
});

test.describe('the states', () => {
  let launcher: TestLauncher;
  test.beforeAll(async () => {
    launcher = await startLauncher({
      CCMS_LAUNCHER_MAX_SANDBOXES: '1',
      CCMS_LAUNCHER_FILMS_DIR: process.env['FILMS'] ?? filmsDir(POSTER),
      CCMS_LAUNCHER_ABUSE_CONTACT: 'abuse@example.org',
      CCMS_LAUNCHER_PORTAL_URL: 'https://manuals.example.org/',
      CCMS_LAUNCHER_HOMEPAGE_URL: 'https://www.example.org/',
      CCMS_LAUNCHER_DOCS_URL: 'https://docs.example.org/',
      CCMS_LAUNCHER_IMPRINT_URL: 'https://www.example.org/imprint',
      CCMS_LAUNCHER_PRIVACY_URL: 'https://www.example.org/privacy',
    });
  });
  test.afterAll(async () => launcher.close());

  test('starting shows each step, then the sandbox', async ({ page }) => {
    let open!: () => void;
    launcher.runtime.gate = new Promise((resolve) => (open = resolve));
    await page.goto(launcher.url);
    await page.getByRole('button', { name: 'Start the demo' }).click();
    await expect(page.locator('html')).toHaveAttribute(
      'data-state',
      'starting',
    );
    await expect(page.locator('[data-step="start"]')).toHaveClass(/now/);
    await expect(page.locator('[data-step="check"]')).toHaveClass(/done/);
    await shoot(page, 'starting');
    open();
    launcher.runtime.gate = undefined;
    await expect(page.locator('body')).toContainText(/^sandbox [0-9a-f]{16}/);
  });

  test('full shows the films and tries again by itself', async ({
    browser,
  }) => {
    // The one sandbox is taken (by the test before, or now).
    if (launcher.sandboxes.status().free > 0) {
      const other = await browser.newPage();
      await other.goto(launcher.url);
      await other.getByRole('button', { name: 'Start the demo' }).click();
      await expect(other.locator('body')).toContainText(/^sandbox /);
      await other.close();
    }
    const page = await browser.newPage();
    await page.goto(launcher.url);
    await expect(page.locator('html')).toHaveAttribute('data-state', 'full');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'All sandboxes are taken',
    );
    await expect(page.locator('[data-retry-text]')).toContainText(
      /try again for you in 1:5\d/,
    );
    await expect(page.getByRole('button', { name: /Play: / })).toHaveCount(5);
    await expect(
      page.getByRole('link', { name: 'abuse@example.org' }),
    ).toHaveAttribute('href', 'mailto:abuse@example.org');
    await shoot(page, 'full');
    // A film plays in place of its poster.
    await page.getByRole('button', { name: 'Play: Writing a module' }).click();
    await expect(page.locator('video')).toHaveCount(1);
    await page.close();
  });

  test('an error names its reference, and trying again works', async ({
    browser,
  }) => {
    await launcher.sandboxes.removeAll();
    const page = await browser.newPage();
    await page.goto(launcher.url);
    launcher.runtime.failNext = 'error';
    await page.getByRole('button', { name: 'Start the demo' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-state', 'error');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      "Your sandbox didn't start.",
    );
    await expect(page.locator('[data-reference]')).toHaveText(
      /^Reference: [0-9a-f]{8}$/,
    );
    await shoot(page, 'error');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('body')).toContainText(/^sandbox /);
    await page.close();
  });

  test('the theme toggle switches and keeps the choice', async ({
    browser,
  }) => {
    await launcher.sandboxes.removeAll();
    const page = await browser.newPage({ colorScheme: 'light' });
    await page.goto(launcher.url);
    await page.getByRole('button', { name: 'Dark theme' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(
      page.getByRole('button', { name: 'Light theme' }),
    ).toBeVisible();
    await page.close();
  });

  test('says what the demo stores, from the footer, in both languages', async ({
    browser,
  }) => {
    const page = await browser.newPage({ colorScheme: 'light' });
    await page.goto(launcher.url);
    await expect(
      page.getByRole('link', { name: 'OpenFolia: homepage' }),
    ).toHaveAttribute('href', 'https://www.example.org/');
    const footer = page.getByRole('navigation', { name: 'About this demo' });
    for (const [name, href] of [
      ['Homepage', 'https://www.example.org/'],
      ['Imprint', 'https://www.example.org/imprint'],
      ['Privacy', 'https://www.example.org/privacy'],
    ] as const)
      await expect(
        footer.getByRole('link', { name, exact: true }),
      ).toHaveAttribute('href', href);
    await footer.getByRole('link', { name: 'What this demo stores' }).click();
    await expect(page).toHaveURL(`${launcher.url}/_demo/data?lang=en`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'What this demo stores',
    );
    await expect(page.getByRole('heading', { level: 2 })).toHaveText([
      'One cookie, strictly necessary',
      'Your IP address, only as a keyed hash',
      'Your sandbox, until it ends',
      'Logs without addresses or content',
    ]);
    await shoot(page, 'data');
    // The theme toggle works here too.
    await page.getByRole('button', { name: 'Dark theme' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.getByRole('link', { name: 'DE', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Was diese Demo speichert',
    );
    await page.getByRole('link', { name: 'Zurück zur Startseite' }).click();
    await expect(page).toHaveURL(`${launcher.url}/?lang=de`);
    await page.close();
  });
});
