import { expect, signIn, test, USERS } from './fixtures.ts';

// "Update guides" (#908): the sample update guide in the builder, a step in its dialog and the
// new-manual dialog making one, in a revision of the shot's own.

test.describe('update guides', () => {
  test('update guide', async ({ page, save, text, l, as }) => {
    const revision = await (
      await as(USERS.admin)
    ).createChangeSet(text.revision);
    await signIn(page, USERS.admin);
    // The step rows' edit buttons show once the builder holds the guide's lock.
    const locked = page.waitForResponse(
      (r) => r.url().includes('/api/locks') && r.request().method() === 'GET',
    );
    await page.goto(`/manuals?manual=software-update&cs=${revision.id}`);
    await locked;
    const steps = page.getByTestId('guide-steps');
    await expect(steps.getByTestId('guide-step').first()).toBeVisible();
    await expect(
      page
        .getByTestId('guide-preview')
        .getByTestId('guide-preview-step')
        .first(),
    ).toBeVisible();
    await save('update-guide');

    await steps
      .locator('section[data-version="2.0"] [data-slot=step-title]')
      .first()
      .click();
    const form = page.getByRole('dialog', {
      name: l('manuals.guide.form.editTitle'),
    });
    await expect(form.getByTestId('update-step-form')).toBeVisible();
    await save('update-guide-step');
    await page.keyboard.press('Escape');
    await expect(form).toBeHidden();

    await page.getByTestId('manual-switcher').click();
    await page.getByTestId('manual-new').click();
    const dialog = page.getByRole('dialog', { name: l('manuals.new.title') });
    await dialog
      .getByLabel(l('manuals.new.titleField'), { exact: true })
      .fill(text.guide);
    await dialog
      .getByRole('radio', { name: l('manuals.new.updateGuide') })
      .click();
    await dialog
      .getByLabel(l('manuals.new.versions'), { exact: true })
      .fill('1.0, 2.0, 3.0');
    await expect(dialog.getByTestId('new-manual-guide')).toBeVisible();
    await save('update-guide-new');
  });
});
