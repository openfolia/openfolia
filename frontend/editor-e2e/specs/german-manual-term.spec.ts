import { unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

// The German interface calls a manual "Anleitung", the glossary term (#816): the sidebar, the
// manual list with its builder and the "New manual" dialog, in both colour schemes. Nothing in
// them says "Handbuch" any more. The flow's own revision holds the dialog; nothing is saved.

test.describe('the German interface says Anleitung @area:manuals @area:shell', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`the manual list and the new-manual dialog, ${scheme}`, async ({
      page,
      api,
    }) => {
      const author = await api(USERS.author);
      const changeSet = await author.createChangeSet(unique('Anleitung'));
      await page.addInitScript((s) => {
        localStorage.setItem('of-language', 'de');
        localStorage.setItem('of-theme', s);
      }, scheme);
      await signIn(page, USERS.author);
      await page.goto(`/manuals?manual=operating&cs=${changeSet.id}`);

      await expect(
        page.getByRole('link', { name: 'Anleitungen' }).first(),
      ).toBeVisible();
      await expect(page.locator('body')).not.toContainText(/Handb(u|ü)ch/);

      await page.getByTestId('manual-switcher').click();
      await page.getByTestId('manual-new').click();
      const dialog = page.getByRole('dialog', { name: 'Neue Anleitung' });
      await expect(dialog).toBeVisible();
      await expect(dialog).not.toContainText(/Handb(u|ü)ch/);

      // The dialog's own wording, with the right articles.
      await expect(dialog).toContainText(
        'Mit einer Kopie einer anderen Anleitung beginnen',
      );
      await expect(dialog).toContainText(
        'Aus einer anderen Anleitung abgeleitet',
      );
    });
  }
});
