import type { Page } from '@playwright/test';
import { moduleId, paragraph, unique } from '../src/api.ts';
import { expect, signIn, test, USERS } from '../src/fixtures.ts';

/** The texts a flow reads, in the UI language it runs in. */
const TEXTS = {
  en: {
    locked: 'Locked by you',
    module: (title: string) => `Module ${title}`,
    snippetCommand: /Snippet/,
    snippetTitle: 'Insert snippet',
    moduleTitle: 'Insert module reference',
    insert: 'Insert',
    variantCommand: /Variant block/,
    unfinishedVariant: 'Choose the variants this block is for',
  },
  de: {
    locked: 'Von Ihnen gesperrt',
    module: (title: string) => `Modul ${title}`,
    snippetCommand: /Textbaustein/,
    snippetTitle: 'Textbaustein einfügen',
    moduleTitle: 'Modulverweis einfügen',
    insert: 'Einfügen',
    variantCommand: /Variantenblock/,
    unfinishedVariant: 'Wählen Sie die Varianten',
  },
} as const;

interface Frame {
  title: string;
  /** The panel's layout height (its transform, the leave transition's scale, left out). */
  height: number;
  /** Its computed transform: `none` under reduced motion. */
  transform: string;
}

/**
 * Records, every animation frame from now until the dialog is gone, the title and layout height
 * the open dialog shows; `frames()` gives them.
 */
async function recordDialog(page: Page): Promise<() => Promise<Frame[]>> {
  await page.evaluate(() => {
    const seen: { title: string; height: number; transform: string }[] = [];
    (window as unknown as { __frames: typeof seen }).__frames = seen;
    const tick = () => {
      const panel = document.querySelector<HTMLElement>('z-dialog-panel');
      if (!panel) return;
      seen.push({
        title: panel.querySelector('z-dialog-title')?.textContent?.trim() ?? '',
        height: panel.offsetHeight,
        transform: getComputedStyle(panel).transform,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return () =>
    page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames);
}

// The snippet picker closes as it opened (#796): never another dialog's title or size on the way
// out; and a new variant block reads as a calm draft, never as an error. A module of its own,
// in a revision of its own, in English and light, and in German and dark with reduced motion.
test.describe('picker and draft blocks @area:module-editor @area:doc-editor @api:modules @api:search @api:change-sets @api:preview', () => {
  for (const [lang, theme] of [
    ['en', 'light'],
    ['de', 'dark'],
  ] as const) {
    test(`the snippet picker closes as it was, and a new variant block is a calm draft (${lang}, ${theme})`, async ({
      page,
      api,
    }) => {
      const t = TEXTS[lang];
      const reduced = lang === 'de';
      if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
      const author = await api(USERS.author);
      const changeSet = await author.createChangeSet(unique('Picker'));
      const id = moduleId();
      const title = 'Battery terminals';
      await author.createModule(changeSet, {
        lang: 'en',
        moduleId: id,
        title,
        blocks: [paragraph('p1', 'Clean the terminals.')],
      });
      await page.addInitScript(
        ({ language, scheme }) => {
          localStorage.setItem('of-language', language);
          localStorage.setItem('of-theme', scheme);
        },
        { language: lang, scheme: theme },
      );
      await signIn(page, USERS.author);
      await page.goto(`/content/en/${id}?cs=${changeSet.id}`);
      await expect(page.getByText(t.locked)).toBeVisible();
      await expect(page.locator('html')).toHaveClass(
        theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/,
      );
      const editor = page.getByRole('textbox', { name: t.module(title) });

      // Insert › Snippet, from a new line after the text.
      await editor.getByText('Clean the terminals.').click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type(lang === 'en' ? '/snippet' : '/textb');
      await page.getByRole('option', { name: t.snippetCommand }).click();
      const dialog = page.getByRole('dialog', { name: t.snippetTitle });
      const row = dialog.locator('button[data-picker-row]');
      await dialog.getByRole('searchbox').fill('gloves');
      await expect(row).toHaveCount(1);
      await row.click();
      await expect(row).toHaveAttribute('aria-pressed', 'true');
      // Settled after its opening transition.
      await page.waitForTimeout(300);

      const frames = await recordDialog(page);
      await dialog.getByRole('button', { name: t.insert, exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(page.locator('z-dialog-panel')).toHaveCount(0);
      const seen = await frames();
      // Every frame of its leave transition: its own title, its own size.
      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen.map((f) => f.title))).toEqual(
        new Set([t.snippetTitle]),
      );
      expect(seen.map((f) => f.title)).not.toContain(t.moduleTitle);
      expect(new Set(seen.map((f) => f.height)).size).toBe(1);
      // Reduced motion: it fades where it stands, never shrinking.
      if (reduced) {
        expect(new Set(seen.map((f) => f.transform))).toEqual(
          new Set(['none']),
        );
      }
      // The module is English: the snippet in its language.
      await expect(editor.locator('of-module-ref-node')).toContainText(
        'Wear gloves',
      );

      // A new variant block, its variants not chosen yet: a calm draft.
      await editor.getByText('Clean the terminals.').click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('/varian');
      await page.getByRole('option', { name: t.variantCommand }).click();
      const variant = editor.locator('[data-node="variant"]');
      await expect(variant).toHaveCount(1);
      await page.keyboard.type('Small ones charge faster');
      const marked = editor.locator('[data-issue]');
      await expect(marked).toHaveCount(1);
      await expect(marked).toHaveAttribute(
        'data-issue',
        new RegExp(`^${t.unfinishedVariant}`),
      );
      await expect(marked).toHaveClass(/doc-editor-issue-draft/);
      await expect(marked).not.toHaveClass(/doc-editor-issue-error/);
      const outline = page.locator('of-module-outline');
      await expect(outline.locator('[data-problem="draft"]')).toHaveCount(1);
      await expect(outline.locator('.text-destructive')).toHaveCount(0);
    });
  }

  test('the live preview names a module a cross-reference links to by its title, not its ID', async ({
    page,
    api,
  }) => {
    const author = await api(USERS.author);
    const changeSet = await author.createChangeSet(unique('Xref'));
    const id = moduleId();
    await author.createModule(changeSet, {
      lang: 'en',
      moduleId: id,
      title: 'Before charging',
      blocks: [
        {
          type: 'paragraph',
          id: 'p1',
          content: [
            { type: 'text', text: 'Read ' },
            { type: 'xref', module: 'charging' },
            { type: 'text', text: ' first.' },
          ],
        },
      ],
    });
    await signIn(page, USERS.author);
    await page.goto(`/content/en/${id}?cs=${changeSet.id}&preview=open`);
    const preview = page
      .locator('of-preview-frame:not(.opacity-0) iframe')
      .contentFrame();
    await expect(preview.locator('.of-xref')).toHaveText('Charging');
  });
});
