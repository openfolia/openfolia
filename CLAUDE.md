# OpenFolia

A documentation platform: modular content (AsciiDoc) in Git, assembled into manuals per
variant and language, served by a JSON:API and rendered to PDF with Typst. Later: drafts on
branches, review and approval workflow, roles, an editor.

**Organisation-agnostic.** This code may be open-sourced. No company, client, person or vendor
names in code, tests, fixtures, sample content, commit messages, issues or PRs. Variant
attributes, audience levels and module types are configuration, never hardcoded. No importer or
plan tied to a specific vendor's system. One exception: a vendored third-party file used only by
tests (a standard's schema, say) keeps the attribution its licence requires; nothing else names
a vendor. Organisation-specific material (the spec, working notes)
lives only in `docs/internal/`, which is git-ignored and never committed, quoted in an issue or
pasted into a PR.

## Layout

Nx 24 + pnpm 11 monorepo, Node 24, TypeScript 6, ESM, Vitest. Frontend: Angular 22, Tailwind CSS v4.

| Path                            | Nx project             | What                                                                              |
| ------------------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `packages/content-model`        | `content-model`        | the document model, manifests, variant resolution, validation                     |
| `packages/content-repo`         | `content-repo`         | reads content from Git at any ref, without a working tree                         |
| `packages/content-editor-model` | `content-editor-model` | the editor's ProseMirror schema and the converters to and from the content model  |
| `packages/render-typst`         | `render-typst`         | resolved manual → PDF with Typst on a worker pool                                 |
| `backend/api`                   | `api`                  | NestJS 12 JSON:API over the content (`backend/api/README.md`)                     |
| `backend/mcp`                   | `mcp`                  | MCP server for agents over the released content, a client of the API              |
| `frontend/theme`                | `theme`                | design tokens and fonts as plain CSS (`frontend/theme/README.md`)                 |
| `frontend/ui`                   | `ui`                   | Angular component library: Zard UI + ours, Tailwind v4                            |
| `frontend/editor`               | `editor`               | the editor, an Angular app built from `ui` components only                        |
| `frontend/docs`                 | `docs`                 | the public docs site (Fumadocs, static export), references generated at build     |
| `frontend/portal`               | `portal`               | the static portal per audience and language (Astro, Pagefind), built from the API |
| `scripts/`                      | `workflow`             | planning and parallel-agent tooling; tests of `.claude/hooks/` too                |

Each package's README describes its API; read it before changing the package.

## Commands

- `pnpm check`: test, lint, typecheck and build everything, then the speed criteria (`perf`,
  `backend/api/README.md`). `pnpm check:changed`: only what the branch affects. One project: `pnpm nx test api`, `pnpm nx lint content-model`, …
- `pnpm nx run api:setup-local` then `pnpm nx run api:serve-local`: the API on a sample content
  repository (`.local/`, `.env.local`; both git-ignored).
- Prettier on the files you touched: `pnpm prettier --write <files>`.

## The API (`backend/api`)

- **Hexagonal**, one folder per component: `api/` (controllers, JSON:API resources as Zod
  schemas), `core/` (actions with one `handle()` each, ports as abstract classes, domain errors),
  `repos/` (adapters implementing the ports), `base/` (shared). A lint rule keeps `core/` free of
  HTTP, Nest's HTTP exceptions, config, Git, the renderer and the database. New behaviour is a new
  action with a unit test against the in-memory fake (`tests/fakes/`), plus an e2e test for the
  route.
- **JSON:API**: media type `application/vnd.api+json` exactly; camelCase members; stored data in
  `attributes`, derived data in `meta`; errors as `{ errors: [{ status, title, detail, code,
source?, meta? }] }` with a stable `code`; unsupported query parameters are a 400.
- **Every list is paginated** (`page[number]`, `page[size]`, `meta.page`, `links`), even short
  ones. In any UI, a paginated list scrolls inside its own container with the pagination outside
  it, and long values wrap instead of widening the page.
- **OpenAPI** is generated from the controllers and the Zod schemas; e2e tests check every JSON
  response against them. Parameters are validated with `@Param('x', { schema })`.
- **Settings**: every new `process.env.*` or env-schema entry also goes into `.env.example` with a
  comment (what it is, format, default).

## Database

Drizzle with drizzle-kit migrations, committed in `backend/api/migrations/` (one per issue, never
edited once merged; `pnpm nx run api:db-generate -- --name <what>`). Adapters in `repos/` inject
`Database`; tests get a fresh migrated PGlite (in-memory Postgres in the test process) from
`createTestDatabase()` or `createTestApp()`, so no shared database and no per-agent database
stack. Locally, `docker compose up -d` runs Postgres for `serve-local`. Git stays the source of
truth for content; Postgres holds operational state (users, roles, locks, comments, workflow,
the append-only audit log) and a rebuildable index. Details: `backend/api/README.md`, "Database".

## Working in this repository

- Work is planned as GitHub issues (`requirements-to-backlog` skill) and built one issue, one
  branch, one PR (`project-workflow`). Several agents at once each get a slot
  (`pnpm slot create <name>`): a worktree under `.claude/worktrees/` with its own port and local
  settings. The rules for build agents are in `docs/agent-rules.md`; the guard hooks in
  `.claude/hooks/` enforce the dangerous ones.
- Before calling work done: `verify-before-done`. Review with `/code-review`; stop the loop at
  the first round with no critical or major findings and list the minors in the PR.
- Stage files explicitly (never `git add -A`). Never commit `docs/internal/`, `.env*` (except
  `.env.example`) or `.local/`.
- Stop servers by port, never `pkill -f`.
