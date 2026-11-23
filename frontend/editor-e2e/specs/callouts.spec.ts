import type { Locator, Page } from '@playwright/test';
import {
  type Api,
  type Block,
  moduleId,
  paragraph,
  unique,
} from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

// The callout editor on an image block and callout references in the text (#547): placing,
// dragging and nudging callouts, their legends, the order, deleting with Undo, a callout hidden
// in a variant, and a reference that shows its callout's number in the editor and the preview.

const text = (value: string) => [{ type: 'text', text: value }];

/** A 1 × 1 PNG: drawn at the image's width, square, so the picture has room to click on. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const callout = (
  id: string,
  x: number,
  y: number,
  legend: string,
  extra: Record<string, unknown> = {},
) => ({ id, anchor: { x, y }, legend: text(legend), ...extra });

const ref = (calloutId: string) => ({
  type: 'calloutRef',
  block: 'pump',
  callout: calloutId,
});

/**
 * A module of the test's own with an image (`pump`) and a paragraph after it, in a revision of
 * its own; `inManual` adds it to the operating manual there, so the live preview offers that
 * manual's variants (Small, Large).
 */
async function setUp(
  api: (user: typeof USERS.author) => Promise<Api>,
  options: {
    callouts?: readonly unknown[];
    after?: readonly unknown[];
    inManual?: boolean;
  } = {},
) {
  const author = await api(USERS.author);
  const changeSet = await author.createChangeSet(unique('Callouts'));
  const id = moduleId();
  const asset = await author.uploadImage(changeSet.id, PIXEL);
  const blocks: Block[] = [
    {
      type: 'image',
      id: 'pump',
      asset,
      alt: 'The pump',
      width: 60,
      ...(options.callouts?.length ? { callouts: options.callouts } : {}),
    } as Block,
    options.after
      ? ({ type: 'paragraph', id: 'see', content: options.after } as Block)
      : paragraph('see', 'Open the valve'),
  ];
  await author.createModule(changeSet, {
    lang: 'en',
    moduleId: id,
    title: 'The pump',
    blocks,
  });
  if (options.inManual) {
    await author.editManual(changeSet.id, 'operating', (manual) => ({
      ...manual,
      entries: [
        ...((manual['entries'] as unknown[] | undefined) ?? []),
        { module: id },
      ],
    }));
  }
  return { changeSet, id, author };
}

/** The editor's parts: the image block, its picture's callouts and its panel. */
function parts(page: Page) {
  const editor = page.getByRole('textbox', { name: 'Module The pump' });
  const image = editor.locator('[data-node="image"]');
  const overlay = image.locator('[data-slot="callout-overlay"]');
  const markers = overlay.locator('[data-slot="callout-marker"]');
  const panel = image.locator('[data-slot="callout-panel"]');
  return { editor, image, overlay, markers, panel };
}

/** Clicks the picture at `x`, `y` (0 to 1 across and down it). */
async function clickPicture(overlay: Locator, x: number, y: number) {
  const box = (await overlay.boundingBox())!;
  await overlay
    .locator('[data-slot="callout-add-area"]')
    .click({ position: { x: box.width * x, y: box.height * y } });
}

/** The live preview's document. */
const preview = (page: Page) =>
  page.locator('of-preview-frame:not(.opacity-0) iframe').contentFrame();

async function open(page: Page, id: string, changeSet: string, extra = '') {
  await signIn(page, USERS.author);
  await page.goto(`/content/en/${id}?cs=${changeSet}${extra}`);
  await expect(page.getByText('Locked by you')).toBeVisible();
}

test.describe('callout editor @area:module-editor @area:manuals @api:modules @api:change-sets', () => {
  test('places three callouts, writes their legends, drags one, and a reference shows its number in the editor and the preview', async ({
    page,
    api,
  }) => {
    const { changeSet, id } = await setUp(api);
    await open(page, id, changeSet.id, '&preview=open');
    const { editor, overlay, markers, panel } = parts(page);
    await panel.getByRole('button', { name: 'Edit callouts' }).click();

    // Three clicks on the picture, a legend typed after each.
    const legends = ['Inlet', 'Outlet', 'Drain'];
    const points: [number, number][] = [
      [0.2, 0.2],
      [0.8, 0.2],
      [0.5, 0.8],
    ];
    for (const [i, [x, y]] of points.entries()) {
      await clickPicture(overlay, x, y);
      const field = panel.getByRole('textbox', {
        name: `Legend of callout ${i + 1}`,
      });
      await expect(field).toBeFocused();
      await page.keyboard.type(legends[i]!);
      await page.keyboard.press('Enter');
    }
    await expect(markers).toHaveText(['1', '2', '3']);
    await expect(panel.locator('[data-callout-row]')).toHaveText([
      /Inlet/,
      /Outlet/,
      /Drain/,
    ]);

    // A reference to the drain, from "/".
    await editor.getByText('Open the valve').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' /callout');
    await page.getByRole('option', { name: /Callout reference/ }).click();
    const picker = page.getByRole('dialog', { name: 'Callout reference' });
    await picker.getByRole('option', { name: '3 Drain' }).click();
    const chip = editor.locator('[data-node="calloutRef"]');
    await expect(chip).toHaveText('Callout reference 3');
    await expect(preview(page).locator('.of-callout-ref')).toHaveText('3', {
      timeout: 20_000,
    });
    await expect(preview(page).locator('.of-callouts__entry')).toHaveText([
      '1 Inlet',
      '2 Outlet',
      '3 Drain',
    ]);

    // Dragged to the top-left corner, the drain reads first: the reference follows.
    const drain = overlay.locator('[data-slot="callout-marker"]', {
      hasText: '3',
    });
    const from = (await drain.boundingBox())!;
    const box = (await overlay.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.05, box.y + box.height * 0.05, {
      steps: 8,
    });
    // While dragged, nothing else moves: the panel keeps its place.
    const panelTop = (await panel.boundingBox())!.y;
    await page.mouse.up();
    expect((await panel.boundingBox())!.y).toBe(panelTop);
    await expect(chip).toHaveText('Callout reference 1');
    await expect(markers).toHaveText(['1', '2', '3']);
    await expect(panel.locator('[data-callout-row]')).toHaveText([
      /Drain/,
      /Inlet/,
      /Outlet/,
    ]);
    await expect(preview(page).locator('.of-callout-ref')).toHaveText('1', {
      timeout: 20_000,
    });
  });

  test('keyboard only: adds a callout, nudges it with the arrow keys, and deletes it', async ({
    page,
    api,
  }) => {
    const { changeSet, id } = await setUp(api, {
      callouts: [callout('inlet', 0.2, 0.2, 'Inlet')],
    });
    await open(page, id, changeSet.id);
    const { overlay, markers, panel } = parts(page);
    // The picture drawn, its callout on it: until it has loaded there is no marker to take the
    // focus once a legend is done (#578).
    await expect(markers).toHaveText(['1']);
    const edit = panel.getByRole('button', { name: 'Edit callouts' });
    await edit.focus();
    await page.keyboard.press('Enter');
    const add = panel.getByRole('button', { name: 'Add callout' });
    await add.focus();
    await page.keyboard.press('Enter');
    // In the middle, its legend focused.
    await expect(
      panel.getByRole('textbox', { name: 'Legend of callout 2' }),
    ).toBeFocused();
    await page.keyboard.type('Gauge');
    // Enter: the legend is done, the marker has the focus.
    await page.keyboard.press('Enter');
    const gauge = overlay.getByRole('button', { name: 'Callout 2: Gauge' });
    await expect(gauge).toBeFocused();
    // A larger step left, a small one up, pressed at once: both count.
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('ArrowUp');
    await expect(gauge).toHaveAttribute('style', /left: 45%; top: 49%/);
    await expect(gauge).toBeFocused();
    await page.keyboard.press('Delete');
    await expect(markers).toHaveText(['1']);
    // Undo, in the toast.
    await page
      .locator('of-toaster')
      .getByRole('button', { name: 'Undo' })
      .click();
    await expect(markers).toHaveText(['1', '2']);
    // Tab reaches the markers from the picture's first one.
    await overlay.getByRole('button', { name: 'Callout 1: Inlet' }).focus();
    await page.keyboard.press('Tab');
    await expect(
      overlay.getByRole('button', { name: 'Callout 2: Gauge' }),
    ).toBeFocused();
    await page.keyboard.press('Backspace');
    await expect(markers).toHaveText(['1']);
  });

  test('reorders by a row’s grip: the numbers and the reference follow, and Undo takes a delete back', async ({
    page,
    api,
  }) => {
    const { changeSet, id } = await setUp(api, {
      callouts: [
        callout('inlet', 0.2, 0.2, 'Inlet'),
        callout('outlet', 0.8, 0.2, 'Outlet'),
      ],
      after: [...text('Open the outlet '), ref('outlet')],
    });
    await open(page, id, changeSet.id);
    const { editor, markers, panel } = parts(page);
    const chip = editor.locator('[data-node="calloutRef"]');
    await expect(chip).toHaveText('Callout reference 2');
    await panel.getByRole('button', { name: 'Edit callouts' }).click();
    await panel.getByRole('button', { name: /^Move Callout 2/ }).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(chip).toHaveText('Callout reference 1');
    await expect(panel.locator('[data-callout-row]')).toHaveText([
      /Outlet/,
      /Inlet/,
    ]);
    await expect(
      panel.getByText('Numbered in the order set here.'),
    ).toBeVisible();

    // Deleted, the reference is broken; Undo brings it back.
    await panel.getByRole('button', { name: 'Delete callout 1' }).click();
    await expect(chip).toHaveText(/\?: The callout is gone/);
    await expect(markers).toHaveText(['1']);
    await page
      .locator('of-toaster')
      .getByRole('button', { name: 'Undo' })
      .click();
    await expect(chip).toHaveText('Callout reference 1');
    await expect(markers).toHaveText(['1', '2']);

    await panel
      .getByRole('button', { name: 'Number in reading order' })
      .click();
    await expect(chip).toHaveText('Callout reference 2');
  });

  test('hides a callout in a variant: the numbers close up in the editor and the preview', async ({
    page,
    api,
  }) => {
    const { changeSet, id } = await setUp(api, {
      callouts: [
        callout('inlet', 0.2, 0.2, 'Inlet'),
        callout('gauge', 0.5, 0.2, 'Gauge'),
        callout('outlet', 0.8, 0.2, 'Outlet'),
      ],
      after: [...text('Open the outlet '), ref('outlet')],
      inManual: true,
    });
    await open(
      page,
      id,
      changeSet.id,
      `&preview=open&previewVariant=${encodeURIComponent('model=small')}`,
    );
    const { editor, markers, panel } = parts(page);
    const chip = editor.locator('[data-node="calloutRef"]');
    await expect(panel.getByText('numbered as in Small')).toBeVisible();
    await expect(chip).toHaveText('Callout reference 3');

    // The gauge only for the large model.
    await panel.getByRole('button', { name: 'Edit callouts' }).click();
    await panel.getByRole('button', { name: 'Legend of callout 2' }).click();
    await panel.getByRole('button', { name: 'Variants' }).click();
    const dialog = page.getByRole('dialog', { name: /Show this block for/ });
    await dialog.getByRole('checkbox', { name: 'Large' }).check();
    await dialog.getByRole('button', { name: 'Apply' }).click();

    await expect(markers).toHaveText(['1', '–', '2']);
    await expect(chip).toHaveText('Callout reference 2');
    await expect(preview(page).locator('.of-callout-ref')).toHaveText('2', {
      timeout: 20_000,
    });
    await expect(preview(page).locator('.of-callouts__entry')).toHaveText([
      '1 Inlet',
      '2 Outlet',
    ]);
  });

  test('a reference to a callout that is gone is marked, and the picker says when there are none', async ({
    page,
    api,
  }) => {
    const { changeSet, id, author } = await setUp(api, {
      callouts: [callout('inlet', 0.2, 0.2, 'Inlet')],
      after: [...text('See '), ref('inlet')],
    });
    // The callout gone from the working copy only: a save point refuses a broken reference.
    await author.editModule(
      changeSet.id,
      { lang: 'en', moduleId: id },
      (content) => ({
        ...content,
        blocks: content.blocks.map((b) =>
          b.type === 'image' ? { ...b, callouts: undefined } : b,
        ),
      }),
      { savePoint: false },
    );
    await open(page, id, changeSet.id);
    const { editor } = parts(page);
    const chip = editor.locator('[data-node="calloutRef"]');
    await expect(chip).toHaveText(/^Callout reference \?/);
    await expect(chip).toHaveAttribute('title', /The callout is gone/);
    await chip.getByText('?', { exact: true }).click();
    await expect(
      page
        .getByRole('dialog', { name: 'Callout reference' })
        .getByText('This module’s images have no callouts yet.', {
          exact: false,
        }),
    ).toBeVisible();
  });

  test('hovering or focusing a callout highlights its marker, legend and references, in the editor and the preview (#549)', async ({
    page,
    api,
  }) => {
    const { changeSet, id } = await setUp(api, {
      callouts: [
        callout('inlet', 0.2, 0.2, 'Inlet'),
        callout('outlet', 0.8, 0.2, 'Outlet'),
      ],
      after: [...text('Open the outlet '), ref('outlet')],
    });
    await open(page, id, changeSet.id, '&preview=open');
    const { editor, markers, panel } = parts(page);
    const chip = editor.locator('[data-node="calloutRef"]');
    // The chip's visible number (its box holds the text for screen readers too).
    const number = chip.getByText('2', { exact: true });
    const outlet = markers.filter({ hasText: '2' });
    const inlet = markers.filter({ hasText: '1' });
    await expect(chip).toHaveText('Callout reference 2');
    // Read-only, the markers let the pointer through to the picture: moved over, not hovered.
    const over = async (marker: Locator) => {
      const box = (await marker.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    };

    // The editor: the marker lights up the reference, and the other way round.
    await over(outlet);
    await expect(chip).toHaveAttribute('data-highlighted', '');
    await over(inlet);
    await expect(chip).not.toHaveAttribute('data-highlighted');
    await number.hover();
    await expect(outlet).toHaveAttribute('data-highlighted', '');
    await expect(inlet).not.toHaveAttribute('data-highlighted');
    // Not by colour alone: a ring around the marker.
    await expect(outlet).toHaveClass(/\bring-2\b/);
    // Off it, onto plain text: nothing is highlighted.
    await editor.getByText('Open the outlet').hover();
    await expect(outlet).not.toHaveAttribute('data-highlighted');
    // The markers do not take the picture's clicks: one on a marker selects the image.
    const { image } = parts(page);
    const box = (await outlet.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(image).toHaveClass(/ProseMirror-selectednode/);
    await expect(outlet).toHaveAttribute('data-highlighted', '');

    // The panel's row, while editing.
    await panel.getByRole('button', { name: 'Edit callouts' }).click();
    const row = panel.locator('[data-callout-row="outlet"]');
    await number.hover();
    await expect(row).toHaveAttribute('data-highlighted', '');
    await panel.locator('[data-callout-row="inlet"]').hover();
    await expect(chip).not.toHaveAttribute('data-highlighted');
    await row.hover();
    await expect(chip).toHaveAttribute('data-highlighted', '');
    await panel.getByRole('button', { name: 'Done' }).click();

    // The keyboard: the reference selected with the arrow keys lights up its marker.
    await editor.getByText('Open the outlet').click();
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    await expect(outlet).toHaveAttribute('data-highlighted', '');
    await page.keyboard.press('Home');
    await expect(outlet).not.toHaveAttribute('data-highlighted');

    // The preview: marker and legend entry, both ways.
    const frame = preview(page);
    const entry = frame.locator('.of-callouts__entry[data-callout$=":outlet"]');
    const marker = frame.locator(
      '.of-callouts__marker[data-callout$=":outlet"]',
    );
    const reference = frame.locator('a.of-callout-ref');
    await expect(entry).toHaveText('2 Outlet', { timeout: 20_000 });
    await marker.hover();
    await expect(entry).toHaveClass(/of-callout--highlighted/);
    await expect(reference).toHaveClass(/of-callout--highlighted/);
    await frame.locator('.of-callouts__entry[data-callout$=":inlet"]').hover();
    await expect(entry).not.toHaveClass(/of-callout--highlighted/);
    await expect(marker).not.toHaveClass(/of-callout--highlighted/);
    await entry.hover();
    await expect(marker).toHaveClass(/of-callout--highlighted/);
    // Not by colour alone: an outline on the entry.
    await expect(entry).toHaveCSS('outline-style', 'solid');

    // Tab to the reference (a link to its picture): its marker lights up.
    await page.mouse.move(0, 0);
    await expect(marker).not.toHaveClass(/of-callout--highlighted/);
    // (A click on the preview's text would take the editor to its block: the focus starts on the link.)
    await reference.focus();
    await expect(marker).toHaveClass(/of-callout--highlighted/);
    await page.keyboard.press('Shift+Tab');
    await expect(reference).not.toBeFocused();
    await expect(marker).not.toHaveClass(/of-callout--highlighted/);
    await page.keyboard.press('Tab');
    await expect(reference).toBeFocused();
    await expect(marker).toHaveClass(/of-callout--highlighted/);
    await expect(entry).toHaveClass(/of-callout--highlighted/);
    await expect(reference).toHaveCSS('outline-style', 'solid');
  });
});
