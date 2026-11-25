import type { Page } from '@playwright/test';

import { moduleId, paragraph, unique, type Api } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

// Update guides in the editor (#908): an update guide created in a revision with the new-manual
// dialog, steps added over three versions and the three phases (one for a level and an option),
// the preview for a range showing exactly the steps a reader gets, and the revision submitted for
// review. Everything is the test's own revision: a version attribute and an option of its own in
// the revision's configuration (whose lock it takes first, as other flows' revisions may hold it a
// few seconds), three modules and the guide. No manual or module of main is changed.

/** The admin's revision: a version attribute, an option and three modules for the steps. */
async function ownRevision(admin: Api) {
  const changeSet = await admin.createChangeSet(unique('Update guide'));
  const software = moduleId('e2e-firmware');
  const setup = moduleId('e2e-setup');
  await expect(async () => {
    await admin.editConfig(changeSet.id, (config) => ({
      ...config,
      variantAttributes: [
        ...config.variantAttributes,
        { id: software, label: 'Firmware', kind: 'version' },
        {
          id: setup,
          label: 'Cluster setup',
          kind: 'enum',
          values: [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ],
        },
      ],
    }));
  }).toPass({ timeout: 30_000 });
  const modules = {
    backUp: { id: moduleId('back-up'), title: unique('Back up the settings') },
    migrate: { id: moduleId('migrate'), title: unique('Migrate the database') },
    rejoin: { id: moduleId('rejoin'), title: unique('Rejoin the cluster') },
  };
  for (const m of Object.values(modules)) {
    await admin.createModule(
      changeSet,
      {
        lang: 'en',
        moduleId: m.id,
        title: m.title,
        type: 'procedure',
        blocks: [paragraph('p1', `${m.title}.`)],
      },
      { savePoint: false },
    );
  }
  await admin.savePoint(changeSet.id);
  return { changeSet, software, setup, modules };
}

/** The first save of the guide's working copy from now on, answered. */
const saved = (page: Page, id: string) =>
  page.waitForResponse(
    (r) =>
      r.request().method() === 'PUT' &&
      r.url().endsWith(`/manuals/${id}/working-copy`),
  );

/** Chooses `label` in the select `testId` of `scope`. */
async function choose(page: Page, testId: string, label: string) {
  await page.getByTestId(testId).getByRole('combobox').click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

test.describe('update guides @area:manuals @api:manuals @api:change-sets @api:config', () => {
  // Creating a manual first asks whether its working copy exists already, and the builder reads
  // a new manual on the branch before its working copy: 404s, as expected.
  test.use({
    consoleAllow: [
      /status of 404.*\/manuals\/[a-z0-9-]+(\/working-copy|\?ref=)/,
    ],
  });

  test('writes an update guide in a revision, previews a range and submits it for review', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const { changeSet, setup, modules } = await ownRevision(admin);

    await signIn(page, USERS.admin);
    await page.goto(`/manuals?cs=${changeSet.id}`);
    await page.getByTestId('manual-switcher').click();
    await page.getByTestId('manual-new').click();
    const dialog = page.getByRole('dialog', { name: 'New manual' });
    const title = unique('Firmware update guide');
    await dialog.getByLabel('Title', { exact: true }).fill(title);
    await dialog
      .getByRole('radio', { name: 'Update guide, steps per software version' })
      .click();
    // The revision's only version attribute is the one followed.
    await expect(
      dialog.getByTestId('new-manual-version-attribute'),
    ).toContainText('Firmware');
    await dialog.getByLabel('Versions').fill('3.0, 1.0, 2.0, 4.0');
    await dialog.getByRole('button', { name: 'Create and open' }).click();

    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await expect(page.getByTestId('guide-empty')).toBeVisible();
    await expect(page.getByTestId('module-count')).toHaveText('No steps');

    // A step: its module from the add list, then its version, phase, level and option.
    const addStep = async (
      module: { id: string; title: string },
      version: string,
      phase: string,
      extra?: () => Promise<void>,
    ) => {
      await page.getByTestId('manual-add').click();
      await page
        .getByRole('combobox', { name: 'Search modules' })
        .fill(module.title);
      await page
        .getByRole('option', { name: module.title, exact: true })
        .click();
      const form = page.getByRole('dialog', { name: 'Add step' });
      await expect(form).toContainText(module.title);
      await choose(page, 'update-step-version', `Version ${version}`);
      await form.getByText(phase, { exact: true }).click();
      await extra?.();
      const done = saved(page, id);
      await form.getByRole('button', { name: 'Add step' }).click();
      expect((await done).status()).toBe(200);
    };
    await addStep(modules.backUp, '2.0', 'Before the update');
    await addStep(modules.migrate, '3.0', 'During the update', async () => {
      await choose(page, 'update-step-level', 'Internal');
    });
    await addStep(modules.rejoin, '4.0', 'After the update', async () => {
      await page.getByTestId('update-step-pick-condition').click();
      const picker = page.getByRole('dialog', { name: 'Only for some setups' });
      await picker
        .locator(`[data-attribute="${setup}"]`)
        .getByRole('checkbox', { name: 'Yes' })
        .check();
      await picker.getByRole('button', { name: 'Apply' }).click();
      await expect(page.getByTestId('update-step-condition')).toContainText(
        'Cluster setup: Yes',
      );
    });

    // Listed by version, then phase, with the level and the option.
    const steps = page.getByTestId('guide-steps');
    await expect(page.getByTestId('module-count')).toHaveText('3 steps');
    await expect(steps.locator('section[data-version]')).toHaveCount(3);
    const migrate = steps.locator(
      `section[data-version="3.0"] [data-phase=during] [data-module="${modules.migrate.id}"]`,
    );
    await expect(migrate.locator('[data-slot=step-level]')).toHaveText(
      'Internal',
    );
    await expect(
      steps.locator(
        `section[data-version="4.0"] [data-phase=after] [data-module="${modules.rejoin.id}"] [data-slot=step-condition]`,
      ),
    ).toContainText('Cluster setup: Yes');

    // The preview: the whole guide for every level without options, then a public reader on a
    // cluster going from 1.0 to 4.0.
    const preview = page.getByTestId('guide-preview');
    const shown = preview.getByTestId('guide-preview-step');
    await expect(shown).toHaveText([
      new RegExp(modules.backUp.title),
      new RegExp(modules.migrate.title),
    ]);
    await choose(page, 'guide-preview-level', 'Public');
    await preview
      .locator(`[data-option="${setup}"]`)
      .getByRole('combobox')
      .click();
    await page.getByRole('option', { name: 'Yes', exact: true }).click();
    await expect(shown).toHaveText([
      new RegExp(modules.backUp.title),
      new RegExp(modules.rejoin.title),
    ]);
    await expect(preview.getByTestId('guide-preview-count')).toHaveText(
      '2 steps from 1.0 to 4.0',
    );
    await choose(page, 'guide-preview-from', '2.0');
    await expect(shown).toHaveText([new RegExp(modules.rejoin.title)]);

    // What was saved: the guide's steps, never entries.
    const answer = await admin.json(
      admin.get(`/change-sets/${changeSet.id}/manuals/${id}/working-copy`),
    );
    const content = answer.data.attributes.content;
    expect(content.kind).toBe('update-guide');
    expect(content.guide.versions).toEqual(['1.0', '2.0', '3.0', '4.0']);
    expect(content.guide.steps).toEqual([
      { module: modules.backUp.id, version: '2.0', phase: 'before' },
      {
        module: modules.migrate.id,
        version: '3.0',
        phase: 'during',
        level: 'internal',
      },
      {
        module: modules.rejoin.id,
        version: '4.0',
        phase: 'after',
        when: { op: 'in', attr: setup, values: ['yes'] },
      },
    ]);

    // Submitted for review like any revision: leaving the builder makes its save point first.
    const savePoint = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/change-sets/${changeSet.id}/commits`) &&
        r.request().method() === 'POST',
    );
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Review' })
      .click();
    await expect(page).toHaveURL(/\/review/);
    expect((await savePoint).status()).toBe(201);
    await page.goto(`/review?cs=${changeSet.id}`);
    const submitted = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/change-sets/${changeSet.id}/submit`) &&
        r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Submit for review' }).click();
    expect((await submitted).status()).toBe(200);
  });

  test('shows a step’s issue at the step, and refuses a step without a version or phase or one before the first version', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const { changeSet, software, modules } = await ownRevision(admin);
    const id = moduleId('guide');
    await admin.createManual(changeSet, id, {
      kind: 'update-guide',
      title: unique('Guide'),
      variants: [{ model: 'small' }],
      guide: {
        attribute: software,
        versions: ['1.0', '2.0'],
        // A version after the guide's last: no update crosses it, the check warns at the step.
        steps: [
          { module: modules.migrate.id, version: '3.0', phase: 'during' },
        ],
      },
    });

    await signIn(page, USERS.admin);
    await page.goto(`/manuals?manual=${id}&cs=${changeSet.id}`);
    const steps = page.getByTestId('guide-steps');
    await expect(
      steps
        .locator(`[data-module="${modules.migrate.id}"]`)
        .locator('[data-code=update-step-outside-versions]'),
    ).toHaveAttribute('data-severity', 'warning');
    await page.getByTestId('manual-add').click();
    await page
      .getByRole('combobox', { name: 'Search modules' })
      .fill(modules.backUp.title);
    await page
      .getByRole('option', { name: modules.backUp.title, exact: true })
      .click();
    const form = page.getByRole('dialog', { name: 'Add step' });
    await form.getByRole('button', { name: 'Add step' }).click();
    await expect(form).toContainText(
      'Choose the version that needs this step.',
    );
    await expect(form).toContainText('Choose when the step is done.');
    await choose(page, 'update-step-version', 'Another version…');
    await form.getByPlaceholder('For example 2.3').fill('0.9');
    await form.getByText('Before the update', { exact: true }).click();
    await form.getByRole('button', { name: 'Add step' }).click();
    await expect(form).toContainText('Choose a version after 1.0');

    // A new version joins the guide's versions, in its place.
    await form.getByPlaceholder('For example 2.3').fill('1.5');
    const done = saved(page, id);
    await form.getByRole('button', { name: 'Add step' }).click();
    expect((await done).status()).toBe(200);
    await expect(
      steps.getByTestId('guide-versions').locator('[data-version]'),
    ).toHaveText(['1.0', '1.5', '2.0']);
    await expect(steps.locator('section[data-version="1.5"]')).toContainText(
      modules.backUp.title,
    );
  });
});
