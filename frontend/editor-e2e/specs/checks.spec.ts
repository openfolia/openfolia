import { unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

// The checks of a revision (#710, #711): a head whose retrieval chunks are too large together is
// a blocking check at the modules that expanded the most, and a run whose chunk cuts passed
// their budget warns at the first module it did not check. Content that large takes tens of
// millions of characters of work, so the checks the API answers for the test's own revision
// are extended in the browser (only this page's); nothing of main or another flow's state is
// changed.

/** A check as the API answers it, at module `moduleId` in English. */
const check = (
  code: string,
  severity: 'blocking' | 'warning',
  moduleId: string,
  params: Record<string, string>,
) => ({
  type: 'Check',
  id: `${code}-${moduleId}`,
  attributes: {
    code,
    severity,
    category: 'reference',
    subject: { type: 'module', lang: 'en', moduleId },
    blockId: null,
    message: `${code} at ${moduleId}`,
    params,
  },
  meta: { variants: [], languages: [], title: `Title of ${moduleId}` },
});

test.describe('chunk checks of a revision @area:review @api:checks @api:chunks', () => {
  test('shows chunks too large together as blocking, and chunks not checked as a warning', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Chunk checks'));
    await page.route(
      (url) => url.pathname === `/api/change-sets/${changeSet.id}/checks`,
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as {
          data: unknown[];
          meta: {
            counts: { blocking: number; warning: number };
            page: { total: number };
          };
        };
        body.data.unshift(
          check('chunk-set-too-large', 'blocking', 'e2e-wide', {
            chars: '2353104',
            nodes: '262138',
          }),
          check('chunks-not-checked', 'warning', 'e2e-wider', {
            modules: '38',
          }),
        );
        body.meta.counts.blocking += 1;
        body.meta.counts.warning += 1;
        body.meta.page.total += 2;
        await route.fulfill({ response, json: body });
      },
    );
    await signIn(page, USERS.author);
    await page.goto(`/checks?cs=${changeSet.id}`);

    const tooLarge = page
      .getByRole('row')
      .filter({ hasText: 'Chunks too large together' });
    await expect(tooLarge).toContainText('Blocking', { timeout: 60_000 });
    await expect(tooLarge).toContainText(
      'Once released, it would have no chunks at all.',
    );
    const notChecked = page
      .getByRole('row')
      .filter({ hasText: 'Chunks not checked' });
    await expect(notChecked).toContainText('Warning');
    await expect(notChecked).toContainText(
      'so from this module on they were not checked',
    );
  });

  test.describe('the checks cannot be read', () => {
    test.use({ consoleAllow: [/status of 503.*\/checks/] });

    test('says so, and shows no check', async ({ page, api }) => {
      const author = await api(USERS.author);
      const changeSet = await author.createChangeSet(unique('Chunk checks'));
      await page.route(
        (url) => url.pathname === `/api/change-sets/${changeSet.id}/checks`,
        (route) =>
          route.fulfill({
            status: 503,
            contentType: 'application/vnd.api+json',
            headers: { 'Retry-After': '30' },
            body: JSON.stringify({
              errors: [
                {
                  status: '503',
                  code: 'renderer-busy',
                  title: 'Service unavailable',
                },
              ],
            }),
          }),
      );
      await signIn(page, USERS.author);
      await page.goto(`/checks?cs=${changeSet.id}`);
      await expect(
        page.getByText('The PDF service is busy. Try again in a moment.'),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        page.getByRole('row').filter({ hasText: 'Chunks too large together' }),
      ).toHaveCount(0);
    });
  });
});
