import type { Page } from '@playwright/test';

import { unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

/** A design ID of the test's own (a slug), so no other test waits for its lock. */
const designId = (prefix: string) =>
  unique(prefix)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');

/** A region's text per language, as a save sends it. */
type SentRegions = Record<string, Record<string, { content: unknown }[]>>;

/**
 * The working copy's first save of the design from now on whose regions `holds` (their JSON),
 * answered. Not just the next save: under load the 600 ms pause before a region's text is taken
 * can pass mid-word, so a save of the text typed so far may still be on its way (#578).
 */
const savedWith = (page: Page, id: string, holds: string) =>
  page.waitForResponse(
    (r) =>
      r.request().method() === 'PUT' &&
      r.url().endsWith(`/page-designs/${id}/working-copy`) &&
      JSON.stringify(
        r.request().postDataJSON().data.attributes.content.regions,
      ).includes(holds),
  );

/** Every save of the design's working copy answered from now on, the regions each sent. */
const savesOf = (page: Page, id: string) => {
  const sent: SentRegions[] = [];
  page.on('response', (r) => {
    if (
      r.request().method() === 'PUT' &&
      r.url().endsWith(`/page-designs/${id}/working-copy`)
    )
      sent.push(r.request().postDataJSON().data.attributes.content.regions);
  });
  return sent;
};

/** The regions a save sent. */
const regionsOf = async (save: ReturnType<typeof savedWith>) =>
  (await save).request().postDataJSON().data.attributes.content.regions;

// Admin › Page design › a design, its title and back page text (#393): each region of the layout
// in the block editor, placeholders typed in with "{" as chips, per language with the source
// text as every language's until a language has its own, and placeholders that are none flagged.
test.describe('page design text @area:admin @area:module-editor @api:page-designs @api:change-sets', () => {
  test('writes the title page foot with a placeholder, then its German version', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Region text'));
    const id = designId('regions');
    await author.createPageDesign(changeSet, {
      id,
      name: unique('Regions'),
      preset: 'classic',
    });

    await signIn(page, USERS.author);
    await page.goto(`/admin/page-designs/${id}?cs=${changeSet.id}`);
    const section = page.locator('[data-section="regions"]');
    await expect(
      section.getByRole('heading', { name: 'Title and back page text' }),
    ).toBeVisible();

    // The foot of the title page: empty, opened, written into.
    const foot = section.locator('[data-region="footer"]');
    await expect(foot).toHaveAttribute('data-state', 'empty');
    await foot.getByRole('button', { name: /Title page foot/ }).click();
    const text = foot.getByRole('textbox', {
      name: 'Title page foot, English',
    });
    await text.click();
    await page.keyboard.type('Keep this manual. Version ');

    // "{" opens the placeholders; the typed letters filter them, Enter puts one in.
    await page.keyboard.type('{');
    const menu = page.getByRole('listbox', { name: 'Insert a placeholder' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('option', { name: /Page number/ })).toHaveCount(
      0,
    );
    await page.keyboard.type('vers');
    await expect(menu.getByRole('option').first()).toContainText(
      'Product version',
    );
    const first = savedWith(page, id, '"product-version"');
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect(foot.locator('[data-node="placeholder"]')).toHaveText(
      'Product version',
    );
    const english = await regionsOf(first);
    expect(english.footer).toEqual([
      expect.objectContaining({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Keep this manual. Version ' },
          { type: 'placeholder', key: 'product-version' },
        ],
      }),
    ]);
    await expect(foot).toHaveAttribute('data-state', 'own');

    // German: the English text shows, marked as not translated, until it is written.
    await section
      .getByRole('radiogroup', { name: 'Language' })
      .getByText('German')
      .click();
    await expect(foot).toHaveAttribute('data-state', 'source');
    await expect(foot.locator('[data-slot="region-badge"]')).toHaveText(
      'Not translated',
    );
    const german = foot.getByRole('textbox', {
      name: 'Title page foot, German',
    });
    await german.click();
    await page.keyboard.press('ControlOrMeta+a');
    const saves = savesOf(page, id);
    await page.keyboard.type('Bewahren Sie diese Anleitung auf. Version ');
    await page.keyboard.type('{');
    await expect(menu).toBeVisible();
    await page.keyboard.type('vers');
    await expect(menu.getByRole('option').first()).toContainText(
      'Product version',
    );
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect(foot).toHaveAttribute('data-state', 'own');
    // Typing saves as it goes: the last save holds the whole German text.
    await expect
      .poll(() => JSON.stringify(saves.at(-1)?.['footer']?.['de'] ?? ''))
      .toContain('product-version');
    const footer = saves.at(-1)?.['footer'] ?? {};
    expect(Object.keys(footer)).toEqual(['en', 'de']);
    expect(footer['en']).toEqual(english.footer);
    expect(footer['de']?.[0]?.content).toEqual([
      { type: 'text', text: 'Bewahren Sie diese Anleitung auf. Version ' },
      { type: 'placeholder', key: 'product-version' },
    ]);
    // The preview shows the German PDF.
    await expect(
      page.getByRole('combobox', { name: /^Language:/ }),
    ).toContainText('German');

    // Read again: both versions there, the chip in each.
    await page.reload();
    await expect(foot).toHaveAttribute('data-state', 'own');
    await expect(foot.locator('[data-node="placeholder"]')).toHaveText(
      'Product version',
    );
  });

  test('flags a placeholder that is none, at its block', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Bad placeholder'));
    const id = designId('bad-placeholder');
    // A working copy only: a commit refuses a design with an error in it.
    await author.lock(changeSet.id, { type: 'design', designId: id });
    await author.json(
      author.send(
        'PUT',
        `/change-sets/${changeSet.id}/page-designs/${id}/working-copy`,
        {
          data: {
            type: 'WorkingCopy',
            attributes: {
              content: {
                schemaVersion: 1,
                id,
                name: unique('Bad placeholder'),
                preset: 'classic',
                colours: {
                  primary: '#1f4e79',
                  accent: '#b45309',
                  text: '#1f2328',
                },
                regions: {
                  back: [
                    {
                      type: 'paragraph',
                      id: 'serial',
                      content: [
                        { type: 'text', text: 'Serial ' },
                        { type: 'placeholder', key: 'serial-number' },
                      ],
                    },
                  ],
                },
              },
            },
          },
          meta: { version: 0, baseCommit: changeSet.baseCommit },
        },
      ),
    );

    await signIn(page, USERS.author);
    await page.goto(`/admin/page-designs/${id}?cs=${changeSet.id}`);
    const back = page.locator('[data-region="back"]');
    const chip = back.locator('[data-node="placeholder"]');
    await expect(chip).toContainText('{serial-number}');
    await expect(chip).toHaveAttribute(
      'title',
      'Not a placeholder: serial-number',
    );
    await expect(
      back.locator('[data-issue="unknown-placeholder"]'),
    ).toBeVisible();
  });
});
