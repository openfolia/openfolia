# @openfolia/connector-wiki-markup

A one-off migration (#141): pages written in a generic wiki markup become an import bundle in the
documented format (`@openfolia/content-model`, "Import format"), ready for the import (`POST /imports`
with the importer `bundle`, or the import screen). It is a standalone tool: nothing in the core
imports it. It reports every construct it could not convert, block by block, and never drops
content silently.

```sh
pnpm nx build connector-wiki-markup
node connectors/wiki-markup/dist/main.js export/ --mapping mapping.yaml --out bundle.zip \
  --config openfolia.yaml   # optional: validate against the target's configuration too
```

It warns, before it writes the bundle, when its `import.json` is larger than the import reads
(`document-too-large`): the API's `CCMS_IMPORT_MAX_DOCUMENT_BYTES`, 8 MiB by default; name the
target's own with `--max-document-bytes <n>`. Convert such an export in parts, a folder of fewer
pages each.

Installed as a package, the command is `openfolia-wiki-markup`; `ccms-wiki-markup`, its name
before the product was named, still starts it for one release.

```ts
const conversion = convertWikiPages(pages, WikiMapping.parse(mapping)); // { document, assets, counts }
const zip = zipBundle(conversion); // import.json and assets/<sha256>
```

## The markup

The markup this reads, by its syntax:

| Markup                                                                      | Becomes                                                                      |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `h1.` to `h6.` headings                                                     | sections, nested by level (at most 5 deep; deeper ones at level 5, reported) |
| paragraphs; a line break, or `\\`                                           | paragraphs; a hard break                                                     |
| `*`, `-` and `#` list lines (`#*` nests a bullet in a number)               | lists (ordered for `#`), nested; procedures with `orderedLists: procedure`   |
| `\|\|header\|\|` and `\|cell\|` rows                                        | a table, the first row its header if all its cells are header cells          |
| `{code:yaml}` … `{code}`, `{noformat}` … `{noformat}`                       | a literal block, kept verbatim, with its language                            |
| `{info}`, `{tip}`, `{note}`, `{warning}` (as mapped)                        | admonitions, or safety notices (`safety`; `title=` is the hazard)            |
| `{panel}`, `{expand}`, … (`containers`)                                     | their content; the frame left out and reported                               |
| any other macro alone on its line, with its body when closed                | a `passthrough` block (`format: wiki`), kept verbatim, reported              |
| `!file.png!`, `!file.png\|alt=…,width=50%!`                                 | an image block (from the page's attachments), after the text it stood in     |
| `[text\|^file.pdf]`                                                         | an attachment block, after its paragraph                                     |
| `*strong*`, `_emphasis_`, `??citation??`, `{{monospace}}`, `^sup^`, `~sub~` | marks                                                                        |
| `[text\|https://…]`, `[mailto:…]`                                           | links                                                                        |
| `[Page title]`, `[text\|Page title]` of a page in the export                | a cross-reference to its module                                              |

Each finding is a `report` entry of the bundle with the page's ID, the module and the block it
ended up in, and a message starting with a stable code (`WIKI_REPORT_CODES`):

- **Kept verbatim** (`passthrough`): an unknown macro (`unknown-macro`), an image or attachment
  the export does not carry (`missing-file`), a table past the content model's caps once padded
  (`table-too-large`). The caps: 1,000 columns and 50,000 cells a table (the content model's),
  and about 40,000 values for one page's tables and 800,000 for the bundle's (within the import's
  limits on a module and a bundle); a page whose converted blocks would pass the import's limit on
  one module beside its `meta` (very many blocks), whole, any files in it as written
  (`page-too-large`). The conversion of such a page stops as soon as its blocks pass that limit,
  so a page of megabytes costs no more time and memory than a module's worth of blocks.
- **Kept as text, without what has no counterpart:** struck-through and underlined text,
  colours, quotations, anchors and links to them, mentions, links to pages outside the export or
  of other schemes, an unknown inline macro (its text as written), a heading inside a macro.
- **Changed:** an image without alternative text gets its file name (`no-alt`), an image or
  attachment inside a line of text moves after it (`moved-out-of-text`), short table rows are
  padded (`row-padded`), header cells outside the first row become ordinary ones, headings and
  lists nested too deep move up, a module ID taken already gets a suffix.
- **Left out, as decoration only:** a horizontal rule (`rule`), image settings with no counterpart
  (a size in pixels, a thumbnail: `image-setting`), a link's tooltip, an empty heading, an image or file inside
  a heading (a title holds text only). Each is still reported.

`convert.spec.ts` checks that every word of the example export is in its bundle, and that any
markup at all (a property test) gives modules the content model accepts.

## The export folder

`<name>.wiki` files, one page each, with their attachments in a folder `<name>/` beside them. A
page may start with front matter:

```text
---
id: 1042            # its ID in the source (default: the file name)
title: Filling the tank
labels: [tank]
order: 1            # pages are ordered by this, then by file name
---
```

Links, nested folders and files over 64 MiB are skipped and listed, never followed.

## The mapping

YAML, checked by `WikiMapping` (`src/lib/mapping.ts`); every value is one the target's `openfolia.yaml`
configures:

```yaml
system: Team wiki # meta.source.system
language: en
moduleType: concept # every page; a label may set another
audience: public
facets: { region: [north] }
labels: # page label → what it sets; other labels are reported (or keywords: labelsAsKeywords)
  internal: { audience: internal }
moduleIds: { from: id, prefix: wiki } # from the page ID (stable, default) or its title
orderedLists: list # or procedure
admonitions: { info: note, tip: tip, note: important, warning: important }
safety: { warning: { severity: warning, symbols: [w001] } } # wins over admonitions
containers: [panel, expand, section, column, details]
manual: { id: team-guide, title: Team guide, variants: [{}] } # optional: every page, in order
```

Module and block IDs come from the page IDs and the headings, so converting the same export again
gives the same IDs, and the import updates (`updateExisting`) or skips what is unchanged.
