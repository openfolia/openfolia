import type { Locator, Page } from '@playwright/test';
import {
  type Api,
  mergedModule,
  moduleId,
  paragraph,
  unique,
  type UserId,
  USERS,
} from '../src/api.ts';
import { expect, openAccountMenu, signIn, test } from '../src/fixtures.ts';

/**
 * Tips and the first-run tour (#222), with their off switch per person. Each test signs in as a
 * person of its own, made through the API, so the preferences it changes are nobody else's, and
 * turns the suite's stub off (`tips: true`): the API's `GET /me/preferences` is read as it is.
 */
test.use({ tips: true });

/**
 * A person of the flow's own: an author (or another role), with the API's defaults (tips on, tour
 * to come).
 */
async function ownAuthor(
  admin: Api,
  role = 'author',
): Promise<{ id: UserId; name: string }> {
  const id = `e2e-tips-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const name = unique('Tips author');
  await admin.json(
    admin.send('POST', '/users', {
      data: {
        type: 'User',
        id,
        attributes: { name, email: `${id}@example.test` },
        relationships: { roles: { data: [{ type: 'Role', id: role }] } },
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

/** The tour's welcome, its first step. */
const WELCOME = 'Write it once, publish it everywhere';

/** A module of the flow's own on main, so the module list's first row is one nobody else uses. */
async function ownModule(api: (user: UserId) => Promise<Api>) {
  return mergedModule(
    await api(USERS.author),
    await api(USERS.reviewer),
    await api(USERS.publisher),
    unique('Tour module'),
  );
}

/** The change sets the person started. */
async function changeSetsOf(api: Api, id: string) {
  const { data } = await api.json(
    api.get(`/change-sets?filter[author]=${encodeURIComponent(id)}`),
  );
  return data as { attributes: { title: string; state: string } }[];
}

/** The tour starts this tab at `step` (as a reload mid-tour does). */
const startAt = (page: Page, person: string, step: string) =>
  page.addInitScript(
    ([key, value]) => sessionStorage.setItem(key!, value!),
    [`openfolia.tour:${person}`, step],
  );

/**
 * Opens the module from its row in the list and waits for the editor's lock on it. The tour's
 * "Change a sentence" lights the text only once it can be edited, and before that the editor reads
 * the module, starts the tour's revision (or chooses the kept one again), reads the module and its
 * working copy in it and takes the lock, one request after another: on a busy machine that chain
 * alone can use most of an expect's 10 s (README, "The first check after a page load"; #523,
 * #901). The card is then expected within the usual time.
 */
async function openToEdit(page: Page, row: Locator): Promise<void> {
  const locked = page.waitForResponse(
    (r) =>
      /\/change-sets\/[^/]+\/locks$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST' &&
      r.ok(),
    // As long as the list's own row may take (a busy machine), not an action's 15 s.
    { timeout: 30_000 },
  );
  await row.click();
  await locked;
}

/** A tour step's "2 of 5". */
const stepOf = (page: Page) => page.locator('[data-slot="tip-step"]');

/** The card sits beside or below the element with `data-tip="<anchor>"`, never over it. */
async function expectBeside(page: Page, card: Locator, anchor: string) {
  const [c, a] = await Promise.all([
    card.boundingBox(),
    page.locator(`[data-tip="${anchor}"]:visible`).first().boundingBox(),
  ]);
  expect(c, 'the card').not.toBeNull();
  expect(a, `the anchor ${anchor}`).not.toBeNull();
  const apart =
    c!.x >= a!.x + a!.width ||
    c!.x + c!.width <= a!.x ||
    c!.y >= a!.y + a!.height ||
    c!.y + c!.height <= a!.y;
  expect(apart, `the card is clear of ${anchor}`).toBe(true);
  // Near it: the arrow can reach.
  const gap = Math.max(
    c!.x - (a!.x + a!.width),
    a!.x - (c!.x + c!.width),
    c!.y - (a!.y + a!.height),
    a!.y - (c!.y + c!.height),
  );
  expect(gap).toBeLessThanOrEqual(24);
}

/** The card covers none of `what` (the sentence the person changed). */
async function expectClearOf(card: Locator, what: Locator) {
  const [c, w] = await Promise.all([card.boundingBox(), what.boundingBox()]);
  expect(c, 'the card').not.toBeNull();
  expect(w, 'what it keeps clear of').not.toBeNull();
  const apart =
    c!.x >= w!.x + w!.width ||
    c!.x + c!.width <= w!.x ||
    c!.y >= w!.y + w!.height ||
    c!.y + c!.height <= w!.y;
  expect(apart, 'the card covers none of it').toBe(true);
}

/** The card is wholly inside the window. */
async function expectOnScreen(page: Page, card: Locator) {
  const box = await card.boundingBox();
  const view = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(view.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(view.height);
}

test.describe('tips and the tour @area:shell @area:content @area:module-editor @api:preferences @api:change-sets', () => {
  test('a new person is welcomed once; Not now ends it, on another browser too', async ({
    page,
    browser,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const me = await ownAuthor(admin);
    await signIn(page, me.id);
    await page.goto('/content');

    const first = tour(page, WELCOME);
    await expect(first).toBeVisible();
    await expect(first).toBeFocused();
    await expect(stepOf(page)).toHaveText('1 of 5');
    await expect(first).toContainText('small reusable modules');
    await expect(first.getByRole('button', { name: 'Back' })).toHaveCount(0);

    const skipped = saved(page);
    await first.getByRole('button', { name: 'Not now' }).click();
    await skipped;
    await expect(first).toBeHidden();
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
      await expect(second.getByRole('dialog', { name: WELCOME })).toHaveCount(
        0,
      );
    } finally {
      await other.close();
    }
  });

  test('a writer goes from the welcome to a typed change in a revision, then to Review, without leaving the tour (#869)', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const made = await ownModule(api);
    const me = await ownAuthor(admin);
    const mine = await api(me.id);
    await signIn(page, me.id);
    await page.goto(`/content?q=${made.module.moduleId}`);

    const welcome = tour(page, WELCOME);
    await expect(welcome).toBeVisible();
    await welcome.getByRole('button', { name: 'Show me how' }).click();

    const open = tour(page, 'Open a module');
    await expect(open).toBeVisible();
    await expect(stepOf(page)).toHaveText('2 of 5');
    await expectBeside(page, open, 'content.module');
    // The list's search may lag behind the module just merged (a busy machine): its own row, not
    // the first one, is the one to open.
    const row = page.getByRole('link', { name: made.moduleTitle });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await openToEdit(page, row);

    // No revision was open: the tour started one, named after the module, and the text is
    // editable in it.
    const edit = tour(page, 'Change a sentence');
    await expect(edit).toBeVisible();
    await expect(stepOf(page)).toHaveText('3 of 5');
    await expect(page.getByText('Locked by you')).toBeVisible();
    expect(await changeSetsOf(mine, me.id)).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({
          title: made.moduleTitle,
          state: 'draft',
        }),
      }),
    ]);

    const editor = page.getByRole('textbox', {
      name: `Module ${made.moduleTitle}`,
    });
    await editor.getByText('Charge the battery before first use.').click();
    await expect(edit).toBeVisible();
    await page.keyboard.press('End');
    await page.keyboard.type(' Then unplug it.');

    // Saved: where the change went, at the revision picker, naming the revision. The caret stays
    // in the text, and the card keeps off the sentence just changed.
    const revision = tour(page, 'Your own revision');
    await expect(revision).toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: /^Saved/ }),
    ).toBeVisible();
    await expect(stepOf(page)).toHaveText('4 of 5');
    await expect(revision).toContainText(
      `Your change is in “${made.moduleTitle}”, a revision of your own.`,
    );
    await expect(editor).toBeFocused();
    await expectClearOf(
      revision,
      editor.getByText('Then unplug it.', { exact: false }),
    );
    await expect(
      page.getByRole('button', { name: `Revision: ${made.moduleTitle}` }),
    ).toBeVisible();
    await revision.getByRole('button', { name: 'Next' }).click();

    // On to Review.
    const review = tour(page, 'Send it for review');
    await expect(review).toBeVisible();
    await expect(stepOf(page)).toHaveText('5 of 5');
    await expectBeside(page, review, 'nav.review');
    await expect(
      review.getByRole('link', { name: /^Read “Your first edit”/ }),
    ).toHaveAttribute('target', '_blank');

    const done = saved(page);
    await review.getByRole('button', { name: 'Done' }).click();
    await done;
    await expect(page.locator('[data-slot="tip"]')).toHaveCount(0);
    await expect(
      page.getByText(/That’s the tour\. Press Ctrl\+K any time/),
    ).toBeVisible();
    expect((await stored(mine)).tourDone).toBe(true);
  });

  test('a presenter gives the tour twice in one session, from the keyboard: the same steps, one revision (#869)', async ({
    page,
    api,
  }) => {
    // Two whole tours in one flow.
    test.slow();
    const admin = await api(USERS.admin);
    const made = await ownModule(api);
    const me = await ownAuthor(admin);
    const mine = await api(me.id);
    await signIn(page, me.id);
    const editor = page.getByRole('textbox', {
      name: `Module ${made.moduleTitle}`,
    });

    /** One run of the tour from its welcome: the titles of its steps, in order. */
    const give = async (typed: string, welcome = true): Promise<string[]> => {
      const seen: string[] = welcome ? [] : [WELCOME];
      const step = async (title: string, count: string) => {
        const card = tour(page, title);
        await expect(card).toBeVisible();
        await expect(stepOf(page)).toHaveText(count);
        seen.push(title);
        return card;
      };
      if (welcome) {
        await step(WELCOME, '1 of 5');
        // → from the card: its main button.
        await page.keyboard.press('ArrowRight');
      }
      await step('Open a module', '2 of 5');
      const row = page.getByRole('link', { name: made.moduleTitle });
      await expect(row).toBeVisible({ timeout: 30_000 });
      await openToEdit(page, row);
      await step('Change a sentence', '3 of 5');
      await editor.getByText('Charge the battery before first use.').click();
      await page.keyboard.press('End');
      await page.keyboard.type(typed);
      const revision = await step('Your own revision', '4 of 5');
      await expect(revision).toContainText(`“${made.moduleTitle}”`);
      // The caret is in the text: → moves it there, not the tour.
      await page.keyboard.press('ArrowRight');
      await expect(revision).toBeVisible();
      await revision.getByRole('button', { name: 'Next' }).click();
      await step('Send it for review', '5 of 5');
      // ← and → from the card: back a step and on again.
      await page.keyboard.press('ArrowLeft');
      await step('Your own revision', '4 of 5');
      await page.keyboard.press('ArrowRight');
      const review = await step('Send it for review', '5 of 5');
      const done = saved(page);
      await page.keyboard.press('ArrowRight');
      await done;
      await expect(review).toBeHidden();
      await expect(page.getByText(/That’s the tour\./)).toBeVisible();
      return seen.filter((title, i) => seen.indexOf(title) === i);
    };

    await page.goto(`/content?q=${made.module.moduleId}`);
    const first = await give(' Then unplug it.');
    expect(await changeSetsOf(mine, me.id)).toHaveLength(1);

    // Between the two: back on the published content, on another screen.
    await page.getByRole('button', { name: /^Revision:/ }).click();
    await page.getByRole('option', { name: 'Published content' }).click();
    await expect(
      page.getByRole('button', { name: 'Revision: Published content' }),
    ).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Review' })
      .click();
    await expect(page).toHaveURL(/\/review/);

    // Take the tour again, from the account menu, on this screen: it starts over at the welcome
    // and goes back to the list for its second step.
    await openAccountMenu(page, me.name);
    await page.getByRole('menuitem', { name: 'Take the tour' }).click();
    await expect(tour(page, WELCOME)).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page).toHaveURL(/\/content/);
    // The presenter finds the module in the list; the tour is still at its step.
    await page.goto(`/content?q=${made.module.moduleId}`);
    const second = await give(' Keep it dry.', false);

    // The same steps, and the tour went on in its revision rather than starting another.
    expect(second).toEqual(first);
    const sets = await changeSetsOf(mine, me.id);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.attributes.title).toBe(made.moduleTitle);
  });

  test('leaving the path pauses the tour; it resumes at the same step, after a reload too (#869)', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const me = await ownAuthor(admin);
    await signIn(page, me.id);
    await page.goto('/content');
    await tour(page, WELCOME)
      .getByRole('button', { name: 'Show me how' })
      .click();
    const open = tour(page, 'Open a module');
    await expect(open).toBeVisible();

    // The palette: paused while it is open, back at the same step once it closes.
    await page.keyboard.press('Control+k');
    const palette = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('combobox') });
    await expect(palette).toBeVisible();
    await expect(open).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    await expect(open).toBeVisible();

    // A click elsewhere on the page: paused, then back.
    await page.getByRole('heading', { level: 1 }).click();
    await expect(open).toBeHidden();
    await expect(open).toBeVisible();

    // Another screen without the list: nothing; back on the list: the same step.
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Manuals' })
      .click();
    await expect(page).toHaveURL(/\/manuals/);
    await expect(open).toBeHidden();
    await page.waitForTimeout(2500);
    await expect(page.locator('[data-slot="tip"]')).toHaveCount(0);
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Content' })
      .click();
    await expect(open).toBeVisible();
    await expect(stepOf(page)).toHaveText('2 of 5');

    await page.reload();
    await expect(open).toBeVisible();
    await expect(page.getByRole('dialog', { name: WELCOME })).toHaveCount(0);
    expect((await stored(await api(me.id))).tourDone).toBe(false);
  });

  test('a reader gets the reading tour, and no revision is made for them (#869)', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const made = await ownModule(api);
    const me = await ownAuthor(admin, 'reader');
    const mine = await api(me.id);
    await signIn(page, me.id);
    await page.goto(`/content?q=${made.module.moduleId}`);

    const welcome = tour(page, WELCOME);
    await expect(welcome).toBeVisible();
    await expect(stepOf(page)).toHaveText('1 of 3');
    await welcome.getByRole('button', { name: 'Show me how' }).click();
    const open = tour(page, 'Open a module');
    await expect(open).toContainText('Open one to read it.');
    await open.getByRole('button', { name: 'Open this module' }).click();

    const manuals = tour(page, 'Find the manuals');
    await expect(manuals).toBeVisible();
    await expect(stepOf(page)).toHaveText('3 of 3');
    await expectBeside(page, manuals, 'nav.manuals');
    await expect(page.getByText('Read-only', { exact: true })).toBeVisible();
    expect(await changeSetsOf(mine, me.id)).toEqual([]);

    const done = saved(page);
    await manuals.getByRole('button', { name: 'Done' }).click();
    await done;
    expect((await stored(mine)).tourDone).toBe(true);
    expect(await changeSetsOf(mine, me.id)).toEqual([]);
  });

  test('a reader who may read drafts is shown the revision picker: the published content, or a revision in progress (#869)', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const made = await ownModule(api);
    const me = await ownAuthor(admin, 'reviewer');
    await signIn(page, me.id);
    await page.goto(`/content?q=${made.module.moduleId}`);

    await expect(tour(page, WELCOME)).toBeVisible();
    await expect(stepOf(page)).toHaveText('1 of 4');
    await page.keyboard.press('ArrowRight');
    const open = tour(page, 'Open a module');
    await expect(open).toBeVisible();
    await open.getByRole('button', { name: 'Open this module' }).click();

    const picker = tour(page, 'Published content and revisions');
    await expect(picker).toBeVisible();
    await expect(stepOf(page)).toHaveText('3 of 4');
    await expect(picker).toContainText(
      'Choose a revision here to read changes still in progress.',
    );
    await expectBeside(page, picker, 'shell.change-set');
    await picker.getByRole('button', { name: 'Next' }).click();
    await expect(tour(page, 'Find the manuals')).toBeVisible();
    await expect(stepOf(page)).toHaveText('4 of 4');
    expect(await changeSetsOf(await api(me.id), me.id)).toEqual([]);
  });

  test('the tour points at what it explains: spotlight, arrow, never over its anchor (#868)', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const me = await ownAuthor(admin);
    await signIn(page, me.id);
    await page.goto('/content');

    // The welcome is centred: the whole page dimmed, no arrow.
    const welcome = tour(page, WELCOME);
    await expect(welcome).toBeVisible();
    const spotlight = page.locator('[data-slot="tip-spotlight"]');
    await expect(spotlight).toHaveAttribute('data-open', '');
    await expect(spotlight).toHaveAttribute('data-empty', '');
    await expect(welcome.locator('[data-slot="tip-arrow"]')).toHaveCount(0);
    // Focused without a ring: the card itself has no outline.
    await expect(welcome).toBeFocused();
    await expect(welcome).toHaveCSS('outline-style', 'none');

    // The step's anchor is lit, the page around it dimmed, and the card points at it.
    await welcome.getByRole('button', { name: 'Show me how' }).click();
    const open = tour(page, 'Open a module');
    await expect(open).toBeVisible();
    await expect(spotlight).not.toHaveAttribute('data-empty', '');
    await expect(open.locator('[data-slot="tip-arrow"]')).toHaveAttribute(
      'data-side',
      'top',
    );
    await expectBeside(page, open, 'content.module');
    // It covers no primary action: New module stays clear.
    const [card, button] = await Promise.all([
      open.boundingBox(),
      page.locator('[data-tip="content.new-module"]').boundingBox(),
    ]);
    expect(card!.y).toBeGreaterThan(button!.y + button!.height);

    // Tab goes round the card's own controls.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      await expect(
        page.locator('[data-slot="tip"]').locator(':focus'),
      ).toHaveCount(1);
    }

    // Escape from outside the card ends the tour for good.
    await page.locator('main').focus();
    await expect(open).toBeVisible();
    const ended = saved(page);
    await page.keyboard.press('Escape');
    await ended;
    await expect(page.locator('[data-slot="tip"]')).toHaveCount(0);
    await expect(spotlight).toHaveCount(0);
    expect((await stored(await api(me.id))).tourDone).toBe(true);
  });

  test('the "Open a module" card stays beside its row when the page moves the row under it (#903)', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const made = await ownModule(api);
    const me = await ownAuthor(admin);
    await startAt(page, me.id, 'tour.open-module');
    await signIn(page, me.id);
    await page.goto(`/content?q=${made.module.moduleId}`);

    const open = tour(page, 'Open a module');
    await expect(open).toBeVisible();
    await expectBeside(page, open, 'content.module');
    // The list keeps its search: the step waited for the row there.
    expect(new URL(page.url()).searchParams.get('q')).toBe(
      made.module.moduleId,
    );

    // The layout moves the row, with no scroll and no resize: something drawn above the list,
    // then the row sliding the way a list's rows do as it changes.
    const row = page.locator('[data-tip="content.module"]:visible').first();
    const before = (await row.boundingBox())!;
    await page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.style.height = '72px';
      document.querySelector('of-list-frame')!.before(spacer);
      document
        .querySelector<HTMLElement>('[data-tip="content.module"]')!
        .style.setProperty('translate', '0 24px');
    });
    await expect
      .poll(async () => (await row.boundingBox())!.y)
      .toBeGreaterThan(before.y + 48);
    await expect(async () => {
      await expectBeside(page, open, 'content.module');
    }).toPass({ timeout: 5_000 });
  });

  test('the tour follows a resize: the menu button on a phone, never off screen; × gives the focus back (#868)', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const me = await ownAuthor(admin);
    await page.setViewportSize({ width: 1280, height: 860 });
    await signIn(page, me.id);
    await startAt(page, me.id, 'tour.review');
    await page.goto('/content');
    // Where the focus is when the tour comes: it goes back there when the tour ends.
    const bell = page.getByRole('button', { name: /^Notifications/ });
    await bell.focus();

    const review = tour(page, 'Send it for review');
    await expect(review).toBeVisible();
    await expectBeside(page, review, 'nav.review');

    // A phone: the sidebar is a closed drawer, so the step points at its menu button.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(async () => {
      await expectBeside(page, review, 'shell.menu');
      await expectOnScreen(page, review);
    }).toPass();
    // Wide again: back beside Review.
    await page.setViewportSize({ width: 1280, height: 860 });
    await expect(async () => {
      await expectBeside(page, review, 'nav.review');
      await expectOnScreen(page, review);
    }).toPass();

    const ended = saved(page);
    await review.getByRole('button', { name: 'End the tour' }).click();
    await ended;
    await expect(page.locator('[data-slot="tip"]')).toHaveCount(0);
    await expect(bell).toBeFocused();
    expect((await stored(await api(me.id))).tourDone).toBe(true);
  });

  test('Take the tour leaves tips off (#868)', async ({ page, api }) => {
    const admin = await api(USERS.admin);
    const me = await ownAuthor(admin);
    const mine = await api(me.id);
    await mine.json(
      mine.send('PATCH', '/me/preferences', {
        data: {
          type: 'Preferences',
          attributes: { tourDone: true, showTips: false },
        },
      }),
    );
    await signIn(page, me.id);
    await page.goto('/content');
    await openAccountMenu(page, me.name);
    const restarted = saved(page);
    await page.getByRole('menuitem', { name: 'Take the tour' }).click();
    await restarted;
    await expect(tour(page, WELCOME)).toBeVisible();
    expect(await stored(mine)).toMatchObject({
      tourDone: false,
      showTips: false,
    });
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
    const first = tour(page, WELCOME);
    await expect(first).toBeVisible();
    await first.getByRole('button', { name: 'End the tour' }).click();
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

// The variant block's tip (#892): shown where the idea is in use, in every layout of the module
// editor, once, and again after Reset tips.
test.describe('the variant block tip @area:shell @area:module-editor @area:doc-editor @api:preferences @api:change-sets', () => {
  const TITLE = 'Only for some products?';

  /**
   * A person who finished the tour and closed the preview tip (it comes first in the module
   * editor), with a revision holding a module whose second block is a variant block.
   */
  async function writerWithVariantBlock(api: (user: UserId) => Promise<Api>) {
    const me = await ownAuthor(await api(USERS.admin));
    const mine = await api(me.id);
    await mine.json(
      mine.send('PATCH', '/me/preferences', {
        data: {
          type: 'Preferences',
          attributes: {
            tourDone: true,
            dismissedTips: ['module-editor.preview'],
          },
        },
      }),
    );
    const changeSet = await mine.createChangeSet(unique('Variant tip'));
    const id = moduleId();
    await mine.createModule(changeSet, {
      lang: 'en',
      moduleId: id,
      title: 'Two models',
      blocks: [
        paragraph('intro', 'Read this first.'),
        {
          type: 'variant',
          id: 'large',
          when: { op: 'in', attr: 'model', values: ['large'] },
          blocks: [paragraph('only', 'Large models only.')],
        },
        paragraph('outro', 'The end.'),
      ],
    });
    return { me, mine, url: `/content/en/${id}?cs=${changeSet.id}` };
  }

  test('points at the variant block once; Got it keeps it away, Reset tips brings it back', async ({
    page,
    api,
  }) => {
    const { me, mine, url } = await writerWithVariantBlock(api);
    await signIn(page, me.id);
    await page.goto(url);

    const tip = page.getByRole('dialog', { name: TITLE });
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('Put the text in a variant block');
    await expectBeside(page, tip, 'module-editor.variant');
    await expect(tip.getByRole('link', { name: /^Learn more:/ })).toBeVisible();

    const done = saved(page);
    await tip.getByRole('button', { name: 'Got it' }).click();
    await done;
    await expect(tip).toBeHidden();
    expect((await stored(mine)).dismissedTips).toContain(
      'module-editor.variant',
    );

    // Gone for good: not after a reload, however long the screen takes to settle.
    await page.reload();
    await expect(
      page.getByRole('textbox', { name: 'Module Two models' }),
    ).toContainText('Read this first.');
    await page.waitForTimeout(2500);
    await expect(tip).toHaveCount(0);

    await openAccountMenu(page, me.name);
    const reset = saved(page);
    await page.getByRole('menuitem', { name: 'Reset tips' }).click();
    await reset;
    // Reset shows every tip again, the preview's first; the variant tip follows on the next visit.
    await page.reload();
    await page.getByRole('button', { name: 'Got it' }).click();
    await page.goto(url);
    await expect(tip).toBeVisible();
  });

  for (const [width, height, label] of [
    [1920, 1080, 'wide, three columns'],
    [1280, 720, 'two columns'],
    [1024, 576, 'stacked, 125% of 1280'],
    [1440, 900, 'the usual laptop'],
    [1024, 768, 'stacked'],
    [390, 844, 'a phone'],
  ] as const) {
    test(`stays beside the block's header at ${width}x${height} (${label})`, async ({
      page,
      api,
    }) => {
      const { me, url } = await writerWithVariantBlock(api);
      await page.setViewportSize({ width, height });
      await signIn(page, me.id);
      await page.goto(url);
      const tip = page.getByRole('dialog', { name: TITLE });
      await expect(tip).toBeVisible();
      await expectBeside(page, tip, 'module-editor.variant');
      // Never over what it explains: clear of the whole block, its text included.
      const block = (await page
        .locator('[data-node="variant"]')
        .first()
        .boundingBox())!;
      const card = (await tip.boundingBox())!;
      expect(
        card.y >= block.y + block.height - 1 ||
          card.y + card.height <= block.y + 1 ||
          card.x >= block.x + block.width ||
          card.x + card.width <= block.x,
        'the card is clear of the variant block',
      ).toBe(true);
      const box = (await tip.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
    });
  }

  test('a person who may only read sees no variant tip', async ({
    page,
    api,
  }) => {
    // On main, where a reader can open it.
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Variant tip main'));
    const id = moduleId();
    await author.createModule(changeSet, {
      lang: 'en',
      moduleId: id,
      title: 'Two models',
      blocks: [
        paragraph('intro', 'Read this first.'),
        {
          type: 'variant',
          id: 'large',
          when: { op: 'in', attr: 'model', values: ['large'] },
          blocks: [paragraph('only', 'Large models only.')],
        },
      ],
    });
    await author.transition(changeSet.id, 'submit', 'Ready for review.');
    await (await api(USERS.reviewer)).transition(changeSet.id, 'approve');
    await (await api(USERS.publisher)).transition(changeSet.id, 'merge');
    const url = `/content/en/${id}`;
    const admin = await api(USERS.admin);
    const reader = await ownAuthor(admin, 'reviewer');
    const mine = await api(reader.id);
    await mine.json(
      mine.send('PATCH', '/me/preferences', {
        data: {
          type: 'Preferences',
          attributes: {
            tourDone: true,
            dismissedTips: ['module-editor.preview'],
          },
        },
      }),
    );
    await signIn(page, reader.id);
    await page.goto(url);
    await expect(
      page.getByRole('textbox', { name: 'Module Two models' }),
    ).toContainText('Large models only.');
    await page.waitForTimeout(2500);
    await expect(page.getByRole('dialog', { name: TITLE })).toHaveCount(0);
  });
});
