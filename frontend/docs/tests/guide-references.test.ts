import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePermissions } from '../scripts/lib/catalogues.mjs';
import {
  keyCaps,
  parseRoles,
  parseShortcuts,
  renderRoles,
  renderShortcuts,
} from '../scripts/lib/guide-references.mjs';

const repo = (path: string) =>
  readFileSync(join(import.meta.dirname, '../../..', path), 'utf8');

const translations = {
  en: {
    shortcuts: {
      areas: { anywhere: 'Anywhere', text: 'Writing text' },
      keys: { ctrl: 'Ctrl', shift: 'Shift', enter: 'Enter' },
      palette: 'Open the palette',
      bold: 'Bold',
    },
  },
  de: {
    shortcuts: {
      areas: { anywhere: 'Überall', text: 'Text schreiben' },
      keys: { ctrl: 'Strg', shift: 'Umschalt', enter: 'Eingabe' },
      palette: 'Palette öffnen',
    },
  },
};

const catalogue = (entries: string) => `
  export const SHORTCUT_AREAS = {
    anywhere: 'editor.shortcuts.areas.anywhere',
    text: 'editor.shortcuts.areas.text',
  };
  export const SHORTCUTS = {
    ${entries}
  } as const satisfies Record<string, Shortcut>;
`;

describe('the shortcut reference', () => {
  it('names keys per platform and language, modifiers in their order', () => {
    // The editor's own key names (its overlay uses the same function, `key-caps.ts`).
    expect(keyCaps('Shift-Mod-z', 'en', 'pc', translations)).toEqual([
      'Ctrl',
      'Shift',
      'Z',
    ]);
    expect(keyCaps('Shift-Mod-z', 'en', 'mac', translations)).toEqual([
      '⇧',
      '⌘',
      'Z',
    ]);
    expect(keyCaps('Mod-Shift-Enter', 'de', 'pc', translations)).toEqual([
      'Strg',
      'Umschalt',
      'Eingabe',
    ]);
    expect(keyCaps('Mod-,', 'en', 'pc', translations)).toEqual(['Ctrl', ',']);
    expect(keyCaps('/', 'de', 'mac', translations)).toEqual(['/']);
    expect(keyCaps('Mod-PageDown', 'en', 'pc', translations)).toBeUndefined();
    expect(keyCaps('Hyper-k', 'en', 'pc', translations)).toBeUndefined();
    expect(keyCaps('?', 'en', 'pc', translations)).toEqual(['?']);
    // A key whose name has no text in the language.
    expect(keyCaps('Tab', 'en', 'pc', translations)).toBeUndefined();
  });

  it('reads the catalogue with its texts, and lists each area’s shortcuts', () => {
    const parsed = parseShortcuts(
      catalogue(`
        palette: { keys: ['Mod-k'], area: 'anywhere', label: 'editor.shortcuts.palette' },
      `),
      translations,
    );
    expect(parsed.problems).toEqual([]);
    const en = renderShortcuts(parsed, 'en');
    expect(en).toContain('articleId: "guide.reference.shortcuts"');
    expect(en).toContain(
      '| <kbd>Ctrl</kbd> <kbd>K</kbd> | <kbd>⌘</kbd> <kbd>K</kbd> | Open the palette |',
    );
    // An area without shortcuts has no section.
    expect(en).not.toContain('## Writing text');
    expect(renderShortcuts(parsed, 'de')).toContain('## Überall');
  });

  it('refuses a shortcut without a text in a language, a key it cannot name, an unknown area', () => {
    const { problems } = parseShortcuts(
      catalogue(`
        bold: { keys: ['Mod-b'], area: 'text', label: 'editor.shortcuts.bold' },
        odd: { keys: ['Hyper-x'], area: 'elsewhere', label: 'editor.shortcuts.palette' },
      `),
      translations,
    );
    expect(problems).toEqual([
      'shortcuts.ts: bold has no de text (editor.shortcuts.bold)',
      'shortcuts.ts: odd: the reference cannot name the key "Hyper-x"',
      'shortcuts.ts: odd is in an unknown area "elsewhere"',
    ]);
  });

  it('refuses a catalogue it cannot read as literals', () => {
    expect(
      parseShortcuts('export const SHORTCUTS = make();', translations).problems,
    ).toEqual(['shortcuts.ts: no SHORTCUTS catalogue of plain literals found']);
  });

  it('reads the editor’s own catalogue with every text in English and German', () => {
    const parsed = parseShortcuts(
      repo('frontend/editor/src/app/shortcuts/shortcuts.ts'),
      {
        en: JSON.parse(repo('frontend/editor/src/i18n/en.json')),
        de: JSON.parse(repo('frontend/editor/src/i18n/de.json')),
      },
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.shortcuts.map((s) => s.id)).toContain('palette');
  });
});

describe('the roles reference', () => {
  const permissions = [
    {
      name: 'content.read',
      description: 'Read released content.',
      text: {
        en: 'Read released content in scope',
        de: 'Freigegebene Inhalte lesen',
      },
      global: false,
      read: true,
    },
    {
      name: 'admin.roles',
      description: 'Define roles.',
      text: { en: 'Create roles, assign people', de: 'Rollen anlegen' },
      global: true,
      read: false,
    },
  ];

  it('reads the roles, a spread of PERMISSIONS as every permission', () => {
    const { roles, problems } = parseRoles(
      `export const exampleSeed = {
        roles: [
          { id: 'reader', name: 'Reader', permissions: ['content.read'], scope: { maxAudience: 'public' } },
          { id: 'admin', name: 'Admin', permissions: [...PERMISSIONS], scope: {} },
        ],
        users: [],
      };`,
      permissions,
    );
    expect(problems).toEqual([]);
    expect(roles.map((r) => [r.id, r.all])).toEqual([
      ['reader', false],
      ['admin', true],
    ]);
    const en = renderRoles(roles, permissions, 'en');
    expect(en).toContain('| Permission | Reader | Admin |');
    expect(en).toContain('| [`admin.roles`](#adminroles) (global) |  | ✓ |');
    expect(en).toContain(
      '| **Reader** (`reader`) | `content.read` | audiences up to public |',
    );
    expect(en).toContain('### admin.roles\n\nCreate roles, assign people\n');
    const de = renderRoles(roles, permissions, 'de');
    expect(de).toContain(
      '| **Admin** (`admin`) | alle Berechtigungen, auch spätere | alle Inhalte |',
    );
    expect(de).toContain('### content.read\n\nFreigegebene Inhalte lesen\n');
    expect(de).not.toContain('englisch');
  });

  it('refuses a role holding a permission that does not exist, or a scope it cannot describe', () => {
    const { problems } = parseRoles(
      `export const exampleSeed = { roles: [
        { id: 'odd', name: 'Odd', permissions: ['content.fly'], scope: { planets: ['mars'] } },
      ] };`,
      permissions,
    );
    expect(problems).toEqual([
      'example-seed.ts: role odd holds "content.fly", which is no permission',
      'example-seed.ts: role odd has a scope "planets" the reference cannot describe',
    ]);
  });

  it('reads the API’s own example roles against its permissions', () => {
    const { permissions: all } = parsePermissions(repo);
    const { roles, problems } = parseRoles(
      repo('backend/api/src/access/repos/example-seed.ts'),
      all,
    );
    expect(problems).toEqual([]);
    expect(roles.find((r) => r.id === 'admin')?.all).toBe(true);
  });
});
