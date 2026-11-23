import {
  moduleId,
  paragraph,
  unique,
  type Api,
  type Block,
} from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

// Derived manuals (#451, #669): a leaflet made from a manual in the builder, what its rule
// gathers, a gathered module left out by the rule; a leaflet switched to gathering the safety
// notices grouped by hazard level (#676). Everything is the test's own, in a revision
// of its own: a module type marked as safety content in that revision's configuration, three
// modules, the source manual and, for the error path, derived manuals made through the API. No
// manual or module of main is changed.

/** The admin's revision: a safety type of its own, two modules of it and one concept, and a source manual. */
async function ownSource(admin: Api) {
  const changeSet = await admin.createChangeSet(unique('Leaflet'));
  const safety = moduleId('e2e-hazard');
  // Another flow's revision may hold the configuration's lock a few seconds: try again.
  await expect(async () => {
    await admin.editConfig(changeSet.id, (config) => ({
      ...config,
      moduleTypes: [
        ...config.moduleTypes.filter((t: { id: string }) => t.id !== safety),
        { id: safety, label: 'Leaflet hazard', safety: true },
      ],
    }));
  }).toPass({ timeout: 30_000 });
  const crush = moduleId('crush');
  const intro = moduleId('about');
  const burn = moduleId('burn');
  const modules = [
    { id: crush, title: 'Crush hazard', type: safety },
    { id: intro, title: 'About the machine', type: 'concept' },
    { id: burn, title: 'Burn hazard', type: safety },
  ];
  for (const m of modules) {
    await admin.createModule(
      changeSet,
      {
        lang: 'en',
        moduleId: m.id,
        title: m.title,
        type: m.type,
        blocks: [paragraph('p1', `${m.title}: take care.`)],
      },
      { savePoint: false },
    );
  }
  const source = moduleId('source');
  const sourceTitle = unique('Machine manual');
  await admin.createManual(changeSet, source, {
    title: sourceTitle,
    audience: 'public',
    variants: [{ model: 'small' }],
    entries: modules.map((m) => ({ module: m.id })),
  });
  return { changeSet, source, sourceTitle, crush, burn };
}

/** A safety notice of a hazard level, as the API stores it. */
const notice = (id: string, severity: string, hazard: string): Block => ({
  type: 'safety',
  id,
  severity,
  hazard: [{ type: 'text', text: hazard }],
  symbols: [],
  blocks: [paragraph(`${id}-do`, 'Keep clear.')],
});

/**
 * The admin's revision for a notice leaflet: two concept modules holding notices, one without,
 * the source manual and a derived manual gathering whole modules (its rule without `notices`).
 */
async function ownNoticeLeaflet(admin: Api) {
  const changeSet = await admin.createChangeSet(unique('Notices'));
  const tank = moduleId('tank');
  const plain = moduleId('plain');
  const charge = moduleId('charge');
  const modules = [
    {
      id: tank,
      title: 'Filling the tank',
      blocks: [notice('burst', 'danger', 'Bursting tank')],
    },
    {
      id: plain,
      title: 'About the machine',
      blocks: [paragraph('p1', 'A machine.')],
    },
    {
      id: charge,
      title: 'Charging',
      blocks: [notice('hot', 'warning', 'Hot surface')],
    },
  ];
  for (const m of modules) {
    await admin.createModule(
      changeSet,
      {
        lang: 'en',
        moduleId: m.id,
        title: m.title,
        type: 'concept',
        blocks: m.blocks,
      },
      { savePoint: false },
    );
  }
  const source = moduleId('source');
  const sourceTitle = unique('Machine manual');
  await admin.createManual(changeSet, source, {
    title: sourceTitle,
    audience: 'public',
    variants: [{ model: 'small' }],
    entries: modules.map((m) => ({ module: m.id })),
  });
  const leaflet = moduleId('notices');
  await admin.createManual(changeSet, leaflet, {
    kind: 'derived',
    title: unique('Notice leaflet'),
    audience: 'public',
    variants: [{ model: 'small' }],
    rule: { source, exclude: [], front: [], back: [] },
  });
  return { changeSet, source, sourceTitle, leaflet };
}

test.describe('derived manuals @area:manuals @api:manuals @api:change-sets', () => {
  // Creating a manual first asks whether its working copy exists already: a 404, as expected.
  test.use({
    consoleAllow: [
      /status of 404.*\/manuals\/safety-leaflet-[a-z0-9]+\/working-copy/,
    ],
  });

  test('makes a leaflet from a manual, sees what it gathers and leaves a module out', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const { changeSet, source, sourceTitle, burn } = await ownSource(admin);

    await signIn(page, USERS.admin);
    await page.goto(`/manuals?manual=${source}&cs=${changeSet.id}`);
    const tree = page.getByRole('tree', { name: 'Structure' });
    await expect(tree.getByRole('treeitem')).toHaveCount(3);

    await page.getByTestId('manual-switcher').click();
    await page.getByTestId('manual-new').click();
    const dialog = page.getByRole('dialog', { name: 'New manual' });
    const title = unique('Safety leaflet');
    await dialog.getByLabel('Title', { exact: true }).fill(title);
    await dialog
      .getByRole('radio', { name: 'Derived from another manual' })
      .click();
    // None chosen: the safety types the revision's settings mark.
    await expect(dialog.getByTestId('new-manual-derived')).toContainText(
      'Leaflet hazard',
    );
    await dialog.getByTestId('new-manual-source').getByRole('combobox').click();
    await page.getByRole('option', { name: sourceTitle }).click();
    await dialog.getByRole('button', { name: 'Create and open' }).click();

    // Opened in the builder: the two safety modules gathered, in the source's order; the
    // outline cannot be edited as entries.
    const rule = page.getByRole('region', { name: 'Gathering rule' });
    await expect(rule).toBeVisible();
    await expect(page.getByTestId('module-count')).toContainText(
      `2 modules, gathered from ${sourceTitle}`,
    );
    const rows = tree.getByRole('treeitem');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Crush hazard');
    await expect(rows.nth(1)).toContainText('Burn hazard');
    await expect(page.getByRole('button', { name: 'Add module' })).toHaveCount(
      0,
    );
    await expect(tree.locator('[cdkDragHandle]')).toHaveCount(0);

    // Left out by the rule: saved as the rule, read again, and the check warns.
    const saved = page.waitForResponse(
      (r) =>
        r.request().method() === 'PUT' &&
        r.url().includes('/working-copy') &&
        r.url().includes('/manuals/'),
    );
    await rows
      .nth(1)
      .getByRole('button', { name: 'Leave out Burn hazard' })
      .click();
    expect((await saved).status()).toBe(200);
    await expect(rows).toHaveCount(1);
    await expect(
      rule.locator('[data-code=safety-module-excluded]'),
    ).toContainText('Safety module left out');
    await expect(rule.getByTestId('rule-excluded')).toContainText(
      'Burn hazard',
    );

    // What was saved: the rule, never entries.
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const answer = await admin.json(
      admin.get(`/change-sets/${changeSet.id}/manuals/${id}/working-copy`),
    );
    const content = answer.data.attributes.content;
    expect(content.kind).toBe('derived');
    expect(content.rule.source).toBe(source);
    expect(content.rule.exclude).toEqual([burn]);
    expect(content.entries ?? []).toEqual([]);
  });

  test('says so when the source is itself derived', async ({ page, api }) => {
    const admin = await api(USERS.admin);
    const { changeSet, source } = await ownSource(admin);
    const first = moduleId('leaflet');
    const second = moduleId('leaflet-of-leaflet');
    const derived = (from: string) => ({
      kind: 'derived',
      title: unique('Leaflet'),
      audience: 'public',
      variants: [{ model: 'small' }],
      rule: { source: from, exclude: [], front: [], back: [] },
    });
    await admin.createManual(changeSet, first, derived(source));
    await admin.createManual(changeSet, second, derived(first));

    await signIn(page, USERS.admin);
    await page.goto(`/manuals?manual=${second}&cs=${changeSet.id}`);
    const rule = page.getByRole('region', { name: 'Gathering rule' });
    const issue = rule.locator('[data-code=derived-source]');
    await expect(issue).toContainText('Source is derived');
    await expect(issue).toHaveAttribute('data-severity', 'error');
    await expect(page.getByText('Nothing gathered')).toBeVisible();
    // The picker offers no other derived manual: only the one the rule names now.
    await rule.getByTestId('rule-source').getByRole('combobox').click();
    await expect(page.getByRole('option', { name: /Leaflet/ })).toHaveCount(1);
    await page.keyboard.press('Escape');
  });

  test('switches a leaflet to gathering safety notices grouped by hazard level (#676)', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const { changeSet, sourceTitle, leaflet } = await ownNoticeLeaflet(admin);

    await signIn(page, USERS.admin);
    await page.goto(`/manuals?manual=${leaflet}&cs=${changeSet.id}`);
    const rule = page.getByRole('region', { name: 'Gathering rule' });
    const gathering = rule.getByTestId('rule-gathering');
    // Whole modules of the configured safety types: none of these concept modules.
    await expect(
      gathering.getByRole('radio', {
        name: 'Whole modules of the types below',
      }),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Nothing gathered')).toBeVisible();
    // The notice options open under the choice (closed, they are inert).
    const options = rule.locator('of-collapse:has([data-testid=rule-notices])');
    await expect(options).toHaveAttribute('data-state', 'closed');

    const saved = () =>
      page.waitForResponse(
        (r) =>
          r.request().method() === 'PUT' &&
          r.url().includes(`/manuals/${leaflet}/working-copy`),
      );
    let save = saved();
    await gathering
      .getByRole('radio', { name: 'Safety notices of the source’s modules' })
      .click();
    expect((await save).status()).toBe(200);
    await expect(options).toHaveAttribute('data-state', 'open');
    await expect(rule.getByTestId('rule-types-hint')).toContainText(
      'every type',
    );

    save = saved();
    await rule
      .getByTestId('rule-grouping')
      .getByRole('radio', { name: 'By hazard level' })
      .click();
    expect((await save).status()).toBe(200);

    // The outline shows the modules holding notices, in the source's order.
    const tree = page.getByRole('tree', { name: 'Structure' });
    const rows = tree.getByRole('treeitem');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Filling the tank');
    await expect(rows.nth(1)).toContainText('Charging');
    await expect(page.getByTestId('module-count')).toContainText(
      `2 modules holding notices, gathered from ${sourceTitle}, grouped by hazard level`,
    );

    // What was saved: `notices: { groupBy: level }`, and no entries.
    const answer = await admin.json(
      admin.get(`/change-sets/${changeSet.id}/manuals/${leaflet}/working-copy`),
    );
    const content = answer.data.attributes.content;
    expect(content.rule.notices).toEqual({ groupBy: 'level' });
    expect(content.entries ?? []).toEqual([]);
  });

  test.describe('a refused save', () => {
    test.use({
      consoleAllow: [/status of 422.*\/manuals\/.*\/working-copy/],
    });

    test('puts the notice options back as they were saved (#676)', async ({
      page,
      api,
    }) => {
      const admin = await api(USERS.admin);
      const { changeSet, leaflet } = await ownNoticeLeaflet(admin);

      await signIn(page, USERS.admin);
      await page.goto(`/manuals?manual=${leaflet}&cs=${changeSet.id}`);
      const rule = page.getByRole('region', { name: 'Gathering rule' });
      const modules = rule.getByRole('radio', {
        name: 'Whole modules of the types below',
      });
      await expect(modules).toHaveAttribute('aria-checked', 'true');

      // The save of the working copy is refused (only this page's, in the browser).
      await page.route(
        (url) => url.pathname.endsWith(`/manuals/${leaflet}/working-copy`),
        (route) =>
          route.request().method() === 'PUT'
            ? route.fulfill({
                status: 422,
                contentType: 'application/vnd.api+json',
                body: JSON.stringify({
                  errors: [
                    {
                      status: '422',
                      code: 'invalid-manifest',
                      title: 'Invalid manifest',
                    },
                  ],
                }),
              })
            : route.fallback(),
      );
      await rule
        .getByRole('radio', { name: 'Safety notices of the source’s modules' })
        .click();
      await expect(page.getByText(/could not be saved/)).toBeVisible();
      await expect(modules).toHaveAttribute('aria-checked', 'true');
      await expect(
        rule.locator('of-collapse:has([data-testid=rule-notices])'),
      ).toHaveAttribute('data-state', 'closed');

      // Nothing of it reached the working copy.
      const answer = await admin.json(
        admin.get(
          `/change-sets/${changeSet.id}/manuals/${leaflet}/working-copy`,
        ),
      );
      expect(answer.data.attributes.content.rule.notices).toBeUndefined();
    });
  });
});
