// Generates the docs site's reference pages from the repository, into `generated/` (git-ignored):
//
//   - `openapi/`: the Delivery API (from `backend/api/openapi/delivery.yaml`) and the Management API
//     (the full document, made now by booting the built API in-process, minus the delivery
//     operations), each also cut into one small document per operation for its page;
//   - `content/api/{delivery,management}/`: a page per operation (fumadocs-openapi), by tag;
//   - `content/reference/`: the catalogues: error codes (`backend/api/error-codes.yaml`; in German
//     with the editor's German messages, `lib/error-texts.mjs`),
//     permissions (`backend/api/src/access/core/permissions.ts` and the routes'
//     `x-required-permission`), settings (`.env.example`), the project configuration (`openfolia.yaml`,
//     the content model's schema), the import format (`import-format.schema.json`) and the MCP
//     tools (`backend/mcp`), each with its German page: the permissions and the error codes in
//     German, the others in English under a German note (#750);
//   - `content/guide/reference/`: the user guide's keyboard shortcuts (the editor's
//     `shortcuts/shortcuts.ts` and its translations) and roles (the example roles of
//     `backend/api/src/access/repos/example-seed.ts` and the permissions), in English and German;
//   - `content/changelog.mdx` (and `.de.mdx`), `changelog.json` and `changelog.xml`: the changelog
//     page, the releases it shows and its Atom feed, from `changelog/<version>.json` (written by
//     `scripts/release.mjs` on each release);
//   - `content/agents.mdx` (and `.de.mdx`): the install guide for coding agents (`agents/`), with
//     the release's version, images and the SHA-256 of `deploy/compose.yaml` filled in.
//
// Nothing generated is committed, so nothing can drift: every build makes it again from the files.
// The build fails (exit 1) for what the references cannot describe: an operation without a summary
// or a description, a setting without a comment, a permission without one, a openfolia.yaml key
// without a description (`.describe()` on the content model's schema), a shortcut without its
// English or German text or with a key the reference cannot name, an example role holding a
// permission that does not exist, a permission without the editor's English or German text, an
// error code without the editor's German text that the editor's i18n test does not exempt (#750),
// and a generated German page with English prose or a table cell equal to the English page's
// outside the English sections only the named pages may hold (#744, `lib/german-check.mjs`).
//
//   node scripts/generate.mjs
//
// Settings (read from the environment): DOCS_SITE_URL, DOCS_REPOSITORY_URL, DOCS_RELEASE,
// DOCS_RELEASE_URL, DOCS_IMAGES (`.env.example`).
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';
import { createOpenAPI } from 'fumadocs-openapi/server';
import { generateFilesOnly } from 'fumadocs-openapi';
import {
  managementDocument,
  operations,
  pruneToOperation,
  slug,
  undocumented,
  withServer,
} from './lib/openapi.mjs';
import { parseEnvExample, renderSettings } from './lib/env-example.mjs';
import {
  parsePermissions,
  renderErrorCodes,
  renderImportFormat,
  renderMcpTools,
  renderPermissions,
  renderProjectConfig,
} from './lib/catalogues.mjs';
import { fields, undescribedFields } from './lib/json-schema.mjs';
import {
  englishProse,
  ENGLISH_END,
  ENGLISH_START,
  glossaryWords,
  sameCells,
  withoutEnglish,
} from './lib/german-check.mjs';
import {
  exemptErrorCodes,
  germanErrorTexts,
  screenErrorTables,
} from './lib/error-texts.mjs';
import {
  GUIDE_LANGUAGES,
  parseRoles,
  parseShortcuts,
  renderRoles,
  renderShortcuts,
  withPermissionTexts,
} from './lib/guide-references.mjs';
import { frontMatter, GENERATED_NOTE } from './lib/markdown.mjs';
import {
  readReleases,
  renderChangelogPage,
  renderFeed,
} from './lib/changelog.mjs';
import { docsSettings } from './lib/settings.mjs';
import {
  checkAgentGuide,
  guideValues,
  renderAgentGuide,
} from './lib/agent-guide.mjs';

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(docsRoot, '../..');
const generated = join(docsRoot, 'generated');
const contentOut = join(generated, 'content');
const openapiOut = join(generated, 'openapi');
const settings = docsSettings(process.env);
const problems = [];

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const writeJson = (path, value) => write(path, `${JSON.stringify(value)}\n`);
const repoFile = (path) => readFileSync(join(repoRoot, path), 'utf8');
/** A link to a file in the repository, where DOCS_REPOSITORY_URL says where it is. */
const repoLink = (path) => `${settings.repositoryUrl}/blob/main/${path}`;

rmSync(generated, { recursive: true, force: true });

// --- The OpenAPI documents -----------------------------------------------------------------------

const fullFile = join(openapiOut, 'full.json');
const made = spawnSync(
  process.execPath,
  [join(repoRoot, 'backend/api/scripts/openapi-document.mjs'), fullFile],
  { stdio: 'inherit' },
);
if (made.status !== 0) {
  console.error(
    'Could not make the full OpenAPI document (run `pnpm nx build api` first?).',
  );
  process.exit(made.status ?? 1);
}
const full = JSON.parse(readFileSync(fullFile, 'utf8'));
rmSync(fullFile);
const apis = {
  delivery: parse(repoFile('backend/api/openapi/delivery.yaml')),
  management: managementDocument(full),
};
const titles = { delivery: 'Delivery API', management: 'Management API' };
for (const [api, doc] of Object.entries(apis)) {
  problems.push(...undocumented(doc, titles[api]));
  apis[api] = withServer(doc);
  writeJson(join(openapiOut, `${api}.json`), apis[api]);
  // The whole document to download (`/openapi/<api>.yaml` and `.json`, `app/openapi/`): for
  // Postman and the like, its server the reader's instance (`API_SERVER`, #618, #858).
  write(
    join(openapiOut, `${api}.yaml`),
    stringify(apis[api], { lineWidth: 0 }),
  );
}

// One small document per operation, so a page embeds only what it shows (`lib/openapi.ts` reads
// `openapi/index.json`).
const index = {};
const pageOfOperation = new Map();
for (const [api, doc] of Object.entries(apis)) {
  const inputs = {};
  const usedIds = new Set();
  for (const { path, method, operation } of operations(doc)) {
    let id = `${api}-${slug(operation.operationId ?? `${method}-${path}`)}`;
    while (usedIds.has(id)) id += '-x';
    usedIds.add(id);
    const file = join(openapiOut, api, `${id}.json`);
    const mini = pruneToOperation(doc, path, method);
    writeJson(file, mini);
    index[id] = relative(docsRoot, file);
    inputs[id] = mini;
  }
  const files = await generateFilesOnly({
    input: createOpenAPI({ input: inputs }),
    per: 'operation',
    groupBy: 'tag',
    slugify: slug,
  });
  const folderTitles = new Map();
  for (const tag of doc.tags ?? []) folderTitles.set(slug(tag.name), tag.name);
  const folders = new Map();
  const written = new Set();
  for (const generatedFile of files) {
    // `Modules_list.mdx` → `modules-list.mdx`: the operation ID as the page's address.
    const file = {
      ...generatedFile,
      path: generatedFile.path.replace(/[^/]+(?=\.mdx$)/, (name) => slug(name)),
    };
    if (written.has(file.path)) {
      problems.push(
        `${api}: two operations would both be the page ${file.path}; rename one's operation ID`,
      );
      continue;
    }
    written.add(file.path);
    const target = join(contentOut, 'api', api, file.path);
    write(target, file.content);
    const id = /document="([^"]+)"/.exec(file.content)?.[1];
    const mini = id && inputs[id];
    const url = `/api/${api}/${file.path.replace(/\.mdx$/, '')}`;
    if (mini)
      for (const op of operations(mini))
        pageOfOperation.set(`${api} ${op.method} ${op.path}`, url);
    const folder = dirname(file.path);
    if (folder !== '.')
      folders.set(folder, [...(folders.get(folder) ?? []), file.path]);
  }
  for (const folder of folders.keys()) {
    const name = folder.split('/').at(-1);
    const title = folderTitles.get(name) ?? name.replace(/-/g, ' ');
    writeJson(join(contentOut, 'api', api, folder, 'meta.json'), {
      title: title.charAt(0).toUpperCase() + title.slice(1),
    });
  }
}
writeJson(join(openapiOut, 'index.json'), index);
const pageOf = (api, path, method) =>
  pageOfOperation.get(`${api} ${method} ${path}`) ?? `/api/${api}`;

// --- The catalogues ------------------------------------------------------------------------------

const page = (name, title, description, body) =>
  write(
    join(contentOut, 'reference', `${name}.mdx`),
    `${frontMatter({ title, description })}\n${GENERATED_NOTE}\n\n${body}`,
  );

// The editor's translations: the shortcut reference's texts, the permissions' texts in both
// languages (Admin › Roles names them so) and the German error code reference's messages.
const editorTranslations = Object.fromEntries(
  GUIDE_LANGUAGES.map((lang) => [
    lang,
    JSON.parse(repoFile(`frontend/editor/src/i18n/${lang}.json`)),
  ]),
);

// The error codes, in English from the catalogue, in German as the editor shows them (#750): its
// `apiErrors.codes`, else a screen's own table, else (a code no screen meets, which the editor's
// i18n test exempts) the English description in an English section.
const errorCatalogue = parse(repoFile('backend/api/error-codes.yaml'));
const editorApp = join(repoRoot, 'frontend/editor/src/app');
const editorSources = readdirSync(editorApp, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
  .sort()
  .map((f) => ({ path: f, text: readFileSync(join(editorApp, f), 'utf8') }));
const germanErrors = germanErrorTexts(Object.keys(errorCatalogue), {
  de: editorTranslations.de,
  tables: screenErrorTables(editorSources),
  exempt: exemptErrorCodes(repoFile('frontend/editor/tools/i18n.test.mjs')),
});
problems.push(...germanErrors.problems);
page(
  'errors',
  'Error codes',
  'Every error code the API answers with, its HTTP status and when it happens.',
  renderErrorCodes(errorCatalogue),
);
page(
  'errors.de',
  'Fehlercodes',
  'Jeder Fehlercode, mit dem die API antwortet, sein HTTP-Status und was er meldet.',
  renderErrorCodes(errorCatalogue, 'de', germanErrors),
);
const parsedPermissions = parsePermissions(
  repoFile('backend/api/src/access/core/permissions.ts'),
);
problems.push(...parsedPermissions.problems);
const permissions = withPermissionTexts(
  parsedPermissions.permissions,
  editorTranslations,
);
problems.push(...permissions.problems);
page(
  'permissions',
  'Permissions',
  'Every permission a role can hold, and the routes that need it.',
  renderPermissions(permissions.permissions, apis, pageOf, 'en'),
);
page(
  'permissions.de',
  'Berechtigungen',
  'Jede Berechtigung, die eine Rolle haben kann, und die Routen, die sie brauchen.',
  renderPermissions(permissions.permissions, apis, pageOf, 'de'),
);

const env = parseEnvExample(repoFile('.env.example'));
problems.push(...env.problems);
page(
  'settings',
  'Settings',
  'Every setting the server and its tools read from the environment, with what the example settings file says about it.',
  renderSettings(env),
);

// The content model and the MCP server, built (`^build`): their own Zod, for their schemas.
const docsRequire = createRequire(join(docsRoot, 'package.json'));
const importFrom = (pkg) =>
  import(pathToFileURL(docsRequire.resolve(pkg)).href);
const zodOf = (pkg) => createRequire(docsRequire.resolve(pkg))('zod');

const model = await importFrom('@openfolia/content-model');
const modelZod = zodOf('@openfolia/content-model');
const projectConfig = modelZod.z.toJSONSchema(model.ProjectConfig, {
  io: 'input',
  unrepresentable: 'any',
});
problems.push(...undescribedFields(fields(projectConfig), 'openfolia.yaml'));
page(
  'project-config',
  'Project configuration (openfolia.yaml)',
  'Every key of a content repository’s openfolia.yaml, from the content model’s schema.',
  renderProjectConfig(projectConfig),
);

page(
  'import-format',
  'Import format',
  'The fields of an import bundle’s import.json, from its JSON Schema.',
  renderImportFormat(
    JSON.parse(repoFile('packages/content-model/import-format.schema.json')),
    repoLink('packages/content-model/docs/import-format.md'),
  ),
);

const mcp = await importFrom('@openfolia/mcp');
const mcpZod = zodOf('@openfolia/mcp');
page(
  'mcp-tools',
  'MCP tools and resources',
  'The tools the MCP server gives agents, their arguments, and its resources.',
  renderMcpTools(
    mcp.TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: mcpZod.z.toJSONSchema(mcpZod.z.object(tool.inputSchema), {
        io: 'input',
        unrepresentable: 'any',
      }),
    })),
    {
      templates: mcp.RESOURCE_TEMPLATES,
      pageSize: mcp.RESOURCES_PAGE_SIZE,
      textLimit: mcp.RESOURCE_TEXT_LIMIT,
    },
  ),
);

// The references whose source is English (#750): the settings (`.env.example`'s comments), openfolia.yaml
// (the schema's `.describe()` texts), the import format (its JSON Schema) and the MCP tools (their
// definitions). Read by operators and integrators, their source of truth is the code, so the German
// page says so at the top, links the English page and shows the English body in an English
// section, which the German check passes over on these pages only.
const ENGLISH_REFERENCES = {
  settings: {
    title: 'Einstellungen',
    description:
      'Jede Einstellung, die der Server und seine Werkzeuge aus der Umgebung lesen, mit dem, was die Beispieldatei über sie sagt.',
    english: 'Settings',
    source:
      'den Kommentaren der `.env.example` erzeugt, die nur auf Englisch geschrieben sind',
  },
  'project-config': {
    title: 'Projektkonfiguration (openfolia.yaml)',
    description:
      'Jeder Schlüssel der openfolia.yaml eines Inhalts-Repositorys, aus dem Schema des Inhaltsmodells.',
    english: 'Project configuration (openfolia.yaml)',
    source:
      'den Beschreibungen im Schema des Inhaltsmodells erzeugt, die nur auf Englisch geschrieben sind',
  },
  'import-format': {
    title: 'Importformat',
    description:
      'Die Felder der import.json eines Import-Pakets, aus ihrem JSON-Schema.',
    english: 'Import format',
    source:
      'dem JSON-Schema der `import.json` erzeugt, das nur auf Englisch geschrieben ist',
  },
  'mcp-tools': {
    title: 'MCP-Werkzeuge und -Ressourcen',
    description:
      'Die Werkzeuge, die der MCP-Server Agenten gibt, ihre Argumente und seine Ressourcen.',
    english: 'MCP tools and resources',
    source:
      'den Werkzeug- und Ressourcendefinitionen des MCP-Servers erzeugt, die nur auf Englisch geschrieben sind',
  },
};
for (const [name, t] of Object.entries(ENGLISH_REFERENCES)) {
  const englishPage = readFileSync(
    join(contentOut, 'reference', `${name}.mdx`),
    'utf8',
  );
  const body = englishPage.slice(
    englishPage.indexOf(GENERATED_NOTE) + GENERATED_NOTE.length,
  );
  page(
    `${name}.de`,
    t.title,
    t.description,
    [
      '<Callout type="info">',
      `Diese Referenz ist auf Englisch: Sie wird aus ${t.source}. Zur englischen Seite: [${t.english}](/reference/${name}).`,
      '</Callout>',
      '',
      ENGLISH_START,
      '',
      body.trim(),
      '',
      ENGLISH_END,
      '',
    ].join('\n'),
  );
}

// --- The user guide's references -----------------------------------------------------------------

// Its shortcut and role pages (#447), in English and German, beside the written guide pages
// (`content/docs/guide/reference/`): from the editor's shortcut catalogue and its translations,
// and from the example roles and the permissions catalogue.
const guideReference = join(contentOut, 'guide', 'reference');
const shortcuts = parseShortcuts(
  repoFile('frontend/editor/src/app/shortcuts/shortcuts.ts'),
  editorTranslations,
);
problems.push(...shortcuts.problems);
const roles = parseRoles(
  repoFile('backend/api/src/access/repos/example-seed.ts'),
  permissions.permissions,
);
problems.push(...roles.problems);
for (const lang of GUIDE_LANGUAGES) {
  const suffix = lang === 'en' ? '' : `.${lang}`;
  write(
    join(guideReference, `shortcuts${suffix}.mdx`),
    renderShortcuts(shortcuts, lang),
  );
  write(
    join(guideReference, `roles${suffix}.mdx`),
    renderRoles(roles.roles, permissions.permissions, lang),
  );
}

// --- The changelog -------------------------------------------------------------------------------

// The release step's data (`changelog/<version>.json`, scripts/release.mjs): checked, then shown by
// `components/changelog-release.tsx` as text. Before the first release there is none, and the page
// says so.
const changelogDir = join(repoRoot, 'changelog');
const changelog = readReleases(
  existsSync(changelogDir)
    ? readdirSync(changelogDir).map((name) => ({
        name,
        text: readFileSync(join(changelogDir, name), 'utf8'),
      }))
    : [],
);
problems.push(...changelog.problems);
writeJson(join(generated, 'changelog.json'), changelog.releases);
write(
  join(contentOut, 'changelog.mdx'),
  renderChangelogPage(changelog.releases, 'en'),
);
write(
  join(contentOut, 'changelog.de.mdx'),
  renderChangelogPage(changelog.releases, 'de'),
);
write(
  join(generated, 'changelog.xml'),
  renderFeed(changelog.releases, { siteUrl: settings.siteUrl }),
);

// --- The install guide for coding agents --------------------------------------------------------

// `agents/agents.mdx` (and `.de.mdx`) with this release's values (#423): its version, images, and
// the SHA-256 of `deploy/compose.yaml`, the file the release publishes. `/agents.md` is the page's
// Markdown, so both pin the same.
const composeText = repoFile('deploy/compose.yaml');
for (const lang of ['en', 'de']) {
  const suffix = lang === 'en' ? '' : `.${lang}`;
  const page = renderAgentGuide(
    readFileSync(join(docsRoot, `agents/agents${suffix}.mdx`), 'utf8'),
    guideValues(settings, composeText, lang),
  );
  problems.push(
    ...checkAgentGuide(page, { english: lang === 'en', rendered: true }).map(
      (problem) => `the agent guide (${lang}): ${problem}`,
    ),
  );
  write(join(contentOut, `agents${suffix}.mdx`), page);
}

// --- No English on the German pages (#744) -----------------------------------------------------

// Every generated German page: no line of English prose, none of the English words the German
// glossary replaces, and no table cell equal to the English page's at the same place unless it is an
// identifier (code, numbers, marks) or a name kept in every language: the example roles' names, as
// an installation stores them, and a few the German pages use as they are.
const KEPT_NAMES = [
  ...roles.roles.map((r) => r.name),
  'macOS',
  'Code',
  'Images',
  'global',
  'Status',
  'Codes',
];
const generatedFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? generatedFiles(join(dir, entry.name))
      : [join(dir, entry.name)],
  );
// The German pages that may hold an English section (`withoutEnglish`), and none other: the
// references whose source is English, and the error codes' list of those no editor screen meets.
const MAY_HOLD_ENGLISH = new Set([
  ...Object.keys(ENGLISH_REFERENCES).map((name) => `reference/${name}.de.mdx`),
  'reference/errors.de.mdx',
]);
for (const file of generatedFiles(contentOut).filter((f) =>
  f.endsWith('.de.mdx'),
)) {
  const where = relative(docsRoot, file);
  const sections = withoutEnglish(readFileSync(file, 'utf8'));
  for (const p of sections.problems) problems.push(`${where}: ${p}`);
  if (
    sections.sections > 0 &&
    !MAY_HOLD_ENGLISH.has(relative(contentOut, file))
  )
    problems.push(
      `${where} holds an English section, which only the references whose source is English may`,
    );
  const german = sections.text;
  for (const p of englishProse(german))
    problems.push(`${where}:${p.line} reads as English: ${p.text}`);
  for (const w of glossaryWords(german))
    problems.push(
      `${where}:${w.line} says "${w.word}", which the German glossary replaces`,
    );
  const englishFile = file.replace(/\.de\.mdx$/, '.mdx');
  if (existsSync(englishFile))
    for (const c of sameCells(
      readFileSync(englishFile, 'utf8'),
      german,
      KEPT_NAMES,
    ))
      problems.push(
        `${where}: table ${c.table}, row ${c.row}, column ${c.column} is the English text: ${c.text}`,
      );
}

if (problems.length > 0) {
  console.error(
    `The references cannot describe ${problems.length} item(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`,
  );
  process.exit(1);
}
console.log(`Generated the references into ${relative(repoRoot, generated)}.`);
