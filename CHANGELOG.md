# Changelog

Every release, newest first: what is new, improved and fixed, the security fixes, and what to do
when you upgrade. `scripts/release.mjs` writes this file on each release tag, with the same notes
as the release on GitHub (CONTRIBUTING.md, "Releases"); don't edit it by hand.

<!-- release v0.0.6 2026-11-26 -->
## [v0.0.6](https://github.com/openfolia/openfolia/releases/tag/v0.0.6) (2026-11-26)

OpenFolia v0.0.6 is mostly refactoring inside the API, with no change to what people see or what the API answers, and one change to SAML sign-in: answers from many addresses at once can no longer crowd out everyone else's.

- SAML sign-in: the answers from one network (an IPv4 /24, an IPv6 /48) are checked one at a time, so one network can never hold all the server's SAML checks and an answer from anywhere else is still checked within the time limit. At most 8 answers of one network, and 3 from one address, wait their turn; one beyond that is refused with "The sign-in service could not be reached", is not counted as a failed sign-in, and is logged once per network. Behind a reverse proxy, CCMS\_TRUST\_PROXY must be set as the guide says, or every answer seems to come from one network. The guide: [https://docs.openfolia.com/guide/self-hosting/saml](https://docs.openfolia.com/guide/self-hosting/saml)
- Refactoring: each part of the API now registers its own permissions, webhook events (and how each event is built and who may see it), audit actions, notification kinds and settings, and the database schema is split into one file per part. Permission names, roles, webhook payloads, notification choices, settings, the API and its OpenAPI document are unchanged.
- Database: a command writes a baseline migration for a chosen set of components into a folder of your choice, for a fresh database (`pnpm nx run api:db-baseline`, [backend/api/README.md](https://github.com/openfolia/openfolia/blob/v0.0.6/backend/api/README.md) "Database"). Existing migrations are unchanged, and no new one runs at start-up.

Upgrading: nothing to do beyond the usual. Take a backup first and follow [deploy/README.md#upgrades](https://github.com/openfolia/openfolia/blob/v0.0.6/deploy/README.md#upgrades). If people sign in with SAML through a reverse proxy, check CCMS\_TRUST\_PROXY before upgrading.

### Docs

- The changelog of v0.0.5 ([#5](https://github.com/openfolia/openfolia/pull/5))

### Upgrade notes

From v0.0.5: take a backup first and follow [Upgrades](https://github.com/openfolia/openfolia/blob/v0.0.6/deploy/README.md#upgrades) in deploy/README.md.

Nothing else to do: no migration, no changed setting.
<!-- /release v0.0.6 -->

<!-- release v0.0.5 2026-11-26 -->
## [v0.0.5](https://github.com/openfolia/openfolia/releases/tag/v0.0.5) (2026-11-26)

OpenFolia now fits into an organisation's own sign-in: people sign in with SAML 2.0 as well as OpenID Connect, a directory provisions them with SCIM 2.0, and an administrator can require single sign-on. People who sign in here can add a second factor, notifications come by email, and the portal serves older releases beside the newest.

- Sign-in: SAML 2.0 beside OpenID Connect, with the same users, sessions, group-to-role mappings and audit. The identity provider's metadata is read from an https address or a file (CCMS\_SAML\_IDP\_METADATA\_URL or CCMS\_SAML\_IDP\_METADATA\_FILE), and this server serves its own for the provider. Every answer must carry the installation's one name ID format (CCMS\_SAML\_NAME\_ID\_FORMAT, default persistent). Sign-in begun at the provider is off unless CCMS\_SAML\_IDP\_INITIATED is true. Single logout and encrypted assertions are not supported. The guide: [https://docs.openfolia.com/guide/self-hosting/saml](https://docs.openfolia.com/guide/self-hosting/saml)
- SCIM: a directory creates, updates and deactivates users, and keeps groups and their members, over SCIM 2.0 at /api/scim/v2, with the token of a service account whose role holds the new scim.provision permission. A deactivation takes effect at once: sessions end and locks are released, while the person's revisions stay; users are never deleted. A provisioned group maps to roles like an identity provider's group, but never gives a role with a global permission. Every change is in the audit log.
- Single sign-on required: under Admin › Project settings › Installation › Single sign-on and sessions, an administrator can require sign-in through the identity provider. Passwords, codes by email, invites and reset links are then refused, except the password of one emergency account; each of its uses is recorded and sent to every administrator as a notification and an email. Turning it on ends the sessions that are no longer allowed, and it is refused while it would lock out the person making the change, or while a SAML provider whose metadata comes from an address does not answer with valid metadata. The same page sets how long a session may stay idle and how long it may last; a tab left open no longer keeps a session alive. When a session ends, the editor says why and gives back a module's unsaved text after signing in again.
- Two-factor sign-in: people who sign in with a password or a code by email can add an authenticator app, with recovery codes, from the account menu. An administrator can require it for administrators or for everyone (Admin › Project settings › Installation › Two-factor sign-in) and reset a person's second factor in Admin › Users; a command on the server resets the last administrator's. With an identity provider, the second factor is the provider's.
- Notifications by email: under Account menu › Notifications each person chooses, for each kind of notification, off, in the app only, email at once or a daily summary at their own hour and time zone, and can pause all email. Emails come in English or German with a one-click unsubscribe, and emails at once beyond an hourly cap per person wait for the summary (CCMS\_NOTIFICATIONS\_DIGEST\_HOUR, default 8; CCMS\_NOTIFICATIONS\_EMAILS\_PER\_HOUR, default 20). Admin › System › Mail lists the emails that failed for good. Without a mail server, no email is queued and the page says why.
- People: a deactivated person's work keeps their name, marked "(deactivated)", in history, review and comments, releases, translation jobs, the audit log and the notifications, until they are reactivated.
- Portal: older releases. With CCMS\_PORTAL\_RELEASES\_PER\_PRODUCT (1 to 20; the default 1 builds the site as before) the portal builds each product's newest releases, and CCMS\_PORTAL\_RELEASES may now name several releases of one product. An older release has addresses of its own and a search of its own, starts with a notice that links to the latest, and is kept out of search engines unless CCMS\_PORTAL\_OLDER\_NOINDEX is off. A release switch in the manual's colophon changes the release and keeps the manual, the variant, the section being read and an update guide's range. Each release has a page with its date, its notes and its manuals.
- Portal: a start page written in OpenFolia. A manual named by CCMS\_PORTAL\_START gives the start page its heading, introduction, a notice and featured links as cards, to sections, manuals, update guides, searches, older releases or other addresses; it is reviewed and released like any manual. CCMS\_PORTAL\_URL is the portal's own address, so a link copied from the portal is checked too, and a link the audience may not read is left out. Without CCMS\_PORTAL\_START the start page is as before.
- MCP: the shared CCMS\_MCP\_HTTP\_TOKEN is removed, as announced in v0.0.4. Every HTTP caller sends its own service account token; while the old setting is still set, the MCP server refuses to start and says why.
- Review: while an approved revision's approval has lapsed (its approver lost the role or was deactivated), the review panel blocks Merge and says why, and marks the approval it waits for.
- Revisions: a preview, a PDF or a manual opened at the moment a revision's changes are committed no longer shows "not found" or the text from before. Marking a translation as current no longer overwrites a save point committed meanwhile; it is refused instead.
- Docs: the docs site's search loads only the reader's language when it opens, about a third of the download before, and shows a loading state, and an error with "Try again".
- Demo: the software update guide is an owner guide, so the shared demo portal shows it; its two technician steps moved to the service booklet.
- Security: sign-in through an identity provider now keeps out a deactivated person whose account at the provider changed, by an address the provider vouches for. SAML answers are checked apart from the rest of the server and within a time limit, so no answer can hold the server up. How linking by address works: [https://docs.openfolia.com/guide/self-hosting/saml](https://docs.openfolia.com/guide/self-hosting/saml)

Breaking: CCMS\_MCP\_HTTP\_TOKEN is removed (v0.0.4 announced it). Before upgrading, give every MCP caller its own service account token (Admin › Service accounts) and remove CCMS\_MCP\_HTTP\_TOKEN and CCMS\_MCP\_HTTP\_TOKEN\_FILE from the settings. To upgrade from v0.0.4, take a backup first and follow [deploy/README.md#upgrades](https://github.com/openfolia/openfolia/blob/v0.0.5/deploy/README.md#upgrades); the database migrations run at start-up. Earlier versions could make a new user at sign-in for a deactivated person whose account at the provider had changed, and those users stay active: review the users created by sign-in after a deactivation, and deactivate them if needed.

### Docs

- The changelog of v0.0.4 ([#4](https://github.com/openfolia/openfolia/pull/4))

### Upgrade notes

From v0.0.4: take a backup first and follow [Upgrades](https://github.com/openfolia/openfolia/blob/v0.0.5/deploy/README.md#upgrades) in deploy/README.md.

**Database migrations** (the API applies them when it starts, unless `CCMS_DATABASE_MIGRATE=false`; see [Upgrades](https://github.com/openfolia/openfolia/blob/v0.0.5/deploy/README.md#upgrades)):

- `0064_saml_seen_assertions`
- `0065_scim`
- `0066_notification_emails`
- `0067_second_factors`
- `0068_enforced_sso`

**Settings** (see [.env.example](https://github.com/openfolia/openfolia/blob/v0.0.5/.env.example)):

- New: `CCMS_SAML_IDP_METADATA_URL`, `CCMS_SAML_IDP_METADATA_FILE`, `CCMS_SAML_SP_ENTITY_ID`, `CCMS_SAML_NAME`, `CCMS_SAML_NAME_ID_FORMAT`, `CCMS_SAML_EMAIL_ATTRIBUTE`, `CCMS_SAML_NAME_ATTRIBUTE`, `CCMS_SAML_GROUPS_ATTRIBUTE`, `CCMS_SAML_EMAIL_VERIFIED`, `CCMS_SAML_IDP_INITIATED`, `CCMS_NOTIFICATIONS_DIGEST_HOUR`, `CCMS_NOTIFICATIONS_EMAILS_PER_HOUR`, `CCMS_PORTAL_RELEASES_PER_PRODUCT`, `CCMS_PORTAL_OLDER_NOINDEX`, `CCMS_PORTAL_START`, `CCMS_PORTAL_URL`
- Changed description or example: `CCMS_AUTH_FAILURES_MAX`, `CCMS_EDITOR_URL`, `CCMS_SESSION_IDLE_MINUTES`, `CCMS_PASSWORD_FAILURES_MAX`, `CCMS_MCP_API_TOKEN`, `CCMS_PORTAL_RELEASES`
- Removed: `CCMS_MCP_HTTP_TOKEN`, `CCMS_MCP_HTTP_TOKEN_FILE`
<!-- /release v0.0.5 -->

<!-- release v0.0.4 2026-11-25 -->
## [v0.0.4](https://github.com/openfolia/openfolia/releases/tag/v0.0.4) (2026-11-25)

OpenFolia now writes update guides: one manual that tells a reader what to do before, during and after an update, filtered to the versions they update between. A new tour ends in the reader's own first edit, and every MCP caller brings their own token, so the audit log names who read what.

- Update guides: a new kind of manual. It follows a version attribute, and each step is a module with the version that needs it, a phase (before, during or after the update), and optionally an audience level and a condition on the product's options. The editor creates one from "New manual", lists the steps by version and phase, reorders and edits them in a revision, and previews any from/to range as a reader will see it. The API serves the guide and its steps for a range, the PDF groups them by version and phase, and the checks flag a step without a valid version or phase.
- Portal: an update guide's page has from/to pickers and option filters, and shows the steps for that range as a checklist that remembers its ticks. The address keeps the choice, so a link opens on the same steps. Without JavaScript it shows every step.
- Portal: code blocks have a copy button that copies the exact text, says so, and selects the text when the clipboard is refused. Searching from the header no longer scrolls the manual page.
- Tour: the first-run tour is task-led. It opens a module, makes a first edit in a revision of the reader's own, explains the revision picker and ends at review. Its card points at what it explains and stays beside it when the list moves. It can be replayed, and steps through with the arrow keys. A tip explains variant blocks the first time one is shown.
- Editor: the module editor's columns follow the room the window leaves: three columns on a wide screen, two with the outline as a tab of the side panel, stacked below that. At phone width the toolbar sticks to the top and the caret stays clear of it.
- Manuals: a glossary term's tooltip shows whole inside a safety notice, a table or an FAQ.
- MCP: every HTTP caller sends its own service account token (a role holding content.read only), made in Admin › Service accounts and checked by the API on every read. The shared CCMS\_MCP\_HTTP\_TOKEN still works in this release and is removed in v0.0.5.
- Audit: reads by service accounts (MCP and API tokens) are recorded as api.read events naming the caller, kept for CCMS\_AUDIT\_READ\_KEEP\_DAYS (default 90) days.
- Demo: the sandbox launcher caps a sandbox's requests in flight (CCMS\_LAUNCHER\_MAX\_IN\_FLIGHT), and an editor's own files no longer use up a sandbox's request rate. A sandbox that fails to start shows an error instead of a blank page.
- Images: the release's merge step retries a registry that hasn't caught up with its push.

To upgrade from v0.0.3, follow "Upgrades" in [deploy/README.md](https://github.com/openfolia/openfolia/blob/v0.0.4/deploy/README.md); the database migration runs at start-up. If an MCP service uses CCMS\_MCP\_HTTP\_TOKEN, move each caller to its own service account token before v0.0.5.

### Docs

- The changelog of v0.0.3 ([#3](https://github.com/openfolia/openfolia/pull/3))

### Upgrade notes

From v0.0.3: take a backup first and follow [Upgrades](https://github.com/openfolia/openfolia/blob/v0.0.4/deploy/README.md#upgrades) in deploy/README.md.

**Database migrations** (the API applies them when it starts, unless `CCMS_DATABASE_MIGRATE=false`; see [Upgrades](https://github.com/openfolia/openfolia/blob/v0.0.4/deploy/README.md#upgrades)):

- `0063_audit_read_events`

**Settings** (see [.env.example](https://github.com/openfolia/openfolia/blob/v0.0.4/.env.example)):

- New: `CCMS_LAUNCHER_MAX_IN_FLIGHT`, `CCMS_AUDIT_READ_KEEP_DAYS`
- Changed description or example: `CCMS_LAUNCHER_RATE`, `CCMS_AUDIT_KEEP_DAYS`, `CCMS_MCP_API_TOKEN`, `CCMS_MCP_HTTP_TOKEN`
<!-- /release v0.0.4 -->

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
