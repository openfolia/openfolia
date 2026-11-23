# The import format, version 1

Content from any source system reaches the platform through one documented format: an **import
bundle**. A converter, written and run outside this repository, turns an export of the source
system into a bundle; `validateImport` checks the bundle against the target repository before
anything is imported and says what is wrong, item by item. No converter for a particular system
ships here.

- The JSON Schema of `import.json`: [`import-format.schema.json`](../import-format.schema.json)
  (draft 2020-12, exported by the package as `@openfolia/content-model/import-format.schema.json`).
  It is generated from the Zod schema `ImportDocument`; a test fails when the two drift
  (`pnpm nx run content-model:import-schema` writes it again).
- An example bundle: [`src/fixtures/import-example/`](../src/fixtures/import-example/) (an
  invented organisation and source system).

## The bundle

A ZIP archive holding:

| Path              | What                                                                    |
| ----------------- | ----------------------------------------------------------------------- |
| `import.json`     | the content: modules, manuals, where they came from, what didn't map    |
| `assets/<sha256>` | every image and attachment file, named by the SHA-256 of its bytes only |

`<sha256>` is 64 lowercase hex characters and nothing else: no extension, no folders below
`assets/`. A block refers to the file as `sha256:<sha256>`. Each file is in the archive once,
however many blocks use it. Any other file in the archive is ignored with a warning.

`import.json` is UTF-8 JSON (a byte order mark is allowed). Limits on the archive itself (its
size, the number of files, a file's size) are the importing system's settings, not the format's.

## `import.json`

```json
{
  "formatVersion": 1,
  "source": { "system": "Example Wiki 4", "exportedAt": "2026-11-02" },
  "modules": [
    { "schemaVersion": 1, "id": "tank-filling", "meta": {}, "blocks": [] }
  ],
  "manuals": [],
  "report": []
}
```

| Field           | Required | What                                                                        |
| --------------- | -------- | --------------------------------------------------------------------------- |
| `formatVersion` | yes      | `1`, this format's version                                                  |
| `source`        | no       | where the content came from, for the people reading the report (below)      |
| `modules`       | yes      | the modules, in any language, as content-model `Module` JSON (may be empty) |
| `manuals`       | no       | the manuals, as manifests; default none                                     |
| `report`        | no       | what the converter could not map, per source item; default none             |

No other member is allowed at this level, in `source`, in a report entry or in a manual (its entries and attribute values included): one is an `invalid-schema` error at its pointer. Inside modules (and conditions), an unknown member is an `unknown-field` warning and is ignored.

### `source`

Free text, one line each, never interpreted.

| Field         | Required | What                                                                     |
| ------------- | -------- | ------------------------------------------------------------------------ |
| `system`      | yes      | the source system, e.g. `Example Wiki 4` (at most 200 characters)        |
| `exportedAt`  | no       | when the export was made, as the converter knows it (at most 200)        |
| `description` | no       | anything else worth knowing, e.g. which part was exported (at most 1000) |

### `report`

One entry per source item the converter could not map, or mapped only partly. The validator
passes the entries through unchanged for the import's report.

| Field        | Required | What                                                                  |
| ------------ | -------- | --------------------------------------------------------------------- |
| `sourceId`   | yes      | the item's ID in the source system (one line, at most 500)            |
| `sourceKind` | no       | what the item was in the source, e.g. `page` or `table` (at most 100) |
| `message`    | yes      | what was lost or changed, for a person to follow up (at most 4000)    |
| `module`     | no       | the module the item ended up in, if any                               |
| `block`      | no       | the block in that module, if any                                      |

### Modules

Each entry of `modules` is one module in one language, exactly the content model's `Module`
(`packages/content-model/README.md` describes it in full). A translation is the same `id` with
another `meta.lang` and the same block IDs as the source language's module. The pair `id` and
`meta.lang` is unique in a bundle.

| Field           | What                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `schemaVersion` | the model's version, `1`                                                                           |
| `id`            | the module ID, a lowercase slug (`tank-filling`, at most 100 characters); it becomes the file name |
| `meta`          | the metadata, below                                                                                |
| `blocks`        | the content, a list of blocks (below)                                                              |

`meta`:

| Field        | What                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `title`      | the module's title, one line                                                                                                            |
| `type`       | one of the target's configured module types                                                                                             |
| `lang`       | a BCP 47 language tag, the source or a target language of the target                                                                    |
| `audience`   | optional, one of the configured audience levels                                                                                         |
| `facets`     | optional, configured facet → list of its values, e.g. `{ "product-line": ["lifters"] }`                                                 |
| `keywords`   | optional, free keywords in the module's language (at most 32, each at most 64 characters, no comma)                                     |
| `source`     | **set it**: `{ "system": "…", "id": "…" }`, the source system and the item's ID there, for traceability                                 |
| `deprecated` | optional: withdrawn or superseded, `reason`, why (one line, at most 500 characters), and optional `replacedBy`, the module replacing it |

Every block has a `type` and an `id` (lowercase, starting with a letter or `_`, at most 64
characters, unique in the module; list items, procedure steps and table cell contents have IDs
too). Block types and their fields:

| `type`        | Fields                                                                                                                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `paragraph`   | `content` (inline)                                                                                                                                                                                                                                                                               |
| `section`     | `title` (inline), `blocks`                                                                                                                                                                                                                                                                       |
| `list`        | `ordered` (boolean), `items`: each `{ id, content, blocks }`                                                                                                                                                                                                                                     |
| `procedure`   | optional `title`, `steps`: each `{ id, content, blocks }`                                                                                                                                                                                                                                        |
| `table`       | optional `title`, `columns` (each `width`, a relative whole number, and optional `align`: `left`, `center`, `right`), `header` (whether row 1 is the header), `rows`: each with `cells`, a cell `{ blocks }` with optional `colspan` and `rowspan`                                               |
| `image`       | `asset` (`sha256:<hash>`), `alt` (required alternative text), optional `title`, optional `width` (percent of the text column), optional `callouts` (numbered markers, below) `calloutOrder` (`reading`, the default, or `manual`) and `calloutLegend` (`below`, the default, `beside` or `none`) |
| `attachment`  | `asset`, `name` (the link text), optional `description`, `fileName` (saved as), `mediaType` (lowercase, e.g. `application/json`), `size` (bytes, of the file in `assets/`)                                                                                                                       |
| `safety`      | `severity` (`danger`, `warning`, `caution`, `notice`), `hazard` (inline), `symbols` (configured safety symbols), `blocks`                                                                                                                                                                        |
| `admonition`  | `kind` (`note`, `tip`, `important`), `blocks`                                                                                                                                                                                                                                                    |
| `faq`         | `question` (inline, one line), `blocks` (the answer, at least one block)                                                                                                                                                                                                                         |
| `variant`     | `when` (a condition, below), `blocks`: content for some variants only                                                                                                                                                                                                                            |
| `moduleRef`   | `module`: another module's ID, placed here when a manual is built                                                                                                                                                                                                                                |
| `literal`     | `text` (preformatted, not translated), optional `language` (e.g. `yaml`)                                                                                                                                                                                                                         |
| `passthrough` | `format` (one word, e.g. `html`), `raw`: source content kept verbatim, the converter's fallback                                                                                                                                                                                                  |
| `pageBreak`   | nothing                                                                                                                                                                                                                                                                                          |

Inline content is a list of nodes, each with a `type`:

| `type`        | Fields                                                                                                                                                                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`        | `text`, optional `marks`: each a `type` of `strong`, `emphasis`, `code`, `sub`, `sup`, `ui`, `link` with `href` (`http:`, `https:` or `mailto:`), or `term` with `termId` (a term link: the ID of a term, `terms/<id>.yaml`; never on the same text as a `link`) |
| `attribute`   | `name`: a configured text attribute, filled in per manual and variant (the product name, a rated load)                                                                                                                                                           |
| `xref`        | `module`, optional `block`, optional `text` (text nodes): a cross-reference                                                                                                                                                                                      |
| `kbd`         | `keys`, e.g. `["Ctrl", "S"]`                                                                                                                                                                                                                                     |
| `calloutRef`  | `block` (an image block of the same module) and `callout` (one of its callouts): printed as the callout's number                                                                                                                                                 |
| `placeholder` | `key`: a page design's data field (`title`, `release`, `page`, …); only a page design's text holds one, so in a module it is a validation error                                                                                                                  |
| `hardBreak`   | nothing                                                                                                                                                                                                                                                          |

An image's `callouts` (at most 100) are numbered markers on it, each `{ id, anchor, legend }`
with optional `label`, `when` and `style`: `id` is unique among the module's block IDs; `anchor`
is the point it marks and `label` where its number is drawn (each with `x` and `y`, 0 to 1 from the
image's left and top edge); `legend` is its legend text (inline, one line); `when` a condition (it
shows only in matching variants); `style` a configured callout style. Numbers are never stored:
they are counted per image over the callouts a variant shows.

A condition (`when`) has an `op`: `all` or `any` with `of` (two or more conditions), `not` with
`of` (one condition), `in` with `attr` (a variant attribute) and `values`, or `cmp` with `attr`,
`cmp` (`<`, `<=`, `>`, `>=`) and `value` (a dotted version, e.g. `2.3`).

### Manuals

Each entry of `manuals` is a manifest, as stored in YAML next to the modules (README, "Manuals
and variants"), in JSON:

| Field           | What                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion` | the manifest's version, `1`                                                                                                                                              |
| `id`            | the manual's ID, a slug                                                                                                                                                  |
| `title`         | its title: one line, or one per language (`{ "en": "Operating manual", "de": "Betriebsanleitung" }`, the source language's among them)                                   |
| `audience`      | optional, the audience it is published for                                                                                                                               |
| `deprecated`    | optional: withdrawn or superseded, `reason` and optional `replacedBy` (another manual), as for modules                                                                   |
| `glossary`      | optional: `true` adds a generated glossary of the terms linked in the manual                                                                                             |
| `design`        | optional: the page design its PDF uses (`design/<id>.yaml`), else the project's default                                                                                  |
| `coverImage`    | optional: the cover image its design shows, `default` (`{ asset, alt }`) and `variants` (`{ variant, asset, alt }`, a variant's own); `alt` one text or one per language |
| `variants`      | the variant combinations it ships for, each variant attribute → value, e.g. `[{ "model": "l-200" }]`                                                                     |
| `attributes`    | optional, text attribute → value, or a list of `{ value, when }` where the first match wins                                                                              |
| `entries`       | the modules in order: `{ module }`, or a group `{ title, entries }` (its `title` one line or one per language, as the manual's); either may have a `when`                |

A manifest's translation record (`translations`, #656) is not part of the format (`ImportedManifest`): it is written only by a translation import or by marking a translation current, so an import bundle carrying one is refused (`invalid-schema`).

## What the validator checks

```ts
const result = await validateImport(bundle, config, {
  existing: { modules, manuals, assets }, // anything with has(id); a Set is one
});
```

`bundle.files` is the unpacked archive (path → bytes); `config` the target's `ProjectConfig`;
`existing` what the target already holds: module IDs, manual IDs and stored files
(`sha256:<hash>`). The result lists the bundle's own `issues`, then one item per module, manual
and file (`items`), each with its issues, plus `counts`, the converter's `report` and `valid`
(no error anywhere). Every issue has a `severity` (`error` stops the import, `warning` is worth a
look, `info` is for the import to decide), a stable `code`, a `message` and, where it points
into `import.json`, a JSON Pointer (`/modules/0/meta/type`); one about a block names it in `at`.

| Code                                         | Severity          | When                                                                                                                                                                           |
| -------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `missing-import-document`                    | error             | the archive has no `import.json` at its root                                                                                                                                   |
| `invalid-json`                               | error             | `import.json` is not UTF-8 JSON                                                                                                                                                |
| `too-deep`                                   | error             | it nests arrays and objects deeper than the limit (128 by default, `maxDepth`)                                                                                                 |
| `invalid-format-version`                     | error             | `formatVersion` is not a whole number from 1                                                                                                                                   |
| `unsupported-format-version`                 | error             | `formatVersion` is newer than the validator reads; nothing else is checked                                                                                                     |
| `invalid-schema`                             | error             | a value the schema refuses, at its pointer; the other modules and manuals are still checked                                                                                    |
| `table-too-large`                            | error             | a table has more than 1,000 columns, or more than 50,000 cells (rows × columns); the other modules and manuals are still checked                                               |
| `unknown-field`                              | warning           | a member the format doesn't have, inside a module or a manual's condition; it is ignored                                                                                       |
| `unknown-module-type`, `unknown-audience`, … | as the model says | the content model's `validateModule` and `validateManifest`, against the target's configuration (README)                                                                       |
| `passthrough`                                | warning           | a `passthrough` block: content kept verbatim; each item counts them                                                                                                            |
| `duplicate-module`                           | error             | the same `id` in the same `meta.lang` twice                                                                                                                                    |
| `duplicate-manual`                           | error             | the same manual `id` twice                                                                                                                                                     |
| `dangling-module-reference`                  | error             | a `moduleRef`, `xref` or manual entry names a module neither in the bundle nor in `existing.modules`                                                                           |
| `dangling-block-reference`                   | error             | an `xref`'s `block` is not in the bundle's module (blocks of modules already in the target aren't checked)                                                                     |
| `missing-asset`                              | error             | an `asset` neither in `assets/` nor in `existing.assets`                                                                                                                       |
| `asset-hash-mismatch`                        | error             | a file's SHA-256 differs from its name                                                                                                                                         |
| `attachment-size-mismatch`                   | warning           | an attachment's `size` differs from its file's; the file's is kept                                                                                                             |
| `unused-asset`                               | warning           | a file no module uses; it is not imported                                                                                                                                      |
| `invalid-asset-name`                         | warning           | a file under `assets/` not named by a SHA-256; it is ignored                                                                                                                   |
| `unexpected-file`                            | warning           | a file outside `import.json` and `assets/`; it is ignored                                                                                                                      |
| `too-many-references`                        | error             | the bundle's references (module references, cross-references, manual entries, files) name more distinct IDs outside it than may be looked up (10,000 by default, `maxLookups`) |
| `document-too-large`                         | error             | `import.json` is larger than may be read (64 MiB by default, `maxDocumentBytes`); refused before it is parsed                                                                  |
| `too-many-items`                             | error             | the bundle holds more modules and manuals together than are checked (10,000 by default, `maxItems`); refused before any is checked                                             |
| `too-many-values`                            | error             | `import.json` holds more values (array elements and object members) than are read (1,000,000 by default, `maxValues`); refused before it is checked                            |
| `item-too-large`                             | error             | a module or manual holds more than 50,000 values; it is not checked                                                                                                            |
| `not-checked`                                | error             | the modules and manuals before it whose schema check failed hold more than 100,000 values in all; it is not checked                                                            |
| `report-too-large`                           | error             | the converter's `report` holds more than 10,000 entries; refused before it is read                                                                                             |
| `id-clash`                                   | info              | a module or manual with that ID exists already; the import decides whether to update it                                                                                        |

At most 100 findings are kept per module or manual, and for the bundle's frame; the rest are counted in one more finding of the same code ("and N more like these").

Which file types an attachment may have is the target's setting, checked when the files are
stored, not here.

## Versions

`formatVersion` is bumped on every change a reader of the previous version can't read. A bundle
with a newer version than the validator knows is refused (`unsupported-format-version`) with
what to do; an older one is migrated by the validator before it is checked
(`IMPORT_FORMAT_MIGRATIONS`, none yet: 1 is the first version). Modules and manifests carry
their own `schemaVersion`.

## Writing a converter

Two converters outside the core are examples (`connectors/`, #141): a generic wiki markup's pages,
and a sample issue-tracker connector that imports on a schedule through the API.

1. **Map to blocks.** Turn each source page or topic into one module per language, choosing the
   block that says what the content is: a heading and what follows into a `section`, numbered
   instructions into a `procedure`, a warning about injury or damage into `safety`, a hint into
   an `admonition`, a question and its answer into `faq`, code into `literal`. Inline formatting becomes marks; a link to another page
   that you convert becomes an `xref`, a link outside an absolute `link` mark.
2. **Keep the source ID.** Put the source system and the item's ID into `meta.source`, so every
   module can be traced back, and derive the module `id` and block IDs from stable source IDs, so
   converting the same export again gives the same IDs (and clashes the import can update).
3. **Fall back to `passthrough`.** Content with no block of its own (an embedded widget, a macro)
   goes into a `passthrough` block with its `format` and `raw` source, so nothing is lost; the
   report counts them, and someone converts them by hand later.
4. **Put anything lost into the report.** Whatever you dropped or changed (an unsupported
   attribute, a comment, a page you skipped) is a `report` entry with the source item's ID and,
   when there is one, the module and block it ended up in.
5. **Write the files once.** Hash each image or attachment's bytes with SHA-256, write it to
   `assets/<hash>`, refer to it as `sha256:<hash>`, and fill an attachment's `fileName`,
   `mediaType` and `size` from the file.
6. **Use the target's configuration.** Module types, audiences, facets, variant attributes,
   text attributes and safety symbols must be ones the target configures; ask for its
   configuration, or validate against it, before the import.
7. **Validate.** Run the bundle through `validateImport` (or check `import.json` against the
   JSON Schema first) and fix every error before you hand it over.
