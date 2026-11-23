import type { Page } from '@playwright/test';

import { unique } from '../src/api.ts';
import {
  expect,
  openAccountMenu,
  signIn,
  test,
  USERS,
} from '../src/fixtures.ts';

// Labels and titles per language (#731): a module type's label in German in the project
// settings, a manual's title in German in the manual builder's settings, both shown once the
// interface is in German; a title emptied in the source language is refused and put back.
// Everything is the flow's own revision: its configuration (whose lock it takes first, as other
// flows' revisions may hold it a few seconds) and a manual of its own.

const slug = (prefix: string) =>
  unique(prefix)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');

/** The first save of `what`'s working copy from now on whose content `holds`, answered. */
const savedWith = (
  page: Page,
  what: string,
  holds: (content: never) => boolean,
) =>
  page.waitForResponse(
    (r) =>
      r.request().method() === 'PUT' &&
      r.url().endsWith(`/${what}/working-copy`) &&
      r.ok() &&
      holds(r.request().postDataJSON().data.attributes.content as never),
  );

test.describe('labels and titles per language @area:admin @area:manuals @area:content @api:config @api:manuals @api:change-sets', () => {
  test('a German module type label and manual title show once the interface is German; an empty source title is refused', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const changeSet = await admin.createChangeSet(unique('Label languages'));
    const manualId = slug('label-languages');
    const title = unique('Label manual');
    const german = unique('Handbuch der Bezeichnungen');
    const typeLabel = unique('Konzept');
    await admin.createManual(changeSet, manualId, {
      title,
      variants: [{ model: 'small' }],
      entries: [{ module: 'charging' }],
    });
    await expect(async () => {
      await admin.lock(changeSet.id, { type: 'config' });
    }).toPass({ timeout: 30_000 });

    await signIn(page, USERS.admin);

    // Project settings: the module type's label in German, beside the English one.
    await page.goto(`/admin/settings/module-types?cs=${changeSet.id}`);
    const concept = page.locator('[data-option="concept"]');
    await concept.locator('[data-slot="option-languages"]').click();
    const de = page.locator('#option-label-concept-de');
    await expect(de).toBeEditable();
    await expect(de).toHaveAttribute('placeholder', 'Concept');
    const labelled = savedWith(
      page,
      'config',
      (c: { moduleTypes: { id: string; label: unknown }[] }) => {
        const label = c.moduleTypes.find((t) => t.id === 'concept')?.label;
        return (
          typeof label === 'object' &&
          (label as Record<string, string>)['de'] === typeLabel
        );
      },
    );
    await de.fill(typeLabel);
    await de.blur();
    const config = (await labelled).request().postDataJSON().data
      .attributes.content;
    expect(
      config.moduleTypes.find((t: { id: string }) => t.id === 'concept').label,
    ).toEqual({ en: 'Concept', de: typeLabel });

    // The manual builder's settings: the title in German.
    await page.goto(`/manuals?manual=${manualId}&cs=${changeSet.id}`);
    await page.getByTestId('settings-open').click();
    const section = page.getByTestId('settings-title');
    const source = section.locator('#settings-title-en');
    await expect(source).toHaveValue(title);
    await section.locator('[data-slot="localized-text-toggle"]').click();
    const target = section.locator('#settings-title-de');
    await expect(target).toBeVisible();
    await expect(target).toHaveAttribute('placeholder', title);
    const titled = savedWith(
      page,
      `manuals/${manualId}`,
      (c: { title: unknown }) =>
        typeof c.title === 'object' &&
        (c.title as Record<string, string>)['de'] === german,
    );
    await target.fill(german);
    await target.blur();
    expect(
      (await titled).request().postDataJSON().data.attributes.content.title,
    ).toEqual({ en: title, de: german });

    // Emptied in the source language: refused, said, and the title put back.
    await source.fill('');
    await source.blur();
    await expect(
      section.locator('[data-slot="localized-text-error"]'),
    ).toBeVisible();
    await expect(section.locator('#settings-title-en')).toHaveValue(title);
    await expect(section.locator('#settings-title-en')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await page.keyboard.press('Escape');

    // The interface in German: the manual's German title, at once, without a reload.
    await openAccountMenu(page, 'Sample Admin');
    await page.getByRole('menuitemradio', { name: 'Deutsch' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('manual-switcher')).toContainText(german);

    // And the module type's German label in the content browser's type filter, which reads the
    // revision's commits: a save point first.
    await admin.savePoint(changeSet.id);
    await page.goto(`/content?cs=${changeSet.id}`);
    await page.getByRole('button', { name: /^Typ:/ }).click();
    await expect(
      page.getByRole('menuitemradio', { name: typeLabel }),
    ).toBeVisible();
  });

  test('the project labels are a row of the translations matrix, linking to the settings', async ({
    page,
  }) => {
    await signIn(page, USERS.translator);
    await page.goto('/translations?lang=de');
    const row = page.locator('[data-row="config/project"]');
    await expect(
      row.getByRole('link', { name: 'Project labels' }),
    ).toHaveAttribute('href', /\/admin\/settings/);
    await expect(row.locator('[data-slot="config-kind"]')).toContainText(
      'Module types',
    );
    await row.locator('[data-slot="choose-row"]').click();
    await expect(page.locator('[data-slot="chosen-count"]')).toHaveText(
      'Project labels chosen',
    );

    await row.locator('[data-cell="de/config/project"]').click();
    const panel = page.locator('[data-slot="cell-panel"]');
    await expect(
      panel.getByRole('heading', { name: 'Project labels' }),
    ).toBeVisible();
    await expect(panel.locator('[data-slot="open-settings"]')).toHaveAttribute(
      'href',
      /\/admin\/settings/,
    );
  });
});
