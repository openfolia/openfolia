# @openfolia/xliff

Writes the translatable units of modules (`translatableUnits` in `@openfolia/content-model`, "Translation") as an [XLIFF 2.0](https://docs.oasis-open.org/xliff/xliff-core/v2.0/os/xliff-core-v2.0-os.html) document, core only, for a translation provider. Framework-free: no Node APIs, no dependencies but the content model and the XML reader (`@openfolia/xml`). The API's delta export (`backend/api`, "Translations") uses it, and its translation import reads the same shape back (`readXliff`, `targetParts`); COTI packages' project descriptions too (`writeCoti`, `readCoti`, below).

```ts
const units = xliffUnitsOf(module, new Set(['intro', 'photo'])); // or all of them
const xml = writeXliff({
  srcLang: 'en',
  trgLang: 'de',
  meta: { job: jobId, commit },
  modules: [
    {
      moduleId: module.id,
      title: module.meta.title,
      original: 'modules/en/charging.adoc',
      units,
    },
  ],
});
const words = wordCount(units[0], 'en');
```

## The document

- `<xliff version="2.0" srcLang trgLang>` with the platform's namespace `xmlns:ccms="urn:ccms:xliff:1.0"`; each entry of `meta` is a `ccms:<key>` attribute (the API names the job and the commit).
- `<file>` carries `srcDir` and `trgDir` (`ltr` or `rtl`) when the document gives `XliffDocument.srcDir` and `trgDir` (the API takes them from `languageDirection`, #458), so a translation tool sets a right-to-left target right to left.
- One `<file id="<moduleId>" original="<path>">` per module, one `<unit id="<blockId>">` per unit, in document order. An image callout's legend (#548) is a unit of its own: `id` the callout's ID (a block ID, unique in the module), `ccms:kind="callout"`, `ccms:image` the image block holding it, one segment `legend`, right after the image's unit; every callout is sent, whichever variants show it, and the path note ends `image#<image> > callout#<callout>`. A unit carries `ccms:sourceHash` (the `sourceHash` of the text it holds: what the translation will have been made from, for the import's translation record) and `ccms:kind` (the block type, or `item`), `canResegment="no"` and `xml:space="preserve"`, and two notes: `category="ccms:module"` with the module's title and `category="ccms:path"` with where the unit sits (`section#intro > list#steps > item#step-1`).
- A page design's region text (#568, `xliffUnitsOfDesign(design, source, include?)`) is a `<file>` of its own: `id="design.<designId>"` (an XML name token, as XLIFF's `id` must be; a module ID has no dot, so no module takes it), `original="design/<designId>.yaml"`, the design's name in the `ccms:module` note. One unit per block of a region (`designUnits` in `@openfolia/content-model`), `id="<slot>.<blockId>"`, in the preset's slot order, its path note starting `region#<slot>`. The XLIFF notation `design/<id>#<slot>/<block>` the issue sketched is not used: `/` and `#` are not allowed in an `id`. Placeholders are `<ph>` with `ccms:key`, as an attribute reference is: a target may only use the codes its source has, so an unknown placeholder is refused like any other added code.
- A manual's own text (`xliffUnitsOfManifest(manifest, source, include?)`: its title and its groups' titles, #731, and its cover images' alternative text, #656) is a `<file>` of its own too: `id="manual.<manualId>"`, `original="manuals/<manualId>.yaml"`; the title is the unit `title` and each group title `group.<12 hex>`, `ccms:kind="section"` with one `title` segment, their path notes `title#manual` and `group#<12 hex>`; one unit per cover image keyed `coverImage.default` or `coverImage.variant-<12 hex>`, `ccms:kind="image"` with one `alt` segment, its path note `coverImage#default` or `coverImage#<variant slug>`; all of plain text (no inline codes, so a target with any is refused).
- The configured labels (#731, `xliffUnitsOfConfig(config, include?)`): a unit per label keyed as in the record (`moduleTypes.<id>`, `facets.<id>.<value>`, …), `ccms:kind="section"` with one `title` segment of plain text, its path note `label#<key>`; the API writes them as the `<file id="config.project" original="openfolia.yaml">`.
- One `<segment id="<field>">` per part of the unit (`content`, or an image's `alt` and `title`, an attachment's `name` and `description`, …), each with its `<source>`. No `<target>`: no previous translation is sent.
- No DOCTYPE, no entities: the output is UTF-8 with an XML declaration.

## Inline content

| Model                        | XLIFF                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `strong`, `emphasis`         | `<pc type="fmt" subType="xlf:b">`, `subType="xlf:i"`                                                                                                   |
| `code`, `sub`, `sup`         | `<pc type="fmt" subType="ccms:code">`, `ccms:sub`, `ccms:sup`                                                                                          |
| `ui`                         | `<pc type="ui" subType="ccms:ui">`                                                                                                                     |
| `link`                       | `<pc type="link" subType="ccms:link" ccms:href="…">`                                                                                                   |
| attribute reference          | `<ph type="other" subType="ccms:attribute" ccms:name="…" disp="{name}"/>`                                                                              |
| cross-reference with text    | `<pc type="link" subType="ccms:xref" ccms:module="…" ccms:block="…">` around its text, which is translated                                             |
| cross-reference without text | `<ph type="link" subType="ccms:xref" ccms:module="…" ccms:block="…" disp="[module#block]"/>` (it shows the target's title, translated with the target) |
| keyboard shortcut            | `<ph type="ui" subType="ccms:kbd" ccms:keys='["Ctrl","S"]' disp="Ctrl+S"/>` (keys are not translated)                                                  |
| callout reference            | `<ph type="other" subType="ccms:callout" ccms:block="…" ccms:callout="…" disp="(<callout id>)"/>` (its number depends on the variant)                  |
| hard break                   | `<ph type="fmt" subType="xlf:lb" equiv="&#10;"/>`                                                                                                      |

Marks are flat in the model (a set per text run) and nested in XLIFF: `<pc>`s open in the model's canonical order (`MARK_ORDER`), so neighbouring runs sharing their outer marks share their `<pc>`; reading the result back and normalizing it gives the same runs. Inline codes are numbered from 1 in each unit (`id` is unique within the unit, across its segments).

## Escaping

Everything from the content goes through one of three escapes (`lib/xml.ts`): inline text (`&`, `<`, `>`, a carriage return as `&#13;`), plain element text (notes) and attribute values (also `"` and tab, line feed and carriage return as character references, so a parser keeps them). A code point XML 1.0 cannot carry at all (a C0 control, a lone surrogate, U+FFFE, U+FFFF) is XLIFF's `<cp hex="…"/>` in inline text, so it reads back exactly, and U+FFFD in a note or an attribute. `writeXliff` throws `XliffWriteError` for what XLIFF cannot express: no module, a module without units, a `meta` key that is no XML name.

## Words

`wordCount(unit, lang)` counts the word-like segments (`Intl.Segmenter`, word granularity) of each part's plain text (`plainTextOf`), so a language written without spaces counts too; for a provider's quote, roughly.

## Reading it back

A translated document comes back from outside: it is read as untrusted input.

```ts
const doc = readXliff(xml); // throws XliffReadError with a `reason`
for (const file of doc.files) {
  for (const unit of file.units) {
    const sent = xliffUnitsOf(module, new Set([unit.blockId]))[0];
    const result = targetParts(sent, unit);
    if (result.ok)
      use(result.parts); // TranslatablePart[], valid inline content
    else refuse(unit.blockId, result.reason, result.detail);
  }
}
```

- **`readXml`** (`@openfolia/xml`, its README) is the parser, its own, iterative (no recursion, so depth never costs stack): no DTD at all (`<!DOCTYPE>`, so no entity declaration, internal or external, is ever read: `dtd-forbidden`), no entity but the five XML predefines (`&amp;` …) and character references, so nothing is fetched and nothing expands (no billion laughs); bounded by `XmlLimits` (`DEFAULT_XML_LIMITS`: length, element depth 64, nodes, attributes per element); XML 1.0 characters only; namespaces resolved; comments and processing instructions skipped, CDATA as text. A document declaring another encoding than UTF-8 is `unsupported-encoding`. Each refusal has a stable `reason` (`XmlRefusal`).
- **`readXliff`** (`lib/read.ts`): an XLIFF 2.0 `<xliff>` (else `not-xliff`) with `srcLang`, `trgLang`, its `ccms:` attributes as `meta`; `<file id>` per module and `<unit id>` per block (also inside `<group>`), each ID once, with `ccms:sourceHash` and its segments' `<source>` and `<target>` (else `invalid-xliff`). At most `MAX_READ_UNITS` units.
- **`targetParts(sent, read)`** (`lib/target.ts`) turns a unit's targets into the parts of the content model, strictly against the unit as sent: the same segments (`missing-segment`, `extra-segment`, `missing-target`); exactly the source's inline codes, each once (`missing-code`, `extra-code`, `unknown-code`), of the same element and kind (`code-mismatch`), with the same parent (`nesting`: a code may move among its siblings, as word order wants, but not into or out of another); no other markup (`unsupported-markup`), no hard break where the field takes none (`line-break`), not empty (`empty`), and valid inline content once read (`invalid-content`). A code's meaning (a mark, a link's `href`, an attribute's name, a cross-reference's target, keys) comes from the source the server wrote again, never from the target's attributes, so a translator's file can neither change a link nor add one.

## COTI packages

COTI (the open exchange standard between content and translation management systems) level 1 puts a job in a ZIP package: one folder per translation project (one source and one target language), each with its project description `COTI.xml` and its files. `lib/coti.ts` writes and reads that description; the API packs the ZIP (`backend/api`, "COTI packages").

```ts
const xml = writeCoti({
  creator: 'OpenFolia',
  creationDate: now,
  packageId: jobId,
  name: `Translation job ${jobId}`,
  projectId: `${jobId}-de`,
  checkoutDate: exportedAt,
  dueDate,
  meta: [{ name: 'job', value: jobId }],
  translationName: `translation-${jobId}-de`,
  sourceLanguage: cotiLanguage('en'), // en-US
  targetLanguage: cotiLanguage('de'), // de-DE
  status: 'none',
  files: [{ fileRef: 'translation files/x.xlf', mimeType: XLIFF_MEDIA_TYPE }],
});
const read = readCoti(xml); // throws CotiReadError with a `reason`
```

- **`writeCoti`**: specification 1.1, level 1, in the standard's namespace (`COTI_NAMESPACE`), UTF-8, no DTD; every value escaped as an attribute or element text. Throws `CotiWriteError` for what the schema refuses: a language that is not `<language>-<region>`, no file, a file reference that is not a relative path of 1 to 255 characters, a MIME type that is none.
- **`cotiLanguage(tag)`**: a BCP 47 tag as COTI writes it, language and region, the tag's own region or its likely one (`Intl.Locale#maximize`); `cotiTimestamp(date)` the package name's time (`2009-11-13T103935Z`), `cotiProjectFolder` the folder (`<project-id>_<source>_<target>`, only `[a-zA-Z0-9_-+]`).
- **`readCoti(xml)`** reads a description back as untrusted input with `readXml` (no DTD, no entities but XML's five, UTF-8 only, bounded by `COTI_XML_LIMITS`): a `<coti>` in the namespace (else `not-coti`), its `level` and `version`, exactly one `<project>` with a `project-id`, exactly one `<translation>` with its languages and at least one `<translation-file>` (`file-ref` a relative path inside the folder: `isRelativeFileRef`, and `mime-type`), else `invalid-coti`; `<meta>` entries by name (an object without a prototype), `package-id` and `status`. Reference files are not read.
- **`cotiSchemaErrors(xml)`**: the standard's schema rules (`COTI11.xsd`, specification 1.1.2) written out: elements in order and number, the attributes each takes and their types. The tests check every description written with it; the schema file itself is not part of the repository (the standard's licence lets it be passed on only whole, with the specification).

## Tests

`src/lib/write.spec.ts` checks the output against the XLIFF 2.0 core schema (OASIS, `src/testing/schemas/`, with the W3C schema of the `xml:` attributes it imports) with `xmllint-wasm`, a test-only dependency. `src/lib/read.spec.ts` reads this writer's output back (the round trip, every inline kind, each refusal), and refuses hostile documents: an external entity, a billion laughs, an undefined entity, every limit.
