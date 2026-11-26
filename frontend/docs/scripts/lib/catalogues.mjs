// The generated reference pages' bodies: error codes, permissions, MCP tools, the project
// configuration and the import format. Each takes what the generator read from the repository and
// returns MDX (front matter is added by the generator).
import { posix } from 'node:path';
import ts from 'typescript';
import { anchor, breakableCode, cell, code, mdx, table } from './markdown.mjs';
import { fieldsTable, fields } from './json-schema.mjs';
import { operations } from './openapi.mjs';
import { ENGLISH_END, ENGLISH_START } from './german-check.mjs';

const statusText = (status) =>
  status === undefined ? '—' : [status].flat().join(', ');

const ERROR_PAGE = {
  en: {
    intro:
      'Every error answer is a JSON:API error document, `{ errors: [{ status, title, detail, code, source?, meta? }] }`, on every route, binary ones included. `code` is stable: switch on it, never on `detail`, which is written for people and may change.',
    count: (n) =>
      `${n} codes. A code marked "—" is not an HTTP answer: it is reported elsewhere (a job's or an output's error, a warning in a report), as its description says.`,
    columns: ['Code', 'Status', 'When'],
    byStatus: '## By status',
    statusColumns: ['Status', 'Codes'],
  },
  de: {
    intro:
      'Jede Fehlerantwort ist ein JSON:API-Fehlerdokument, `{ errors: [{ status, title, detail, code, source?, meta? }] }`, auf jeder Route, auch den binären. `code` bleibt gleich: Werten Sie ihn aus, nie `detail`, das für Menschen geschrieben ist und sich ändern kann. `title` und `detail` schreibt die API auf Englisch; die Meldungen hier zeigt der Editor zu jedem Code, „…“ steht für einen Wert, den er einsetzt.',
    count: (n) =>
      `${n} Codes. Ein Code mit „—“ ist keine HTTP-Antwort: Er wird anderswo gemeldet, als Fehler eines Auftrags oder einer Ausgabe oder als Warnung in einem Bericht.`,
    columns: ['Code', 'Status', 'Meldung'],
    english: '## Codes nur für API-Clients',
    englishText: (n) =>
      `Diese ${n} Codes trifft keine Seite des Editors, nur Programme, die die API selbst aufrufen. Der Editor hat für sie keine Meldung, darum stehen ihre Beschreibungen hier auf Englisch, wie auf der [englischen Seite](/reference/errors).`,
    englishColumns: ['Code', 'Status', 'Beschreibung (Englisch)'],
    byStatus: '## Nach Status',
    statusColumns: ['Status', 'Codes'],
  },
};

/**
 * The error code reference, from `backend/api/error-codes.yaml`, in `lang`. The German page takes
 * each code's text from `german` (`germanErrorTexts`, the editor's German messages) and lists the
 * codes it has none for (`german.english`, those no editor screen meets) with their English
 * description in an English section (`ENGLISH_START`).
 */
export function renderErrorCodes(catalogue, lang = 'en', german) {
  const t = ERROR_PAGE[lang];
  const entries = Object.entries(catalogue).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const byStatus = new Map();
  for (const [codeName, entry] of entries)
    for (const s of entry.status === undefined
      ? ['other']
      : [entry.status].flat())
      byStatus.set(s, [...(byStatus.get(s) ?? []), codeName]);
  const english = new Set(lang === 'en' ? [] : (german?.english ?? []));
  const text = (codeName, entry) =>
    lang === 'en' ? entry.when : german?.texts.get(codeName);
  const row = (codeName, entry, value) => [
    breakableCode(codeName),
    statusText(entry.status),
    cell(value),
  ];
  return [
    t.intro,
    '',
    t.count(entries.length),
    '',
    table(
      t.columns,
      entries
        .filter(([codeName]) => !english.has(codeName))
        .map(([codeName, entry]) =>
          row(codeName, entry, text(codeName, entry)),
        ),
    ),
    '',
    ...(english.size === 0
      ? []
      : [
          t.english,
          '',
          t.englishText(english.size),
          '',
          ENGLISH_START,
          '',
          table(
            t.englishColumns,
            entries
              .filter(([codeName]) => english.has(codeName))
              .map(([codeName, entry]) => row(codeName, entry, entry.when)),
          ),
          '',
          ENGLISH_END,
          '',
        ]),
    t.byStatus,
    '',
    table(
      t.statusColumns,
      [...byStatus]
        .sort(([a], [b]) => String(a).localeCompare(String(b)))
        .map(([status, codes]) => [
          status === 'other' ? '—' : String(status),
          codes.map((c) => code(c)).join(', '),
        ]),
    ),
    '',
  ].join('\n');
}

/** Where the API registers every component's permissions, in their order. */
export const PERMISSION_REGISTRY = 'backend/api/src/permissions.ts';

const nodesOf = (file, test) => {
  const found = [];
  const visit = (node) => {
    if (test(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
};

const callOf = (name) => (node) =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === name;

/** A file's top-level `export const <name> = <callee>(...)` declarations, never nested ones. */
const exportedCalls = (file, callee) =>
  file.statements
    .filter(
      (s) =>
        ts.isVariableStatement(s) &&
        s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
        (s.declarationList.flags & ts.NodeFlags.Const) !== 0,
    )
    .flatMap((s) => s.declarationList.declarations)
    .filter(
      (d) =>
        ts.isIdentifier(d.name) &&
        !!d.initializer &&
        callOf(callee)(d.initializer),
    )
    .map((d) => ({ name: d.name.text, call: d.initializer }));

const TEXT_MEMBERS = new Set(['key', 'labelKey', 'description']);
const FLAG_MEMBERS = new Set(['global', 'read']);

/**
 * An object literal's members (`{ key: 'a', global: true }`): the texts as string literals, the
 * flags as `true` (as `registerPermissions` holds them). Anything else (another member, a spread, a computed or quoted name,
 * a value the reference cannot read) is in `odd`, so the build fails instead of documenting a
 * permission otherwise than the API enforces it.
 */
function literalMembers(node) {
  const members = {};
  const odd = [];
  for (const p of node.properties) {
    const name =
      ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) ? p.name.text : '';
    const v = name ? p.initializer : undefined;
    if (TEXT_MEMBERS.has(name) && ts.isStringLiteralLike(v))
      members[name] = v.text;
    else if (FLAG_MEMBERS.has(name) && v.kind === ts.SyntaxKind.TrueKeyword)
      members[name] = true;
    else odd.push(p.getText());
  }
  return { members, odd };
}

/**
 * The permissions the API registers, in their order: the groups `registerPermissions([...])`
 * lists in `PERMISSION_REGISTRY`, each read from the component's file it is imported from (its
 * `definePermissions(group, [...])`), with each permission's text key and description and which
 * are global and which only read. `read(path)` gives a repository file's text.
 */
export function parsePermissions(read, registry = PERMISSION_REGISTRY) {
  const parse = (path) =>
    ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
  const root = parse(registry);
  const from = new Map();
  for (const node of nodesOf(root, ts.isImportDeclaration)) {
    const named = node.importClause?.namedBindings;
    if (
      named &&
      ts.isNamedImports(named) &&
      node.moduleSpecifier.text.startsWith('.')
    )
      for (const element of named.elements)
        from.set(
          element.name.text,
          posix.join(
            posix.dirname(registry),
            node.moduleSpecifier.text.replace(/\.js$/, '.ts'),
          ),
        );
  }
  // Exactly one call, the file's `export const … = registerPermissions([...])`: a second one,
  // nested or not, could be documented instead of what the API registers.
  const exported = exportedCalls(root, 'registerPermissions');
  const listed =
    exported.length === 1 &&
    exported[0].name === 'REGISTERED_PERMISSIONS' &&
    nodesOf(root, callOf('registerPermissions')).length === 1
      ? exported[0].call.arguments[0]
      : undefined;
  if (!listed || !ts.isArrayLiteralExpression(listed))
    return {
      permissions: [],
      problems: [
        `${registry}: needs exactly one registerPermissions([...]), as export const REGISTERED_PERMISSIONS (what the API reads)`,
      ],
    };
  const permissions = [];
  const problems = [];
  for (const element of listed.elements) {
    const name = ts.isIdentifier(element) ? element.text : '';
    const path = from.get(name);
    const defined = path
      ? exportedCalls(parse(path), 'definePermissions').find(
          (d) => d.name === name,
        )?.call.arguments[1]
      : undefined;
    if (!defined || !ts.isArrayLiteralExpression(defined)) {
      problems.push(
        `${registry}: ${name || element.getText()} is no definePermissions(group, [...]) imported from a file`,
      );
      continue;
    }
    for (const entry of defined.elements) {
      const { members: m, odd } = ts.isObjectLiteralExpression(entry)
        ? literalMembers(entry)
        : { members: {}, odd: [] };
      const permission = {
        name: m.key ?? '',
        labelKey: m.labelKey ?? '',
        description: m.description ?? '',
        global: m.global === true,
        read: m.read === true,
      };
      if (!permission.name || !permission.labelKey || !permission.description)
        problems.push(
          `${path}: ${permission.name || entry.getText()} needs a key, a labelKey and a description, each a string`,
        );
      for (const member of odd)
        problems.push(
          `${path}: ${permission.name || entry.getText()} has ${member}, which the reference cannot read (texts are string literals, global and read only true)`,
        );
      permissions.push(permission);
    }
  }
  return { permissions, problems };
}

const PERMISSION_PAGE = {
  en: {
    intro: [
      "A role bundles permissions with a scope (the content it applies to); a person or a service account holds roles. Every route checks one permission before it reads or changes anything: an actor holding no role with it is refused with 403 `forbidden`. A read of content outside the actor's scope answers 404 `not-found`, as for content that does not exist.",
      '',
      "- **Global** permissions are about the system, not about content: a role's scope does not apply to them.",
      '- **Read** permissions only read: a scope admits a read of a module shared with content outside it.',
    ],
    columns: ['Permission', 'What it allows', 'Kind', 'Routes'],
    global: 'global',
    scoped: 'scoped',
    read: 'read',
    none: 'No route needs it on its own.',
    route: 'Route',
    does: 'What it does',
    open: '## Routes without a permission',
    openText:
      'Public routes (the health check, the licence, the API reference) and routes any signed-in actor may call (for example `GET /me`). A route that reads content needs `content.read` through the ref it opens, whatever else it needs.',
  },
  de: {
    intro: [
      'Eine Rolle bündelt Berechtigungen mit einem Geltungsbereich (den Inhalten, für die sie gilt); Personen und Dienstkonten haben Rollen. Jede Route prüft eine Berechtigung, bevor sie etwas liest oder ändert: Wer keine Rolle mit ihr hat, bekommt 403 `forbidden`. Ein Lesezugriff auf Inhalte außerhalb des eigenen Geltungsbereichs wird mit 404 `not-found` beantwortet, wie für Inhalte, die es nicht gibt.',
      '',
      '- **Globale** Berechtigungen betreffen das System, nicht Inhalte: Der Geltungsbereich einer Rolle gilt für sie nicht.',
      '- **Lesende** Berechtigungen lesen nur: Ein Geltungsbereich erlaubt auch das Lesen eines Moduls, das mit Inhalten außerhalb von ihm geteilt wird.',
      '',
      'Die Routen verweisen auf die Seiten der einzelnen Operationen, die auf Englisch sind.',
    ],
    columns: ['Berechtigung', 'Was sie erlaubt', 'Art', 'Routen'],
    global: 'global',
    scoped: 'im Geltungsbereich',
    read: 'lesend',
    none: 'Keine Route braucht sie allein.',
    open: '## Routen ohne Berechtigung',
    openText:
      'Öffentliche Routen (der Health-Check, die Lizenz, die API-Referenz) und Routen, die jede angemeldete Person und jedes Dienstkonto aufrufen darf (zum Beispiel `GET /me`). Eine Route, die Inhalte liest, braucht für den Stand, den sie öffnet (Branch oder Tag), `content.read`, was immer sie sonst braucht.',
  },
};

/**
 * The permissions reference in `lang`: each permission, what it allows (its text from the editor,
 * `withPermissionTexts`), and the routes that need it, from the operations' `x-required-permission`.
 * `pageOf(api, path, method)` gives an operation's page. The German page lists the routes without
 * their summaries, which are the English operation pages' titles.
 */
export function renderPermissions(permissions, apis, pageOf, lang = 'en') {
  const t = PERMISSION_PAGE[lang];
  const routes = new Map();
  const open = [];
  for (const [api, doc] of Object.entries(apis))
    for (const { path, method, operation } of operations(doc)) {
      const needed = operation['x-required-permission'];
      const route = { api, path, method, summary: operation.summary ?? '' };
      if (needed) routes.set(needed, [...(routes.get(needed) ?? []), route]);
      else open.push(route);
    }
  const link = (r) =>
    `[${code(`${r.method.toUpperCase()} ${r.path}`)}](${pageOf(r.api, r.path, r.method)})`;
  const routeTable = (list) =>
    lang === 'en'
      ? table(
          [t.route, t.does],
          list.map((r) => [link(r), cell(r.summary)]),
        )
      : list.map((r) => `- ${link(r)}`).join('\n');
  const out = [
    ...t.intro,
    '',
    table(
      t.columns,
      permissions.map((p) => [
        `[${breakableCode(p.name)}](#${anchor(p.name)})`,
        cell(p.text[lang]),
        [p.global ? t.global : t.scoped, p.read ? t.read : '']
          .filter(Boolean)
          .join(', '),
        String(routes.get(p.name)?.length ?? 0),
      ]),
    ),
    '',
  ];
  for (const p of permissions) {
    out.push(`## ${p.name}`, '', mdx(p.text[lang]), '');
    const list = routes.get(p.name) ?? [];
    if (list.length === 0) out.push(t.none, '');
    else out.push(routeTable(list), '');
  }
  out.push(t.open, '', t.openText, '', routeTable(open), '');
  return out.join('\n');
}

/**
 * The MCP tools and resources reference: the tools from `TOOLS` (`backend/mcp`) with JSON Schemas
 * for their inputs, and the resource templates from `RESOURCE_TEMPLATES` with their bounds.
 *
 * @param {{ name: string, title: string, description: string, inputSchema: object }[]} tools
 * @param {{ templates: readonly { uriTemplate: string, name: string, title: string, description: string, mimeType: string }[], pageSize?: number, textLimit?: number }} [resources]
 */
export function renderMcpTools(tools, resources = { templates: [] }) {
  const out = [
    'The MCP server (`backend/mcp`) gives agents the released content through these tools and resources. It is a client of the API and acts with the token it is given, so a tool sees only what that token may read. Every tool is read-only. How to connect a client: [The MCP server](/guides/mcp).',
    '',
    table(
      ['Tool', 'What it does'],
      tools.map((t) => [
        `[${breakableCode(t.name)}](#${anchor(t.name)})`,
        cell(t.title),
      ]),
    ),
    '',
  ];
  for (const t of tools) {
    out.push(
      `## ${t.name}`,
      '',
      `**${mdx(t.title)}.** ${mdx(t.description)}`,
      '',
    );
    const rows = fields(t.inputSchema);
    out.push(rows.length === 0 ? 'Takes no arguments.' : fieldsTable(rows), '');
  }
  if (resources.templates.length > 0) {
    out.push(
      '## Resources',
      '',
      'Besides the tools, a client can list the manuals as resources (`resources/list`, paged by `cursor`) and read one (`resources/read`). `resources/templates/list` gives their address templates:',
      '',
    );
    for (const r of resources.templates) {
      out.push(
        `### ${r.name}`,
        '',
        `**${mdx(r.title)}.** ${mdx(r.description)}`,
        '',
        `- Address: ${code(r.uriTemplate)}`,
        `- Type: ${code(r.mimeType)}`,
        '',
      );
    }
    const bounds = [
      resources.pageSize !== undefined &&
        `\`resources/list\` lists ${resources.pageSize} manuals a page, each once per variant and language.`,
      resources.textLimit !== undefined &&
        `A read gives at most ${resources.textLimit.toLocaleString('en')} characters; \`_meta.truncated\` says when the text was cut.`,
    ].filter(Boolean);
    if (bounds.length > 0) out.push(bounds.join(' '), '');
  }
  return out.join('\n');
}

/** The project configuration (`openfolia.yaml`) reference, from the content model's schema. */
export function renderProjectConfig(schema) {
  const rows = fields(schema);
  const top = rows.map((r) => r.path).filter((path) => !/[.[<]/.test(path));
  return [
    'Each content repository holds its configuration in `openfolia.yaml` at its root: its languages, module types, audiences, facets, variant attributes, safety symbols, the labels printed in outputs, and how releases and deliveries behave. Everything organisation-specific lives there, not in code. The server reads it at the commit it serves, so a change to it goes through a change set like any other.',
    '',
    `Top-level keys: ${top.map((k) => code(k)).join(', ')}.`,
    '',
    '`<key>` stands for a key you choose (an ID). `a[]` is an item of the list `a`.',
    '',
    fieldsTable(rows),
    '',
  ].join('\n');
}

/** The import format reference, from `import-format.schema.json`. */
export function renderImportFormat(schema, guideUrl) {
  return [
    'Content from another system reaches the platform as an import bundle: a ZIP archive with `import.json` at its root (the modules, manuals and a report, described below) and the files it refers to under `assets/`. A converter run outside the platform makes the bundle; the import checks it against the target repository and says what is wrong, item by item, before anything is written. The JSON Schema of `import.json` is published with the content model as `@openfolia/content-model/import-format.schema.json`.',
    '',
    ...(guideUrl
      ? [
          `The format's guide, with examples: [import-format.md](${guideUrl}).`,
          '',
        ]
      : []),
    ...(schema.description ? [mdx(schema.description), ''] : []),
    fieldsTable(fields(schema)),
    '',
  ].join('\n');
}
