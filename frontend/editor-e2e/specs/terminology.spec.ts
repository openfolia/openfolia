import { unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

// The terminology page (`/terminology`): a term that modules link cannot be deleted (#245). The
// sample content's `storage` module links `battery` and `charger` (`battery` is also another
// term's replacement, a reason of its own); nothing links `housing`.
// Each test opens the page in a revision of its own (deleting needs one) and changes no term.
test.describe('terminology @area:terminology @api:terms @api:modules', () => {
  test('a term a module links names the module and offers no delete', async ({
    page,
    api,
  }) => {
    const changeSet = await (
      await api(USERS.author)
    ).createChangeSet(unique('Linked term'));
    await signIn(page, USERS.author);
    await page.goto(`/terminology?term=charger&cs=${changeSet.id}`);
    const panel = page.getByRole('complementary', { name: 'Term details' });
    await expect(
      panel.getByText(/Kept while a module links it:/),
    ).toContainText('Storage (en)');
    await expect(
      panel.getByRole('button', { name: 'Delete term' }),
    ).toHaveAttribute('aria-disabled', 'true');
    await expect(
      panel.getByRole('button', { name: 'Delete term' }),
    ).toHaveAttribute('aria-description', 'Modules link this term.');
  });

  test('a term no module links can be deleted', async ({ page, api }) => {
    const changeSet = await (
      await api(USERS.author)
    ).createChangeSet(unique('Unlinked term'));
    await signIn(page, USERS.author);
    await page.goto(`/terminology?term=housing&cs=${changeSet.id}`);
    const panel = page.getByRole('complementary', { name: 'Term details' });
    const remove = panel.getByRole('button', { name: 'Delete term' });
    await expect(remove).toBeVisible();
    await expect(remove).not.toHaveAttribute('aria-disabled', 'true');
    await expect(panel.getByText(/Kept while/)).toHaveCount(0);
  });
});
