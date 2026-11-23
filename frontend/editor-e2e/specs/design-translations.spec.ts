import { unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

/** A design ID of the test's own (a slug), so no other test meets it. */
const designId = (prefix: string) =>
  unique(prefix)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');

// Translations › a page design's region text (#568): a row of the status matrix of its own, its
// cell's panel with the units and a way to the design. In a draft of the test's own, so neither
// the matrix on main nor its jobs change.
test.describe('page design translations @area:translations @area:admin @api:translations @api:page-designs', () => {
  test('a design’s region text is a row of the matrix, its panel listing the units to translate', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Design text'));
    const id = designId('house');
    const name = unique('House style');
    await author.createPageDesign(changeSet, {
      id,
      name,
      preset: 'classic',
      regions: {
        back: [
          {
            type: 'paragraph',
            id: 'imprint',
            content: [
              { type: 'text', text: 'Printed on ' },
              { type: 'placeholder', key: 'date' },
            ],
          },
        ],
      },
    });

    await signIn(page, USERS.translator);
    await page.goto(
      `/translations?cs=${changeSet.id}&lang=de&q=${encodeURIComponent(name)}`,
    );
    const row = page.locator(`[data-row="designs/${id}"]`);
    await expect(row.getByRole('link', { name })).toHaveAttribute(
      'href',
      new RegExp(`/admin/page-designs/${id}`),
    );
    await expect(row.locator('[data-slot="design-kind"]')).toContainText(
      'Page design',
    );

    await row.locator(`[data-cell="de/designs/${id}"]`).click();
    const panel = page.locator('[data-slot="cell-panel"]');
    await expect(panel.getByRole('heading', { name })).toBeVisible();
    const unit = panel.locator('[data-block="back.imprint"]');
    await expect(unit.locator('[data-slot="block-source"]')).toHaveText(
      /Printed on/,
    );
    const open = panel.locator('[data-slot="open-design"]');
    await expect(open).toHaveText(/Open the page design/);
    await expect(open).toHaveAttribute(
      'href',
      new RegExp(`/admin/page-designs/${id}`),
    );
  });

  test.describe('refused', () => {
    test.use({ consoleAllow: [/status of 404/] });

    test('a design that is not there opens an error in the panel', async ({
      page,
    }) => {
      await signIn(page, USERS.translator);
      await page.goto('/translations?cell=de/designs/no-such-design');
      const panel = page.locator('[data-slot="cell-panel"]');
      await expect(panel.getByRole('alert').first()).toBeVisible();
    });
  });
});
