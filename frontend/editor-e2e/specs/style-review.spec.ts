import type { Page, Route } from '@playwright/test';
import { type Api, type Block, moduleId, unique } from '../src/api.ts';
import { chooseSegment, expect, signIn, test, USERS } from '../src/fixtures.ts';

// The style review in the module editor's Suggestions tab (#247's model suggestions, #573): a
// suggestion on an image callout's legend is applied to that callout only, shown in its image's
// callout panel, with Undo; one made for text that changed since is refused. The run's API has no
// style reviewer, so whether it has one (`GET /style-review`, #247) and the review's answer are
// route-mocked here (no model call); without the mock, the real API says it has none and
// "Review style" is not shown at all.

const text = (value: string) => [{ type: 'text', text: value }];

/** A 1 × 1 PNG: drawn at the image's width, square. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** A module of the test's own with an image of two callouts and a paragraph, in a revision of its own. */
async function setUp(api: (user: typeof USERS.author) => Promise<Api>) {
  const author = await api(USERS.author);
  const changeSet = await author.createChangeSet(unique('Style review'));
  const id = moduleId();
  const asset = await author.uploadImage(changeSet.id, PIXEL);
  const blocks: Block[] = [
    {
      type: 'image',
      id: 'pump',
      asset,
      alt: 'The pump',
      width: 60,
      callouts: [
        {
          id: 'pump-1',
          anchor: { x: 0.2, y: 0.3 },
          legend: text('Utilize the outlet'),
        },
        {
          id: 'pump-2',
          anchor: { x: 0.7, y: 0.6 },
          legend: text('Utilize the inlet'),
        },
      ],
    } as Block,
    {
      type: 'paragraph',
      id: 'see',
      content: text('Open the valve in order to drain.'),
    } as Block,
  ];
  await author.createModule(changeSet, {
    lang: 'en',
    moduleId: id,
    title: 'The pump',
    blocks,
  });
  return { author, changeSet, id };
}

const suggestion = (
  id: string,
  blockId: string,
  field: string,
  start: number,
  original: string,
  replacement: string | null,
  message: string,
) => ({
  id,
  blockId,
  field,
  range: { start, end: start + original.length },
  original,
  message,
  replacement,
  rule: 'model',
});

/** The style review answers with `suggestions` for this module, without the API. */
async function mockReview(page: Page, id: string, suggestions: unknown[]) {
  const asked: string[] = [];
  await page.route(
    (url) => url.pathname.endsWith('/api/style-review'),
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
    (route: Route) => {
      asked.push(route.request().method());
      return route.fulfill({
        status: 200,
        contentType: 'application/vnd.api+json',
        body: JSON.stringify({
          data: {
            type: 'StyleReview',
            id: `en/${id}`,
            attributes: { lang: 'en', moduleId: id, suggestions },
            meta: { version: 1, baseCommit: 'a'.repeat(40), dropped: 0 },
          },
        }),
      });
    },
  );
  return asked;
}

async function open(page: Page, id: string, changeSet: string) {
  await signIn(page, USERS.author);
  await page.goto(`/content/en/${id}?cs=${changeSet}`);
  await expect(page.getByText('Locked by you')).toBeVisible();
  await chooseSegment(page, 'Side panel', 'Suggestions');
}

const panel = (page: Page) => page.locator('[data-slot="suggestions-panel"]');
const rows = (page: Page) => panel(page).locator('[data-slot="suggestion"]');
const markers = (page: Page) =>
  page
    .getByRole('textbox', { name: 'Module The pump' })
    .locator(
      '[data-node="image"] [data-slot="callout-overlay"] [data-slot="callout-marker"]',
    );

test.describe('style review @area:module-editor @api:style-review @api:change-sets', () => {
  test('suggests a change to a callout legend, applies it to that callout only, and Undo takes it back', async ({
    page,
    api,
  }) => {
    const { author, changeSet, id } = await setUp(api);
    const asked = await mockReview(page, id, [
      suggestion(
        's1',
        'pump-1',
        'legend',
        0,
        'Utilize',
        'Use',
        'Prefer the plain word.',
      ),
      suggestion('s2', 'see', 'content', 15, 'in order to', 'to', 'Shorter.'),
    ]);
    await open(page, id, changeSet.id);
    await panel(page).getByRole('button', { name: 'Review style' }).click();
    await expect(rows(page)).toHaveCount(2);
    expect(asked).toEqual(['POST']);

    const legend = rows(page).filter({ hasText: 'Callout legend' });
    await expect(legend).toContainText('Prefer the plain word.');
    await expect(legend.locator('del')).toHaveText('Utilize');
    await expect(legend.locator('ins')).toHaveText('Use');
    await legend.getByRole('button', { name: 'Apply' }).click();

    // The image's callout panel opens on that callout, and only its legend changed.
    const image = page.locator('[data-node="image"]');
    const row = image.locator('[data-callout-row="pump-1"]');
    await expect(
      row.getByRole('textbox', { name: /Legend of callout/ }),
    ).toHaveText('Use the outlet');
    await expect(image.locator('[data-callout-row="pump-2"]')).toContainText(
      'Utilize the inlet',
    );
    await expect(rows(page)).toHaveCount(1);
    await expect(markers(page)).toHaveCount(2);

    // Undo, in the toast: the legend and the suggestion come back.
    await page
      .locator('of-toaster')
      .getByRole('button', { name: 'Undo' })
      .click();
    await expect(
      row.getByRole('textbox', { name: /Legend of callout/ }),
    ).toHaveText('Utilize the outlet');
    await expect(rows(page)).toHaveCount(2);

    // Applied again, it is saved into the working copy, with the other callout untouched.
    await rows(page)
      .filter({ hasText: 'Callout legend' })
      .getByRole('button', { name: 'Apply' })
      .click();
    await expect(rows(page)).toHaveCount(1);
    await expect(async () => {
      const copy = await author.json(
        author.get(
          `/change-sets/${changeSet.id}/modules/en/${id}/working-copy`,
        ),
      );
      const blocks = copy.data.attributes.content.blocks as {
        callouts?: { id: string; legend: { text: string }[] }[];
      }[];
      expect(
        blocks[0]?.callouts?.map((c) => [
          c.id,
          c.legend.map((r) => r.text).join(''),
        ]),
      ).toEqual([
        ['pump-1', 'Use the outlet'],
        ['pump-2', 'Utilize the inlet'],
      ]);
    }).toPass({ timeout: 15_000 });
  });

  test('refuses a suggestion once its legend changed since the review', async ({
    page,
    api,
  }) => {
    const { changeSet, id } = await setUp(api);
    await mockReview(page, id, [
      suggestion(
        's1',
        'pump-2',
        'legend',
        0,
        'Utilize',
        'Use',
        'Prefer the plain word.',
      ),
    ]);
    await open(page, id, changeSet.id);
    await panel(page).getByRole('button', { name: 'Review style' }).click();
    const legend = rows(page).filter({ hasText: 'Callout legend' });
    await expect(legend).toHaveCount(1);

    // "Show" opens the callout panel on that callout; typing there changes its legend.
    await legend.getByRole('button', { name: 'Show' }).click();
    const field = page
      .locator('[data-node="image"] [data-callout-row="pump-2"]')
      .getByRole('textbox', { name: /Legend of callout/ });
    await expect(field).toBeVisible();
    await field.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' valve');
    await expect(field).toHaveText('Utilize the inlet valve');

    await legend.getByRole('button', { name: 'Apply' }).click();
    await expect(
      page
        .locator('of-toaster')
        .getByText('The text changed since the review', { exact: false }),
    ).toBeVisible();
    await expect(field).toHaveText('Utilize the inlet valve');
    await expect(
      legend.locator('[data-slot="suggestion-stale"]'),
    ).toBeVisible();
    await expect(legend.getByRole('button', { name: 'Apply' })).toHaveCount(0);
    await legend.getByRole('button', { name: 'Dismiss' }).click();
    await expect(rows(page)).toHaveCount(0);
  });

  test('without a style reviewer on the server, Review style is not offered at all', async ({
    page,
    api,
  }) => {
    const { changeSet, id } = await setUp(api);
    const asked = page.waitForResponse((r) =>
      new URL(r.url()).pathname.endsWith('/api/style-review'),
    );
    await open(page, id, changeSet.id);
    expect(await (await asked).json()).toMatchObject({
      data: { attributes: { configured: false } },
    });
    // The writing checks stay; the style review's section is not there.
    await expect(
      page.locator('[data-slot="writing-checks-panel"]'),
    ).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Review style' }),
    ).toHaveCount(0);
  });
});
