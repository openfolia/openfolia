import type { Locator, Page } from '@playwright/test';
import {
  type Api,
  type Block,
  type UserId,
  mergedModule,
  moduleId,
  paragraph,
  unique,
} from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

const text = (value: string) => [{ type: 'text', text: value }];
const paragraphWith = (id: string, content: readonly unknown[]): Block => ({
  type: 'paragraph',
  id,
  content,
});

/**
 * Presses the grip of `block` (hovered first, so the grip stands beside it) and moves the pointer
 * in steps until the block's top is `dy` px lower: the copy follows, the slot takes the nearest
 * place. Returns once moved; the caller releases.
 */
async function liftBy(page: Page, block: Locator, dy: number): Promise<void> {
  await block.hover();
  const grip = page.getByTestId('block-grip');
  await expect(grip).toBeVisible();
  const box = (await grip.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + Math.sign(dy) * 8, { steps: 2 });
  await page.mouse.move(x, y + dy, { steps: 12 });
}

// The module editor (`/content/:lang/:id` in a revision): edit, autosave, save point, the lock.
test.describe('module editor @area:module-editor @api:change-sets @api:modules', () => {
  test('edits a block, autosaves, and makes a save point on leaving the module', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Edit a block'));
    const id = moduleId();
    await author.createModule(changeSet, {
      lang: 'en',
      moduleId: id,
      title: 'Battery care',
      blocks: [paragraph('p1', 'Charge it.')],
    });

    await signIn(page, USERS.author);
    await page.goto(`/content/en/${id}?cs=${changeSet.id}`);
    await expect(page.getByText('Locked by you')).toBeVisible();
    const editor = page.getByRole('textbox', { name: 'Module Battery care' });
    await editor.getByText('Charge it.').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Then unplug it.');
    await expect(
      page.getByRole('status').filter({ hasText: /^Saved/ }),
    ).toBeVisible();

    // Leaving the module makes the save point: the text is on the revision's branch.
    await page
      .getByRole('navigation', { name: 'Breadcrumb' })
      .getByRole('link', { name: 'Content' })
      .click();
    await expect(page).toHaveURL(/\/content\?/);
    await expect(async () => {
      const { data } = await author.json(
        author.get(
          `/modules/en/${id}?ref=${encodeURIComponent(changeSet.branch)}`,
        ),
      );
      expect(JSON.stringify(data)).toContain('Charge it. Then unplug it.');
    }).toPass({ timeout: 20_000 });
  });

  // #239: the blocks inside a variant block or a safety notice have a grip of their own.
  test('drags a block out of a variant block and back with undo, keeps its last block, and moves a block out of a safety notice with Alt+Up', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Blocks out'));
    const id = moduleId();
    const large = { op: 'in', attr: 'model', values: ['large'] };
    const blocks: Block[] = [
      paragraph('intro', 'Read this first.'),
      {
        type: 'variant',
        id: 'both',
        when: large,
        blocks: [
          paragraph('large-1', 'Large models only.'),
          paragraph('large-2', 'Also for large models.'),
        ],
      },
      paragraph('middle', 'Between the frames.'),
      {
        type: 'variant',
        id: 'one',
        when: large,
        blocks: [paragraph('only', 'The only block.')],
      },
      {
        type: 'safety',
        id: 'hot',
        severity: 'warning',
        hazard: text('Hot surface'),
        symbols: [],
        blocks: [
          paragraph('burns', 'Burns.'),
          paragraph('cool', 'Let it cool.'),
        ],
      },
      paragraph('outro', 'The end.'),
    ];
    await author.createModule(changeSet, {
      lang: 'en',
      moduleId: id,
      title: 'Containers',
      blocks,
    });

    await signIn(page, USERS.author);
    await page.goto(`/content/en/${id}?cs=${changeSet.id}`);
    await expect(page.getByText('Locked by you')).toBeVisible();
    const editor = page.getByRole('textbox', { name: 'Module Containers' });
    const variants = editor.locator('[data-node="variant"]');
    const paragraphOf = (value: string) =>
      editor.locator('p', { hasText: value });
    const inBoth = variants.first().locator('p', { hasText: 'Also for large' });

    // Out of the variant block, down onto the paragraph after it, then back with one undo.
    const source = paragraphOf('Also for large models.');
    const target = (await paragraphOf('Between the frames.').boundingBox())!;
    const from = (await source.boundingBox())!;
    await liftBy(page, source, target.y + target.height + 4 - from.y);
    await expect(page.getByTestId('block-slot')).toBeVisible();
    await expect(page.getByTestId('block-drop-hint')).toBeHidden();
    await page.mouse.up();
    await expect(inBoth).toHaveCount(0);
    await expect(paragraphOf('Also for large models.')).toBeVisible();
    await expect(
      editor.locator(':scope > p', { hasText: 'Also for large models.' }),
    ).toHaveCount(1);
    // The drag never took the focus: back into the document, then undo.
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(inBoth).toHaveCount(1);

    // The only block of a variant block stays: every other place says why, and nothing changes.
    const only = paragraphOf('The only block.');
    const above = (await paragraphOf('Read this first.').boundingBox())!;
    const onlyBox = (await only.boundingBox())!;
    await liftBy(page, only, above.y - onlyBox.y);
    await expect(page.getByTestId('block-drop-hint')).toHaveText(
      'Its frame can’t be empty: move the frame to take this block along.',
    );
    await page.mouse.up();
    await expect(page.getByTestId('block-lifted')).toHaveCount(0);
    await expect(variants.nth(1).locator('p')).toHaveText('The only block.');

    // Alt+Up from the notice's first block takes it out, right before the notice.
    const notice = editor.locator('[data-node="safety"]');
    await paragraphOf('Read this first.').click();
    await paragraphOf('Burns.').click();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(notice.locator('p', { hasText: 'Burns.' })).toHaveCount(0);
    await expect(
      editor.locator(':scope > p', { hasText: 'Burns.' }),
    ).toHaveCount(1);
    await expect(notice.locator('p')).toHaveText(['Let it cool.']);
  });

  // #490: a click's caret is the selection at once, and a hover never moves it.
  test('Alt+Up right after a click moves the clicked block, also after hovering another one', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Click then move'));
    const id = moduleId();
    await author.createModule(changeSet, {
      lang: 'en',
      moduleId: id,
      title: 'Click then move',
      blocks: [
        paragraph('one', 'First block.'),
        paragraph('two', 'Second block.'),
        paragraph('three', 'Third block.'),
        paragraph('four', 'Fourth block.'),
      ],
    });

    await signIn(page, USERS.author);
    await page.goto(`/content/en/${id}?cs=${changeSet.id}`);
    await expect(page.getByText('Locked by you')).toBeVisible();
    const editor = page.getByRole('textbox', {
      name: 'Module Click then move',
    });
    const blockOf = (value: string) => editor.locator('p', { hasText: value });
    const order = editor.locator(':scope > p');

    // On a loaded machine the browser's `selectionchange` comes after the next key or hover;
    // held back here until the end, so the flow is that machine on every run.
    await blockOf('First block.').click();
    await page.evaluate(() => {
      const hold = (event: Event) => event.stopImmediatePropagation();
      window.addEventListener('selectionchange', hold, true);
      (window as { releaseSelection?: () => void }).releaseSelection = () =>
        window.removeEventListener('selectionchange', hold, true);
    });

    // The caret starts in the first block; a click in the third, then Alt+Up with no wait.
    await blockOf('Third block.').click();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(order).toHaveText([
      'First block.',
      'Third block.',
      'Second block.',
      'Fourth block.',
    ]);

    // A click in the last block, the pointer on to the first one, then Alt+Up: the clicked
    // block moves, not the hovered one.
    await blockOf('Fourth block.').click();
    await blockOf('First block.').hover();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(order).toHaveText([
      'First block.',
      'Third block.',
      'Fourth block.',
      'Second block.',
    ]);
    await page.evaluate(() =>
      (window as { releaseSelection?: () => void }).releaseSelection?.(),
    );
  });

  test('the live preview draws an image’s callouts, its legend and the references to them', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Callouts'));
    const id = moduleId();
    // A 1 × 1 PNG, drawn at half the column's width.
    const asset = await author.uploadImage(
      changeSet.id,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const callout = (
      calloutId: string,
      x: number,
      y: number,
      legend: string,
      label?: { x: number; y: number },
    ) => ({
      id: calloutId,
      anchor: { x, y },
      ...(label ? { label } : {}),
      legend: text(legend),
    });
    const ref = (calloutId: string) => ({
      type: 'calloutRef',
      block: 'front',
      callout: calloutId,
    });
    await author.createModule(changeSet, {
      lang: 'en',
      moduleId: id,
      title: 'The charger',
      blocks: [
        {
          type: 'paragraph',
          id: 'p1',
          content: [
            ...text('Press the switch '),
            ref('switch'),
            ...text(', then check the lamp '),
            ref('lamp'),
            ...text('.'),
          ],
        },
        {
          type: 'image',
          id: 'front',
          asset,
          alt: 'The charger from the front',
          width: 50,
          title: text('The charger'),
          calloutLegend: 'beside',
          callouts: [
            callout('lamp', 0.7, 0.6, 'Status lamp', { x: 0.9, y: 0.1 }),
            callout('switch', 0.2, 0.3, 'Power switch'),
          ],
        },
      ],
    });
    // Then a reference to a callout the image does not have, in the working copy only (a save
    // point refuses it): a check finding, and "?" in the outputs.
    await author.editModule(
      changeSet.id,
      { lang: 'en', moduleId: id },
      (content) => ({
        ...content,
        blocks: [
          paragraphWith('p2', [...text('Check the fuse '), ref('fuse')]),
          ...content.blocks,
        ],
      }),
      { savePoint: false },
    );

    await signIn(page, USERS.author);
    await page.goto(`/content/en/${id}?cs=${changeSet.id}&preview=open`);
    const preview = page
      .locator('of-preview-frame:not(.opacity-0) iframe')
      .contentFrame();
    // Numbered in reading order: the lamp's label is the highest point, so it reads 1.
    const legend = preview.locator('.of-callouts__entry');
    await expect(legend).toHaveText(['1 Status lamp', '2 Power switch']);
    await expect(preview.locator('.of-callouts__marker text')).toHaveText([
      '1',
      '2',
    ]);
    await expect(preview.locator('line.of-callouts__leader')).toHaveCount(1);
    // The references print the markers' numbers; one to a callout that is not there, "?".
    await expect(preview.locator('.of-callout-ref')).toHaveText([
      '?',
      '2',
      '1',
    ]);
  });

  test.describe('locked', () => {
    // The editor asks for the lock and is refused (409): the browser reports it.
    test.use({ consoleAllow: [/status of 409/] });

    test('a module another revision is editing opens with the lock dialog, and read-only', async ({
      page,
      api,
    }) => {
      // The admin's revision holds the lock on a module of main (only this test uses it).
      const admin = await api(USERS.admin);
      const theirs = await admin.createChangeSet(unique('Holding the lock'));
      await admin.lock(theirs.id, {
        type: 'module',
        lang: 'en',
        moduleId: 'trained-staff',
      });
      const mine = await (
        await api(USERS.author)
      ).createChangeSet(unique('Wants the lock'));

      await signIn(page, USERS.author);
      await page.goto(`/content/en/trained-staff?cs=${mine.id}`);
      const dialog = page.getByRole('dialog', {
        name: 'Someone else is editing this module',
      });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(/Sample Admin/).first()).toBeVisible();
      await dialog.getByRole('button', { name: 'Open read-only' }).click();
      await expect(dialog).toBeHidden();
      await expect(
        page.getByRole('heading', { level: 1, name: 'Trained staff only' }),
      ).toBeVisible();
      await expect(page.getByText('Locked by you')).toHaveCount(0);
    });
  });

  test.describe('locked by you, in another revision', () => {
    // The editor asks for the lock and is refused (409): the browser reports it.
    test.use({ consoleAllow: [/status of 409/] });

    /** A module of main of the test's own, and two revisions of the author's started after it. */
    async function ownLock(
      api: (user: UserId) => Promise<Api>,
      user: UserId = USERS.author,
      { changed = false }: { changed?: boolean } = {},
    ) {
      const holder = await api(user);
      const { module, moduleTitle } = await mergedModule(
        await api(USERS.author),
        await api(USERS.reviewer),
        await api(USERS.publisher),
        unique('Own lock'),
      );
      const thereTitle = unique('Holding it there');
      const there = {
        ...(await holder.createChangeSet(thereTitle)),
        title: thereTitle,
      };
      if (changed) {
        // A working copy there, not yet in a save point.
        await holder.editModule(
          there.id,
          module,
          (content) => ({
            ...content,
            blocks: [...content.blocks, paragraph('p9', 'Changed there.')],
          }),
          { savePoint: false },
        );
      } else {
        await holder.lock(there.id, { type: 'module', ...module });
      }
      const here = await holder.createChangeSet(unique('Wants it here'));
      return { holder, module, moduleTitle, there, here };
    }

    /**
     * Opens the module in `here` and waits for the editor's lock request to be refused (409):
     * the dialog follows that answer, which comes only after the page has read the change set,
     * the configuration, the module and its working copy one after another. On a busy machine
     * that chain alone can take most of an expect's 10 s, so the flow waits for the answer
     * first, then for the dialog (#523).
     */
    async function openRefused(
      page: Page,
      module: { moduleId: string },
      here: { id: string },
    ): Promise<Locator> {
      const refused = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname ===
            `/api/change-sets/${here.id}/locks`,
      );
      await page.goto(`/content/en/${module.moduleId}?cs=${here.id}`);
      expect((await refused).status()).toBe(409);
      return page.getByRole('dialog', {
        name: "You're editing this module in another revision",
      });
    }

    test('says so, names that revision and opens it there', async ({
      page,
      api,
    }) => {
      const { module, moduleTitle, there, here } = await ownLock(api);
      await signIn(page, USERS.author);
      const dialog = await openRefused(page, module, here);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(there.title)).toBeVisible();
      await dialog.getByRole('button', { name: 'Open that revision' }).click();
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`[?&]cs=${there.id}`));
      await expect(
        page.getByRole('heading', { level: 1, name: moduleTitle }),
      ).toBeVisible();
      await expect(page.getByText('Locked by you')).toBeVisible();
    });

    test('releases it there when nothing changed there, and Undo takes it back', async ({
      page,
      api,
    }) => {
      const { holder, module, there, here } = await ownLock(api);
      await signIn(page, USERS.author);
      const dialog = await openRefused(page, module, here);
      await dialog.getByRole('button', { name: 'Release it there' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText('Locked by you')).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`[?&]cs=${here.id}`));
      const lockOf = async () => {
        const { data } = await holder.json(
          holder.get(
            `/locks?filter[subject]=module/en/${module.moduleId}&page[number]=1&page[size]=1`,
          ),
        );
        return data[0]?.relationships.changeSet.data.id as string | undefined;
      };
      expect(await lockOf()).toBe(here.id);

      await page
        .getByRole('status')
        .or(page.getByRole('alert'))
        .getByRole('button', { name: 'Undo' })
        .click();
      // Four requests and a reload: give a loaded machine time.
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      await expect.poll(lockOf).toBe(there.id);
    });

    test('keeps it there when that revision changed the module', async ({
      page,
      api,
    }) => {
      const { module, here } = await ownLock(api, USERS.author, {
        changed: true,
      });
      await signIn(page, USERS.author);
      const dialog = await openRefused(page, module, here);
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByText(/changes to it are kept there/),
      ).toBeVisible();
      await expect(
        dialog.getByRole('button', { name: 'Open that revision' }),
      ).toBeVisible();
      await expect(
        dialog.getByRole('button', { name: 'Release it there' }),
      ).toHaveCount(0);
    });

    test('an admin is offered to take over editing too', async ({
      page,
      api,
    }) => {
      const { module, here } = await ownLock(api, USERS.admin);
      await signIn(page, USERS.admin);
      const dialog = await openRefused(page, module, here);
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole('button', { name: 'Take over editing' }),
      ).toBeVisible();
    });
  });

  // #491: "Update from main" while a module is open in the editor.
  test.describe('after "Update from main"', () => {
    /**
     * A module of main of the test's own, a revision of the author's started after it, and main
     * moved on since: `change` says what the revision merged meanwhile does to the module (none:
     * another module is merged, the module stays as it was).
     */
    async function behindMain(
      api: (user: UserId) => Promise<Api>,
      change?: (blocks: readonly Block[]) => Block[],
    ) {
      const author = await api(USERS.author);
      const reviewer = await api(USERS.reviewer);
      const publisher = await api(USERS.publisher);
      const { module, moduleTitle } = await mergedModule(
        author,
        reviewer,
        publisher,
        unique('Behind main'),
      );
      const title = unique('Open while main moves');
      const mine = await author.createChangeSet(title);
      if (change) {
        const theirs = await author.createChangeSet(unique('Moves main'));
        await author.editModule(theirs.id, module, (content) => ({
          ...content,
          blocks: change(content.blocks),
        }));
        await author.transition(theirs.id, 'submit', 'Ready for review.');
        await reviewer.transition(theirs.id, 'approve');
        await publisher.transition(theirs.id, 'merge');
      } else {
        await mergedModule(author, reviewer, publisher, unique('Elsewhere'));
      }
      return { module, moduleTitle, mine: { ...mine, title } };
    }

    test('reads the module and its live preview again at the new head', async ({
      page,
      api,
    }) => {
      const { module, moduleTitle, mine } = await behindMain(api, (blocks) =>
        blocks.map((b) =>
          b.id === 'p1' ? paragraph('p1', 'Charge the battery fully.') : b,
        ),
      );
      await signIn(page, USERS.author);
      await page.goto(
        `/content/en/${module.moduleId}?cs=${mine.id}&preview=open`,
      );
      const editor = page.getByRole('textbox', {
        name: `Module ${moduleTitle}`,
      });
      await expect(
        editor.getByText('Charge the battery before first use.'),
      ).toBeVisible();
      // The frame in view (a new page loads in the other one, hidden until it has).
      const preview = page
        .locator('of-preview-frame:not(.opacity-0) iframe')
        .contentFrame();
      await expect(
        preview.getByText('Charge the battery before first use.'),
      ).toBeVisible();

      await page.getByRole('button', { name: /^Update from main/ }).click();
      await expect(
        page.getByText(`Updated “${mine.title}” from main.`),
      ).toBeVisible();
      // Nothing was edited here: the module is read again at the branch's new head, and so is
      // its preview, without a reload.
      await expect(editor.getByText('Charge the battery fully.')).toBeVisible();
      await expect(
        editor.getByText('Charge the battery before first use.'),
      ).toHaveCount(0);
      await expect(
        preview.getByText('Charge the battery fully.'),
      ).toBeVisible();
      await expect(page.getByText('Locked by you')).toBeVisible();
    });

    test.describe('with unsaved changes', () => {
      // The save is answered 503 on purpose (the server does not answer): the browser reports it.
      test.use({ consoleAllow: [/status of 503/] });

      test('keeps them, says main moved, and offers a reload once they are saved', async ({
        page,
        api,
      }) => {
        const { module, moduleTitle, mine } = await behindMain(api);
        await signIn(page, USERS.author);
        await page.goto(`/content/en/${module.moduleId}?cs=${mine.id}`);
        const editor = page.getByRole('textbox', {
          name: `Module ${moduleTitle}`,
        });
        await expect(page.getByText('Locked by you')).toBeVisible();

        // The server does not take the save: the text stays unsaved, in this browser.
        const workingCopy = `**/api/change-sets/${mine.id}/modules/en/${module.moduleId}/working-copy`;
        await page.route(workingCopy, (route) =>
          route.request().method() === 'PUT'
            ? route.fulfill({ status: 503, body: '' })
            : route.fallback(),
        );
        await editor.getByText('Keep the charger dry.').click();
        await page.keyboard.press('End');
        await page.keyboard.type(' Mine, unsaved.');
        await expect(
          page.getByText(/offline, kept in this browser/),
        ).toBeVisible();

        await page.getByRole('button', { name: /^Update from main/ }).click();
        await expect(
          page.getByText(`Updated “${mine.title}” from main.`),
        ).toBeVisible();
        // Never read again over the unsaved text: it stays, and the page says main moved.
        await expect(
          page.getByText(
            /updated from main while this module had unsaved changes/,
          ),
        ).toBeVisible();
        await expect(
          editor.getByText('Keep the charger dry. Mine, unsaved.'),
        ).toBeVisible();

        // The server answers again: saved, and the reload is offered.
        await page.unroute(workingCopy);
        await page.getByRole('button', { name: 'Retry' }).click();
        await expect(
          page.getByRole('status').filter({ hasText: /^Saved/ }),
        ).toBeVisible();
        const offer = page.getByText(/Your changes are saved/);
        await expect(offer).toBeVisible();
        // The reload keeps the module on screen (dimmed) until it is read again, so the text and
        // "Locked by you" below would already show before it is. It ends by taking the lock again,
        // after its reads: the flow waits for that answer, else the test could end (and its
        // change set be abandoned) first, and the lock be refused 409 `invalid-state` (#516).
        const relocked = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname ===
              `/api/change-sets/${mine.id}/locks`,
        );
        await page.getByRole('button', { name: 'Reload' }).click();
        expect((await relocked).ok()).toBe(true);
        // Read again: no longer dimmed, so what follows is about the module as read anew.
        await expect(
          page.locator('[data-slot="module-editor-columns"]'),
        ).not.toHaveAttribute('aria-busy', 'true');
        await expect(offer).toHaveCount(0);
        await expect(
          editor.getByText('Keep the charger dry. Mine, unsaved.'),
        ).toBeVisible();
        await expect(page.getByText('Locked by you')).toBeVisible();
      });
    });
  });
});
