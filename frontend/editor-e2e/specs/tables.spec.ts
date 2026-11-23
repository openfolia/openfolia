import { type Block, moduleId, unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

/** The most columns a table may have (`MAX_TABLE_COLUMNS` of the content model, #686). */
const MAX_COLUMNS = 1_000;

/**
 * A table of `columns` columns and one row, each cell a paragraph; the first column as wide as all
 * the others, so its cell (`First cell`) has room to be clicked.
 */
const wideTable = (columns: number): Block => ({
  type: 'table',
  id: 'wide',
  columns: Array.from({ length: columns }, (_c, c) => ({
    width: c === 0 ? columns : 1,
  })),
  header: false,
  rows: [
    {
      cells: Array.from({ length: columns }, (_c, c) => ({
        blocks: [
          {
            type: 'paragraph',
            id: `cell-${c + 1}`,
            content: [{ type: 'text', text: c === 0 ? 'First cell' : '·' }],
          },
        ],
      })),
    },
  ],
});

// The table tools within the caps of a table (#686): no column past 1,000, the menu saying why.
test.describe('table caps @area:module-editor @api:change-sets', () => {
  test('offers no column past the cap, says why, and still adds a row', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Wide table'));
    const id = moduleId();
    await author.createModule(changeSet, {
      lang: 'en',
      moduleId: id,
      title: 'Wide table',
      blocks: [wideTable(MAX_COLUMNS)],
    });

    await signIn(page, USERS.author);
    await page.goto(`/content/en/${id}?cs=${changeSet.id}`);
    await expect(page.getByText('Locked by you')).toBeVisible();
    const editor = page.getByRole('textbox', { name: 'Module Wide table' });
    // A thousand columns leave each cell too narrow to click: the caret goes into the first
    // cell from the start of the module, the blank line before the table.
    await editor.focus();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('ArrowDown');
    await expect(
      page.getByRole('button', { name: 'Table actions' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Table actions' }).click();
    const menu = page.getByRole('menu');
    await expect(
      menu.getByRole('menuitem', { name: 'Insert column after' }),
    ).toBeDisabled();
    await expect(
      menu.getByRole('menuitem', { name: 'Insert column before' }),
    ).toBeDisabled();
    await expect(
      menu.getByText(
        'A table has at most 1,000 columns: no more can be added.',
      ),
    ).toBeVisible();

    // A row still fits (2,000 cells): added, and saved.
    const saved = page.waitForResponse(
      (r) =>
        r.request().method() === 'PUT' &&
        r.url().endsWith(`/modules/en/${id}/working-copy`) &&
        r.status() === 200,
    );
    await menu.getByRole('menuitem', { name: 'Insert row below' }).click();
    await saved;
    await expect(editor.locator('[data-node="tableCell"]')).toHaveCount(
      2 * MAX_COLUMNS,
    );
  });

  test('a table past the cap is refused by the API with table-too-large', async ({
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Too wide'));
    const id = moduleId();
    await author.lock(changeSet.id, {
      type: 'module',
      lang: 'en',
      moduleId: id,
    });
    const answer = await author.send(
      'PUT',
      `/change-sets/${changeSet.id}/modules/en/${id}/working-copy`,
      {
        data: {
          type: 'WorkingCopy',
          attributes: {
            content: {
              schemaVersion: 1,
              id,
              meta: {
                title: 'Too wide',
                type: 'concept',
                lang: 'en',
                facets: {},
              },
              blocks: [wideTable(MAX_COLUMNS + 1)],
            },
          },
        },
        meta: { version: 0, baseCommit: changeSet.baseCommit },
      },
    );
    expect(answer.status()).toBe(422);
    const body = (await answer.json()) as { errors: { code: string }[] };
    expect(body.errors.map((e) => e.code)).toEqual(['table-too-large']);
  });
});

// The table actions menu takes the room the window has (#694): every entry shows, Column
// alignment at its end too, without scrolling inside the menu.
test.describe('table actions menu @area:module-editor @api:change-sets', () => {
  test('shows every entry at once when the window has room for them', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Table menu'));
    const id = moduleId();
    await author.createModule(changeSet, {
      lang: 'en',
      moduleId: id,
      title: 'Table menu',
      blocks: [wideTable(2)],
    });

    await signIn(page, USERS.author);
    await page.goto(`/content/en/${id}?cs=${changeSet.id}`);
    await expect(page.getByText('Locked by you')).toBeVisible();
    await page.getByText('First cell', { exact: true }).click();
    await page.getByRole('button', { name: 'Table actions' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByText('Column alignment')).toBeVisible();
    const room = await page
      .getByRole('button', { name: 'Table actions' })
      .evaluate((b) => window.innerHeight - b.getBoundingClientRect().bottom);
    const height = await menu.evaluate((m) => m.scrollHeight);
    // The window has room for the whole menu below its button: nothing is cut off.
    expect(height).toBeLessThan(room);
    expect(await menu.evaluate((m) => m.scrollHeight - m.clientHeight)).toBe(0);
    await expect(menu.getByRole('menuitemcheckbox').last()).toBeInViewport({
      ratio: 1,
    });
  });

  test.describe('in a short window', () => {
    test.use({ viewport: { width: 1440, height: 480 } });

    test('stays inside the window and scrolls within itself', async ({
      page,
      api,
    }) => {
      const author = await api(USERS.author);
      const changeSet = await author.createChangeSet(unique('Short window'));
      const id = moduleId();
      await author.createModule(changeSet, {
        lang: 'en',
        moduleId: id,
        title: 'Short window',
        blocks: [wideTable(2)],
      });

      await signIn(page, USERS.author);
      await page.goto(`/content/en/${id}?cs=${changeSet.id}`);
      await expect(page.getByText('Locked by you')).toBeVisible();
      await page.getByText('First cell', { exact: true }).click();
      await page.getByRole('button', { name: 'Table actions' }).click();
      const menu = page.getByRole('menu');
      await expect(menu.getByText('Column alignment')).toBeVisible();
      const box = await menu.evaluate((m) => {
        const r = m.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      });
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(480);
      expect(
        await menu.evaluate((m) => m.scrollHeight - m.clientHeight),
      ).toBeGreaterThan(0);
    });
  });
});
