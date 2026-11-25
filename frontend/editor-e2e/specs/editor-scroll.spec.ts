import type { Page } from '@playwright/test';
import { moduleId, paragraph, unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

/**
 * The end of the line. `End` on macOS scrolls to the end of the document and leaves the caret
 * where it is (the platform's binding, which Playwright follows there); Cmd+Right is its end of
 * line.
 */
const LINE_END = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End';

/** How far the page (`main`, below lg) and the document's own scroller (from lg) are scrolled. */
const scrolled = (page: Page) =>
  page.evaluate(() => ({
    main: document.querySelector('main')!.scrollTop,
    canvas: document.querySelector('[data-slot="editor-scroller"]')!.scrollTop,
  }));

/**
 * Where the caret is, and the band of the screen it can be seen in: below the toolbar (stuck to
 * the top of `main` below lg, above the document's scroller from lg) and above the bottom of
 * `main` and of the document's scroller.
 */
const caretAndView = (page: Page) =>
  page.evaluate(() => {
    const range = getSelection()!.getRangeAt(0).cloneRange();
    range.collapse(false);
    const rects = range.getClientRects();
    const caret = rects.length
      ? rects[rects.length - 1]!
      : range.startContainer.parentElement!.getBoundingClientRect();
    const toolbar = document
      .querySelector('of-editor-toolbar')!
      .getBoundingClientRect();
    const main = document.querySelector('main')!.getBoundingClientRect();
    const canvas = document
      .querySelector('[data-slot="editor-scroller"]')!
      .getBoundingClientRect();
    return {
      top: caret.top,
      bottom: caret.bottom,
      viewTop: Math.max(toolbar.bottom, main.top, canvas.top),
      viewBottom: Math.min(main.bottom, canvas.bottom),
    };
  });

async function expectCaretInView(page: Page): Promise<void> {
  const at = await caretAndView(page);
  expect(at.top, 'the caret is below the toolbar').toBeGreaterThanOrEqual(
    at.viewTop,
  );
  expect(at.bottom, 'the caret is above the bottom edge').toBeLessThanOrEqual(
    at.viewBottom,
  );
}

// #886: typing scrolls only when the caret is out of sight, and then brings it clear of the
// sticky toolbar; at phone width (`main` scrolls, the toolbar sticks to its top) and at 1440 px.
test.describe('typing keeps the caret in view @area:module-editor @api:modules @narrow', () => {
  test('typing with the caret in view leaves the page still; out of view it comes back below the toolbar, and Enter at the bottom follows it', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Typing scroll'));
    const id = moduleId();
    await author.createModule(changeSet, {
      lang: 'en',
      moduleId: id,
      title: 'Typing scroll',
      blocks: [
        paragraph('first', 'Charge the battery before the first use.'),
        ...Array.from({ length: 30 }, (_, i) =>
          paragraph(`p${i}`, `Paragraph ${i + 1} of a long module.`),
        ),
        paragraph('last', 'The last paragraph.'),
      ],
    });

    await signIn(page, USERS.author);
    await page.goto(`/content/en/${id}?cs=${changeSet.id}`);
    await expect(page.getByText('Locked by you')).toBeVisible();
    const editor = page.getByRole('textbox', { name: 'Module Typing scroll' });
    const narrow = test.info().project.name === 'narrow';

    // The caret in the first paragraph, in view: typing never moves the page.
    await editor.getByText('Charge the battery').click();
    await page.keyboard.press(LINE_END);
    await expectCaretInView(page);
    const before = await scrolled(page);
    await page.keyboard.type(' Then unplug it.');
    await expect(editor).toContainText('first use. Then unplug it.');
    expect(await scrolled(page), 'nothing scrolled while typing').toEqual(
      before,
    );
    await expectCaretInView(page);

    // Scrolled away from the caret (at phone width the toolbar now sticks to the top of the
    // page): the next key brings the caret back, below the toolbar rather than under it.
    await page.evaluate(
      (selector) => {
        document.querySelector(selector)!.scrollTop = 1200;
      },
      narrow ? 'main' : '[data-slot="editor-scroller"]',
    );
    await page.keyboard.type(' Then');
    await expect(editor).toContainText('unplug it. Then');
    await expectCaretInView(page);
    if (narrow) {
      // The toolbar stays at the top of the page (within main's padding), over the document
      // scrolling under it, and marked stuck.
      const bar = page.locator('of-editor-toolbar');
      await expect(bar).toHaveAttribute('data-stuck');
      const { toolbar, main } = await page.evaluate(() => ({
        toolbar: document
          .querySelector('of-editor-toolbar')!
          .getBoundingClientRect().top,
        main: document.querySelector('main')!.getBoundingClientRect().top,
      }));
      expect(
        toolbar - main,
        'the toolbar sticks to the top of the page',
      ).toBeGreaterThanOrEqual(0);
      expect(toolbar - main).toBeLessThanOrEqual(24);
    }

    // The last paragraph just above the bottom edge of what scrolls: each Enter takes the caret
    // lower, and the page follows it.
    await page.evaluate(
      (selector) => {
        const scroller = document.querySelector(selector)!;
        const last = [...document.querySelectorAll('.doc-editor-content p')].at(
          -1,
        )!;
        scroller.scrollTop +=
          last.getBoundingClientRect().bottom -
          scroller.getBoundingClientRect().bottom +
          40;
      },
      narrow ? 'main' : '[data-slot="editor-scroller"]',
    );
    const last = editor.getByText('The last paragraph.');
    await last.click();
    await page.keyboard.press(LINE_END);
    const atBottom = await scrolled(page);
    for (let line = 1; line <= 10; line++) {
      await page.keyboard.press('Enter');
      await page.keyboard.type(`Line ${line}`);
    }
    await expect(editor).toContainText('Line 10');
    await expectCaretInView(page);
    const after = await scrolled(page);
    expect(
      narrow ? after.main : after.canvas,
      'the page followed the caret',
    ).toBeGreaterThan(narrow ? atBottom.main : atBottom.canvas);
  });
});
