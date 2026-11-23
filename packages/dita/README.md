# @openfolia/dita

The DITA import's converter (#432): a DITA 1.3 project, the files of its archive by path, as an
import bundle in the documented format (`@openfolia/content-model`, "Import format"), for a target
configuration and its DITA mapping (`dita` in `openfolia.yaml`, "DITA mapping" there). The API's `dita`
importer (`backend/api`, "Imports") runs it on an uploaded ZIP. The mapping table, the sources and
what has no counterpart are in `docs/dita-import.md`.

```ts
const conversion = await convertDita(files, config); // { document: ImportDocument, assets }
const bundle = { files: bundleFiles(conversion) }; // import.json and assets/<sha256>
```

- **Pure and deterministic.** It reads nothing but `files` (no repository, network or file
  system), and the same project and configuration give the same bundle. Module IDs come from
  source paths and block IDs from `@id`s, so a second import is `unchanged` and a changed topic
  an `update`.
- **Untrusted input.** XML is read with `@openfolia/xml` (`readXml`, `doctype: 'external-id'`), with
  `DITA_XML_LIMITS`: a DOCTYPE naming a DTD is skipped and never opened, while an internal
  subset or entity is refused, and the file is reported and left out. References resolve only
  inside the archive. Content references are bounded: `MAX_CONREF_DEPTH` deep, cycles cut, and
  `MAX_MODULE_EXPANSION` and `MAX_IMPORT_EXPANSION` elements copied in, charged as they are
  made. Key text is charged to the same budget, and a key cycle or one past 16 keys deep is cut.
  Text is charged by its length too (`MAX_MODULE_EXPANSION_CHARS`, `MAX_IMPORT_EXPANSION_CHARS`).
  Cross-references resolve through an index (linear in links and topics).
  A title with key text is at most `MAX_KEYED_TEXT_CHARS` long. Copies are charged their
  attributes' characters too, and a keyed external address every use. Manuals are bounded by
  `MAX_MANUAL_ENTRIES`, `MAX_MANUAL_TITLE_CHARS` and `MAX_MAP_VISITS` (a fan-out of submaps; a
  submap reached by many paths is walked once, and charged its full cost at every reuse). Sections, ranges and
  links are linear in their input; submaps nest at most `MAX_MAP_DEPTH` deep, and an element has at
  most `MAX_ELEMENT_CONDITIONS` conditions.
- **Isolated.** `convertDitaIsolated(files, config, { maxMemoryMb, timeoutMs })` runs the conversion
  and `bundleFiles` in a child process of its own (V8 serialisation over IPC, no file or network of
  its own): past its heap or time it is killed, a `ConversionLimitError` (`reason` `memory`,
  `timeout` or `size`). With `maxDocumentBytes`, a larger `import.json` is refused in the child
  (`DocumentTooLargeError`, a `size`), so the caller never receives more. From the TypeScript sources (tests) the child runs them with Node's type
  transform and `source-hooks.mjs`.
  Tables are capped at `MAX_TABLE_COLUMNS` columns and `MAX_TABLE_CELLS` cells, padding included:
  the content model's caps (#686), re-exported here. The export refuses a table past them
  (`TableTooLargeError`) before it writes a column.
  `hostile.spec.ts` covers each.
- **Nothing dropped silently.** Each loss is an entry of `document.report`, with a stable `[code]`
  (`DitaReportCode`) and its file, element and module. Entries of the same code, file and message
  are counted into one, and at most `MAX_REPORT_ENTRIES` are kept.
- **Layout** (`src/lib/`): `load` (reading, languages, the topic index), `keys` (key spaces),
  `conref` (content references), `profiling` (filter attributes, DITAVAL), `topic` (a topic as a
  module), `map` (a map as a manual), `convert` (all of it, cross-references, files,
  translations), `ids`, `paths`, `elements`, `report`.

## Export

The other direction (#433): `exportDita(input)` writes a manual as a DITA 1.3 project, the
mapping read backwards (`docs/dita-export.md`). The API's DITA packages
(`backend/api`, "DITA export") run it on a release output.

```ts
const { files, warnings, topics } = exportDita({
  config,
  manifest,
  languages: ['en'],
  variants: [{ model: 'small' }],
  references: 'conref', // or 'resolved'
  module: (id, lang) => modules.get(`${lang}/${id}`),
  asset: (ref) => ({ extension: '.png' }), // undefined: not stored
  symbol: (id) => ({ extension: '.svg' }), // undefined: no artwork
});
// files: { path, text } | { path, asset } | { path, symbol }, sorted by path
```

- **Pure and deterministic.** Everything it reads comes through `input` (the caller loads the
  modules first), and the same input makes the same files. It parses no XML; every text and
  attribute is escaped (`lib/export/xml.ts`), characters XML cannot hold written as U+FFFD.
- **Safe paths.** Every file is `<lang>/<id>.dita`, `<lang>/<manual>.ditamap`,
  `filters/<variant>.ditaval`, `images/` or `files/<sha256><ext>` or `symbols/<name>`, each segment
  of `[A-Za-z0-9._-]` starting with a letter or digit; a mapping key that is not such a name is
  never used as one.
- **Bounded.** Elements and texts, and characters, of every file together
  (`limits`, `DEFAULT_EXPORT_MAX_NODES`, `DEFAULT_EXPORT_MAX_CHARS`; past them
  `DitaExportTooLargeError`); module references are followed `MAX_REFERENCE_DEPTH` deep, cycles
  cut.
- **Nothing dropped silently.** What DITA cannot say is a warning (`DITA_EXPORT_WARNINGS`), one
  per code, module and language with a count, at most `MAX_EXPORT_WARNINGS`.
- **Layout** (`src/lib/export/`): `xml` (elements and writing), `profiling` (conditions as filter
  attributes, DITAVAL), `topic` (a module as a topic), `report`, `export` (all of it: references,
  the map, cross-references, files).

Its dependencies are `@openfolia/content-model` and `@openfolia/xml`.

## Tests

`src/lib/convert.spec.ts` imports the fixture project (`src/fixtures/garden-pump/`: an invented
garden pump in English and German, with a bookmap and a map, concept, task, reference and
troubleshooting topics, conref, keys, DITAVAL, a hazard statement, images and tables) into
`garden-pump.openfolia.yaml`, and covers hostile input: an entity bomb, XXE, a conref bomb, cycles and
paths out of the archive. `src/fixtures.grammar.spec.ts` validates every fixture against the OASIS
DITA 1.3 XML Schemas. They are fetched once by the global setup (`src/testing/fetch-grammars.ts`,
pinned by SHA-256, cached in the git-ignored `.cache/`), never committed. Without network access
and without the cache, that test fails and names the problem (`grammarsProblem()`).
`src/testing/grammars.ts` (`validateDita`) holds the validation, for the export's tests too.

`src/lib/export/export.spec.ts` exports the fixture and imports it again (the same modules and
manuals, both reference modes), validates the export of it and of a sample of every block type
(`src/testing/export-sample.ts`) against the same schemas, and covers hostile text, unsafe
mapping keys, bounds and reference cycles.
