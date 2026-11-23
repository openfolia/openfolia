import { crc32, deflateSync } from 'node:zlib';
import {
  type Api,
  expect,
  MODULE_ID,
  openModule,
  revisionWithModule,
  signIn,
  test,
  USERS,
} from './fixtures.ts';

// The user guide's screens of Translations, Reports and the media (#680): the status matrix and
// a cell's details, the delta export, the jobs and an import's report, a page design's texts in
// the matrix, the reports, a module's languages, the media library, a safety notice's symbols,
// the storage used and the branding's images. The translation screens are the translation
// manager's; the import and the admin screens the admin's. The one delta export made here is
// cancelled after its shot, so main's matrix is as it was.

/** A 2×2 PNG of one colour (no image tool in the suite). */
function png(rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.from([0, ...rgb, ...rgb]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat([row, row]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A delta export of the operating manual into German, made through the API. */
async function exportOperating(api: Api): Promise<string> {
  const { data } = await api.json(
    api.send('POST', '/translations/exports', {
      data: {
        type: 'TranslationJob',
        attributes: {
          languages: ['de'],
          subject: { type: 'manual', manualId: 'operating' },
        },
      },
    }),
    201,
  );
  return data.id as string;
}

/** The export's XLIFF with each segment's source copied as its target: a file "sent back". */
async function translatedFile(api: Api, job: string): Promise<Buffer> {
  const answer = await api.get(`/translations/exports/${job}/file?lang=de`);
  expect(answer.status()).toBe(200);
  const xliff = await answer.text();
  let first = true;
  return Buffer.from(
    xliff.replace(
      /<source>([\s\S]*?)<\/source>(?!\s*<target)/g,
      (_, text: string) => {
        // The first unit comes back empty, so the report shows a refused one too.
        const target = first ? '' : text;
        first = false;
        return `<source>${text}</source><target>${target}</target>`;
      },
    ),
  );
}

test.describe('the user guide: translations and media', () => {
  test('translation status', async ({ page, save, l }) => {
    await signIn(page, USERS.translator);
    await page.goto('/translations');
    const matrix = page.getByRole('grid', {
      name: l('translations.matrix.label'),
    });
    await expect(matrix.getByRole('row').nth(3)).toBeVisible();
    await page.locator('[data-cell="de/charging"]').click();
    await expect(
      page
        .locator('[data-slot="cell-panel"] [data-slot="panel-block"]')
        .first(),
    ).toBeVisible();
    await save('translation-status');
  });

  test('delta export', async ({ page, save, l }) => {
    await signIn(page, USERS.translator);
    await page.goto('/translations');
    await page
      .getByRole('button', { name: l('translations.export.action') })
      .click();
    const dialog = page.getByRole('dialog', {
      name: l('translations.export.title'),
    });
    await dialog
      .getByText(l('translations.export.manual'), { exact: true })
      .click();
    await dialog.getByRole('combobox').first().click();
    await page.getByRole('option').first().click();
    await expect(dialog.getByText(/ · /).first()).toBeVisible();
    await save('translation-export');
  });

  test('page design text in the matrix', async ({ page, save }) => {
    await signIn(page, USERS.translator);
    await page.goto('/translations?lang=de&cell=de/designs/classic');
    await expect(
      page
        .locator('[data-slot="cell-panel"] [data-slot="panel-block"]')
        .first(),
    ).toBeVisible();
    await save('translation-special-texts');
  });

  test('reports', async ({ page, save }) => {
    await signIn(page, USERS.translator);
    await page.goto('/reports/translations');
    await expect(page.getByRole('row').nth(2)).toBeVisible();
    await save('translation-report');
    await signIn(page, USERS.author);
    await page.goto('/reports/usage');
    await expect(page.getByRole('row').nth(2)).toBeVisible();
    await save('translation-usage-report');
  });

  test('a module’s languages', async ({ page, save, lang, text, as, l }) => {
    const revision = await revisionWithModule(
      await as(USERS.admin),
      lang,
      text.revision,
    );
    await signIn(page, USERS.admin);
    await openModule(
      page,
      `/content/${lang}/${MODULE_ID}?cs=${revision.id}`,
      text.module,
    );
    const card = page.locator('section', {
      has: page.getByRole('heading', {
        name: l('moduleEditor.translations.title'),
      }),
    });
    await expect(card).toBeVisible();
    await save('translation-new-language', card);
  });

  test('media library', async ({ page, save }) => {
    await signIn(page, USERS.author);
    await page.goto('/media');
    const files = page.getByRole('region', { name: /./ }).first();
    await expect(files).toBeVisible();
    await page.getByRole('option').first().click();
    await page.waitForTimeout(1000);
    await save('media-library');
  });

  test('a fresh upload', async ({ page, save, text, as, l }) => {
    const author = await as(USERS.author);
    const revision = await author.createChangeSet(text.revision);
    await author.uploadImage(revision.id, png([29, 78, 216]));
    await signIn(page, USERS.author);
    await page.goto(`/media?cs=${revision.id}&view=table`);
    const files = page.getByRole('region', { name: l('media.list') });
    await files.locator('[data-slot="media-row"]').first().click();
    await expect(
      page.getByRole('complementary', { name: l('media.detail.title') }),
    ).toBeVisible();
    await page.waitForTimeout(1000);
    await save('media-uploads');
  });

  test('safety symbol', async ({ page, save, lang, text, as }) => {
    const revision = await revisionWithModule(
      await as(USERS.admin),
      lang,
      text.revision,
    );
    await signIn(page, USERS.admin);
    await openModule(
      page,
      `/content/${lang}/${MODULE_ID}?cs=${revision.id}`,
      text.module,
    );
    await page.locator('of-safety-node button[z-dropdown]').click();
    await expect(page.getByRole('menuitemcheckbox').first()).toBeVisible();
    await page.waitForTimeout(500);
    await save('media-safety-symbols');
  });

  test('storage', async ({ page, save }) => {
    await signIn(page, USERS.admin);
    await page.goto('/admin/system');
    const card = page.locator('[data-slot="storage-card"]');
    await expect(card.locator('[data-slot="storage-used"]')).toBeVisible();
    await save('media-storage', card);
  });

  test('branding images', async ({ page, save, l }) => {
    await signIn(page, USERS.admin);
    await page.goto('/admin/branding');
    const images = page.locator('section', {
      has: page.getByRole('heading', {
        name: l('admin.branding.images.title'),
      }),
    });
    await expect(images.locator('li[data-field="favicon"]')).toBeVisible();
    await save('media-branding', images);
  });

  // Last: a delta export marks the manual's blocks as at the agency until it is cancelled, at
  // the end of the shot.
  test('jobs and an import', async ({ page, save, as }) => {
    const admin = await as(USERS.admin);
    const job = await exportOperating(admin);
    try {
      await signIn(page, USERS.admin);
      await page.goto('/translations/jobs');
      await expect(page.getByRole('row').nth(1)).toBeVisible();
      await save('translation-jobs');

      const file = await translatedFile(admin, job);
      await page.goto('/translations/import');
      await page.locator('#translation-import-file').setInputFiles({
        name: `translation-${job}-de.xlf`,
        mimeType: 'application/octet-stream',
        buffer: file,
      });
      await expect(page.locator('[data-slot="count-ready"]')).toBeVisible();
      await page.waitForTimeout(1500);
      await save('translation-import');
    } finally {
      const cancelled = await admin.send(
        'POST',
        `/translations/exports/${job}/cancel`,
      );
      // Left at the agency, its blocks would show so in every later shot.
      expect(cancelled.ok()).toBe(true);
    }
  });
});
