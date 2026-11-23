import { type Api, unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

interface HeaderJson {
  name: string;
  secret: boolean;
  value: string | null;
}

/**
 * Every flow here runs beside the others on one stack, each making and deleting subscribers of
 * its own. The page shows the log of the subscriber its address names, else of the first listed:
 * another flow's, which that flow may delete between the list's read and its log's (a 404, #603).
 * So each flow opens the page on a subscriber of its own, made through the API, on a page large
 * enough to hold it whatever the others made meanwhile. Deleted after the test (`afterEach`
 * below), whatever happened.
 */
let own: string[] = [];

async function ownSubscriber(
  admin: Api,
  attributes: Record<string, unknown> = {},
): Promise<string> {
  const { data } = await admin.json<{ data: { id: string } }>(
    admin.send('POST', '/webhooks', {
      data: {
        type: 'Webhook',
        attributes: {
          url: `https://receiver-${Date.now().toString(36)}.example/own`,
          events: ['manual.released'],
          description: unique('E2E own hook'),
          ...attributes,
        },
      },
    }),
    201,
  );
  own.push(data.id);
  return data.id;
}

const ownPage = (id: string) => `/admin/webhooks?hook=${id}&size=50`;

// Admin → Webhooks (`/admin/webhooks`): custom headers per subscriber (#457), a secret value
// stored sealed and write-only.
test.describe('webhooks @area:admin @api:webhooks @api:secrets', () => {
  test.afterEach(async ({ api }) => {
    const admin = await api(USERS.admin);
    for (const id of own) await admin.send('DELETE', `/webhooks/${id}`);
    own = [];
  });

  test('adds a secret header, shows it only as Set, replaces and removes headers, and asks for the secret again for a new URL', async ({
    page,
    api,
  }) => {
    const name = unique('E2E hook');
    const admin = await api(USERS.admin);
    const anchor = await ownSubscriber(admin);
    await signIn(page, USERS.admin);
    await page.goto(ownPage(anchor));
    await page.getByRole('button', { name: 'Add subscriber' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByRole('textbox', { name: 'URL' })
      .fill(`https://receiver-${Date.now().toString(36)}.example/hook`);
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);

    const rows = dialog.locator('[data-header="row"]');
    await dialog.getByRole('button', { name: 'Add header' }).click();
    await rows
      .nth(0)
      .getByRole('textbox', { name: 'Name' })
      .fill('Authorization');
    // A credential's name turns "Secret" on by itself (#560).
    await expect(
      rows.nth(0).getByRole('switch', { name: 'Secret' }),
    ).toBeChecked();
    // A secret value is typed into a password field.
    const secretValue = rows.nth(0).locator('input[type="password"]');
    await secretValue.fill('Bearer e2e-first-token');

    // A name the server sets is refused before anything is sent.
    await dialog.getByRole('button', { name: 'Add header' }).click();
    await rows.nth(1).getByRole('textbox', { name: 'Name' }).fill('Host');
    await expect(rows.nth(1).getByRole('alert')).toContainText(
      'The server sets this header',
    );
    await rows.nth(1).getByRole('textbox', { name: 'Name' }).fill('X-Tenant');
    await rows.nth(1).getByRole('textbox', { name: 'Value' }).fill('north');
    await expect(rows.nth(1).getByRole('alert')).toHaveCount(0);

    const created = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/webhooks'),
    );
    await dialog
      .getByRole('button', { name: 'Add subscriber', exact: true })
      .click();
    const answer = await created;
    expect(answer.status()).toBe(201);
    const body = (await answer.json()) as {
      data: { id: string; attributes: { headers: HeaderJson[] } };
    };
    const id = body.data.id;
    try {
      // Never the secret value, not even in the answer that made it.
      expect(body.data.attributes.headers).toEqual([
        { name: 'Authorization', secret: true, value: null },
        { name: 'X-Tenant', secret: false, value: 'north' },
      ]);
      expect(JSON.stringify(body)).not.toContain('e2e-first-token');
      await page.getByRole('button', { name: 'Done' }).click();
      // Closed: while it closes it hands the focus back, which would close the menu opened next.
      await expect(page.getByRole('dialog')).toHaveCount(0);

      // Edit: the secret shows only "Set".
      await page.getByRole('button', { name: `Actions for ${name}` }).click();
      await page.getByRole('menuitem', { name: 'Edit' }).click();
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0).locator('[data-header="set"]')).toHaveText(
        /Set/,
      );
      await expect(rows.nth(0).locator('input[type="password"]')).toHaveCount(
        0,
      );

      // A new URL asks for the secret value again, and nothing is saved.
      const url = dialog.getByRole('textbox', { name: 'URL' });
      const before = await url.inputValue();
      await url.fill(`${before}/moved`);
      await expect(rows.nth(0).getByRole('alert')).toContainText(
        'enter the secret value again',
      );
      await url.fill(before);
      await expect(rows.nth(0).getByRole('alert')).toHaveCount(0);

      // Replace the secret, remove the plain one.
      await rows.nth(0).getByRole('button', { name: 'Replace' }).click();
      await rows
        .nth(0)
        .locator('input[type="password"]')
        .fill('Bearer e2e-second-token');
      await dialog
        .getByRole('button', { name: 'Remove header X-Tenant' })
        .click();
      await expect(rows).toHaveCount(1);
      const saved = page.waitForResponse(
        (r) =>
          r.request().method() === 'PATCH' &&
          r.url().endsWith(`/webhooks/${id}`),
      );
      await dialog.getByRole('button', { name: 'Save changes' }).click();
      expect((await saved).status()).toBe(200);
      await expect(dialog).toHaveCount(0);

      const { data } = await admin.json<{
        data: { attributes: { headers: HeaderJson[] } };
      }>(admin.get(`/webhooks/${id}`));
      expect(data.attributes.headers).toEqual([
        { name: 'Authorization', secret: true, value: null },
      ]);
    } finally {
      await admin.send('DELETE', `/webhooks/${id}`);
    }
  });

  // #560: Replace, a rename, then Keep goes back to the stored header, its name included; a header
  // the API refuses says so on its own row, never at the top of the form.
  test.describe('a refused header', () => {
    // The API refuses the save (422): the browser reports it.
    test.use({ consoleAllow: [/status of 422/] });

    test('keeps a stored secret under its own name after a rename, and shows the API’s refusal on its row', async ({
      page,
      api,
    }) => {
      const name = unique('E2E stale hook');
      const admin = await api(USERS.admin);
      const { data } = await admin.json<{ data: { id: string } }>(
        admin.send('POST', '/webhooks', {
          data: {
            type: 'Webhook',
            attributes: {
              url: `https://receiver-${Date.now().toString(36)}.example/stale`,
              events: ['manual.released'],
              description: name,
              headers: [
                {
                  name: 'Authorization',
                  value: 'Bearer e2e-stale',
                  secret: true,
                },
              ],
            },
          },
        }),
        201,
      );
      const id = data.id;
      try {
        await signIn(page, USERS.admin);
        await page.goto(ownPage(id));
        await page.getByRole('button', { name: `Actions for ${name}` }).click();
        await page.getByRole('menuitem', { name: 'Edit' }).click();
        const dialog = page.getByRole('dialog');
        const rows = dialog.locator('[data-header="row"]');
        const first = rows.nth(0);
        await expect(first.locator('[data-header="set"]')).toHaveText(/Set/);

        // Replace, rename, Keep: the stored header again, under its stored name.
        await first.getByRole('button', { name: 'Replace' }).click();
        await first.getByRole('textbox', { name: 'Name' }).fill('X-Renamed');
        await first.getByRole('button', { name: 'Keep stored value' }).click();
        await expect(first.getByRole('textbox', { name: 'Name' })).toHaveValue(
          'Authorization',
        );
        await expect(first.locator('[data-header="set"]')).toHaveText(/Set/);

        // Meanwhile the stored header is removed elsewhere: keeping it is refused, on its row.
        await admin.json(
          admin.send('PATCH', `/webhooks/${id}`, {
            data: { type: 'Webhook', id, attributes: { headers: [] } },
          }),
        );
        await dialog.getByRole('button', { name: 'Add header' }).click();
        await rows
          .nth(1)
          .getByRole('textbox', { name: 'Name' })
          .fill('X-Tenant');
        await rows.nth(1).getByRole('textbox', { name: 'Value' }).fill('north');
        const refused = page.waitForResponse(
          (r) =>
            r.request().method() === 'PATCH' &&
            r.url().endsWith(`/webhooks/${id}`),
        );
        await dialog.getByRole('button', { name: 'Save changes' }).click();
        const answer = await refused;
        expect(answer.status()).toBe(422);
        expect(
          (
            (await answer.json()) as {
              errors: { source: { pointer: string } }[];
            }
          ).errors[0]?.source.pointer,
        ).toBe('/data/attributes/headers/0/value');
        await expect(first.getByRole('alert')).toContainText(
          'The stored value can no longer be used',
        );
        await expect(dialog.getByRole('alert')).toHaveCount(1);

        // Given a value again, it saves.
        await first.getByRole('button', { name: 'Replace' }).click();
        await first.locator('input[type="password"]').fill('Bearer e2e-again');
        await expect(first.getByRole('alert')).toHaveCount(0);
        const saved = page.waitForResponse(
          (r) =>
            r.request().method() === 'PATCH' &&
            r.url().endsWith(`/webhooks/${id}`),
        );
        await dialog.getByRole('button', { name: 'Save changes' }).click();
        expect((await saved).status()).toBe(200);
        await expect(dialog).toHaveCount(0);
        const stored = await admin.json<{
          data: { attributes: { headers: HeaderJson[] } };
        }>(admin.get(`/webhooks/${id}`));
        expect(stored.data.attributes.headers).toEqual([
          { name: 'Authorization', secret: true, value: null },
          { name: 'X-Tenant', secret: false, value: 'north' },
        ]);
      } finally {
        await admin.send('DELETE', `/webhooks/${id}`);
      }
    });
  });

  // #558: a subscriber can be sent `manual.deprecated`, and needs at least one event.
  test('subscribes to manual.deprecated alone, and refuses a subscriber without events', async ({
    page,
    api,
  }) => {
    const name = unique('E2E manual hook');
    const admin = await api(USERS.admin);
    const anchor = await ownSubscriber(admin);
    await signIn(page, USERS.admin);
    await page.goto(ownPage(anchor));
    await page.getByRole('button', { name: 'Add subscriber' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByRole('textbox', { name: 'URL' })
      .fill(`https://receiver-${Date.now().toString(36)}.example/manuals`);
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    const box = (event: string) =>
      dialog.locator(`[data-event="${event}"]`).getByRole('checkbox');
    await expect(
      dialog.getByText('A released manual was deprecated through a revision.'),
    ).toBeVisible();

    // The release events chosen by default, taken off: none left is refused.
    await box('manual.released').uncheck();
    await box('module.released').uncheck();
    const add = dialog.getByRole('button', {
      name: 'Add subscriber',
      exact: true,
    });
    await add.click();
    await expect(dialog.getByRole('alert')).toContainText(
      'Choose at least one event.',
    );

    await box('manual.deprecated').check();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    const created = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/webhooks'),
    );
    await add.click();
    const answer = await created;
    expect(answer.status()).toBe(201);
    const body = (await answer.json()) as {
      data: { id: string; attributes: { events: string[] } };
    };
    const id = body.data.id;
    try {
      expect(body.data.attributes.events).toEqual(['manual.deprecated']);
      await page.getByRole('button', { name: 'Done' }).click();
      // Closed: while it closes it hands the focus back, which would close the menu opened next.
      await expect(page.getByRole('dialog')).toHaveCount(0);
      // The log is the new subscriber's, chosen in the address.
      await expect(page).toHaveURL(new RegExp(`hook=${id}`));
      await expect(page.locator('#webhook-log-title')).toContainText(name);
      // Opened again, it shows that one event chosen.
      await page.getByRole('button', { name: `Actions for ${name}` }).click();
      await page.getByRole('menuitem', { name: 'Edit' }).click();
      await expect(box('manual.deprecated')).toBeChecked();
      await expect(box('manual.released')).not.toBeChecked();
      const { data } = await admin.json<{
        data: { attributes: { events: string[] } };
      }>(admin.get(`/webhooks/${id}`));
      expect(data.attributes.events).toEqual(['manual.deprecated']);
    } finally {
      await admin.send('DELETE', `/webhooks/${id}`);
    }
  });
});
