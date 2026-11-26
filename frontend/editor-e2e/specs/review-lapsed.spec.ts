import {
  type Api,
  changeSetWithModule,
  moduleId,
  unique,
  type UserId,
} from '../src/api.ts';
import type { Page } from '@playwright/test';
import { chooseSegment, expect, signIn, test, USERS } from '../src/fixtures.ts';

/**
 * An approved revision whose only approval lapsed (#950): its approver lost the role, or was
 * deactivated. The API refuses the merge (`approval-lapsed`), so the review panel never offers
 * it: the Merge step says it is blocked and what to do, and the Merge button says why it cannot
 * be used, to assistive technology too. The reviewer is this test's own, so taking their role or
 * deactivating them changes nothing another flow sees.
 */

/** A reviewer of this test's own: their ID and name. */
async function reviewer(admin: Api) {
  const id = moduleId('lapsing') as UserId;
  const name = `Lapsing ${id}`;
  await admin.json(
    admin.send('POST', '/users', {
      data: {
        type: 'User',
        id,
        attributes: { name, email: `${id}@example.com` },
        relationships: { roles: { data: [{ type: 'Role', id: 'reviewer' }] } },
      },
    }),
    201,
  );
  return { id, name };
}

const ROLE = { data: [{ type: 'Role', id: 'reviewer' }] };

/** At phone width the review shows one pane at a time: the approvals. */
async function showApprovals(page: Page) {
  const panes = page.getByRole('radiogroup', { name: 'Show', exact: true });
  if (await panes.isVisible()) await chooseSegment(page, 'Show', 'Approvals');
}

const lapses = {
  'a role change': {
    lapse: (admin: Api, id: string) =>
      admin.json(
        admin.send('DELETE', `/users/${id}/relationships/roles`, ROLE),
      ),
    restore: (admin: Api, id: string) =>
      admin.send('POST', `/users/${id}/relationships/roles`, ROLE),
    line: (name: string) =>
      `Approved by ${name}, which no longer counts: they lost the role`,
  },
  'a deactivation': {
    lapse: (admin: Api, id: string) =>
      admin.json(admin.send('POST', `/users/${id}/deactivate`)),
    restore: (admin: Api, id: string) =>
      admin.send('POST', `/users/${id}/reactivate`),
    line: (name: string) =>
      `Approved by ${name} (deactivated), which no longer counts`,
  },
} as const;

test.describe('review, a lapsed approval @area:review @api:change-sets @api:access @narrow', () => {
  for (const [cause, how] of Object.entries(lapses)) {
    test(`the merge is blocked with why once the only approval lapsed by ${cause} (#950)`, async ({
      page,
      api,
    }) => {
      const admin = await api(USERS.admin);
      const person = await reviewer(admin);
      const author = await api(USERS.author);
      const title = unique('Lapsed approval');
      const changeSet = await changeSetWithModule(author, title, {
        submit: true,
      });
      await (await api(person.id)).transition(changeSet.id, 'approve');

      const panel = page.locator('of-review-panel');
      const step = panel.locator('[data-step="merge"]');
      const merge = panel.getByRole('button', { name: /^Merge/ });
      try {
        // Approved and holding: ready to merge.
        await signIn(page, USERS.publisher);
        await page.goto(`/review?state=approved&cs=${changeSet.id}`);
        await expect(
          page.getByRole('heading', { level: 2, name: title }),
        ).toBeVisible();
        await showApprovals(page);
        await expect(step).toContainText('Ready to merge into main');
        await expect(merge).not.toHaveAttribute('aria-disabled', 'true');

        await how.lapse(admin, person.id);
        await page.reload();
        await expect(
          page.getByRole('heading', { level: 2, name: title }),
        ).toBeVisible();
        await showApprovals(page);
        await expect(panel.getByText(how.line(person.name))).toBeVisible();
        // The review waits again; the merge is blocked, and says what to do.
        await expect(panel.locator('[data-step="review"]')).toHaveAttribute(
          'data-status',
          'current',
        );
        await expect(step).toHaveAttribute('data-status', 'blocked');
        await expect(step).toContainText(
          'Blocked until every approval it needs holds. A reviewer sends it back with Request changes.',
        );
        await expect(panel.getByText('Ready to merge')).toHaveCount(0);
        await expect(merge).toHaveAttribute('aria-disabled', 'true');
        await expect(merge).toHaveAttribute(
          'aria-description',
          /no longer counts\. A reviewer sends it back with Request changes/,
        );
        // Pressing it anyway asks the API for nothing.
        const asked = page
          .waitForRequest(
            (r) => r.method() === 'POST' && /\/merge$/.test(r.url()),
            { timeout: 1_000 },
          )
          .then(
            () => true,
            () => false,
          );
        await merge.click({ force: true });
        expect(await asked).toBe(false);
      } finally {
        await how.restore(admin, person.id);
      }
    });
  }
});
