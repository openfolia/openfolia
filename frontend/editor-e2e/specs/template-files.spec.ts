import type { Locator, Page } from '@playwright/test';

import { unique } from '../src/api.ts';
import {
  expect,
  expectPageFits,
  signIn,
  test,
  USERS,
} from '../src/fixtures.ts';

/** A template ID of the test's own (a slug), so no other test waits for its files' locks. */
const templateId = (prefix: string) =>
  unique(prefix)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');

/** The working copy's save of a template file, answered. */
const saved = (page: Page, path: string) =>
  page.waitForResponse(
    (r) =>
      r.request().method() === 'PUT' &&
      r.url().includes('/files/working-copy') &&
      new URL(r.url()).searchParams.get('path') === path,
  );

/** Puts the caret at the end of the code and types `text` as a person would. */
async function typeAtEnd(code: Locator, text: string): Promise<void> {
  await code.focus();
  await code.evaluate((area) => {
    const field = area as HTMLTextAreaElement;
    field.setSelectionRange(field.value.length, field.value.length);
  });
  await code.page().keyboard.type(text);
}

// Admin › Page design › an own template's files (#396): a new template made from the example in
// the author's own draft, its files edited in the code editor with the live preview following;
// a broken line is listed with its file and line, opens there, and the template compiles again
// once it is fixed; a file is made and deleted. Read-only for a role that may not change it.
test.describe('page design template files @area:admin @api:page-designs @api:change-sets', () => {
  // The broken draft is refused on purpose: its preview answers 422.
  test.use({ consoleAllow: [/status of 422.*\/preview\/pages\//] });

  test('makes a template, edits it with the preview, follows an error to its line and fixes it', async ({
    page,
    api,
  }) => {
    test.setTimeout(150_000);
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Template files'));
    const id = templateId('house');

    await signIn(page, USERS.author);
    await page.goto(`/admin/page-designs?cs=${changeSet.id}`);
    const templates = page.locator('[data-slot="own-templates"]');
    await expect(templates.locator('[data-template="example"]')).toBeVisible();

    // New template: from the example, in the revision.
    await templates.locator('[data-slot="new-template"]').click();
    const dialog = page.getByRole('dialog');
    const name = dialog.getByLabel('Name');
    await name.fill('Not a slug');
    await expect(dialog).toContainText('Use lowercase letters, digits');
    await expect(
      dialog.locator('[data-slot="new-template-create"]'),
    ).toBeDisabled();
    await name.fill(id);
    await dialog.locator('[data-slot="new-template-create"]').click();
    await expect(page).toHaveURL(
      new RegExp(`/admin/page-designs/templates/${id}\\?`),
    );

    const files = page.locator('[data-slot="template-files"]');
    for (const file of ['default.typ', 'design.typ', 'manual.typ']) {
      await expect(files.locator(`[data-file="${file}"]`)).toBeVisible();
    }
    await expect(files.locator('[data-file="manual.typ"]')).toHaveAttribute(
      'aria-current',
      'true',
    );
    const code = page.getByRole('textbox', { name: 'Code of manual.typ' });
    await expect(code).toHaveValue(/#import "design\.typ": \*/);
    const preview = page.locator('[data-slot="template-preview-page"] img');
    await expect(preview).toBeVisible({ timeout: 60_000 });
    const problems = page.locator('[data-slot="template-problems"]');
    await expect(problems).toContainText('The template compiles.', {
      timeout: 60_000,
    });
    await expectPageFits(page);

    // A broken line: saved, then listed with its file and line, the line marked.
    const original = await code.inputValue();
    const brokenLine = original.split('\n').length + 1;
    const save = saved(page, 'manual.typ');
    await typeAtEnd(code, '\n#let broken = (1).nope()');
    expect(
      (await save).request().postDataJSON().data.attributes.content.text,
    ).toContain('#let broken = (1).nope()');
    const problem = problems.locator('[data-slot="template-problem"]').first();
    await expect(problem).toContainText(`manual.typ:${brokenLine}:`, {
      timeout: 60_000,
    });
    await expect(problems).toContainText('The template does not compile');
    await expect(
      page.locator(
        `[data-slot="code-editor-gutter"] [data-marked]:text-is("${brokenLine}")`,
      ),
    ).toBeVisible();
    await expect(
      files.locator('[data-file="manual.typ"] [data-slot="file-draft"]'),
    ).toBeAttached();

    // The problem opens its line.
    await code.evaluate((area) =>
      (area as HTMLTextAreaElement).setSelectionRange(0, 0),
    );
    await problem.click();
    await expect(code).toBeFocused();
    await expect(page.locator('[data-slot="caret"]')).toContainText(
      `Line ${brokenLine},`,
    );

    // Fixed: it compiles again and the preview is back.
    const fixed = saved(page, 'manual.typ');
    await code.fill(original);
    await fixed;
    await expect(problems).toContainText('The template compiles.', {
      timeout: 60_000,
    });
    await expect(preview).toBeVisible();

    // A new file, then deleted again.
    await page.locator('[data-slot="template-new-file"]').click();
    const newFile = page.getByRole('dialog');
    const path = newFile.getByLabel('Path in the template');
    await path.fill('../outside.typ');
    await expect(newFile).toContainText('Use letters, digits');
    await path.fill('logo.png');
    await expect(newFile).toContainText('End the name with a text extension');
    await path.fill('parts/notice.typ');
    await newFile.locator('[data-slot="new-template-file-create"]').click();
    await expect(
      files.locator('[data-file="parts/notice.typ"]'),
    ).toHaveAttribute('aria-current', 'true');
    const notice = page.getByRole('textbox', {
      name: 'Code of parts/notice.typ',
    });
    await expect(notice).toHaveValue('');
    await page.locator('[data-slot="template-delete-file"]').click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete file' })
      .click();
    await expect(files.locator('[data-file="parts/notice.typ"]')).toHaveCount(
      0,
    );
    await expect(files.locator('[data-file="manual.typ"]')).toHaveAttribute(
      'aria-current',
      'true',
    );
    // The entry file cannot be deleted.
    await expect(
      page.locator('[data-slot="template-delete-file"]'),
    ).toHaveCount(0);
  });

  test.describe('past the folder’s caps', () => {
    // The 201st file is refused on purpose: its save answers 422 (#803).
    test.use({
      consoleAllow: [/status of 422.*\/(files\/working-copy|preview\/pages\/)/],
    });

    test('says why a file past the folder’s caps is not made', async ({
      page,
      api,
    }) => {
      test.setTimeout(150_000);
      const author = await api(USERS.author);
      const changeSet = await author.createChangeSet(unique('Template caps'));
      const id = templateId('full');
      // A template its drafts fill to MAX_TEMPLATE_FILES (200), made through the API.
      const paths = Array.from({ length: 200 }, (_, i) =>
        i === 0 ? 'manual.typ' : `parts/f${String(i).padStart(3, '0')}.typ`,
      );
      const make = async (path: string) => {
        await author.lock(changeSet.id, {
          type: 'template',
          templateId: id,
          path,
        });
        await author.json(
          author.send(
            'PUT',
            `/change-sets/${changeSet.id}/page-design-templates/${id}/files/working-copy?path=${encodeURIComponent(path)}`,
            {
              data: {
                type: 'WorkingCopy',
                attributes: {
                  content: { schemaVersion: 1, text: `// ${path}\n` },
                },
              },
              meta: { version: 0, baseCommit: changeSet.baseCommit },
            },
          ),
        );
      };
      for (let i = 0; i < paths.length; i += 10) {
        await Promise.all(paths.slice(i, i + 10).map(make));
      }

      await signIn(page, USERS.author);
      await page.goto(`/admin/page-designs/templates/${id}?cs=${changeSet.id}`);
      const files = page.locator('[data-slot="template-files"]');
      await expect(files.locator('[data-file="manual.typ"]')).toBeVisible();

      // One file more: refused, the toast says why; the file is not listed.
      await page.locator('[data-slot="template-new-file"]').click();
      const newFile = page.getByRole('dialog');
      await newFile.getByLabel('Path in the template').fill('extra.typ');
      await newFile.locator('[data-slot="new-template-file-create"]').click();
      await expect(
        page.getByText(
          'The file could not be made: The template would be too large: a template holds at most 200 files and 16,777,216 bytes together.',
          { exact: false },
        ),
      ).toBeVisible();
      await expect(files.locator('[data-file="extra.typ"]')).toHaveCount(0);
      await expectPageFits(page);
    });
  });

  test.describe('read-only', () => {
    // A template that is not there is a 404 on purpose.
    test.use({
      consoleAllow: [/status of 404.*\/page-design-templates\/nowhere\//],
    });

    test('shows a template read-only, with why, to a role that may not change it', async ({
      page,
    }) => {
      await signIn(page, USERS.reviewer);
      await page.goto('/admin/page-designs/templates/example');
      const code = page.getByRole('textbox', { name: 'Code of manual.typ' });
      await expect(code).toHaveValue(/#import "design\.typ": \*/);
      await expect(code).toHaveAttribute('readonly', '');
      await expect(page.locator('[data-slot="read-reason"]')).toBeVisible();
      await expect(page.locator('[data-slot="template-new-file"]')).toHaveCount(
        0,
      );
      await expect(
        page.locator('[data-slot="template-delete-file"]'),
      ).toHaveCount(0);
      // Its files list the folder; a template that is not there says so.
      await expect(
        page.locator('[data-slot="template-files"] [data-file="design.typ"]'),
      ).toBeVisible();
      await page.goto('/admin/page-designs/templates/nowhere');
      await expect(
        page.locator('[data-slot="template-missing"]'),
      ).toBeVisible();
    });
  });
});
