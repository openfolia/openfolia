import type { Page, Route } from '@playwright/test';
import {
  type Api,
  type Block,
  moduleId,
  paragraph,
  unique,
} from '../src/api.ts';
import { chooseSegment, expect, signIn, test, USERS } from '../src/fixtures.ts';

// The writing aids in the module editor (#247), on the sample's terms and style rules
// (`addSampleTerms`): "loader" is a forbidden variant of `charger`, "charging unit" an allowed
// one, `battery` an approved term, "in a dry place" the phrase of the style rule `dry-place`.
// Every test edits a module of its own in a revision of its own (abandoned after the test).

async function setUp(
  api: (user: typeof USERS.author) => Promise<Api>,
  title: string,
  blocks: Block[] = [paragraph('p1', 'Plug it in.')],
) {
  const author = await api(USERS.author);
  const changeSet = await author.createChangeSet(unique(title));
  const id = moduleId();
  await author.createModule(changeSet, {
    lang: 'en',
    moduleId: id,
    title,
    blocks,
  });
  return { author, changeSet, id };
}

/** Opens the module, waits for its lock and for the terms the checks read. */
async function open(page: Page, id: string, changeSet: string) {
  await signIn(page, USERS.author);
  const terms = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/terms' && r.ok(),
  );
  await page.goto(`/content/en/${id}?cs=${changeSet}`);
  await expect(page.getByText('Locked by you')).toBeVisible();
  await terms;
}

const editor = (page: Page, title: string) =>
  page.getByRole('textbox', { name: `Module ${title}` });

/** The caret at the end of the paragraph reading `text`. */
async function typeAfter(
  page: Page,
  title: string,
  text: string,
  typed: string,
) {
  await editor(page, title).getByText(text).click();
  await page.keyboard.press('End');
  await page.keyboard.type(typed);
}

const saved = (page: Page) =>
  expect(page.getByRole('status').filter({ hasText: /^Saved/ })).toBeVisible();

test.describe('writing aids @area:doc-editor @area:module-editor @api:terms @api:style-review', () => {
  test('marks a forbidden term while typing, replaces it in one step, and Undo brings it back', async ({
    page,
    api,
  }) => {
    const title = 'Charging aids';
    const { id, changeSet } = await setUp(api, title);
    await open(page, id, changeSet.id);
    await typeAfter(page, title, 'Plug it in.', ' Then switch on the loader.');

    // Underlined (dotted, with the field's icon), not by colour alone.
    const finding = editor(page, title).locator('.doc-editor-finding');
    await expect(finding).toHaveText('loader');
    await expect(finding).toHaveAttribute('data-severity', 'warning');
    await expect(
      editor(page, title).locator('.doc-editor-has-finding'),
    ).toHaveCount(1);

    // Listed in the Suggestions tab, with the fix.
    await chooseSegment(page, 'Side panel', 'Suggestions');
    const checks = page.locator('[data-slot="writing-checks-panel"]');
    const row = checks.locator('[data-slot="suggestion"]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('“loader” is a forbidden term.');
    await expect(row.locator('ins')).toHaveText('charger');

    // Alt+Enter in the word: the popover, focused on Replace; Escape closes it, the caret back
    // in the text where it was.
    await finding.click();
    await page.keyboard.press('Alt+Enter');
    const popover = page.getByRole('dialog', { name: 'Writing check' });
    await expect(
      popover.getByRole('button', { name: 'Replace' }),
    ).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(editor(page, title)).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.type(' Now.');
    await expect(editor(page, title)).toContainText(
      'Then switch on the loader. Now.',
    );
    for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
    await finding.click();
    await page.keyboard.press('Alt+Enter');
    await expect(popover).toContainText('Reads as a machine that loads goods.');
    await expect(
      popover.getByRole('button', { name: 'Replace' }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(popover).toBeHidden();
    await expect(editor(page, title)).toContainText(
      'Plug it in. Then switch on the charger.',
    );
    await expect(finding).toHaveCount(0);
    await expect(row).toHaveCount(0);

    // One undo step takes the replacement back, and the finding with it.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(editor(page, title)).toContainText(
      'Plug it in. Then switch on the loader.',
    );
    await expect(finding).toHaveText('loader');
    await saved(page);
  });

  test('marks a finding in a safety notice with its icon inside the notice, its labels kept', async ({
    page,
    api,
  }) => {
    const title = 'Safety aids';
    const { id, changeSet } = await setUp(api, title, [
      {
        type: 'safety',
        id: 'drop',
        severity: 'warning',
        hazard: [{ type: 'text', text: 'A falling loader' }],
        symbols: [],
        blocks: [
          paragraph('crush', 'Crushing.'),
          {
            type: 'list',
            id: 'measures',
            ordered: false,
            items: [
              {
                id: 'stand',
                content: [
                  { type: 'text', text: 'Never stand under the loader.' },
                ],
                blocks: [],
              },
            ],
          } as Block,
        ],
      } as Block,
    ]);
    await open(page, id, changeSet.id);
    const notice = editor(page, title).locator('of-safety-notice');
    // The hazard and a list item in the notice: each icon all inside the notice's frame, which
    // clips what leaves it.
    const icons = notice.locator('.doc-editor-finding-icon');
    await expect(icons).toHaveCount(2);
    const frame = (await notice.boundingBox())!;
    for (const icon of await icons.all()) {
      const box = (await icon.boundingBox())!;
      expect(box.width).toBeGreaterThan(0);
      expect(box.x).toBeGreaterThanOrEqual(frame.x);
      expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
    }
    // The field's label is still the label.
    await expect(notice).toContainText('A falling loader');
    const label = await notice
      .locator('[data-node="hazard"]')
      .evaluate((el) => getComputedStyle(el, '::after').content);
    expect(label).not.toBe('none');
    expect(label).not.toBe('""');
  });

  test('ignores a finding here from the side panel, and Show selects it in the text', async ({
    page,
    api,
  }) => {
    const title = 'Storage aids';
    const { id, changeSet } = await setUp(api, title, [
      paragraph('p1', 'Store the battery in a dry place.'),
    ]);
    await open(page, id, changeSet.id);
    await chooseSegment(page, 'Side panel', 'Suggestions');
    const row = page
      .locator('[data-slot="writing-checks-panel"] [data-slot="suggestion"]')
      .filter({ hasText: 'Name the storage conditions' });
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { name: 'Show' }).click();
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe('in a dry place');
    await row.getByRole('button', { name: 'Ignore here' }).click();
    await expect(row).toHaveCount(0);
    await expect(
      editor(page, title).locator('.doc-editor-finding'),
    ).toHaveCount(0);
    // The text is as it was.
    await expect(editor(page, title)).toContainText(
      'Store the battery in a dry place.',
    );
  });

  test('completes a term with Tab and links it; the term picker inserts one; both round-trip through a save point', async ({
    page,
    api,
  }) => {
    const title = 'Term aids';
    const { author, id, changeSet } = await setUp(api, title);
    await open(page, id, changeSet.id);

    // Typing the start of a preferred variant shows the rest; Tab puts it in, linked.
    await typeAfter(page, title, 'Plug it in.', ' Use the char');
    const ghost = editor(page, title).locator('.doc-editor-term-ghost');
    await expect(ghost).toContainText('ger');
    await page.keyboard.press('Tab');
    await expect(ghost).toHaveCount(0);
    const linked = editor(page, title).locator('[data-mark="term"]');
    await expect(linked).toHaveText('charger');

    // "/" › Term: the picker lists approved terms; the one chosen goes in linked.
    await page.keyboard.type(' and the ');
    await page.keyboard.type('/term');
    await page.getByRole('option', { name: /^Term/ }).click();
    const picker = page.getByRole('dialog', { name: 'Insert a term' });
    await picker.getByRole('searchbox', { name: 'Search terms' }).fill('batt');
    const battery = picker.locator('[data-term-row][data-term="battery"]');
    await expect(battery).toContainText('The rechargeable energy store');
    await battery.click();
    await expect(picker).toBeHidden();
    await expect(linked).toHaveText(['charger', 'battery']);

    // A linked term shows its definition while the caret rests in it.
    await linked.first().click();
    await expect(page.getByRole('dialog', { name: 'Term link' })).toContainText(
      'The device that charges',
    );

    await saved(page);
    // Leaving the module makes the save point: both links are on the revision's branch.
    await page
      .getByRole('navigation', { name: 'Breadcrumb' })
      .getByRole('link', { name: 'Content' })
      .click();
    await expect(async () => {
      const { data } = await author.json(
        author.get(
          `/modules/en/${id}?ref=${encodeURIComponent(changeSet.branch)}`,
        ),
      );
      const content = JSON.stringify(data.attributes.blocks);
      expect(content).toContain('"termId":"charger"');
      expect(content).toContain('"termId":"battery"');
    }).toPass({ timeout: 20_000 });

    // Opened again, the links are there.
    await page.goto(`/content/en/${id}?cs=${changeSet.id}`);
    await expect(page.getByText('Locked by you')).toBeVisible();
    await expect(editor(page, title).locator('[data-mark="term"]')).toHaveText([
      'charger',
      'battery',
    ]);
  });

  test('marks the style review’s suggestion in the text, and applies it from there', async ({
    page,
    api,
  }) => {
    const title = 'Review aids';
    const { id, changeSet } = await setUp(api, title, [
      paragraph('p1', 'Open the valve in order to drain.'),
    ]);
    // The run's API has no style reviewer: its status and the review are mocked (no model call).
    await page.route(
      (url) => url.pathname === '/api/style-review',
      (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/vnd.api+json',
          body: JSON.stringify({
            data: {
              type: 'StyleReviewStatus',
              id: 'style-review',
              attributes: { configured: true },
            },
          }),
        }),
    );
    await page.route(
      (url) => url.pathname.endsWith(`/modules/en/${id}/style-review`),
      (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/vnd.api+json',
          body: JSON.stringify({
            data: {
              type: 'StyleReview',
              id: `en/${id}`,
              attributes: {
                lang: 'en',
                moduleId: id,
                suggestions: [
                  {
                    id: 's1',
                    blockId: 'p1',
                    field: 'content',
                    range: { start: 15, end: 26 },
                    original: 'in order to',
                    replacement: 'to',
                    message: 'Shorter.',
                    rule: 'model',
                  },
                ],
              },
              meta: { version: 1, baseCommit: 'a'.repeat(40), dropped: 0 },
            },
          }),
        }),
    );
    await open(page, id, changeSet.id);
    await chooseSegment(page, 'Side panel', 'Suggestions');
    await page.getByRole('button', { name: 'Review style' }).click();
    const mark = editor(page, title).locator('.doc-editor-suggestion-mark');
    await expect(mark).toHaveText('in order to');
    await mark.click();
    await page.keyboard.press('Alt+Enter');
    const popover = page.getByRole('dialog', { name: 'Style suggestion' });
    await expect(popover).toContainText('Shorter.');
    await popover.getByRole('button', { name: 'Apply' }).click();
    await expect(editor(page, title)).toContainText('Open the valve to drain.');
    await expect(mark).toHaveCount(0);
  });
});

test.describe('writing aids on a large module @area:doc-editor @api:terms', () => {
  // The budget (#247, `frontend/editor/README.md`): on a module of 400 paragraphs (about 24,000
  // words, a long chapter), a key typed is on screen in a frame, the checks run only on the
  // field that changed, after a pause, and a check pass stays far below a frame.
  test('keeps typing fast: each key on screen within its budget, each check pass small', async ({
    page,
    api,
  }) => {
    test.slow();
    const title = 'Large aids';
    const sentence =
      'Store the battery in a dry room and charge it with the charger before the first shift starts. ';
    const blocks = Array.from({ length: 400 }, (_, i) =>
      paragraph(
        `p${i}`,
        i % 50 === 0
          ? `${sentence.repeat(3)}Plug in the loader.`
          : sentence.repeat(4),
      ),
    );
    const { id, changeSet } = await setUp(api, title, blocks);
    await open(page, id, changeSet.id);
    const content = editor(page, title);
    // The first pass over the whole module has found the eight forbidden terms.
    await expect(content.locator('.doc-editor-finding')).toHaveCount(8);

    await page.evaluate(() => {
      const w = window as unknown as { keyLatency: number[] };
      w.keyLatency = [];
      performance.clearMeasures('openfolia:writing-check');
      document.addEventListener(
        'keydown',
        () => {
          const start = performance.now();
          // On screen: the next frame painted.
          requestAnimationFrame(() =>
            setTimeout(() => w.keyLatency.push(performance.now() - start), 0),
          );
        },
        true,
      );
    });
    await content.locator('p').nth(200).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Keep the loader away from water. ', {
      delay: 40,
    });
    await expect(content.locator('.doc-editor-finding')).toHaveCount(9);

    const { keys, checks } = await page.evaluate(() => ({
      keys: (window as unknown as { keyLatency: number[] }).keyLatency,
      checks: performance
        .getEntriesByName('openfolia:writing-check')
        .map((m) => ({
          duration: m.duration,
          checked: (m as PerformanceMeasure).detail?.checked as number,
        })),
    }));
    const sorted = [...keys].sort((a, b) => a - b);
    const at = (q: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
    const numbers = {
      keys: keys.length,
      medianMs: Math.round(at(0.5)),
      p95Ms: Math.round(at(0.95)),
      checkPasses: checks.length,
      maxCheckMs: Math.round(Math.max(...checks.map((c) => c.duration))),
      maxFieldsChecked: Math.max(...checks.map((c) => c.checked)),
    };
    // The numbers, in the run's output (the PR reports them).
    console.log(`writing aids typing latency: ${JSON.stringify(numbers)}`);
    test.info().annotations.push({
      type: 'typing latency',
      description: JSON.stringify(numbers),
    });
    expect(keys.length).toBeGreaterThanOrEqual(30);
    // Debounced: far fewer passes than keys, and each one only the field typed in.
    expect(checks.length).toBeLessThanOrEqual(keys.length / 3);
    expect(numbers.maxFieldsChecked).toBeLessThanOrEqual(2);
    expect(numbers.maxCheckMs).toBeLessThanOrEqual(16);
    expect(numbers.medianMs).toBeLessThanOrEqual(50);
    expect(numbers.p95Ms).toBeLessThanOrEqual(100);
  });
});
