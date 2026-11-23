import type { Page, Route } from '@playwright/test';
import {
  expect,
  MODULE_ID,
  openModule,
  paragraph,
  revisionWithModule,
  signIn,
  test,
  TEXT,
  USERS,
  type Text,
} from './fixtures.ts';

// The guide's screens of a module's and a manual's life (#680): terminology, a module's history,
// its actions, a revision's take-out, a contributor's suggestion, the style review, and a manual's
// menu, settings, PDF preview, audience check, history and notice-gathering rule. Each shot works
// in a revision of its own (abandoned after it) and never merges into main.

/** A side panel's tab (a segmented control): its label, as the person clicks it. */
async function chooseSegment(
  page: Page,
  group: string,
  option: string,
): Promise<void> {
  await page
    .getByRole('radiogroup', { name: group })
    .locator('label')
    .filter({ has: page.getByRole('radio', { name: option, exact: true }) })
    .click();
}

/** The style review's answer for the guide's module, per language: two wording suggestions. */
function styleSuggestions(text: Text, lang: string) {
  const pick =
    lang === 'de'
      ? [
          {
            block: 'intro',
            field: 'content',
            in: text.intro,
            original: 'nicht mehr für eine ganze Schicht reicht',
            replacement: 'keine ganze Schicht mehr reicht',
            message: 'Kürzer und direkter.',
          },
          {
            block: 'step-3',
            field: 'content',
            in: text.steps[2],
            original: 'die neue',
            replacement: 'die neue Batterie',
            message: 'Nennen Sie das Teil, statt es nur mitzudenken.',
          },
        ]
      : [
          {
            block: 'intro',
            field: 'content',
            in: text.intro,
            original: 'no longer lasts',
            replacement: 'does not last',
            message: 'Prefer the plain phrase.',
          },
          {
            block: 'step-3',
            field: 'content',
            in: text.steps[2],
            original: 'put in',
            replacement: 'insert',
            message: 'Use one verb for one action.',
          },
        ];
  return pick.map((s, i) => {
    const start = s.in.indexOf(s.original);
    return {
      id: `s${i + 1}`,
      blockId: s.block,
      field: s.field,
      range: { start, end: start + s.original.length },
      original: s.original,
      message: s.message,
      replacement: s.replacement,
      rule: 'model',
    };
  });
}

test.describe('the user guide: a module’s and a manual’s life', () => {
  test('terminology', async ({ page, save, text, as }) => {
    const revision = await (
      await as(USERS.author)
    ).createChangeSet(text.revision);
    await signIn(page, USERS.author);
    await page.goto(`/terminology?term=power-pack&cs=${revision.id}`);
    await expect(page.locator('[data-slot="term-row"]').first()).toBeVisible();
    await expect(
      page.locator('[data-slot="term-row"][data-term="power-pack"]'),
    ).toHaveAttribute('data-state', 'selected');
    await save('terminology');
  });

  test('module history', async ({ page, save, lang, text, as }) => {
    const admin = await as(USERS.admin);
    const revision = await revisionWithModule(admin, lang, text.revision);
    await admin.editModule(
      revision.id,
      { lang, moduleId: MODULE_ID },
      (module) => ({
        ...module,
        blocks: [
          paragraph('intro', `${text.intro} ${text.large}`),
          ...module.blocks.slice(1),
        ],
      }),
    );
    await signIn(page, USERS.admin);
    await page.goto(`/content/${lang}/${MODULE_ID}/history?cs=${revision.id}`);
    await expect(page.locator('[data-slot="history-restore"]')).toBeVisible();
    await expect(page.locator('ins').first()).toBeVisible();
    await save('module-history');
  });

  test('module actions', async ({ page, save, lang, text, l, as }) => {
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
    await page
      .getByRole('button', { name: l('moduleEditor.actions.label') })
      .click();
    await expect(page.getByRole('menu')).toBeVisible();
    await save('module-actions');
    await page.keyboard.press('Escape');
  });

  test('change a module ID', async ({ page, save, lang, text, l, as }) => {
    // A module the manuals use, so the panel lists the files it rewrites.
    const revision = await (
      await as(USERS.admin)
    ).createChangeSet(text.revision);
    await signIn(page, USERS.admin);
    const locked = page.waitForResponse(
      (r) => r.url().includes('/locks') && r.request().method() === 'POST',
    );
    await page.goto(`/content/${lang}/charging?cs=${revision.id}`);
    await locked;
    await page
      .getByRole('button', { name: l('moduleEditor.rename.action') })
      .first()
      .click();
    await page
      .getByRole('textbox', { name: l('moduleEditor.rename.newId') })
      .fill(lang === 'de' ? 'akku-laden' : 'battery-charging');
    const submit = page
      .getByRole('button', { name: l('moduleEditor.rename.submit') })
      .last();
    await expect(
      page.getByRole('list', { name: l('moduleEditor.rename.references') }),
    ).toBeVisible();
    await submit.scrollIntoViewIfNeeded();
    await save('module-change-id');
  });

  test('take out of a revision', async ({ page, save, lang, text, l, as }) => {
    const author = await as(USERS.author);
    const revision = await revisionWithModule(author, lang, text.revision);
    await author.editModule(
      revision.id,
      { lang: 'en', moduleId: 'charging' },
      (module) => ({
        ...module,
        blocks: [...module.blocks, paragraph('housing', TEXT.en.mainChange)],
      }),
    );
    await signIn(page, USERS.author);
    await page.goto(`/review?cs=${revision.id}`);
    const takeOut = page.getByRole('button', {
      name: l('review.takeOut.action'),
    });
    await expect(takeOut.first()).toBeVisible();
    await takeOut.last().click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await save('revision-take-out');
    await page.keyboard.press('Escape');
  });

  test('suggest a change', async ({ page, save, lang, l, as }) => {
    const contributor = await as(USERS.contributor);
    await signIn(page, USERS.contributor);
    await page.goto(`/content/${lang === 'de' ? 'de' : 'en'}/charging`);
    await page.getByRole('button', { name: l('suggestion.start') }).click();
    await expect(page).toHaveURL(/[?&]cs=[0-9a-f-]{36}/);
    contributor.adopt(new URL(page.url()).searchParams.get('cs') ?? '');
    const note = page.getByRole('textbox', { name: l('suggestion.note') });
    await expect(note).toBeVisible();
    await note.fill(
      lang === 'de'
        ? 'Ladezeit für das große Modell ergänzt'
        : 'Added the charging time of the large model',
    );
    await save('module-suggest');
  });

  test('style review', async ({ page, save, lang, text, l, as }) => {
    const revision = await revisionWithModule(
      await as(USERS.author),
      lang,
      text.revision,
    );
    // The screenshots' API has no style reviewer: its answer is the one a model would give.
    await page.route(
      (url) =>
        url.pathname.endsWith(`/modules/${lang}/${MODULE_ID}/style-review`),
      (route: Route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/vnd.api+json',
          body: JSON.stringify({
            data: {
              type: 'StyleReview',
              id: `${lang}/${MODULE_ID}`,
              attributes: {
                lang,
                moduleId: MODULE_ID,
                suggestions: styleSuggestions(text, lang),
              },
              meta: { version: 1, baseCommit: 'a'.repeat(40), dropped: 0 },
            },
          }),
        }),
    );
    await signIn(page, USERS.author);
    await openModule(
      page,
      `/content/${lang}/${MODULE_ID}?cs=${revision.id}`,
      text.module,
    );
    await chooseSegment(
      page,
      l('moduleEditor.side.label'),
      l('moduleEditor.side.suggestions'),
    );
    const panel = page.locator('[data-slot="suggestions-panel"]');
    await panel.getByRole('button', { name: l('suggestions.review') }).click();
    await expect(panel.locator('[data-slot="suggestion"]')).toHaveCount(2);
    await save('module-style-review');
  });

  test('manual menu and settings', async ({ page, save, text, l, as }) => {
    const revision = await (
      await as(USERS.admin)
    ).createChangeSet(text.revision);
    await signIn(page, USERS.admin);
    await page.goto(`/manuals?manual=operating&cs=${revision.id}`);
    await expect(
      page.getByRole('tree').getByRole('treeitem').first(),
    ).toBeVisible();
    // The PDF preview card: the cover and the first page.
    const preview = page.locator('of-cover-preview');
    await expect(preview.locator('img').first()).toBeVisible({
      timeout: 60_000,
    });
    await save('manual-pdf-preview', preview);

    await page.getByTestId('manual-menu').click();
    await expect(page.getByRole('menu')).toBeVisible();
    await save('manual-menu');
    await page.keyboard.press('Escape');

    await page.getByTestId('settings-open').click();
    await expect(
      page.getByRole('dialog').getByText(l('manuals.settings.variants.list')),
    ).toBeVisible();
    await save('manual-settings');
  });

  test('above the manual’s audience', async ({ page, save, text, l, as }) => {
    const admin = await as(USERS.admin);
    const revision = await admin.createChangeSet(text.revision);
    await admin.editModule(
      revision.id,
      { lang: 'en', moduleId: 'charging' },
      (module) => ({
        ...module,
        meta: { ...(module.meta as object), audience: 'internal' },
      }),
    );
    await signIn(page, USERS.admin);
    await page.goto(`/checks?manual=operating&cs=${revision.id}`);
    const finding = page
      .getByText(l('checks.codes.above-audience.title'), { exact: true })
      .first();
    await expect(finding).toBeVisible();
    await finding.scrollIntoViewIfNeeded();
    await save('manual-above-audience');
  });

  test('manual history', async ({ page, save, text, as }) => {
    const admin = await as(USERS.admin);
    const revision = await admin.createChangeSet(text.revision);
    await admin.editManual(revision.id, 'operating', (manual) => ({
      ...manual,
      entries: [
        ...(manual['entries'] as unknown[]).filter(
          (e) => (e as { module?: string }).module !== 'storage',
        ),
      ],
    }));
    await signIn(page, USERS.admin);
    await page.goto(`/manuals/operating/history?cs=${revision.id}`);
    await expect(page.locator('[data-slot="history-restore"]')).toBeVisible();
    await page.waitForTimeout(1000);
    await save('manual-history');
  });

  test('notice gathering rule', async ({ page, save, lang, text, as }) => {
    const admin = await as(USERS.admin);
    const revision = await admin.createChangeSet(text.revision);
    // A leaflet of the operating manual's safety notices, grouped by hazard level.
    await admin.createManual(revision, 'safety-notices', {
      kind: 'derived',
      title: lang === 'de' ? 'Sicherheitshinweise' : 'Safety notices',
      audience: 'public',
      variants: [{ model: 'small' }, { model: 'large' }],
      rule: {
        source: 'operating',
        exclude: [],
        front: [],
        back: [],
        notices: { groupBy: 'level' },
      },
    });
    await signIn(page, USERS.admin);
    await page.goto(`/manuals?manual=safety-notices&cs=${revision.id}`);
    await expect(
      page.getByRole('tree').getByRole('treeitem').first(),
    ).toBeVisible();
    const rule = page.getByTestId('derived-rule');
    await expect(
      rule.locator('of-collapse:has([data-testid=rule-notices])'),
    ).toHaveAttribute('data-state', 'open');
    await save('manual-leaflet-notices');
  });
});
