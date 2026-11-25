import type { Page } from '@playwright/test';
import {
  expect,
  MODULE_ID,
  openModule,
  paragraph,
  revisionWithModule,
  signIn,
  test,
  TEXT,
  USERS,
} from './fixtures.ts';

// The guide's first screens (#447): content, revisions, the module editor, manuals, checks and
// submitting for review. The other areas have files of their own (`<area>.shots.ts`), on the
// shared fixtures (`fixtures.ts`).

/**
 * The person's tip preferences as the page reads them (#222), in place of the fixture's "tips
 * off": a stub in the page, so no shot writes them.
 */
async function preferences(
  page: Page,
  attributes: { showTips: boolean; tourDone: boolean },
): Promise<void> {
  await page.context().unroute('**/api/me/preferences');
  await page.context().route('**/api/me/preferences', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.api+json',
      body: JSON.stringify({
        data: {
          type: 'Preferences',
          id: 'shots',
          attributes: { dismissedTips: [], ...attributes },
          meta: { updatedAt: null },
        },
      }),
    }),
  );
}

/**
 * The tour starts at `step` in this tab on the next loads (#869), as after a reload mid-tour; a
 * later call wins, its script running last.
 */
async function atTourStep(page: Page, person: string, step: string) {
  await page.addInitScript(
    ([key, value]) => sessionStorage.setItem(key!, value!),
    [`openfolia.tour:${person}`, step],
  );
}

test.describe('the user guide', () => {
  test('content and revisions', async ({ page, save, text, l }) => {
    await signIn(page, USERS.author);
    await page.goto('/content');
    await expect(page.getByRole('row').nth(3)).toBeVisible();
    await save('content-browser');
    await page
      .getByRole('button', { name: /^(Revision|Überarbeitung):/ })
      .click();
    await expect(
      page.getByRole('option', { name: l('changeSet.start') }),
    ).toBeVisible();
    await save('revision-menu');
    await page.getByRole('option', { name: l('changeSet.start') }).click();
    const dialog = page.getByRole('dialog', {
      name: l('changeSet.startTitle'),
    });
    await dialog.getByLabel(l('changeSet.titleField')).fill(text.revision);
    await save('revision-new');
  });

  test('search palette', async ({ page, save, text, l }) => {
    await signIn(page, USERS.author);
    await page.goto('/content');
    await expect(page.getByRole('row').nth(3)).toBeVisible();
    // The browser reports a non-Apple platform: Ctrl+K.
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog');
    await palette
      .getByRole('combobox', {
        name: l('search.placeholder').replace(/…$/, ''),
      })
      .fill(text.search);
    await expect(palette.getByRole('option').first()).toBeVisible();
    await save('search-palette');
  });

  test('account menu', async ({ page, save }) => {
    await signIn(page, USERS.author);
    await page.goto('/content');
    await page
      .getByRole('button', { name: /^(Account: |Konto: )?Sample Author$/ })
      .click();
    await expect(page.getByRole('menu')).toBeVisible();
    await save('account-menu');
  });

  test('tour and tips', async ({ page, save, l, lang, text, as }) => {
    await preferences(page, { showTips: true, tourDone: false });
    await signIn(page, USERS.author);
    // The tour's second step, Open a module (#869): this tab kept it, as after Show me how.
    await atTourStep(page, USERS.author, 'tour.open-module');
    await page.goto('/content');
    await expect(page.getByRole('row').nth(3)).toBeVisible();
    await expect(
      page.getByRole('dialog', { name: l('tour.openModule.title') }),
    ).toBeVisible();
    await save('tour');

    // Change a sentence, in a revision of the author's with the module open.
    const revision = await revisionWithModule(
      await as(USERS.author),
      lang,
      text.revision,
    );
    await atTourStep(page, USERS.author, 'tour.edit');
    await openModule(
      page,
      `/content/${lang}/${MODULE_ID}?cs=${revision.id}`,
      text.module,
    );
    await expect(
      page.getByRole('dialog', { name: l('tour.edit.title') }),
    ).toBeVisible();
    await save('tour-edit');

    await preferences(page, { showTips: true, tourDone: true });
    await page.goto('/content');
    await expect(page.getByRole('row').nth(3)).toBeVisible();
    await expect(
      page.getByRole('dialog', { name: l('tips.newModule.title') }),
    ).toBeVisible();
    await save('tip');
  });

  test('new module', async ({ page, save, text, l, as }) => {
    await signIn(page, USERS.admin);
    const revision = await (
      await as(USERS.admin)
    ).createChangeSet(text.revision);
    await page.goto(`/content?cs=${revision.id}`);
    await page.getByRole('button', { name: l('content.new.open') }).click();
    const dialog = page.getByRole('dialog', { name: l('content.new.title') });
    await dialog.getByLabel(l('content.new.titleField')).fill(text.newModule);
    await save('new-module');
  });

  test('module editor', async ({ page, save, lang, text, l, as }) => {
    const revision = await revisionWithModule(
      await as(USERS.admin),
      lang,
      text.revision,
    );
    await signIn(page, USERS.admin);
    await openModule(
      page,
      `/content/${lang}/${MODULE_ID}?cs=${revision.id}`,
      text.module,
    );
    await save('module-editor');

    await page.getByTestId('insert-menu').click();
    await expect(
      page.getByRole('dialog', { name: l('docEditor.insert.label') }),
    ).toBeVisible();
    await save('insert-menu');
    await page.keyboard.press('Escape');

    // The block actions menu of the intro, from its grip.
    const editor = page.getByRole('textbox', {
      name: new RegExp(text.module),
    });
    await editor.getByText(text.intro).hover();
    await page.getByTestId('block-grip').first().click();
    await expect(page.getByRole('menu')).toBeVisible();
    await save('block-menu');
    await page.keyboard.press('Escape');

    // The variant block's conditions.
    await page
      .getByRole('button', { name: l('docEditor.variant.change') })
      .click();
    await expect(
      page.getByRole('dialog', { name: l('variantPicker.title') }),
    ).toBeVisible();
    await save('variant-picker');
    await page.keyboard.press('Escape');
    // Closed, and the focus back on its button: a click before that loses the caret to it.
    await expect(
      page.getByRole('dialog', { name: l('variantPicker.title') }),
    ).toBeHidden();
    await expect(
      page.getByRole('button', { name: l('docEditor.variant.change') }),
    ).toBeFocused();

    // The slash menu, in a new empty paragraph after the intro.
    await editor.getByText(text.intro).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/');
    await expect(page.getByRole('listbox')).toBeVisible();
    await save('slash-menu');
  });

  test('module preview', async ({ page, save, lang, text, as }) => {
    const revision = await revisionWithModule(
      await as(USERS.admin),
      lang,
      text.revision,
    );
    await signIn(page, USERS.admin);
    await openModule(
      page,
      `/content/${lang}/${MODULE_ID}?cs=${revision.id}&preview=open`,
      text.module,
    );
    await expect(page.locator('iframe').first()).toBeVisible();
    await page.waitForTimeout(1500);
    await save('module-preview');
  });

  test('module locked elsewhere', async ({ page, save, text, l, as }) => {
    const author = await as(USERS.author);
    const theirs = await author.createChangeSet(text.other);
    await author.lock(theirs.id, {
      type: 'module',
      lang: 'en',
      moduleId: 'charging',
    });
    const mine = await (await as(USERS.admin)).createChangeSet(text.revision);
    await signIn(page, USERS.admin);
    await page.goto(`/content/en/charging?cs=${mine.id}`);
    await expect(
      page.getByRole('dialog', { name: l('moduleLock.title') }),
    ).toBeVisible();
    await save('module-locked');
  });

  test('manual builder', async ({ page, save, lang, text, l, as }) => {
    const revision = await revisionWithModule(
      await as(USERS.admin),
      lang,
      text.revision,
    );
    await signIn(page, USERS.admin);
    await page.goto(`/manuals?manual=operating&cs=${revision.id}`);
    await expect(
      page.getByRole('tree').getByRole('treeitem').first(),
    ).toBeVisible();
    await save('manual-builder');
    await page.getByRole('button', { name: l('manuals.add.open') }).click();
    await expect(page.getByRole('option').first()).toBeVisible();
    await save('manual-add-module');
  });

  test('safety leaflet', async ({ page, save, text, l, as }) => {
    const revision = await (
      await as(USERS.admin)
    ).createChangeSet(text.revision);
    await signIn(page, USERS.admin);
    await page.goto(`/manuals?manual=safety-leaflet&cs=${revision.id}`);
    await expect(
      page.getByRole('tree').getByRole('treeitem').first(),
    ).toBeVisible();
    await save('safety-leaflet');
    await page.getByTestId('manual-switcher').click();
    await page.getByTestId('manual-new').click();
    const dialog = page.getByRole('dialog', { name: l('manuals.new.title') });
    await dialog.getByLabel(l('manuals.new.titleField')).fill(text.leaflet);
    await dialog.getByRole('radio', { name: l('manuals.new.derived') }).click();
    await expect(dialog.getByTestId('new-manual-derived')).toBeVisible();
    await save('new-derived-manual');
  });

  test('checks', async ({ page, save, lang, text, as }) => {
    const revision = await revisionWithModule(
      await as(USERS.admin),
      lang,
      text.revision,
    );
    await signIn(page, USERS.admin);
    await page.goto(`/checks?manual=operating&cs=${revision.id}`);
    await expect(page.getByRole('row').nth(2)).toBeVisible();
    await save('checks');
  });

  test('submit for review', async ({ page, save, lang, text, as }) => {
    const revision = await revisionWithModule(
      await as(USERS.author),
      lang,
      text.revision,
    );
    await signIn(page, USERS.author);
    await page.goto(`/review?cs=${revision.id}`);
    await expect(page.getByText(text.module).first()).toBeVisible();
    await save('review-submit');
  });

  // Last: it merges a change into main (a paragraph of the sample's `internals`), which every
  // later shot then reads.
  test('update from main', async ({ page, save, lang, text, l, as }) => {
    const admin = await as(USERS.admin);
    const revision = await revisionWithModule(admin, lang, text.revision);
    const author = await as(USERS.author);
    const change = await author.createChangeSet(text.other);
    await author.editModule(
      change.id,
      { lang: 'en', moduleId: 'internals' },
      (module) => ({
        ...module,
        blocks: [
          ...module.blocks,
          paragraph(`housing-${lang}`, TEXT.en.mainChange),
        ],
      }),
    );
    await author.transition(change.id, 'submit');
    await (await as(USERS.reviewer)).transition(change.id, 'approve');
    await (await as(USERS.publisher)).transition(change.id, 'merge');

    await signIn(page, USERS.admin);
    await openModule(
      page,
      `/content/${lang}/${MODULE_ID}?cs=${revision.id}`,
      text.module,
    );
    await expect(
      page.getByRole('button', {
        name: new RegExp(
          `^${l('changeSet.update.action', { ref: 'main' }).split(' (')[0]}`,
        ),
      }),
    ).toBeVisible();
    await save('update-from-main');
  });
});
