import { readFile } from 'node:fs/promises';
import type { Page, Request } from '@playwright/test';
import { type Api, type Json, unique, type UserId } from '../src/api.ts';
import {
  holdPlanning,
  holdReleaseOutputs,
  refuseReleaseOutputs,
  releasePlanning,
  cutOffPlanning,
  unplanRelease,
} from '../src/database.ts';
import {
  chooseSegment,
  expect,
  openAccountMenu,
  signIn,
  switchUser,
  test,
  USERS,
} from '../src/fixtures.ts';

/** A product version no other test (or retry) uses. */
const version = () =>
  `e2e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/**
 * A product no other test (or retry) releases (#564): a new value of the product facet (the
 * first facet, the sample configures no `release.productFacet`), merged to main. Its first
 * release lists every manual as added, whatever other flows release meanwhile. Appended last,
 * so the products before it keep their place in lists ordered by the facet's values.
 *
 * The configuration's lock is held by one change set at a time (other flows take it too), and a
 * change set started before another one's merge conflicts with it in `openfolia.yaml`: either way
 * the change set is abandoned and a new one, on the new main, tries again.
 */
async function ownProduct(
  api: (user: UserId) => Promise<Api>,
): Promise<string> {
  const [admin, reviewer, publisher] = await Promise.all([
    api(USERS.admin),
    api(USERS.reviewer),
    api(USERS.publisher),
  ]);
  const id = version();
  const label = `E2E product ${id}`;
  await expect(async () => {
    const changeSet = await admin.createChangeSet(unique('Own product'));
    try {
      await admin.editConfig(changeSet.id, (config) => {
        const facetId = config.release?.productFacet ?? config.facets[0].id;
        return {
          ...config,
          facets: config.facets.map((facet: Json) =>
            facet.id === facetId
              ? { ...facet, values: [...facet.values, { id, label }] }
              : facet,
          ),
        };
      });
      await admin.transition(changeSet.id, 'submit');
      await reviewer.transition(changeSet.id, 'approve');
      await publisher.transition(changeSet.id, 'merge');
    } catch (error) {
      // Its lock goes with it; the original error is the one to tell.
      await admin.abandon(changeSet.id).catch(() => undefined);
      throw error;
    }
  }).toPass({ timeout: 120_000 });
  return id;
}

/** Fills the "New release" dialog for `product` `revision` and goes through its steps. */
async function createRelease(
  page: Page,
  product: string,
  revision: string,
): Promise<void> {
  await page.getByRole('button', { name: 'New release' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create release' });
  await dialog.getByRole('combobox', { name: /^Product/ }).click();
  await page.getByRole('option', { name: product }).click();
  await dialog.getByRole('textbox', { name: 'Product version' }).fill(revision);
  const next = dialog.getByRole('button', { name: 'Next' });
  await next.click();
  // The checks: warnings (the sample content has some) are confirmed by their count.
  const despite = dialog.getByText(/^Release despite \d+ warnings?$/);
  await expect(despite.or(dialog.getByText('All checks passed'))).toBeVisible();
  if (await despite.isVisible()) await despite.click();
  await next.click(); // the outputs
  await next.click(); // the notes
  await dialog.getByRole('button', { name: 'Create release' }).click();
}

// Releases: cut one, its files as they are made, download, its changes.
test.describe('releases @area:releases @api:releases', () => {
  test('a fresh release shows its files being prepared, never "No files", then the files without a reload (#456)', async ({
    page,
  }) => {
    // Every file rendered, behind newer releases' files, among them other flows' first releases
    // of a product of their own (`ownProduct`), which reuse no file: as the ZIP flow (#469).
    test.setTimeout(360_000);
    // Notes whether the files' empty state ever showed, however briefly.
    await page.addInitScript(() => {
      const w = window as unknown as { sawNoFiles: boolean };
      w.sawNoFiles = false;
      new MutationObserver(() => {
        if (document.body?.innerText.includes('The release has no files yet'))
          w.sawNoFiles = true;
      }).observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    await signIn(page, USERS.admin);
    await page.goto('/releases');
    let loads = 0;
    page.on('load', () => (loads += 1));
    await createRelease(page, 'South', version());

    await expect(page).toHaveURL(/\/releases\/[0-9a-f-]{36}/);
    const files = page.getByRole('region', { name: 'Files' }).last();
    await expect(
      files.getByRole('button', { name: /^Download / }).first(),
    ).toBeVisible({
      timeout: 90_000,
    });
    // Every file ends done, and the page was never loaded again for it.
    const rows = page.locator('[data-state-file]');
    await expect(rows.first()).toBeVisible();
    await expect(
      page.locator('[data-state-file]:not([data-state-file="done"])'),
    ).toHaveCount(0, {
      timeout: 240_000,
    });
    await expect(
      page.locator('[data-slot="files-progress"][data-progress="failed"]'),
    ).toHaveCount(0);
    expect(loads).toBe(0);
    expect(
      await page.evaluate(
        () => (window as unknown as { sawNoFiles: boolean }).sawNoFiles,
      ),
    ).toBe(false);
  });

  test('a release’s notes open on the summary in the reader’s interface language, and a chosen one survives a reload (#794)', async ({
    page,
    api,
  }) => {
    const publisher = await api(USERS.publisher);
    const german = await publisher.cutRelease({
      product: 'south',
      revision: version(),
      notes: 'Torque values corrected.',
      notesByLanguage: { de: 'Drehmomente korrigiert.' },
    });
    const french = await publisher.cutRelease({
      product: 'south',
      revision: version(),
      notes: 'Torque values corrected.',
      notesByLanguage: { fr: 'Couples corrigés.' },
    });
    const notes = page.locator('[data-slot="notes"]');
    const choice = (name: string) =>
      page
        .getByRole('radiogroup', { name: 'Hinweise in' })
        .getByRole('radio', { name, exact: true });

    await signIn(page, USERS.reader);
    // In English: the summary, as before.
    await page.goto(`/releases/${german.id}`);
    await expect(notes).toHaveText('Torque values corrected.');
    await openAccountMenu(page, 'Sample Reader');
    await page.getByRole('menuitemradio', { name: 'Deutsch' }).click();
    await page.keyboard.press('Escape');
    // Switched in place (the choice is stored once its texts are loaded): the German summary.
    await expect(notes).toHaveText('Drehmomente korrigiert.');

    // In German, opened anew: the German summary, with nothing in the address.
    await page.goto(`/releases/${german.id}`);
    await expect(notes).toHaveText('Drehmomente korrigiert.');
    await expect(choice('Deutsch')).toBeChecked();
    expect(new URL(page.url()).searchParams.has('notes')).toBe(false);

    // The summary, chosen: in the address, and kept on a reload.
    await chooseSegment(page, 'Hinweise in', 'Zusammenfassung');
    await expect(notes).toHaveText('Torque values corrected.');
    await expect(page).toHaveURL(/[?&]notes=summary\b/);
    await page.reload();
    await expect(notes).toHaveText('Torque values corrected.');
    await expect(choice('Zusammenfassung')).toBeChecked();

    // German chosen back: in the address too.
    await chooseSegment(page, 'Hinweise in', 'Deutsch');
    await expect(page).toHaveURL(/[?&]notes=de\b/);
    await page.reload();
    await expect(notes).toHaveText('Drehmomente korrigiert.');

    // No German summary: it opens on the summary.
    await page.goto(`/releases/${french.id}`);
    await expect(notes).toHaveText('Torque values corrected.');
    await expect(choice('Zusammenfassung')).toBeChecked();
    await expect(choice('Französisch')).not.toBeChecked();
  });

  test('the list shows every release’s files from its own answer, no read per release (#481)', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    await admin.cutRelease({ product: 'south', revision: version() });
    const reads: string[] = [];
    page.on('request', (req) => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith('/api/releases')) reads.push(path);
    });
    await signIn(page, USERS.admin);
    await page.goto('/releases');
    const rows = page.locator('[data-slot="release-row"]');
    await expect(rows.first()).toBeVisible();
    // Its files' badge comes from the list's own answer (`meta.outputs`).
    await expect(
      rows.first().locator('[data-slot="progress"] [data-progress]'),
    ).toBeVisible();
    expect(reads.filter((p) => p !== '/api/releases')).toEqual([]);
  });

  test('downloads a PDF of a release and lists its changes', async ({
    page,
    api,
  }) => {
    // Its product made and merged first (behind other flows' configuration changes), then every
    // file rendered anew (a first release reuses none): more than the default minute.
    test.setTimeout(420_000);
    // A product of its own: its first release, so its changes list every manual whatever other
    // flows, retries and repeats release meanwhile (#564).
    const product = await ownProduct(api);
    const publisher = await api(USERS.publisher);
    const release = await publisher.cutRelease({
      product,
      revision: version(),
    });

    await signIn(page, USERS.publisher);
    await page.goto(`/releases/${release.id}`);
    const download = page
      .getByRole('button', {
        name: /^Download Operating manual, Small · English/,
      })
      .first();
    // Read again until the files are made (the page itself waiting for them is #456's flow).
    await expect(async () => {
      await page.reload();
      await expect(download).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 240_000 });
    await expect(
      page
        .getByRole('region', { name: 'Changes' })
        .getByRole('button', { name: /Operating manual English/ }),
    ).toBeVisible();
    const [file] = await Promise.all([
      page.waitForEvent('download'),
      download.click(),
    ]);
    expect(file.suggestedFilename()).toMatch(/\.pdf$/);
  });

  test('shows a file’s stable address with Copy and the QR code, on the release and the manual screen (#450)', async ({
    page,
    api,
  }) => {
    // Two reads that wait for a release's files to be planned (120 s each): its own, then maybe
    // another flow's.
    test.setTimeout(300_000);
    const publisher = await api(USERS.publisher);
    const revision = version();
    const release = await publisher.cutRelease({ product: 'north', revision });

    await signIn(page, USERS.publisher);
    await page.goto(`/releases/${release.id}`);
    const open = page
      .getByRole('button', {
        name: 'Stable address and QR code of Operating manual, Small · English',
      })
      .first();
    // The files are planned in the background: read again until the row is there.
    await expect(async () => {
      await page.reload();
      await expect(open).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 120_000 });
    await open.click();
    const dialog = page.getByRole('dialog', {
      name: /^Address of Operating manual/,
    });
    await expect(
      dialog.getByRole('textbox', { name: 'Latest release' }),
    ).toHaveValue('https://docs.example.com/d/north/operating/model=small/en');
    await expect(
      dialog.getByRole('textbox', { name: 'This release' }),
    ).toHaveValue(
      `https://docs.example.com/d/north/operating/model=small/en@${revision}`,
    );
    await expect(
      dialog.getByText(
        /Only clients that send an API token open these addresses/,
      ),
    ).toBeVisible();
    await expect(
      dialog.getByRole('img', {
        name: /^QR code of https:\/\/docs\.example\.com\//,
      }),
    ).toBeVisible();
    const [svg] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: 'Download SVG' }).click(),
    ]);
    expect(svg.suggestedFilename()).toBe(
      'qr_north_operating_model-small_en.svg',
    );
    expect(await readFile(await svg.path(), 'utf8')).toMatch(/^<svg /);
    await page.keyboard.press('Escape');

    // The manual's screen lists the same addresses, of North's newest release: whichever that is
    // (any gives the same latest address), but one another flow, retry or repeat has just cut
    // lists no row until its files are planned (#564). Read again until it does.
    const row = page
      .getByRole('button', {
        name: /^Stable address and QR code of North · Small · English$/,
      })
      .first();
    await expect(async () => {
      await page.goto('/manuals?manual=operating');
      await expect(row).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 120_000 });
    await row.click();
    await expect(
      page
        .getByRole('dialog', { name: /^Address of Operating manual/ })
        .getByRole('textbox', { name: 'Latest release' }),
    ).toHaveValue('https://docs.example.com/d/north/operating/model=small/en');
  });

  test('downloads all of a release’s files as one ZIP, blocked with its reason until one is ready (#469)', async ({
    page,
    api,
  }) => {
    // Waits for every file of a fresh release to render, then downloads them: more than the
    // default minute on a loaded machine. Newer releases' files go first, among them other flows'
    // first releases of a product of their own (`ownProduct`), which reuse no file.
    test.setTimeout(360_000);
    const revision = version();
    const release = await (
      await api(USERS.publisher)
    ).cutRelease({ product: 'north', revision });

    await signIn(page, USERS.publisher);
    await page.goto(`/releases/${release.id}`);
    const button = page.getByRole('button', { name: 'Download all (ZIP)' });
    await expect(button).toBeVisible();
    // Before any file is ready the button is blocked and says why. The files may be made before
    // the page reads them (a fast render), so this is asserted only while none is ready yet.
    // Both read at once, so a file finishing in between cannot split them.
    const first = await button.evaluate((el) => ({
      blocked: el.getAttribute('aria-disabled') === 'true',
      reason: el.getAttribute('aria-description'),
    }));
    if (first.blocked) {
      expect(first.reason).toBe('No file is ready yet.');
    }

    // Every file done: the page says how many, and the button is free.
    const progress = page.locator(
      '[data-slot="files-progress"][data-progress="done"]',
    );
    await expect(progress).toBeVisible({ timeout: 240_000 });
    const all = Number(
      /All (\d+) files ready/.exec((await progress.textContent()) ?? '')?.[1],
    );
    // The ZIP holds the PDFs: the offline packages (#59), ZIPs of their own, stay out of it.
    const packages = (
      await (
        await (
          await api(USERS.publisher)
        ).get(
          `/releases/${release.id}/outputs?filter[kind]=offline-package&page[size]=1`,
        )
      ).json()
    ).meta.page.total as number;
    const total = all - packages;
    expect(total).toBeGreaterThan(1);
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('[data-slot="archive-note"]')).toHaveText('');

    const [file] = await Promise.all([
      page.waitForEvent('download'),
      button.click(),
    ]);
    expect(file.suggestedFilename()).toBe(`north_${revision}.zip`);
    const zip = await readFile(await file.path());
    // A ZIP: a local file header first, and the end record counts its entries.
    expect(zip.subarray(0, 4)).toEqual(Buffer.from('PK\x03\x04', 'latin1'));
    const end = zip.subarray(zip.length - 22);
    expect(end.readUInt32LE(0)).toBe(0x06054b50);
    expect(end.readUInt16LE(10)).toBe(total);
    await expect(
      page.getByText(`${total} files downloaded as ZIP`),
    ).toBeVisible();
  });

  test('lists a release’s offline packages with its files, one per language and audience level, and downloads one (#59)', async ({
    page,
    api,
  }) => {
    // Built once every PDF of the release is done, behind newer releases' files.
    test.setTimeout(360_000);
    const revision = version();
    const release = await (
      await api(USERS.publisher)
    ).cutRelease({ product: 'north', revision });

    await signIn(page, USERS.publisher);
    await page.goto(`/releases/${release.id}`);
    const files = page.getByRole('region', { name: 'Files' }).last();
    await expect(
      page.locator('[data-slot="files-progress"][data-progress="done"]'),
    ).toBeVisible({ timeout: 300_000 });
    const group = files.getByRole('columnheader', { name: 'Offline packages' });
    await expect(group).toBeVisible();
    const download = files.getByRole('button', {
      name: 'Download Offline packages, Public · English',
    });
    await expect(download).toBeVisible();
    // A package has no stable address (#450): no address button in its row.
    const row = page.locator('tr', { has: download });
    await expect(row.locator('[data-slot="file-address"]')).toHaveCount(0);
    const [file] = await Promise.all([
      page.waitForEvent('download'),
      download.click(),
    ]);
    expect(file.suggestedFilename()).toBe(`offline_public_en_${revision}.zip`);
    const zip = await readFile(await file.path());
    expect(zip.subarray(0, 4)).toEqual(Buffer.from('PK\x03\x04', 'latin1'));
    expect(zip.includes(Buffer.from('index.html'))).toBe(true);
    expect(zip.includes(Buffer.from('manifest.json'))).toBe(true);
  });

  test('a release whose files wait behind a newer release’s says for how many, in English and German, only to a publisher of its product, and planning again makes them (#497)', async ({
    page,
    api,
    browser,
    baseURL,
  }) => {
    // Two releases rendered to their end first: longer than a flow's usual minute.
    test.setTimeout(480_000);
    const publisher = await api(USERS.publisher);
    const ended = async (id: string) =>
      expect
        .poll(
          async () =>
            (await (await publisher.get(`/releases/${id}`)).json()).data.meta
              .outputs?.state,
          { timeout: 300_000 },
        )
        .toMatch(/^(done|failed)$/);
    const older = await publisher.cutRelease({
      product: 'south',
      revision: version(),
    });
    const newer = await publisher.cutRelease({
      product: 'south',
      revision: version(),
    });
    await Promise.all([ended(older.id), ended(newer.id)]);
    // Both releases' files back to waiting: the newer one's go first.
    expect(await holdReleaseOutputs([older.id, newer.id])).toBeGreaterThan(0);
    // Another release of the product rendered meanwhile, as parallel flows cut them, never
    // makes the held files (#536): they are out of the groups its files serve.
    await ended(
      (await publisher.cutRelease({ product: 'south', revision: version() }))
        .id,
    );

    await signIn(page, USERS.publisher);
    await page.goto(`/releases/${older.id}`);
    // Other flows may cut newer South releases meanwhile: the count is at least the newer one's
    // (whether the newest waits for none is the API's and the specs' to show, not a parallel run's).
    const waiting = page.locator('[data-slot="files-waiting"]');
    await expect(waiting).toHaveText(
      /^· Waiting for [\d,]+ files? of newer releases$/,
    );
    await openAccountMenu(page, 'Sample Publisher');
    await page.getByRole('menuitemradio', { name: 'Deutsch' }).click();
    await page.keyboard.press('Escape');
    await expect(waiting).toHaveText(
      /^· Wartet auf [\d.]+ Dateien? neuerer Veröffentlichungen$/,
    );
    // A reader: no queue at all (the count covers manuals one may not read).
    // Its own browser context: the demo sign-in is stored per origin.
    const context = await browser.newContext({ ...(baseURL && { baseURL }) });
    const reader = await context.newPage();
    try {
      await signIn(reader, USERS.reader);
      await reader.goto(`/releases/${older.id}`);
      await expect(
        reader.locator('[data-slot="files-progress"]').first(),
      ).toContainText(/0 of \d+ files? ready/);
      await expect(reader.locator('[data-slot="files-waiting"]')).toHaveCount(
        0,
      );
    } finally {
      await context.close();
    }

    // Planned again: the files get their jobs, each rendered at its own release (out of their
    // groups, nothing serves both), and the line goes once none waits.
    for (const id of [newer.id, older.id]) {
      expect(
        (await publisher.send('POST', `/releases/${id}/outputs/plan`)).status(),
      ).toBe(202);
    }
    await page.goto(`/releases/${older.id}`);
    await expect(
      page.locator('[data-state-file]:not([data-state-file="done"])'),
    ).toHaveCount(0, { timeout: 240_000 });
    await expect(page.locator('[data-slot="files-waiting"]')).toHaveCount(0);
  });

  test('a release whose planning waits behind an earlier release’s says so, in English and German, only to a publisher of its product, and the line goes once it is planned (#497, #527)', async ({
    page,
    api,
    browser,
    baseURL,
  }) => {
    test.setTimeout(300_000);
    // A product of its own: no other flow's release of it is planned meanwhile (#527: a
    // product's releases are planned in the order cut, so another's would plan the older one).
    const product = await ownProduct(api);
    const publisher = await api(USERS.publisher);
    const state = async (id: string) =>
      (await (await publisher.get(`/releases/${id}`)).json()).data.meta.outputs
        ?.state;
    const settled = (id: string, states: string[]) =>
      expect
        .poll(() => state(id), { timeout: 120_000 })
        .toMatch(new RegExp(`^(${states.join('|')})$`));
    const olderRevision = version();
    const older = await publisher.cutRelease({
      product,
      revision: olderRevision,
    });
    const newer = await publisher.cutRelease({ product, revision: version() });
    // The older one's files all made, so none of them renders while it is taken back.
    await Promise.all([
      settled(older.id, ['done']),
      settled(newer.id, ['done', 'rendering']),
    ]);
    // Both plannings waiting again, the older one with no files yet: as a burst of releases
    // waits to be planned in the order cut. Only these two releases are touched.
    expect(await holdPlanning([older.id, newer.id])).toBe(2);
    expect(await unplanRelease(older.id)).toBeGreaterThan(0);
    // The newer one's planning as one cut off part way, so its held job is still its planning.
    expect(await cutOffPlanning(newer.id)).toBe(true);
    let released: number | undefined;
    try {
      await signIn(page, USERS.publisher);
      await page.goto(`/releases/${newer.id}`);
      const waiting = page.locator('[data-slot="files-waiting"]');
      await expect(waiting).toHaveText(
        /^(· )?Waiting for 1 earlier release to be prepared first$/,
      );
      await openAccountMenu(page, 'Sample Publisher');
      await page.getByRole('menuitemradio', { name: 'Deutsch' }).click();
      await page.keyboard.press('Escape');
      await expect(waiting).toHaveText(
        /^(· )?Wartet auf die Vorbereitung einer früheren Veröffentlichung$/,
      );
      // The older one itself waits for none.
      await page.goto(`/releases/${older.id}`);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(
        olderRevision,
      );
      await expect(page.locator('[data-slot="files-waiting"]')).toHaveCount(0);
      // A reader: no count at all (it covers manuals one may not read).
      const context = await browser.newContext({ ...(baseURL && { baseURL }) });
      const reader = await context.newPage();
      try {
        await signIn(reader, USERS.reader);
        await reader.goto(`/releases/${newer.id}`);
        await expect(
          reader.locator('[data-slot="files-progress"]').first(),
        ).toBeVisible();
        await expect(reader.locator('[data-slot="files-waiting"]')).toHaveCount(
          0,
        );
      } finally {
        await context.close();
      }
      await page.goto(`/releases/${newer.id}`);
      await expect(waiting).toBeVisible();
    } finally {
      // Always let them run; asserted after, so a failure above stays the one reported.
      released = await releasePlanning([older.id, newer.id]);
    }
    expect(released).toBe(2);
    // The newer one's turn plans the older one first, then itself: the line goes.
    await expect(page.locator('[data-slot="files-waiting"]')).toHaveCount(0, {
      timeout: 120_000,
    });
    await Promise.all([
      settled(older.id, ['done', 'rendering']),
      settled(newer.id, ['done', 'rendering']),
    ]);
  });

  test('a read of the manuals started for one person never lands after a switch to another (#706)', async ({
    page,
    api,
  }) => {
    // Its files planned before the page opens (120 s at most), as in #450's flow.
    test.setTimeout(240_000);
    const publisher = await api(USERS.publisher);
    const release = await publisher.cutRelease({
      product: 'north',
      revision: version(),
    });
    await expect
      .poll(
        async () =>
          (await (await publisher.get(`/releases/${release.id}`)).json()).data
            .meta.outputs?.total ?? 0,
        { timeout: 120_000 },
      )
      .toBeGreaterThan(0);

    // Notes whether a title from the held read ever showed, however briefly, as text or in a
    // button's name.
    const STALE = 'Title read for the person before';
    await page.addInitScript((stale) => {
      const w = window as unknown as { sawStale: boolean };
      w.sawStale = false;
      new MutationObserver(() => {
        if (document.body?.innerHTML.includes(stale)) w.sawStale = true;
      }).observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    }, STALE);

    // The first read of the manuals at the release's tag is held until the person has changed;
    // every later one goes through.
    const { promise: holding, resolve: hold } =
      Promise.withResolvers<Request>();
    const { promise: held, resolve: answerHeld } =
      Promise.withResolvers<void>();
    let reads = 0;
    const atTag = (url: URL) =>
      url.pathname === '/api/manuals' &&
      url.searchParams.get('ref') === release.tag;
    await page.route(atTag, async (route) => {
      reads += 1;
      if (reads > 1) return route.continue();
      hold(route.request());
      await held;
      // What the first person's read answers, marked so the page would show it if it landed.
      const answer = await route.fetch();
      const body = await answer.json();
      for (const manual of body.data) {
        if (manual.attributes) manual.attributes.title = STALE;
      }
      await route.fulfill({ response: answer, json: body });
    });

    await signIn(page, USERS.publisher);
    await page.goto(`/releases/${release.id}`);
    const first = await holding;
    await switchUser(page, 'Sample Publisher', 'Sample Admin');
    // The admin's own read has answered: the file names the manual by its title.
    const open = page
      .getByRole('button', {
        name: 'Stable address and QR code of Operating manual, Small · English',
      })
      .first();
    await expect(open).toBeVisible();

    // Now the publisher's read answers, after the admin's.
    const delivered = page.waitForEvent(
      'requestfinished',
      (req) => req === first,
    );
    answerHeld();
    await delivered;
    // Two frames after it arrived: whatever it would have written is on screen by then.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(open).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as unknown as { sawStale: boolean }).sawStale,
      ),
    ).toBe(false);
  });

  test.describe('too many files (#477)', () => {
    // Planning again is refused by the API (422), which the browser reports.
    test.use({ consoleAllow: [/status of 422/] });

    test('a release with more files than one may have says so on its page and in the list, in English and German, and planning again is refused', async ({
      page,
      api,
    }) => {
      const revision = version();
      const publisher = await api(USERS.publisher);
      const release = await publisher.cutRelease({
        product: 'south',
        revision,
      });
      // Its own planning and rendering end first, so nothing touches its files after the refusal.
      await expect
        .poll(
          async () =>
            (await (await publisher.get(`/releases/${release.id}`)).json()).data
              .meta.outputs?.state,
          { timeout: 120_000 },
        )
        .toMatch(/^(done|failed)$/);
      // Over the run's limit (the default, 20,000): the state the planning job records.
      await refuseReleaseOutputs(release.id, { wanted: 25_000, max: 20_000 });

      await signIn(page, USERS.publisher);
      await page.goto(`/releases/${release.id}`);
      const files = page.getByRole('region', { name: 'Files' }).last();
      await expect(
        files.getByText('Too many files for one release'),
      ).toBeVisible();
      await expect(
        files.getByText(
          'This release would have 25,000 files, more than the 20,000 one release may have',
          { exact: false },
        ),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Download all (ZIP)' }),
      ).toHaveAttribute(
        'aria-description',
        'This release has too many files: none were prepared.',
      );
      // Planning again: the API refuses it and says why, and nothing is planned.
      const plan = page.waitForResponse(
        (res) =>
          res.url().endsWith(`/releases/${release.id}/outputs/plan`) &&
          res.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Plan the files again' }).click();
      expect((await plan).status()).toBe(422);
      await expect(
        page.getByText(
          'This release would have 25,000 files, more than the 20,000 one release may have. Ask an administrator to raise the limit.',
        ),
      ).toBeVisible();
      await expect(
        files.getByText('Too many files for one release'),
      ).toBeVisible();

      // The list's badge says it in a word, its title in full.
      await page.goto('/releases');
      const badge = page
        .getByRole('row')
        .filter({ hasText: revision })
        .locator('[data-slot="progress"] [data-progress="failed"]');
      await expect(badge).toHaveText('Too many files');
      await expect(badge).toHaveAttribute(
        'title',
        'Too many files to prepare: 25,000, more than the limit of 20,000.',
      );

      await openAccountMenu(page, 'Sample Publisher');
      await page.getByRole('menuitemradio', { name: 'Deutsch' }).click();
      await page.keyboard.press('Escape');
      await expect(badge).toHaveText('Zu viele Dateien');
      await page.goto(`/releases/${release.id}`);
      await expect(
        page.getByText('Zu viele Dateien für eine Veröffentlichung'),
      ).toBeVisible();
    });
  });

  test.describe('refused', () => {
    // The API's refusal (409), which the browser reports.
    test.use({ consoleAllow: [/status of 409/] });

    test('a version that is released already is refused in the dialog', async ({
      page,
      api,
    }) => {
      const taken = version();
      await (
        await api(USERS.publisher)
      ).cutRelease({ product: 'south', revision: taken });

      await signIn(page, USERS.publisher);
      await page.goto('/releases');
      await createRelease(page, 'South', taken);
      const dialog = page.getByRole('dialog', { name: 'Create release' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(/already/i).first()).toBeVisible();
      await expect(page).toHaveURL(/\/releases(\?|$)/);
    });
  });
});
