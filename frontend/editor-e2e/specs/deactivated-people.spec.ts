import type { Locator } from '@playwright/test';
import {
  type Api,
  moduleId,
  paragraph,
  unique,
  type UserId,
} from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

/**
 * A deactivated person's work (#928): their name stays, marked "(deactivated)", wherever a screen
 * says who wrote, approved or said something, until they are reactivated. The people are made
 * here and nobody else's, so deactivating them changes nothing another flow sees.
 */

/** A person of this test's own with `role`: their ID and name. */
async function person(admin: Api, role: string) {
  const id = moduleId('former') as UserId;
  const name = `Former ${id}`;
  await admin.json(
    admin.send('POST', '/users', {
      data: {
        type: 'User',
        id,
        attributes: { name, email: `${id}@example.com` },
        relationships: { roles: { data: [{ type: 'Role', id: role }] } },
      },
    }),
    201,
  );
  return { id, name };
}

const set = (admin: Api, id: string, to: 'deactivate' | 'reactivate') =>
  admin.json(admin.send('POST', `/users/${id}/${to}`));

const BLOCK = 'e2e-former';

test.describe('deactivated people @area:review @area:module-editor @api:change-sets @api:comments @api:modules', () => {
  test('a deactivated author, commenter and approver are marked in review, comments and history; reactivated they are not (#928)', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const author = await person(admin, 'author');
    const reviewer = await person(admin, 'reviewer');
    const writing = await api(author.id);
    const reviewing = await api(reviewer.id);
    const title = unique('Former work');
    const id = moduleId();
    const changeSet = await writing.createChangeSet(title);
    await writing.createModule(changeSet, {
      lang: 'en',
      moduleId: id,
      title,
      blocks: [paragraph(BLOCK, 'Check the battery monthly.')],
    });
    await writing.comment(
      changeSet.id,
      { lang: 'en', moduleId: id },
      BLOCK,
      'Monthly is enough.',
    );
    await writing.transition(changeSet.id, 'submit');

    // The author goes while the revision is in review.
    await set(admin, author.id, 'deactivate');
    const named = (root: Locator, who: { name: string }) =>
      root.locator('[data-slot="person"]', { hasText: who.name });
    const row = page.locator('a[aria-current="true"]', { hasText: title });
    const header = page
      .getByRole('region', { name: title })
      .locator('header')
      .first();
    try {
      await signIn(page, USERS.publisher);
      await page.goto(`/review?cs=${changeSet.id}`);
      // In the list of revisions, and in the one shown.
      const thread = page.locator('[data-slot="thread"]', {
        hasText: 'Monthly is enough.',
      });
      for (const place of [row, header, thread]) {
        await expect(named(place, author)).toHaveText(
          `${author.name} (deactivated)`,
        );
      }
      // In a narrow place the byline wraps, and its separator stays with the name.
      await thread.evaluate((el) => (el.style.width = '10rem'));
      const left = async (l: Locator) => (await l.boundingBox())?.x ?? 0;
      const separator = thread.locator('span[aria-hidden]', { hasText: '·' });
      expect(await left(separator.first())).toBeGreaterThan(
        (await left(named(thread, author))) + 1,
      );
      // The reviewer still works here: named, not marked.
      await reviewing.transition(changeSet.id, 'approve');
      await page.reload();
      await expect(
        page.getByText(`Approved by ${reviewer.name}`),
      ).toBeVisible();
      await expect(
        page.getByText(`${reviewer.name} (deactivated)`),
      ).toHaveCount(0);
      const publisher = await api(USERS.publisher);
      await publisher.transition(changeSet.id, 'merge');
      await set(admin, reviewer.id, 'deactivate');

      // The approval it was given, and the history: in a sentence.
      await page.reload();
      await expect(
        page
          .locator('of-review-panel')
          .getByText(`${reviewer.name} (deactivated)`),
      ).toBeVisible();
      await page.goto(`/content/en/${id}/history`);
      await expect(
        page
          .locator('[data-slot="history-row"]')
          .getByText(`${reviewer.name} (deactivated)`),
      ).toBeVisible();

      // Back again: no marker.
      await set(admin, author.id, 'reactivate');
      await set(admin, reviewer.id, 'reactivate');
      await page.reload();
      await expect(
        page.locator('[data-slot="history-row"]').getByText(reviewer.name),
      ).toBeVisible();
      await expect(page.getByText('(deactivated)')).toHaveCount(0);
      await page.goto(`/review?cs=${changeSet.id}`);
      await expect(named(header, author)).toHaveText(author.name);
      await expect(named(thread, author)).toHaveText(author.name);
      await expect(page.getByText('(deactivated)')).toHaveCount(0);
    } finally {
      // Whoever is left deactivated would not be let clean up.
      for (const { id: user } of [author, reviewer]) {
        await admin.send('POST', `/users/${user}/reactivate`);
      }
    }
  });
});

test.describe('deactivated people, in the notifications @area:notifications @api:notifications @api:change-sets', () => {
  test('a deactivated approver is marked in the bell, and named after a reload; reactivated they are not (#928)', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const author = await person(admin, 'author');
    const reviewer = await person(admin, 'reviewer');
    const writing = await api(author.id);
    const title = unique('Former work');
    const changeSet = await writing.createChangeSet(title);
    await writing.createModule(changeSet, {
      lang: 'en',
      moduleId: moduleId(),
      title,
      blocks: [paragraph(BLOCK, 'Check the battery monthly.')],
    });
    await writing.transition(changeSet.id, 'submit');
    await (await api(reviewer.id)).transition(changeSet.id, 'approve');
    // The API's consumer turns the approval into a notification a moment later.
    await expect
      .poll(
        async () =>
          (await writing.json(writing.get('/me/notifications'))).data.length,
        { timeout: 30_000 },
      )
      .toBe(1);
    await set(admin, reviewer.id, 'deactivate');
    try {
      await signIn(page, author.id);
      await page.goto('/content?notifications=all');
      const row = page
        .getByRole('dialog', { name: 'Notifications' })
        .getByText(title);
      await expect(row).toHaveText(
        `${reviewer.name} (deactivated) approved “${title}”`,
      );
      await set(admin, reviewer.id, 'reactivate');
      await page.reload();
      await expect(row).toHaveText(`${reviewer.name} approved “${title}”`);
    } finally {
      await admin.send('POST', `/users/${reviewer.id}/reactivate`);
    }
  });
});

test.describe('deactivated people, their names unread @area:review @area:module-editor @api:change-sets', () => {
  test.use({ consoleAllow: [/503/] });

  test('a deactivated person whose name cannot be read is named by ID, marked all the same (#928)', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const author = await person(admin, 'author');
    const writing = await api(author.id);
    const changeSet = await writing.createChangeSet(unique('Former work'));
    await set(admin, author.id, 'deactivate');
    try {
      await page.route(/\/api\/demo\/users\?.*deactivated/, (route) =>
        route.fulfill({ status: 503, body: '' }),
      );
      await signIn(page, USERS.admin);
      await page.goto(`/review?state=draft&cs=${changeSet.id}`);
      await expect(
        page.locator('a[aria-current="true"] [data-slot="person"]'),
      ).toHaveText(`${author.id} (deactivated)`);
    } finally {
      await set(admin, author.id, 'reactivate');
    }
  });
});
