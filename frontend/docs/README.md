# `frontend/docs` (`docs`)

The public documentation site (#420): Fumadocs on Next.js, built as a **static export** (`out/`)
that any web server can serve. English and German, the product's palette and fonts, light and
dark, and search in the browser. Its reference parts are generated from this repository on every
build, so a pull request that changes the API, a setting or the content model changes its docs in
the same pull request, and nothing generated is committed.

## Commands

| Command                               | What                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm nx build docs`                  | generate the references, build the site into `frontend/docs/out`, check the stable addresses |
| `pnpm nx run docs:generate`           | only the generated references (`frontend/docs/generated`)                                    |
| `pnpm nx run docs:serve -- -p <port>` | the dev server (`next dev`) at `http://127.0.0.1:<port>` (`localhost` works too)             |
| `pnpm nx test docs`                   | the generators' tests, and the drift checks on the repository's own files                    |
| `pnpm nx run docs:e2e`                | the browser smoke test on the built site (below); `pnpm check` runs it                       |

The versions are pinned: Next 16.4.5, React 19.2.9, `fumadocs-core` and `fumadocs-ui` 16.17.10,
`fumadocs-mdx` 15.4.10, `fumadocs-openapi` 12.5.8.

## Layout

| Path                                 | What                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `content/docs/`                      | the hand-written pages, MDX: `page.mdx` in English, `page.de.mdx` in German; `meta.json` orders a folder             |
| `generated/` (git-ignored)           | what `scripts/generate.mjs` makes: the API documents and the reference pages                                         |
| `app/(en)/`, `app/de/`               | the two languages' routes, each a root layout with its `<html lang>`                                                 |
| `app/*.json`, `app/*.txt`, `app/md/` | files made at build time: the search indexes, `llms.txt`, `llms-full.txt`, `guide-index.json`, every page's Markdown |
| `agents/`                            | the install guide for coding agents (`/agents`), a template the generator fills in with the release's values         |
| `lib/`, `components/`                | the source (`lib/source.ts`), languages, the sidebar, the page                                                       |
| `scripts/`                           | the generator, the stable-address check, and their libraries (`scripts/lib/`)                                        |

## Languages

English has no prefix (`/api`); German has the same paths under `/de/` (`/de/api`). A static
export has no middleware, so the two are separate route trees (`app/(en)/[[...slug]]` and
`app/de/[[...slug]]`) over one Fumadocs source with the `dot` parser. A page without a German
file shows its English text under `/de/`, with German chrome and a note saying so. Of the generated
references, the shortcuts, the roles, the permissions, the error codes, the changelog and the agent
guide are written in both languages, the permissions' and the error codes' texts taken from the
editor's translations (#750, `scripts/lib/error-texts.mjs`: a code's `apiErrors.codes` text, else a
screen's own table's; a code without a German text fails the build, unless the editor's i18n test
exempts it because no editor screen meets it, and then its English description stands in an English
section of the German page). The other catalogues (settings, `openfolia.yaml`, import format, MCP tools)
are English, because their source is: their German pages say so at the top, link the English page
and show the English body in an English section. No German page (`.de.mdx`) may hold English prose:
the build checks the generated German pages and `tests/german-pages.test.ts` the written ones
(`scripts/lib/german-check.mjs`, #744). An English section (between the MDX comments
`{/* english: start */}` and `{/* english: end */}`) is passed over, and only those five generated
pages may hold one. The API reference's
operation pages, about 200, are not doubled: German links to their English addresses
(`lib/tree.ts`). The site's own texts are in `lib/translations.ts`, and Fumadocs' chrome in German
is in `lib/ui-i18n.ts`.

## Generated references

`scripts/generate.mjs` (the `generate` target, which `build` depends on) reads the repository's
files at build time, never a copy:

| Reference                      | From                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/delivery/…`              | `backend/api/openapi/delivery.yaml`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `/api/management/…`            | the API's full document, made by booting the built API in-process (`backend/api/scripts/openapi-document.mjs`), minus the delivery operations                                                                                                                                                                                                                                                                                                                                                                                                   |
| `/reference/errors`            | `backend/api/error-codes.yaml` (checked against the source by the API's own test)                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `/reference/permissions`       | `backend/api/src/access/core/permissions.ts` and each route's `x-required-permission`                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `/reference/settings`          | `.env.example` and its comments                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `/reference/project-config`    | `ProjectConfig` of `@openfolia/content-model`, as JSON Schema                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `/reference/import-format`     | `packages/content-model/import-format.schema.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `/reference/mcp-tools`         | `TOOLS` of `@openfolia/mcp`, their inputs as JSON Schema                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `/guide/reference/shortcuts`   | `SHORTCUTS` of `frontend/editor/src/app/shortcuts/shortcuts.ts` with their texts from the editor's translations (the editor's `shortcuts.spec.ts` holds the catalogue to the keys the editor binds)                                                                                                                                                                                                                                                                                                                                             |
| `/guide/reference/roles`       | the example roles of `backend/api/src/access/repos/example-seed.ts`, with the permissions' descriptions                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `/changelog`, `/changelog.xml` | `changelog/<version>.json`, which the release step writes (`scripts/release.mjs`, CONTRIBUTING.md "Releases"), checked by the build: a section per release with its anchor (`#v1.2.0`), newest first, and an Atom feed; "No release yet" before the first. The pull requests' titles and notes in it are untrusted, so they never go through Markdown or MDX: the page's MDX names only the version, and `components/changelog-release.tsx` shows the text as text nodes, with links it builds from the repository and the pull request numbers |

The API reference has a page per operation (fumadocs-openapi), by tag. Each page embeds a document
cut down to its own operation and the schemas it references (`pruneToOperation`), not the whole
document. Every document has one server, `https://{host}/api` (`API_SERVER` in
`scripts/lib/openapi.mjs`, #858): the reader types their instance's host (a hosted team's
`<team>.openfolia.com`, or their own) once, in the field above each operation
(`components/api-page.tsx`), and the code samples use it; it is kept in the browser for the other
pages. The site sends no requests itself: a static site on another origin can't reach an instance
(the API sends no CORS headers, and the image's Content-Security-Policy allows only the site), so
the field replaces the playground's send action, and points to `/api/docs` on the instance, which
serves its own interactive reference.

**Drift checks.** The build fails, and with it `pnpm check`, when a reference cannot describe
something:

- an operation without a summary or a description;
- a setting in `.env.example` without a comment above it;
- a permission without a `/** comment */`;
- a `openfolia.yaml` key without a description (`.describe()` on the content model's schema);
- a guide page without an `articleId`, or two pages with one ID;
- a shortcut without its text in a language or with a key the reference cannot name, or an example
  role naming a permission or a scope that does not exist;
- a stable address missing from the built site.

A new error code without an entry in `backend/api/error-codes.yaml` fails the API's tests
(`backend/api/README.md`, "Error codes"), and a `openfolia.yaml` key without a description fails the
content model's tests too (`config.spec.ts`), before the docs are built.

## For language models and coding agents

- **Every page as Markdown** at its address plus `.md` (`/guide/writing.md`; the home pages at
  `/index.md` and `/de/index.md`): `app/md/[...slug]/route.ts` makes them under `out/md/`, since a
  static export can't put a route beside the pages' own, and `scripts/markdown-pages.mjs` (run by
  `build`) moves each to its address. A page's Markdown is its title, its description and its text
  after the MDX is processed; the agent box is written out as its line.
- **Page actions** on every page: "Copy Markdown" and "Open" (the Markdown, or the page handed to
  an assistant), Fumadocs' own (`components/docs-page.tsx`).
- **`/llms.txt`** (the index, with the agent guide and the OpenAPI documents) and
  **`/llms-full.txt`** (every English page's text), from `lib/llms.ts`.
- **The install guide for coding agents** (#423), `/agents` and `/agents.md`: `agents/agents.mdx`
  (and `.de.mdx`) is a template; `scripts/generate.mjs` fills in the release the docs are built
  for (`DOCS_RELEASE`), its images (`DOCS_IMAGES`), where its files are downloaded
  (`DOCS_RELEASE_URL`) and the SHA-256 of `deploy/compose.yaml`, which the release workflow
  attaches to the GitHub Release (CONTRIBUTING.md, "Releases"), and its images by their digests
  (`DOCS_RELEASE_DIGESTS`, the release's `images.lock`, #739): the SHA-256 of the override
  `compose.digests.yaml`, made here by the release's own code (`scripts/release-digests.mjs`), and
  the digests step 7 checks the running containers against. A release's docs without them fail
  the build. When the release's images are signed (#745, `DOCS_RELEASE_SIGNATURES`, the release's
  `signatures.sha256`), the guide also names the SHA-256 of each signature bundle and of the
  trust root, and the identity the signatures carry (the release workflow's, from
  `DOCS_REPOSITORY_URL` and the tag, or `DOCS_RELEASE_SIGNER_IDENTITY` and
  `DOCS_RELEASE_SIGNER_ISSUER`); step 5 verifies them with cosign, offline, before pulling. So a
  release's docs install that
  release; the development docs (no `DOCS_RELEASE`) tell the agent to stop. `checkAgentGuide`
  (`scripts/lib/agent-guide.mjs`) fails the build, and `tests/agent-guide.test.ts` the tests, for
  a guide that pipes a download into a shell, names an unpinned image or version, downloads a file
  without verifying its checksum, installs without the images' digests, prints the settings, runs
  cosign other than offline (`verify-blob-attestation --trusted-root`), or lacks one of its safety
  rules; the two
  languages must give the same commands.
- **"Install with your coding agent"** (`<AgentInstall />`, `lang="de"` on a German page): the
  one line to paste, naming this site's `/agents`, with a copy button. On the home page, Getting
  started and Self-hosting.

## Search

The search runs in the browser (`components/search.tsx`). Each language has its own index, a Fumadocs export made at build time at `/search-en.json` and `/search-de.json` (`lib/search-index.ts`), and the dialog fetches only the reader's, as it opens (#949). Before, one `/search.json` held both languages, with sort tables and fields the search never used: 17 MB, 3.2 MB compressed. Now an index is about 5.4 MB, about 1 MB compressed. The docs have one version, so the language is the only split. The full text of about 470 pages is itself about 400 KB compressed, which is why the issue's 500 KB is not reached. The dialog shows a placeholder while the index loads and, if it fails, a message with "Try again" (the client caches a failed fetch by its address, so a retry changes the address).

`scripts/check-search-budget.mjs` (run by `build`; `scripts/lib/search-budget.mjs` holds `SEARCH_BUDGET_BYTES`) fails the build when a language's index, gzipped, is over 1.2 MB. Trim the index before raising the number.

## Stable addresses

The product's website, the README and the editor link to these, so `scripts/check-stable-paths.mjs`
(run by `build`) fails when one is missing from `out/`, in English or in German:

- the pages `/`, `/api`, `/api/delivery`, `/api/management`, `/getting-started`, `/demo` (#32), `/self-hosting`,
  `/guides/rag`, `/guides/mcp`, `/changelog` (#421), `/agents` (#423) and `/guide` (#447), each
  also under `/de/`;
- the files `/agents.md`, `/llms.txt`, `/llms-full.txt`, `/guide-index.json` and `/changelog.xml`, and both OpenAPI
  documents to download: `/openapi/delivery.yaml`, `/openapi/delivery.json`,
  `/openapi/management.yaml` and `/openapi/management.json` (`app/openapi/`), the documents the
  reference is made from, with the same server and its `host` variable, for Postman and similar
  tools.

A page that moves keeps its old address with a redirect: add it to `REDIRECTS` in
`scripts/lib/redirects.mjs` (#820), which `build` turns into a small page per language at the old
address (`scripts/redirect-pages.mjs`: a meta refresh and a canonical link, since a static export
has no server to answer 301) and the stable-address check holds to exist. Pages that only hold an address for
another issue say so (`planned: <issue>` in their front matter shows a notice).

## Browser smoke test

`e2e/smoke.spec.ts` (`docs:e2e`, after `build`) runs Playwright on the static export, the files
that ship, served from `out/` at `127.0.0.1` on a port the system picks (`e2e/global-setup.ts`).
On an English and a German page, at desktop and phone width, in light and dark: search opens with
⌘K and finds a page, the sidebar collapses and opens, the theme switches, the language select goes
to `/de/` and back, nothing logs an error or scrolls sideways, and a table fills its frame. It also
checks that the `openfolia.yaml` reference breaks field names only between their parts and that both
OpenAPI documents download and parse. A change to the site's layout, styles or controls keeps it
passing; a bug found in the browser gets a check here first.

The dev server allows `127.0.0.1` as well as `localhost` (`allowedDevOrigins`): Next 16 blocks its
dev resources from any other host, which leaves every control dead. It writes no `AGENTS.md`
(`agentRules: false`).

## The user guide

`content/docs/guide/` is the user guide (#447), one folder per area, as `docs/features.md` plans
its pages (`/guide/<area>/<page>`). Every guide page has an `articleId` in its front matter, for
example `guide.writing.edit-a-module`: the editor's in-app help (#221) links by ID through
`/guide-index.json`, which lists each ID with the page's address, title and summary per
language. One generator makes it, `scripts/lib/guide-index.mjs` (front matter plus the generated
reference pages of `scripts/lib/guide-reference-pages.mjs`): the site serves it, and the editor's
build ships the same file for its own version (`editor:guide-index`, the asset
`help/guide-index.json`), so the editor needs no request to the docs site to find a page. The
index fails the build for a page without an `articleId`, without a title or summary, or for an ID
used twice; `pnpm nx run docs:stable-paths` checks that every address in it is a page of the
site. The shortcut reference names the keys with the editor's own `keyCaps`
(`frontend/editor/src/app/shortcuts/key-caps.ts`, imported as is) and the key names of the
editor's translations (`shortcuts.keys`), the same the editor's shortcut overlay shows.

How a page is written:

- **One task per page**, short sentences, numbered steps for what to do.
- **The editor's labels in bold, exactly** as `frontend/editor/src/i18n/{en,de}.json` (and
  `frontend/ui/src/i18n/`) have them: the English page uses the English label, the German page the
  German one. A label that changes in the editor changes on the page too.
- **German is a translation of its own** (`<page>.de.mdx`), in the editor's German wording and its
  "Sie"; links go to `/de/guide/…`.
- **Examples use the sample content only.**
- **Screenshots** live in `public/images/guide/<en|de>/<name>.webp`, made by
  `pnpm nx run editor-e2e:guide-screenshots` (`frontend/editor-e2e/README.md`, "Screenshots for
  the user guide"); a page shows its own language's (`![…](/images/guide/en/<name>.webp)`).

`tests/guide-articles.test.ts` holds the pages together: each has an `articleId`, the same in both
languages, every page is in English and German, its screenshots exist in its language, its links
to other guide pages lead somewhere, and the index builds without a problem. The editor's
`screen-help.spec.ts` holds every routed screen to a guide page in that index.

## Theme

`@openfolia/theme` gives the tokens and the fonts (Geist, served from the site, never a CDN), imported
in the layouts so their font URLs resolve. `fumadocs-ui/css/shadcn.css` maps Fumadocs' colours
onto the theme's token names in light and dark, so no colour is written here. The brand's lockup
and favicon come from `@openfolia/theme/brand`.

## Settings

Read from the build's environment (`.env.example`, "Docs site"): `DOCS_SITE_URL` (absolute links in `llms.txt`, the agent guide and its
one-liner) and `DOCS_REPOSITORY_URL` (the GitHub link in the navigation and links to files in the
repository; by default the project's own, `https://github.com/openfolia/openfolia`); for the
agent guide, `DOCS_RELEASE`, `DOCS_RELEASE_URL`, `DOCS_IMAGES`, `DOCS_RELEASE_DIGESTS`,
`DOCS_RELEASE_SIGNATURES`, `DOCS_RELEASE_SIGNER_IDENTITY` and `DOCS_RELEASE_SIGNER_ISSUER`
(above). An invalid value fails
the build.
