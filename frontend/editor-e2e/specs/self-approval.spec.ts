import { Api, changeSetWithModule, unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

/**
 * Self-approval (#588): an installation-wide setting. Turned on, it would change what every other
 * flow sees of the four-eyes rule, so this file runs in a Playwright project of its own
 * (`isolated`, `playwright.config.ts`) after every other flow is done, one test at a time, and
 * puts the setting back to `never` after each test, whatever happened.
 */
test.describe.configure({ mode: 'serial' });

async function setRule(rule: string): Promise<void> {
  const admin = await Api.as(USERS.admin);
  try {
    await admin.json(
      admin.send('PATCH', '/settings', {
        data: {
          type: 'InstallationSettings',
          id: 'installation',
          attributes: { selfApproval: rule },
        },
      }),
    );
  } finally {
    await admin.dispose();
  }
}

test.describe('self-approval @area:admin @area:review @api:settings @api:change-sets', () => {
  test.afterEach(() => setRule('never'));

  test('an administrator lets authors approve their own revision; the author approves theirs, marked as such', async ({
    page,
    api,
  }) => {
    // The admin holds every permission: they write, review and publish.
    const admin = await api(USERS.admin);
    const changeSet = await changeSetWithModule(admin, unique('Mine alone'), {
      submit: true,
    });

    await signIn(page, USERS.admin);
    await page.goto('/admin/settings/review');
    await expect(
      page.getByText('Applies to the whole installation at once.'),
    ).toBeVisible();
    const never = page.locator('[data-option="never"] [role="radio"]');
    await expect(never).toHaveAttribute('aria-checked', 'true');
    const saved = page.waitForResponse(
      (r) =>
        r.url().endsWith('/api/settings') && r.request().method() === 'PATCH',
    );
    await page.locator('[data-option="review"]').click();
    expect((await saved).status()).toBe(200);
    await expect(
      page.locator('[data-option="review"] [role="radio"]'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('of-save-status')).toHaveAttribute(
      'data-status',
      'saved',
    );

    await page.goto(`/review?cs=${changeSet.id}`);
    await expect(
      page.getByRole('heading', { level: 2, name: /Mine alone/ }),
    ).toBeVisible();
    await expect(page.locator('[data-slot="self-approval-note"]')).toHaveText(
      /Four eyes is off for this installation/,
    );
    const approved = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/change-sets/${changeSet.id}/approve`) &&
        r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Approve' }).click();
    expect((await approved).status()).toBe(200);
    await expect(page.locator('[data-slot="self-approved"]')).toHaveText(
      /Approved by its author/,
    );
    await expect(
      page.getByText(/Approved by its author, Sample Admin/),
    ).toBeVisible();
    const review = await admin.json(
      admin.get(`/change-sets/${changeSet.id}/review`),
    );
    expect(review['meta'].review).toMatchObject({
      selfApproved: true,
      approvals: [{ requirement: 'review', self: true }],
    });

    // The audit log marks the approval as its author's.
    await page.goto(
      `/admin/audit?type=change-set&id=${changeSet.id}&action=change-set.approve`,
    );
    await expect(page.locator('[data-slot="audit-self"]')).toHaveText(
      'By its author',
    );
  });

  test('with four eyes, the author’s Approve stays blocked and no note shows', async ({
    page,
    api,
  }) => {
    const admin = await api(USERS.admin);
    const changeSet = await changeSetWithModule(admin, unique('Four eyes'), {
      submit: true,
    });

    await signIn(page, USERS.admin);
    await page.goto(`/review?cs=${changeSet.id}`);
    await expect(
      page.getByRole('heading', { level: 2, name: /Four eyes/ }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(page.locator('[data-slot="self-approval-note"]')).toHaveCount(
      0,
    );
    await expect(page.locator('[data-slot="self-approved"]')).toHaveCount(0);
  });
});
