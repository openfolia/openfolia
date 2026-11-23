# DITA export: mapping and what it cannot say (#433)

A release output (a manual in one variant and language) can be downloaded as a DITA 1.3 project:
a map, a topic per module, the media they show, and a DITAVAL file for the variant. The export
inverts the import's mapping (`docs/dita-import.md`, the same OASIS sources and licence check),
reading the configuration's DITA mapping (`dita` in `openfolia.yaml`) backwards, so a package
imports again as the same content. The converter is `exportDita` (`@openfolia/dita`); the API serves
it at `GET /releases/:releaseId/dita-packages/…` (`backend/api/README.md`, "DITA export").

## The package

| Path                        | What                                                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<lang>/<manual>.ditamap`   | The manual: its title, a `ditavalref` to the variant's DITAVAL file, a `keydef` per text attribute, its groups (`topichead`) and modules (`topicref`), conditions as filter attributes. |
| `<lang>/<module>.dita`      | A module, of the topic type its module type maps to. A module a reference names is a topic too, outside the map.                                                                        |
| `filters/<variant>.ditaval` | The variant: per variant attribute, every value excluded but the variant's.                                                                                                             |
| `images/<sha256>.<ext>`     | An image a topic shows; the extension from its stored type.                                                                                                                             |
| `files/<sha256>.<ext>`      | An attached file a topic links.                                                                                                                                                         |
| `symbols/<name>`            | A safety symbol's artwork: the `dita.hazardSymbols` file name naming it, else `<id>.<ext>`.                                                                                             |

With `languages=all`, each language the reader may read the whole manual in is a folder. A
module without a translation is written in the source language (`xml:lang` says which), with the
warning `missing-translation`. Every path is letters, digits, `.`, `_` and `-` in segments
starting with a letter or digit, so no entry can leave the archive; the export refuses any other
(a bug, never content).

## Mapping, backwards

- **Topic type.** The first `dita.moduleTypes` entry naming the module type, else the topic type
  named like it (`concept`, `task`, `reference`, `troubleshooting`), else `topic`. When the import
  would not read the module type back from the topic type, the root has an `@outputclass`: the
  `dita.outputclasses` token naming it, else the module type's ID.
- **Body.** A `concept` or `topic` holds blocks, then sections. A `reference` holds its blocks in
  one untitled `section`. A `task` is `context`, one `steps` (procedures one after another, and
  those of variant blocks, the condition on the step; the joined procedures' and variant blocks'
  own IDs are not written, `procedures-merged`), then `result`; content between two
  procedures makes it no task (the warning `topic-type`, written as `topic`). A
  `troubleshooting` topic is its `condition`, then a `troubleSolution` per procedure (what comes
  before it its `cause`, the procedure its `remedy`).
- **Sections.** A section is a `section`. When any section of a level holds sections, every
  section of that level is a nested topic of the same type, its `@id` the section's (unless that
  is the module's topic ID: then `<id>-section`, `id-renamed`).
- **Blocks.** Paragraph `p` (with line breaks `lines`), list `ul`/`ol`, procedure outside a task
  `ol outputclass="steps"` (`procedure-as-list`), table CALS (`colspec` widths, `namest`/`nameend`,
  `morerows`), image `fig` (with a title) or `image`, attachment a `p` with an `xref` to the file,
  safety notice `hazardstatement` (its hazard `typeofhazard`, paragraphs and simple lists
  `howtoavoid`, symbols `hazardsymbol`), note and tip `note`, variant block `div` with filter
  attributes, literal `codeblock outputclass="language-…"`.
- **Inline.** Strong `b`, emphasis `i`, code `codeph`, UI `uicontrol`, sub/superscript, term
  `term`, link `xref scope="external"`, text attribute `ph keyref`, cross-reference `xref`
  to the topic and element (`<module>.dita#<topic>/<block>`).
- **Conditions.** A condition on one attribute is the filter attribute the mapping names
  (`dita.profiling`, values read backwards; unmapped, `props="<attribute>(…)"`), `not` its
  complement (which imports again as `in` of the values configured when it was exported). One DITA cannot say as values (a version compared, attributes combined with `any`)
  is written as the values of the manual's shipped variants it holds in (`condition-shipped`, or
  `condition-approximated` when that includes more than the condition does).
- **Audience.** A module's audience is the mapped `audience` value on its root; the map carries
  the manual's.
- **Module references.** `references=conref` (the default): a content reference to the referenced
  topic's elements (`@conref`, and `@conrefend` for more than one), its stub the element its first
  block is, marked `outputclass="openfolia-module-reference"`: the import reads a marked reference to
  all of a top-level topic's content back as the module reference (an unmarked one is copied in,
  as before). Where DITA cannot say one (the target holds sections or steps, or a note would be in a
  note, a table in a table), or with `references=resolved`, its content is put in, every ID
  prefixed with the reference's (`module-reference-resolved`). A cycle, or a chain deeper than 16,
  is cut (`module-reference-cycle`).

## What has no counterpart

Each is a warning of the package (`meta.warnings`: code, module, block, language, count), never a
silent loss. Codes are stable (`DITA_EXPORT_WARNINGS`).

- **Not written:** `module-not-exported` (missing, or above the manual's audience),
  `missing-asset`, `missing-symbol`, `xref-outside` (a cross-reference to a module not in the
  package is its text), `module-reference-cycle`.
- **Written in another form:** `topic-type`, `procedure-as-list`, `procedure-title` (a bold
  paragraph before the steps), `procedures-merged`, `id-renamed`, `section-flattened`, `nested-note` and `nested-table` (content in
  a `div` or put in place), `safety-as-note` (a safety notice holding more than paragraphs and a
  simple list is a `note` of its severity, without symbols), `table-layout`, `line-break`, `faq`
  (a definition list), `attachment`, `passthrough` (a code block), `keyboard` (`userinput`),
  `module-reference-resolved`, `condition-shipped`, `condition-approximated`,
  `text-attribute-variants` (a key holds the variant's value).
- **Left out:** `image-size`, `callouts`, `term-link`, `metadata` (facets, an unmapped audience),
  `page-break`.

## Checks

- **Valid:** tests validate every exported file (the garden pump fixture, and a sample of every
  block type in both reference modes and with hostile text) against the OASIS DITA 1.3 XML
  Schemas, fetched and pinned as for the import (`packages/dita/src/testing/grammars.ts`).
- **Round trip:** the fixture imported, exported and imported again gives the same modules and
  manuals (only `meta.source` differs), in both reference modes; a module with a variant block
  and a module reference gives the same blocks, IDs included (the import takes a profiled
  `div`'s `@id` for its variant block). What a warning reports above does not come back as it
  was (procedures joined, a `not`, a renamed nested topic).
- **Deterministic:** the same content, options and configuration make the same files, and the
  API the same bytes (entries stored, dated with the release's `publishedAt`).
- **Escaping:** every text and attribute is XML-escaped; characters XML cannot hold become
  U+FFFD. The export parses no XML.

## Defaults

#433's open questions, decided here: references as `conref`; DITA 1.3; one package per release
output (its variant's DITAVAL file), made on request and kept a while, not stored with the
release. Out of scope: specialisations, exporting drafts, an editor screen.
