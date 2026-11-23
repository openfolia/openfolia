import { unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

// The terminology and style checks (#55) on the checks screen: the sample's `storage` module
// says "Store the loader in a dry place.", a forbidden variant of the term `charger` and the
// phrase of the sample's style rule `dry-place` (`addSampleTerms`). Read in a revision of the
// test's own; nothing is changed.

test.describe('writing checks @area:review @api:checks', () => {
  test('shows the forbidden term and the style rule at their block, with the fix', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Writing checks'));
    await signIn(page, USERS.author);
    await page.goto(`/checks?manual=operating&cs=${changeSet.id}`);

    const forbidden = page
      .getByRole('row')
      .filter({ hasText: 'Forbidden term' });
    await expect(forbidden).toContainText(
      '“loader” is a forbidden variant of the term charger: write “charger”.',
      { timeout: 60_000 },
    );
    await expect(forbidden).toContainText('Warning');
    const style = page.getByRole('row').filter({ hasText: 'Style rule' });
    await expect(style).toContainText(
      '“in a dry place”: Name the storage conditions, such as the temperature range.',
    );

    await forbidden.getByRole('button', { name: /Go to block/ }).click();
    await expect(page).toHaveURL(/\/content\/en\/storage\?.*block=dry/);
  });

  test('shows a rule’s message as text, and says where the checks stopped', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Writing checks'));
    // A configured message is untrusted text; a module too long to check is a warning of its own.
    await page.route(
      (url) => url.pathname === `/api/change-sets/${changeSet.id}/checks`,
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as {
          data: unknown[];
          meta: { counts: { warning: number }; page: { total: number } };
        };
        const at = (code: string, params: Record<string, string>) => ({
          type: 'Check',
          id: `${code}-e2e`,
          attributes: {
            code,
            severity: 'warning',
            category: 'writing',
            subject: { type: 'module', lang: 'en', moduleId: 'storage' },
            blockId: 'dry',
            message: code,
            params,
          },
          meta: { variants: [], languages: [], title: 'Storage' },
        });
        body.data.unshift(
          at('style-rule', {
            field: 'content',
            start: '0',
            end: '5',
            text: 'Store',
            rule: 'markup',
            message: '<img src=x onerror=alert(1)> {count} stays text.',
          }),
          at('writing-not-checked', { stopped: 'steps' }),
        );
        body.meta.counts.warning += 2;
        body.meta.page.total += 2;
        await route.fulfill({ response, json: body });
      },
    );
    await signIn(page, USERS.author);
    await page.goto(`/checks?cs=${changeSet.id}`);

    await expect(
      page.getByRole('row').filter({
        hasText: '“Store”: <img src=x onerror=alert(1)> {count} stays text.',
      }),
    ).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await expect(
      page.getByRole('row').filter({ hasText: 'Writing not checked' }),
    ).toContainText('The style rules took too long on this module’s text');
  });
});
