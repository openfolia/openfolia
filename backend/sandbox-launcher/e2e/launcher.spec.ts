// The start page in a browser: two visitors in two browsers get a sandbox each and neither
// reaches the other; the page's states (ready, starting, full, error) and its layout. With SHOTS
// set, each state is also saved in light and dark at four sizes (the PR's screenshots).
import { expect, type Page, test } from '@playwright/test';
import { join } from 'node:path';
import { filmsDir, startLauncher, type TestLauncher } from './launcher.js';

/** A 1 × 1 grey JPEG: a stand-in poster when the real films are not at hand (FILMS). */
const POSTER = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);
const SHOTS = process.env['SHOTS'];
/** A phone, a tablet, a laptop, a desktop. */
const SHOT_SIZES = [
  [360, 780],
  [768, 1024],
  [1280, 800],
  [1920, 1080],
] as const;

/** `fullPage: false` for a modal: the top layer covers the viewport, not the whole page. */
async function shoot(page: Page, name: string, fullPage = true) {
  if (!SHOTS) return;
  await page.evaluate(() => document.fonts.ready);
  // The page's own policy refuses an injected style: its reduced-motion rules stop the motion.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // A dialog that just opened may still be fading in.
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running'),
  );
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(
      (dark) => document.documentElement.classList.toggle('dark', dark),
      theme === 'dark',
    );
    for (const [width, height] of SHOT_SIZES) {
      await page.setViewportSize({ width, height });
      await page.screenshot({
        path: join(SHOTS, `${name}-${theme}-${width}.png`),
        fullPage,
      });
    }
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

  test('the header stays, the footer follows the content, the button is above the fold', async ({
    browser,
  }) => {
    await launcher.sandboxes.removeAll();
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    const box = async (selector: string) =>
      (await page.locator(selector).first().boundingBox())!;
    /** The space between the end of the column and the footer's top. */
    const gap = async () =>
      (await box('footer.foot')).y -
      ((await box('main .col')).y + (await box('main .col')).height);

    // The start button in the first viewport at a common laptop size, in both languages.
    for (const [lang, name] of [
      ['en', 'Start the demo'],
      ['de', 'Demo starten'],
    ] as const) {
      await page.goto(`${launcher.url}/?lang=${lang}`);
      const button = await page.getByRole('button', { name }).boundingBox();
      expect(button!.y).toBeGreaterThan((await box('header.bar')).height);
      expect(button!.y + button!.height).toBeLessThanOrEqual(800);
    }

    // The header stays at the top while the page scrolls; its hairline shows once scrolled.
    await page.goto(launcher.url);
    const ready = await gap();
    await expect(page.locator('html')).not.toHaveAttribute('data-scrolled');
    await page.mouse.wheel(0, 2000);
    await expect(page.locator('html')).toHaveAttribute('data-scrolled');
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(100);
    expect((await box('header.bar')).y).toBe(0);
    await expect(
      page.getByRole('button', { name: 'Dark theme' }),
    ).toBeInViewport();

    // A short state on a tall screen: the footer right after the content, with the same gap.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.evaluate(() => scrollTo(0, 0));
    launcher.runtime.failNext = 'error';
    await page.getByRole('button', { name: 'Start the demo' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-state', 'error');
    expect(await gap()).toBeCloseTo(ready, 0);
    const footer = await box('footer.foot');
    expect(footer.y + footer.height).toBeLessThan(1080 - 200);
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

test.describe('the ended dialog (#846)', () => {
  let launcher: TestLauncher;
  test.beforeAll(async () => {
    launcher = await startLauncher({
      CCMS_LAUNCHER_MAX_SANDBOXES: '3',
      CCMS_LAUNCHER_PORTAL_URL: 'https://manuals.example.org/',
      CCMS_LAUNCHER_HOMEPAGE_URL: 'https://www.example.org/',
      CCMS_LAUNCHER_BOOKING_URL: 'https://www.example.org/#demo',
    });
  });
  test.afterAll(async () => launcher.close());

  /** Starts a sandbox from the start page and waits for it (the fake sandbox's page). */
  async function startOne(page: Page, lang: 'en' | 'de' = 'en') {
    await page.goto(`${launcher.url}/?lang=${lang}`);
    await page
      .getByRole('button', {
        name: lang === 'en' ? 'Start the demo' : 'Demo starten',
      })
      .click();
    await expect(page.locator('body')).toContainText(/^sandbox [0-9a-f]{16}/);
  }

  /** What the editor's "End demo" does once confirmed: the end route, then its `next`. */
  async function endFromTheEditor(page: Page, lang: 'en' | 'de' = 'en') {
    const next = await page.evaluate(async (lang) => {
      const res = await fetch('/_demo/api/end', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lang }),
      });
      return ((await res.json()) as { next: string }).next;
    }, lang);
    await page.goto(`${launcher.url}${next}`);
  }

  test('ending thanks the visitor and offers a demo; Escape closes it, the page stays put', async ({
    browser,
  }) => {
    const page = await browser.newPage({ colorScheme: 'light' });
    await startOne(page);
    const [started] = launcher.runtime.started.slice(-1);
    await endFromTheEditor(page);
    expect(launcher.runtime.removed).toContain(started!.id);

    const dialog = page.getByRole('dialog', {
      name: 'Thanks for trying OpenFolia.',
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      'Your sandbox has ended, and everything in it was deleted.',
    );
    const book = dialog.getByRole('link', { name: 'Book a demo' });
    await expect(book).toHaveAttribute('href', 'https://www.example.org/#demo');
    // The focus on its heading: read from the top; the first Tab is "Book a demo".
    await expect(
      dialog.getByRole('heading', { name: 'Thanks for trying OpenFolia.' }),
    ).toBeFocused();
    await expect(
      dialog.getByRole('link', { name: 'See the published manuals' }),
    ).toHaveAttribute('href', 'https://manuals.example.org/');
    await expect(
      dialog.getByRole('button', { name: 'Start a new sandbox' }),
    ).toBeVisible();
    // Shown once: the address loses its `ended`, so a reload is the plain start page.
    await expect(page).toHaveURL(`${launcher.url}/?lang=en`);
    // The cookie is gone with the sandbox.
    expect(await page.context().cookies()).toEqual([]);
    // The page behind is inert, and keeps its place.
    await shoot(page, 'ended', false);
    await page.setViewportSize({ width: 1280, height: 800 });
    const before = await page.locator('main .col').boundingBox();
    await page.keyboard.press('Tab');
    await expect(book).toBeFocused();
    // Tab reaches each of its controls in turn (the page behind is inert), the close button last.
    for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole('heading', { level: 1, name: /Try OpenFolia/ }),
    ).toBeFocused();
    await expect(page.locator('.notice-line')).toContainText('has ended');
    const after = await page.locator('main .col').boundingBox();
    expect(after).toEqual(before);
    await page.reload();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await page.close();
  });

  test('an expired sandbox leads to it too, with why; "Start a new sandbox" starts one', async ({
    browser,
  }) => {
    const page = await browser.newPage({ colorScheme: 'dark' });
    await startOne(page, 'de');
    // It runs out (idle, its maximum, a restart): the launcher drops it.
    const token = (await page.context().cookies())[0]!.value;
    await launcher.sandboxes.drop(launcher.sandboxes.find(token)!, 'expired');
    // The editor's poll keeps the cookie; the visitor's next page is the dialog.
    expect(
      (await page.request.get(`${launcher.url}/api/sandbox`)).status(),
    ).toBe(404);
    await page.goto(`${launcher.url}/content?lang=de`);
    const dialog = page.getByRole('dialog', {
      name: 'Danke, dass Sie OpenFolia ausprobiert haben.',
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Ihre Sandbox ist abgelaufen');
    await expect(dialog).toContainText('nach 30 Minuten ohne Aktivität');
    await expect(
      dialog.getByRole('link', { name: 'Demo buchen' }),
    ).toBeVisible();
    await shoot(page, 'ended-expired', false);
    const count = launcher.runtime.started.length;
    await dialog.getByRole('button', { name: 'Neue Sandbox starten' }).click();
    await expect(page.locator('body')).toContainText(
      /^sandbox [0-9a-f]{16} \(de\)/,
    );
    expect(launcher.runtime.started).toHaveLength(count + 1);
    await page.close();
  });
});

test.describe('the ended dialog without a booking address (#846)', () => {
  let launcher: TestLauncher;
  test.beforeAll(async () => {
    launcher = await startLauncher();
  });
  test.afterAll(async () => launcher.close());

  test('offers a new sandbox instead, and nothing to book', async ({
    page,
  }) => {
    await page.goto(`${launcher.url}/?ended=closed`);
    const dialog = page.getByRole('dialog', {
      name: 'Thanks for trying OpenFolia.',
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Book a demo' })).toHaveCount(
      0,
    );
    await page.keyboard.press('Tab');
    await expect(
      dialog.getByRole('button', { name: 'Start a new sandbox' }),
    ).toBeFocused();
    await expect(dialog).toContainText(
      'You can start a new sandbox at any time.',
    );
    await shoot(page, 'ended-no-booking', false);
    // The close button, and a click on the dimmed page, close it as Escape does.
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    await page.goto(`${launcher.url}/?ended=closed`);
    await expect(dialog).toBeVisible();
    await page.mouse.click(5, 400);
    await expect(dialog).toBeHidden();
  });
});
