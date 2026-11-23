import type { Page } from '@playwright/test';

import { type Api, unique, type UserId } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

/** A design ID of the test's own (a slug), so no other test waits for its lock. */
const designId = (prefix: string) =>
  unique(prefix)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');

/** The configuration's working copy saved in the change set, answered. */
const configSaved = (page: Page) =>
  page.waitForResponse(
    (r) =>
      r.request().method() === 'PUT' &&
      /\/api\/change-sets\/[^/]+\/config\/working-copy$/.test(r.url()),
  );

/**
 * Waits until the default's choice can be used: the draft's settings are read to edit. Another
 * revision may hold the settings' lock for a moment (a flow making a product of its own): they
 * are read again until it is free. Whether the page was read again (the select then opens no
 * more on its own).
 */
async function untilSettingsEditable(page: Page): Promise<boolean> {
  const combobox = page
    .locator('[data-slot="default-select"]')
    .getByRole('combobox');
  let reloaded = false;
  await expect(async () => {
    if (await combobox.isDisabled()) {
      reloaded = true;
      await page.reload();
    }
    await expect(combobox).toBeEnabled({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  return reloaded;
}

/**
 * A page design of the flow's own in the change set (the stack's main has none, and a design
 * merged there would show in every other flow's list).
 */
async function ownDesign(
  admin: Api,
  changeSet: { id: string; baseCommit: string },
): Promise<{ id: string; name: string }> {
  const design = { id: designId('design'), name: unique('Design') };
  await admin.createPageDesign(changeSet, design);
  return design;
}

/**
 * An administrator of the flow's own, without a draft: "Change in a draft" takes the person's
 * newest open draft, and the seeded admin's are other flows' (abandoned under it as they end).
 */
async function ownAdmin(admin: Api): Promise<UserId> {
  const id = designId('e2e-settings');
  await admin.json(
    admin.send('POST', '/users', {
      data: {
        type: 'User',
        id,
        attributes: {
          name: unique('Settings admin'),
          email: `${id}@example.test`,
        },
        relationships: { roles: { data: [{ type: 'Role', id: 'admin' }] } },
      },
    }),
    201,
  );
  // A user added for the flow, not one of the seeded ones `UserId` names.
  return id as UserId;
}

/**
 * Takes the configuration's lock for the change set before the screen saves into it. Another
 * revision (another flow's, making a product or a default of its own) may hold it for a while:
 * asked again until it is free, so the screen's own save never meets it.
 */
async function holdConfigLock(api: Api, changeSet: string): Promise<void> {
  await expect(async () => {
    await api.lock(changeSet, { type: 'config' });
  }).toPass({ timeout: 90_000, intervals: [1_000, 2_000, 5_000] });
}

/** The change set the address names (`?cs=`). */
const changeSetOf = (page: Page) =>
  new URL(page.url()).searchParams.get('cs') ?? '';

/**
 * A manual of the change set's own, a copy of the service manual, so a design set on it changes
 * no manual any other flow reads.
 */
async function ownManual(
  author: Api,
  changeSet: { id: string; baseCommit: string },
  design?: string,
): Promise<{ id: string; title: string }> {
  const id = designId('own-manual');
  const title = unique('Own manual');
  const { data } = await author.json(
    author.get(`/change-sets/${changeSet.id}/manuals/service/working-copy`),
  );
  await author.lock(changeSet.id, { type: 'manual', manualId: id });
  await author.json(
    author.send(
      'PUT',
      `/change-sets/${changeSet.id}/manuals/${id}/working-copy`,
      {
        data: {
          type: 'WorkingCopy',
          attributes: {
            content: {
              ...data.attributes.content,
              id,
              title,
              ...(design && { design }),
            },
          },
        },
        meta: { version: 0, baseCommit: changeSet.baseCommit },
      },
    ),
  );
  await author.savePoint(changeSet.id);
  return { id, title };
}

/** The design the PDF preview of `manual` names, in the change set. */
async function previewedDesign(
  page: Page,
  manual: string,
  changeSet: string,
): Promise<string> {
  await page.goto(
    `/preview?manual=${manual}&output=pdf&scope=manual&cs=${changeSet}`,
  );
  const named = page.locator('[data-slot="design-in-use"]');
  await expect(named).toBeVisible();
  return (await named.textContent())?.replace(/\s+/g, ' ').trim() ?? '';
}

// #589: from "a new design" to the PDFs that use it. The project's default changes only in a
// draft of the flow's own (never merged: the stack's main is every flow's), a manual's own design
// only on a manual the flow makes.
test.describe('page designs in use @area:admin @area:manuals @api:page-designs @api:manuals @api:change-sets @api:config', () => {
  test('changes the default from published content in a draft of one’s own, and the preview names it', async ({
    page,
    api,
  }) => {
    const admin = await api(await ownAdmin(await api(USERS.admin)));
    await signIn(page, admin.user);
    await page.goto('/admin/page-designs');
    const select = page.locator('[data-slot="default-select"]');
    // Published content: the default is read-only, with the way to a draft.
    const inDraft = page.getByRole('button', { name: 'Change in a draft' });
    await expect(inDraft).toBeVisible();
    await expect(select.getByRole('combobox')).toBeDisabled();

    await inDraft.click();
    // The person has no draft: one is started, chosen and in the address.
    await expect(page).toHaveURL(/[?&]cs=/);
    const id = changeSetOf(page);
    admin.adopt(id);
    const { data } = await admin.json(admin.get(`/change-sets/${id}`));
    const changeSet = { id, baseCommit: data.attributes.baseCommit };
    await holdConfigLock(admin, id);
    // The select opens once the draft's settings are read to edit (unless they were held by
    // another revision and read again here).
    if (!(await untilSettingsEditable(page))) {
      await expect(page.getByRole('listbox')).toBeVisible();
    }
    // A design the draft makes, then chosen from the select.
    const design = await ownDesign(admin, changeSet);
    await page.reload();
    await untilSettingsEditable(page);
    const saved = configSaved(page);
    await select.getByRole('combobox').click();
    await page.getByRole('option', { name: design.name }).click();
    const save = await saved;
    expect(save.status()).toBe(200);
    expect(
      save.request().postDataJSON().data.attributes.content.pdf.design,
    ).toBe(design.id);
    await expect(select).toContainText(design.name);

    // Committed and submitted: the draft's preview prints the manual with it.
    await admin.savePoint(changeSet.id);
    await admin.transition(changeSet.id, 'submit');
    expect(await previewedDesign(page, 'operating', changeSet.id)).toBe(
      `Design: ${design.name}, project default`,
    );
    const link = page.locator('[data-slot="design-in-use"] a');
    await expect(link).toHaveAttribute(
      'href',
      new RegExp(`/admin/page-designs/${design.id}\\?cs=${changeSet.id}`),
    );
    // The published content still uses the built-in design.
    const published = await admin.json(admin.get('/manuals/operating'));
    expect(published.data.meta.design).toMatchObject({ id: 'builtin' });
  });

  test('makes the first design the default in the same draft, with the switch on', async ({
    page,
    api,
  }) => {
    const admin = await api(await ownAdmin(await api(USERS.admin)));
    const changeSet = await admin.createChangeSet(unique('First design'));
    await holdConfigLock(admin, changeSet.id);
    const name = unique('House design');
    await signIn(page, admin.user);
    await page.goto(`/admin/page-designs?cs=${changeSet.id}`);
    // The switch is offered while the draft's settings can be changed.
    await untilSettingsEditable(page);
    await page.getByRole('button', { name: 'New design' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
    const id = await dialog.getByRole('textbox', { name: 'ID' }).inputValue();
    const asDefault = dialog.getByRole('switch', {
      name: 'Use as the default design',
    });
    // The project uses the built-in design: on.
    await expect(asDefault).toHaveAttribute('aria-checked', 'true');
    const saved = configSaved(page);
    await dialog.getByRole('button', { name: 'Create design' }).click();
    const save = await saved;
    expect(save.status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`/admin/page-designs/${id}\\?`));

    // The draft holds both: the design and the default naming it.
    const config = await admin.json(
      admin.get(`/change-sets/${changeSet.id}/config/working-copy`),
    );
    expect(config.data.attributes.content.pdf.design).toBe(id);
    const design = await admin.json(
      admin.get(`/change-sets/${changeSet.id}/page-designs/${id}/working-copy`),
    );
    expect(design.data.attributes.content.name).toBe(name);
  });

  test('sets a manual’s own design in the builder: only that manual’s PDF uses it', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const changeSet = await admin.createChangeSet(unique('Own design'));
    const design = await ownDesign(admin, changeSet);
    const manual = await ownManual(admin, changeSet);
    await signIn(page, USERS.admin);
    await page.goto(`/manuals?manual=${manual.id}&cs=${changeSet.id}`);
    await page.getByTestId('settings-open').click();
    const field = page.getByTestId('settings-design');
    await expect(field.getByRole('combobox')).toContainText(
      'Project default (Built-in design)',
    );
    const saved = page.waitForResponse(
      (r) =>
        r.request().method() === 'PUT' &&
        r.url().endsWith(`/manuals/${manual.id}/working-copy`),
    );
    await field.getByRole('combobox').click();
    await page.getByRole('option', { name: design.name }).click();
    const save = await saved;
    expect(save.status()).toBe(200);
    expect(save.request().postDataJSON().data.attributes.content.design).toBe(
      design.id,
    );
    await expect(field.getByRole('combobox')).toContainText(design.name);

    await admin.savePoint(changeSet.id);
    expect(await previewedDesign(page, manual.id, changeSet.id)).toBe(
      `Design: ${design.name}, this manual's own`,
    );
    // Any other manual keeps the project's default.
    expect(await previewedDesign(page, 'service', changeSet.id)).toBe(
      'Design: Built-in design',
    );
  });

  test('warns of a manual’s design that is not in the content, in the builder and the preview', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Gone design'));
    const manual = await ownManual(author, changeSet, 'no-such-design');
    await signIn(page, USERS.author);
    await page.goto(`/manuals?manual=${manual.id}&cs=${changeSet.id}`);
    await page.getByTestId('settings-open').click();
    await expect(page.getByTestId('settings-design-missing')).toContainText(
      'no-such-design',
    );
    await previewedDesign(page, manual.id, changeSet.id);
    await expect(page.locator('[data-slot="design-missing"]')).toContainText(
      'built-in design is used',
    );
  });
  test.describe('the default refused', () => {
    // The refusal the flow provokes: the browser logs the 409 it answers.
    test.use({ consoleAllow: [/status of 409 \(Conflict\) .*\/locks/] });

    test('keeps the list and says so when the default cannot be saved with the new design', async ({
      page,
      api,
    }) => {
      const admin = await api(await ownAdmin(await api(USERS.admin)));
      const changeSet = await admin.createChangeSet(unique('Default refused'));
      // The configuration's lock is answered as held by another revision: every time, so the
      // refusal is certain (the race it stands for: another revision taking it first).
      await page.route(
        (url) => url.pathname === `/api/change-sets/${changeSet.id}/locks`,
        async (route) => {
          const body = route.request().postDataJSON();
          if (
            route.request().method() !== 'POST' ||
            body?.data?.attributes?.subject?.type !== 'config'
          ) {
            return route.continue();
          }
          await route.fulfill({
            status: 409,
            contentType: 'application/vnd.api+json',
            body: JSON.stringify({
              errors: [
                {
                  status: '409',
                  title: 'Conflict',
                  code: 'locked',
                  detail: 'Someone else holds the lock.',
                },
              ],
            }),
          });
        },
      );
      const name = unique('Refused design');
      await signIn(page, admin.user);
      await page.goto(`/admin/page-designs?cs=${changeSet.id}`);
      await untilSettingsEditable(page);
      await page.getByRole('button', { name: 'New design' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
      const id = await dialog.getByRole('textbox', { name: 'ID' }).inputValue();
      await expect(
        dialog.getByRole('switch', { name: 'Use as the default design' }),
      ).toHaveAttribute('aria-checked', 'true');
      await dialog.getByRole('button', { name: 'Create design' }).click();

      // Said: the design was made and opens, and it is not the default.
      await expect(
        page
          .getByRole('alert')
          .filter({ hasText: 'is not the default design' }),
      ).toContainText(name);
      await expect(page).toHaveURL(new RegExp(`/admin/page-designs/${id}\\?`));
      const config = await admin.json(
        admin.get(`/change-sets/${changeSet.id}/config/working-copy`),
        [200, 404],
      );
      expect(config?.data?.attributes?.content?.pdf?.design).toBeUndefined();
    });
  });
});

// #554: what resolving a manual's page design finds is in the manual's checks, never dropped
// without a word. A design and a manual of the flow's own, in its own draft.
test.describe('a page design’s problems in a manual’s checks @area:review @api:checks @api:page-designs @api:manuals', () => {
  const para = (id: string, text: string) => ({
    type: 'paragraph',
    id,
    content: [{ type: 'text', text }],
  });

  test('names a text left out and a translation with other blocks, at the manual', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const changeSet = await admin.createChangeSet(unique('Design checks'));
    const design = {
      id: designId('checked-design'),
      name: unique('Checked design'),
      // The German footer region lacks a block of the English one; the footer's left place is
      // only in German, so an English manual has none.
      regions: {
        footer: {
          en: [para('a', 'Keep this manual.'), para('b', 'Read it first.')],
          de: [para('a', 'Bewahren Sie diese Anleitung auf.')],
        },
      },
      footer: {
        default: { left: { de: [{ type: 'text', text: 'Nur Deutsch' }] } },
      },
    };
    await admin.createPageDesign(changeSet, design);
    const manual = await ownManual(admin, changeSet, design.id);
    await signIn(page, USERS.admin);
    await page.goto(`/checks?manual=${manual.id}&cs=${changeSet.id}`);
    const dropped = page
      .getByRole('row')
      .filter({ hasText: 'Page design text left out' });
    await expect(dropped).toContainText(
      `The page design ${design.id} has footer.default.left neither in the manual’s language nor in the source language: it is left out.`,
      { timeout: 60_000 },
    );
    const differs = page
      .getByRole('row')
      .filter({ hasText: 'Page design translation differs' });
    await expect(differs).toContainText(
      `The translation of regions.footer in the page design ${design.id} has other blocks than its English text.`,
    );
  });
});
