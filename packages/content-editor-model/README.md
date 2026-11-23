# @openfolia/content-editor-model

The editor's document model: a ProseMirror schema that mirrors the content model
(`@openfolia/content-model`) one to one, and the converters between the two. The stored form stays the
content model; the editor edits ProseMirror JSON. No UI: the editor app adds node views, menus and
key bindings on top of these extensions, never another node type.

```ts
import {
  createEditorExtensions,
  fromEditor,
  normalizeEditorDoc,
  toEditor,
} from '@openfolia/content-editor-model';

const editor = new Editor({
  extensions: [...createEditorExtensions() /* , behaviour */],
  content: toEditor(module),
});
// on save:
const module = fromEditor(normalizeEditorDoc(editor.getJSON()));
```

## API

| Export                     | What                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `toEditor(module)`         | the module as an editor document (`EditorDoc`)                                                              |
| `fromEditor(doc)`          | the document as a module, the exact inverse: `fromEditor(toEditor(m))` equals `m`                           |
| `regionToEditor(blocks)`   | a page design region's blocks (#393) as an editor document of no module (`moduleId` empty, `meta` null)     |
| `regionFromEditor(doc)`    | the inverse, checked as `RegionBlocks`; a document of only empty paragraphs is `[]` (no text)               |
| `normalizeEditorDoc(x)`    | repairs any JSON into a document the schema accepts; throws only a limit error; its result is a fixed point |
| `createEditorExtensions()` | the schema as TipTap extensions (nodes and marks, with HTML for copy and paste)                             |
| `getEditorSchema()`        | the ProseMirror `Schema` of those extensions                                                                |
| `exceededLimit(x)`         | the cap a document breaks (`TooManyNodesError`, `NestingTooDeepError`, `DocumentTooLargeError`), or `null`  |
| `NODE_ATTRS`, `MARK_ATTRS` | every node and mark type with its attributes' types and defaults (`spec.ts`)                                |

**Errors.** A converter failure is a `ConversionError` whose `blockId` names the block it is in: its
own ID (an invalid one too, when that is the problem), or the nearest enclosing block's when the node
at fault has none (a list item's text, a table cell, a block missing its ID). It is `null` when no
block is around the problem: the module's own ID or metadata, or a top-level node that isn't a block
or has no ID. `problems` lists every problem the model found. A document over a cap is an
`EditorLimitError` (`limit`: `nodes`, `depth` or `size`), thrown before anything is read; it is never
turned into a shorter or empty document.

## The document

The module's `id`, `schemaVersion` and `meta` are the `doc` node's attributes (`moduleId`,
`schemaVersion`, `meta`). Below it, one node per block, named as the block type:

| Node                                                                          | Content                                | Attributes                                                                       |
| ----------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| `doc`                                                                         | `(block \| pageBreak)* section*`       | `moduleId`, `schemaVersion`, `meta`                                              |
| `paragraph`                                                                   | `inline*`                              | `id`                                                                             |
| `section`                                                                     | `title (block \| pageBreak)* section*` | `id`                                                                             |
| `list`                                                                        | `listItem+`                            | `id`, `ordered`                                                                  |
| `procedure`                                                                   | `title? listItem+`                     | `id`                                                                             |
| `listItem` (list items and procedure steps)                                   | `itemText block*`                      | `id`                                                                             |
| `table`                                                                       | `title? tableRow+`                     | `id`, `header`, `columns`                                                        |
| `tableRow` / `tableCell`                                                      | `tableCell+` / `block+`                | — / `colspan`, `rowspan`                                                         |
| `image`                                                                       | `title? callout*`                      | `id`, `asset`, `alt`, `width`, `calloutOrder`                                    |
| `callout` (#498, only in `image`)                                             | its legend: inline, no breaks          | `id`, `anchor`, `label`, `when`, `style`                                         |
| `attachment`                                                                  | atom                                   | `id`, `asset`, `name`, `description`, `fileName`, `mediaType`, `size`            |
| `safety`                                                                      | `hazard block*`                        | `id`, `severity`, `symbols`                                                      |
| `admonition`                                                                  | `block+`                               | `id`, `kind`                                                                     |
| `faq`                                                                         | `question block+`                      | `id`                                                                             |
| `variant`                                                                     | `block+`                               | `id`, `when` (the condition tree)                                                |
| `moduleRef`, `passthrough`                                                    | atoms                                  | `id`, `module`, `block` (#223: one block of it; `null`: whole) / `format`, `raw` |
| `literal`                                                                     | `text*`, no marks                      | `id`, `language`                                                                 |
| `pageBreak`                                                                   | atom, only in `doc` and `section`      | `id`                                                                             |
| `title`, `hazard`, `question`, `itemText`                                     | inline (titles: no breaks)             | —                                                                                |
| `text`, `hardBreak`; `attribute`, `xref`, `kbd`, `placeholder` (inline atoms) | —                                      | `name`; `module`, `block`, `text`; `keys`; `key`                                 |
| `calloutRef` (inline atom)                                                    | —                                      | `block` (the image), `callout`                                                   |

An image's callouts (#498) are `callout` children after its title, in their stored order, each holding its legend; `anchor` and `label` are `{ x, y }` from 0 to 1. Their numbers are derived (`numberCallouts` in the content model), so no node holds one; the editor edits them on the picture (#547), and its caption edits keep them. The repair step keeps callouts in their image (anything else in an image moves out after it), turns a stray callout into a paragraph of its legend, and gives callouts and blocks IDs unique among them all, as the model asks.

A `placeholder` (#390) is a page design's data field (`key`: `title`, `page`, …), shown as `[key]`; only a page design's text holds one (in a module it is the model's validation error `placeholder-in-module`), so a region's blocks edited as a document round-trip like a module's.

An empty table cell (no blocks in the model) is a `tableCell` holding one empty paragraph to type in; `fromEditor` writes a cell holding only an empty paragraph back as no blocks, so a fresh table or an empty column saves.

Marks: `link` (`href`), `term` (`termId`, #245), `ui`, `strong`, `emphasis`, `code`, `sub`,
`sup`, ranked in the model's `MARK_ORDER`, so ProseMirror sorts them as `normalizeModule` does. A
term link renders as `<span data-mark="term" data-term-id="…">` and is pasted back only with a valid
term ID; `link` and `term` exclude each other (one replaces the other on the same text), as the
model allows only one, and `normalizeEditorDoc` keeps the link where both come in, and drops a term
mark naming no valid ID (its text stays). Inserting and showing term links in the editor is #247. A field the model leaves out is
`null` in the document (and left out again by `fromEditor`). The JSON is exactly what ProseMirror's
`Node.toJSON()` writes: `attrs` with every attribute, `content` and `marks` only when there are
some.

Where ProseMirror can say it, the schema says what the model says (sections only at the document
or in a section, after its other blocks; page breaks only between the blocks of the document or a
section; required titles; non-empty containers). The rest (an empty
paragraph, section and list depth, table geometry, a value out of range) is checked by `fromEditor`
with the model's own schema, and reported with the block ID.

## The three steps, and what each may change

- **`toEditor`** and **`fromEditor`** change nothing. `fromEditor` is strict: an unknown node or
  mark, a node in the wrong place, content inside an atom or a text node, formatting on anything but
  text or a field the model refuses is an error, never dropped or guessed.
- **`normalizeEditorDoc`** is the repair step for what an editor (or a paste) hands over. It gives
  every block a valid, unique ID (a repeated one is kept by the first block in document order; the
  editor should give pasted blocks new IDs before that), types attributes, puts nodes where the
  schema allows them (unwrapping, never dropping, content in the wrong place; a block inside a line
  of text moves out after it, whole), canonicalizes text (line breaks as `hardBreak`, marks sorted,
  runs merged) and fills in what the schema requires. It drops only what holds nothing (a value that
  is neither a node nor holds any, an empty unknown node, a list or table without items or rows, a page break where no page can break, keeping anything inside it),
  formatting on anything but text, attribute values of the wrong type and a link mark whose address `isLinkHref` refuses (its text stays); pasted HTML keeps only such links, and `fromEditor` refuses any other address. Over a cap, given or
  reached by the repair (line breaks become nodes), it throws the named `EditorLimitError`. Its doc
  comment has the full list. A document `toEditor` made from a module in normal form comes back
  unchanged.

**On a server**, a posted body goes to `fromEditor` as it is (it checks the caps and repairs
nothing). Repairing is the editor's step, before it hands the document over.

**Caps** (`limits.ts`): `MAX_EDITOR_NODES` 20,000 nodes, `MAX_EDITOR_DEPTH` 64 levels,
`MAX_EDITOR_CHARS` 2,000,000 characters of JSON; attribute values (a condition, the metadata) nest at
most `MAX_EDITOR_DEPTH` levels too. Checked first by all three steps, by one walk over everything
that stops at the caps, so a hostile document (a cycle, a shared object met over and over, a deep
condition) costs at most the caps.

**Copy and paste.** Every attribute is rendered into a `data-*` attribute as JSON and parsed back
(a value of the wrong type is ignored). Links get a real `href` only for `http`, `https` and
`mailto`. Images render no address: the editor's node view shows the asset. The parse rules read our
own `data-node` markup from any HTML, so a page put on the clipboard elsewhere could carry a
`moduleRef`, `variant`, `passthrough` or `image`. The editor honours those only when it copied them
itself, and gives pasted blocks new IDs. ProseMirror's `data-pm-slice` attribute proves nothing,
since any page can write it. So the editor keeps, in memory, the guarded nodes of what it last put on
the clipboard (`transformCopied`), and in `transformPasted` it keeps a pasted guarded node only
when the node equals one of those, IDs aside. Any other is taken out: a variant leaves its blocks, the
others go. The playground does this in `frontend/editor/.../plugins/paste-guard.ts`.

## A new node type or attribute goes in every place at once

A new block, inline, mark or condition type in `@openfolia/content-model`, or a new field on one:

1. `src/lib/spec.ts`: `BLOCK_NODES` / `INLINE_NODES` and `NODE_ATTRS` (or `MARK_ATTRS`);
2. `src/lib/extensions.ts`: its node (content expression, group, HTML);
3. `src/lib/to-editor.ts` and `src/lib/from-editor.ts`: both directions;
4. `src/lib/normalize.ts`: its repair in `repairBlock` (or the inline repair);
5. `src/testing/arbitraries.ts`: its generator;
6. `src/lib/schema.spec.ts`: `CHILDREN`, when the new field is a child node rather than an attribute.

The compiler refuses the build until 1, 3 (`toEditor`) and 5 have the new type (the tables are
typed by the model's unions). The tests catch the rest: `schema.spec.ts` fails when the schema's
nodes and attributes differ from the model's types and fields, the round-trip property fails when a
converter loses or changes anything, the normalize property fails when the repair step changes a
valid document, and a coverage test fails when an attribute never leaves its default in the
generated documents (a new field the converters or the generator don't carry).

## Tests

- `round-trip.spec.ts`: `fromEditor(toEditor(m))` equals `m` over 3,000 random valid modules (not
  in normal form: marks out of order, empty mark lists, spans of 1); through a real ProseMirror
  document only normalization happens; a module in normal form is written exactly as ProseMirror
  writes it, and `normalizeEditorDoc` leaves it alone.
- `normalize.spec.ts`: over random garbage and damaged documents, `normalizeEditorDoc` throws only
  limit errors, keeps every character of text it was given, and its result is valid in the schema,
  in ProseMirror's JSON form, has unique valid IDs and is a fixed point; `fromEditor` on it fails
  only with `ConversionError`.
- `from-editor.spec.ts`: every kind of failure names its block; the caps.
- `html.spec.ts` (jsdom): rendering to HTML and parsing back keeps every node and attribute.

```
nx test content-editor-model
nx run content-editor-model:typecheck
```

TipTap packages are pinned to one exact version (a test holds them equal).
