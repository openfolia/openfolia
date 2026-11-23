import { deflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import {
  expect,
  openModule,
  paragraph,
  signIn,
  t,
  test,
  USERS,
  type Api,
  type Block,
} from './fixtures.ts';

// The guide's pages on the blocks of a module (#680): headings and tables, safety notices and
// notes, procedures, FAQ entries, page breaks and text attributes, cross-references, images and
// their callouts, attachments, and right-to-left languages. Each shot makes a module of its own
// in a revision of its own (abandoned after it), in English and, for the German run, in German.

/** The example texts of these shots, per language. */
const WORDS = {
  en: {
    revision: 'Describe the charger',
    tables: 'Charging times',
    charging: 'Charging',
    chargingIntro: 'The charger fills the battery in a few hours.',
    times: 'Charging times',
    tableHead: ['Battery', 'Empty to full', 'Empty to 80 %'],
    tableRows: [
      ['Standard', '4 h', '2.5 h'],
      ['Long life', '6 h', '4 h'],
      ['Fast charge', '2 h', '1 h'],
    ],
    storage: 'Storage',
    storageText: 'Store the battery half charged.',
    notices: 'Handle the battery safely',
    hazard: 'Heavy battery',
    consequence: 'The battery can crush your fingers.',
    measure: 'Lift it with both hands, by its handles.',
    tip: 'Charge the battery before its first use.',
    procedureModule: 'Replace the fuse',
    procedure: 'Replace the fuse',
    steps: [
      'Switch off the charger and unplug it.',
      'Open the fuse holder under the socket.',
      'Put in a new fuse of the same rating.',
    ],
    stepImage: 'The fuse holder under the socket, opened',
    faqModule: 'Questions about charging',
    question: 'Can I charge the battery overnight?',
    answer: 'Yes. The charger stops when the battery is full.',
    afterBreak: ['Read the label on ', ' before you plug it in.'],
    xrefModule: 'Charger overview',
    xrefIntro: 'For the times, see ',
    xrefOutro: '.',
    parts: 'Parts',
    partsText: 'The charger has a power switch and a status lamp.',
    imageModule: 'The charger',
    imageAlt: 'The charger from the front, with its switch and lamp',
    imageCaption: 'The charger',
    calloutText: ['Press the power switch ', ', then check the lamp ', '.'],
    legends: ['Status lamp', 'Power switch', 'Socket'],
    attachModule: 'Charger settings',
    attachIntro: 'Load these settings into the charger with its service tool.',
    attachName: 'Sample configuration',
    attachDescription: 'Settings for the standard battery',
    reuseModule: 'Charging station',
    reuseIntro: 'Before you charge the battery, read this notice.',
  },
  de: {
    revision: 'Das Ladegerät beschreiben',
    tables: 'Ladezeiten',
    charging: 'Laden',
    chargingIntro: 'Das Ladegerät lädt die Batterie in wenigen Stunden.',
    times: 'Ladezeiten',
    tableHead: ['Batterie', 'Leer bis voll', 'Leer bis 80 %'],
    tableRows: [
      ['Standard', '4 h', '2,5 h'],
      ['Langlebig', '6 h', '4 h'],
      ['Schnellladen', '2 h', '1 h'],
    ],
    storage: 'Lagerung',
    storageText: 'Lagern Sie die Batterie halb geladen.',
    notices: 'Sicher mit der Batterie umgehen',
    hazard: 'Schwere Batterie',
    consequence: 'Die Batterie kann Ihre Finger quetschen.',
    measure: 'Heben Sie sie mit beiden Händen an den Griffen an.',
    tip: 'Laden Sie die Batterie vor dem ersten Gebrauch.',
    procedureModule: 'Sicherung wechseln',
    procedure: 'Sicherung wechseln',
    steps: [
      'Schalten Sie das Ladegerät aus und ziehen Sie den Stecker.',
      'Öffnen Sie den Sicherungshalter unter der Buchse.',
      'Setzen Sie eine neue Sicherung mit demselben Nennwert ein.',
    ],
    stepImage: 'Der geöffnete Sicherungshalter unter der Buchse',
    faqModule: 'Fragen zum Laden',
    question: 'Kann ich die Batterie über Nacht laden?',
    answer: 'Ja. Das Ladegerät stoppt, wenn die Batterie voll ist.',
    afterBreak: [
      'Lesen Sie das Typenschild von ',
      ', bevor Sie es einstecken.',
    ],
    xrefModule: 'Das Ladegerät im Überblick',
    xrefIntro: 'Die Zeiten finden Sie unter ',
    xrefOutro: '.',
    parts: 'Teile',
    partsText: 'Das Ladegerät hat einen Netzschalter und eine Statusleuchte.',
    imageModule: 'Das Ladegerät',
    imageAlt: 'Das Ladegerät von vorn, mit Schalter und Leuchte',
    imageCaption: 'Das Ladegerät',
    calloutText: [
      'Drücken Sie den Netzschalter ',
      ' und prüfen Sie dann die Leuchte ',
      '.',
    ],
    legends: ['Statusleuchte', 'Netzschalter', 'Buchse'],
    attachModule: 'Einstellungen des Ladegeräts',
    attachIntro:
      'Laden Sie diese Einstellungen mit dem Servicewerkzeug ins Ladegerät.',
    attachName: 'Beispielkonfiguration',
    attachDescription: 'Einstellungen für die Standardbatterie',
    reuseModule: 'Ladestation',
    reuseIntro: 'Lesen Sie diesen Hinweis, bevor Sie die Batterie laden.',
  },
} as const;
type Words = (typeof WORDS)['en'] | (typeof WORDS)['de'];
const words = (lang: string): Words => (lang === 'de' ? WORDS.de : WORDS.en);

// A picture of a charger, drawn here: a PNG needs no image tool, only zlib and a CRC.
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
type Rgb = readonly [number, number, number];
function png(width: number, height: number, at: (x: number, y: number) => Rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) raw.set(at(x, y), row + 1 + x * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** A charger seen from the front: its housing, a lamp, a switch and a socket. */
const CHARGER = png(480, 300, (x, y) => {
  const inBox = (x0: number, y0: number, x1: number, y1: number) =>
    x >= x0 && x < x1 && y >= y0 && y < y1;
  const inCircle = (cx: number, cy: number, r: number) =>
    (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  if (inCircle(330, 110, 18)) return [34, 197, 94];
  if (inBox(130, 160, 200, 200)) return [30, 41, 59];
  if (inBox(300, 200, 360, 240)) return [15, 23, 42];
  if (inBox(90, 60, 390, 260)) return [148, 163, 184];
  if (inBox(70, 260, 410, 270)) return [100, 116, 139];
  return [241, 245, 249];
});

/**
 * A module of the shot's own in a new revision: in English, and in German too for the German
 * run (the same ID, the German blocks), so the editor opens it in the run's language.
 */
async function moduleOf(
  api: Api,
  lang: string,
  id: string,
  title: (w: Words) => string,
  blocks: (w: Words, image: string) => Block[],
  { image = false }: { image?: boolean } = {},
) {
  const revision = await api.createChangeSet(words(lang).revision);
  const asset = image ? await api.uploadImage(revision.id, CHARGER) : '';
  await api.createModule(
    revision,
    {
      lang: 'en',
      moduleId: id,
      title: title(WORDS.en),
      blocks: blocks(WORDS.en, asset),
    },
    { savePoint: lang === 'en' },
  );
  if (lang === 'de')
    await api.createModule(revision, {
      lang,
      moduleId: id,
      title: title(WORDS.de),
      blocks: blocks(WORDS.de, asset),
    });
  return revision;
}

const cell = (id: string, text: string) => ({ blocks: [paragraph(id, text)] });

/** The editor's document area of module `title`. */
const documentOf = (page: Page, title: string) =>
  page.getByRole('textbox', { name: new RegExp(title) });

test.describe('the user guide: writing blocks', () => {
  test('headings and tables', async ({ page, save, lang, l, as }) => {
    const w = words(lang);
    const revision = await moduleOf(
      await as(USERS.admin),
      lang,
      'guide-charging-times',
      (x) => x.tables,
      (x) => [
        {
          type: 'section',
          id: 'charging',
          title: [t(x.charging)],
          blocks: [
            paragraph('charging-intro', x.chargingIntro),
            {
              type: 'section',
              id: 'times',
              title: [t(x.times)],
              blocks: [
                {
                  type: 'table',
                  id: 'times-table',
                  columns: [
                    { width: 2 },
                    { width: 1, align: 'right' },
                    { width: 1, align: 'right' },
                  ],
                  header: true,
                  rows: [
                    { cells: x.tableHead.map((h, i) => cell(`h${i}`, h)) },
                    ...x.tableRows.map((row, r) => ({
                      cells: row.map((value, c) => cell(`r${r}c${c}`, value)),
                    })),
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'section',
          id: 'storage',
          title: [t(x.storage)],
          blocks: [paragraph('storage-text', x.storageText)],
        },
      ],
    );
    await signIn(page, USERS.admin);
    await openModule(
      page,
      `/content/${lang}/guide-charging-times?cs=${revision.id}`,
      w.tables,
    );
    const doc = documentOf(page, w.tables);

    // The heading's text style menu: the levels, and a level down or up.
    await doc.getByText(w.times, { exact: true }).click();
    await page
      .getByRole('button', { name: l('docEditor.toolbar.textStyle') })
      .click();
    await expect(page.getByRole('menu')).toBeVisible();
    await save('writing-heading-levels');
    await page.keyboard.press('Escape');

    // The table's actions, from a cell.
    await doc.getByText(w.tableRows[1][0], { exact: true }).click();
    await page
      .getByRole('button', { name: l('docEditor.table.actions') })
      .click();
    await expect(page.getByRole('menu')).toBeVisible();
    await save('writing-table-menu');
  });

  test('safety notices and notes', async ({ page, save, lang, l, as }) => {
    const w = words(lang);
    const revision = await moduleOf(
      await as(USERS.admin),
      lang,
      'guide-battery-safety',
      (x) => x.notices,
      (x) => [
        {
          type: 'safety',
          id: 'heavy',
          severity: 'warning',
          hazard: [t(x.hazard)],
          symbols: ['w001'],
          blocks: [
            paragraph('heavy-consequence', x.consequence),
            paragraph('heavy-measure', x.measure),
          ],
        },
        {
          type: 'admonition',
          id: 'first-charge',
          kind: 'tip',
          blocks: [paragraph('first-charge-text', x.tip)],
        },
      ],
    );
    await signIn(page, USERS.admin);
    await openModule(
      page,
      `/content/${lang}/guide-battery-safety?cs=${revision.id}`,
      w.notices,
    );
    await expect(
      page.locator('of-safety-node [data-symbol] img').first(),
    ).toBeVisible();
    const menu = page.getByRole('button', {
      name: l('docEditor.safety.settings'),
    });
    await menu.hover();
    await menu.click();
    await expect(page.getByRole('menuitemcheckbox').first()).toBeVisible();
    await expect(
      page.getByRole('menuitemcheckbox').first().locator('img'),
    ).toBeVisible();
    await save('writing-safety-menu');
  });

  test('procedures', async ({ page, save, lang, as }) => {
    const w = words(lang);
    const revision = await moduleOf(
      await as(USERS.admin),
      lang,
      'guide-replace-fuse',
      (x) => x.procedureModule,
      (x, image) => [
        {
          type: 'procedure',
          id: 'fuse',
          title: [t(x.procedure)],
          steps: x.steps.map((step, i) => ({
            id: `fuse-${i + 1}`,
            content: [t(step)],
            blocks:
              i === 1
                ? [
                    {
                      type: 'image',
                      id: 'fuse-holder',
                      asset: image,
                      alt: x.stepImage,
                      width: 40,
                    },
                  ]
                : [],
          })),
        },
      ],
      { image: true },
    );
    await signIn(page, USERS.admin);
    await openModule(
      page,
      `/content/${lang}/guide-replace-fuse?cs=${revision.id}`,
      w.procedureModule,
    );
    const procedure = page.locator('[data-node="procedure"]').first();
    await expect(procedure.locator('img').first()).toBeVisible();
    await documentOf(page, w.procedureModule).getByText(w.steps[2]).click();
    await page.keyboard.press('End');
    await save('writing-procedure', page.locator('of-procedure-node').first());
  });

  test('FAQ entries, page breaks and text attributes', async ({
    page,
    save,
    lang,
    as,
  }) => {
    const w = words(lang);
    const revision = await moduleOf(
      await as(USERS.admin),
      lang,
      'guide-charging-questions',
      (x) => x.faqModule,
      (x) => [
        {
          type: 'faq',
          id: 'overnight',
          question: [t(x.question)],
          blocks: [paragraph('overnight-answer', x.answer)],
        },
        { type: 'pageBreak', id: 'break' },
        {
          type: 'paragraph',
          id: 'label',
          content: [
            t(x.afterBreak[0]),
            { type: 'attribute', name: 'product-name' },
            t(x.afterBreak[1]),
          ],
        },
      ],
    );
    await signIn(page, USERS.admin);
    await openModule(
      page,
      `/content/${lang}/guide-charging-questions?cs=${revision.id}&preview=open`,
      w.faqModule,
    );
    const preview = page
      .locator('of-preview-frame:not(.opacity-0) iframe')
      .contentFrame();
    await expect(preview.locator('.of-attribute--unset')).toBeVisible({
      timeout: 20_000,
    });
    await save('writing-faq-entry', page.locator('of-faq-node').first());
    await save('writing-page-break-preview');
  });

  test('cross-references', async ({ page, save, lang, l, as }) => {
    const w = words(lang);
    const revision = await moduleOf(
      await as(USERS.admin),
      lang,
      'guide-charger-overview',
      (x) => x.xrefModule,
      (x) => [
        {
          type: 'paragraph',
          id: 'see-times',
          content: [
            t(x.xrefIntro),
            { type: 'xref', module: 'charging', text: [t(x.times)] },
            t(x.xrefOutro),
          ],
        },
        {
          type: 'section',
          id: 'parts',
          title: [t(x.parts)],
          blocks: [paragraph('parts-text', x.partsText)],
        },
        {
          type: 'section',
          id: 'storage',
          title: [t(x.storage)],
          blocks: [paragraph('storage-text', x.storageText)],
        },
      ],
    );
    await signIn(page, USERS.admin);
    await openModule(
      page,
      `/content/${lang}/guide-charger-overview?cs=${revision.id}`,
      w.xrefModule,
    );
    await documentOf(page, w.xrefModule).getByText(w.partsText).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' /');
    await page.keyboard.type(l('docEditor.slash.xref').slice(0, 5));
    await page
      .getByRole('option', { name: new RegExp(l('docEditor.slash.xref')) })
      .click();
    const picker = page.getByRole('dialog', {
      name: l('docEditor.xref.title'),
    });
    await expect(picker.getByRole('option').nth(2)).toBeVisible();
    await save('writing-cross-reference');
  });

  // #223: one block of another module, chosen in the module reference picker's preview.
  test('one block of a module', async ({ page, save, lang, l, as }) => {
    const w = words(lang);
    const admin = await as(USERS.admin);
    const notice = (x: Words): Block[] => [
      {
        type: 'safety',
        id: 'heavy',
        severity: 'warning',
        hazard: [t(x.hazard)],
        symbols: [],
        blocks: [
          paragraph('heavy-consequence', x.consequence),
          paragraph('heavy-measure', x.measure),
        ],
      },
      {
        type: 'admonition',
        id: 'first-charge',
        kind: 'tip',
        blocks: [paragraph('first-charge-text', x.tip)],
      },
    ];
    const revision = await moduleOf(
      admin,
      lang,
      'guide-charging-station',
      (x) => x.reuseModule,
      (x) => [paragraph('intro', x.reuseIntro)],
    );
    for (const at of lang === 'de'
      ? (['en', 'de'] as const)
      : (['en'] as const))
      await admin.createModule(revision, {
        lang: at,
        moduleId: 'guide-battery-handling',
        title: WORDS[at].notices,
        blocks: notice(WORDS[at]),
      });
    await signIn(page, USERS.admin);
    await openModule(
      page,
      `/content/${lang}/guide-charging-station?cs=${revision.id}`,
      w.reuseModule,
    );
    await documentOf(page, w.reuseModule).getByText(w.reuseIntro).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/');
    await page.keyboard.type(l('docEditor.slash.moduleRef').slice(0, 5));
    await page
      .getByRole('option', {
        name: new RegExp(l('docEditor.slash.moduleRef')),
      })
      .click();
    await page
      .locator('of-module-ref-node')
      .getByRole('button', { name: l('docEditor.moduleRef.choose') })
      .click();
    const picker = page.getByRole('dialog', { name: l('modulePicker.title') });
    await picker
      .getByRole('searchbox', { name: l('modulePicker.search') })
      .fill(w.notices);
    await picker
      .locator('button[data-picker-row]')
      .filter({ hasText: w.notices })
      .click();
    await picker
      .getByRole('radio', { name: new RegExp(l('modulePicker.block')) })
      .click();
    await picker
      .locator('[data-block-chooser]')
      .getByRole('radio', { name: new RegExp(w.hazard) })
      .click();
    await expect(
      picker.getByRole('button', {
        name: l('modulePicker.insert'),
        exact: true,
      }),
    ).not.toHaveAttribute('aria-disabled', 'true');
    await save('writing-reuse-one-block');
  });

  test('images', async ({ page, save, lang, l, as }) => {
    const w = words(lang);
    const revision = await moduleOf(
      await as(USERS.admin),
      lang,
      'guide-charger-image',
      (x) => x.imageModule,
      (x, image) => [
        paragraph('parts-text', x.partsText),
        {
          type: 'image',
          id: 'front',
          asset: image,
          alt: x.imageAlt,
          width: 50,
        },
      ],
      { image: true },
    );
    await signIn(page, USERS.admin);
    await openModule(
      page,
      `/content/${lang}/guide-charger-image?cs=${revision.id}`,
      w.imageModule,
    );
    const image = page.locator('[data-node="image"]').first();
    await expect(image.locator('img').first()).toBeVisible();
    await image
      .getByRole('button', { name: l('docEditor.image.edit'), exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: l('images.editTitle') });
    await expect(dialog.getByRole('radio').first()).toBeVisible();
    await expect(dialog.locator('img').first()).toBeVisible();
    await dialog.locator('#image-caption').fill(w.imageCaption);
    await save('writing-image-dialog');
  });

  test('image callouts', async ({ page, save, lang, l, as }) => {
    const w = words(lang);
    const callout = (id: string, x: number, y: number, legend: string) => ({
      id,
      anchor: { x, y },
      legend: [t(legend)],
    });
    const ref = (id: string) => ({
      type: 'calloutRef',
      block: 'front',
      callout: id,
    });
    const revision = await moduleOf(
      await as(USERS.admin),
      lang,
      'guide-charger-callouts',
      (x) => x.imageModule,
      (x, image) => [
        {
          type: 'paragraph',
          id: 'use',
          content: [
            t(x.calloutText[0]),
            ref('switch'),
            t(x.calloutText[1]),
            ref('lamp'),
            t(x.calloutText[2]),
          ],
        },
        {
          type: 'image',
          id: 'front',
          asset: image,
          alt: x.imageAlt,
          title: [t(x.imageCaption)],
          width: 60,
          calloutLegend: 'beside',
          callouts: [
            callout('lamp', 0.69, 0.37, x.legends[0]),
            callout('switch', 0.34, 0.6, x.legends[1]),
            callout('socket', 0.69, 0.73, x.legends[2]),
          ],
        },
      ],
      { image: true },
    );
    await signIn(page, USERS.admin);
    await openModule(
      page,
      `/content/${lang}/guide-charger-callouts?cs=${revision.id}&preview=open`,
      w.imageModule,
    );
    const image = page.locator('[data-node="image"]').first();
    const panel = image.locator('[data-slot="callout-panel"]');
    await expect(image.locator('[data-slot="callout-marker"]')).toHaveCount(3);
    await panel
      .getByRole('button', { name: l('docEditor.callouts.edit') })
      .click();
    await expect(panel.locator('[data-callout-row]')).toHaveCount(3);
    // The switch's row chosen: its variants and its leader line below it.
    await panel
      .locator('[data-callout-row="switch"] [data-slot="callout-legend-text"]')
      .click();
    await expect(
      panel.locator('[data-action="callout-leader"]').first(),
    ).toBeVisible();
    const preview = page
      .locator('of-preview-frame:not(.opacity-0) iframe')
      .contentFrame();
    await expect(preview.locator('.of-callouts__entry')).toHaveCount(3, {
      timeout: 20_000,
    });
    await image.scrollIntoViewIfNeeded();
    await save('writing-callouts');
  });

  test('attachments', async ({ page, save, lang, l, as }) => {
    const w = words(lang);
    const revision = await moduleOf(
      await as(USERS.admin),
      lang,
      'guide-charger-settings',
      (x) => x.attachModule,
      (x) => [paragraph('intro', x.attachIntro)],
    );
    await signIn(page, USERS.admin);
    await openModule(
      page,
      `/content/${lang}/guide-charger-settings?cs=${revision.id}`,
      w.attachModule,
    );
    await documentOf(page, w.attachModule).getByText(w.attachIntro).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/');
    await page.keyboard.type(l('docEditor.slash.attachment').slice(0, 5));
    await page
      .getByRole('option', {
        name: new RegExp(l('docEditor.slash.attachment')),
      })
      .click();
    const dialog = page.getByRole('dialog', { name: l('attachments.title') });
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      dialog.getByRole('button', { name: l('attachments.upload') }).click(),
    ]);
    await chooser.setFiles({
      name: 'charger-settings.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify(
          { battery: 'standard', maxCurrent: 8, stopAtFull: true },
          null,
          2,
        ),
      ),
    });
    await expect(
      dialog.getByText('charger-settings.json').first(),
    ).toBeVisible();
    await expect(dialog.getByText(l('attachments.uploading'))).toHaveCount(0);
    await dialog.locator('#attachment-name').fill(w.attachName);
    await dialog.locator('#attachment-description').fill(w.attachDescription);
    await save('writing-attach-dialog');
    await dialog.getByRole('button', { name: l('attachments.insert') }).click();
    await expect(dialog).toBeHidden();
    const block = page.locator('of-attachment-node').first();
    await expect(block.getByText(w.attachName)).toBeVisible();
    await save('writing-attachment-block', block);
  });

  test('right to left', async ({ page, save, lang, as }) => {
    const revision = await (
      await as(USERS.admin)
    ).createChangeSet(words(lang).revision);
    await signIn(page, USERS.admin);
    await openModule(
      page,
      `/content/ar/display?cs=${revision.id}&preview=open`,
      'الشاشة',
    );
    const preview = page
      .locator('of-preview-frame:not(.opacity-0) iframe')
      .contentFrame();
    await expect(preview.locator('html')).toHaveAttribute('dir', 'rtl', {
      timeout: 20_000,
    });
    await save('writing-right-to-left');
  });
});
