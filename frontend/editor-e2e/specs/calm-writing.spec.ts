import type { Locator, Page } from '@playwright/test';
import {
  type Api,
  type Block,
  moduleId,
  paragraph,
  unique,
} from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

const text = (value: string) => [{ type: 'text', text: value }];

/**
 * A module of its own (`title`, `blocks`) in a revision of its own, opened locked as the author;
 * returns its editor.
 */
async function openOwnModule(
  page: Page,
  api: (user: typeof USERS.author) => Promise<Api>,
  title: string,
  blocks: readonly Block[],
): Promise<Locator> {
  const author = await api(USERS.author);
  const changeSet = await author.createChangeSet(unique(title));
  const id = moduleId();
  await author.createModule(changeSet, {
    lang: 'en',
    moduleId: id,
    title,
    blocks,
  });
  await signIn(page, USERS.author);
  await page.goto(`/content/en/${id}?cs=${changeSet.id}`);
  await expect(page.getByText('Locked by you')).toBeVisible();
  return page.getByRole('textbox', { name: `Module ${title}` });
}

/** A new variant block after `after` ("/variant"), the caret in its empty line. */
async function newVariantBlock(page: Page, editor: Locator, after: string) {
  await editor.getByText(after).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/variant');
  await page.getByRole('option', { name: /Variant block/ }).click();
  await expect(editor.locator('[data-node="variant"]')).toHaveCount(1);
}

// Writing feels calm (#793): a normal step of writing never reads as an error, the variants
// dialog never jumps, and what is inserted reads well. Each test edits a module of its own.
test.describe('calm writing @area:module-editor @area:doc-editor @api:modules @api:variants @api:search @api:change-sets', () => {
  test('a new variant block is a calm draft until its variants are chosen; Apply gives the caret back where it was', async ({
    page,
    api,
  }) => {
    const editor = await openOwnModule(page, api, 'Charging', [
      paragraph('p1', 'Plug it in.'),
    ]);
    await newVariantBlock(page, editor, 'Plug it in.');
    await page.keyboard.type('Small ones charge faster');

    // Not saved yet, as a step of writing: muted, never the colour of an error.
    const status = page.locator('of-save-status');
    await expect(status).toHaveAttribute('data-status', 'draft');
    await expect(status).toHaveText(
      /^\s*Draft\s+· finish the block to save\s*$/,
    );
    await expect(status).not.toHaveClass(/text-destructive/);

    await editor
      .locator('[data-node="variant"]')
      .getByRole('button', { name: 'Choose variants' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Show this block for' });
    await dialog.getByText('Small', { exact: true }).click();
    const apply = dialog.getByRole('button', { name: 'Apply' });
    await expect(apply).not.toHaveAttribute('aria-disabled', 'true');
    await apply.click();
    await expect(dialog).toBeHidden();

    // Back in the block, the caret where it was: writing goes on there.
    await expect(editor).toBeFocused();
    await page.keyboard.type('.');
    await expect(
      editor.locator('[data-node="variant"] p', {
        hasText: 'Small ones charge faster.',
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: /^\s*Saved/ }),
    ).toBeVisible();
  });

  test('the "Choose variants" dialog stays in place while the builds of a choice load', async ({
    page,
    api,
  }) => {
    const editor = await openOwnModule(page, api, 'Storage', [
      paragraph('p1', 'Keep it dry.'),
    ]);
    await newVariantBlock(page, editor, 'Keep it dry.');
    await editor
      .locator('[data-node="variant"]')
      .getByRole('button', { name: 'Choose variants' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Show this block for' });
    const small = dialog.getByText('Small', { exact: true });
    await expect(small).toBeVisible();
    await expect(dialog.locator('[data-appears-in]')).toContainText(
      'Choose values',
    );
    // Settled after its opening transition.
    await page.waitForTimeout(300);
    const before = await dialog.boundingBox();

    await small.click();
    await expect(dialog.locator('[data-appears-in]')).toContainText(
      /Appears in \d+ build/,
    );
    await expect(dialog.locator('[data-build]').first()).toBeVisible();
    const after = await dialog.boundingBox();
    expect(after?.y).toBeCloseTo(before!.y, 0);
    expect(after?.height).toBeCloseTo(before!.height, 0);

    // Cancelled: the block stays without a condition.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });

  test('a snippet inserted on a blank line takes its place, no hint left beside it, and the outline names it by its title', async ({
    page,
    api,
  }) => {
    const editor = await openOwnModule(page, api, 'Battery care', [
      paragraph('p1', 'Charge it.'),
      {
        type: 'safety',
        id: 's1',
        severity: 'warning',
        symbols: [],
        hazard: text('Hot surface'),
        blocks: [paragraph('s1-p', 'Let it cool.')],
      },
    ]);
    // The blank line after the safety notice: "/snippet" there.
    await editor.getByText('Let it cool.').click();
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.type('/snippet');
    await page.getByRole('option', { name: /Snippet/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Insert snippet' });
    await dialog.getByRole('searchbox').fill('gloves');
    const row = dialog.locator('button[data-picker-row]');
    await expect(row).toHaveCount(1);
    await row.click();
    await dialog.getByRole('button', { name: 'Insert', exact: true }).click();
    await expect(dialog).toBeHidden();

    const reference = editor.locator('of-module-ref-node');
    await expect(reference).toContainText('Wear gloves');
    // The reference is selected, not a line: no "Type / for a block" beside it.
    await expect(editor.locator('[data-placeholder]')).toHaveCount(0);
    await expect(editor.getByText('/snippet')).toHaveCount(0);

    // The outline names it by the snippet's title, not its ID.
    const outline = page.locator('of-module-outline');
    await expect(outline).toContainText('Wear gloves');
    await expect(outline).not.toContainText('wear-gloves');
  });
});
