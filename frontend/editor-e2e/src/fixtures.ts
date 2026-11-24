import { writeFileSync } from 'node:fs';
import {
  test as base,
  expect,
  type Locator,
  type Page,
  type Request,
} from '@playwright/test';
import { Api, type UserId, USERS } from './api.ts';

/**
 * The suite's `test`:
 *
 * - the browser console is kept for every test and written next to its trace on failure
 *   (`console.txt`, also attached to the report);
 * - a console error or an uncaught exception fails the test, unless it matches the test's
 *   `consoleAllow` (`test.use({ consoleAllow: [/…/] })`, for a flow that provokes one);
 * - `signIn(page, user)` acts as a seeded demo user from the first page load, the way the
 *   sign-in page leaves it (local storage `openfolia.demo-user`);
 * - `api(user)` makes the state a flow needs through the API (`src/api.ts`); the change sets it
 *   started are abandoned after the test, so their locks never hold up another test. Not before
 *   the page's own requests are answered (`PageRequests`): the editor shows a write at once and
 *   sends it after, or sends one once a read is answered, so a flow can end while one is on its
 *   way, and abandoning first made it a 409.
 * - tips and the first-run tour (#222) are off: `GET /api/me/preferences` answers "Show tips" off
 *   and the tour done (`tipsOff`, a stub in the page, so nothing is written for the person), as
 *   a tip or the tour opening over a flow would take its focus. A flow about them sets
 *   `test.use({ tips: true })` and signs in as a person of its own.
 */

/**
 * What the browser says by design: the HTML previews run in sandboxed frames without scripts
 * (`backend/api/README.md`, "HTML previews"), and Chromium reports each script it blocked there.
 */
const ALWAYS_ALLOWED: readonly RegExp[] = [
  /Blocked script execution in 'about:(blank|srcdoc)' because the document's frame is sandboxed/,
];

/**
 * Off the public sandbox's editor only (`E2E_SANDBOX_URL`): the editor asks at start-up whether
 * the API is a public sandbox (#826), a normal instance answers 404, and Chromium logs that
 * answer. In front of the sandbox the same request must succeed, so there it is not allowed.
 */
const NOT_A_SANDBOX: readonly RegExp[] = [
  /status of 404 \(Not Found\) \(http:\/\/127\.0\.0\.1:\d+\/api\/sandbox(?::\d+)?\)/,
];
const SANDBOX_URL = process.env['E2E_SANDBOX_URL'] ?? '';

/**
 * The page's requests to the API not answered yet: what the editor sent eagerly while the flow
 * went on. Reads count as well as writes: a read is often what the editor sends a write after
 * (a reload takes the module's lock again once it has read it, #516), so a quiet window that
 * counted only writes could pass between the two.
 */
class PageRequests {
  private readonly open = new Set<Request>();
  private lastChange = Date.now();

  watch(page: Page): void {
    page.on('request', (request) => {
      if (!isApi(request)) return;
      this.open.add(request);
      this.lastChange = Date.now();
    });
    const done = (request: Request) => {
      if (this.open.delete(request)) this.lastChange = Date.now();
    };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
  }

  /**
   * Resolves once no request is open and none started or ended for `quietMs` (a write the
   * editor sends a moment after the last request, as a save after a rename or a lock after a
   * reload's reads); after `timeoutMs` at the latest, open or not: then with the requests still
   * open (method and URL). A write the editor sends only later (a delete when its Undo toast
   * ends) is not waited for: a flow that ends on one waits for its answer itself.
   */
  async settled(quietMs = 500, timeoutMs = 10_000): Promise<string[]> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (this.open.size === 0 && Date.now() - this.lastChange >= quietMs)
        return [];
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return [...this.open].map((r) => `${r.method()} ${r.url()}`);
  }
}

const isApi = (request: Request): boolean =>
  new URL(request.url()).pathname.startsWith('/api/');

interface Fixtures {
  consoleAllow: readonly RegExp[];
  /** Tips and the tour as the API has them; off (stubbed) by default. */
  tips: boolean;
  api: (user: UserId) => Promise<Api>;
  consoleLog: string[];
  pageRequests: PageRequests;
}

export const test = base.extend<Fixtures>({
  consoleAllow: [[], { option: true }],
  tips: [false, { option: true }],

  consoleLog: async ({}, use) => {
    await use([]);
  },

  pageRequests: async ({}, use) => {
    await use(new PageRequests());
  },

  page: async (
    { page, baseURL, consoleAllow, consoleLog, pageRequests, tips },
    use,
    testInfo,
  ) => {
    pageRequests.watch(page);
    if (!tips) await tipsOff(page);
    const unexpected: string[] = [];
    // The editor this test opens (`test.use({ baseURL })`): the sandbox's, or a normal one.
    const sandbox = SANDBOX_URL !== '' && baseURL === SANDBOX_URL;
    const allowed = [
      ...ALWAYS_ALLOWED,
      ...(sandbox ? [] : NOT_A_SANDBOX),
      ...consoleAllow,
    ];
    const note = (kind: string, text: string, location = '') => {
      const line = `[${kind}] ${text}${location ? ` (${location})` : ''}`;
      consoleLog.push(line);
      // Matched against the whole line: a failed request names its URL only in the location.
      if (
        (kind === 'error' || kind === 'pageerror') &&
        !allowed.some((pattern) => pattern.test(line))
      ) {
        unexpected.push(line);
      }
    };
    page.on('console', (message) => {
      const { url, lineNumber } = message.location();
      note(message.type(), message.text(), url ? `${url}:${lineNumber}` : '');
    });
    page.on('pageerror', (error) =>
      note('pageerror', error.stack ?? error.message),
    );
    // The API's own word for a refused request (its error `code`), next to the browser's bare
    // "Failed to load resource": kept in the log only, never counted as a console error.
    page.on('response', (response) => {
      if (response.status() < 400 || !response.url().includes('/api/')) return;
      const method = response.request().method();
      void response.text().then(
        (body) =>
          consoleLog.push(
            `[response] ${response.status()} ${method} ${response.url()} ${body.slice(0, 2000)}`,
          ),
        () => undefined,
      );
    });

    await use(page);

    const failed = testInfo.status !== testInfo.expectedStatus;
    if (failed || unexpected.length > 0) {
      const file = testInfo.outputPath('console.txt');
      writeFileSync(file, consoleLog.join('\n') + '\n');
      await testInfo.attach('console', {
        path: file,
        contentType: 'text/plain',
      });
    }
    expect(
      unexpected,
      'console errors (allow one with test.use({ consoleAllow: [/…/] }))',
    ).toEqual([]);
  },

  // Needs `page`, so the page is set up before and torn down after: still open while its
  // requests settle below.
  api: async ({ page, pageRequests, consoleLog }, use) => {
    const made: Api[] = [];
    await use(async (user) => {
      const api = await Api.as(user);
      made.push(api);
      return api;
    });
    // What the page sent, and what it sends once its reads are answered, lands before its
    // change set is abandoned.
    const open = page.isClosed() ? [] : await pageRequests.settled();
    for (const request of open)
      consoleLog.push(
        `[cleanup] abandoning with a request still open: ${request}`,
      );
    for (const api of made) await api.cleanUp();
    await Promise.all(made.map((api) => api.dispose()));
  },
});

/**
 * Tips and the first-run tour off for this page and its context (#222): `GET /api/me/preferences` answers "Show
 * tips" off and the tour done, whoever is signed in. Only the page sees it; the API's own data is
 * untouched, and a change (`PATCH`) still goes through.
 */
export async function tipsOff(page: Page): Promise<void> {
  await page.context().route('**/api/me/preferences', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 200,
          contentType: 'application/vnd.api+json',
          body: JSON.stringify({
            data: {
              type: 'Preferences',
              id: 'e2e',
              attributes: {
                showTips: false,
                dismissedTips: [],
                tourDone: true,
              },
              meta: { updatedAt: null },
            },
          }),
        })
      : route.continue(),
  );
}

/** Acts as `user` from the next page load on (the demo sign-in's stored choice). */
export async function signIn(page: Page, user: UserId): Promise<void> {
  await page.addInitScript((id) => {
    // Only the first load of the test: a switch in the app afterwards must stand.
    if (!sessionStorage.getItem('e2e.signed-in')) {
      sessionStorage.setItem('e2e.signed-in', '1');
      localStorage.setItem('openfolia.demo-user', id);
    }
  }, user);
}

/** Below 768 px the sidebar is a drawer: opens it, so its links and the account menu are there. */
export async function openSidebar(page: Page): Promise<void> {
  const width = page.viewportSize()?.width ?? 1440;
  if (width >= 768) return;
  await page.getByRole('button', { name: 'Open sidebar' }).click();
}

/**
 * Opens the account menu: the button naming who is signed in (`Account: <name>` while the
 * sidebar is collapsed to icons).
 */
export async function openAccountMenu(page: Page, name: string): Promise<void> {
  await openSidebar(page);
  await page
    .getByRole('button', { name: new RegExp(`^(Account: )?${name}$`) })
    .click();
}

/** Acts as another seeded user through the account menu's switcher. */
export async function switchUser(
  page: Page,
  from: string,
  to: string,
): Promise<void> {
  await openAccountMenu(page, from);
  await page.getByRole('menuitemradio', { name: new RegExp(to) }).click();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: new RegExp(`^(Account: )?${to}$`) }),
  ).toBeAttached();
  // Confirmed by the API and stored, so a reload keeps it.
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem('openfolia.demo-user')),
    )
    .toBe(USER_IDS[to]);
}

const USER_IDS: Record<string, string> = Object.fromEntries(
  Object.values(USERS).map((id) => [
    id
      .replace(/^sample-/, 'Sample ')
      .replace(/\b(\w)/g, (c) => c.toUpperCase()),
    id,
  ]),
);
USER_IDS['Sample Translation Manager'] = USERS.translator;

/**
 * Chooses `option` in a segmented control (`of-segmented`: radios in a radiogroup named
 * `group`), by its label as a person does: the radio itself sits under the label.
 */
export async function chooseSegment(
  page: Page,
  group: string,
  option: string,
): Promise<void> {
  await page
    .getByRole('radiogroup', { name: group })
    .locator('label')
    .filter({ has: page.getByRole('radio', { name: option, exact: true }) })
    .click();
}

/** The page has no horizontal scroll: nothing is wider than the viewport. */
export async function expectNoSideways(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
}

/**
 * The page is no taller than what it lays out (#563). The document never scrolls, and the
 * shell's scroller (`main`) is no taller than its content: an absolutely positioned element
 * (an `sr-only` text) inside an inner scroller that is not positioned escapes that scroller's
 * clip and stretches `main` into empty space where it sits, deep in the list. `fits`: the
 * screen fits the viewport as well, so `main` has nothing to scroll at all.
 */
export async function expectPageFits(
  page: Page,
  { fits = false }: { fits?: boolean } = {},
): Promise<void> {
  const sizes = await page.evaluate(() => {
    const doc = document.scrollingElement ?? document.documentElement;
    const main = document.querySelector<HTMLElement>(
      'main[data-slot=sidebar-inset]',
    );
    if (!main) throw new Error('no shell scroller (main) on the page');
    const box = main.getBoundingClientRect();
    const content = Math.max(
      0,
      ...Array.from(main.children, (child) => {
        const rect = child.getBoundingClientRect();
        const margin = parseFloat(getComputedStyle(child).marginBottom) || 0;
        return rect.bottom + margin - box.top + main.scrollTop;
      }),
    );
    const padding = parseFloat(getComputedStyle(main).paddingBottom) || 0;
    return {
      document: doc.scrollHeight - doc.clientHeight,
      phantom:
        main.scrollHeight -
        Math.max(main.clientHeight, Math.ceil(content + padding)),
      scrolls: main.scrollHeight - main.clientHeight,
    };
  });
  expect(sizes.document, 'the document is taller than the window').toBe(0);
  expect(
    sizes.phantom,
    'the page scrolls into empty space below its content',
  ).toBeLessThanOrEqual(1);
  if (fits) expect(sizes.scrolls, 'the page is taller than the window').toBe(0);
  await expectNoSideways(page);
}

/**
 * Waits until `scroller` shows all it loads: nothing in it busy (`aria-busy`) or a skeleton, every
 * frame in it loaded with its fonts, and its height the same two frames apart (a frame that takes
 * its page's height has measured it). A row whose body arrives later grows the list (#599).
 */
async function expectLoaded(scroller: Locator): Promise<void> {
  await expect
    .poll(
      () =>
        scroller.evaluate(async (el) => {
          if (el.querySelector('[aria-busy=true], [data-slot=skeleton]'))
            return 'a row is loading';
          for (const frame of el.querySelectorAll('iframe')) {
            // Another origin's frame cannot be looked into: its size is what counts.
            const doc = frame.contentDocument;
            if (!doc) continue;
            if (
              doc.readyState !== 'complete' ||
              (frame.srcdoc && doc.URL !== 'about:srcdoc')
            )
              return 'a frame is loading';
            await doc.fonts.ready;
          }
          const height = el.scrollHeight;
          await new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(done)),
          );
          return el.scrollHeight === height ? 'loaded' : 'growing';
        }),
      { message: 'the list has loaded what it shows' },
    )
    .toBe('loaded');
}

/**
 * Wheels down inside `scroller` well past its end; the page itself stays where it was: neither
 * the document nor the shell's `main` scrolls (no scroll chaining, #563). It waits for the list
 * to have loaded first: else a row loading after the wheels reached the end moves the end away
 * from them (#599).
 */
export async function expectWheelStaysInside(
  page: Page,
  scroller: Locator,
): Promise<void> {
  await expectLoaded(scroller);
  const box = await scroller.boundingBox();
  if (!box) throw new Error('the scroller is not on screen');
  await page.mouse.move(
    box.x + box.width / 2,
    box.y + Math.min(box.height, 200) / 2,
  );
  const pageScroll = () =>
    page.evaluate(() => ({
      window: window.scrollY,
      main:
        document.querySelector('main[data-slot=sidebar-inset]')?.scrollTop ?? 0,
    }));
  const before = await pageScroll();
  expect(
    await scroller.evaluate((el) => el.scrollHeight > el.clientHeight + 1),
    'the list has more than it shows (else nothing here is tested)',
  ).toBe(true);
  // To the end in steps as a wheel sends them, then on past it: the list stops there.
  const atEnd = () =>
    scroller.evaluate(
      (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
    );
  for (let i = 0; i < 60 && !(await atEnd()); i++)
    await page.mouse.wheel(0, 800);
  expect(await atEnd(), 'the list scrolled to its end').toBe(true);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 800);
  // The scrolls those wheels started have landed.
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  expect(await pageScroll(), 'the page scrolled with the list').toEqual(before);
}

export { expect, USERS };
