import { unique } from '../src/api.ts';
import { chooseSegment, expect, signIn, test, USERS } from '../src/fixtures.ts';

// The manual builder (`/manuals`): add a module, switch the variant, open the PDF preview.
// The service manual is this spec's own to change (the review flow changes the operating
// manual); the preview reads the operating manual on main, built for two variants.
test.describe('manual builder @area:manuals @api:manuals @api:preview', () => {
  // Both lock the service manual: one after the other, never at once.
  test.describe('the service manual', () => {
    test.describe.configure({ mode: 'serial' });

    test('adds a module to a manual in a revision', async ({ page, api }) => {
      const changeSet = await (
        await api(USERS.author)
      ).createChangeSet(unique('Add to manual'));
      // The summaries read (#481): the outline's by ID, the add list's searched; never all.
      const summaries: URL[] = [];
      page.on('request', (req) => {
        const url = new URL(req.url());
        if (url.pathname === '/api/module-summaries') summaries.push(url);
      });
      await signIn(page, USERS.author);
      await page.goto(`/manuals?manual=service&cs=${changeSet.id}`);
      const tree = page.getByRole('tree', { name: 'Structure' });
      await expect(tree.getByRole('treeitem').first()).toBeVisible();
      await expect(tree.getByRole('treeitem', { name: /Storage/ })).toHaveCount(
        0,
      );
      await expect(tree.getByText('Not found')).toHaveCount(0);
      expect(summaries.length).toBeGreaterThan(0);
      expect(summaries.every((u) => u.searchParams.has('filter[id]'))).toBe(
        true,
      );

      await page.getByRole('button', { name: 'Add module' }).click();
      const picker = page.getByRole('dialog');
      const searched = page.waitForRequest((req) => {
        const url = new URL(req.url());
        return (
          url.pathname === '/api/module-summaries' &&
          url.searchParams.get('filter[q]') === 'Storage'
        );
      });
      await picker
        .getByRole('combobox', { name: 'Search modules' })
        .fill('Storage');
      await searched;
      await picker
        .getByRole('option', { name: 'Storage', exact: true })
        .click();
      await expect(
        tree.getByRole('treeitem', { name: /Storage/ }),
      ).toBeVisible();
      // No read of the whole list at any point.
      expect(
        summaries
          .filter(
            (u) =>
              !u.searchParams.has('filter[id]') &&
              !u.searchParams.has('filter[q]'),
          )
          .every((u) => u.searchParams.get('page[size]') === '50'),
      ).toBe(true);
    });

    test.describe('the add list cannot be searched', () => {
      test.use({ consoleAllow: [/status of 503.*\/api\/module-summaries/] });

      test('says so and tries again (#481)', async ({ page, api }) => {
        const changeSet = await (
          await api(USERS.author)
        ).createChangeSet(unique('Search fails'));
        let refuse = true;
        await page.route(
          (url) =>
            url.pathname === '/api/module-summaries' &&
            !url.searchParams.has('filter[id]'),
          (route) =>
            refuse
              ? route.fulfill({
                  status: 503,
                  contentType: 'application/vnd.api+json',
                  body: JSON.stringify({
                    errors: [
                      { status: '503', code: 'unavailable', title: 'Busy' },
                    ],
                  }),
                })
              : route.continue(),
        );
        await signIn(page, USERS.author);
        await page.goto(`/manuals?manual=service&cs=${changeSet.id}`);
        const tree = page.getByRole('tree', { name: 'Structure' });
        await expect(tree.getByRole('treeitem').first()).toBeVisible();
        await page.getByRole('button', { name: 'Add module' }).click();
        const picker = page.getByRole('dialog');
        await expect(
          picker.getByText('The modules could not be searched.'),
        ).toBeVisible();
        refuse = false;
        await picker.getByRole('option', { name: 'Try again' }).click();
        await expect(
          picker.getByText('The modules could not be searched.'),
        ).toHaveCount(0);
        await expect(
          picker.getByRole('option', { name: 'Storage', exact: true }),
        ).toBeVisible();
      });
    });
    test.describe('the add list cannot read its next page', () => {
      test.use({ consoleAllow: [/status of 503.*\/api\/module-summaries/] });

      test('says so in place of "Show more", keeps the highlight there and reads that page again (#561)', async ({
        page,
        api,
      }) => {
        const changeSet = await (
          await api(USERS.author)
        ).createChangeSet(unique('Next page fails'));
        // The sample has fewer modules than a page: the browse list is split in two here, the
        // first page all but "Storage", the second "Storage" alone, which fails once.
        let refuse = true;
        const pages: string[] = [];
        await page.route(
          (url) =>
            url.pathname === '/api/module-summaries' &&
            !url.searchParams.has('filter[id]') &&
            !url.searchParams.has('filter[q]'),
          async (route) => {
            const url = new URL(route.request().url());
            const number = url.searchParams.get('page[number]') ?? '1';
            pages.push(number);
            if (number !== '1' && refuse) {
              refuse = false;
              return route.fulfill({
                status: 503,
                contentType: 'application/vnd.api+json',
                body: JSON.stringify({
                  errors: [
                    { status: '503', code: 'unavailable', title: 'Busy' },
                  ],
                }),
              });
            }
            if (number !== '1') url.searchParams.set('filter[q]', 'Storage');
            url.searchParams.set('page[number]', '1');
            const response = await route.fetch({ url: url.toString() });
            const doc = (await response.json()) as {
              data: { attributes: { title: string } }[];
              meta: { page: { total: number } };
            };
            const data = doc.data.filter((m) =>
              number === '1'
                ? m.attributes.title !== 'Storage'
                : m.attributes.title === 'Storage',
            );
            return route.fulfill({
              response,
              body: JSON.stringify({
                ...doc,
                data,
                meta: {
                  ...doc.meta,
                  page: {
                    ...doc.meta.page,
                    currentPage: Number(number),
                    lastPage: 2,
                    total: doc.meta.page.total + 1,
                  },
                },
              }),
            });
          },
        );
        await signIn(page, USERS.author);
        await page.goto(`/manuals?manual=service&cs=${changeSet.id}`);
        const tree = page.getByRole('tree', { name: 'Structure' });
        await expect(tree.getByRole('treeitem').first()).toBeVisible();
        await page.getByRole('button', { name: 'Add module' }).click();
        const picker = page.getByRole('dialog');
        const storage = picker.getByRole('option', {
          name: 'Storage',
          exact: true,
        });
        const showMore = picker.getByRole('option', {
          name: 'Show more modules',
        });
        await expect(showMore).toBeVisible();
        await expect(storage).toHaveCount(0);

        // By keyboard (the mouse out of the way): up past "New module…" to "Show more", Enter;
        // the page fails.
        await page.mouse.move(0, 0);
        await picker.getByRole('combobox', { name: 'Search modules' }).focus();
        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('ArrowUp');
        await expect(showMore).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('Enter');
        await expect(
          picker.getByText('The next modules could not be read.'),
        ).toBeVisible();
        const retry = picker.getByRole('option', { name: 'Try again' });
        // The highlight stays in "Show more"'s place, on the retry, never on a module.
        await expect(retry).toHaveAttribute('aria-selected', 'true');
        await expect(showMore).toHaveCount(0);
        // The first search's message is not shown: only the next page failed.
        await expect(
          picker.getByText('The modules could not be searched.'),
        ).toHaveCount(0);

        // Enter again reads that page, not the first one again.
        await page.keyboard.press('Enter');
        await expect(storage).toBeVisible();
        await expect(
          picker.getByText('The next modules could not be read.'),
        ).toHaveCount(0);
        // The last page read: nothing more to show.
        await expect(showMore).toHaveCount(0);
        expect(pages).toEqual(['1', '2', '2']);
        await storage.click();
        await expect(
          tree.getByRole('treeitem', { name: /Storage/ }),
        ).toBeVisible();
      });
    });
  });

  test('a term link in the preview shows its definition, Escape hides it, and it leads to the glossary', async ({
    page,
  }) => {
    // The operating manual's `storage` module links `battery`; the manual has a glossary (#245).
    await signIn(page, USERS.author);
    await page.goto('/preview?manual=operating');
    const frame = page.frameLocator('iframe').first();
    const link = frame
      .locator('a.of-term__link[href$="_term-battery"]')
      .first();
    const tip = frame
      .locator('.of-term:has(a[href$="_term-battery"]) .of-term__definition')
      .first();
    await expect(link).toBeVisible({ timeout: 30_000 });
    await link.hover();
    await expect(tip).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tip).toBeHidden();

    await link.click();
    await expect(
      frame.locator('[id$="_term-battery"].of-glossary__entry'),
    ).toBeInViewport();
  });

  test('switches the variant and opens the PDF preview', async ({ page }) => {
    await signIn(page, USERS.author);
    await page.goto('/manuals?manual=operating');
    await page.getByRole('combobox', { name: /^Variant:/ }).click();
    await page.getByRole('option', { name: 'Large' }).click();
    await expect(page).toHaveURL(/[?&]variant=[^&]*large(&|$)/);
    await page
      .getByRole('link', {
        name: /^Open the preview of Operating manual, Large/,
      })
      .click();
    await expect(page).toHaveURL(/\/preview\?.*manual=operating/);
    await chooseSegment(page, 'Output', 'PDF');
    await expect(page).toHaveURL(/[?&]output=pdf(&|$)/);
    // The PDF is built and opened in a new tab (the headless browser shows no PDF viewer, so
    // the answer itself is checked).
    const pdf = page.context().waitForEvent('response', {
      predicate: (r) =>
        (r.headers()['content-type'] ?? '').startsWith('application/pdf'),
      timeout: 60_000,
    });
    await page.getByRole('button', { name: 'Build and open PDF' }).click();
    expect((await pdf).status()).toBe(200);
  });
});
