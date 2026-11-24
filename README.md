<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/openfolia-lockup-horizontal-color-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/brand/openfolia-lockup-horizontal-color-light.svg">
    <img alt="OpenFolia" src="docs/assets/brand/openfolia-lockup-horizontal-color-light.svg" width="360">
  </picture>
</h1>

<p align="center">
  Modular documentation in Git, assembled into manuals for every variant and language.
</p>

<p align="center">
  <a href="https://openfolia.com"><strong>Website</strong></a>
  &nbsp;·&nbsp;
  <a href="https://docs.openfolia.com"><strong>Docs</strong></a>
  &nbsp;·&nbsp;
  <a href="https://docs.openfolia.com/api"><strong>API reference</strong></a>
  &nbsp;·&nbsp;
  <a href="https://docs.openfolia.com/changelog"><strong>Changelog</strong></a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="Licence: AGPL-3.0" src="https://img.shields.io/badge/licence-AGPL--3.0-2f6f8f"></a>
  <a href=".nvmrc"><img alt="Node 24" src="https://img.shields.io/badge/node-24-3c873a"></a>
</p>

## What it is

OpenFolia is a documentation platform: an editor, review and releases, and a reader portal.
Content is written once as small modules in Git, then assembled into manuals for each product
variant and language. Authors work in a web editor on drafts that go through review
before they are released. Every release becomes accessible PDF and HTML, a portal for readers and
a JSON:API for other systems, so the same content reaches print, the web and your own applications.

- **Modules and variants:** reuse one module across many manuals, and let variant attributes
  decide what each manual includes.
- **Review and releases:** drafts in change sets, review and approval, and immutable,
  reproducible releases tagged in Git.
- **Outputs:** accessible PDF through Typst, HTML, a static reader portal (one per audience and
  language, with search and your organisation's branding), a JSON:API, and an MCP server for AI
  assistants over the released content. The API is one output among them.
- **Translations:** a manual per language, with XLIFF exports of what changed for a translation
  provider.
- **Self-hosted:** Postgres, S3-compatible or local file storage, and a Git repository you own.

## Try the demo

Node 24, pnpm 11 and Git; no Docker, no database server:

```sh
pnpm install
pnpm demo:start   # builds, then prints the address of the editor; open it
```

You are the author of an invented car's documentation, with a reviewer and an admin a click
away. What to click and what it shows: [Try the demo](https://docs.openfolia.com/demo).
`pnpm demo:stop` ends it.

## Quick start

```sh
pnpm install
pnpm check                    # test, lint, typecheck and build everything
docker compose up -d          # Postgres and S3-compatible storage for a local run
pnpm nx run api:setup-local   # a sample content repository and local settings
pnpm nx run api:serve-local   # the API on that sample content
```

**Running it on a server:** container images and a Compose file for Postgres, the API and the
editor, with settings, backups, upgrades and a reverse proxy with TLS:
[`deploy/README.md`](deploy/README.md).

**Names kept from before the product was named.** The settings keep their `CCMS_` prefix
(`CCMS_DATABASE_URL`, `CCMS_PUBLIC_URL`, …), so no deployment breaks; so do the API's `X-Ccms-*`
headers, the token prefixes (`ccms_sat_…`), the XLIFF namespace and the database names. A content
repository's configuration is `openfolia.yaml`; one that still has `ccms.yaml` is read for one more
release, with a deprecation warning (`openfolia.yaml` wins when both exist). The command names
`ccms-mcp`, `ccms-tracker-connector` and `ccms-wiki-markup` still start the `openfolia-*` ones for
one release.

## Run the portal

The portal is a static site of the released manuals for one audience, built from the API with a
read-only service token and served by any web server. With the local API running:

```sh
CCMS_PORTAL_API_URL=http://127.0.0.1:3100 \
CCMS_PORTAL_TOKEN=<a service token with only content.read> \
CCMS_PORTAL_AUDIENCE=public \
pnpm nx run portal:site                  # builds into frontend/portal/dist
npx serve frontend/portal/dist -l 4330   # then open http://localhost:4330
```

Use your own API's address (`PORT`, default 3100). A self-hosted stack runs it as a Compose
profile instead, rebuilt after each release: `deploy/self-host.sh --portal`
([With Docker Compose](https://docs.openfolia.com/guide/portal/compose)). The settings, branding and hosting are in the
[portal guide](https://docs.openfolia.com/guide/portal); the project's own README is
[`frontend/portal/README.md`](frontend/portal/README.md).

## Documentation

- **Using and running OpenFolia:** the documentation site, [docs.openfolia.com](https://docs.openfolia.com),
  with the [API reference](https://docs.openfolia.com/api).
- **Working on the code:** [`CLAUDE.md`](CLAUDE.md) maps the projects in this monorepo, and each
  project's `README.md` describes its API:
  - [API](backend/api/README.md), [MCP server](backend/mcp/README.md) and [sandbox database](backend/sandbox/README.md);
  - [content model](packages/content-model/README.md),
    [content repository](packages/content-repo/README.md),
    [editor model](packages/content-editor-model/README.md),
    [PDF renderer](packages/render-typst/README.md),
    [HTML renderer](packages/render-html/README.md), [XLIFF](packages/xliff/README.md),
    [DITA](packages/dita/README.md) and [XML reader](packages/xml/README.md);
  - [editor](frontend/editor/README.md), [UI components](frontend/ui/README.md) and
    [theme](frontend/theme/README.md).

## Contributing

- [Contributing](CONTRIBUTING.md): setup, how work is planned, what a pull request needs.
- [Code of conduct](CODE_OF_CONDUCT.md).
- [Security policy](SECURITY.md): report a vulnerability privately, never in an issue.

## Licence

Copyright (C) 2026 The project authors.

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU Affero General Public License, version 3 only (AGPL-3.0-only), as published by the Free
Software Foundation; see [`LICENSE`](LICENSE). It is distributed in the hope that it will be
useful, but without any warranty; without even the implied warranty of merchantability or fitness
for a particular purpose.

- **Running it as a service:** AGPL-3.0 section 13 asks a modified version that people use over a
  network to offer them its source. Set `CCMS_SOURCE_URL` (`.env.example`) to where your
  version's source is: the API names it at `GET /about` and the editor links to it.
- **One licence for all of it:** every part of the repository, and every feature, is under
  AGPL-3.0-only.
- **Third-party software:** [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) lists the
  dependencies the project ships and their licences; `pnpm check` fails on one whose licence is
  not allowed with AGPL-3.0-only (`pnpm licences`, `scripts/licence-policy.json`).
