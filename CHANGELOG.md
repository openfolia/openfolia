# Changelog

Every release, newest first: what is new, improved and fixed, the security fixes, and what to do
when you upgrade. `scripts/release.mjs` writes this file on each release tag, with the same notes
as the release on GitHub (CONTRIBUTING.md, "Releases"); don't edit it by hand.

<!-- release v0.0.2 2026-11-24 -->
## [v0.0.2](https://github.com/openfolia/openfolia/releases/tag/v0.0.2) (2026-11-24)

The reader portal now runs as part of a self-hosted OpenFolia. Until this release it was static files you built by hand from a checkout of the repository; now the stack can run it for you and keep it current.

- Portal: a portal image and an optional portal Compose profile. It builds the portal from the API with a read-only token, serves it on its own port (8090 by default), sends the security headers a portal needs, and shows each new release within a few minutes without a restart. A failed build keeps the last good one online, and withdrawn content is taken down.
- Portal: [deploy/self-host.sh](https://github.com/openfolia/openfolia/blob/v0.0.2/deploy/self-host.sh) --portal sets it up in one step: a read-only role and service account for the audience you choose, its token stored in the stack's settings and never shown, and the portal's address printed next to the editor's.
- Docs: a Portal section of its own in the user guide (overview, build and preview, branding, hosting, and running it with Docker Compose). The old portal page forwards to it.
- Docs: a release's documentation now includes that release in its changelog.

To upgrade from v0.0.1, follow "Upgrades" in [deploy/README.md](https://github.com/openfolia/openfolia/blob/v0.0.2/deploy/README.md). The portal is optional: without the portal profile, nothing changes.

### Upgrade notes

From v0.0.1: take a backup first and follow [Upgrades](https://github.com/openfolia/openfolia/blob/v0.0.2/deploy/README.md#upgrades) in deploy/README.md.

**Settings** (see [.env.example](https://github.com/openfolia/openfolia/blob/v0.0.2/.env.example)):

- New: `OPENFOLIA_PORTAL_PORT`, `CCMS_PORTAL_HTTP_HOSTS`, `CCMS_PORTAL_REFRESH_SECONDS`, `CCMS_PORTAL_TOKEN_FILE`
- Changed description or example: `OPENFOLIA_IMAGES`, `OPENFOLIA_EDITOR_PORT`, `CCMS_PORTAL_API_URL`
<!-- /release v0.0.2 -->

<!-- release v0.0.1 2026-11-24 -->
## [v0.0.1](https://github.com/openfolia/openfolia/releases/tag/v0.0.1) (2026-11-24)

The first release of OpenFolia, a documentation platform. You write content once, as small modules in a Git repository, and OpenFolia assembles it into manuals for each product variant and language. Writers work in a web editor, every change is reviewed before it is released, and the same content reaches print, a portal, other systems and AI assistants. This release is for trying OpenFolia and running it yourself. It covers:

- Writing: a web editor for modules with headings, lists, tables, procedures, safety notices with their symbols, images with numbered callouts, attachments and module references. Autosave, save points, history and a live preview per language and variant.
- Writing: snippets for repeated text, a terminology list with forbidden and deprecated terms, and terminology and style checks as you type.
- Variants and manuals: variant attributes and their values are configuration, not code. A block, a module or a row of a manual can carry a condition, and the preview shows what each variant gets.
- Variants and manuals: a manual is an outline of modules with its audience, variant builds and page design. A derived manual, such as a safety leaflet, gathers the safety content of another manual and follows its changes.
- Review and releases: changes are made in revisions, each on its own Git branch. They are submitted for review, compared side by side or as rendered text, commented per block, approved, signed off and merged. Small teams can allow authors to approve their own changes.
- Review and releases: checks before a release (broken references, missing images, outdated translations, accessibility, layout). A release pins one commit of the content, renders its files in the background, keeps stable addresses and QR codes per product, variant and language, and can be withdrawn.
- Translations: the translation status per module and language, a delta export as XLIFF 2.0 or as a COTI package, and imports checked unit by unit and committed through a revision. Right-to-left languages in the editor, the HTML and the PDF.
- Output: reproducible, tagged PDF (PDF/UA-1) rendered with Typst, with page designs, fonts, covers and an imprint set up in the editor, or a sandboxed Typst template of your own.
- Output: a static portal per audience and language with search, an offline package per release, and exports as iiRDS and DITA 1.3.
- Output: a JSON:API for released content with its OpenAPI description, a change feed, signed webhooks and hybrid search, and an MCP server that gives AI assistants read access to released content.
- Running it: container images for the API, the editor, the MCP server and backups, a Compose file and a quick start with one command ([deploy/self-host.sh](https://github.com/openfolia/openfolia/blob/v0.0.1/deploy/self-host.sh)). Postgres for operational state, files on disk or in S3-compatible storage, and encrypted backups you can verify and restore.
- Running it: sign-in with OpenID Connect, with email and password, or with one-time codes by email. Roles and scopes, service accounts with tokens, and an audit log you can export or send to a log server.
- Running it: the editor and the documentation are in English and German. The install and upgrade steps are in [deploy/README.md](https://github.com/openfolia/openfolia/blob/v0.0.1/deploy/README.md), the full documentation at [https://docs.openfolia.com](https://docs.openfolia.com/).

### Upgrade notes

The first release: there is nothing to upgrade from. To install it, follow the quick start in [deploy/README.md](https://github.com/openfolia/openfolia/blob/v0.0.1/deploy/README.md).
<!-- /release v0.0.1 -->
