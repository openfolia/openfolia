import type { Page } from '@playwright/test';
import {
  changeSetWithModule,
  moduleId,
  paragraph,
  unique,
} from '../src/api.ts';
import {
  chooseSegment,
  expect,
  expectPageFits,
  expectWheelStaysInside,
  signIn,
  switchUser,
  test,
  USERS,
} from '../src/fixtures.ts';

// The review screen (`/review`): the diff views, block comments, approve and merge by role.
test.describe('review @area:review @api:change-sets @api:comments', () => {
  test('the diff view tabs switch the module view and the address, and back; Comment shows without hover (#452)', async ({
    page,
    api,
  }) => {
    // A manual and a module on main, both changed: the manual's diff comes first, as on the
    // owner's revision, and is drawn the same in every view; the module's is not.
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Diff views'));
    await author.editManual(
      changeSet.id,
      'operating',
      (manual) => ({ ...manual, title: `${manual['title']} (revised)` }),
      { savePoint: false },
    );
    await author.editModule(
      changeSet.id,
      { lang: 'en', moduleId: 'storage' },
      (content) => ({
        ...content,
        blocks: [
          ...content.blocks,
          paragraph('e2e-monthly', 'Check the battery monthly.'),
        ],
      }),
    );

    await signIn(page, USERS.admin);
    await page.goto(`/review?state=draft&cs=${changeSet.id}`);
    const changes = page.getByRole('region', { name: 'Changes' });
    const item = (title: RegExp) =>
      changes
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { level: 3, name: title }) });
    const module = item(/^Storage$/);
    const manual = item(/^Operating manual/);
    const added = module.getByText('Check the battery monthly.');
    const columns = module.getByText('Before', { exact: true });
    const frameTitle = 'The new version as readers see it';
    const sameNote = manual.getByText(/Drawn the same in every view/);

    await added.scrollIntoViewIfNeeded();
    await expect(added).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Inline' })).toBeChecked();
    await expect(columns).toHaveCount(0);
    await expect(sameNote).toHaveCount(0);
    // Comment on a changed block is there to see, not only on hover.
    await page.mouse.move(0, 0);
    const comment = module.getByRole('button', {
      name: 'Comment on this Paragraph',
    });
    await expect(comment).toBeVisible();
    await expect(comment).toHaveCSS('opacity', '1');

    await chooseSegment(page, 'Show the changes', 'Side by side');
    await expect(page).toHaveURL(/[?&]diff=side-by-side(&|$)/);
    await expect(
      page.getByRole('radio', { name: 'Side by side' }),
    ).toBeChecked();
    await columns.scrollIntoViewIfNeeded();
    await expect(columns).toBeVisible();
    await expect(sameNote).toBeVisible();

    await chooseSegment(page, 'Show the changes', 'Rendered');
    await expect(page).toHaveURL(/[?&]diff=rendered(&|$)/);
    await expect(page.getByRole('radio', { name: 'Rendered' })).toBeChecked();
    await expect(columns).toHaveCount(0);
    await expect(
      module
        .frameLocator(`iframe[title="${frameTitle}"]`)
        .getByText('Check the battery monthly.'),
    ).toBeVisible();
    await expect(sameNote).toBeVisible();

    await chooseSegment(page, 'Show the changes', 'Inline');
    await expect(page).not.toHaveURL(/[?&]diff=/);
    await expect(page.getByRole('radio', { name: 'Inline' })).toBeChecked();
    await expect(module.locator(`iframe[title="${frameTitle}"]`)).toHaveCount(
      0,
    );
    await expect(added).toBeVisible();
    await expect(sameNote).toHaveCount(0);
  });

  test('comment on a block of a draft, reply, resolve (#452: an admin can comment)', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await changeSetWithModule(author, unique('Comments'));

    await signIn(page, USERS.admin);
    await page.goto(`/review?state=draft&cs=${changeSet.id}`);
    const changes = page.getByRole('region', { name: 'Changes' });
    // The editor shows each write at once and sends it after (#493): every step waits for the
    // API's answer, not only for the text on screen, so no write is still on its way when the
    // next user acts or the test ends (its change set is abandoned then: a 409 for a late one).
    await changes
      .getByRole('button', { name: 'Comment on this Paragraph' })
      .first()
      .click();
    await changes
      .getByRole('textbox', { name: /^New comment/ })
      .fill('Which charger?');
    const posted = commentWrite(page, /\/comments$/, 201);
    await changes.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(changes.getByText('Which charger?')).toBeVisible();
    await posted;

    // The author answers.
    await switchUser(page, 'Sample Admin', 'Sample Author');
    await changes
      .getByRole('button', { name: /^Reply/ })
      .first()
      .click();
    await page
      .getByRole('textbox', { name: /reply/i })
      .last()
      .fill('The one in the box.');
    const replied = commentWrite(page, /\/comments$/, 201);
    await page
      .getByRole('button', { name: /^(Reply|Post|Send)$/ })
      .last()
      .click();
    await expect(changes.getByText('The one in the box.')).toBeVisible();
    await replied;

    const resolved = commentWrite(page, /\/comments\/[^/]+\/resolve$/, 200);
    await changes
      .getByRole('button', { name: /^Resolve/ })
      .first()
      .click();
    await expect(changes.getByText(/Resolved/).first()).toBeVisible();
    await resolved;
  });

  test('the author cannot approve their own revision; a reviewer approves, a publisher merges', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await changeSetWithModule(
      author,
      unique('Approve and merge'),
      {
        submit: true,
      },
    );

    await signIn(page, USERS.author);
    await page.goto(`/review?cs=${changeSet.id}`);
    await expect(
      page.getByRole('heading', { level: 2, name: /Approve and merge/ }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);

    await switchUser(page, 'Sample Author', 'Sample Reviewer');
    await page.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);

    await switchUser(page, 'Sample Reviewer', 'Sample Publisher');
    await page.getByRole('button', { name: /^Merge/ }).click();
    // The module is on main once the merge is through (the page's own word for it may already
    // be on screen as a label, so the API is asked).
    await expect
      .poll(
        async () =>
          (
            await author.get(`/modules/en/${changeSet.module.moduleId}`)
          ).status(),
        {
          timeout: 30_000,
        },
      )
      .toBe(200);
    await page.goto(`/content/en/${changeSet.module.moduleId}?cs=`);
    await expect(
      page.getByRole('heading', { level: 1, name: changeSet.moduleTitle }),
    ).toBeVisible();
  });

  test('a page design added in a revision is listed as a project file, labelled as one (#390)', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const title = unique('Page design');
    const changeSet = await author.createChangeSet(title);
    const designId = `look-${changeSet.id.slice(-8)}`;
    await author.createPageDesign(changeSet, {
      id: designId,
      name: 'Product line',
    });

    await signIn(page, USERS.author);
    await page.goto(`/review?cs=${changeSet.id}`);
    await expect(
      page.getByRole('heading', { level: 2, name: title }),
    ).toBeVisible();
    const item = page.locator(`[id="item-design/${designId}"]`);
    await expect(item).toBeVisible();
    await expect(item.getByText('Page design', { exact: true })).toBeVisible();
    await expect(item.getByText(designId).first()).toBeVisible();
  });
});

// A revision whose saves cancel out (#854): nothing differs from main, so the review has no
// view switch and no legend, only the empty state.
test.describe('review without changes @area:review @api:change-sets', () => {
  test('a revision that adds a configuration entry and removes it again shows the empty state alone (#854)', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const title = unique('Cancelled out');
    const changeSet = await admin.createChangeSet(title);
    const typeId = moduleId('e2e-cancel');
    // Another flow's revision may hold the configuration's lock a few seconds: try again.
    await expect(async () => {
      await admin.editConfig(changeSet.id, (config) => ({
        ...config,
        moduleTypes: [
          ...config.moduleTypes,
          { id: typeId, label: 'Cancelled', safety: false },
        ],
      }));
    }).toPass({ timeout: 30_000 });
    await admin.editConfig(changeSet.id, (config) => ({
      ...config,
      moduleTypes: config.moduleTypes.filter(
        (t: { id: string }) => t.id !== typeId,
      ),
    }));

    await signIn(page, USERS.admin);
    await page.goto(`/review?cs=${changeSet.id}`);
    const section = page.locator('section', {
      has: page.getByRole('heading', { level: 2, name: title }),
    });
    await expect(section.locator('[data-state="empty"]')).toContainText(
      'Nothing differs from main',
    );
    await expect(section.getByText('0 changed items')).toBeVisible();
    await expect(section.getByRole('radio', { name: 'Inline' })).toHaveCount(0);
    await expect(section.getByLabel('What the marks mean')).toHaveCount(0);
    await expect(section.getByLabel('Previous change')).toHaveCount(0);
  });
});

// The review screen's layout (#563): the change list scrolls inside its own frame, the page
// never scrolls into empty space below it, and the pagination stays in reach.
test.describe('review layout @area:review @api:change-sets @narrow', () => {
  test('the change list scrolls inside its frame in every view; the page stays put (#563)', async ({
    page,
    api,
  }, testInfo) => {
    const narrow = testInfo.project.name === 'narrow';
    // The size the issue was seen at; a phone keeps its own.
    if (!narrow) await page.setViewportSize({ width: 1400, height: 790 });
    // Five new modules of eight paragraphs: far more than the frame shows at once.
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Long revision'));
    for (let m = 1; m <= 5; m++) {
      await author.createModule(
        changeSet,
        {
          lang: 'en',
          moduleId: moduleId('e2e-scroll'),
          title: `Long module ${m}`,
          blocks: Array.from({ length: 8 }, (_, i) =>
            paragraph(
              `p${i + 1}`,
              `Paragraph ${i + 1} of module ${m}: check the drive unit-and-charger-connection-before-every-shift.`,
            ),
          ),
        },
        { savePoint: m === 5 },
      );
    }

    await signIn(page, USERS.admin);
    await page.goto(`/review?state=draft&cs=${changeSet.id}`);
    const changes = page.getByRole('region', { name: 'Changes' });
    const frame = page.locator('of-list-frame').filter({ has: changes });
    const pagination = frame.locator('[data-slot=list-pagination]');

    // Side by side is offered from a wider screen on.
    const views = narrow
      ? ['Inline', 'Rendered']
      : ['Inline', 'Side by side', 'Rendered'];
    for (const view of views) {
      if (view !== 'Inline')
        await chooseSegment(page, 'Show the changes', view);
      await expect(page.getByRole('radio', { name: view })).toBeChecked();
      await expect(
        view === 'Rendered'
          ? changes
              .locator('iframe')
              .first()
              .contentFrame()
              .getByText(/Paragraph 1 of module 1/)
          : changes.getByText(/Paragraph 1 of module 1/).first(),
      ).toBeVisible();

      await expectPageFits(page, { fits: !narrow });
      await expectWheelStaysInside(page, changes);
      await expectPageFits(page, { fits: !narrow });
      if (narrow) {
        // The header above takes most of a phone's height: the page scrolls it away, and no
        // further than the frame's end.
        await pagination.scrollIntoViewIfNeeded();
        await expectPageFits(page);
      }
      await expect(pagination).toBeInViewport({ ratio: 1 });
      await changes.evaluate((el) => el.scrollTo({ top: 0 }));
    }
  });
});

/** The API's answer to the page's next comment write whose path ends in `path`, checked to be `status`. */
async function commentWrite(
  page: Page,
  path: RegExp,
  status: number,
): Promise<void> {
  const answer = await page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/change-sets\/[^/]+\/comments/.test(response.url()) &&
      path.test(new URL(response.url()).pathname),
    // An answer under load, not an action: the navigation's patience.
    { timeout: 30_000 },
  );
  const body = await answer.text().catch(() => '');
  expect(answer.status(), body).toBe(status);
}
