import { expect, type Page, test } from '@playwright/test';
import { parse } from 'yaml';

/**
 * The docs site in a real browser, on the static export (#618): on an English and a German page,
 * at each project's width and colour scheme (`playwright.config.ts`), the controls work, nothing
 * logs an error, nothing scrolls sideways and a table fills its frame.
 */

const PAGES = [
  {
    lang: 'en',
    path: '/configuration/',
    other: '/de/configuration/',
    search: 'error codes',
  },
  {
    lang: 'de',
    path: '/de/configuration/',
    other: '/configuration/',
    // The German error code reference is German (#750): its search finds it by its German title.
    search: 'Fehlercodes',
  },
] as const;

const phone = (page: Page) => (page.viewportSize()?.width ?? 0) < 768;

/** Errors the page logs or throws, collected from the moment the page opens. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/** Opens the page and waits until React has made it interactive. */
async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'networkidle' });
  // The theme switch marks itself when mounted (next-themes): the client has hydrated.
  await expect(
    page.locator('[data-theme-toggle] .bg-fd-accent').first(),
  ).toBeAttached();
}

/** The sidebar's theme switch: the drawer's on a phone (opened first), the footer's otherwise. */
async function sidebar(page: Page) {
  if (phone(page)) {
    await page
      .getByRole('button', { name: /open sidebar|seitenleiste öffnen/i })
      .first()
      .click();
    const drawer = page.locator('#nd-sidebar-mobile');
    await expect(drawer).toBeVisible();
    return drawer;
  }
  return page.locator('#nd-sidebar');
}

for (const { lang, path, other, search } of PAGES) {
  test.describe(`${path} (${lang})`, () => {
    test('opens search with ⌘K and finds a page', async ({ page }) => {
      const errors = watchErrors(page);
      await open(page, path);
      await page.keyboard.press('ControlOrMeta+KeyK');
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('combobox').fill(search);
      const hit = dialog
        .getByRole('option')
        .filter({ hasText: /error codes|fehlercodes/i })
        .first();
      await expect(hit).toBeVisible();
      await hit.click();
      await expect(page).toHaveURL(/\/reference\/errors\//);
      expect(errors).toEqual([]);
    });

    test('collapses the sidebar and opens it again', async ({ page }) => {
      const errors = watchErrors(page);
      await open(page, path);
      if (phone(page)) {
        // A phone opens the sidebar as a drawer from the right; a tap beside it closes it.
        const drawer = await sidebar(page);
        await page.mouse.click(10, 400);
        await expect(drawer).toBeHidden();
      } else {
        const aside = page.locator('#nd-sidebar');
        await expect(aside).toBeInViewport();
        const collapse = page.getByRole('button', {
          name: /collapse sidebar|seitenleiste einklappen/i,
        });
        // The sidebar's own button, then the one left floating over the page to bring it back.
        await aside
          .getByRole('button', {
            name: /collapse sidebar|seitenleiste einklappen/i,
          })
          .click();
        await expect(aside).not.toBeInViewport();
        await collapse.last().click();
        await expect(aside).toBeInViewport();
      }
      expect(errors).toEqual([]);
    });

    test('switches the theme', async ({ page }) => {
      const errors = watchErrors(page);
      await open(page, path);
      const html = page.locator('html');
      const dark = (await html.getAttribute('class'))
        ?.split(' ')
        .includes('dark');
      const bar = await sidebar(page);
      await bar.locator('[data-theme-toggle]').click();
      await expect(html).toHaveClass(dark ? /^(?!.*\bdark\b)/ : /\bdark\b/);
      expect(errors).toEqual([]);
    });

    test('has no empty slot beside the theme switch', async ({ page }) => {
      test.skip(phone(page), 'the drawer puts the switch in a row of its own');
      await open(page, path);
      // The bordered row the switch sits in names it, so no blank band sits beside it.
      const row = page
        .locator('#nd-sidebar [data-theme-toggle]')
        .locator('xpath=..');
      await expect(
        row.getByText(lang === 'en' ? 'Theme' : 'Darstellung', { exact: true }),
      ).toBeVisible();
    });

    test('links to the repository', async ({ page }) => {
      await open(page, path);
      const bar = await sidebar(page);
      // DOCS_REPOSITORY_URL, the project's own repository unless a build sets another.
      await expect(
        bar.locator('a[href^="https://github.com/"]').first(),
      ).toBeVisible();
    });

    test('switches the language and back', async ({ page }) => {
      const errors = watchErrors(page);
      await open(page, path);
      const bar = await sidebar(page);
      await bar
        .getByRole('button', { name: /choose a language|sprache wählen/i })
        .click();
      await page
        .getByRole('button', {
          name: lang === 'en' ? 'Deutsch' : 'English',
          exact: true,
        })
        .click();
      await expect(page).toHaveURL(new RegExp(`${other}$`));
      await expect(page.locator('html')).toHaveAttribute(
        'lang',
        lang === 'en' ? 'de' : 'en',
      );
      await expect(
        page.locator('[data-theme-toggle] .bg-fd-accent').first(),
      ).toBeAttached();
      const back = await sidebar(page);
      await back
        .getByRole('button', { name: /choose a language|sprache wählen/i })
        .click();
      await page
        .getByRole('button', {
          name: lang === 'en' ? 'English' : 'Deutsch',
          exact: true,
        })
        .click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      expect(errors).toEqual([]);
    });

    test('does not scroll sideways, and its table fills its frame', async ({
      page,
    }) => {
      const errors = watchErrors(page);
      await open(page, path);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
      const table = page.locator('article table').first();
      await table.scrollIntoViewIfNeeded();
      const [own, frame] = await table.evaluate((element) => [
        element.querySelector('tr')?.getBoundingClientRect().width ?? 0,
        element.parentElement?.clientWidth ?? 0,
      ]);
      expect(
        own,
        'the table rows stop short of their frame',
      ).toBeGreaterThanOrEqual(frame - 2);
      expect(errors).toEqual([]);
    });
  });
}

test('the openfolia.yaml reference breaks field names only between their parts', async ({
  page,
}) => {
  await open(page, '/reference/project-config/');
  const cells = page.locator('article table tbody tr td:first-child code');
  await expect(cells.first()).toBeVisible();
  const laidOut = await cells.evaluateAll((codes) =>
    codes.map((code) => {
      // Each line the browser laid the name out on, from its text's rectangles.
      const range = document.createRange();
      range.selectNodeContents(code);
      const lines = new Map<number, string>();
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        for (let i = 0; i < text.length; i++) {
          const r = document.createRange();
          r.setStart(node, i);
          r.setEnd(node, i + 1);
          const top = Math.round(r.getBoundingClientRect().top);
          lines.set(top, (lines.get(top) ?? '') + text[i]);
        }
      }
      const parts = [...lines.values()];
      return parts;
    }),
  );
  // A line may end only after `.`, `_`, `-` or `]` (between a name's parts), never mid-word.
  const broken = laidOut
    .filter((parts) =>
      parts.slice(0, -1).some((line) => !/[._\-\]]$/.test(line)),
    )
    .map((parts) => parts.join(' | '));
  expect(broken, 'field names wrapped mid-word').toEqual([]);
  // On a phone the column is narrow enough that long names do wrap: the check above saw some.
  if (phone(page))
    expect(
      laidOut.some((parts) => parts.length > 1),
      'no field name wrapped at all',
    ).toBe(true);
  if (!phone(page)) {
    // On a desktop the whole table fits its frame: every column, Description included, in view.
    const [scroll, client] = await page
      .locator('article table')
      .first()
      .evaluate((table) => [
        table.parentElement?.scrollWidth ?? 0,
        table.parentElement?.clientWidth ?? 0,
      ]);
    expect(
      scroll,
      'the table scrolls sideways in its frame',
    ).toBeLessThanOrEqual(client);
  }
});

for (const api of ['delivery', 'management'] as const) {
  test(`the ${api} OpenAPI document downloads as YAML and JSON`, async ({
    page,
    request,
  }) => {
    test.skip(phone(page) || page.viewportSize() === null, 'once is enough');
    const yaml = await request.get(`/openapi/${api}.yaml`);
    expect(yaml.ok()).toBe(true);
    const json = await request.get(`/openapi/${api}.json`);
    expect(json.ok()).toBe(true);
    for (const document of [parse(await yaml.text()), await json.json()]) {
      expect(document.openapi).toMatch(/^3\.\d+\.\d+$/);
      expect(Object.keys(document.paths ?? {}).length).toBeGreaterThan(0);
      expect(document.servers?.[0]?.url).toMatch(/^https?:\/\//);
    }
    await open(page, `/api/${api}/`);
    await expect(
      page.getByRole('link', { name: 'YAML' }).first(),
    ).toHaveAttribute('href', `/openapi/${api}.yaml`);
  });
}

for (const { lang, path, heading } of [
  { lang: 'en', path: '/changelog/', heading: 'Changelog' },
  { lang: 'de', path: '/de/changelog/', heading: 'Änderungsprotokoll' },
] as const) {
  test(`the changelog (${lang}) renders and names its Atom feed`, async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    await open(page, path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
    const feedLink = page.locator('article a[href="/changelog.xml"]');
    await expect(feedLink).toBeVisible();
    await expect(
      page.locator('head link[rel="alternate"][type="application/atom+xml"]'),
    ).toHaveAttribute('href', /\/changelog\.xml$/);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
    // The feed is well-formed Atom, with an entry per version the page lists.
    const feed = await request.get('/changelog.xml');
    expect(feed.ok()).toBe(true);
    const text = await feed.text();
    const parsed = await page.evaluate((xml) => {
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      return {
        error: doc.getElementsByTagName('parsererror').length > 0,
        root: doc.documentElement.namespaceURI,
        entries: doc.getElementsByTagName('entry').length,
      };
    }, text);
    expect(parsed.error).toBe(false);
    expect(parsed.root).toBe('http://www.w3.org/2005/Atom');
    expect(parsed.entries).toBe(
      await page.locator('article h2[id^="v"]').count(),
    );
    expect(errors).toEqual([]);
  });
}

for (const { lang, path, markdown, copy, line } of [
  {
    lang: 'en',
    path: '/',
    markdown: '/index.md',
    copy: 'Copy',
    line: /^Install OpenFolia for me: fetch and follow this guide https?:\/\/\S+\/agents$/,
  },
  {
    lang: 'de',
    path: '/de/',
    markdown: '/de/index.md',
    copy: 'Kopieren',
    line: /^Installiere OpenFolia für mich: .+ https?:\/\/\S+\/agents$/,
  },
] as const) {
  test(`the home page (${lang}) offers the install line for a coding agent, and its Markdown (#423)`, async ({
    page,
    context,
    request,
  }) => {
    const errors = watchErrors(page);
    await open(page, path);
    const box = page.locator('[data-agent-install]');
    await expect(box).toBeVisible();
    await expect(box.locator('code')).toHaveText(line);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await box.getByRole('button', { name: copy, exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
      line,
    );
    // The page's own actions: its Markdown to copy, or to open.
    await expect(
      page.getByRole('button', { name: /copy markdown|markdown kopieren/i }),
    ).toBeVisible();
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
    const md = await request.get(markdown);
    expect(md.ok()).toBe(true);
    expect(md.headers()['content-type']).toMatch(/^text\/markdown/);
    expect(await md.text()).toMatch(/^# OpenFolia/);
    expect(errors).toEqual([]);
  });
}

test('the agent guide is served as Markdown, and the files for language models as text (#423)', async ({
  page,
  request,
}) => {
  test.skip(phone(page) || page.viewportSize() === null, 'once is enough');
  const guide = await request.get('/agents.md');
  expect(guide.headers()['content-type']).toMatch(/^text\/markdown/);
  const text = await guide.text();
  expect(text).toMatch(/^# Install with a coding agent/);
  expect(text).toContain('## Rules for the agent');
  expect(text).not.toContain('<AgentInstall');
  for (const file of ['/llms.txt', '/llms-full.txt']) {
    const answer = await request.get(file);
    expect(answer.ok()).toBe(true);
    expect(answer.headers()['content-type']).toMatch(/^text\/plain/);
  }
  expect(await (await request.get('/llms.txt')).text()).toContain('/agents.md');
});
