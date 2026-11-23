# DITA import: research note and mapping (#432)

A project kept in DITA comes in through the import flow (`backend/api/README.md`, "Imports") as
modules, manuals, variants, files and translations. This note says which DITA the import reads,
where the standard is, how each part of it maps to the content model, and what has no
counterpart. The mapping is designed from the OASIS specification, section by section (the
numbers below are DITA 1.3 Part 3's, errata 02), so that the DITA export (#433) can invert it.

## Versions and sources

- **DITA 1.3**, OASIS Standard incorporating Approved Errata 02 (19 June 2018), the newest DITA
  OASIS has approved: its standards list names DITA 1.0 (2005), 1.1 (2007), 1.2 (2010) and 1.3
  (2015, with errata 01 and 02), and no later version.
  - Specification (Part 3, all-inclusive edition):
    <https://docs.oasis-open.org/dita/dita/v1.3/errata02/os/complete/part3-all-inclusive/dita-v1.3-errata02-os-part3-all-inclusive-complete.html>
  - Grammar files (DTD, RELAX NG, XML Schema):
    <https://docs.oasis-open.org/dita/dita/v1.3/errata02/os/complete/part3-all-inclusive/dita-v1.3-errata02-os-part3-all-inclusive-complete-grammars.zip>
- **DITA 2.0** is not an OASIS Standard yet: only working drafts are published
  (<https://docs.oasis-open.org/dita/dita/v2.0/>). A file declaring a version other than 1.x
  (`@ditaarch:DITAArchVersion`) is read as DITA 1.3 with the warning `dita-version`. What 2.0
  removes or renames is then reported like any unknown element. Supporting 2.0 properly is
  cheap once it is final, since most of the subset below is unchanged in the drafts.

### Licence check

The specification and its grammar files are © OASIS Open. OASIS's notice allows copying them and
publishing derivative works that help implement them, in whole or in part and without
restriction, as long as the copyright notice and the notices section stay with them. It does
not allow modifying the specification itself. So the grammar files could be vendored for tests,
with their notices. The project prefers not to vendor them. The fixture tests fetch the grammars
ZIP once, pinned to its SHA-256 (`d7973189…`, in `packages/dita/src/testing/fetch-grammars.ts`),
into the git-ignored `packages/dita/.cache/`. They then validate every fixture (topics, maps,
DITAVAL files) against the OASIS XML Schemas from that ZIP, with xmllint and `--nonet`, so nothing
is fetched during validation. The XML Schemas are used because the xmllint build the tests use
has no DTD validation, and libxml2's RELAX NG cannot compile DITA's constraint overrides; the
three grammars describe the same document types. This is the same pattern the iiRDS validator
uses (`docs/iirds-export.md`). Without network access and without the cache, that one test fails
and says why; the converter's tests need neither. No grammar file is committed.

## How the import reads XML

DITA files are untrusted input. They are read by the repository's own strict reader
(`readXml`, `@openfolia/xml`):

- No DTD is read or fetched. Every DITA file carries a `<!DOCTYPE … PUBLIC "…" "…">` naming its
  document type. The reader accepts such a declaration only with an external identifier, and
  never opens it. An internal subset (`[ … ]`), and so any entity declaration, is refused.
- No entity is expanded, so there is no XXE and no billion laughs. Only XML's five predefined
  entities and character references are read.
- Bounded: 8 Mi characters per file, elements 64 deep, 1,000,000 nodes, 64 attributes per element.
- UTF-8 only.
- A file the reader refuses is reported (`not-well-formed`, `dtd-subset`, `unsupported-encoding`,
  `too-large`) and left out; the rest are imported.

Because DTD attribute defaults are never read, no `@class` is filled in. Elements are known by
their names (the OASIS document types', table below). A specialisation is known by a `@class`
it carries literally, and is generalised (`specialization`). An element with neither is unknown.

Content references are the remaining amplification route, and they are bounded:

- At most 16 deep.
- A cycle is cut (`conref-cycle`).
- At most 200,000 elements are brought into one topic, and 2,000,000 into one import. A topic past
  either bound is left out (`expansion-limit`).
- Text is charged by its length, not as one node: at most 4 Mi characters of copied or key text
  in one topic and 16 Mi in one import (`expansion-limit`). A conversion still too large for the
  runtime is refused as `import-too-large` (422).
- A title (or navigation title) with a key's text put in is at most 4,096 characters; past it, it
  is cut.
- Text is charged with the attributes copied along (an address, a long condition), and a key's
  external address at every link that names it.
- Maps: a submap named many times is followed every time, so the manuals one import makes hold at
  most 200,000 entries and 16 Mi characters of entry titles, all together; past either, the manual
  being made is left out (`expansion-limit`). A submap reached by several paths is walked once
  and charged at every reuse what walking it again would cost; the maps' walk is at most
  1,000,000 elements.
- Submaps nest at most 32 deep; a deeper one is not followed (`map-entry`).
- One element carries at most 32 distinct conditions (a repeated group is one); the rest is left
  out (`condition-limit`).
- Whitespace trimming, blank lines and column spans take linear time.
- The conversion runs in a child process of its own, its heap and time bounded
  (`CCMS_IMPORT_CONVERT_MAX_MEMORY_MB`, default 1,024; `CCMS_IMPORT_CONVERT_TIMEOUT_MS`, default
  120,000): whatever an archive costs past the bounds above, the import is refused as 422
  `import-too-large`, and the server's event loop and heap are untouched. An `import.json` past
  `CCMS_IMPORT_MAX_DOCUMENT_BYTES` is refused in the child (`size`), so the server never receives it.
- Cross-references are resolved through an index, so many links into many topics take linear
  time.

Key text is bounded the same way: a key whose text names a key being put in already (a cycle) is
left out, at most 16 keys deep, and every node of a key's text counts toward the same element
budget, so a fan-out of keys stops there (`key-cycle`, `expansion-limit`). A table is imported with
at most 1,000 columns and 50,000 cells, its padding included, however many columns `@cols` declares
or rows it has; past either, the rest is left out and reported (`table-layout`). Padded cells count
toward the budget too. No list is passed as call arguments (no spread), so an element with a
million children cannot exhaust the stack.

Every reference resolves only against the files of the uploaded archive. One climbing out of it
resolves to nothing (`outside-archive`), and nothing is fetched (`external-reference`). The archive
itself is read by `readZip` with every importer's limits: size, entries, path depth, no path out
of it, no links, and the compression ratio.

## The archive

- A ZIP of the project: maps, topics, images, DITAVAL files, in any folders.
- **Languages** (2.4.6.1): top-level folders named as configured languages (`en/`, `de/`,
  `de-DE/`, case-insensitive) are language trees. A topic at the same path in two trees is the same
  module in two languages. Files outside every language folder are the source language's, and
  images may live there, shared. Without language folders, every topic is the source language's.
  An `xml:lang` that contradicts the folder (or the source language) is reported (`language`).
- **Module IDs**: the slug of the topic's path within its language folder, without the extension
  (`topics/install.dita` → `topics-install`). A topic of a `<dita>` document takes `-<topic id>`
  as well. A slug two paths share, or one longer than 100 characters, takes the first 8 hex digits
  of the path's SHA-256 instead of its tail. The same project always gives the same IDs, so a
  second import updates the modules the first made.
- **Block IDs**: an element's `@id`, as a slug, else `<kind>-<n>` in document order. A translation
  keeps its source's `@id`s and structure, so it gets the same block IDs. One that does not is
  reported (`translation-structure`).

## Mapping table

| DITA (1.3 section)                                                                                                                                   | Content model                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| top-level `<topic>`, `<concept>`, `<task>`, `<reference>`, `<troubleshooting>`, `<glossentry>` (3.1)                                                 | a module. Its type: `dita.outputclasses` (a token of the root's `@outputclass`), else `dita.moduleTypes` (the root element's name), else a configured module type of the same name, else `dita.defaultModuleType`, else the first configured. `meta.source` is `DITA` and `<path>#<topic id>`.                                                                                                                                                                       |
| `<dita>` (ditabase)                                                                                                                                  | each child topic a module of its own                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `<title>`, `<shortdesc>`, `<abstract>`                                                                                                               | the module's title (plain text); paragraphs                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `<prolog><metadata><keywords><keyword>`                                                                                                              | `meta.keywords` (commas dropped, at most 32 of at most 64 characters). Any other prolog metadata is reported (`metadata`).                                                                                                                                                                                                                                                                                                                                           |
| nested topic                                                                                                                                         | a section, titled as the topic (deeper than 5 sections: a bold paragraph, `section-depth`)                                                                                                                                                                                                                                                                                                                                                                           |
| `<section>`, `<example>` with a title                                                                                                                | a section; without a title, its content in place                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `<p>`                                                                                                                                                | a paragraph. Blocks inside it (a list, say) split it.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `<ul>`, `<ol>`, `<sl>`, `<choices>`, `<steps-unordered>`                                                                                             | a list (ordered for `<ol>`); an item's first paragraph is its text, the rest are its blocks                                                                                                                                                                                                                                                                                                                                                                          |
| `<dl>`, `<parml>`                                                                                                                                    | a list, each entry's term in bold as its text and its definition as its blocks; `<dlhead>` is reported                                                                                                                                                                                                                                                                                                                                                               |
| `<steps>`, `<substeps>`                                                                                                                              | a procedure: `<cmd>` is the step's text; `<info>`, `<stepxmp>`, `<stepresult>`, `<substeps>`, … are its blocks. `@importance` is reported.                                                                                                                                                                                                                                                                                                                           |
| `<prereq>`, `<context>`, `<result>`, `<postreq>`, `<condition>`, `<cause>`, `<remedy>`, `<troubleSolution>`, `<refsyn>`, `<bodydiv>`, `<sectiondiv>` | their content in place (a section when they have a title). The generated headings a DITA processor adds ("Before you begin") are not added.                                                                                                                                                                                                                                                                                                                          |
| `<note>` (3.2.1.17)                                                                                                                                  | `note`, `tip`, `important`: an admonition. `danger`, `warning`, `caution`, `notice`: a safety block (its first paragraph is the hazard). `fastpath`, `remember`, `restriction`, `attention`, `trouble`, `other`: the nearest admonition, reported (`note-type`).                                                                                                                                                                                                     |
| `<hazardstatement>` (3.5.1.1)                                                                                                                        | a safety block: `@type` is the severity (`danger`, `warning`, `caution`, `notice`; any other type is an admonition, `hazard-type`), `<typeofhazard>` the hazard, `<consequence>` and `<howtoavoid>` its paragraphs, `<hazardsymbol>` a safety symbol by `dita.hazardSymbols` (its file name or key; unmapped: `hazard-symbol`)                                                                                                                                       |
| `<fig>` with one `<image>`, `<image placement="break">`                                                                                              | an image: `<alt>` (or `@alt`, the figure's title, the file name) its alternative text, the figure's title its title; its size (`@width`, `@height`, `@scale`, `@scalefit`) has no counterpart, since a width is a share of the text width (`unsupported-attribute`). The file goes into the bundle by its SHA-256.                                                                                                                                                   |
| `<image>` inside text                                                                                                                                | an image block, splitting the paragraph (`inline-image`)                                                                                                                                                                                                                                                                                                                                                                                                             |
| `<table>` (CALS)                                                                                                                                     | a table. `<colspec colwidth="2*">` sets relative widths (absolute units: equal widths, `table-layout`), `namest`/`nameend` a column span, `morerows` a row span. The first `<thead>` row is the header. A table in a table is a paragraph (`nested-table`). Each `<tgroup>` is a table.                                                                                                                                                                              |
| `<simpletable>`, `<properties>`, `<choicetable>`                                                                                                     | a table, its head row the header, `@relcolwidth` the widths                                                                                                                                                                                                                                                                                                                                                                                                          |
| `<codeblock>`, `<pre>`, `<screen>`, `<msgblock>`                                                                                                     | a literal block (`outputclass="language-x"` is its language); markup inside is reported (`markup-in-literal`)                                                                                                                                                                                                                                                                                                                                                        |
| `<lines>`                                                                                                                                            | a paragraph with line breaks                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `<b>`, `<i>`, `<cite>`, `<varname>`, `<sub>`, `<sup>`                                                                                                | strong, emphasis, sub, sup                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `<tt>`, `<codeph>`, `<filepath>`, `<cmdname>`, `<option>`, `<parmname>`, `<apiname>`, `<userinput>`, `<systemoutput>`, `<msgph>`, …                  | code                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `<uicontrol>`, `<wintitle>`, `<shortcut>`, `<menucascade>`                                                                                           | ui (a menu cascade's controls joined by `>`)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `<xref>` (3.2.1.31) to a topic or an element in one                                                                                                  | a cross-reference to its module (and block)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `<xref scope="external">`, an `http`, `https` or `mailto` URL                                                                                        | a link mark; another scheme is its text (`external-reference`)                                                                                                                                                                                                                                                                                                                                                                                                       |
| `<ph>`, `<keyword>`, `<term>`, `<text>`, `<q>`, `<tm>`                                                                                               | their text (`<q>` in quotes, `<tm>` with its symbol)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `@conref`, `@conkeyref`, `@conrefend` (2.4.2, 3.12.13.5, 3.12.13.8)                                                                                  | the referenced content copied in place, with the referencing element's attributes over the target's (except `-dita-use-conref-target`). `@conkeyref`'s key falls back to `@conref`. A topic referencing a whole top-level topic is a module reference block. So is an element marked `outputclass="openfolia-module-reference"` whose range is all of a top-level topic's content, as the export writes one (#433). A profiled `div`'s `@id` is its variant block's. |
| keys: `@keys` on `<keydef>`/`<topicref>` (2.3.4)                                                                                                     | per root map, the first definition in a breadth-first pass of the map and its submaps (2.3.4.1, "Effective key definitions")                                                                                                                                                                                                                                                                                                                                         |
| empty `<ph keyref>` (and `<keyword>`, `<term>`) (2.3.4.9)                                                                                            | a text attribute (`dita.textKeys`, or a text attribute of the key's name), whose value each manual takes from its map's key definition. Any other key is its text (`<keywords><keyword>`, else `<linktext>`, `<navtitle>`).                                                                                                                                                                                                                                          |
| `@keyref` on `<xref>`, `<image>`, `<topicref>`                                                                                                       | the key's target, as its `@href` would be                                                                                                                                                                                                                                                                                                                                                                                                                            |
| filter attributes `@product`, `@platform`, `@audience`, `@otherprops`, `@props`, `@deliveryTarget`, and groups `name(a b)` (2.4.3.2)                 | a variant block around the element's blocks: each group is an `in` of its mapped values, and the groups are `all` of them. That is DITA's rule: excluded only when every value of a group is excluded, and excluded when any group excludes. `dita.profiling` maps a name to a variant attribute (and values) or to audience levels; by default, a name that is a variant attribute's ID maps to it, and `audience` to the levels of the same IDs.                   |
| `@audience` on a topic, a map                                                                                                                        | the module's or manual's audience (the least restricted of several)                                                                                                                                                                                                                                                                                                                                                                                                  |
| root `<map>`, `<bookmap>` (3.3)                                                                                                                      | a manual (source language only). Its title is `<booktitle><mainbooktitle>`, `<title>` or `@title`.                                                                                                                                                                                                                                                                                                                                                                   |
| `<topicref>`, `<chapter>`, `<appendix>`, `<part>`, …                                                                                                 | a module entry. With children: a group titled after it (its navigation title, else the topic's), holding its module, then its children. `<topichead>`: a group. `<topicgroup>`, `<frontmatter>`, `<backmatter>`: their children in place. `<mapref>`: the submap's entries in place.                                                                                                                                                                                 |
| a reference's filter attributes                                                                                                                      | the entry's `when`                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `<ditavalref>` on a root map (3.3.x, 2.4.3.4)                                                                                                        | one variant of the manual per DITAVAL file it names                                                                                                                                                                                                                                                                                                                                                                                                                  |
| DITAVAL `<prop att val action>` (3.4)                                                                                                                | the variant's value of each variant attribute it decides: the one value it leaves included. Several, or none: left unset, `ditaval-variant`.                                                                                                                                                                                                                                                                                                                         |
| a DITAVAL file no map names                                                                                                                          | not applied (`ditaval-unreferenced`), unless `dita.ditavalDefault: all` makes it a variant of every manual                                                                                                                                                                                                                                                                                                                                                           |

## What has no counterpart, and how it is reported

Nothing is dropped silently. Each loss is an entry of the bundle's converter report (the
import's `meta.report.report`), with a stable code in brackets, the file and element it is
about, and the module. Entries of the same code, file and message are one entry with a count,
so a thousand index terms are one line per file.

- **Left out**:
  - `dropped-element`: index terms, draft comments, required clean-up, `<data>`, `<foreign>`,
    `<object>`, related links, alternative titles.
  - `reltable`, `generated-list`: relationship tables and a bookmap's generated lists.
  - `conaction`: pushed content.
  - `ditaval-action`: DITAVAL flagging and passthrough; the content is included.
  - `metadata`: prolog metadata other than keywords.
- **Kept, without what it said**:
  - `inline-condition`: a phrase's condition. Inline content does not vary by variant in the
    model.
  - `item-condition`: a list item's, step's, cell's or table row's condition. Items are split into
    lists of their own, in variant blocks; cells and rows stay unconditional.
  - `section-condition`: a section's or nested topic's condition. A variant block holds no section,
    so the section stays, titled in every variant, and the condition goes onto its content.
  - `audience-condition`: an audience inside a topic.
  - `unmapped-profiling`: a profiling value mapped to nothing; that value is left out of the
    condition.
  - `keyscope`: key scopes; every key is in one scope.
  - `conditional-key`: a key definition's own condition; its first definition is used.
  - `ditaval-branch`: branch filtering below a map's root, a `<ditavalref>` in a submap included.
  - `unsupported-element`: `<u>`, `<line-through>` and `<overline>`, long quotations, syntax
    diagrams, image map areas, step sections.
  - `footnote`: footnotes; each becomes a note after its paragraph.
- **Unresolved**:
  - `unresolved-conref`, `conref-cycle`, `unresolved-key`, `key-cycle`, `unresolved-xref`: a reference to
    nothing in the archive. A cross-reference to an element that is no block links to its
    module.
  - `missing-asset`, `outside-archive`, `external-reference`: a file that is missing, outside the
    archive, or not fetched.
  - `map-entry`: a map entry naming no topic, or a non-DITA file.
- **Unknown**:
  - `unknown-element`: an element of no OASIS DITA 1.3 document type. Its text is imported as a
    paragraph, the issue's default.
  - `specialization`: a specialisation, imported as the element its `@class` names.
- **Translations**:
  - `translated-map`: a map in another language is no manual of its own, since a manual has one
    title. Its keys are used for its language's topics, but a text attribute's value comes from
    the source map.
  - `translation-without-source`: a translation whose topic the source language lacks.
  - `translation-structure`: a translation whose blocks differ from its source's.
- **Configuration**: `mapping`: a `dita` mapping value naming nothing configured
  (`ditaMappingIssues`); the import uses its default there. `GET /config` lists them too
  (`meta.ditaIssues`).

## The mapping is configuration

`dita` in `openfolia.yaml` (`@openfolia/content-model`, "DITA mapping"). Every key is optional, and every
default is named above. Nothing about a project's DITA (its topic types, output classes, product
values, keys, symbols) is in code.
