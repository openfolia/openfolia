import { type Page, request } from '@playwright/test';
import { exampleBundle } from '../src/import-bundle.ts';
import { type Api, expect, signIn, test, USERS } from './fixtures.ts';

// The user guide's Admin screens (#680): the rail and the palette, users and roles, group
// mappings, service accounts and their tokens, the project settings and the variant attributes,
// branding, webhooks, the audit log, backups and the system page. Each makes what it shows through
// the API and removes it again where it can: a service account cannot be deleted, so each
// language has one of its own.

/** The examples the Admin shots use, per language. */
const ADMIN = {
  en: {
    revision: 'Add a model size',
    group: 'docs-reviewers',
    service: 'Portal build',
    serviceId: 'portal-build',
    token: 'Portal build, production',
    hook: 'Portal build',
    newUser: 'Robin Meyer',
    newEmail: 'robin.meyer@example.com',
  },
  de: {
    revision: 'Eine Modellgröße ergänzen',
    group: 'docs-reviewers',
    service: 'Portal-Build',
    serviceId: 'portal-build-de',
    token: 'Portal-Build, Produktion',
    hook: 'Portal-Build',
    newUser: 'Robin Meyer',
    newEmail: 'robin.meyer@example.com',
  },
} as const;

const examples = (lang: string) => (lang === 'de' ? ADMIN.de : ADMIN.en);

/** Opens an admin page and waits for its heading. */
async function openAdmin(page: Page, path: string, title: string) {
  await page.goto(`/admin/${path}`);
  await expect(
    page.getByRole('heading', { level: 1, name: title }),
  ).toBeVisible();
}

/** A group mapping of `group` to `role`, made through the API; answers its ID. */
async function mapGroup(api: Api, group: string, role: string) {
  const { data } = await api.json<{ data: { id: string } }>(
    api.send('POST', '/group-mappings', {
      data: {
        type: 'GroupMapping',
        attributes: { group },
        relationships: { role: { data: { type: 'Role', id: role } } },
      },
    }),
    [201, 409],
  );
  return data?.id;
}

/** Removes every mapping of `group`. */
async function unmapGroup(api: Api, group: string) {
  const { data } = await api.json<{ data: { id: string }[] }>(
    api.get(`/group-mappings?filter[group]=${encodeURIComponent(group)}`),
  );
  for (const { id } of data) await api.send('DELETE', `/group-mappings/${id}`);
}

test.describe('the user guide: admin', () => {
  test('the admin pages in the search palette', async ({ page, save, l }) => {
    await signIn(page, USERS.admin);
    await page.goto('/content');
    await expect(page.getByRole('row').nth(3)).toBeVisible();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog');
    await palette
      .getByRole('combobox', {
        name: l('search.placeholder').replace(/…$/, ''),
      })
      .fill(l('admin.settings.sections.languages'));
    await expect(
      palette.getByRole('option', { name: /›/ }).first(),
    ).toBeVisible();
    await save('admin-palette');
  });

  test('users', async ({ page, save, lang, l }) => {
    const ex = examples(lang);
    await signIn(page, USERS.admin);
    await openAdmin(page, 'users', l('admin.titles.users'));
    await expect(page.getByRole('row').nth(3)).toBeVisible();
    await save('admin-users');

    await page
      .getByRole('button', { name: l('admin.actions.newUser') })
      .click();
    const dialog = page.getByRole('dialog', {
      name: l('admin.users.new.title'),
    });
    await dialog.getByLabel(l('admin.users.fields.name')).fill(ex.newUser);
    await dialog.getByLabel(l('admin.users.fields.email')).fill(ex.newEmail);
    await save('admin-user-new');
  });

  test('roles', async ({ page, save, l }) => {
    await signIn(page, USERS.admin);
    await page.goto('/admin/roles?role=author');
    await expect(
      page.getByRole('heading', { level: 1, name: l('admin.titles.roles') }),
    ).toBeVisible();
    await expect(page.getByLabel(l('admin.roles.fields.name'))).not.toHaveValue(
      '',
    );
    await save('admin-roles');
  });

  test('group mappings', async ({ page, save, lang, l, as }) => {
    const ex = examples(lang);
    const admin = await as(USERS.admin);
    await mapGroup(admin, ex.group, 'reviewer');
    try {
      await signIn(page, USERS.admin);
      await openAdmin(page, 'group-mappings', l('admin.titles.groupMappings'));
      await expect(
        page.getByRole('row', { name: /docs-reviewers/ }),
      ).toBeVisible();
      await page
        .getByRole('button', { name: l('admin.actions.addMapping') })
        .first()
        .click();
      const dialog = page.getByRole('dialog', {
        name: l('admin.groupMappings.dialog.title'),
      });
      await dialog
        .getByRole('textbox', { name: l('admin.groupMappings.fields.group') })
        .fill('docs-translators');
      await save('admin-group-mappings');
    } finally {
      await unmapGroup(admin, ex.group);
    }
  });

  test('service account tokens', async ({ page, save, lang, l, as }) => {
    const ex = examples(lang);
    const admin = await as(USERS.admin);
    // A service account cannot be deleted: one per language, kept for a retry.
    await admin.json(
      admin.send('POST', '/service-accounts', {
        data: {
          type: 'ServiceAccount',
          id: ex.serviceId,
          attributes: { name: ex.service, description: null },
          relationships: {
            roles: { data: [{ type: 'Role', id: 'reader' }] },
          },
        },
      }),
      [201, 409],
    );
    await signIn(page, USERS.admin);
    await openAdmin(
      page,
      'service-accounts',
      l('admin.titles.serviceAccounts'),
    );
    await page
      .getByRole('button', {
        name: l('admin.serviceAccounts.actions.tokensLabel', {
          name: ex.service,
        }),
      })
      .click();
    const sheet = page.getByRole('dialog');
    await sheet
      .getByRole('button', { name: l('admin.serviceAccounts.tokens.issue') })
      .click();
    await sheet
      .getByLabel(l('admin.serviceAccounts.tokens.name'))
      .fill(ex.token);
    await sheet
      .getByRole('button', {
        name: l('admin.serviceAccounts.tokens.create'),
        exact: true,
      })
      .click();
    await expect(
      sheet.getByText(l('admin.serviceAccounts.issued.title')),
    ).toBeVisible();
    // A real token, even of a throwaway stack, never goes into a public image.
    await page
      .locator('#issued-token')
      .evaluate(
        (el) =>
          (el.textContent = `ccms_sat_${'0'.repeat(16)}_${'•'.repeat(64)}`),
      );
    await save('admin-service-token');
  });

  test('project settings and variant attributes', async ({
    page,
    save,
    lang,
    l,
    as,
  }) => {
    const ex = examples(lang);
    const revision = await (await as(USERS.admin)).createChangeSet(ex.revision);
    await signIn(page, USERS.admin);
    await page.goto(`/admin/settings/module-types?cs=${revision.id}`);
    await expect(
      page.getByRole('button', { name: l('admin.settings.add.moduleType') }),
    ).toBeEnabled();
    await save('admin-settings');

    await page.goto(
      `/admin/settings/variant-attributes?cs=${revision.id}&attribute=model&value=large`,
    );
    await expect(page.getByText(l('admin.variants.detail.key'))).toBeVisible();
    await save('admin-variant-attributes');
  });

  test('branding', async ({ page, save, l }) => {
    await signIn(page, USERS.admin);
    await openAdmin(page, 'branding', l('admin.titles.branding'));
    await expect(
      page.getByText(l('admin.branding.preview.title'), { exact: true }),
    ).toBeVisible();
    await save('admin-branding');
  });

  test('webhooks', async ({ page, save, lang, l, as }) => {
    const ex = examples(lang);
    const admin = await as(USERS.admin);
    const { data } = await admin.json<{ data: { id: string } }>(
      admin.send('POST', '/webhooks', {
        data: {
          type: 'Webhook',
          attributes: {
            url: 'https://portal.example.com/hooks/docs',
            events: ['manual.released', 'release.withdrawn'],
            description: ex.hook,
          },
        },
      }),
      201,
    );
    try {
      await signIn(page, USERS.admin);
      await page.goto(`/admin/webhooks?hook=${data.id}`);
      await expect(
        page.getByRole('heading', {
          level: 1,
          name: l('admin.titles.webhooks'),
        }),
      ).toBeVisible();
      await page
        .getByRole('button', { name: l('admin.webhooks.log.test') })
        .click();
      await expect(
        page
          .getByRole('region', { name: l('admin.webhooks.log.label') })
          .getByRole('listitem')
          .first(),
      ).toBeVisible();
      await save('admin-webhooks');
    } finally {
      await admin.send('DELETE', `/webhooks/${data.id}`);
    }
  });

  test('audit log', async ({ page, save, lang, l, as }) => {
    const ex = examples(lang);
    // Something to show: a revision started and abandoned.
    const admin = await as(USERS.admin);
    const revision = await admin.createChangeSet(ex.revision);
    await admin.abandon(revision.id);
    await signIn(page, USERS.admin);
    await openAdmin(page, 'audit', l('admin.titles.audit'));
    await expect(
      page
        .locator('[data-slot="audit-row"]')
        .filter({ hasText: l('admin.audit.actions.changeSetAbandon') })
        .first(),
    ).toBeVisible();
    await page
      .getByRole('button', { name: l('admin.audit.export.label') })
      .click();
    await expect(page.getByRole('menu')).toBeVisible();
    await save('admin-audit');
  });

  // #877: the reads of a service account, as an MCP server's tools make them.
  test('audit log reads', async ({ page, save, lang, l, as }) => {
    const ex = examples(lang);
    // One account per run (a service account cannot be deleted): only this run's reads show.
    const accountId = `${ex.serviceId}-mcp-${Date.now().toString(36)}`;
    const admin = await as(USERS.admin);
    await admin.json(
      admin.send('POST', '/service-accounts', {
        data: {
          type: 'ServiceAccount',
          id: accountId,
          attributes: { name: `${ex.service} MCP`, description: null },
          relationships: {
            roles: { data: [{ type: 'Role', id: 'reader' }] },
          },
        },
      }),
      201,
    );
    const issued = await admin.json<{ meta: { token: string } }>(
      admin.send('POST', `/service-accounts/${accountId}/tokens`, {
        data: { type: 'ServiceToken', attributes: { name: 'MCP' } },
      }),
      201,
    );
    const reads = await request.newContext({
      baseURL: process.env['E2E_API_URL'],
      extraHTTPHeaders: {
        Authorization: `Bearer ${issued.meta.token}`,
        Accept: 'application/vnd.api+json',
      },
    });
    try {
      for (const [client, path] of [
        ['mcp', '/me'],
        ['mcp/search', '/search?filter[q]=battery&ref=main'],
        ['mcp/read_module', '/modules/en/no-such-module?ref=main'],
        ['mcp/list_manuals', '/manuals?ref=main'],
      ] as const) {
        await reads.get(path, { headers: { 'X-OpenFolia-Client': client } });
      }
    } finally {
      await reads.dispose();
    }
    await signIn(page, USERS.admin);
    await page.goto(
      `/admin/audit?kind=read&actor=${encodeURIComponent(`service/${accountId}`)}`,
    );
    const rows = page.locator('[data-slot="audit-row"]');
    await expect(async () => {
      await page.reload();
      await expect(rows).toHaveCount(4);
    }).toPass({ timeout: 15_000 });
    await expect(
      rows.first().getByText(l('admin.audit.actions.apiRead')),
    ).toBeVisible();
    await save('admin-audit-reads');
  });

  test('backups', async ({ page, save, l }) => {
    await signIn(page, USERS.admin);
    await openAdmin(page, 'backups', l('admin.titles.backups'));
    await expect(
      page.getByText(l('admin.backups.key.heading'), { exact: true }),
    ).toBeVisible();
    await save('admin-backups');
  });

  test('import', async ({ page, save, l }) => {
    // A dry run only: it is kept on the server for an hour and changes nothing.
    await signIn(page, USERS.admin);
    await openAdmin(page, 'import', l('admin.titles.import'));
    await page.locator('#import-file-zone').setInputFiles({
      name: 'wiki-export.zip',
      mimeType: 'application/zip',
      buffer: exampleBundle(''),
    });
    await page.locator('[data-slot="dry-run"]').click();
    await expect(page.locator('[data-slot="counts"]')).toBeVisible();
    await save('admin-import');
  });

  test('system', async ({ page, save, l }) => {
    await signIn(page, USERS.admin);
    await openAdmin(page, 'system', l('admin.titles.system'));
    const email = page.getByRole('region', {
      name: l('admin.system.mail.title'),
    });
    await expect(email).toBeVisible();
    // The key file's path is the screenshot stack's own folder: shown as a server's would be.
    await page
      .getByText(/ccms-secret\.key/)
      .first()
      .evaluate((el) => (el.textContent = '/data/ccms-secret.key'));
    await save('admin-system');
  });
});
