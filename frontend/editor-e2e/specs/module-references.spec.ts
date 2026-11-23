import type { Page } from '@playwright/test';
import { type Block, moduleId, paragraph, unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

const text = (value: string) => [{ type: 'text', text: value }];

/** A shared module's blocks: a safety notice and a paragraph, one of which is reused. */
const sharedBlocks = (extra: readonly Block[] = []): Block[] => [
  paragraph('intro', 'About battery acid.'),
  {
    type: 'safety',
    id: 'acid',
    severity: 'warning',
    symbols: [],
    hazard: text('Battery acid'),
    blocks: [paragraph('acid-rinse', 'Rinse with plenty of water.')],
  },
  ...extra,
];

/**
 * Inserts a module reference after `after` (`/module`) and opens the picker from its card,
 * then searches for `term` and chooses the one row it finds.
 */
async function openPicker(
  page: Page,
  title: string,
  after: string,
  term: string,
) {
  await page
    .getByRole('textbox', { name: `Module ${title}` })
    .getByText(after)
    .click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/module');
  await page.getByRole('option', { name: /Module reference/ }).click();
  await page
    .locator('of-module-ref-node')
    .getByRole('button', { name: 'Choose module' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Insert module reference' });
  await dialog.getByRole('searchbox', { name: 'Search modules' }).fill(term);
  const row = dialog.locator('button[data-picker-row]');
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  return dialog;
}

// The module reference picker's "One block from it" (#223), in a revision of its own.
test.describe('module references to one block @area:module-editor @area:doc-editor @api:modules @api:search @api:change-sets', () => {
  test('includes one block of another module, chosen in the picker’s preview, and names it on its card', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('One block'));
    const word = unique('acid').split(' ')[1] as string;
    const shared = moduleId('shared');
    const host = moduleId('host');
    await author.createModule(
      changeSet,
      {
        lang: 'en',
        moduleId: shared,
        title: `Battery safety ${word}`,
        blocks: sharedBlocks(),
      },
      { savePoint: false },
    );
    await author.createModule(changeSet, {
      lang: 'en',
      moduleId: host,
      title: 'Charging station',
      blocks: [paragraph('p1', 'Before charging, read this.')],
    });

    await signIn(page, USERS.author);
    await page.goto(`/content/en/${host}?cs=${changeSet.id}`);
    await expect(page.getByText('Locked by you')).toBeVisible();
    const dialog = await openPicker(
      page,
      'Charging station',
      'Before charging, read this.',
      word,
    );

    // "One block from it": the preview turns into a chooser of the module's blocks.
    await dialog.getByRole('radio', { name: /One block from it/ }).click();
    const chooser = dialog.locator('[data-block-chooser]');
    await expect(chooser.getByRole('radio')).toHaveCount(3);
    const insert = dialog.getByRole('button', { name: 'Insert', exact: true });
    await expect(insert).toHaveAttribute('aria-disabled', 'true');
    await expect(
      dialog.getByText('Choose a block of the module first.'),
    ).toBeVisible();
    await chooser.getByRole('radio', { name: /Battery acid/ }).click();
    await expect(insert).not.toHaveAttribute('aria-disabled', 'true');
    await insert.click();
    await expect(dialog).toBeHidden();

    // The card names the module and the block.
    const card = page.locator('of-module-ref-node');
    await expect(card).toContainText(`Battery safety ${word}`);
    await expect(card).toContainText('Block “Safety notice: Battery acid”');
    await expect(
      page.getByRole('status').filter({ hasText: /^Saved/ }),
    ).toBeVisible();
    await expect(async () => {
      const { data } = await author.json(
        author.get(
          `/change-sets/${changeSet.id}/modules/en/${host}/working-copy`,
        ),
      );
      expect(JSON.stringify(data)).toContain(
        `"module":"${shared}","block":"acid"`,
      );
    }).toPass({ timeout: 20_000 });

    // Open goes to the shared module, at that block.
    await card.getByRole('button', { name: 'Open' }).click();
    await expect(page).toHaveURL(
      new RegExp(`/content/en/${shared}\\?.*block=acid`),
    );
  });

  test('refuses one block of a module that already includes this one: a cycle', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Block cycle'));
    const word = unique('loop').split(' ')[1] as string;
    const host = moduleId('host');
    const wrapper = moduleId('wrapper');
    await author.createModule(
      changeSet,
      {
        lang: 'en',
        moduleId: host,
        title: 'Charging station',
        blocks: [paragraph('p1', 'Before charging, read this.')],
      },
      { savePoint: false },
    );
    // The wrapper includes the host module already.
    await author.createModule(changeSet, {
      lang: 'en',
      moduleId: wrapper,
      title: `Station overview ${word}`,
      blocks: sharedBlocks([{ type: 'moduleRef', id: 'host', module: host }]),
    });

    await signIn(page, USERS.author);
    await page.goto(`/content/en/${host}?cs=${changeSet.id}`);
    await expect(page.getByText('Locked by you')).toBeVisible();
    const dialog = await openPicker(
      page,
      'Charging station',
      'Before charging, read this.',
      word,
    );
    await dialog.getByRole('radio', { name: /One block from it/ }).click();
    await dialog
      .locator('[data-block-chooser]')
      .getByRole('radio', { name: /Battery acid/ })
      .click();
    await expect(
      dialog.getByText(`Station overview ${word} already includes this module`),
    ).toBeVisible();
    const insert = dialog.getByRole('button', { name: 'Insert', exact: true });
    await expect(insert).toHaveAttribute('aria-disabled', 'true');
    await expect(
      dialog.getByText('Including this module would make a cycle.'),
    ).toBeVisible();
    // A link is no inclusion: it stays possible.
    await dialog.getByRole('radio', { name: /Link only/ }).click();
    await expect(insert).not.toHaveAttribute('aria-disabled', 'true');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });
});
