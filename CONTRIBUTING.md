# Contributing

Thank you for helping. This guide says how to set up the repository, how work is planned, what a
pull request needs and under which licence your contribution is accepted.

By taking part you agree to follow the [code of conduct](CODE_OF_CONDUCT.md). To report a
security vulnerability, don't open an issue: read the [security policy](SECURITY.md).

## Setup

You need Node 24 (`.nvmrc`), pnpm 11 (the version in `package.json`'s `packageManager`; `corepack
enable` picks it up) and Git. Docker is needed only to run the API locally; the tests don't need
it.

```sh
pnpm install
pnpm check          # test, lint, typecheck and build every project, then the speed criteria
```

To run the API on a sample content repository:

```sh
docker compose up -d          # Postgres and S3-compatible storage, bound to 127.0.0.1 (compose.yaml)
pnpm nx run api:setup-local   # makes .local/sample-content.git, .env.local, the database and the bucket; prints the token
pnpm nx run api:serve-local   # builds and starts the API with .env.local
pnpm nx serve editor          # the editor's development server, proxying /api to that API
```

`.local/` and `.env.local` are git-ignored; never commit them. The API's
[README](backend/api/README.md) explains the settings, the API reference (`GET /docs`) and the
database.

Optional, once per clone: `pnpm setup:git-hooks` installs a post-merge hook that runs
`pnpm check:changed` after a merge or pull.

### The repository

An Nx monorepo, TypeScript and ESM throughout, Vitest for tests. [`CLAUDE.md`](CLAUDE.md) has the
map of the projects and the main conventions; each project's `README.md` describes its API.
**Read the README of every project you change before you change it.**

| Path                            | What                                                            |
| ------------------------------- | --------------------------------------------------------------- |
| `packages/content-model`        | the document model, manifests, variant resolution, validation   |
| `packages/content-repo`         | reads content from Git at any ref, without a working tree       |
| `packages/content-editor-model` | the editor's schema and the converters to and from the model    |
| `packages/render-typst`         | resolved manual to PDF with Typst on a worker pool              |
| `backend/api`                   | the JSON:API over the content ([README](backend/api/README.md)) |
| `backend/mcp`                   | an MCP server for agents over the released content              |
| `frontend/theme`                | design tokens and fonts as plain CSS                            |
| `frontend/ui`                   | the Angular component library                                   |
| `frontend/editor`               | the editor, an Angular app built from `ui` components only      |

Useful commands:

- `pnpm check`: everything. `pnpm check:changed`: only the projects your branch affects (and
  those depending on them), for quick rounds while you work.
- One project: `pnpm nx test api`, `pnpm nx lint content-model`, `pnpm nx typecheck editor`, …
- Formatting: `pnpm prettier --write <the files you changed>`.

## How work is planned

Work is planned as GitHub issues, grouped in milestones. An issue states its goal, its scope, its
acceptance criteria and what it touches. **The issue and its comments are the spec; decisions
recorded in its comments are binding.** Open product questions are collected in an
open-questions issue, each with the default that is built while it stays unanswered.

- Look for an existing issue before you start; comment on it to say you are working on it.
- For something new, open an issue first (a bug report or a feature request) so the scope can be
  agreed before you write code.
- A bug you find along the way outside your issue becomes its own issue; it doesn't widen your
  pull request.

## Pull requests

- **One issue, one branch, one pull request**, branched from the latest `main` and targeting
  `main`. The description says `Closes #<issue>`.
- **Organisation-agnostic.** No company, client, person or vendor names in code, tests,
  fixtures, sample content, commit messages, issues or pull requests. Variant attributes,
  audience levels and module types are configuration, never hardcoded. Examples use invented,
  neutral names.
- **Follow the project's conventions**, in `CLAUDE.md` and the READMEs. In short, for the API:
  hexagonal (`api/`, `core/`, `repos/`, `base/`); new behaviour is a new action with a unit test
  against an in-memory fake, and a route gets its end-to-end test; JSON:API with the exact media
  type, camelCase members and errors with a stable `code`; every list is paginated; the OpenAPI
  document is generated from the controllers and the Zod schemas.
- **Settings:** every new `process.env.*` read or configuration-schema entry also goes into
  `.env.example`, with a comment saying what it is for, its format and its default.
- **Database:** a schema change comes with its drizzle-kit migration
  (`pnpm nx run api:db-generate -- --name <what>`), one per issue; a merged migration is never
  edited.
- **Texts in the UI** are translation keys, in English and German; lint and the translation
  tests refuse literal text.
- **Lists in the UI** scroll inside their own container, with the pagination outside it always
  visible, and long values wrap instead of widening the page.
- Stage files explicitly; never commit `.env*` (except `.env.example`), `.local/` or
  `docs/internal/`.
- Before you ask for a review: `pnpm check` passes on your final head, after merging the latest
  `main`. Name in the description the commit it ran on, what you checked by hand and what
  couldn't run.
- Add images where they help: a screenshot of a UI change (light and dark), a rendered PDF page
  for a template or renderer change.

### Review

Every pull request is reviewed for correctness and, separately, for security (authentication and
tokens, roles and permissions, Git writes, workflow transitions, the audit log, migrations and
template sandboxing get particular scrutiny). Critical and major findings are fixed and reviewed
again; minor ones may be listed in the description as known points instead. Answer every review
comment: fix it, or say why it doesn't apply. A maintainer merges once the review is clean and the
checks pass.

### Labels for the release notes

A release's notes are made from the titles of its merged pull requests (see "Releases" below), so
**a pull request's title is the sentence users read**: say what changed for them, not how. Write it
as a conventional commit (`feat(editor): …`, `fix: …`). Its label, or else its title's type, puts
it in a group (`.github/release.yml`):

| Group    | Label           | Or the title's type    |
| -------- | --------------- | ---------------------- |
| Security | `security`      | none: always the label |
| New      | `feature`       | `feat`                 |
| Improved | `enhancement`   | `perf`, no type        |
| Fixed    | `bug`           | `fix`, `revert`        |
| Docs     | `documentation` | `docs`                 |

- **Left out:** a pull request labelled `internal` or `chore`, a title of type `test`, `chore`,
  `ci`, `build`, `refactor` or `style`, and a title whose scopes are all the repository's own
  tooling (`workflow`, `hooks`, `ci`, `scripts`, `factory`, `board`, `agents`). Tests, CI and
  workflow tooling are internal.
- **Upgrade notes:** when an operator has to do something on upgrading (move a setting, run a
  command, expect a long migration), add a `## Upgrade notes` section to the pull request's
  description saying what, or the `upgrade-note` label. A breaking change (below) also gets the
  `breaking` label or a `!` after the type (`feat(api)!: …`). Migrations and changes to
  `.env.example` are found by themselves.
- **A security fix** gets the `security` label, and in its description a line
  `Severity: low|moderate|high|critical` and the advisory's ID (`GHSA-…`) once there is one. The
  notes show only the title, the severity and the advisory: keep exploit detail out of the title.
- The notes never name who wrote a change.

## Releases

**Versioning.** The whole product (the API, the editor, the MCP server and their images) has one
version, [semantic versioning](https://semver.org): `vX.Y.Z`.

- **Major** (`X`): a breaking change. One that makes an existing client, installation or
  content stop working without a change on their side: a route, parameter, attribute or error
  code of the API removed or changed in meaning; a setting removed or renamed, or its default
  changed so an installation behaves differently; a change to the import format or to
  `openfolia.yaml` that an existing bundle or content repository no longer passes; a migration that
  cannot run on a live database without a step of its own.
- **Minor** (`Y`): new behaviour that keeps what exists working (a new route, attribute, setting
  with a safe default, feature).
- **Patch** (`Z`): fixes only, security fixes included.

Before `v1.0.0`, a minor version may still break, and its notes say so under **Breaking changes**.

**Cutting a release.** A maintainer tags a commit of `main` with `vX.Y.Z` and pushes the tag. The
release workflow (`.github/workflows/release.yml`) then runs `node scripts/release.mjs vX.Y.Z`,
which:

- starts the notes with the release's own summary, when the tagged commit holds one (below);
- groups the pull requests merged since the previous release tag as above;
- adds **Upgrade notes**: the database migrations added since then (`backend/api/migrations/`),
  the settings added, changed or removed (`.env.example`), breaking changes and the pull
  requests' own upgrade notes, with a link to the upgrade steps in `deploy/README.md`;
- creates the GitHub Release with these notes (or updates it when run again);
- writes the release's entry into `CHANGELOG.md` and its data into `changelog/vX.Y.Z.json`, which
  the workflow proposes as a pull request to `main` (branch `release/changelog-vX.Y.Z`). The docs
  site's `/changelog` and its Atom feed (`/changelog.xml`) are built from `changelog/`, showing
  the pull requests' text as text only. **Don't edit `CHANGELOG.md` or `changelog/` by hand**:
  run the step again instead (re-running the workflow updates the Release and that pull request).

**A summary for the release.** A release can open with a few paragraphs of its own, written by a
maintainer: `release-notes/vX.Y.Z.md` in English and, optionally, `release-notes/vX.Y.Z.de.md` in
German (only beside an English one). Commit them before tagging: the step reads them from the
tagged commit. Without them, the notes are the pull requests and upgrade notes alone. The step
puts the English summary first in the GitHub Release and in `CHANGELOG.md`, and both into
`changelog/vX.Y.Z.json` (`summary: { en, de }`); the German `/changelog` shows the German one, or
the English one marked as English. A release with a summary has notes even without a pull request,
like the first one.

- **Plain text only:** paragraphs separated by a blank line, and bullets starting with `- ` (a
  bullet goes on over indented lines). No headings, HTML, MDX or Markdown links: `*`, `#`, `<`,
  `[text](url)` and the like are shown as the characters they are. `code` between a pair of
  backticks is shown as code.
- **Links** are made by the step itself, from a bare `https://` address and from a relative path of
  the repository (`deploy/README.md`, `deploy/README.md#upgrades`, `CONTRIBUTING.md`: two or more
  segments with a file extension, or a capitalised `.md` file at the root), linked to that file at
  the release's tag. Any other address (`http:`, `javascript:`, `mailto:`) stays text. The step
  refuses a summary that links to a path the tagged commit doesn't hold.
- Preview it, once committed, with `node scripts/release.mjs vX.Y.Z --dry-run --to HEAD`: the step
  reads the commit, not the working tree, and the first lines of the notes are the summary.

The workflow needs the repository setting **Allow GitHub Actions to create and approve pull
requests** (Settings, Actions, General) to open that pull request. Merge a release's changelog
pull request before tagging the next release: the step builds on `main`'s changelog, so two open
changelog pull requests would conflict.

Once every image of the tag is pushed, the images workflow (`.github/workflows/images.yml`, job
`release-files`) attaches the files the install guide for coding agents downloads (#423, #739)
to the GitHub Release: the tag's `deploy/compose.yaml`; `images.lock`, every image of the release
by its digest, as `node scripts/release-digests.mjs` reads them from the registry; the Compose
override `compose.digests.yaml` it makes from them, which pins each service's image by tag and
digest; and `SHA256SUMS` over the three. The script checks each digest against the one the build
job pushed, and the run's summary shows `images.lock`: compare it with the release's file before
building the docs. Build the release's docs (from the tag, or the commit that adds its changelog; "Publishing the docs") with
`DOCS_RELEASE=vX.Y.Z` and `DOCS_RELEASE_DIGESTS="$(cat images.lock)"` (the release's file;
`.env.example`, "Docs site"): their `/agents` then pins that release's images by their digests and
names the same SHA-256 of `compose.yaml` and of `compose.digests.yaml`. Without the workflow, a
maintainer runs
`node scripts/release-digests.mjs --images ghcr.io/<owner>/openfolia --tag vX.Y.Z --out <dir>` once
the images are pushed (it only reads the registry) and attaches the same files.

**Publishing the docs.** The docs site is an image of its own, built and pushed from a
maintainer's machine with one command (`deploy/README.md`, "The docs site"). For a release, from
a checkout of the commit that adds the release's changelog (the merged changelog pull request),
once `images.lock` is in hand (and `signatures.sha256`, when signed). The release workflow writes
`CHANGELOG.md` and `changelog/vX.Y.Z.json` after the tag, so the tag's own docs would lack the
release they are for; the command takes that commit when the tag is its ancestor and only the
changelog files differ, and refuses anything else, naming the files:

```sh
git checkout <the changelog commit>   # or vX.Y.Z itself
DOCS_SITE_URL=https://docs.example.com \
DOCS_RELEASE_DIGESTS="$(cat images.lock)" \
pnpm docs:publish --release vX.Y.Z --push
```

It tags the image `vX.Y.Z`, `latest` and `sha-<commit>` (the commit built), prints its digest, and the docs' host
redeploys `latest`. Between releases, `pnpm docs:publish --push` without `--release` publishes
the development docs (their install guide for coding agents pins no release and says so).

With the repository variable `SIGN_IMAGES` set to `true` (Settings, Secrets and variables,
Actions, Variables), the job `release-sign` also signs each image of `images.lock` by its digest
with cosign, keyless, as the workflow's own identity (#745; `deploy/README.md`, "Images signed"),
and the release gets `<image>.sigstore.json` per image, `trusted_root.json` and
`signatures.sha256`. Build that release's docs with `DOCS_RELEASE_SIGNATURES` set to the
`signatures.sha256` the signing job's run summary shows, not to the release's file alone: the
summary is written by the job that signed, while anyone who can edit the release's files could
replace the trust root and the bundles together. Compare the two before building; they must be
the same. The guide then checks the signatures before pulling. Unset, nothing is signed and the
release's files are the ones above.

To see a release's notes before tagging it: `node scripts/release.mjs vX.Y.Z --dry-run --to HEAD`
(`--from <ref>` for another starting point; `--changelog <file>` and `--data <dir>` to write the
changelog and the data it would make there). It needs `gh` signed in. Without the workflow, a
maintainer runs `node scripts/release.mjs vX.Y.Z` after pushing the tag and commits
`CHANGELOG.md` and `changelog/`.

## Licence of contributions

Contributions are accepted under the project's licence, the GNU Affero General Public License,
version 3 only (AGPL-3.0-only, [`LICENSE`](LICENSE)): what you contribute is licensed to everyone
under the same terms you received the code under ("inbound = outbound"). There is nothing to sign.
You keep the copyright in your contribution; only submit work you have the right to license this
way.

Everything in the repository is under that one licence, so the same terms hold wherever you
contribute.

<!--
For maintainers: contributions are taken as AGPL-3.0-only, with no further grant. If outside
contributions start, revisit a contributor agreement or a Developer Certificate of Origin (DCO)
before accepting them.
-->

## Questions

Ask in the issue you are working on, or open a new issue.
