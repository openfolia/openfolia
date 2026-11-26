// The user guide's generated references (#447): the keyboard shortcuts, from the editor's
// shortcut catalogue (`frontend/editor/src/app/shortcuts/shortcuts.ts`) and its English and
// German texts, and the roles, from the example roles the API ships
// (`backend/api/src/access/repos/example-seed.ts`) and the permissions catalogue. Each parser
// reads the source as TypeScript (never runs it) and returns the problems that fail the build:
// a shortcut without a text in a language, a key the reference cannot name, a role holding a
// permission that does not exist.
import ts from 'typescript';
import { GUIDE_REFERENCE_PAGES } from './guide-reference-pages.mjs';
import { keyCaps as editorKeyCaps } from '../../../editor/src/app/shortcuts/key-caps.ts';
import {
  anchor,
  cell,
  code,
  frontMatter,
  GENERATED_NOTE,
  kbd,
  table,
} from './markdown.mjs';

/** A code span inside a table cell: a pipe would end the cell even there. */
const cellCode = (text) => code(text).replace(/\|/g, '\\|');

/** The user guide's languages, English first. */
export const GUIDE_LANGUAGES = ['en', 'de'];

/** A literal's value: strings, arrays, objects and `as`/`satisfies` around them; else `undefined`. */
function literal(node, spreads = {}) {
  while (node && (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)))
    node = node.expression;
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isArrayLiteralExpression(node)) {
    const out = [];
    for (const element of node.elements) {
      if (ts.isSpreadElement(element) && ts.isIdentifier(element.expression)) {
        const spread = spreads[element.expression.text];
        if (spread === undefined) return undefined;
        out.push(...spread);
      } else {
        const value = literal(element, spreads);
        if (value === undefined) return undefined;
        out.push(value);
      }
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return undefined;
      const name =
        ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text
          : undefined;
      const value = literal(property.initializer, spreads);
      if (name === undefined || value === undefined) return undefined;
      out[name] = value;
    }
    return out;
  }
  return undefined;
}

/** The top-level `const` initialisers of a TypeScript source, by name. */
function constants(sourceText, fileName) {
  const file = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const found = {};
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations)
      if (ts.isIdentifier(declaration.name) && declaration.initializer)
        found[declaration.name.text] = declaration.initializer;
  }
  return found;
}

// --- Shortcuts -----------------------------------------------------------------------------------

/**
 * The key caps of `keys` in `lang` on `platform` (`pc` or `mac`), or `undefined` for a key it
 * cannot name: the editor's own `keyCaps` (`shortcuts/key-caps.ts`, which its overlay uses too),
 * with the keys' names from the editor's translations (`translations[lang]`, its JSON file).
 */
export function keyCaps(keys, lang, platform, translations) {
  return editorKeyCaps(keys, platform, (key) =>
    translationText(translations[lang], key),
  );
}

/** A whole translation key's text (`editor.shortcuts.undo`) in one language's JSON, if any. */
function translationText(messages, key) {
  const value = String(key)
    .replace(/^editor\./, '')
    .split('.')
    .reduce(
      (node, part) =>
        node && typeof node === 'object' ? node[part] : undefined,
      messages,
    );
  return typeof value === 'string' ? value : undefined;
}

/**
 * The shortcut catalogue (`SHORTCUTS` and `SHORTCUT_AREAS` of `shortcuts.ts`) with each one's
 * text per language from the editor's translations (`{ en, de }`, the JSON files). Problems: the
 * catalogue missing, an entry the reference cannot read, a key it cannot name, a text missing.
 */
export function parseShortcuts(sourceText, translations) {
  const found = constants(sourceText, 'shortcuts.ts');
  const problems = [];
  const catalogue = literal(found.SHORTCUTS);
  const areaKeys = literal(found.SHORTCUT_AREAS);
  if (
    !catalogue ||
    typeof catalogue !== 'object' ||
    Object.keys(catalogue).length === 0
  )
    return {
      shortcuts: [],
      areas: [],
      translations: {},
      problems: [
        'shortcuts.ts: no SHORTCUTS catalogue of plain literals found',
      ],
    };
  if (!areaKeys || typeof areaKeys !== 'object')
    return {
      shortcuts: [],
      areas: [],
      translations: {},
      problems: ['shortcuts.ts: no SHORTCUT_AREAS of plain literals found'],
    };
  const text = (key, lang) => translationText(translations[lang], key);
  const texts = (key, where) => {
    const out = {};
    for (const lang of GUIDE_LANGUAGES) {
      out[lang] = text(key, lang);
      if (out[lang] === undefined)
        problems.push(`shortcuts.ts: ${where} has no ${lang} text (${key})`);
    }
    return out;
  };
  const areas = Object.entries(areaKeys).map(([id, key]) => ({
    id,
    title: texts(key, `area ${id}`),
  }));
  const shortcuts = [];
  for (const [id, entry] of Object.entries(catalogue)) {
    const keys = entry?.keys;
    if (
      !Array.isArray(keys) ||
      keys.length === 0 ||
      keys.some((k) => typeof k !== 'string')
    ) {
      problems.push(`shortcuts.ts: ${id} has no keys`);
      continue;
    }
    for (const k of keys)
      if (
        GUIDE_LANGUAGES.some((lang) =>
          ['pc', 'mac'].some(
            (platform) => !keyCaps(k, lang, platform, translations),
          ),
        )
      )
        problems.push(
          `shortcuts.ts: ${id}: the reference cannot name the key "${k}"`,
        );
    if (!areas.some((a) => a.id === entry.area))
      problems.push(
        `shortcuts.ts: ${id} is in an unknown area "${entry.area}"`,
      );
    shortcuts.push({
      id,
      keys,
      area: entry.area,
      label: texts(entry.label, id),
    });
  }
  return { shortcuts, areas, translations, problems };
}

const SHORTCUT_PAGE = {
  en: {
    ...GUIDE_REFERENCE_PAGES.shortcuts.en,
    intro: [
      'Every keyboard shortcut of the editor. The list is made from the editor’s own shortcut definitions when the documentation is built, so it matches the release it belongs to.',
      '',
      'On a Mac, ⌘ is the Command key, ⌥ the Option key and ⇧ the Shift key.',
    ],
    pc: 'Windows and Linux',
    mac: 'macOS',
    does: 'What it does',
    or: ' or ',
  },
  de: {
    ...GUIDE_REFERENCE_PAGES.shortcuts.de,
    intro: [
      'Alle Tastenkürzel des Editors. Die Liste entsteht beim Bauen der Dokumentation aus den Tastenkürzeln des Editors selbst und passt deshalb immer zur jeweiligen Version.',
      '',
      'Auf einem Mac ist ⌘ die Befehlstaste, ⌥ die Wahltaste und ⇧ die Umschalttaste.',
    ],
    pc: 'Windows und Linux',
    mac: 'macOS',
    does: 'Wirkung',
    or: ' oder ',
  },
};

/** The shortcut reference page in `lang` (front matter included). */
export function renderShortcuts({ shortcuts, areas, translations }, lang) {
  const t = SHORTCUT_PAGE[lang];
  const caps = (keys, platform) =>
    keys
      .map((k) =>
        (keyCaps(k, lang, platform, translations) ?? [k]).map(kbd).join(' '),
      )
      .join(t.or);
  const out = [
    frontMatter({
      title: t.title,
      description: t.description,
      articleId: GUIDE_REFERENCE_PAGES.shortcuts.articleId,
    }),
    GENERATED_NOTE,
    '',
    ...t.intro,
    '',
  ];
  for (const area of areas) {
    const rows = shortcuts.filter((s) => s.area === area.id);
    if (rows.length === 0) continue;
    out.push(
      `## ${cell(area.title[lang])}`,
      '',
      table(
        [t.pc, t.mac, t.does],
        rows.map((s) => [
          caps(s.keys, 'pc'),
          caps(s.keys, 'mac'),
          cell(s.label[lang]),
        ]),
      ),
      '',
    );
  }
  return out.join('\n');
}

// --- Permissions' texts ---------------------------------------------------------------------------

/**
 * The permissions (`parsePermissions`) with their texts per language (`text: { en, de }`), by the
 * text key each registers (`labelKey`), from the editor's translations (`{ en, de }`, its JSON
 * files), which name them on Admin › Roles. Problems: a permission without a text in a language.
 */
export function withPermissionTexts(permissions, translations) {
  const problems = [];
  const out = permissions.map((p) => {
    const key = p.labelKey;
    const text = {};
    for (const lang of GUIDE_LANGUAGES) {
      text[lang] = translationText(translations[lang], key);
      if (text[lang] === undefined)
        problems.push(
          `the editor's ${lang}.json has no text for the permission ${p.name} (${key})`,
        );
    }
    return { ...p, text };
  });
  return { permissions: out, problems };
}

// --- Roles ---------------------------------------------------------------------------------------

/** A role's scope dimensions (`Scope` of `backend/api/src/access/core/actor.ts`). */
const SCOPE_KEYS = ['languages', 'moduleTypes', 'maxAudience', 'facets'];

/**
 * The example roles (`exampleSeed.roles` of `example-seed.ts`; `...PERMISSIONS` stands for every
 * permission), checked against the permissions catalogue (`permissions`, from `parsePermissions`).
 */
export function parseRoles(sourceText, permissions) {
  const names = permissions.map((p) => p.name);
  const found = constants(sourceText, 'example-seed.ts');
  const seed = literal(found.exampleSeed, { PERMISSIONS: names });
  const problems = [];
  if (!seed || !Array.isArray(seed.roles) || seed.roles.length === 0)
    return {
      roles: [],
      problems: [
        'example-seed.ts: no exampleSeed.roles of plain literals found',
      ],
    };
  const roles = [];
  for (const role of seed.roles) {
    const where = `example-seed.ts: role ${role?.id ?? '?'}`;
    if (typeof role?.id !== 'string' || typeof role.name !== 'string') {
      problems.push(`${where} needs an id and a name`);
      continue;
    }
    const held = Array.isArray(role.permissions) ? role.permissions : [];
    for (const p of held)
      if (!names.includes(p))
        problems.push(`${where} holds "${p}", which is no permission`);
    for (const key of Object.keys(role.scope ?? {}))
      if (!SCOPE_KEYS.includes(key))
        problems.push(
          `${where} has a scope "${key}" the reference cannot describe`,
        );
    roles.push({
      id: role.id,
      name: role.name,
      permissions: held,
      all: names.every((n) => held.includes(n)),
      scope: role.scope ?? {},
    });
  }
  return { roles, problems };
}

const ROLE_PAGE = {
  en: {
    ...GUIDE_REFERENCE_PAGES.roles.en,
    intro: [
      'A role is a set of permissions with a scope: the content it applies to. An admin sets up the roles of an installation and gives them to people (Admin › Roles, Admin › Users). The roles below are the examples the product ships, which the demo users hold. Your installation may have other roles.',
      '',
      'This page is made from the API’s permissions catalogue, the editor’s texts for them and the example roles when the documentation is built. The roles’ names are as an installation stores them. The [permissions reference](/reference/permissions) lists the API routes each permission opens.',
    ],
    matrix: 'Which role holds which permission',
    permission: 'Permission',
    allows: 'What it allows',
    roles: 'The example roles',
    holds: 'Holds',
    everything: 'every permission, including ones added later',
    scope: 'Scope',
    anywhere: 'all content',
    scopeNames: {
      languages: 'languages',
      moduleTypes: 'module types',
      maxAudience: 'audiences up to',
      facets: 'facet values',
    },
    yes: '✓',
    global:
      'A global permission is about the installation, not about content: a role’s scope does not limit it.',
    globalMark: ' (global)',
  },
  de: {
    ...GUIDE_REFERENCE_PAGES.roles.de,
    intro: [
      'Eine Rolle bündelt Berechtigungen mit einem Geltungsbereich: den Inhalten, für die sie gilt. Ein Admin legt die Rollen einer Installation an und weist sie Personen zu (Verwaltung › Rollen, Verwaltung › Benutzer). Die Rollen unten sind die Beispiele, die das Produkt mitbringt und die die Demo-Benutzer haben. Ihre Installation kann andere Rollen haben.',
      '',
      'Diese Seite entsteht beim Bauen der Dokumentation aus dem Berechtigungskatalog der API, den Texten des Editors dazu und den Beispielrollen. Die Namen der Rollen stehen so da, wie eine Installation sie speichert. Die [Berechtigungsreferenz](/de/reference/permissions) nennt die API-Routen jeder Berechtigung.',
    ],
    matrix: 'Welche Rolle welche Berechtigung hat',
    permission: 'Berechtigung',
    allows: 'Was sie erlaubt',
    roles: 'Die Beispielrollen',
    holds: 'Hat',
    everything: 'alle Berechtigungen, auch spätere',
    scope: 'Geltungsbereich',
    anywhere: 'alle Inhalte',
    scopeNames: {
      languages: 'Sprachen',
      moduleTypes: 'Modultypen',
      maxAudience: 'Zielgruppen bis',
      facets: 'Facettenwerte',
    },
    yes: '✓',
    global:
      'Eine globale Berechtigung betrifft die Installation, nicht Inhalte: der Geltungsbereich einer Rolle schränkt sie nicht ein.',
    globalMark: ' (global)',
  },
};

function scopeText(scope, t) {
  const parts = [];
  for (const key of SCOPE_KEYS) {
    const value = scope[key];
    if (value === undefined) continue;
    const shown =
      key === 'facets'
        ? Object.entries(value)
            .map(([facet, values]) => `${facet}: ${[values].flat().join(', ')}`)
            .join('; ')
        : [value].flat().join(', ');
    parts.push(`${t.scopeNames[key]} ${shown}`);
  }
  return parts.length === 0 ? t.anywhere : parts.join('; ');
}

/**
 * The roles reference page in `lang` (front matter included), the permissions with their texts
 * (`withPermissionTexts`).
 */
export function renderRoles(roles, permissions, lang) {
  const t = ROLE_PAGE[lang];
  const out = [
    frontMatter({
      title: t.title,
      description: t.description,
      articleId: GUIDE_REFERENCE_PAGES.roles.articleId,
    }),
    GENERATED_NOTE,
    '',
    ...t.intro,
    '',
    `## ${t.matrix}`,
    '',
    table(
      [t.permission, ...roles.map((r) => cell(r.name))],
      permissions.map((p) => [
        `[${cellCode(p.name)}](#${anchor(p.name)})${p.global ? t.globalMark : ''}`,
        ...roles.map((r) => (r.permissions.includes(p.name) ? t.yes : '')),
      ]),
    ),
    '',
    t.global,
    '',
    `## ${t.roles}`,
    '',
    table(
      ['', t.holds, t.scope],
      roles.map((r) => [
        `**${cell(r.name)}** (${cellCode(r.id)})`,
        r.all ? t.everything : r.permissions.map((p) => cellCode(p)).join(', '),
        cell(scopeText(r.scope, t)),
      ]),
    ),
    '',
    `## ${t.allows}`,
    '',
  ];
  for (const p of permissions)
    out.push(`### ${cell(p.name)}`, '', cell(p.text[lang]), '');
  return out.join('\n');
}
