import type { Page } from '@playwright/test';
import { type Api, unique, type UserId, USERS } from '../src/api.ts';
import { expect, openAccountMenu, signIn, test } from '../src/fixtures.ts';

/**
 * Tips and the first-run tour (#222), with their off switch per person. Each test signs in as a
 * person of its own, made through the API, so the preferences it changes are nobody else's, and
 * turns the suite's stub off (`tips: true`): the API's `GET /me/preferences` is read as it is.
 */
test.use({ tips: true });

/** A person of the flow's own: an author, with the API's defaults (tips on, tour to come). */
async function ownAuthor(admin: Api): Promise<{ id: UserId; name: string }> {
  const id = `e2e-tips-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const name = unique('Tips author');
  await admin.json(
    admin.send('POST', '/users', {
      data: {
        type: 'User',
        id,
        attributes: { name, email: `${id}@example.test` },
        relationships: { roles: { data: [{ type: 'Role', id: 'author' }] } },
      },
    }),
    201,
  );
  // A user added for the flow, not one of the seeded ones `UserId` names.
  return { id: id as UserId, name };
}

/** The person's preferences as the API keeps them. */
async function stored(api: Api) {
  const { data } = await api.json(api.get('/me/preferences'));
  return data.attributes as {
    showTips: boolean;
    dismissedTips: string[];
    tourDone: boolean;
  };
}

/** Waits for the editor's next change of the preferences to be answered. */
const saved = (page: Page) =>
  page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/me/preferences') &&
      r.request().method() === 'PATCH' &&
      r.ok(),
  );

const tour = (page: Page, title: string) =>
  page.getByRole('dialog', { name: title });

/** A tour step's "2 of 5". */
const stepOf = (page: Page) => page.locator('[data-slot="tip-step"]');

test.describe('tips and the tour @area:shell @api:preferences', () => {
  test('a new person sees the tour once; Skip ends it, on another browser too', async ({
    page,
    browser,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const me = await ownAuthor(admin);
    await signIn(page, me.id);
    await page.goto('/content');

    const first = tour(page, 'Content');
    await expect(first).toBeVisible();
    await expect(first).toBeFocused();
    await expect(stepOf(page)).toHaveText(/1 of \d/);
    await expect(first).toContainText('Every module is here');

    await first.getByRole('button', { name: 'Next' }).click();
    const editor = tour(page, 'The editor');
    await expect(editor).toBeVisible();
    await expect(stepOf(page)).toHaveText(/2 of \d/);
    await editor.getByRole('button', { name: 'Back' }).click();
    await expect(tour(page, 'Content')).toBeVisible();

    // Escape skips it, as Skip does.
    const skipped = saved(page);
    await page.keyboard.press('Escape');
    await skipped;
    await expect(page.getByRole('dialog', { name: 'Content' })).toBeHidden();
    expect((await stored(await api(me.id))).tourDone).toBe(true);

    // Another browser: no tour, the content screen's tip comes instead (the tour goes first).
    const other = await browser.newContext();
    try {
      const second = await other.newPage();
      await signIn(second, me.id);
      // A context of its own has none of the suite's settings: the address in full.
      await second.goto(new URL('/content', page.url()).href);
      const tip = second.getByRole('dialog', { name: 'Start a module' });
      await expect(tip).toBeVisible();
      await expect(tip.getByRole('button', { name: 'Got it' })).toBeVisible();
      await expect(
        tip.getByRole('button', { name: 'Turn off tips' }),
      ).toBeVisible();
      await expect(second.getByRole('dialog', { name: 'Content' })).toHaveCount(
        0,
      );
    } finally {
      await other.close();
    }
  });

  test('a dismissed tip never shows again; the next one does', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const me = await ownAuthor(admin);
    const mine = await api(me.id);
    await mine.json(
      mine.send('PATCH', '/me/preferences', {
        data: { type: 'Preferences', attributes: { tourDone: true } },
      }),
    );
    await signIn(page, me.id);
    await page.goto('/content');

    const tip = page.getByRole('dialog', { name: 'Start a module' });
    await expect(tip).toBeVisible();
    await expect(tip).toBeFocused();
    await expect(
      tip.getByRole('link', { name: /^Learn more:/ }),
    ).toHaveAttribute('target', '_blank');
    const done = saved(page);
    await tip.getByRole('button', { name: 'Got it' }).click();
    await done;
    await expect(tip).toBeHidden();
    expect((await stored(mine)).dismissedTips).toEqual(['content.new-module']);

    // With a revision of their own, the bell's tip applies too: after a reload it is the one
    // shown, never the dismissed one.
    await mine.createChangeSet(unique('Tips revision'));
    await page.reload();
    await expect(
      page.getByRole('dialog', { name: 'Hear back on your revisions' }),
    ).toBeVisible();
    await expect(
      page.getByRole('dialog', { name: 'Start a module' }),
    ).toHaveCount(0);
  });

  test('Show tips off hides tips and the tour; Reset tips and Take the tour bring them back', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const me = await ownAuthor(admin);
    const mine = await api(me.id);
    await mine.json(
      mine.send('PATCH', '/me/preferences', {
        data: { type: 'Preferences', attributes: { tourDone: true } },
      }),
    );
    await signIn(page, me.id);
    await page.goto('/content');

    const tip = page.getByRole('dialog', { name: 'Start a module' });
    await expect(tip).toBeVisible();
    const off = saved(page);
    await tip.getByRole('button', { name: 'Turn off tips' }).click();
    await off;
    await expect(tip).toBeHidden();
    await expect.poll(async () => (await stored(mine)).showTips).toBe(false);

    await openAccountMenu(page, me.name);
    const show = page.getByRole('menuitemcheckbox', { name: 'Show tips' });
    await expect(show).toHaveAttribute('aria-checked', 'false');
    const reset = saved(page);
    await page.getByRole('menuitem', { name: 'Reset tips' }).click();
    await reset;
    await expect(page.getByText('Tips will show again.')).toBeVisible();
    await expect(tip).toBeVisible();
    expect(await stored(mine)).toMatchObject({
      showTips: true,
      dismissedTips: [],
    });

    await tip.getByRole('button', { name: 'Got it' }).click();
    await expect(tip).toBeHidden();
    await openAccountMenu(page, me.name);
    await expect(
      page.getByRole('menuitemcheckbox', { name: 'Show tips' }),
    ).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('menuitem', { name: 'Take the tour' }).click();
    const first = tour(page, 'Content');
    await expect(first).toBeVisible();
    // Next to the last step, whatever the number of steps this person has; Done there.
    const total = Number(
      /of (\d)/.exec((await stepOf(page).textContent()) ?? '')?.[1],
    );
    for (let index = 1; index < total; index++) {
      await expect(stepOf(page)).toHaveText(new RegExp(`${index} of ${total}`));
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Next' })
        .click();
    }
    await expect(stepOf(page)).toHaveText(new RegExp(`${total} of ${total}`));
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Done' })
      .click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(async () => (await stored(mine)).tourDone).toBe(true);
  });

  test('no tip while the search palette is open', async ({ page, api }) => {
    const admin = await api(USERS.admin);
    const me = await ownAuthor(admin);
    const mine = await api(me.id);
    await mine.json(
      mine.send('PATCH', '/me/preferences', {
        data: { type: 'Preferences', attributes: { tourDone: true } },
      }),
    );
    await signIn(page, me.id);
    const read = page.waitForResponse((r) =>
      r.url().endsWith('/api/me/preferences'),
    );
    await page.goto('/content');
    await read;
    // The browser reports a non-Apple platform: Ctrl+K.
    await page.keyboard.press('Control+k');
    const palette = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('combobox') });
    await expect(palette).toBeVisible();
    // Longer than the screen takes to settle (1.2 s): the tip would have come by now.
    await page.waitForTimeout(2500);
    await expect(
      page.getByRole('dialog', { name: 'Start a module' }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    await expect(
      page.getByRole('dialog', { name: 'Start a module' }),
    ).toBeVisible();
  });
});

test.describe('tips when the API refuses their change @area:shell @api:preferences', () => {
  test.use({ consoleAllow: [/\/api\/me\/preferences/] });

  test('a refused change keeps to this browser: the tip still goes', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const me = await ownAuthor(admin);
    const mine = await api(me.id);
    await mine.json(
      mine.send('PATCH', '/me/preferences', {
        data: { type: 'Preferences', attributes: { tourDone: true } },
      }),
    );
    await page.route('**/api/me/preferences', (route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({
            status: 503,
            contentType: 'application/vnd.api+json',
            body: JSON.stringify({
              errors: [
                {
                  status: '503',
                  code: 'database-timeout',
                  title: 'Unavailable',
                },
              ],
            }),
          })
        : route.continue(),
    );
    await signIn(page, me.id);
    await page.goto('/content');
    const tip = page.getByRole('dialog', { name: 'Start a module' });
    await expect(tip).toBeVisible();
    const refused = page.waitForResponse(
      (r) => r.url().endsWith('/api/me/preferences') && r.status() === 503,
    );
    await tip.getByRole('button', { name: 'Got it' }).click();
    await refused;
    await expect(tip).toBeHidden();
    // Kept in this browser only: the API still has it as not dismissed.
    expect((await stored(mine)).dismissedTips).toEqual([]);
    expect(
      await page.evaluate(
        (id) =>
          JSON.parse(localStorage.getItem(`openfolia.tips:${id}`) ?? '{}'),
        me.id,
      ),
    ).toMatchObject({ dismissedTips: ['content.new-module'] });
  });
});
