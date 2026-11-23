import {
  expect,
  guideBlocks,
  MODULE_ID,
  signIn,
  TEXT,
  test,
  USERS,
  type Api,
} from './fixtures.ts';

// The guide's releases section (#680): the releases list, a release's page, the "New release"
// dialog, a file's stable address, withdrawing, maintenance lines, and Admin › Page design with
// the manual's cover image. Releases are tags, so cutting them changes nothing on main; the
// releases this file cuts are the same in both languages (made by the first run that needs them,
// found again by the next), so the list and the changes read alike in English and German.

/** The product version of the releases this file cuts. */
const VERSION = '2.0';

/** The release notes this file gives, in the source language and per language. */
const NOTES = {
  en: 'The battery instructions now cover the large model.',
  de: 'Die Batterieanleitung gilt jetzt auch für das große Modell.',
} as const;

/**
 * Release `VERSION` of `product`, cut by `api` unless it is there already (a retry, or the other
 * language's run), with notes in English and German; then every file rendered.
 */
async function release(api: Api, product: string): Promise<string> {
  const listed = await api.json<{
    data: { id: string; attributes: { revision: string } }[];
  }>(api.get(`/releases?filter[product]=${product}&page[size]=100`));
  let id = listed.data.find((r) => r.attributes.revision === VERSION)?.id;
  if (!id) {
    const made = await api.json<{ data: { id: string } }>(
      api.send('POST', '/releases', {
        data: {
          type: 'Release',
          attributes: {
            product,
            revision: VERSION,
            notes: NOTES.en,
            notesByLanguage: { de: NOTES.de },
          },
        },
      }),
      201,
    );
    id = made.data.id;
  }
  const releaseId = id;
  // The renderer is real: the files of a first release take a while.
  await expect
    .poll(
      async () =>
        (
          await api.json<{
            data: { meta: { outputs?: { state?: string } } };
          }>(api.get(`/releases/${releaseId}`))
        ).data.meta.outputs?.state,
      { timeout: 240_000, intervals: [2_000] },
    )
    .toMatch(/^(done|failed)$/);
  return releaseId;
}

test.describe('the user guide: releases', () => {
  test('releases list and a release', async ({ page, save, l, as }) => {
    test.setTimeout(360_000);
    const publisher = await as(USERS.publisher);
    const north = await release(publisher, 'north');
    await release(publisher, 'south');
    await signIn(page, USERS.publisher);

    await page.goto(`/releases?release=${north}`);
    const panel = page.locator('[data-slot="release-panel"]');
    await expect(panel).toBeVisible();
    // The files named by the manual's title and the variant's label, not their IDs (#691).
    await expect(panel.locator('li button').first()).toContainText(
      'Operating manual',
    );
    await expect(
      page.locator('[data-slot="release-row"] [data-progress="ready"]'),
    ).toHaveCount(2);
    await save('release-list');

    await page.goto(`/releases/${north}`);
    await expect(
      page.locator('[data-slot="files-progress"][data-progress="done"]'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: l('releases.files.archive.download') }),
    ).toBeVisible();
    await save('release-page');
  });

  test('new release', async ({ page, save, l, as }) => {
    await release(await as(USERS.publisher), 'north');
    await signIn(page, USERS.publisher);
    await page.goto('/releases');
    await page.getByRole('button', { name: l('releases.new') }).click();
    const dialog = page.getByRole('dialog', {
      name: l('releases.create.title'),
    });
    await dialog
      .getByRole('combobox', {
        name: new RegExp(`^${l('releases.create.product.label')}`),
      })
      .click();
    await page.getByRole('option', { name: 'North' }).click();
    await dialog
      .getByRole('textbox', { name: l('releases.create.revision.label') })
      .fill('2.1');
    await expect(dialog.locator('[data-slot="commit"]')).toContainText(
      /[0-9a-f]{7}/,
    );
    await save('release-new');

    await dialog
      .getByRole('button', { name: l('releases.create.next') })
      .click();
    await expect(
      dialog.locator('[data-slot="manual-checks"]').first(),
    ).toBeVisible();
    await save('release-new-checks');
  });

  test('stable address and withdrawing', async ({ page, save, l, as }) => {
    const north = await release(await as(USERS.publisher), 'north');
    await signIn(page, USERS.publisher);
    await page.goto(`/releases/${north}`);
    await page
      .locator('[data-state-file]')
      .filter({ hasText: /Small · (English|Englisch)/ })
      .first()
      .locator('[data-slot="file-address"]')
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('[data-slot="address-qr"]')).toBeVisible();
    await save('release-address');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // The dialog only: the release is not withdrawn.
    await page
      .getByRole('button', { name: l('releases.withdraw.action') })
      .click();
    const withdraw = page.getByRole('dialog');
    await withdraw
      .getByRole('textbox', { name: l('releases.withdraw.reason') })
      .fill(
        l('releases.withdraw.reason') === 'Reason'
          ? 'The charging times in this release are wrong. Use release 2.1.'
          : 'Die Ladezeiten in dieser Veröffentlichung sind falsch. Verwenden Sie Release 2.1.',
      );
    await save('release-withdraw');
  });

  test('page designs', async ({ page, save, text, as }) => {
    test.setTimeout(180_000);
    const admin = await as(USERS.admin);
    const revision = await admin.createChangeSet(text.revision);
    await signIn(page, USERS.admin);
    await page.goto(`/admin/page-designs?cs=${revision.id}`);
    await expect(page.getByRole('link', { name: /Classic/ })).toBeVisible();
    await save('page-design-list');

    await page.goto(`/admin/page-designs/classic?cs=${revision.id}`);
    const preview = page.locator('[data-slot="design-preview-pages"]');
    await expect(preview.locator('img')).toHaveCount(2, { timeout: 60_000 });
    await expect
      .poll(() =>
        preview
          .locator('img')
          .evaluateAll((imgs) =>
            imgs.every((img) => (img as HTMLImageElement).naturalWidth > 0),
          ),
      )
      .toBe(true);
    await save('page-design-editor');

    // The region editor at the top of the window, the preview beside it.
    await page
      .locator('[data-section="regions"]')
      .evaluate((section) => section.scrollIntoView({ block: 'start' }));
    await save('page-design-regions');

    const fonts = page.locator('[data-section="fonts"]');
    await fonts.scrollIntoViewIfNeeded();
    await save('page-design-fonts', fonts);
  });

  test('back page and manufacturer', async ({ page, save, text, as }) => {
    test.setTimeout(120_000);
    const admin = await as(USERS.admin);
    const revision = await admin.createChangeSet(text.revision);
    // The manufacturer in the revision's configuration, so the back page has them to show.
    await admin.editConfig(revision.id, (config) => ({
      ...config,
      manufacturer: {
        name: 'Example Works Ltd',
        address: ['1 Sample Street', '12345 Sample Town'],
        contact: 'info@example.com',
        website: 'https://example.com',
      },
      release: { ...config.release, checkManufacturer: true },
    }));
    await signIn(page, USERS.admin);
    await page.goto(`/admin/settings/manufacturer?cs=${revision.id}`);
    await expect(
      page.locator('[data-slot="manufacturer"] [data-field="name"]'),
    ).toHaveValue('Example Works Ltd');
    await save('settings-manufacturer');

    await page.goto(`/admin/page-designs/classic?cs=${revision.id}`);
    const back = page.locator('[data-section="back-page"]');
    await expect(back.locator('[data-slot="manufacturer-name"]')).toHaveText(
      'Example Works Ltd',
    );
    await back.scrollIntoViewIfNeeded();
    await save('page-design-back-page', back);
  });

  test('cover image', async ({ page, save, text, as }) => {
    const revision = await (
      await as(USERS.admin)
    ).createChangeSet(text.revision);
    await signIn(page, USERS.admin);
    await page.goto(`/manuals?manual=operating&cs=${revision.id}`);
    await page.getByTestId('settings-open').click();
    const cover = page.getByTestId('settings-cover');
    await cover.scrollIntoViewIfNeeded();
    await expect(cover).toBeVisible();
    await save('page-design-cover-image', cover);
  });

  // Last: a maintenance line is a branch of its own (never main), closed again after the shot so
  // the next run's New release dialog has no Cut from.
  test('maintenance line', async ({ page, save, l, as, lang, text }) => {
    test.setTimeout(360_000);
    const publisher = await as(USERS.publisher);
    // A release takes one line ever, closed or not: each language starts its own.
    const base = await release(publisher, lang === 'de' ? 'north' : 'south');
    const started = await publisher.send('POST', '/maintenance-lines', {
      data: {
        type: 'MaintenanceLine',
        relationships: {
          baseRelease: { data: { type: 'Release', id: base } },
        },
      },
    });
    expect(started.status()).toBe(201);
    const line = ((await started.json()) as { data: { id: string } }).data.id;
    try {
      await signIn(page, USERS.publisher);
      await page.goto('/releases');
      await page.getByRole('button', { name: l('releases.new') }).click();
      const dialog = page.getByRole('dialog', {
        name: l('releases.create.title'),
      });
      await dialog
        .getByRole('combobox', { name: l('releases.create.from.label') })
        .click();
      await expect(page.getByRole('option')).toHaveCount(2);
      await save('release-maintenance-line');

      // The Maintenance tab (#250): the line, open, with the release it started at.
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.goto('/releases?tab=maintenance');
      await expect(
        page
          .locator('[data-slot="line-row"]')
          .filter({ hasText: l('releases.maintenance.state.open') })
          .first(),
      ).toBeVisible();
      await save('maintenance-lines');

      // A revision started on the line: the picker's Product version choice, as a writer.
      await page.evaluate(
        (id) => localStorage.setItem('openfolia.demo-user', id),
        USERS.author,
      );
      await page.goto('/content');
      await page
        .getByRole('button', {
          name: new RegExp(`^${l('changeSet.trigger', { name: '' })}`),
        })
        .click();
      await page.getByRole('option', { name: l('changeSet.start') }).click();
      const choice = page.getByRole('radiogroup', {
        name: l('changeSet.lineField'),
      });
      await expect(choice.getByRole('radio')).toHaveCount(2);
      await choice.getByRole('radio').nth(1).click();
      await page
        .getByRole('textbox', { name: l('changeSet.titleField') })
        .fill(text.revision);
      await save('revision-product-version');
      await page.keyboard.press('Escape');

      // A fix merged into the line: its review offers carrying it forward to the current content.
      const author = await as(USERS.author);
      const fix = await author.createChangeSet(text.revision, {
        maintenanceLine: line,
      });
      await author.createModule(fix, {
        lang: 'en',
        moduleId: MODULE_ID,
        title: TEXT.en.module,
        type: 'procedure',
        blocks: guideBlocks(TEXT.en),
      });
      await author.transition(fix.id, 'submit', text.revision);
      await (await as(USERS.reviewer)).transition(fix.id, 'approve');
      await publisher.transition(fix.id, 'merge');
      await page.goto(`/review?cs=${fix.id}`);
      await expect(
        page.getByRole('button', { name: l('carryForward.action') }),
      ).toBeVisible();
      await save('carry-forward');
    } finally {
      const closed = await publisher.send(
        'POST',
        `/maintenance-lines/${line}/close`,
      );
      expect(closed.status()).toBe(200);
    }
  });
});
