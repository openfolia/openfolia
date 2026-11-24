# Changelog

Every release, newest first: what is new, improved and fixed, the security fixes, and what to do
when you upgrade. `scripts/release.mjs` writes this file on each release tag, with the same notes
as the release on GitHub (CONTRIBUTING.md, "Releases"); don't edit it by hand.

<!-- release v0.0.3 2026-11-24 -->
## [v0.0.3](https://github.com/openfolia/openfolia/releases/tag/v0.0.3) (2026-11-24)

OpenFolia now runs on Arm servers, and it can be tried without installing it: a public sandbox mode gives every visitor of a demo an OpenFolia of their own, deleted after the session. The reader portal gets a search that answers as you type and a variant switch that says what it does.

- Images: every image is built for both amd64 and arm64, natively on each, as one multi-platform image. The same compose.yaml runs on an x86 server, an Arm server or an Apple silicon Mac.
- Sandbox: a public sandbox mode (CCMS\_PUBLIC\_SANDBOX=on) for a throwaway instance open to anyone: no outbound connections, no users or tokens, no uploads, caps on what can be written, and a banner with the time left. The sandbox image runs it with a finished demo baked in, ready in a few seconds.
- Demo: the sandbox launcher starts one sandbox per visitor behind a start page, with a proof-of-work, per-address limits and a cap, each sandbox on its own network with no route out. A visitor can end their sandbox from its banner; when it ends or expires, the start page thanks them and can offer to book a demo. [deploy/compose.demo.yaml](https://github.com/openfolia/openfolia/blob/v0.0.3/deploy/compose.demo.yaml) runs the launcher, its agent, a shared read-only demo portal and TLS on one host.
- Portal: a typeahead on the search fields shows the best passages as you type, with full keyboard support. The search page and the typeahead share one search.
- Portal: when a manual isn't published in every combination of its variant attributes, the variant switch says so before the click ("only as Electric") and, after it, which other setting changed. Switching between variants no longer blanks the page.
- Portal: search excerpts no longer run a glossary term into its definition.
- Editor: a revision with no changes against its base shows that, without an empty diff's view switch and legend.
- MCP: the editor serves the MCP server at /mcp on its own address, so an assistant connects to https\://&lt;your address&gt;/mcp with the instance's MCP token. The MCP server believes a forwarded client address only from the proxies named in CCMS\_MCP\_HTTP\_PROXY\_ADDRESSES.
- Docs: a full MCP page (address, token, client setups, tools and resources, troubleshooting), and the docs now start from using an OpenFolia someone runs for you, with running it yourself as the second path. The API reference's server is [https://{host}/api](https://{host}/api) with the host editable, never localhost.
- German: the interface says Anleitung, the glossary term, throughout.
- Security: [SECURITY.md](https://github.com/openfolia/openfolia/blob/v0.0.3/SECURITY.md) now states which versions get security fixes: the latest release and main.

To upgrade from v0.0.2, follow "Upgrades" in [deploy/README.md](https://github.com/openfolia/openfolia/blob/v0.0.3/deploy/README.md). An installation that runs the MCP service becomes reachable at the editor's address plus /mcp, behind the same token; the sandbox mode and the demo are separate deployments.

### Docs

- The changelog of v0.0.2 ([#1](https://github.com/openfolia/openfolia/pull/1))

### Upgrade notes

From v0.0.2: take a backup first and follow [Upgrades](https://github.com/openfolia/openfolia/blob/v0.0.3/deploy/README.md#upgrades) in deploy/README.md.

**Settings** (see [.env.example](https://github.com/openfolia/openfolia/blob/v0.0.3/.env.example)):

- New: `CCMS_PUBLIC_SANDBOX`, `CCMS_SANDBOX_IDLE_MINUTES`, `CCMS_SANDBOX_MAX_MINUTES`, `CCMS_SANDBOX_MAX_MODULE_BYTES`, `CCMS_SANDBOX_MAX_COMMENT_LENGTH`, `CCMS_SANDBOX_MAX_CHANGE_SETS`, `CCMS_SANDBOX_MAX_MODULES`, `CCMS_SANDBOX_MAX_MANUALS`, `CCMS_SANDBOX_RELEASES_PER_HOUR`, `CCMS_SANDBOX_RENDER_JOBS`, `CCMS_SANDBOX_MAX_WRITE_BYTES`, `CCMS_SANDBOX_PORTAL_URL`, `CCMS_SANDBOX_END_URL`, `CCMS_SANDBOX_LANG`, `CCMS_LAUNCHER_PUBLIC_URL`, `CCMS_LAUNCHER_AGENT_TOKEN`, `CCMS_LAUNCHER_AGENT_URL`, `CCMS_LAUNCHER_HOST`, `CCMS_LAUNCHER_PORT`, `CCMS_LAUNCHER_TRUST_PROXY`, `CCMS_LAUNCHER_PROXY_ADDRESSES`, `CCMS_LAUNCHER_ADDRESS_SECRET`, `CCMS_LAUNCHER_MAX_SANDBOXES`, `CCMS_LAUNCHER_IDLE_MINUTES`, `CCMS_LAUNCHER_MAX_MINUTES`, `CCMS_LAUNCHER_PER_ADDRESS`, `CCMS_LAUNCHER_PER_ADDRESS_DAILY`, `CCMS_LAUNCHER_POW_BITS`, `CCMS_LAUNCHER_RATE`, `CCMS_LAUNCHER_START_TIMEOUT`, `CCMS_LAUNCHER_HOMEPAGE_URL`, `CCMS_LAUNCHER_DOCS_URL`, `CCMS_LAUNCHER_IMPRINT_URL`, `CCMS_LAUNCHER_PRIVACY_URL`, `CCMS_LAUNCHER_PORTAL_URL`, `CCMS_LAUNCHER_BOOKING_URL`, `CCMS_LAUNCHER_ABUSE_CONTACT`, `CCMS_LAUNCHER_FILMS_DIR`, `CCMS_LAUNCHER_AGENT_HOST`, `CCMS_LAUNCHER_AGENT_PORT`, `CCMS_LAUNCHER_DOCKER_SOCKET`, `CCMS_LAUNCHER_SANDBOX_IMAGE`, `CCMS_LAUNCHER_CONTAINER`, `CCMS_LAUNCHER_INSTANCE`, `CCMS_LAUNCHER_SANDBOX_MEMORY`, `CCMS_LAUNCHER_SANDBOX_CPUS`, `CCMS_LAUNCHER_SANDBOX_TMPFS`, `CCMS_LAUNCHER_SANDBOX_PIDS`, `CCMS_MCP_HTTP_TRUST_PROXY`, `CCMS_MCP_HTTP_PROXY_ADDRESSES`, `OPENFOLIA_DEMO_HOST`, `OPENFOLIA_DEMO_PORTAL_HOST`, `OPENFOLIA_DEMO_DOCKER_GID`, `CCMS_EDITOR_MCP_URL`
- Changed description or example: `CCMS_EDITOR_PORT`
- Removed: `DOCS_API_BASE_URL`
<!-- /release v0.0.3 -->

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
