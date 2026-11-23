import type { Page } from '@playwright/test';
import {
  type Api,
  mergedModule,
  type ModuleRef,
  paragraph,
  unique,
} from '../src/api.ts';
import { expect, signIn, switchUser, test, USERS } from '../src/fixtures.ts';

/**
 * Fixing an older product version (#250): a revision started on a maintenance line from the
 * header's picker, edited, reviewed and merged into the line, then carried forward to main as a
 * new draft; a conflict lists the blocks to fix, each opening the editor at its block; the Releases
 * page's Maintenance tab starts and closes lines. Every flow makes its own release (a product
 * version no other flow uses), its own line and its own module: nothing shared is changed.
 */

/** A product version of its own: no other flow's release or maintenance line meets it. */
const ownVersion = () =>
  `e2e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/**
 * A module of its own on main (two paragraphs, `p1` and `p2`), released as `north` at a version of
 * its own, and a maintenance line started from that release.
 */
async function lineWithModule(
  author: Api,
  reviewer: Api,
  publisher: Api,
): Promise<{
  line: string;
  version: string;
  module: ModuleRef;
  title: string;
}> {
  const made = await mergedModule(
    author,
    reviewer,
    publisher,
    unique('Older version module'),
  );
  const version = ownVersion();
  const release = await publisher.cutRelease({
    product: 'north',
    revision: version,
  });
  const line = await publisher.startMaintenanceLine(release.id);
  return { line, version, module: made.module, title: made.moduleTitle };
}

/** The line's name as the editor writes it: "North <version>". */
const lineName = (version: string) => new RegExp(`North ${version}`);

/** The module at a branch, as the API reads it. */
async function moduleText(api: Api, module: ModuleRef, branch: string) {
  const { data } = await api.json(
    api.get(
      `/modules/${module.lang}/${module.moduleId}?ref=${encodeURIComponent(branch)}`,
    ),
  );
  return JSON.stringify(data);
}

async function openPicker(page: Page) {
  await page.getByRole('button', { name: /^Revision:/ }).click();
}

test.describe('maintenance lines @area:shell @area:review @area:releases @area:module-editor @api:change-sets @api:releases', () => {
  test('a writer fixes an older product version: starts on its line, edits, gets it reviewed and merged, carries it forward to main', async ({
    page,
    api,
  }) => {
    // Several merges and a release through the API: slow on a loaded machine.
    test.setTimeout(150_000);
    const author = await api(USERS.author);
    const reviewer = await api(USERS.reviewer);
    const publisher = await api(USERS.publisher);
    const { version, module, title } = await lineWithModule(
      author,
      reviewer,
      publisher,
    );

    await signIn(page, USERS.author);
    await page.goto('/content');
    // New revision: the product version it fixes, Current (main) by default.
    await openPicker(page);
    await page.getByRole('option', { name: 'New revision' }).click();
    const choice = page.getByRole('radiogroup', { name: 'Product version' });
    await expect(choice).toBeVisible();
    await expect(
      choice.getByRole('radio', { name: 'Current (main)' }),
    ).toBeChecked();
    await choice.getByRole('radio', { name: lineName(version) }).click();
    const fixTitle = unique('Fix the older version');
    await page.getByRole('textbox', { name: 'Title' }).fill(fixTitle);
    await page.getByRole('button', { name: 'Start' }).click();
    // The revision names the product version it fixes, never the line's branch.
    const trigger = page.getByRole('button', {
      name: new RegExp(`^Revision: ${fixTitle} \\(Draft\\), North ${version}$`),
    });
    await expect(trigger).toBeVisible();
    await expect(trigger).not.toContainText('maintenance/');
    await expect(page).toHaveURL(/[?&]cs=[0-9a-f-]{36}/);
    const fix = new URL(page.url()).searchParams.get('cs') ?? '';
    author.adopt(fix);

    // Editing in it reads and writes the line's content; the editor's header says which version.
    const locked = page.waitForResponse(
      (r) => r.url().includes(`/change-sets/${fix}/locks`) && r.ok(),
    );
    await page.goto(`/content/${module.lang}/${module.moduleId}?cs=${fix}`);
    await locked;
    await expect(page.getByText('Locked by you')).toBeVisible();
    await expect(
      page.locator('header [data-slot="line-badge"]').first(),
    ).toHaveText(lineName(version));
    const editor = page.getByRole('textbox', { name: `Module ${title}` });
    await editor.getByText('Charge the battery before first use.').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Fixed for the older version.');
    await expect(
      page.getByRole('status').filter({ hasText: /^Saved/ }),
    ).toBeVisible();
    // Leaving the module (in the app) makes the save point, as its author.
    await page
      .getByRole('navigation', { name: 'Breadcrumb' })
      .getByRole('link', { name: 'Content' })
      .click();
    await expect(page).toHaveURL(/\/content\?/);
    const branch = (
      await author.json<{ data: { attributes: { branch: string } } }>(
        author.get(`/change-sets/${fix}`),
      )
    ).data.attributes.branch;
    await expect(async () => {
      expect(await moduleText(author, module, branch)).toContain(
        'Fixed for the older version.',
      );
    }).toPass({ timeout: 20_000 });
    await author.transition(fix, 'submit', 'Fix for the older version.');
    await reviewer.transition(fix, 'approve');

    // Merged by the publisher: into the line, and the toast says who carries it forward.
    await page.goto(`/review?cs=${fix}`);
    await expect(
      page.getByRole('heading', { level: 2, name: fixTitle }),
    ).toBeVisible();
    // The review reads again for whoever acts now (a full load would sign the author in again).
    await switchUser(page, 'Sample Author', 'Sample Publisher');
    await page.getByRole('button', { name: /^Merge/ }).click();
    await expect(
      page.getByText(new RegExp(`Merged “${fixTitle}” into North ${version}`)),
    ).toBeVisible();
    await expect(
      page.getByText('Its author can carry it forward'),
    ).toBeVisible();

    // Its writer carries it forward from the review of the merged revision.
    await switchUser(page, 'Sample Publisher', 'Sample Author');
    const carry = page.getByRole('button', {
      name: 'Carry forward to current',
    });
    await expect(carry).toBeVisible();
    await expect(
      page.getByText(new RegExp(`Its changes are in North ${version} only`)),
    ).toBeVisible();
    await carry.click();
    // Lands in a new draft on main, chosen, with the same change.
    await expect(page).toHaveURL(/[?&]state=draft/);
    await expect(page).not.toHaveURL(new RegExp(`cs=${fix}`));
    const carried = new URL(page.url()).searchParams.get('cs') ?? '';
    expect(carried).toMatch(/^[0-9a-f-]{36}$/);
    author.adopt(carried);
    await expect(
      page.getByRole('heading', {
        level: 2,
        name: `Carry forward: ${fixTitle}`,
      }),
    ).toBeVisible({ timeout: 30_000 });
    const { data } = await author.json(author.get(`/change-sets/${carried}`));
    expect(data.attributes.baseRef).toBe('main');
    expect(await moduleText(author, module, data.attributes.branch)).toContain(
      'Charge the battery before first use. Fixed for the older version.',
    );
  });

  test.describe('carried already', () => {
    test.use({ consoleAllow: [/status of 409.*\/carry-forward/] });

    test('a second carry-forward says it was carried already and opens that draft', async ({
      page,
      api,
    }) => {
      // Several merges and a release through the API: slow on a loaded machine.
      test.setTimeout(150_000);
      const author = await api(USERS.author);
      const reviewer = await api(USERS.reviewer);
      const publisher = await api(USERS.publisher);
      const { line, module } = await lineWithModule(
        author,
        reviewer,
        publisher,
      );
      const fix = await author.createChangeSet(unique('Carried twice'), {
        maintenanceLine: line,
      });
      await author.editModule(fix.id, module, (content) => ({
        ...content,
        blocks: [
          paragraph('p1', 'Charge the battery fully before first use.'),
          ...content.blocks.slice(1),
        ],
      }));
      await author.transition(fix.id, 'submit', 'Fix.');
      await reviewer.transition(fix.id, 'approve');
      await publisher.transition(fix.id, 'merge');
      const first = await author.carryForward(fix.id);

      await signIn(page, USERS.author);
      await page.goto(`/review?cs=${fix.id}`);
      await page
        .getByRole('button', { name: 'Carry forward to current' })
        .click();
      await expect(page.getByText('was carried forward already')).toBeVisible();
      await page.getByRole('button', { name: 'Open the draft' }).click();
      await expect(page).toHaveURL(new RegExp(`cs=${first.id}`));
    });
  });

  test('a conflict lists the blocks main changed differently, each opening the editor at its block', async ({
    page,
    api,
  }) => {
    // Several merges and a release through the API: slow on a loaded machine.
    test.setTimeout(150_000);
    const author = await api(USERS.author);
    const reviewer = await api(USERS.reviewer);
    const publisher = await api(USERS.publisher);
    const { line, module, title } = await lineWithModule(
      author,
      reviewer,
      publisher,
    );
    // The line fixes p1 one way…
    const fix = await author.createChangeSet(unique('Line fix'), {
      maintenanceLine: line,
    });
    await author.editModule(fix.id, module, (content) => ({
      ...content,
      blocks: [
        paragraph('p1', 'Charge the battery for eight hours before first use.'),
        ...content.blocks.slice(1),
      ],
    }));
    await author.transition(fix.id, 'submit', 'Line fix.');
    await reviewer.transition(fix.id, 'approve');
    await publisher.transition(fix.id, 'merge');
    // …and main changed it another way since (this module is this test's own).
    const onMain = await author.createChangeSet(unique('Main moved on'));
    await author.editModule(onMain.id, module, (content) => ({
      ...content,
      blocks: [
        paragraph('p1', 'Charge the battery with the supplied charger.'),
        ...content.blocks.slice(1),
      ],
    }));
    await author.transition(onMain.id, 'submit', 'Main.');
    await reviewer.transition(onMain.id, 'approve');
    await publisher.transition(onMain.id, 'merge');

    await signIn(page, USERS.author);
    await page.goto(`/review?cs=${fix.id}`);
    await page
      .getByRole('button', { name: 'Carry forward to current' })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Some changes need you on the current content',
    });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/[?&]state=draft/);
    const carried = new URL(page.url()).searchParams.get('cs') ?? '';
    author.adopt(carried);
    const row = dialog.getByRole('listitem').filter({
      hasText: `${module.moduleId} (${module.lang})`,
    });
    await expect(row.first()).toContainText('changed on main too');
    await expect(dialog).not.toContainText('maintenance/');

    const locked = page.waitForResponse(
      (r) => r.url().includes(`/change-sets/${carried}/locks`) && r.ok(),
    );
    await row
      .getByRole('button', {
        name: `Open block p1 of ${module.moduleId} (${module.lang}) in the editor`,
      })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/content/${module.lang}/${module.moduleId}\\?.*block=p1`),
    );
    await expect(page).toHaveURL(new RegExp(`cs=${carried}`));
    await locked;
    await expect(
      page.getByRole('heading', { level: 1, name: title }),
    ).toBeVisible();
    // Main's version is there to fix by hand.
    await expect(
      page
        .getByRole('textbox', { name: `Module ${title}` })
        .getByText('Charge the battery with the supplied charger.'),
    ).toBeVisible();
  });

  test('the Maintenance tab: a publisher starts a line on a release and closes it', async ({
    page,
    api,
  }) => {
    // Several merges and a release through the API: slow on a loaded machine.
    test.setTimeout(150_000);
    const publisher = await api(USERS.publisher);
    const version = ownVersion();
    const release = await publisher.cutRelease({
      product: 'north',
      revision: version,
    });

    await signIn(page, USERS.publisher);
    await page.goto(`/releases?release=${release.id}`);
    const panel = page.locator('[data-slot="release-panel"]');
    const start = panel.getByRole('button', { name: 'Start maintenance' });
    await expect(start).toBeVisible();
    await start.click();
    await expect(
      page.getByText(new RegExp(`Started maintenance for North ${version}`)),
    ).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText(/Maintenance line open since/)).toBeVisible();
    await panel.getByRole('button', { name: 'Show in Maintenance' }).click();
    await expect(page).toHaveURL(/[?&]tab=maintenance/);

    const lines = page.getByTestId('maintenance-lines');
    const row = lines
      .locator('[data-slot="line-row"]')
      .filter({ hasText: version });
    await expect(row).toBeVisible();
    await expect(row.locator('[data-slot="line-state"]')).toHaveText(/Open/);
    await expect(lines).not.toContainText('maintenance/');
    await row
      .getByRole('button', {
        name: new RegExp(`Close the maintenance line North ${version}`),
      })
      .click();
    await page.getByRole('button', { name: 'Close line' }).click();
    await expect(row.locator('[data-slot="line-state"]')).toHaveText(/Closed/);
    await expect(
      page.getByText(
        new RegExp(`Closed the maintenance line North ${version}`),
      ),
    ).toBeVisible();
    await expect(
      row.getByRole('button', { name: /Close the maintenance line/ }),
    ).toHaveCount(0);

    // A closed line takes no new revision: the picker offers it no more.
    await switchUser(page, 'Sample Publisher', 'Sample Author');
    await openPicker(page);
    await page.getByRole('option', { name: 'New revision' }).click();
    await expect(page.getByRole('textbox', { name: 'Title' })).toBeVisible();
    await expect(
      page.getByRole('radio', { name: lineName(version) }),
    ).toHaveCount(0);
  });
});
