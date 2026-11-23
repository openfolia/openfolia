# Import connectors

Optional tools that bring content from other tools into the platform (#141). The core knows no
particular tool: the only interface between a connector and the core is the documented import
format (`@openfolia/content-model`, `packages/content-model/docs/import-format.md`) and the import
routes of the API (`backend/api/README.md`, "Imports"). A connector produces a bundle of that
format; the API checks it against the target branch and writes it into a change set, which is
reviewed like any other. Nothing a connector brings in is published without that review.

| Folder         | Nx project              | What                                                                                                                                                          |
| -------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wiki-markup/` | `connector-wiki-markup` | one-off migration: pages of a generic wiki markup → an import bundle, reporting every unconverted construct                                                   |
| `tracker/`     | `connector-tracker`     | recurring import, a sample: items of an issue tracker → a bundle → the import API → a change set in review; on a schedule or a signed trigger from the source |

- **Separate.** Each is an Nx project of its own, tagged `type:connector`: it may build on the
  content model and other connectors, and nothing in the core imports one (lint: the root
  `eslint.config.mjs` and `backend/api/eslint.config.mjs`). Only the API's end-to-end test drives
  the tracker connector against the real API (`backend/api/tests/import-connectors.e2e.spec.ts`).
- **Mapping is configuration.** Which source fields become which module type, audience, facet or
  variant is a mapping file per connector, checked against the target's `openfolia.yaml` when the
  bundle is validated. Nothing about a target or a source tool is built in.
- **No calls nobody configured.** No telemetry. The wiki-markup converter reads and writes local
  files only; the tracker connector calls the one API address it is given, and its sample source
  reads a local file.
- **Writing another one:** produce the import format (its "Writing a converter" section), keep each
  item's source ID in `meta.source`, fall back to `passthrough` and put whatever was lost into the
  bundle's `report`. The tracker connector's `ItemSource` is the place for a real tracker's API
  client, with an address and credential the person configures.
