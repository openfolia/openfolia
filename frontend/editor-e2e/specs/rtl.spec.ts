import { unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

// Right-to-left languages (#458), on the sample's Arabic and Hebrew (`addSampleRtlLanguages`:
// the `display` module in both, its direction from the script, nothing else configured). The
// module `display` is this file's alone: the edit below locks it in a revision of its own.
test.describe('right-to-left languages @area:module-editor @area:admin @area:manuals @api:modules @api:preview', () => {
  test('edits an Arabic module right to left, the toolbar left to right, and previews it right to left', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Arabic display'));
    await signIn(page, USERS.author);
    await page.goto(`/content/ar/display?cs=${changeSet.id}&preview=open`);
    await expect(page.getByText('Locked by you')).toBeVisible();

    // The document area is Arabic, right to left; the toolbar around it is the UI's.
    const editor = page.getByRole('textbox', { name: 'Module الشاشة' });
    await expect(editor).toHaveAttribute('lang', 'ar');
    await expect(editor).toHaveAttribute('dir', 'rtl');
    const toolbar = page.getByRole('toolbar').first();
    await expect(toolbar).toBeVisible();
    expect(await toolbar.evaluate((el) => getComputedStyle(el).direction)).toBe(
      'ltr',
    );
    // Mixed-direction text: the Latin product name's attribute chip, the number, the code span.
    await expect(editor.getByText('E-104').first()).toBeVisible();
    // The text starts at the right: the paragraph's start edge is the document's right side.
    const box = (await editor.boundingBox())!;
    const line = (await editor
      .getByText('مستوى شحن البطارية', { exact: false })
      .boundingBox())!;
    expect(box.x + box.width - (line.x + line.width)).toBeLessThan(
      box.width / 4,
    );

    // Typing goes into the Arabic text and is saved.
    await editor.getByText('اترك الجهاز حتى يبرد قبل لمسه.').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' 5 دقائق');
    await expect(
      page.getByRole('status').filter({ hasText: /^Saved/ }),
    ).toBeVisible();

    // The preview is a page of its own, right to left, the code isolated left to right.
    const preview = page
      .locator('of-preview-frame:not(.opacity-0) iframe')
      .contentFrame();
    await expect(preview.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(preview.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(preview.locator('code.of-code').first()).toHaveAttribute(
      'dir',
      'ltr',
    );
    await expect(
      preview.getByText('اترك الجهاز حتى يبرد قبل لمسه. 5 دقائق'),
    ).toBeVisible();
  });

  test('shows the Hebrew module right to left, read only, beside a left-to-right language', async ({
    page,
  }) => {
    await signIn(page, USERS.reader);
    await page.goto('/content/he/display');
    const editor = page.getByRole('textbox', { name: 'Module תצוגה' });
    await expect(editor).toHaveAttribute('dir', 'rtl');
    await expect(editor).toHaveAttribute('lang', 'he');
    // The same module in English is left to right.
    await page.goto('/content/en/display');
    const english = page.getByRole('textbox', { name: 'Module Display' });
    await expect(english).toHaveAttribute('dir', 'ltr');
    await expect(english).toHaveAttribute('lang', 'en');
  });

  test.describe('a missing translation', () => {
    // The module's read is answered 404 on purpose: the browser reports it.
    test.use({ consoleAllow: [/status of 404.*\/api\/modules\/ar\/charging/] });

    test('a module with no translation in a right-to-left language is not there, and no document area is set', async ({
      page,
    }) => {
      await signIn(page, USERS.reader);
      await page.goto('/content/ar/charging');
      await expect(page.getByText('This module is not there')).toBeVisible();
      await expect(page.locator('.doc-editor-content')).toHaveCount(0);
    });
  });

  test('lists each language with its direction in the settings', async ({
    page,
  }) => {
    await signIn(page, USERS.admin);
    await page.goto('/admin/settings/languages');
    const direction = (tag: string) =>
      page.locator(`[data-language="${tag}"] [data-slot="direction"]`);
    await expect(direction('ar')).toHaveText('Right to left');
    await expect(direction('he')).toHaveText('Right to left');
    await expect(direction('en')).toHaveText('Left to right');
    await expect(direction('de')).toHaveText('Left to right');
  });
});
