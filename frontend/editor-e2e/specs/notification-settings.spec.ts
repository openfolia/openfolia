import type { Page } from '@playwright/test';
import { type Api, unique, type UserId, USERS } from '../src/api.ts';
import {
  expect,
  expectNoSideways,
  openAccountMenu,
  signIn,
  test,
} from '../src/fixtures.ts';
import { knobGaps } from '../src/switch.ts';

/**
 * Account menu › Notifications (#884) and the page an email's unsubscribe link opens. Each test
 * signs in as a person of its own, made through the API, so the choices it changes are nobody
 * else's. The suite's API sends no email, so the page says why. `tips: true` reads the person's
 * real preferences (the suite's stub has no notifications); their tips are turned off by the API.
 */

const JSON_API = 'application/vnd.api+json';

/** An administrator of the flow's own: the admin alerts concern them. */
async function ownAdmin(admin: Api): Promise<{ id: UserId; name: string }> {
  const id = `e2e-notif-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const name = unique('Notified admin');
  await admin.json(
    admin.send('POST', '/users', {
      data: {
        type: 'User',
        id,
        attributes: { name, email: `${id}@example.test` },
        relationships: { roles: { data: [{ type: 'Role', id: 'admin' }] } },
      },
    }),
    201,
  );
  // A user added for the flow, not one of the seeded ones `UserId` names.
  return { id: id as UserId, name };
}

/** No tip and no tour in the way of the flow. */
async function withoutTips(mine: Api): Promise<void> {
  await mine.json(
    mine.send('PATCH', '/me/preferences', {
      data: {
        type: 'Preferences',
        attributes: { showTips: false, tourDone: true },
      },
    }),
  );
}

/** The person's notification settings as the API keeps them. */
async function stored(api: Api) {
  const { data } = await api.json(api.get('/me/preferences'));
  return data.attributes.notifications as {
    choices: Record<string, string>;
    allOff: boolean;
    emailPaused: boolean;
    language: string | null;
    timeZone: string | null;
  };
}

/** Waits for the page's next change of the preferences to be answered. */
const saved = (page: Page) =>
  page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/me/preferences') &&
      r.request().method() === 'PATCH',
  );

/** The row of a kind on the page, by its label. */
const row = (page: Page, label: string) =>
  page.getByRole('listitem').filter({ hasText: label });

test.describe('notification settings @area:notifications @api:preferences @narrow', () => {
  test.use({ tips: true });

  test('chooses per kind, warns of a missed admin alert, and turns everything off', async ({
    page,
    api,
  }) => {
    const me = await ownAdmin(await api(USERS.admin));
    const mine = await api(me.id);
    await withoutTips(mine);
    await signIn(page, me.id);
    await page.goto('/content');
    await openAccountMenu(page, me.name);
    await page.getByRole('menuitem', { name: 'Notifications' }).click();
    await expect(page).toHaveURL(/\/account\/notifications/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Notifications' }),
    ).toBeVisible();

    // No mail server on this stack: said, and why.
    await expect(page.getByText('Email is off for you')).toBeVisible();
    await expect(page.getByText(/This server sends no email/)).toBeVisible();

    // The defaults.
    const submit = row(page, 'A revision is submitted to you for review');
    await expect(submit.getByRole('combobox')).toHaveText(
      /App \+ email at once/,
    );
    await expect(
      row(page, 'A release is published').getByRole('combobox'),
    ).toHaveText(/App \+ daily summary/);

    // An admin alert turned off: the page says what is missed, and it is kept.
    const backup = row(page, 'A backup failed');
    await backup.getByRole('combobox').click();
    const off = saved(page);
    await page.getByRole('option', { name: 'Off', exact: true }).click();
    await off;
    await expect(page.getByText('You turned off an admin alert')).toBeVisible();
    await expect(
      page.getByText('You will not hear when a backup fails.'),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="settings-save-status"]'),
    ).toContainText('Saved');
    await expect
      .poll(async () => (await stored(mine)).choices['backup.failed'])
      .toBe('off');
    expect((await stored(mine)).choices['change-set.submit']).toBe('email');

    // The editor keeps the email's language and time zone to the person's.
    await expect.poll(async () => (await stored(mine)).language).toBe('en');
    expect((await stored(mine)).timeZone).not.toBeNull();

    // Read again: the choice stands.
    await page.reload();
    await expect(backup.getByRole('combobox')).toHaveText(/Off/);

    // Everything off: for this person only.
    const allOff = saved(page);
    await page
      .getByRole('switch', { name: 'Turn off all notifications' })
      .click();
    await allOff;
    await expect(
      page.getByText('All your notifications are off.'),
    ).toBeVisible();
    await expect(submit.getByRole('combobox')).toBeDisabled();
    expect((await stored(mine)).allOff).toBe(true);
    expect((await stored(await api(USERS.admin))).allOff).toBe(false);
    await expectNoSideways(page);
  });

  test.describe('a change the API refuses', () => {
    test.use({ consoleAllow: [/status of 503.*\/api\/me\/preferences/] });

    test('says so, and puts back what the server has', async ({
      page,
      api,
    }) => {
      const me = await ownAdmin(await api(USERS.admin));
      const mine = await api(me.id);
      await withoutTips(mine);
      await signIn(page, me.id);
      await page.goto('/account/notifications');
      const submit = row(page, 'A revision is submitted to you for review');
      await expect(submit.getByRole('combobox')).toHaveText(
        /App \+ email at once/,
      );
      await page.route(
        (url) => url.pathname === '/api/me/preferences',
        (route) =>
          route.request().method() === 'PATCH'
            ? route.fulfill({
                status: 503,
                contentType: JSON_API,
                headers: { 'Retry-After': '1' },
                body: JSON.stringify({
                  errors: [
                    {
                      status: '503',
                      code: 'database-timeout',
                      title: 'Service Unavailable',
                      detail: 'The database took too long.',
                    },
                  ],
                }),
              })
            : route.fallback(),
      );
      await submit.getByRole('combobox').click();
      await page.getByRole('option', { name: 'In the app only' }).click();
      await expect(
        page.locator('[data-slot="settings-save-status"]'),
      ).toContainText('Not saved');
      await expect(submit.getByRole('combobox')).toHaveText(
        /App \+ email at once/,
      );
      expect((await stored(mine)).choices['change-set.submit']).toBe('email');
    });
  });
});

/** A kind's select, or a switch: what its box and its text measure. */
const measured = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      const text = element.querySelector('.truncate');
      return {
        text: text?.textContent?.trim() ?? '',
        clipped: text !== null && text.scrollWidth > text.clientWidth,
        width: Math.round(box.width),
        right: Math.round(box.right),
      };
    }),
  );
const SELECTS = '[data-slot="kind-choice"] button';
const SWITCHES = '[data-slot="switches"] [role="switch"]';

test.describe('notification settings, the controls @area:notifications @api:preferences', () => {
  test.use({ tips: true });

  for (const [language, longest] of [
    ['en', 'App + email at once'],
    ['de', 'App + tägliche Zusammenfassung'],
  ] as const) {
    test(`have one width and one right edge, with no text cut off (${language})`, async ({
      page,
      api,
    }) => {
      const me = await ownAdmin(await api(USERS.admin));
      await withoutTips(await api(me.id));
      await page.addInitScript((l) => {
        localStorage.setItem('of-language', l);
      }, language);
      await signIn(page, me.id);
      await page.goto('/account/notifications');
      for (const width of [390, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(page.locator(SELECTS).first()).toBeVisible();
        const selects = await measured(page, SELECTS);
        expect(selects.map((s) => s.text)).toContain(longest);
        expect(
          selects.filter((s) => s.clipped),
          `cut off at ${width}`,
        ).toEqual([]);
        expect(
          new Set(selects.map((s) => s.width)).size,
          `widths at ${width}`,
        ).toBe(1);
        const switches = await measured(page, SWITCHES);
        expect(switches).toHaveLength(2);
        expect(
          [...new Set([...selects, ...switches].map((c) => c.right))],
          `right edges at ${width}`,
        ).toHaveLength(1);
        await expectNoSideways(page);
      }
      // A shorter choice moves nothing.
      const before = await measured(page, SELECTS);
      const select = page.locator('[data-kind="release.published"] button');
      await select.click();
      const done = saved(page);
      await page.getByRole('option').first().click();
      await done;
      const after = await measured(page, SELECTS);
      expect(after.map((s) => [s.width, s.right])).toEqual(
        before.map((s) => [s.width, s.right]),
      );
    });
  }

  for (const scale of [1, 2]) {
    test.describe(`at ${scale}x`, () => {
      test.use({ deviceScaleFactor: scale });

      test("a switch's knob sits inside the border, as far from each side", async ({
        page,
        api,
      }) => {
        const me = await ownAdmin(await api(USERS.admin));
        await withoutTips(await api(me.id));
        await signIn(page, me.id);
        await page.goto('/account/notifications');
        for (const id of ['notif-pause-email', 'notif-all-off']) {
          const track = page.locator(`#${id}`);
          const gaps = { size: 'default', top: 1, bottom: 1, end: 1, away: 15 };
          await expect
            .poll(() => knobGaps(track))
            .toEqual({ on: false, ...gaps });
          const done = saved(page);
          await track.click();
          await done;
          // Polled: the knob moves there.
          await expect
            .poll(() => knobGaps(track))
            .toEqual({ on: true, ...gaps });
        }
      });
    });
  }
});

test.describe('unsubscribe link @area:notifications @api:notifications @narrow', () => {
  test('confirms the kinds it turned off', async ({ page }) => {
    let posted = '';
    await page.route(
      (url) => url.pathname.startsWith('/api/notifications/unsubscribe/'),
      (route) => {
        posted = new URL(route.request().url()).pathname;
        return route.fulfill({
          status: 200,
          contentType: JSON_API,
          body: JSON.stringify({
            meta: {
              kinds: ['change-set.submit'],
              changed: ['change-set.submit'],
            },
          }),
        });
      },
    );
    const token = 'a'.repeat(40);
    // As the email links it: the token, and the kinds to name (an unknown one is left out).
    await page.goto(
      `/unsubscribe#${token}&kinds=change-set.submit,release.published,nope`,
    );
    // Asked first: opening the page (a link scanner does) changes nothing.
    await expect(
      page.getByRole('heading', { name: 'Stop these emails?' }),
    ).toBeVisible();
    const asked = page.locator('[data-slot="unsubscribe-kinds"] li');
    await expect(asked).toHaveText([
      'A revision is submitted to you for review',
      'A release is published',
    ]);
    expect(posted).toBe('');
    // The token leaves the address at once.
    expect(new URL(page.url()).hash).toBe('');
    await page.getByRole('button', { name: 'Stop these emails' }).click();
    await expect(
      page.getByRole('heading', { name: 'You are unsubscribed' }),
    ).toBeVisible();
    await expect(
      page.getByText('A revision is submitted to you for review'),
    ).toBeVisible();
    expect(posted).toBe(`/api/notifications/unsubscribe/${token}`);
    await expectNoSideways(page);
  });

  test('says nothing changed when the emails already come another way', async ({
    page,
  }) => {
    await page.route(
      (url) => url.pathname.startsWith('/api/notifications/unsubscribe/'),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: JSON_API,
          body: JSON.stringify({ meta: { kinds: [], changed: [] } }),
        }),
    );
    await page.goto(`/unsubscribe#${'c'.repeat(40)}`);
    await page.getByRole('button', { name: 'Stop these emails' }).click();
    await expect(
      page.getByRole('heading', { name: 'Nothing changed' }),
    ).toBeVisible();
    await expect(page.getByText(/another way than this link/)).toBeVisible();
    await expect(page.locator('[data-slot="unsubscribed-kinds"]')).toHaveCount(
      0,
    );
  });

  test.describe('a link this server did not make', () => {
    test.use({
      consoleAllow: [/status of 404.*\/api\/notifications\/unsubscribe/],
    });

    test('says it does not work, and changes nothing', async ({ page }) => {
      await page.goto(`/unsubscribe#${'b'.repeat(40)}`);
      await page.getByRole('button', { name: 'Stop these emails' }).click();
      await expect(
        page.getByRole('heading', { name: 'This link does not work' }),
      ).toBeVisible();
      await expect(
        page.getByText('Open your notification settings'),
      ).toBeVisible();
    });
  });
});
