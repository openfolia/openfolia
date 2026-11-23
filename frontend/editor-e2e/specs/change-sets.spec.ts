import { mergedModule, unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

// Revisions (change sets) from the header's revision control: start one, rename it, update it
// from main.
test.describe('revisions @area:shell @area:change-sets @api:change-sets', () => {
  test('starts a revision from the revision control and renames it', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const title = unique('Started in the browser');
    // #467: nothing names the revision's placeholder (`pending:<n>`) while it is started.
    const placeholders: string[] = [];
    page.on('request', (request) => {
      if (/pending(:|%3A)\d/i.test(request.url()))
        placeholders.push(request.url());
    });
    await signIn(page, USERS.author);
    await page.goto('/content');

    await page.getByRole('button', { name: /^Revision:/ }).click();
    await page.getByRole('option', { name: 'New revision' }).click();
    const start = page.getByRole('button', { name: 'Start' });
    await page.getByRole('textbox', { name: 'Title' }).fill(title);
    await start.click();
    await expect(
      page.getByRole('button', { name: `Revision: ${title} (Draft)` }),
    ).toBeVisible();
    await expect(page).toHaveURL(/[?&]cs=[0-9a-f-]{36}/);
    author.adopt(new URL(page.url()).searchParams.get('cs') ?? '');
    expect(placeholders).toEqual([]);

    const renamed = `${title} (renamed)`;
    await page.getByRole('button', { name: /^Revision:/ }).click();
    await page.getByRole('option', { name: 'Rename revision' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill(renamed);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(
      page.getByRole('button', { name: `Revision: ${renamed} (Draft)` }),
    ).toBeVisible();
  });

  test('a revision without a title is not started', async ({ page }) => {
    await signIn(page, USERS.author);
    await page.goto('/content');
    await page.getByRole('button', { name: /^Revision:/ }).click();
    await page.getByRole('option', { name: 'New revision' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill('   ');
    const start = page.getByRole('button', { name: 'Start' });
    if (await start.isEnabled()) await start.click();
    await expect(
      page.getByRole('button', { name: 'Revision: Published content' }),
    ).toBeVisible();
    await expect(page).not.toHaveURL(/[?&]cs=/);
  });

  test('updates a revision from main once main moved on', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const title = unique('Behind main');
    const mine = await author.createChangeSet(title);
    // Main moves on: another revision is merged.
    const moved = await mergedModule(
      author,
      await api(USERS.reviewer),
      await api(USERS.publisher),
      unique('Came from main'),
    );

    await signIn(page, USERS.author);
    await page.goto(
      `/content?cs=${mine.id}&q=${encodeURIComponent(moved.moduleTitle)}`,
    );
    const modules = page.getByRole('region', { name: 'Modules' });
    await expect(
      modules.getByRole('link', { name: moved.moduleTitle }),
    ).toHaveCount(0);
    const update = page.getByRole('button', { name: /^Update from main/ });
    await update.click();
    await expect(update).toHaveCount(0);
    await expect(page.getByText(`Updated “${title}” from main.`)).toBeVisible();
    // The list is read again at the branch's new head, without a reload (#466).
    await expect(
      modules.getByRole('link', { name: moved.moduleTitle }),
    ).toBeVisible();
  });
});
