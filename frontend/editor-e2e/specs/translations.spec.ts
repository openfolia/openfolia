import { readFileSync } from 'node:fs';
import { moduleId, paragraph, unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

// Translations (`/translations`): the status matrix, a delta export, an import. An export puts
// what it sends "At the agency" for every flow (#718), so the one here sends only a module of the
// test's own, in a revision of its own; the other flows never read a cell's state on main.
test.describe('translations @area:translations @api:translations', () => {
  test('the status matrix, a delta export (its counts first) and importing it back', async ({
    page,
    api,
  }, testInfo) => {
    // A module of the test's own with a German translation that has no record: both blocks
    // outdated.
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Delta export'));
    const id = moduleId('e2e-export');
    const title = unique('Export module');
    const blocks = [
      paragraph('p1', 'Plug the charger in.'),
      paragraph('p2', 'Wait until the light is green.'),
    ];
    // One save point, after the German one, commits both working copies.
    await author.createModule(
      changeSet,
      { lang: 'en', moduleId: id, title, blocks },
      { savePoint: false },
    );
    await author.createModule(changeSet, {
      lang: 'de',
      moduleId: id,
      title,
      blocks: [
        paragraph('p1', 'Das Ladegerät einstecken.'),
        paragraph('p2', 'Warten, bis die Leuchte grün ist.'),
      ],
    });

    await signIn(page, USERS.translator);
    await page.goto(
      `/translations?cs=${changeSet.id}&lang=de&q=${encodeURIComponent(title)}`,
    );
    const matrix = page.getByRole('grid', {
      name: 'Translation status by module and language',
    });
    await expect(
      matrix.getByRole('button', { name: `${title} in German: 2 outdated` }),
    ).toBeVisible();
    // Only this row is sent: chosen before the dialog opens, else it would send a whole manual
    // of main's and change what every other flow sees (#718).
    const row = page.locator(`[data-row="${id}"]`);
    await row.locator('[data-slot="choose-row"]').click();
    await expect(row).toHaveAttribute('data-state', 'selected');

    await page.getByRole('button', { name: 'Create delta export' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create delta export' });
    // The dry run: what would be sent, before anything is.
    await expect(
      dialog.getByText(/1 module · 2 blocks · \d+ words?/),
    ).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: 'Export and download' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.(xlf|xliff|zip)$/);
    const file = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(file);

    await page.goto('/translations/import');
    await page.locator('#translation-import-file').setInputFiles({
      name: download.suggestedFilename(),
      mimeType: 'application/octet-stream',
      buffer: readFileSync(file),
    });
    await expect(
      page.getByText(download.suggestedFilename()).first(),
    ).toBeVisible();
  });

  test.describe('COTI packages', () => {
    // The error path below: a cancelled job's package is answered 409.
    test.use({ consoleAllow: [/status of 409/] });

    test('a job downloaded as a COTI package comes back through the import (#140)', async ({
      page,
      api,
    }, testInfo) => {
      // A module and a job of the test's own (#718): no other flow sees its blocks at the agency.
      const author = await api(USERS.author);
      const changeSet = await author.createChangeSet(unique('COTI package'));
      const id = moduleId('e2e-coti');
      await author.createModule(changeSet, {
        lang: 'en',
        moduleId: id,
        title: unique('Package module'),
        blocks: [paragraph('p1', 'Close the cover.')],
      });
      const translator = await api(USERS.translator);
      const job = await translator.json(
        translator.send('POST', '/translations/exports', {
          data: {
            type: 'TranslationJob',
            attributes: {
              languages: ['de'],
              subject: { type: 'modules', moduleIds: [id] },
              ref: `change-sets/${changeSet.id}`,
            },
          },
        }),
        201,
      );
      const jobId = job['data'].id as string;

      await signIn(page, USERS.translator);
      await page.goto('/translations/jobs');
      const row = page.locator(`[data-slot="job-row"][data-row="${jobId}"]`);
      await expect(row).toBeVisible();
      // On a tablet too, who exported it has room to be read.
      const { width, height } = page.viewportSize()!;
      await page.setViewportSize({ width: 768, height });
      const exported = page.getByRole('columnheader', { name: 'Exported' });
      await expect
        .poll(async () => (await exported.boundingBox())?.width)
        .toBeGreaterThan(100);
      await page.setViewportSize({ width, height });
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        row.getByRole('button', { name: /as a COTI package$/ }).click(),
      ]);
      expect(download.suggestedFilename()).toMatch(
        new RegExp(
          `^\\d{4}-\\d\\d-\\d\\dT\\d{6}Z_translation-${jobId}\\.coti$`,
        ),
      );
      const file = testInfo.outputPath(download.suggestedFilename());
      await download.saveAs(file);
      const upload = {
        name: download.suggestedFilename(),
        mimeType: 'application/octet-stream',
        buffer: readFileSync(file),
      };

      // Back as it left (untranslated): read and checked like its XLIFF, nothing imported yet.
      await page.goto('/translations/import');
      await page.locator('#translation-import-file').setInputFiles(upload);
      await expect(page.locator('[data-slot="counts"]')).toBeVisible();
      await expect(page.locator('[data-slot="upload-error"]')).toHaveCount(0);

      // The error path: once the job is cancelled, its package is refused with a reason.
      await translator.json(
        translator.send('POST', `/translations/exports/${jobId}/cancel`),
      );
      await page.goto('/translations/import');
      await page.locator('#translation-import-file').setInputFiles(upload);
      await expect(page.locator('[data-slot="upload-error"]')).toBeVisible();
    });
  });

  test('the matrix’s total counts its rows, though rows lack a language (#689)', async ({
    page,
  }) => {
    // The translation manager reads two of the target languages: no row has a cell in the others.
    await signIn(page, USERS.translator);
    await page.goto('/translations?size=25');
    const matrix = page.getByRole('grid', {
      name: 'Translation status by module and language',
    });
    // Its first row, whatever state its cells are in: another flow may export one (#718).
    await expect(
      matrix.locator('[data-slot="matrix-row"]').first(),
    ).toBeVisible();
    const pagination = page.locator('[data-slot="list-pagination"]');
    const counted = /Page 1 of (\d+) \((\d+) in total\)/;
    await expect(pagination).toHaveText(counted);
    const said = counted.exec(
      (await pagination.textContent())?.replace(/\s+/g, ' ') ?? '',
    );
    expect(said).not.toBeNull();
    const [last, total] = [Number(said![1]), Number(said![2])];
    // A page holds 25 rows: all of them on the only page, else 25.
    await expect(matrix.locator('[data-slot="matrix-row"]')).toHaveCount(
      last === 1 ? total : 25,
    );
    expect(last).toBe(Math.max(1, Math.ceil(total / 25)));
  });

  test.describe('refused', () => {
    test.use({ consoleAllow: [/status of (400|415|422)/] });

    test('a file that is no XLIFF is refused on import', async ({ page }) => {
      await signIn(page, USERS.translator);
      await page.goto('/translations/import');
      await page.locator('#translation-import-file').setInputFiles({
        name: 'notes.xlf',
        mimeType: 'application/xml',
        buffer: Buffer.from('this is not XLIFF'),
      });
      await expect(page.getByRole('alert').first()).toBeVisible();
    });
  });
});
