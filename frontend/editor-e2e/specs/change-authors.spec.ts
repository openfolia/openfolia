import { type Api, changeSetWithModule, unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

/**
 * Everyone who wrote a revision counts as its author (#597): a fix written on a maintenance line
 * and carried forward to main by someone else stays its writer's under four eyes. Four eyes is the
 * installation's default, so nothing here changes a setting (no `isolated` project needed).
 */

/**
 * A fix by `writer` on a new maintenance line, reviewed and merged there, then carried forward
 * to main by `carrier` and submitted: the carried revision's ID and title.
 */
async function carriedFix(
  writer: Api,
  carrier: Api,
  reviewer: Api,
  publisher: Api,
): Promise<{ id: string; title: string }> {
  const release = await publisher.cutRelease({
    // A revision of its own: no other flow's release or maintenance line meets it.
    product: 'north',
    revision: `e2e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
  });
  const line = await publisher.startMaintenanceLine(release.id);
  const title = unique('Fix on the line');
  const fix = await changeSetWithModule(writer, title, {
    submit: true,
    maintenanceLine: line,
  });
  await reviewer.transition(fix.id, 'approve');
  await publisher.transition(fix.id, 'merge');
  const carried = await carrier.carryForward(fix.id);
  await carrier.transition(carried.id, 'submit', 'Carried to main.');
  return { id: carried.id, title };
}

test.describe('the writer of a carried-forward fix @area:review @api:change-sets @api:releases', () => {
  test('its writer finds Approve and Return blocked on the carried revision, though someone else started it', async ({
    page,
    api,
  }) => {
    // The admin writes and reviews; the author carries the fix forward.
    const admin = await api(USERS.admin);
    const carried = await carriedFix(
      admin,
      await api(USERS.author),
      await api(USERS.reviewer),
      await api(USERS.publisher),
    );

    await signIn(page, USERS.admin);
    await page.goto(`/review?cs=${carried.id}`);
    await expect(
      page.getByRole('heading', { level: 2, name: new RegExp(carried.title) }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page.getByRole('button', { name: 'Approve' }).hover();
    await expect(
      page.getByText('You wrote this revision, or part of it'),
    ).toBeVisible();
    await expect(page.locator('[data-slot="self-approval-note"]')).toHaveCount(
      0,
    );
  });

  test('a reviewer who wrote none of it approves it, not as its author', async ({
    page,
    api,
  }) => {
    const reviewer = await api(USERS.reviewer);
    const carried = await carriedFix(
      await api(USERS.admin),
      await api(USERS.author),
      reviewer,
      await api(USERS.publisher),
    );

    await signIn(page, USERS.reviewer);
    await page.goto(`/review?cs=${carried.id}`);
    await expect(
      page.getByRole('heading', { level: 2, name: new RegExp(carried.title) }),
    ).toBeVisible();
    const approved = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/change-sets/${carried.id}/approve`) &&
        r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Approve' }).click();
    expect((await approved).status()).toBe(200);
    await expect(page.locator('[data-slot="self-approved"]')).toHaveCount(0);
  });
});
