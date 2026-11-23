import {
  Api,
  expect,
  MODULE_ID,
  paragraph,
  revisionWithModule,
  signIn,
  t,
  test,
  USERS,
  type Block,
} from './fixtures.ts';

// The user guide's screens of review and checks (#680): the review list, the diff views, block
// comments, approvals with a sign-off and a configuration change, self-approval, and the checks
// of a revision with broken references. Nothing here merges into main; the self-approval shot
// puts the installation's rule back to "never" whatever happens.

/** This file's own example texts, per language. */
const MORE = {
  en: {
    comment: 'Which battery type fits the small model?',
    reply: 'Say how long a charge lasts, too.',
    charging: 'Charge the battery for at least four hours before first use.',
    broken: 'Check the links',
    brokenText: 'See the cleaning steps and the term',
    brokenTerm: 'charger',
  },
  de: {
    comment: 'Welcher Batterietyp passt zum kleinen Modell?',
    reply: 'Sagen Sie auch, wie lange eine Ladung reicht.',
    charging: 'Charge the battery for at least four hours before first use.',
    broken: 'Links prüfen',
    brokenText: 'Siehe die Reinigungsschritte und den Begriff',
    brokenTerm: 'Ladegerät',
  },
} as const;
const more = (lang: string) => (lang === 'de' ? MORE.de : MORE.en);

/** Sets the installation's self-approval rule (`never`, `review`, `review-and-sign-off`). */
async function setSelfApproval(rule: string): Promise<void> {
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

test.describe('the user guide: review and checks', () => {
  test('review list', async ({ page, save, lang, text, as }) => {
    const author = await as(USERS.author);
    const revision = await revisionWithModule(author, lang, text.revision);
    await author.transition(revision.id, 'submit', text.intro);
    // A second one, still a draft: the filters count it.
    await author.createChangeSet(text.other);

    await signIn(page, USERS.reviewer);
    await page.goto(`/review?cs=${revision.id}`);
    await expect(
      page.getByRole('heading', { level: 2, name: text.revision }),
    ).toBeVisible();
    await expect(page.getByText(text.module).first()).toBeVisible();
    await save('review-list');
  });

  test('compare', async ({ page, save, lang, text, l, as }) => {
    const admin = await as(USERS.admin);
    const revision = await revisionWithModule(admin, lang, text.revision);
    // The manual takes the new module; an existing module gets a sentence more.
    await admin.editManual(revision.id, 'operating', (manual) => ({
      ...manual,
      entries: [...manual['entries'], { module: MODULE_ID }],
    }));
    await admin.editModule(
      revision.id,
      { lang: 'en', moduleId: 'charging' },
      (module) => ({
        ...module,
        blocks: [
          ...module.blocks.slice(0, 1),
          paragraph('first-use', more(lang).charging),
          ...module.blocks.slice(1),
        ],
      }),
    );

    await signIn(page, USERS.admin);
    const changes = page.getByRole('region', { name: l('review.diff.label') });
    await page.goto(`/review?state=draft&cs=${revision.id}`);
    await expect(
      page.getByRole('heading', { level: 2, name: text.revision }),
    ).toBeVisible();
    await expect(changes.getByText(text.module).first()).toBeVisible();
    await save('review-outline');

    await page.goto(
      `/review?state=draft&cs=${revision.id}&module=charging&lang=en&diff=side-by-side`,
    );
    await expect(page.getByText(more(lang).charging).first()).toBeVisible();
    await page.getByText(more(lang).charging).first().scrollIntoViewIfNeeded();
    await save('review-side-by-side');

    await page.goto(
      `/review?state=draft&cs=${revision.id}&module=charging&lang=en&diff=rendered`,
    );
    const charging = changes.getByRole('listitem').filter({
      has: page.getByRole('heading', { level: 3, name: /^Charging/ }),
    });
    await expect(
      charging
        .locator(`iframe[title="${l('review.rendered.frame')}"]`)
        .contentFrame()
        .getByText(more(lang).charging),
    ).toBeVisible();
    await page.waitForTimeout(1500);
    await save('review-rendered');
  });

  test('comments', async ({ page, save, lang, text, as }) => {
    const author = await as(USERS.author);
    const revision = await revisionWithModule(author, lang, text.revision);
    await author.transition(revision.id, 'submit');
    const module = { lang, moduleId: MODULE_ID };
    await (
      await as(USERS.reviewer)
    ).comment(revision.id, module, 'intro', more(lang).comment);
    await author.comment(revision.id, module, 'steps', more(lang).reply);

    await signIn(page, USERS.reviewer);
    await page.goto(
      `/review?cs=${revision.id}&module=${MODULE_ID}&lang=${lang}`,
    );
    const comment = page.getByText(more(lang).comment);
    await expect(comment).toBeVisible();
    await comment.scrollIntoViewIfNeeded();
    await save('review-comments');
  });

  test('approvals and a configuration change', async ({
    page,
    save,
    lang,
    text,
    as,
  }) => {
    // Procedures become a restricted type, in the same revision as a new procedure: it needs
    // the review and a sign-off.
    const admin = await as(USERS.admin);
    const revision = await revisionWithModule(admin, lang, text.revision);
    await admin.editConfig(revision.id, (config) => ({
      ...config,
      moduleTypes: config['moduleTypes'].map(
        (type: { id: string; label: string }) =>
          type.id === 'procedure' ? { ...type, restricted: true } : type,
      ),
    }));
    await admin.transition(revision.id, 'submit');
    await (await as(USERS.reviewer)).transition(revision.id, 'approve');

    await signIn(page, USERS.approver);
    await page.goto(`/review?cs=${revision.id}`);
    await expect(
      page.getByRole('heading', { level: 2, name: text.revision }),
    ).toBeVisible();
    await expect(page.getByText('openfolia.yaml').first()).toBeVisible();
    await save('review-approvals');
  });

  test('self-approval', async ({ page, save, lang, text, l, as }) => {
    const admin = await as(USERS.admin);
    const revision = await revisionWithModule(admin, lang, text.revision);
    await admin.transition(revision.id, 'submit');
    try {
      await setSelfApproval('review');
      await signIn(page, USERS.admin);
      await page.goto('/admin/settings/review');
      await expect(
        page.getByText(l('admin.settings.installation.appliesAtOnce')),
      ).toBeVisible();
      await expect(
        page.locator('[data-option="review"] [role="radio"]'),
      ).toHaveAttribute('aria-checked', 'true');
      await save('review-self-approval-setting');

      await page.goto(`/review?cs=${revision.id}`);
      await expect(
        page.locator('[data-slot="self-approval-note"]'),
      ).toBeVisible();
      await page
        .getByRole('button', { name: l('review.actions.approve') })
        .click();
      await expect(page.locator('[data-slot="self-approved"]')).toBeVisible();
      // Read again, in the Approved list, without the toast.
      await page.goto(`/review?state=approved&cs=${revision.id}`);
      await expect(page.locator('[data-slot="self-approved"]')).toBeVisible();
      await save('review-self-approved');
    } finally {
      await setSelfApproval('never');
    }
  });

  test('checks with broken references', async ({ page, save, lang, as }) => {
    const m = more(lang);
    const admin = await as(USERS.admin);
    const revision = await admin.createChangeSet(m.broken);
    const blocks: Block[] = [
      {
        type: 'paragraph',
        id: 'links',
        content: [
          t(`${m.brokenText} `),
          {
            type: 'text',
            text: m.brokenTerm,
            marks: [{ type: 'term', termId: 'no-such-term' }],
          },
          t(': '),
          { type: 'xref', module: 'clean-the-sensors' },
          t('.'),
        ],
      },
    ];
    await admin.createModule(revision, {
      lang: 'en',
      moduleId: 'check-the-links',
      title: m.broken,
      type: 'procedure',
      blocks,
    });

    await signIn(page, USERS.admin);
    await page.goto(`/checks?cs=${revision.id}`);
    await expect(page.getByRole('row').nth(2)).toBeVisible();
    await save('checks-blocking');
  });
});
