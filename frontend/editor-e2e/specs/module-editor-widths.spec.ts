import type { Page } from '@playwright/test';
import {
  type Api,
  moduleId,
  paragraph,
  unique,
  type UserId,
} from '../src/api.ts';
import {
  chooseSegment,
  expect,
  expectNoSideways,
  signIn,
  test,
  USERS,
} from '../src/fixtures.ts';

/** A paragraph long enough to wrap over several lines at any width. */
const PROSE =
  'Charge the battery fully before the first use and keep the charger away from water, ' +
  'heat and direct sunlight, so the cells keep their capacity for many years of daily work ' +
  'in the warehouse and on the road between the sites.';

/** How many characters the first line of the long paragraph holds. */
const charsOnFirstLine = (page: Page) =>
  page.evaluate(
    (start) => {
      const p = [...document.querySelectorAll('.doc-editor-content p')].find(
        (el) => el.textContent?.startsWith(start),
      );
      if (!p) return 0;
      // The text may be split over several nodes (a writing check's marks).
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let first: number | null = null;
      let count = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (let i = 0; i < node.textContent!.length; i++) {
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const top = range.getBoundingClientRect().top;
          first ??= top;
          if (Math.abs(top - first) > 2) return count;
          count++;
        }
      }
      return count;
    },
    PROSE.slice(0, 24),
  );

/** Sets the sidebar's state from the first load on (the shell's stored choice). */
async function sidebar(page: Page, mode: 'expanded' | 'collapsed') {
  await page.addInitScript((m) => {
    localStorage.setItem('openfolia.sidebar', m);
  }, mode);
}

async function openModule(page: Page, api: (user: UserId) => Promise<Api>) {
  const author = await api(USERS.author);
  const changeSet = await author.createChangeSet(unique('Widths'));
  const id = moduleId();
  await author.createModule(changeSet, {
    lang: 'en',
    moduleId: id,
    title: 'Battery care and charging between the sites of the warehouse',
    blocks: [
      paragraph('prose', PROSE),
      ...Array.from({ length: 24 }, (_, i) =>
        paragraph(`p${i}`, `Paragraph ${i + 1} of a long module.`),
      ),
    ],
  });
  await signIn(page, USERS.author);
  await page.goto(`/content/en/${id}?cs=${changeSet.id}`);
  await expect(page.getByText('Locked by you')).toBeVisible();
}

// #889: between the phone layout and the full three columns, the text column stays readable
// (at least about 45 characters a line), with the sidebar open or collapsed to icons.
test.describe('module editor widths @area:module-editor @api:modules', () => {
  for (const mode of ['expanded', 'collapsed'] as const) {
    test(`the text holds at least 45 characters a line from 1024 to 1920 px, sidebar ${mode}`, async ({
      page,
      api,
    }) => {
      await sidebar(page, mode);
      await page.setViewportSize({ width: 1024, height: 768 });
      await openModule(page, api);
      for (const [width, height] of [
        [1024, 768],
        [1180, 820],
        [1280, 720],
        [1440, 900],
        [1920, 1080],
      ] as const) {
        await page.setViewportSize({ width, height });
        await expect
          .poll(() => charsOnFirstLine(page), {
            message: `characters a line at ${width} px`,
          })
          .toBeGreaterThanOrEqual(45);
        await expectNoSideways(page);
        // The details stay at hand: beside the text or below it.
        await expect(
          page.getByRole('complementary', { name: 'Module details' }),
        ).toBeAttached();
      }
    });
  }

  test('with the sidebar open at 1280 px the outline is a tab of the side panel, and its column comes back when there is room', async ({
    page,
    api,
  }) => {
    await sidebar(page, 'expanded');
    await page.setViewportSize({ width: 1280, height: 720 });
    await openModule(page, api);
    const outline = page.getByRole('heading', { name: 'Outline' });
    const details = page.getByRole('complementary', { name: 'Module details' });
    // No column of its own: a tab beside the details, which stay the first shown.
    await expect(outline).toBeHidden();
    await expect(details.getByLabel('Title')).toBeVisible();
    await chooseSegment(page, 'Side panel', 'Outline');
    await expect(
      details.getByRole('heading', { name: 'Outline' }),
    ).toBeVisible();
    await expect(page).toHaveURL(/side=outline/);
    // An entry still takes the caret to its block.
    await details
      .getByRole('button', { name: /Paragraph 20 of a long module/ })
      .click();
    await expect(
      page.locator('.doc-editor-content p', {
        hasText: 'Paragraph 20 of a long module.',
      }),
    ).toBeInViewport();

    // Room for it again (a wider window): its own column, the tab gone, the details shown.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(outline).toBeVisible();
    await expect(details.getByRole('heading', { name: 'Outline' })).toHaveCount(
      0,
    );
    await expect(
      page
        .getByRole('radiogroup', { name: 'Side panel' })
        .getByRole('radio', { name: 'Outline' }),
    ).toHaveCount(0);
    await expect(details.getByLabel('Title')).toBeVisible();

    // The preview opens beside the text, in the details' place, not as a sheet.
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('button', { name: 'Preview' }).first().click();
    await expect(page.locator('iframe[title^="Preview of"]')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('with the sidebar open at 1024 px the outline and the details go below the text, and the toolbar sticks while the page scrolls', async ({
    page,
    api,
  }) => {
    await sidebar(page, 'expanded');
    await page.setViewportSize({ width: 1024, height: 768 });
    await openModule(page, api);
    const editor = page.locator('of-block-editor');
    const box = (await editor.boundingBox())!;
    const outlineBox = (await page.locator('of-module-outline').boundingBox())!;
    expect(
      outlineBox.y,
      'the outline is below the text',
    ).toBeGreaterThanOrEqual(box.y + box.height);
    await expect(
      page
        .getByRole('radiogroup', { name: 'Side panel' })
        .getByRole('radio', { name: 'Outline' }),
    ).toHaveCount(0);
    // The page scrolls, not the document's own scroller, and the toolbar stays at its top.
    await page.evaluate(() => {
      document.querySelector('main')!.scrollTop = 600;
    });
    await expect(page.locator('of-editor-toolbar')).toHaveAttribute(
      'data-stuck',
    );
    await expectNoSideways(page);

    // No room for the preview beside the text either: it opens as a sheet over the page.
    await page.evaluate(() => {
      document.querySelector('main')!.scrollTop = 0;
    });
    await page.getByRole('button', { name: 'Preview' }).first().click();
    await expect(
      page.getByRole('dialog').locator('iframe[title^="Preview of"]'),
    ).toBeVisible();
  });
});
