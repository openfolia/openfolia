# `frontend/editor` (`@openfolia/editor`)

The editor, an Angular application (standalone components, signals, zoneless) built with
`@angular/build`. Its screens come with later issues; today it has the shell (sidebar, breadcrumb,
account menu), a placeholder page per section, Admin with its side rail, screen 0 at `/theme` and, in
development builds only, the `/showcase` route that mounts the library's component showcase and
the `/doc-editor` block editor playground.

## Branding and screen 0

`src/docs.config.ts` holds the branding (`productName`, `logo.small`, optional `logo.full`,
`logo.smallDark` and `logo.fullDark` for a dark page, `favicon`, optional `faviconPng` (16 and
32 px), `appleTouchIcon` and `manifest`; the app adds them to the page's head). The
defaults are the product's own brand, OpenFolia: its assets come from `@openfolia/theme`
(`frontend/theme/src/brand/`), which the build serves at `assets/brand/`, and its `favicon.ico`
at the root (what a browser asks for when it reads no icon link), next to the web manifest
(`src/manifest.webmanifest`: the name and the 192 and 512 px app icons). An installation's branding
sets its own in Admin → Branding (below); these are the defaults it falls back to. Without `logo.full` the full logo is the mark next to the product
name, which reads in both themes. Screen 0, at
`/theme`, shows the logo slots and the main colour tokens with what they are for, as the design
draws them, then every token of `theme.css` (light and dark side by side, values read from the
computed style). Add a token to `theme.css` and to `pages/theme/theme-tokens.ts` together (a
test checks).

## Shell and dark mode

`src/app/shell/` lays out the app on the library's Zard sidebar: floating, collapsible to icons
(the logo mark, which turns into an expand button on hover or focus, and the account initials),
a drawer below 768 px. The breadcrumb comes from route data (`breadcrumbsOf`). Admin
(`pages/admin.page.ts`) has the page header with the open page's primary action, guarded by the
permission helper, and a side rail (#591): the pages the role may open (`ADMIN_TABS` in
`shell/nav.ts`, each naming its group) under five group headings (`ADMIN_GROUPS`: People and
access, Content, Look, Integrations, Operations), a group with none left out. A heading is a label,
not a menu; the current page is marked (`aria-current`), Project settings on each of its topics.
Below 1024 px the rail is a select above the page, with the groups as option groups. A new admin
page names its group. Pages not built yet show
`pages/placeholder.page.ts`. A section
the role may not use stays out of the sidebar, and its address (any address under it, a deep
link into an Admin page too) shows the no-access page (`pages/no-access.page.ts`, `guarded` in
`app.routes.ts`): the address stays, the page names the permission the section needs and links
to the start page, in demo mode with the hint to switch user, and once the person holds the
permission the section opens in its place. An address no screen has is "Page not found"
(`pages/not-found.page.ts`). The account menu holds the theme choice (Light / Dark / System);
`index.html` applies the stored choice before the app boots, so the first paint is in the right
theme.

The account menu also links to the source code and the licence (`src/app/about/`, #370; AGPL-3.0
section 13), as `GET /about` names them (`CCMS_SOURCE_URL`); the sign-in page shows the same
links under its card, so someone who cannot sign in is offered the source too. Without a source
address both show only the licence, and Admin → System tells the admin to set `CCMS_SOURCE_URL`
(#453). The links appear once `GET /about` answers (a failed read is tried again the next time).

## Block editor (`src/app/doc-editor/`)

`of-block-editor` hosts TipTap 3 (`@tiptap/core`, `@tiptap/pm`) on the content model's editor
schema (`@openfolia/content-editor-model`), in a standalone component: the core the module editor
(below) mounts, and the `/doc-editor` playground too. Its `value` is a document as `toEditor` makes it, read once, when the editor is made
(another document means a new instance) and repaired on the way in (`normalizeEditorDoc`).
`changed` hands on the document after each edit, without the caret gaps and ready for
`fromEditor`; mounting alone hands on nothing. `/doc-editor` (development builds only) loads a
sample module holding every block type (`sample-module.ts`) and shows, as you type, the content
model (`fromEditor`, or the conversion error with the block's ID) and the ProseMirror JSON.
`editable` (default true) makes it read-only (no toolbar), `issues` marks blocks with a problem
(`plugins/block-issues.ts`: a dashed outline, the text as its description, following the block as
the document changes), `blurred` fires when the focus leaves the editor and `focusBlock(id)` puts
the caret in a block and scrolls it into view.

- **Schema:** the package's extensions, never another node type (`extensions.ts`). Text,
  section headings, lists and tables are edited here; every other block by its node view
  (`blocks/`, below): safety notices, variant blocks, module references, images, admonitions,
  procedures, code blocks and passthroughs.
- **Safety symbols** (`blocks/safety-node.component.ts`, on the library's `of-safety-symbol`,
  #208): each symbol of a safety notice shows its artwork beside the signal word, its configured
  label as the text alternative; the header's menu shows each configured symbol's artwork beside
  its label (read once its button is pointed at or focused). The module editor reads the artwork
  through `SymbolSources` (`src/app/images/`: `GET /symbols/{id}` at the change set's branch,
  once per symbol). A symbol without artwork (none in the repository, a file that is no image,
  one that cannot be read) shows its label, marked "No artwork": never a broken image. **SVG never
  runs:** the editor makes no `blob:` URL of an SVG (one opened in a tab would run in the editor's
  origin); SVG artwork is drawn as an image from a `data:` URL that never enters the page and read
  back as a PNG (`svg-raster.ts`), and only that PNG gets a URL. The previews do the same.
- **Admonitions** (`blocks/admonition-node.component.ts`, on the library's `of-admonition`): a
  note, a tip or something important, its blocks edited in place. The kind's word is the
  configured output label in the document's language (`outputLabels`: `note`, `tip`,
  `important`), its icon is the kind's; the header's menu switches the kind in place, the colours
  fading to the new one (at once under reduced motion). "/" Note and the toolbar's Insert menu
  add one.
- **Procedures** (`blocks/procedure-node.component.ts`, `plugins/procedure-steps.ts`): numbered
  steps edited like a list's items (Enter adds a step, Enter on an empty last step leaves the
  procedure, Tab makes a step a sub-step: a procedure in the step before; Shift+Tab lifts it
  back). A procedure is a flow of its steps (`flow.ts`), so a step moves by its grip and
  Alt+Up/Down among its procedure's steps, after the title. The title is optional ("Add title";
  Backspace in an empty one takes it away). The model has no field for a step's result: it is the
  first paragraph of the step's blocks, marked "Result", added by "/" Step result.
- **Code blocks** (`blocks/literal-node.component.ts`, the model's `literal`): monospace, every
  space and line break kept, plain text only (no marks); Tab inserts two spaces and Shift+Tab
  takes them off the caret's line, Enter is a line break. The language is picked in the header
  ("Language", `blocks/code-languages.ts`): a searchable list of common languages by name (Plain
  text for none), the project's `codeLanguages` added to it, and a word typed in offered as
  "Use “xyz”" within the model's rule (one word, at most 32 characters); a word the model would
  refuse is named, never set. There is no syntax highlighting.
- **Passthroughs** (`blocks/passthrough-node.component.ts`): an importer's unconverted source,
  read-only: its format and the start of its source, "Show source" opens all of it, always as
  text. The node is an atom: selected, moved and deleted whole, and out of the editor exactly as
  it went in.
- **Images** (`blocks/image-node.component.ts`, on the library's `of-image-block`): an atom
  showing the picture at its width (a percentage of the column; none: its own size), the caption
  and the alt text. The page reads the picture (`DocBlockSettings.imageSource`, an object URL);
  missing and failed say so in words in a muted box (at most 20rem wide, never an empty or broken
  `<img>`: a picture that does not load counts as failed), failed with Retry. "/" Image and the Insert menu's Image open the
  page's image picker (`pickImage`) first and insert what was chosen where the caret was, selected
  (`pickAndInsertImage`); without a picker both are unavailable (the menus say why). Edit (or a
  double click) opens the picker with the block's image, alt text, caption and width and puts the
  answer back in one undo step, with the focus back in the document; a caption left as it was
  keeps its formatting, a changed one is plain text. Read-only, there is no Edit. An image file
  (PNG or JPEG) dropped on the document or pasted into it opens the same picker with that file
  already uploading (`blocks/image-files.ts`, `pickImage`'s `file`), so its alt text and size are
  set there too, and goes where it was dropped, or at the caret.
- **Callouts on an image** (#547, `blocks/callouts.ts`, `callout-panel.component.ts`,
  `callout-legend-field.component.ts`, on the library's `of-callout-overlay`): the picture shows
  its callouts' numbers, in the variant the live preview shows (`DocBlockSettings.variant`; none:
  every callout counts, a hidden one is drawn "–"). "Edit callouts" (off by default) makes the
  picture take clicks: one adds a callout there (`<image>-<n>`, no leader line) and focuses its
  legend; "Add callout" puts one in the middle. A marker is dragged (one undo step, on release) or
  moved with the arrow keys (0.01, Shift 0.05); Delete removes it, with Undo in the toast. The
  panel lists them in number order: the legend is edited in place (one line, with marks, in a
  nested editor whose Mod+Z and Shift+Mod+Z go to the document's history; Enter or Escape ends
  it), each one's variants (the page's variant picker), its leader line, Delete; a row moved by
  its grip numbers them in the author's order, "Number in reading order" goes back. An empty
  legend leaves the draft incomplete until one is typed. Not in a page design region.
- **Callout references** (`calloutRef`, `inline/`): "/" Callout reference picks a callout of the
  module's images (grouped per image, with its number); the chip shows the number in the shown
  variant, or "?" with why (hidden there, or gone). A pasted image keeps its callouts and, when
  its ID is taken, gets a new one; references pasted with it follow the copy
  (`plugins/paste-guard.ts`).
- **Callout highlighting** (#549, `inline/callout-hover.ts`): a callout's marker, its row in the
  panel and the reference chips to it light up together while one of them is under the pointer
  or holds the focus (a chip: selected with the keyboard). The editor keeps one hovered callout
  (`DocBlocksContext.calloutHover`, image block ID and callout ID); each source clears only the
  highlight it set. The chips' highlight is a node decoration, outside the document and Undo. A
  ring (an outline and a background on a row), never colour alone and never a change of weight
  (nothing moves); eased only
  without reduced motion.
- **Blocks in a procedure step** (`plugins/block-place.ts`): with the caret in a step's text (or a
  sub-step's), "/" and the Insert menu put a block under that text, in the step: an image above
  all (indented with the step, the size preset's width, several per step), but also a safety
  notice, a note, a table, code, a sub-procedure, a variant block, a module reference or an
  attachment. A page break goes after the procedure, where a page can break. A step is a flow of
  the blocks under its text (`flow.ts`), so the grip, a drag and Alt+Up/Down move them within
  their step and into the other steps of their procedure (Alt+Up/Down never out of it, never above a step's text or its result,
  never among the steps); a block outside the procedure steps over it whole. A step of a
  procedure in a note, a table or a list moves whole, as before. A paste that carries text is
  pasted as text, even beside a picture.
- **Attachments** (`blocks/attachment-node.component.ts`, on the library's `of-attachment-block`):
  an atom showing an icon by the file's type, the name readers see, the file name, type and size
  (`formatFileSize`), the description, and Download. Download goes through the page
  (`DocBlockSettings.downloadAttachment`, `AttachmentFiles`): the file is saved, never opened or
  shown; a file that is gone turns the block to "File not found", a failed read is a toast with
  Retry. "/" Attachment and the toolbar's Insert menu open the page's attach-file dialog
  (`pickAttachment`) and insert the choice where the caret was, selected
  (`pickAndInsertAttachment`); without the dialog both are unavailable. Edit (or a double click)
  opens it with the block's file, name and description and puts the answer back in one undo step.
  The grip menu deletes, duplicates and moves it whole. Read-only, there is Download but no Edit.
- **Tables** (`plugins/table-editing.ts`): a CSS grid per table (its columns' widths), the
  caption first, a header row when the table has one. The slash menu and the Insert menu insert a
  2 × 2 table; the toolbar's table menu adds and removes rows and columns, toggles the header row
  and deletes the table. Tab and Shift+Tab go from cell to cell (past the last, a new row). Cells
  merge with the next one or the one below (when it covers the same rows or columns; never down
  from the header row, whose merged cells join their text in one paragraph) and split back, each
  place the cell covered getting an empty cell. A table with merged cells keeps its rows and
  columns until they are split; the menu says why. Each column has an alignment (left, centre,
  right, or none), shown on its cells. The model has no header column: only a header row.
- **Flows and moves:** the document and each section are flows; with the caret in a heading, the
  section moves. Where a block may go is `plugins/drop-rules.ts`: a block into any flow's text
  (between a heading and its subsections) and into a variant block's or safety notice's content;
  a section among the sections of any flow, its blocks and subsections with it, its level the
  depth it lands at, within the cap (the rules of `heading-levels.ts`). The grip's drag
  (`block-drag`) shows a dashed slot where the block lands (a long block's slot and lifted copy
  capped, fading out), slides what it passes, scrolls the editor's scroll area near its edges and,
  where several levels meet, takes the level a sideways pull asks for (the slot names it). Over a
  place it can't go (a heading between blocks, in a list, a table, a variant or safety block, past
  the cap) the slot stays at the last allowed place, the copy and the cursor say not allowed with
  the reason under the copy, and releasing there changes nothing. Alt+Up/Down and the toolbar step
  past one block, or across the flow's edge into the neighbouring one (a section at its own level)
  (`block-move`, `block-slide`). Every move is one transaction and an undo step of its own. A procedure is a flow of its steps
  (after its title): a step moves among its procedure's steps. A step is a flow of the blocks
  under its text: those go under the text of any step. A variant block's, a safety notice's and
  an FAQ entry's content is a flow of its blocks too (after the hazard or the question, which
  stand for their block, never with a grip of their own), so each of those blocks has its grip
  (in the gutter left of the frame; in a safety notice, which clips its frame, right before the
  block's text) and its menu, and is dragged out into the flow around, into another container or
  back. Alt+Up/Down, the toolbar and its grip's menu move it among its container's blocks and, at their edge, out of the container, right before or after it. Where it can't leave (a variant block's or FAQ answer's last block), Alt+Up/Down and the toolbar move the container instead (as with the caret in it before); its menu then has no move. A drag takes it further. A
  variant block's or an FAQ answer's last block stays (the frame can't be empty: the drag says
  so); a safety notice may keep its hazard alone. The containers' styling counts only their
  blocks (`:nth-child(… of …)`), so the grip, the slot and a folded block move no name or space.
- **Block actions menu** (`block-menu.component.ts`, `plugins/block-menu.ts`,
  `plugins/block-actions.ts`): a click on a block's grip (a press let go within 4 px; pressing
  and moving drags) or Shift+F10 / the context-menu key in the document opens a menu for that
  block, of any type: Move up and Move down (as Alt+Up/Down), Duplicate (the copy gets new IDs
  from the repair), Remove frame, keep content (for a frame around blocks, such as a variant
  block: the schema decides, so a new container type is covered) and Delete. Each is one undo
  step of its own; Delete asks nothing and says "Block deleted" in a toast with Undo (the toast
  goes once the document changes again). The block keeps its grip while the menu is open, which
  is placed against it by the dropdown menu's service (`createTriggerOverlay`).
- **Scrolling:** the document scrolls inside the editor's own scroller, the element with
  `data-slot="editor-scroller"` (a `cdkScrollable`, so overlays follow it). It is the container
  the caret-into-view scrolls and the drag's auto-scroll scrolls near its edges. It only has a height of its own where the
  page gives the editor one: the module editor does from `lg` up (the page fills the shell's
  content area and never scrolls as a whole; the outline and the details panel scroll on their
  own when taller); below `lg` the editor grows with its document and the page scrolls.
- **Text styles** (`plugins/structure.ts`): a section heading is a section's title, and the
  section holds the blocks after it. Text → heading and back move those blocks in and
  out; the block keeps its ID. Lists wrap a run of paragraphs, switch kind, or unwrap.
- **Heading levels** (`plugins/heading-levels.ts`): a heading's level is its section's depth
  (Heading 1 at the top of the module, Heading 2 in a Heading 1, …), offered up to the project's
  `maxHeadingLevel` (default 3; the page hands the configuration in, `setHeadingCap`). The
  toolbar's style picker shows the level at the caret and offers Text and Heading 1 to the cap;
  the slash menu offers the same headings. Tab in a heading demotes it into the section before it
  (as its last subsection), Shift+Tab promotes it out of its parent, right after it, taking the
  sections after it there along as its subsections; a section always moves with its blocks and
  subsections, and the reading order never changes. A level that would be skipped, past the cap,
  without a section to go under, or where no section may stand (a list, a table, a variant or
  safety block) is shown disabled with the reason. Each level change is one undo step. Tab outside
  a heading is the lists' and tables'.
- **Repair** (`plugins/model-repair.ts`): after every change, `normalizeEditorDoc` runs and its
  result is written back as a minimal patch in the same undo step, so the editor's document is
  always one the package accepts (a split paragraph's new half gets an ID, a duplicate ID is
  kept by the first block only).
- **Paste** (`plugins/paste-guard.ts`): pasted blocks get new IDs. A module reference, variant,
  passthrough or image is kept only when the editor copied that very node itself (it remembers
  what it put on the clipboard; `data-pm-slice` proves nothing): any other is taken out, a
  variant leaving its blocks. A drag within the editor always moves (never copies, which would
  share IDs), and the moved blocks keep their IDs.
- **Blank lines** (`plugins/blank-lines.ts`): blank lines are not spacing (the content model
  stores no empty paragraph, the outputs space blocks by their design). At most one blank
  paragraph stays, the one holding the caret, besides the caret gaps a flow needs; the others go
  once the caret leaves them, collapsing first (200 ms, at once under reduced motion). The
  tidying joins the last undo step rather than making one of its own, so one undo brings back
  the blank line with what made it (the Enter, the text deleted from it), exactly as typed;
  nothing is tidied while there is something to redo (until the next edit), nor while read-only. Enter on a
  blank line moves on to the next place to type and never stacks another; Enter at the start of
  a paragraph opens a line before it with the caret in it.
- **Inline types** (`inline/`): links, cross-references, text attributes and key combinations,
  each edited in one popover under the caret (`inline/inline-edit-popover.component.ts`, the
  logic in `inline/inline-edit.ts`). A cross-reference and a text attribute are chips
  (`inline/inline-views.ts`): the target's name (a section's title, "Table", a module's title) or
  the configured attribute's label; a target that is gone, a module that does not exist and an
  attribute not configured are inline issues (dashed, the reason as its description). A key
  combination shows as key caps. A click on one, Enter with it selected, or "/" Link,
  Cross-reference, Text attribute and Key opens its popover: a link's address (only http, https
  and mailto: `isLinkHref`, checked as typed, on apply and again by `fromEditor`; `https://` is
  added when no scheme is typed, `mailto:` for an e-mail address) and its text; a cross-reference's
  target among the sections, figures, tables, procedures and steps of this module and of the
  modules it refers to, or another module through the module picker in link mode
  (`pickModule(current, { linkOnly: true })`); a text attribute from the configuration; keys as
  typed ("Ctrl+Shift+S", "Ctrl++" for the plus key). A link opens in a new tab only with Ctrl/Cmd
  held (without an opener); a plain click edits. The selection bubble holds bold, italic, code,
  interface text, subscript, superscript, Link and Key. `editing-coverage.spec.ts` fails when a
  block type, inline type or mark of the content model has no editing UI here.
- **Keys** (`plugins/model-keys.ts`): Ctrl/Cmd+B, I, E for bold, italic and code; Ctrl/Cmd+Shift+U
  interface text, Ctrl/Cmd+, subscript, Ctrl/Cmd+. superscript, Ctrl/Cmd+K a link, Shift+Enter a
  line break in the text, Ctrl/Cmd+Shift+Enter the Insert menu. Enter at the
  start of a paragraph or list item opens a line before it (the text keeps its block and ID),
  splits a list item or leaves the list from an empty one. Tab and Shift+Tab nest and lift items
  (a nested list takes its list's kind). Backspace at the start of a heading turns it back into
  text; at the start of another title (a procedure's, a table's caption) it takes an empty one
  away and never merges text out of it. Backspace or Delete next to a block without text (an
  image, a passthrough) selects it first, and Delete before a section moves into its heading
  rather than pulling it into the section before.
- **Plugins** (`plugins/`, framework-free ProseMirror, each with its test) also hold caret gaps
  (`caret-gaps`: blank paragraphs where a caret could not land otherwise, around a block without
  text or a list, per flow; added on load, kept as the document changes and taken out of what is handed
  on), the remembered selection for commands from outside the editor (`selection-memory`), the
  click's caret read at once (`caret-sync`: on letting go of a press, before a key and before
  the grip follows the pointer, the browser's selection is taken into the state rather than when
  its `selectionchange` comes, so a key right after a click acts on the clicked block and a
  hover never puts the old caret back), and
  the slash command (`slash/`, on `@tiptap/suggestion`, with a `SlashMenuView` the UI
  implements; Text, Heading 1 to the cap, the two lists, Table, the documentation blocks, Note,
  Procedure, Code block, in a procedure's step its result, and the inline types;
  an item that can't run at the caret is shown disabled with its reason).
- **Snippets** (#136; `snippets/`, `plugins/snippet-suggestions.ts`): reusable wording is a
  module of a type the configuration marks `snippet: true`. **While typing**, once a paragraph's
  first words (at least two, six characters) are the start of a snippet's text, folded as search
  folds (`snippet-match.ts`, `foldText`), the rest of that snippet shows after the caret as ghost
  text in the line (muted, with a Tab key cap; never over the text, never selected or saved), and
  screen readers are told. Tab puts a reference to the snippet in the paragraph's place, with an
  empty line after it for the caret; Shift+Tab a copy of its blocks with new IDs (read through
  the page, `moduleContent`), the caret at its end; Escape dismisses it for that paragraph. Each
  acceptance is one undo step that brings the typed words back. One suggestion at a time, only
  with the caret at the end of a paragraph of plain text where a module reference may stand, and
  only while editing. The page hands the snippets over (`DocBlockSettings.snippets`): the module
  editor reads `GET /module-summaries?filter[snippet]=true` in the document's language at the
  chosen revision (`module-editor/snippet-list.ts`, `meta.text` the start of each text), so
  only snippets the person may read, in that language, are ever suggested, never the module
  itself. **"/" Snippet** and the Insert menu's Snippet open the module picker for snippets
  (`pickModule(null, { snippet: true })`, below) and insert the choice where the caret was: a
  reference, selected, or a copy. A reference to a snippet shows as the module reference card,
  labelled "Snippet". No suggestion is model-based: matching is plain text.
  **Save as snippet** (#309; `snippets/save-snippet.ts`): the block actions menu and the selection
  bubble turn the blocks a selection covers (from the block menu: that block, or the selection's
  run when it holds it) into a snippet. The run is the selected blocks of the innermost flow,
  procedure step or block container holding the selection where a module reference may stand (a
  title, a step's text or a hazard in it stands for what it leads). The page
  (`DocBlockSettings.saveSnippet`, the module editor's `save-snippet-dialog.component.ts`) asks for
  the title, the snippet type (preselected when there is one) and the ID (made from the title
  until typed), then creates the module through `ModuleCreation` in the revision being edited,
  with copies of the blocks under new IDs and the module's language, facets and audience. Only
  once it exists does a reference to it take the blocks' place, in one undo step; the blocks are
  found again by their IDs and must be unchanged, and the page must still show that module in that revision; else they stay and the toast says the snippet was saved but not inserted. A failed
  creation leaves the document as it was, with the toast's Retry (which also puts the reference
  in). Refused with the reason: no snippet type configured, no draft revision, a section or a
  module reference in the selection (`snippet-too-large`), a block the model can't hold yet. Not
  in a contributor's focused editor.
- **Writing aids** (#247; `writing/`): the terminology and style checks of #55 while typing, on
  the same engine (`compileWritingRules`, `checkWritingText` from `@openfolia/content-model/core`;
  no matcher of our own). The page reads `GET /terms` for the document's language (all pages,
  at most 10,000 terms) and the configuration's `styleRules` once per editing session, branch
  head and save point (`module-editor/writing-aids-source.ts`), and hands the compiled rules and
  the term index (`TermHints`) on in `DocBlockSettings.writing`; the aids shown meanwhile stay, so
  nothing flickers. `writing-checks.ts` (a ProseMirror plugin) checks the text fields
  (`writing-fields.ts`: paragraph and list item text, titles, hazards, questions, callout
  legends; never literal or passthrough blocks, nor text marked as code) **after a pause**
  (`DEBOUNCE_MS` 300, at most `MAX_WAIT_MS` 1,200 while typing on), and **only the fields that
  changed** (results cached per immutable node), within the engine's own budgets
  (`MAX_WRITING_CHARS` per pass). Findings are decorations: a dotted underline (thicker when
  blocking), a warning icon beside the field (never colour alone), mapped through edits until the
  next pass. The card (`writing-popover.component.ts`) peeks on hover or when the caret rests in a
  finding, a page suggestion or a term link, and takes the focus on Alt+Enter; Replace is one
  transaction (`closeHistory`), so one Undo takes it back, and refused when the text found has
  changed since; Ignore here holds for the editing session (by block, field, rule and text). A
  rule's message is text, never markup. `term-suggestions.ts` shows the rest of an approved
  term's preferred variant after three letters, and offers an allowed variant typed in full as a
  link (Tab, Escape; after the snippet suggestions, before the lists); `term-insert.ts` is "/"
  Term and Insert › Term (the page's term picker, `GET /terms` filtered to approved terms).
  **Budget**, held by `editor-e2e/specs/writing-aids.spec.ts` on a module of 400 paragraphs
  (about 24,000 words): a key on screen in at most 50 ms median and 100 ms at the 95th percentile,
  at most one check pass per three keys, each reading at most 2 fields within 16 ms (the
  `openfolia:writing-check` performance measures).
- **Placeholders** (#393): only a page design region's editor (`[region]`) has them, by typing `{`
  or from its Insert menu; in a module, `{` is a character.
- **Insert menu** (the toolbar's "+ Insert", Ctrl/Cmd+Shift+Enter): every block in groups,
  Content (table, image, attachment, code), Notices (safety notice, note) and Structure (procedure, variant
  block, module reference, page break), each with its icon and one-line hint, filtered as typed and stepped
  with the arrow keys; an entry that can't go at the caret is shown disabled with the reason.
  **One list builds both menus:** `SLASH_ITEMS` in `slash/slash-items.ts`; an item with a `group`
  is in the Insert menu too (`insertEntries`), so a new block type joins both with one entry
  there (its `group`, and `can`/`unavailable` when it can't always go). The attachment (Content)
  and the page break (Structure) joined so.
- **UI** from `@openfolia/ui` components: the toolbar (`role="toolbar"`, Left/Right between controls,
  tooltips with the shortcuts), the selection bubble (positioned by TipTap's bubble menu plugin)
  and the slash menu (a list box under the caret; the focus stays in the document, which points
  at the highlighted row with `aria-activedescendant`). Commands live in `editor-commands.ts`.
- **Tests:** `doc-editor.page.spec.ts` drives the playground (typing, Enter, Alt+Up, the slash
  menu, a drag, undo) and checks the content model after each step: only what was edited
  changes.

## Demo session and revision (`src/app/session/`)

A **revision** is what the API calls a change set (`/change-sets`, `ChangeSet…` and `cs` in code):
the editor's texts say "revision" (German "Überarbeitung"), code and addresses keep the API's name.

- **Demo mode** is learned from `GET /demo/users` (the API answers it only in demo mode, 404
  otherwise), asked once at start-up (`provideAppInitializer`). Without an answer there is no
  switcher, no `X-Ccms-User` header and no stored identity is used. `DemoSession` holds the users,
  the chosen one (local storage `openfolia.demo-user`, forgotten when no longer seeded) and `switchTo`:
  eager (name, checkmark and header at once), confirmed by `GET /me`, a refusal restores the
  previous user with a toast and a retry. The switcher (`of-demo-user-switch`) is projected into
  the account menu: menu radio items, scrolling inside their own box, with loading, empty and
  failed (retry) states.
- **Permissions** come from `GET /me` (`MeService`): nobody holds anything until it answers.
  Screens that depend on the person key their data on `me().id`.
- **Revision** (`ChangeSetSession`, `of-change-set-control` in the header next to the
  breadcrumb): one control, a trigger naming the revision that opens its menu: a searchable
  list ("Published content" and the open revisions, the state as a word, the chosen one ticked),
  then "Rename revision" (its author, while it is open) and "New revision", which turn the
  menu into their form. The choice points reads at its branch and is in the address
  (`?cs=`, below); without one there, this tab's last choice (session storage, none included),
  else the last one used in any tab (local storage), both `openfolia.change-set`. One the person
  cannot see is dropped with a notice. Starting is eager and
  rolled back with a retry toast on refusal; the retry of a lost answer first looks for the revision
  it may have made, so it never starts two. Until the API has answered, the revision is chosen
  under a placeholder ID (`pending:<n>`) that no request names: reads that need its ID take
  `startedId` (null meanwhile, #467).
- **Product version** (#250, `MaintenanceLines`, `of-line-badge`): "New revision" offers, for
  those who may read drafts and while a maintenance line is open, a radio choice "Product
  version": "Current (main)" (the default) or an open line, named by its product and version
  ("North 2.1"), never by its branch. The revision is started on the line
  (`POST /change-sets` with `maintenanceLine`). A revision on a line carries a badge naming that
  version (an icon and words, not colour alone) in the picker (its trigger and its list), the
  module editor's header, the review (its list and its header) and the content browser. Lines
  are read lazily, once per person (`GET /maintenance-lines`, with `GET /config` for the product
  labels): a base branch is shown as `main`, a line's product and version, or, until the lines
  are known (or for someone who may not read them), "an older product version". Every text that
  names a revision's base (update from main, move, base rewritten, conflicts) goes through
  `MaintenanceLines.label`.
- **Carry forward** (#250, `CarryForward`, `of-carry-forward-conflicts`): a revision merged into
  a line offers "Carry forward to current" on its review (`content.edit`), and the merge's toast
  offers it to whoever may edit (a publisher who may not is told its author can). It is never
  automatic. `POST /change-sets/{id}/carry-forward` starts a new draft on `main`; it is chosen and
  opened in the review. What `main` changed differently is listed in a dialog by module (and
  manual, settings, …), each changed block a button opening the module editor at it in the new
  draft (`/content/:lang/:id?cs=&block=`); "Later" keeps the list, "Done" drops it. Carried
  already (`already-carried-forward`): an info toast with "Open the draft".
- **A revision whose branch is gone** (#317: deleted outside the app, or the content repository
  restored or replaced). The list says so (`meta.branchMissing`), and so does any read at it that
  answers `change-set-branch-missing` (`missingBranchInterceptor` sets `ReadRef.missing`). The
  picker and the palette mark it in words ("branch missing") and the picker with an icon. While it
  is chosen, every screen that reads at it shows one message in place of its content
  (`of-change-set-branch-missing`, from the shell): "This revision's branch is missing from
  the content repository.", with **Leave revision** (back to the published content) and, for its
  author or an admin (`admin.roles` with `content.read.draft`, as the API allows), **Abandon revision**: at once, with Undo; the request goes once the toast ends. The sidebar, the breadcrumb
  and the picker stay usable; screens that read nothing at a revision (`data.changeSetFree`:
  roles, users, service accounts, screens not built yet, the not-found and no-access pages) show as
  they are. Nothing recreates the branch.

## View state in the address (`src/app/view-state/`, `session/change-set-url.ts`)

**Every screen keeps its view state (filters, search, sort, page, tab, selection) in the query
parameters, through `injectQueryState`**, so a reload, a copied link and Back/Forward show the
same view. Never in a component's memory only, and never with `Router`/`ActivatedRoute` by hand.

```ts
const view = injectQueryState({
  q: textParam(), // ?q=battery: a run of typing is one history entry
  type: idParam(/^[a-z][a-z0-9-]*$/), // ?type=procedure
  keyword: listParam(isKeyword), // ?keyword=a&keyword=b
  page: intParam(1), // ?page=2; 1 is left out
  size: intParam(50, { only: [25, 50, 100] }),
  state: oneOfParam(['draft', 'approved'], 'draft'),
});
view.get('page')(); // a signal per value; `view.values()` for all
view.set({ type: 'concept', page: 1 }); // a history entry
view.set({ page: 3 }, { replace: true }); // corrects the entry (past the end)
view.reset(); // every default: a clean address
```

- **Reading:** each parameter is parsed and checked; an invalid value (or a default written out)
  is ignored and taken out of the address, replacing the entry. A check that needs data (the
  configured types) is the screen's: it drops the value with `set(…, { replace: true })`.
- **Writing:** a choice adds a history entry; typing (`textParam`, after the screen's debounce)
  adds one per run, replaced while it goes on; defaults are left out. Two quick `set`s add up,
  and nothing is written once the screen is being left.
- **No reload for the same view:** the signals keep their value while the address stands for
  the same one; Back and Forward change them.
- Parameters a state does not name are left alone (`cs`, another component's).

**Names in use.** Short and readable; a repeatable filter repeats the parameter.

- Every screen in the shell: `cs`, the revision (below); `notifications` (`all`, `unread`: the
  notifications sheet is open, with that filter).
- Content browser: `q`, `type`, `facet` (`<facet>:<value>`; with `type`, the group on the left),
  `lang`, `audience`, `status` (`released`, `changed`), `keyword` (repeated), `page`, `size`.
- Review: `cs` (the revision under review, the page's own), `state`, `page`, `size`,
  `changes`, `module` with `lang`, `manual`, `diff`, `open` (repeated).
- Module editor: `block` (a block to put the caret in once the module is open, as a check links),
  `preview` (`open`: the live preview; `source`: the source language beside a translation),
  `previewLang`, `previewVariant`, `side` (`history`: the side panel's History tab),
  `historyPage`.
- History: `version` and `base` (commits), `diff`, `page`, `open` (repeated).
- Checks: `manual`, `changeSet` (a revision to check without choosing it), `severity`
  (`blocking`, `warning`), `page`, `size`.
- Manual builder: `manual`, `node`, `lang`, `variant`.
- Preview: `module`, `manual`, `scope` (`manual`), `lang`, `variant`, `output` (`pdf`), `hidden`
  (`shown`), `hiddenPage`, `unsaved` (`off`: the person's own draft as committed), `tag` (a
  release's tag: the content as released).
- Releases: `product`, `state` (`published`, `withdrawn`), `page`, `size`, `release` (the one in
  the panel), `create` (`open`: the "New release" dialog), `tab` (`maintenance`: the
  Maintenance tab), `linesPage`, `linesSize` (its list). A release's page: `notes` (a
  language's summary), `changesPage`, `change` (repeated: the opened `<lang>/<manual>` rows),
  `filesPage`.

**The revision (`ChangeSetUrl`, started by `provideChangeSetUrl()`).** On every route whose
`data.changeSetParam` is `session` (the shell), `?cs=` and the session's revision are kept
together. The address wins: a link with `cs` chooses that revision, but only from the list read
for whoever acts now (never from the previous person's after a demo-user switch); one they may not
see falls back to the released content with a notice and leaves the address. Back or Forward to
an entry without `cs` chooses none. Without `cs`, the session's choice is written in, replacing the
entry; a choice in the picker or the palette adds one. App links (sidebar, breadcrumbs, rows, the
palette) carry it: `[queryParams]="csLink.params()"` with `csLink = inject(ChangeSetUrl)`, or
`router.navigate(…, { queryParams: csLink.params() })`. Two tabs show two revisions. A route
whose `cs` means its own selection (the review screen) sets `changeSetParam: 'own'`, and its page
owns `cs` through `injectQueryState` (`idParam(isChangeSetId)`).

## Sign-in (`src/app/sign-in/`)

The shell is only for a person. Its route's guard (`personActing`, a `canMatch`) waits for
`GET /me` (`MeService.presence`), then lets a `user` in and sends nobody acting to `/sign-in`,
outside the shell, with the address in `returnUrl`: the token's read-only service, or `/me`
refused (401, 403). A failed read (no answer, busy) still opens the shell, which shows the
failure with a Retry that reads again and matches the address again. Should the person stop
acting while in the shell (a refused identity), the shell goes to the sign-in page itself.
`returnUrl` is only ever a path inside the editor (`safeReturnUrl`); a person acting who opens
`/sign-in` goes straight on to it (`nobodyActing`).

- **Demo mode** (`DemoSession.status` is `on`): the seeded users as a list (the account menu's
  switcher, as a page; it scrolls inside its own box). Choosing one is `DemoSession.signIn`: the
  switch, confirmed by `/me`, then back to `returnUrl`; a refusal stays on the page with the
  switcher's Retry toast.
- **Token mode** (no demo route): sign-in is not set up on this server, with the steps for a
  local run in demo mode (`CCMS_AUTH_MODE=demo`, `api:db-seed -- --example`). A refused token
  says so instead.
- **Sign-in with an identity provider** (#37, `session/sign-in-session.ts`, `SignInSession`): when
  `GET /auth/providers` lists one (the API has sign-in on; it then answers `/me` 401 until someone
  signs in), a button per provider ("Sign in with <`CCMS_OIDC_NAME`>", or "Continue to sign-in"),
  which leaves the app for the API's `/api/auth/<id>/sign-in?returnTo=<returnUrl>` (a full page
  load, `PAGE_NAVIGATION`): the provider's page, then back at `returnUrl` with a session cookie
  the app never sees. A sign-in that came back refused lands on `/sign-in?error=<code>`, said
  above the buttons (`SIGN_IN_ERROR_TEXT`; an unknown code reads as `sign-in-failed`). **Sign
  out** sits in the account menu for a signed-in session only (`/me`'s `meta.session`,
  `SignOutMenuItemComponent`): `POST /auth/sign-out`, then the provider's sign-out page (back at
  `/sign-in`) or straight to `/sign-in`; a failure is a toast with Retry, and the session goes
  on. A session that ends meanwhile (idle, deactivated) makes `/me` 401, so the shell goes to
  the sign-in page as for any refused identity. Flow: `frontend/editor-e2e/specs/sign-in.spec.ts`.
- **A one-time code by email** (#634, `sign-in/email-code.page.ts`, `/sign-in-code`): when
  `GET /auth/options` says `emailCode`, "Email me a code" sits under the password form (or alone,
  without passwords), keeping `returnUrl`. The page takes the address (always the same answer:
  "If <address> is known here, a code is on its way"), then the six-digit code
  (`autocomplete="one-time-code"`, spaces allowed); a wrong one is said above the button and the
  address stays; "Send a new code" asks again (the earlier one stops working); the request carries
  the page's language for the email. The email's link opens the same page with the token after
  `#`, taken out of the address at once; it signs in at a click (a mail scanner opening the link
  signs nobody in), and a used or replaced link offers a new code. Flow:
  `frontend/editor-e2e/specs/email-code-sign-in.spec.ts`.
- **States:** placeholder rows while the API is asked, no demo users (with the seed command),
  failed with Retry (asks for demo mode and `/me` again), refused (no access). The theme and
  language choices sit under the card, as the account menu is not there.
- **Never empty:** until `/me` names a person, the nav shows placeholder rows and the account
  menu a placeholder; then the person, or the redirect.

## Search palette (`src/app/search/`)

Screen 18: `of-search-palette`, mounted once in the shell, opens with Cmd+K (Apple) or Ctrl+K
from anywhere, and from the sidebar's Search button (an icon with a tooltip when the sidebar is
collapsed). It is the library's Command in a Dialog, kept open as a global overlay.

- **Search:** `GET /search?filter[q]=` (`PaletteSearch`), sent once typing pauses (200 ms), the
  query trimmed and capped at 200 characters. A newer query, another revision or another person
  cancels the answer in flight. 20 results a page; "Show more results" appends the next page.
  Results are grouped (Modules, Manuals); the API's match offsets are highlighted with
  `of-highlighted-text`, the excerpt always as text. A module found by its keywords says so
  ("Keyword · English"), with the matching keywords as its second line. A module opens `/content/<lang>/<id>`
  (with the matching block as the fragment), a manual `/manuals/<id>`.
- **Recent items** (`RecentItems`): what the person opened from the palette, newest first, at
  most six, in local storage per acting person (`openfolia.recent.<user id>`); every read and write is
  wrapped, and a stored list that is not ours is ignored. Shown when nothing is typed.
- **Actions** (`palette-actions.ts`): "Switch revision" lists the revisions of
  `ChangeSetSession` in the palette and chooses one. "New module" asks the content browser for
  its dialog (`NewModuleRequest`) and goes to `/content` when elsewhere. "Open review" goes to `/review`. An action a role can never use is hidden; one
  blocked now (a user switch in progress, no draft revision chosen) is disabled with the
  reason on its second line.
- **Pages** (`palette-pages.ts`, #591): every admin page and every project-settings topic the
  role may open, as "Admin › <group> › <page>" and "Admin › Project settings › <topic>", listed
  first while something is typed and every typed word is in that line (case and accents
  ignored). They never wait for the search, and a page found means no "nothing found".
- **Help** (#221): pages of the user guide whose title or summary holds every typed word
  (`HelpService.search`, title matches first, at most four), after the results, marked "User guide";
  one opens in a new tab. Off with the help links (`CCMS_DOCS_URL=off`).
- **States:** a skeleton while searching, nothing found, failed with a retry, no access (a
  refused search). A role without `content.read` gets the pages and actions only; a role with
  nothing to offer gets no button and no shortcut.
- **Keyboard:** arrows move (the input's `aria-activedescendant` follows), Enter opens, Escape
  closes and the focus returns to where it was; Backspace in an empty revision filter goes
  back to the search.

## In-app help (`src/app/help/`, `src/app/shortcuts/`)

#221. Each screen names its page of the user guide by article ID in its route's `data.help`
(`HELP_DATA`; admin tabs, report tabs and settings topics carry a `help` of their own); the
deepest route that names one wins. `HelpService` turns it into an address: the docs site of
`GET /about` (`docsUrl`, `CCMS_DOCS_URL`) plus the page's path in the interface language, from
the guide index the build ships (`help/guide-index.json`, made by `editor:guide-index` from the
docs' guide into `generated/`, git-ignored). The docs address must be `http(s)` without
credentials, and no path from the index may leave it; anything else shows no link. Without a
docs site (`off`) or an index, no link shows, and a failed index is read again on the next use.

- **Page header:** the shell provides `PAGE_HELP` from `HelpService.page`, so every
  `of-page-header` shows the question mark; the module editor and history put
  `of-page-help` beside their own heading.
- **Account menu:** "Help for this page" (when the screen has one) and "Keyboard shortcuts"
  (`of-help-menu-items`); the sign-in pages show "Help" with the licence links.
- **Shortcut overlay** (`of-shortcuts-overlay`): `?` outside a field and with no dialog open
  (`isPageShortcut`), or the menu entry, opens a dialog listing `SHORTCUTS` by area with the
  keys of the person's platform (`keyCaps` of `shortcuts/key-caps.ts`, whose key names are the
  translations' `shortcuts.keys`). The docs' shortcut reference is generated from the same
  catalogue, function and names.
- **Drift test** (`help/screen-help.spec.ts`): every routed screen names a page that is in the
  guide index, but the exempt ones (with their reason).

## Tips and the first-run tour (`src/app/tips/`)

#222. Tips are data (`tips.ts`): each an ID, the `data-tip` attribute of the element it points
at, its screen (the guide article ID the route names in `data.help`, or `*` for any screen),
its title and text keys, an optional guide article for "Learn more" (an address from
`HelpService.link`, so none while help links are off) and an optional condition (a permission,
or `after-first-change-set`). `TOUR_STEPS` are the tour's steps over the shell: content, the
editor (centred, no anchor), revisions, review and search.

- **Scheduling** (`tip-rules.ts`, pure, unit-tested): the tour first while it is due (tips on,
  not finished or skipped); then at most one tip per visit of a screen, the first in catalogue
  order that is not dismissed, on its screen, whose condition holds and whose anchor shows. A
  tour step whose anchor is missing is left out.
- **`TipsController`** (provided by the shell, so it runs only there): looks once a screen has
  settled (1.2 s) and when the preferences change, only while the page is free (`pageBusy` of
  `@openfolia/ui/tip`: no modal, no open menu, select or popover, the focus in no field), else again
  every second, 30 times at most. The focus moving into a field, a dialog or a menu closes an open
  tip or the tour, not counted as seen. A tip counts as seen on "Got it", "Turn off tips",
  Escape or leaving the screen; the tour on Done, Skip or Escape.
- **`PreferencesService`**: `GET`/`PATCH /me/preferences` for the person `GET /me` names, read
  again for each new person. A change shows at once and is sent after, one at a time in order;
  the browser keeps a copy per person (`openfolia.tips:<id>`), used when the API cannot be read.
- **Account menu** (`of-help-menu-items`): "Show tips" (a checkbox item), "Take the tour" and
  "Reset tips" (dismissed tips cleared and tips on, with a toast).
- **Anchors:** `nav.<section>` on the sidebar's links, `shell.search`, `shell.change-set`,
  `shell.notifications`, `content.new-module`, `module-editor.preview`, `review.filters`. Keep a
  `data-tip` where a tip points: the catalogue test checks each tip's screen and article against
  the guide index, not the anchors.

## Notifications (`src/app/notifications/`)

Screen 19, over `GET /me/notifications` (`backend/api/README.md`, "Notifications"):

- **The bell** (`of-notification-bell`, in the header next to the revision) shows the unread
  count as a number (none at 0, `99+` past 99), in its accessible name too. It starts
  `NotificationCenter.watch()`: `GET /me/notifications/unread-count` at once, every 30 s while the
  tab is visible and at once when the window gets the focus or the tab is shown again (the
  browser revalidates the answer with its `ETag`). A switch of the person starts over; an answer
  for the previous one is dropped.
- **The sheet** (`of-notifications-sheet`, Zard Sheet from the right, 420 px): opened by the
  bell or Alt+Shift+N from anywhere, held in the address (`?notifications=all|unread`), closed by
  Escape, the close button, the mask or Back, and the focus returns to where it was. Newest
  first, grouped Today and Earlier (the local day), 20 a page with "Load more" below the
  scroller; each open reads the first page again (the rows shown stay, dimmed), and a new
  notification arriving while it is open fades in at the top. "Unread only" filters
  (`filter[unread]=true`).
- **A row** (`notification-model.ts`, `describe`): the kind's icon, a sentence built from the kind
  and the payload with translation keys (never text from the server), when it happened, and while
  unread a dot, a tint, a medium weight and the word "Unread" for screen readers. Who did it is
  named when the editor knows them (the person, a demo user), else by role ("A reviewer"). A
  release is named by `GET /releases/:id` (its product and product version), read once per page. A click
  marks it read and opens its subject: a revision's review (`/review?cs=`, with `state=` when it
  went back to draft or was approved), the module of a single broken lock (in its revision),
  the release (`/releases?release=`) or the import (`/translations?import=`, or the revision it
  committed into).
- **Marking read** is eager: the row and the count change at once (one row, or "Mark all read"),
  and go back with a Retry toast when the API refuses. A poll sent before a local change does not
  overwrite the count.

## Module editor (`src/app/module-editor/`)

`/content/<lang>/<id>` (screen 2, `module-editor.page.ts`): the module in the block editor, the
outline on the left (a row puts the caret in its block; problems listed at the top), the details
on the right (title, type, facets, audience, keywords with the keyword field, the variants used,
the ID; the translations, linking to the other languages; the manuals that use it). The metadata
lives in the editor's document (`doc.attrs.meta`), so it is saved and undone with the text. The
header holds the title, the status, the lock and the save state, the language switch (the
languages the module exists in) and "Preview", the live preview.

- **Live preview (#237, `preview/live-preview.component.ts`):** "Preview" opens the module
  rendered as a reader sees it (`?preview=open`): beside the document on a wide screen (the
  details make way), a full-screen sheet on a phone. A language and a variant to choose
  (`?previewLang=`, `?previewVariant=`; the variants of the manuals the module is in), what the
  variant hides (the preview screen's bar), and a link to the full preview. While the person edits
  their draft it reads the working copy (`?workingCopy=true`: what was autosaved, uncommitted),
  and renders again a moment (`LIVE_DEBOUNCE_MS`) after each autosave lands. Two frames take turns:
  the next page loads in the hidden one while the last stays in view, dimmed; it takes the
  reader's place by block (`of-preview-frame`'s `anchor()` and `restore()`) before it is shown,
  so the page neither flashes nor jumps. A click on a block puts the editor's caret in it.

- **Translate (#264):** in the Translations card, a configured language the module is not in yet
  has "Translate" (`content.edit`; blocked with the reason without a draft revision).
  `ModuleTranslation` (`module-translation.ts`) takes the lock for `module/<lang>/<id>` and saves a
  working copy copied from the source language (the person's working copy of it, else the
  committed file): the same blocks with their block IDs and the metadata, `meta.lang` set
  (`translationOf`). Nothing is committed then: the editor opens on the working copy
  (`?preview=source`) and its save point puts the language on the branch, so the browser lists
  it afterwards. A version another tab started is opened as it is. Until the translation round
  trip writes a record (#243, #51), the new language has none and so counts as outdated in every
  block.
- **Source beside a translation:** "Source" (shown in a language other than the configured
  source one, when the module is in that one) puts the source language in the live preview's
  frame, read-only, in the preview's place (`?preview=source`; a sheet on a phone). Its blocks
  have the translation's IDs, so a click on one puts the caret in the same block of the
  translation.
- **Delete (#264):** the header's "More actions" menu (`content.edit`) has Delete, blocked with
  the reason without a draft revision, while the module loads, when another revision holds
  the lock or the person may not change it. It opens the delete dialog (below); the text being
  edited is saved first, the page then goes to a language that is left (or back to the content
  browser), and Undo brings the person back.
- **Change ID (#265):** the Details card's "Change ID" (`content.edit`; blocked with the reason as
  Delete is, and while a translation starts) opens a panel under the ID (`?rename=open`,
  `module-rename-panel.component.ts`): the new ID, prefilled from the title's slug and checked as
  typed (a lowercase slug of at most 100 characters, not the ID it has), and what the rename
  touches at the revision's head (`GET …/module-references/:moduleId`): the languages it moves
  and the manuals and modules naming it, which it rewrites, listed in a capped scrolling list, with
  how many of them have unsaved edits. "Change ID" saves the text being edited and stops saving
  under the old ID; `ModuleRename` (`module-rename.ts`) then takes the locks (the module under
  both IDs in every language, and every file naming it; they stay with the revision), commits
  the working copies in its way (a save point) and renames (`POST …/module-renames`: one commit
  that moves the module and rewrites the references), and the page opens `/content/:lang/:newId`.
  A toast offers Undo, which renames back the same way and opens the old address, if the person
  is still on the new one (from its history page, the old ID's history; the query, the History
  tab with it, is left behind). The History tab and page of the new ID start at the rename; a
  version from before it is in the old ID's history, and restoring it there brings the old ID
  back as a module of its own. A lock another revision holds says whether it is a module's or a
  manual's; any other refusal says why by its code (`id-taken`, `invalid-id`,
  `translation-at-provider`, …). Releases keep the old ID.
- **Edit or read:** with `content.edit` and a draft revision chosen, the page takes the module's
  lock and opens its working copy; a lock another holds, a refusal, the published content or a
  revision past draft opens it read-only, saying why.
- **Locked (screen 12, #76; `module-locked-dialog.component.ts`, `module-lock.ts`):** a lock
  another revision holds (`409 locked`) opens the module read-only with a dialog: who holds it
  (`of-avatar` and their name; "Someone else" when the API does not say, as it names the holder
  only to someone who may know of the lock) and since when, with "Open read-only" (first focus),
  "Back" (the content browser) and, only for `admin.roles` (the open UI questions' answer; hidden
  for everyone else, disabled with the reason when the API gave no lock ID), "Take over
  editing". The address keeps the step (`?lock=read` once dismissed, `?lock=takeOver` while
  writing why); the header says who edits it and offers the take-over too. Taking over asks why
  (required, as the API wants it), breaks the lock with that comment (`POST /locks/:id/break`:
  audited as `lock.break`, and the holder is notified) and opens the module again, taking the
  lock for this revision; a lock gone meanwhile (404) opens it too, and one someone else took
  meanwhile shows the dialog again with them. A refusal says why in the dialog, which stays.
- **A lock lost while editing (#76):** a save or save point refused because the revision no
  longer holds the lock (`lock-required`, or `locked`) takes it again by itself, once
  (`ModuleDraft`'s `relock` hook), and saves on. When someone else holds it now (they took it
  over), the editor turns read-only where it stands, what was not saved stays in this browser
  (restored once the module is theirs again) and a toast says who took it over; no dialog
  opens by itself. Lost again straight after taking it back, it waits for the toast's Retry, so
  two tabs never take it back and forth.
- **Suggest a change (#137):** a module open read-only from the published content offers
  "Suggest a change" (`content.edit`): a revision named after the module is started, chosen and
  the module opens in it. For a **contributor** (`content.edit` without `content.read.draft`,
  `suggestsOnly` in `permissions/`) it is the only way in: the header has no revision picker
  (`shell.layout.ts`), and the page opens each module in its own suggestion, the revision of
  theirs holding the module's lock (`GET /locks?filter[subject]=…`; none: the published content,
  with the button; one in review: read-only, saying so). Their editor is **focused**
  (`of-block-editor`'s `focused`): the toolbar and "/" offer text, the two lists, links, images
  and attachments only (`FOCUSED_SLASH_ITEMS`; no text styles, tables, notices, procedures,
  variant blocks or module references), the metadata is read-only, and there is no Delete or
  Translate. Beside it, the suggestion panel (`suggestion-panel.component.ts`): "What did you
  change?", required, kept as the revision's description when the field is left (eagerly, the
  session's rename with its rollback), and "Submit for review", which makes a save point and
  submits with the note as its comment in one step; the module then opens read-only, in review. While a
  suggestion is being started the published module stays on screen; if its lock is then refused
  (someone else edits the module, or it is outside their scope), or the person went on to
  another module meanwhile, the new revision is abandoned (nothing is in it yet) and a toast
  says why. Leaving the module editor chooses the published content again, so elsewhere a
  contributor reads what is released; the search palette offers them neither "Switch revision" nor "New manual", and the manual builder's route provides `ManualPermissions`, under which
  they read manuals but never build them.
- **Saving** (`module-draft.ts`, `ModuleDraft`): every edit shows at once and is saved to the
  working copy two seconds after typing stops (and when the editor loses the focus or the tab is
  hidden); content equal to the last saved is not sent. Leaving the module (the route guard, a
  language switch) and every five minutes make a save point: a commit of the revision's working
  copy, only when something was saved since the last one. The header says Saved, Saving… or Not
  saved and why.
- **Never lost:** what is not saved yet is kept in this browser (`local-drafts.ts`, per person,
  revision and module) and restored on reopen when the server's copy is still the one it was
  made on; a draft made on an older copy is offered, not applied. Text that cannot be a module yet
  (an empty list item, cell or heading) stays local and is marked at its block. No answer: kept,
  a toast with Retry, tried again every ten seconds. A copy saved elsewhere (409) is never
  overwritten: the text stays here and the toast offers a reload. A save whose answer was lost is
  recognised by its content, not reported as a conflict. Closing the tab with unsaved work warns;
  leaving the module with work not saved asks.
- **An update from main** (`ReadRef.moves`, #491): the revision's branch got a new head while
  the module is open. With nothing unsaved, the module is read again there (its working copy, else
  the file committed at the new head; no save point is made on the way), and so are the titles of
  the modules it references. With unsaved changes (pending, offline, refused, incomplete or in
  conflict) it is never read over them: they stay and are saved as before (a file the update
  changed takes the conflict path above), a toast says the revision was updated under them, and
  once they are saved another one offers Reload (which saves what was typed since first). The
  live preview renders at the new head at once, its manuals read again with the variants kept,
  and the snippet suggestions are read again either way.
- **A file the server refuses** (`refused-files.ts`; a save or a save point answered
  `unknown-asset`, or `asset-deleted`, with `meta.assets`): never offered Retry, since the same
  content is refused the same way. The toast names the image by its alt text (else its caption)
  or the attachment by its name, or counts several, and its action opens the image dialog on that
  block (`?block=<id>&replace=image`) or shows the block; each block naming one is marked as a
  problem. The text stays in this browser and nothing is sent while a block still names a
  refused file; once none does (the block removed, another file chosen) or the file was chosen
  again in the image or attachment dialog (which uploads it into the revision), the save goes
  again by itself. No periodic save point tries a refused one again.
- **Loading:** skeletons in the shapes of the header, outline, editor and side panel, on the
  first load only, fading in after 150 ms. A language switch or a reload keeps what is shown,
  dimmed and inert, until the next module is there; the header, the toolbar and the side panel
  keep their place in every state, and the save status changes in place.
- **View state in the URL:** the module and language are the path; `?cs=<id>` names the revision, so a link or a reload shows the same view. Choosing another revision adds a history
  entry; a link or Back naming one chooses it once the list shows it may be seen; an invalid or
  unknown one is dropped, and none chosen (the published content) leaves it out. The language
  switch keeps the query.
- **Toasts belong to their module:** a toast's action (Retry, Reload, restore or discard a kept
  draft) does nothing once another module is open, and the page's toasts go when it loads another.
- **Problems:** the working copy's validation issues and the editor's own show at their blocks and
  in the outline, by text and icon, never by colour alone.
- **A link to a block:** `?block=<id>` puts the caret in that block and scrolls it into view once
  the module is open (once per module, language and block, so a reload never pulls editing back); the checks link there.

**Module reference picker** (screen 9, `module-picker-dialog.component.ts`): "Choose module" on an
empty module reference opens it (`DocBlockSettings.pickModule`). A search over `GET /search`
(nothing typed: the list of `GET /module-summaries`), in the document's language, narrowed by type
and by the module's own facet values ("Same …"), paged inside the list frame; a preview of the
chosen module (its first blocks), the modules that already include it, and how to insert it:

- **Whole module, kept in sync:** the reference block gets the module.
- **Link only:** a cross-reference (`xref`, no text of its own, so it reads as the module's title)
  in a line of text takes the reference block's place, in one Undo step.
- **One block from it** (#223): the preview turns into a chooser of the module's blocks (every
  block at any depth but page breaks, by type and text, in a scroller of its own); the reference
  block gets the module and that block (`block`), kept in sync. Insert says why it can't until a
  block is chosen; choosing another module clears it. The cycle check is the whole module's (a
  cycle is one of modules). The reference's card then names the block by its type and text
  (`block-choices.ts`), says so when the module no longer has it, and Open goes to the module at
  that block (`?block=`).

**For a snippet** (`ModulePickRequest.snippet`, "Insert snippet"): only snippets are listed
(`GET /module-summaries?filter[snippet]=true`, searched by title or ID with `filter[q]` on the
same route), the type filter offers only the snippet types, and it inserts **As reference** (the
reference block, kept in sync; translated once) or **As copy** (its blocks with new IDs; nothing
links back). Neither a link nor one block is offered; the cycle check applies to both.

**No cycles.** `module-graph.ts` reads every module the person may see (`GET /modules`, in the
document's language with the source language standing in, 200 a page, at most 20 pages; past that
the modules it lacks are read one by one, `GET /modules/:lang/:id`). Rows of modules that include
the edited one, directly or through others, say "Includes this module"; the chosen one's way back is
named, and Insert (whole) is disabled with the reason, as it is for the module itself and while the
check runs or failed (with "Check again"). A link is no inclusion and stays possible, except to the
module itself. The manual checks (`GET /manuals/:id/checks`) report a cycle that gets past this
(`module-cycle`, blocking). The dialog's state stays out of the address: it answers a promise of
the block that opened it, which a reload or a link could not restore.

**Variant picker** (screen 8, `variant-picker-dialog.component.ts`, `variant-builder.ts`): a variant
block's "Choose variants" or "Change variants" opens it (`DocBlockSettings.pickVariant`). The
variant attributes come from `GET /variants` at the chosen revision (nothing is known by name):
each is a group, "is" or "is not", with its values as checkboxes (an enum attribute) or
comparisons (a version attribute: at least, above, at most, below, exactly; two make a range), and
the groups combine with "All groups must match" or "Any group may match". A search box narrows the
groups and values by their labels.

- **The rule** reads as a sentence, and its text form (the condition as a variant block's `when`
  takes it in AsciiDoc) stays below it, in sync: a change in the groups rewrites the text; typed
  text the groups can show updates them, and one they can't (a nested mix, an unknown name) is
  kept as text only, the groups dimmed until the text fits them again.
- **Builds:** "Appears in N builds" and the builds, paged in the list frame, from
  `GET /variants/matches?when=`, asked once changes pause (300 ms). The API's 400 (the text does
  not read) and 422 (`unknown-variant`: an attribute or value the configuration does not hold, by
  `meta.issue`, the names read from the text) show at the text, and Apply says why it can't. A
  version that is not one (`2.x`) is refused here, as the content model refuses it (the API does
  not check it yet, #225).
- **Apply** sets the block's condition; **Remove condition** takes the block's frame away and
  leaves its blocks in place (one Undo step), as a condition for no variant at all.
- The dialog's state stays out of the address, as the module picker's does: it answers a promise
  of the block that opened it.

## Insert image (`src/app/images/`)

Screen 10, `of-insert-image-dialog`, the module editor's image picker (`pickImage`), offered
only while the module is edited in a draft revision. `open(current)` resolves to the image, alt
text, caption and width, or null when cancelled, once the dialog has closed and the focus is back.

- **List:** `GET /assets?filter[changeSet]=<id>&filter[type]=image` at the revision's branch, 12
  a page, in the list frame's grid (`ofListGrid`): the revision's uploads first, then the
  images its modules show. The search box is `filter[q]` (alt texts, captions, the showing modules'
  titles and IDs), sent once typing pauses. Images have no file name, so a tile is named by a
  module showing it (in the module's language first, "+n" for more), "Uploaded into this revision", or the start of its hash. The tiles are one radio group: one tab stop, the arrows move the
  choice. Empty, skeleton, error with Retry and no access come from the frame.
- **Upload:** a PNG or JPEG into the revision (`POST /change-sets/{id}/assets`, the form gets
  `X-Ccms-Request` from `stateChangeInterceptor`). Eager: the tile shows at once, first and chosen,
  from the file's own bytes; a refusal takes it back with a toast offering Retry. Insert waits for
  the upload.
- **Side panel:** the chosen image's name and facts (type, pixels, size, how many modules use
  it), the size (Icon 10 %, 30 %, 50 %, 75 %, Full 100 %: the block's `width`; an image edited
  with another width keeps it until a preset is chosen), the alt text in the module's language
  (required: Insert with none says so at the field and puts the focus there) and the optional
  caption (the block's title). "A different image per language" is shown disabled with the
  reason: each language's module holds its own image block.
- **Showing images** (`ImageSources`, provided per page): an image is read through the API, so
  the demo identity and the branch apply (an `<img src>` carries neither), and shown from an
  object URL, revoked with the page: `GET /assets/{hash}` at the branch, else, for a fresh upload
  no module there shows yet, the revision's preview `GET /change-sets/{id}/assets/{hash}`. At
  most four reads at once; an upload is shown from its own bytes.
- **Not in the address:** the dialog is a transient picker that hands its answer to the caret's
  place in the document, which a link could not restore, so its search and page stay in the
  component.

## Attach file (`src/app/attachments/`)

`of-attach-file-dialog`, the module editor's `pickAttachment`, offered only while the module is
edited in a draft revision, in the insert-image dialog's layout. `open(current)` resolves to the
file, its name and description, or null when cancelled, once the dialog has closed.

- **List:** `GET /assets?filter[changeSet]=<id>&filter[type]=attachment`, 10 a page, in the list
  frame (one radio group: one tab stop, the arrows move the choice): the revision's uploads
  first, then the files its modules attach. A row shows the type's icon, the file name (wrapping),
  its type, size and how many modules use it. The search box is `filter[q]`, sent once typing
  pauses. Files are only named here: never shown, previewed or given an object URL.
- **Upload:** any file into the revision (`POST /change-sets/{id}/assets?kind=attachment`), no
  `accept` filter: the server decides the type from the bytes and the name and refuses what its
  settings do not take (`unsupported-attachment-type`, said by its reason: dangerous, mismatch,
  denied, not allowed). Eager: the row shows at once, first and chosen; a refusal takes it back
  with a toast offering Retry. Insert waits for the upload.
- **Side panel:** the chosen file's name and facts, the name readers see in the module's language
  (required; it starts as the file name without its extension until one is typed) and an optional
  description.
- **Saving files** (`AttachmentFiles`, provided per page): the bytes are read through the API like
  an image's (`GET /assets/{hash}` at the branch, else the revision's preview) and handed to the
  browser as a `Blob` typed `application/octet-stream` behind a hidden `<a download>`, so even an
  HTML or SVG file is only ever saved, never rendered in the editor's origin. It is saved under the name the API serves it under (`Content-Disposition`: a name that fits its stored type), never the block's `fileName` as such, which content could set to `notes.vbs` on harmless text; a PNG or JPEG the API shows in place keeps `fileName` only with its own extension, else the hash.
- **Review:** an attachment's facts (name, file name, type, size, description) diff as text; a
  file replaced under the same facts is named "File replaced" (`review/diff-nodes.component.ts`, in the block's card look).

## Content browser (`src/app/content/`)

`/content` (screen 1): groups (module type, then the first facet's values), filter chips and a
debounced search over `GET /module-summaries`, and the module table (each row with its keywords
under the ID) in the list frame's table
mode, with status and language badges; a row opens `/content/<lang>/<id>` (the module editor). **New module** (screen 7, `new-module-dialog.component.ts`) is hidden without
`content.edit` and disabled with the reason (`NewModuleRequest.blocked`) without a draft revision. `ModuleCreation` saves eagerly into the current revision (lock, working copy, save point)
with the row shown at once; a failure takes it back with a Retry toast, rolling back only what
this tab saved, and an unknown outcome keeps it so a retry resumes and never makes two.

**Delete** (#264, `delete-module-dialog.component.ts`, `module-deletion.ts`): each row's actions
menu (only with `content.edit`) and the module editor's header menu open the delete dialog. It
asks what to delete, one language or the whole module in every language ("every language" also
removes a language that is only a working copy, a translation started and not committed yet), and
first shows where the module is used (`module-usage.ts`): the manuals that include it and the
modules that reference it, in a box that scrolls on its own, saying the checks report these uses
until they are fixed. A used module may still be deleted (checks, #71, report the broken
references). Delete waits for that list (a failure says so and still lets it go on), and a lock
another revision holds blocks it, saying why. `ModuleDeletion` reads what each language holds
now (its working copy, else the committed file), takes the locks and makes one save point with
`deletes` (a language that is only a working copy is discarded instead); a refused save point
says so with a Retry toast. The locks stay with the revision, as the module editor's do
(giving one back could take it from another tab of the same revision). Then a toast with **Undo**: it writes what was
read back into working copies (on the delete's commit) and commits them, while the revision is
a draft and nobody has put the module back since (it never overwrites one; it says so). A
module deleted in every language is gone from the summaries, so page 1 of an unfiltered list (or
one narrowed to "Changed") shows the revision's deleted modules (`deleted-modules.ts`: its
changes, `removed`, keeping a module with no language left), each with a Deleted badge, its old
title (what this tab deleted, else read at the revision's base, else the ID) and the languages
it was deleted in; at most 20, from the first 200 changes. Review shows them removed. Once the
revision is merged, an older version comes back through the history (below).

**Deprecate** (#266, `deprecate-dialog.component.ts`): "Deprecate…" in the module editor's
header menu (in the module's source language) and in the manual builder's ⋯ menu, with
`content.edit` in a draft revision, opens a dialog with a required reason (one line, at most 500
characters) and an optional replacement: a module (or a manual) that is not deprecated itself,
from `GET /module-summaries?filter[deprecated]=false` (or `GET /manuals`). It goes into the
content like any edit (the module's metadata in the document, the manual's working copy), so it
is saved into the revision, reviewed and merged with it; a toast's **Undo** takes it back, and on
a deprecated module or manual the menu has "Undo deprecation" instead. Nothing asks first and
nothing blocks: a deprecated module stays readable and in the manuals that include it, the checks
warn (`deprecated-module`) and review decides. A Deprecated badge (always the word) shows in the
browser's rows (the reason as its tooltip), the editor header (with a notice of the reason and
the replacement in the side panel), the manual chooser and the manual's header, the outline's
module rows, search results and the review's details diff. The "Used in" card warns that those
manuals still include the module. The browser hides deprecated modules unless **Show deprecated**
is on (`?show=deprecated`).

**Show deleted** (#320, `?show=deleted`, joining `show`): the browser asks for
`GET /module-summaries?filter[status]=any`, so the modules deleted on the branch shown (merged
deletions included, read from its first-parent history) join the list, paged and filtered with
the rest. Each is summarised from its last versions the reader may see (one outside their scope
is never listed), muted, with a Deleted badge, the date of its deletion and its deleted languages
struck through, and no row actions; it opens its history (`/content/:lang/:id/history`), where
an older version is restored as a draft (#88). While it is on, the revision's own deleted rows
above are not added: the list holds them already.

**Keywords** (`keyword-field.component.ts`): free-form keywords as chips. Enter or a comma adds
one (a pasted list is split at its commas; what is typed is added when the field loses the
focus or the form is sent), Backspace in the empty field removes the last, and each chip has its
remove button; one already there (case aside) is not added again, and one too long (over 64
characters) or one too many (over 32) is refused with the reason, keeping what was typed. The
new-module dialog has the field, so a module is created with its keywords. The **Keyword** filter
chip opens a popover with the same field: every keyword added narrows the table to modules with
all of them (`filter[keyword]`, repeated). The module editor's details edit an existing module's
keywords with the same field.

**Suggest a new module (#137):** for a contributor the header's button reads "Suggest a new
module" and needs no revision: the dialog's module is created in a revision started for it
and named after it, then opened in the focused editor. The rows have no actions menu for them.

## Review (`src/app/review/`)

`/review` (screen 4), for anyone who reads drafts (`content.read.draft`): authors submit there,
reviewers and publishers act. The address holds the whole view, so a link or a reload shows it
again: `?state=approved|draft` (waiting for review when left out), `?page=` and `?size=` (20, 50, 100) of the list, `?cs=<id>` (the revision; the first of the list when none is named),
`?changes=` (the page of its items), `?diff=side-by-side|rendered` (inline when left out),
`?module=&lang=` or `?manual=` (an item, marked and scrolled to; its title links there) and
`?open=<item>~<run>` (repeated, at most 32: runs of unchanged blocks shown unfolded). Each is checked, and
one that is not valid is ignored; defaults are left out. A choice is a history entry of its own;
what the screen corrects (the first revision, a page past the end) replaces the entry.

**Contributor label (#137):** a revision whose author is a person whose roles hold neither
`content.review` nor `content.approve` shows "Contributor" beside the author's name, in the list
and in its header (`contributesOnly`), derived from what the API lists: `GET /me` for the person
themself, else the users' `meta.permissions` (`GET /demo/users`, which also names them). Where the
users cannot be listed (outside demo mode) there is no label, as there is no name.

- **List** (left): `GET /change-sets?filter[state]=`, paged, in the list frame's `cards` mode: the
  title, the author and when it last changed, and its state as a badge. The filters' counts come
  with the list's answer (`meta.counts`, every state, #481), so no read per state.
- **Header** (middle, on top): the revision's title, state, author, when it last changed, how
  many items it changes and its checks (a chip linking to `/checks?changeSet=`); then the view
  (inline, side by side, rendered: side by side is not offered below 768 px and falls back to
  inline; a manual's outline and a project file are drawn alike in every view and say so outside
  inline, so a switch that changes only the modules below them is not taken for broken, #452),
  one pill per changed item (its title, kind and counts: `+` added, `−` removed, `~`
  changed, `↕` moved; a click scrolls to it), the legend, and moving through the changes: the
  arrows, or `j`/`n` and `k`/`p` (not while typing), with "x of y" (counted again when the view
  changes). The counts are those of the page of items shown, so they agree with the pagination.
- **Diff** (middle): `GET /change-sets/:id/changes`, five items a page, each read on both sides
  (`GET /modules/:lang/:id?ref=`, `GET /manuals/:id?ref=` at the base commit and the head the API
  names) and compared in the browser:
  - `tree-diff.ts`: a generic tree diff matched by ID. A node is added, removed, changed (its own
    content or text differs) or the same; one that stands under another parent is `movedFrom`
    there, with a ghost at its old place (`movedTo`) linking both ways; one reordered among its
    siblings (outside the longest run both sides keep in order) likewise. A new node around nodes
    that were there is a wrap (one change, "added around existing content"), a frame taken away an
    unwrap. What an added or removed node holds is part of it (`inherited`), never counted on its
    own. Each change is counted once, at its node (`countChanges`). `foldUnchanged` folds runs of
    unchanged nodes, keeping one of context beside each change (a list of three or fewer is shown
    whole); a run is opened by its button, kept in `?open=`.
  - `block-diff.ts`: blocks, list items, steps and table cells as the tree (unknown kinds by their
    `blocks`), texts compared word by word (`diffText`, a longest common subsequence), an image's
    alt text and caption too.
  - `manual-diff.ts`: a manual's outline (chapters matched by title, else by the modules they
    hold, so a renamed chapter is one change); `meta-diff.ts`: the details (title, type,
    audience, facets, keywords; a manual's title, audience, variants and text attributes) as a
    table of before and after, by the configured labels.
  - `diff-nodes.component.ts` draws the blocks with the real block components (`@openfolia/ui`: the
    safety notice in its level's frame, the variant block with its condition, the reference
    card, the image), each change marked at its edge (a gutter bar, a tint and a named mark line,
    never colour alone) and the words with the library's diff marks (`ins`/`del`, named for
    screen readers). A replaced image shows both pictures, read at their commits, with a swipe to
    compare. Inline shows both sides in one; side by side puts them in rows, a hatched gap facing
    what one side lacks, in one scroller (so both sides scroll together). Inside a container (a
    section, a variant block, a procedure) `align-sides.directive.ts` lines up the blocks both
    sides have by their ID (`alignPairs`: in order, the higher one pushed down; again on any
    resize), and a code block or table scrolled sideways scrolls its counterpart. In the before
    column a table keeps a moved block's old place in its cell.
  - `diff-rendered.component.ts` (rendered): the module's new version as a reader sees it
    (`GET /modules/:lang/:id/preview?ref=<head>&variant=`, a variant of the manuals that hold the
    module) in the sandboxed `of-preview-frame` (its policy unchanged; `fit` sizes it to the
    page). `frame-marks.ts` marks each change on the page from outside (inline styles and a text
    line naming it, through the prototypes' own members, never markup). Above it the changes are
    listed in words (symbol, kind, an excerpt; "Show on the page" scrolls there; `j`/`k` visit
    them), with what the new version removed and how many changes the chosen variant does not
    show.
  - **Comments** (`review-comments.ts`, `diff-comments.component.ts`): the review threads of each
    module (`GET /change-sets/:id/comments?filter[module]=<lang>/<id>&filter[resolved]=any`,
    paged) next to their block, in all three views: who (initials and name), what it is on
    ("on: Paragraph"), when, the text, the replies; a resolved thread folds to one line. A changed
    block has "Comment" at its edge (always in sight, not only on hover: #452), in the rendered list
    too, and a click on a block of the rendered page starts a thread there; `c` starts one on the
    change `j`/`k` moved to, Ctrl or Cmd+Enter sends, Escape cancels. Its author and anyone with
    `content.review` write, while the revision is open (draft, in review, approved): start (`POST
…/comments` with the block), reply (with `thread`), resolve and reopen, edit. Every write is
    eager: shown at once (a new comment as "Sending…"), kept as an overlay of pending writes on
    what was read, so a read meanwhile never drops it, and dropped once the module's threads are
    read again. A refusal rolls it back, puts a new comment's text back in its box and says why in
    a toast, with Retry where trying again can help (`retryableFailure`). An unchanged block with
    a thread is never folded away. Below each module's diff (`module-comments.component.ts`):
    threads whose block a later save point removed (`meta.orphaned`), listed apart and flagged,
    naming the block's kind where the diff still has it; and, when the threads could not be read,
    a notice with Retry (the diff stays usable). Neither shows an empty panel.
  - `review-context.ts`: what the items report to the page (their counts and titles for the
    overview) and the module titles read for references, four at a time.
- **Panel** (right): `GET /change-sets/:id/review` (the approvals needed, given and pending, and
  those that lapsed: named as no longer counting, the requirement still waiting), what
  happens after approval, the review comment and the transitions (`transitionStates`,
  `review-model.ts`): hidden when the role can never make them or the state does not take them,
  disabled with the reason when the person is the author (four eyes), the review is given already
  or a request for changes has no comment. Each is eager (`expectedAfter`): shown at once, taken
  back with a Retry toast when the API refuses, and the revision read again. Retry acts only on
  the revision that failed: with another one chosen since, it shows that one again instead.
- **Narrow screens** (below `xl`): one pane at a time (revisions, changes, approvals), chosen
  above them; choosing a revision shows its changes.
- **Loading:** the first read of a revision shows its card and panel as skeletons in their real
  shape; choosing another keeps the one shown, dimmed and inert, until the new revision and its
  review are both there. A module read again keeps its diff, dimmed. `?cs=` takes an ID
  only.
- **Checks** (in the panel, `checks/checks-summary.component.ts`): how many checks block the revision
  and how many warn (`GET /change-sets/:id/checks`), and "Run checks", which opens them on
  `/checks?changeSet=<id>` (the person's own revision stays theirs).

## History (`src/app/history/`)

Screen 13 (#88): a module's versions, compared, and restored as a draft. Read at the chosen revision's branch (its save points too), else `main`.

- **Side panel:** the module editor's side panel has two tabs, Details and History (`?side=history`,
  its page `?historyPage=`). History lists the versions (`of-history-list`) and "Open history";
  a row opens the history page on that version.
- **The page** (`/content/:lang/:moduleId/history`, `history.page.ts`): the versions on the left
  (`GET /modules/:lang/:id/history`, 20 a page, in the list frame: rows scroll inside it, the
  pagination stays in view), each with its version number ("v3", "version 3" in running text and its accessible name, or
  the short commit when the history was cut), who and when, its message, Added or Deleted, the release tags holding it
  ("Released · v1"), its revision (a link to its review) and its approvers. The version shown
  (`?version=`, the newest when left out) is compared against the one before it, or the one chosen
  with a row's "Compare with version N" link (`?base=`): two versions are chosen by keyboard as by
  pointer. A commit never read here (for this module, branch and person) is dropped from the
  address; one read on another page stays, and the history knows the current version on any page.
- **Compare:** `GET /modules/:lang/:id/compare?base=&head=` (the oldest version, compared with
  nothing, is read at its commit and shows all added), drawn by the review screen's own diff,
  `review/module-diff-body.component.ts` (`of-module-diff-body`: the details table, then the
  blocks inline, side by side or rendered, `?diff=` as on the review screen, runs opened in
  `?open=`). Both screens use that one component; the history shows no comments
  (`commentModule` null). A version the reader may not read (an older commit needs
  `content.read.draft`) says so.
- **Restore** ("Restore rev N as draft", `content.edit`; `version-restore.ts`, for a module or a manual): into the person's open
  revision (the chosen one, a draft of theirs), else a new one started as the picker starts one
  ("<title> (rev N)"). It reads the version at its commit, takes the module's lock there, reads the
  working copy (its version and base; none for a module deleted on the branch: the revision's base) and saves the version into it (`PUT …/working-copy`): the server checks the state, the
  lock and the restorer's scope as for any edit, and the editor's save point commits it. Then the
  editor opens on it with a toast "Restored rev N as a draft" and **Undo**, which puts back what
  the working copy held (or discards it) only while it is still the restored version, and opens
  the module again. Blocked, with the reason: the version shown is the current one, a deletion,
  unreadable, or another revision holds the lock (`GET /locks`), or while the revisions load.
- **Contributors** (#137, `suggestsOnly`): the History tab and the page are read-only for them,
  with no Restore, since they work only in their own suggestion.
- **A manual's history** (#321, `/manuals/:manualId/history`): the same page for a manual's
  manifest (`HistorySubject` in `history-model.ts`). Its versions are `GET /manuals/:id/history`,
  compared with `GET /manuals/:id/compare` and drawn by `review/manual-diff-body.component.ts`
  (`of-manual-diff-body`, the review screen's manual diff: details and outline), so there is no
  view switch. The title leads back to the builder on the manual; the lock checked is
  `manual/<id>`. Restore saves the version's manifest into the manual's working copy and opens the
  builder on it (Undo as for a module; the builder reads the draft again). A version that names
  modules hidden from the person (`outside-scope` among its issues) is not restored by them, since
  the save would drop those entries. Opened from the builder's menu ("History"), or for a manual
  deleted on the branch from the switcher's **Show deleted** (`?deleted=shown`,
  `GET /manuals?filter[status]=deleted`).

## Manual builder (`src/app/manuals/`)

`/manuals` (screen 3): a manual's outline (chapters and modules), its outputs per language and
its cover. The address holds the view (`injectQueryState`, `builder-view.ts`): `?manual=` (the
first manual when left out), `?node=` (the selected row), `?lang=` (the source language when left
out), `?variant=` (the first variant when left out) and `?deleted=shown` (the switcher lists the deleted manuals, #321); `?cs=` is the shell's (`ChangeSetUrl`). A
value that is not valid, or not in the manual, is dropped; defaults are left out; choosing a manual, language or variant is a
history entry, selecting a row replaces it. `/manuals/:id` redirects to `?manual=:id`.

- **Outline**: `of-module-tree` with nesting rules (chapters keep at least one row, modules are
  leaves). `manual-outline.ts` turns manifest entries into rows and back (conditions kept), adds a
  module after the selected row, puts a row into a new chapter, renames a chapter and removes a row
  with the chapters it would leave empty (Undo in the toast puts it back). Enter on a module opens
  it in the module editor, on a chapter renames it; Delete removes; F2 renames.
- **Saving** (`manual-draft.ts`): editable only in a draft revision the person started, with
  `content.edit`, and when no other revision holds the manual's lock; otherwise read-only with
  the reason. Every change shows at once and is saved eagerly: the lock first
  (`POST /change-sets/:id/locks`), then `PUT …/manuals/:id/working-copy` with the version it last
  got. A refusal puts the saved outline back with a Retry toast; a conflict or an unknown outcome
  reads the manual again. A save point (`POST …/commits`) follows 30 s without changes, before a
  preview and on leaving the screen.
- **Module summaries** (`outline-summaries.ts`, #481): the titles, languages, status and
  deprecation of the outline's modules, read by ID (`GET /module-summaries?filter[id]=`, up to
  200 IDs and 6,000 characters of them per read), as the outline gains modules; never the whole
  list. An ID the branch has no module of is marked "Not found". A module added or created shows
  its title at once.
- **Add module** (`module-choices.ts`): the list searches on the server while it is open, by
  title or ID (`filter[q]`, after a 200 ms pause), 50 modules by title, those in the manual left
  out; "x of y modules shown" when more match, the last results dimmed while the next arrive, and
  "Try again" when the search fails. Last, "New module…" with the search text as its title.
- **Outputs**: per language whether every module has a translation (complete, partial, not
  translated), from the module summaries; choosing a language sets `?lang=`.
- **Cover**: the title page drawn from the manual's title and the chosen variant.
- **Derived manuals** (#451, #669; `derived-rule.ts`, `derived-rule-card.component.ts`): "New
  manual" offers "Derived from another manual": the source among the manuals it may gather from
  (an assembled manual, for its audience or a wider one, `mayGatherFrom`; the API decides all the
  same) and the module types (none: the safety types the settings mark). It starts with the
  source's variants, its rule and no entries, and is made a save point at once. A derived manual's
  outline is what its rule gathers, read with the working copies
  (`GET /manuals/:id?workingCopy=true` at the revision's branch, the author's own): read-only (no
  moves, adding, row menu or keys that change it), its front and back matter marked, a row the
  chosen variant leaves out marked "Not in <variant>" (`evaluateCondition` of
  `@openfolia/content-model/core`), and "Leave out" on a gathered row. The rule card, first beside the
  outline, edits the rule in place: source, types, front and back matter (searched as "Add
  module" is), what is left out ("Include again"), and its issues (the seven derived-manual
  checks, blocking first). What it gathers (#676): "Whole modules" (the rule without `notices`)
  or "Safety notices" (`rule.notices`, from `DEFAULT_NOTICE_RULE`); the notice options open
  under the choice: the grouping (`NOTICE_GROUPINGS`) and the hazard levels gathered, ticked and
  in their groups' order (a sortable list; every level, most severe first, is saved as no
  `levels`; one stays ticked). With notices the types field names the types searched (none:
  every type), and the outline's count says the rows are the modules holding the notices and how
  they are grouped (the level headings are the resolved manual's). Choosing whole modules again
  removes `notices`. A change of the rule saves the rule (the working copy never sends
  entries) and reads what it gathers again, the rows kept and dimmed meanwhile; a read that fails
  keeps them, with "Try again". A check of a derived manual links to `?section=rule`, which
  focuses the card.
- **Header**: the title is the manual switcher (a searchable list of the manuals, marked new or
  deleted in the revision, then "New manual"). One primary action, "Preview", opens the web
  preview (screen 11) in the chosen language and variant; its split menu has the web preview and
  "PDF: <variant>, <language>", which makes a save point and opens the real PDF
  (`GET /manuals/:id/variants/:slug/:lang/pdf` on the revision's branch) in a new tab. The ⋯
  menu holds Run checks (`/checks?manual=` with the chosen revision), Rename (the title turns
  into a field), Duplicate and Delete. The outline card shows the module count, its keys in a
  keyboard popover and "Add module" as an outline button.

## Checks (`src/app/checks/`)

`/checks` (screen 14, `checks.page.ts`), for anyone who reads content (`content.read`); reached
from the review panel and the manual builder, not from the sidebar. It checks a manual
(`?manual=<id>`: `GET /manuals/:id/checks`, read at the chosen revision once its branch is read,
else the released content) or, without one, what a revision changes
(`GET /change-sets/:id/checks`): the one `?changeSet=` names (the review screen's link; its fixes
open in that revision) or the chosen one; with none, it says what to choose.

- **Top:** the counts (blocking, warnings, the modules without issues of those checked), as the
  API counts them before the filter, then the severity filter (`?severity=`, with counts).
- **Table** (the list frame's table mode, paged on the server, `?page=`, `?size=`): the checks by
  module, each subject named once in a header row (its title, ID and language, and its counts on
  the page), then its checks: severity as a badge with an icon and a word, what the check is and
  what it names (`checks-model.ts`: a text per code, in English and German, never the API's
  English `message`), and a link to where it is fixed: the module editor at its block
  (`/content/<lang>/<id>?block=`), or the manual (a derived manual's checks: its rule,
  `?section=rule`, #669).
- **Actions:** "Run again" reads the checks again (the last answer stays, dimmed, until the new
  one is there). On a manual, "Create release" is hidden without `release.publish`, disabled with
  the reason while anything blocks, and otherwise opens "New release" (`/releases?create=open`).
- **States:** the counts and rows as placeholders on the first load only, no issues, nothing of
  the filtered kind, failed with retry, no access (a refused read).

## Reports (`src/app/reports/`)

`/reports` (#56), a sidebar entry after Releases, for whoever holds `content.read.draft`: two tabs,
each a route (`report-tabs.ts`), read at the chosen revision's branch as other content reads, else
the released content.

- **Translations** (`/reports/translations`, `GET /reports/translations`): one row per manual and
  target language the reader may see, with the share of its modules up to date as a bar
  (`of-meter-bar`) and a percentage, and the counts in words (modules and blocks up to date,
  outdated, at the agency, missing), so the state is never told by the bar alone. A row links to
  the Translations screen filtered to it (`/translations?manual=<id>&lang=<lang>`, #87), only for
  someone holding `translation.manage`. Filters: manual, language (`?manual=`, `?lang=`).
- **Usage** (`/reports/usage`, `GET /reports/module-usage`): every module with how many manuals
  include it (directly or through module references) and how many modules refer to it, the
  manuals it is in (each a link to the manual builder; "through a module reference" in words) and
  the modules referring to it. View All / Used / Unused (`?show=`; Unused is `filter[unused]=true`:
  a module only reached through a reference is used), type (`?type=`), order (`?sort=`: title,
  most used, least used).
- Both: paged on the server (`?page=`, `?size=`), rows scroll inside the list frame with the
  pagination outside it, long titles wrap; **Download CSV** saves the whole report as filtered
  (`/reports/…/csv` through `ApiClient.csv`, saved as a file by `ReportDownload`, never opened).
  The four states come from the list frame.

## Admin: roles and users (`src/app/admin/`)

The Roles and Users tabs of Admin, for whoever holds `admin.roles` (the tabs' primary action is
guarded by it; the API refuses everyone else). The header's action ("New role", "New user") is
handed to the open tab through `AdminActions` (provided by `pages/admin.page.ts`). Every change
applies at once, is written to the audit log by the API, and says so under the screen.

- **Roles** (screen 6, `roles.page.ts`): the roles on the left (paged, `?page=`), the chosen one
  (`?role=`) in the middle: name, description, the ten permissions with what each allows, and
  the scope per facet, module types, audience level ("up to") and languages, a line left empty
  meaning all of it. "New role" starts an empty one whose ID follows the name until it is typed.
  Unsaved changes are confirmed before another role is shown. A role still held cannot be
  deleted (the button says by how many). On the right, who holds it directly (paged), with
  remove and "Add person"; group mapping from an identity provider comes with single sign-on.
- **Users** (`users.page.ts`, `user-dialog.component.ts`): every person, deactivated ones too,
  with email, roles and status; search (`?q=`, ID, name or email) and status (`?status=`) in the
  address, paged (`?page=`, `?size=`). The dialog adds a person (ID made from the email address,
  editable) or changes name, email and roles. Deactivate asks first and then says how many of
  the person's locks were released; Reactivate lets them act again.
- The API keeps at least one active `admin.roles` holder: taking the last one's role, dropping
  `admin.roles` from the last admin role or deactivating the last admin is refused with
  `last-admin`, shown as a toast. After a change to one's own roles, `MeService` reads `GET /me`
  again, so the shell follows at once.
- `admin-model.ts` holds what can be tested without a page: drafts, the IDs made from names,
  what is missing in a form, the scope as the API takes it.

## Admin: branding (`src/app/branding/`, `src/app/admin/branding/`)

An installation's own product name, logos (light and dark), mark, favicon, app icon and brand
colours (#169), stored by the API (`GET /branding`, public; `PATCH /branding` and
`POST /branding/images` for `admin.branding`; `backend/api/README.md`, "Branding").

- **Applied everywhere** (`branding/branding.service.ts`): read once before the first screen
  (next to the demo session, `app.config.ts`); a branding the API cannot give leaves the defaults
  of `docs.config.ts`. The name goes to the sidebar, the sign-in page and the document title
  (`i18n/title-strategy.ts`: "<page> · <product>"); the images to the logo slots and the icon
  links in the head (`link[data-of-brand]`); the colour tokens the API derives (`meta.tokens`,
  light and dark) to one `<style id="of-brand-tokens">` kept last in the head, so it wins over
  `theme.css` without touching it. Only the allow-listed tokens (`BRAND_TOKENS`, the API's list:
  a test compares them) with `#rrggbb` values are written; safety, status and diff colours are
  never among them. A change shows at once for the admin who makes it; everyone else gets it on
  their next load. The web manifest stays the default's.
- **The screen** (`admin/branding/branding.page.ts`, the Branding tab of Admin): the name, the
  five image slots (PNG or WebP; favicon and app icon square; an SVG is refused before upload),
  the primary colour and an optional accent (text field and picker; empty means the default),
  with the contrast the API measured for each, and a sticky preview of sidebar, card and button
  in light and dark side by side. Every change is eager: shown at once, sent, and on a refusal
  rolled back to what is saved, with the reason under the field (a contrast below 4.5:1 names
  the pair and the ratio, `branding-errors.ts`) and a toast. "Reset to default" asks first.
- **Not here:** the UI font, and the branding of outputs (PDF title pages and the portal), which
  page designs (#390) carry per manual, not the installation's app branding.

## Admin: page design (`src/app/admin/page-designs/`)

The Page design tab (#392) lists the PDF's page designs at the chosen revision
(`GET /page-designs`, paged in its own scroller) and edits one at
`/admin/page-designs/<id>`. Everyone who reads drafts (`content.read.draft`) opens it; changing a
design is a change in a draft revision of one's own (`content.edit`, unrestricted, as the API asks);
anyone else, or a revision whose design lock another holds, sees it read-only with the reason.

- `design-draft.ts` (`DesignDraft`, provided by the editor page) saves eagerly, like
  `ConfigDraft`: each change shows at once, takes the `design/<id>` lock on the first save and is
  sent queued into `/change-sets/{id}/page-designs/{designId}/working-copy`; Undo (50 steps) sends
  the design before. A refusal puts the saved design back (a lock or 403 turns the page read-only,
  a conflict reads it again, anything else is a toast with Retry). A save point (subject `design`)
  follows 30 s after the last save and on leaving the page. `createDesign` makes a new design
  (lock, then the first working copy on the revision's base), from the list's "New design" dialog
  (name, ID, layout).
- **The settings** (`page-design-editor.page.ts`), as the PDF reads them: the layout preset
  (`preset-picker.component.ts`, thumbnails in the design's colours, a radio group), page size,
  margins and double-sided print, the light and dark logo (chosen in the image dialog in its
  pick-only mode, or "Use the platform logo": #169's light logo, a WebP drawn into a PNG, uploaded
  into the revision), the three colours with their contrast on white, the fonts (shown; uploading
  fonts is not supported yet, the screen says so), the title page fields (shown or not, ordered
  with `of-sortable-list`), the running header and footer (`running-region.component.ts`: left,
  centre and right, each one of the manual's data; own text for the first page and, double-sided,
  for left pages; text written by hand shows as "Custom text" and is kept as it is), the title
  and back page text (below), headings, body text, tables, steps and notes, and the safety standard with what it fixes listed
  read-only (safety colours, signal words, symbols) and why. The design's issues (by their code,
  never the API's English) show under the section they are in.
- **The title and back page text** (#393, `region-texts.component.ts`, `region-text.ts`): each
  region of the preset (`above-title`, `below-fields`, `band`, `footer`) and of the back page
  (`back`, `back-footer`) in a row that opens on its own block editor in the region mode
  (`of-block-editor [region]`: "/" and Insert offer text, Heading 1 only, lists, images, notes,
  links and placeholders, `REGION_SLASH_ITEMS`). A placeholder (`slash/placeholder-command.ts`)
  goes in by typing `{` (or Insert › Placeholder, which types it): a menu of the keys a region may
  hold (`REGION_PLACEHOLDER_KEYS`, every key but the page ones), filtered as typed, so an unknown
  one can't be typed in; it shows as a chip with its name (`inline/placeholders.ts`), and a key
  that is no placeholder as a flagged chip ("Not a placeholder: …") with the design's
  `unknown-placeholder` issue at its block. One language is edited at a time, the preview's, picked
  above the regions with a count of the texts it lacks: the source language's text is every
  language's until a language has its own; a language without its own shows the source text with
  "Not translated", and typing in it makes its own (`withRegionText`: the region becomes one text
  per language, block IDs kept); "Use the … text" removes it again. Typing is handed to the design
  600 ms after the last key or when the focus leaves; Undo puts the text before back into the
  editor. Text in a region the preset lacks is kept, listed as "Not in this layout", and can be
  removed. The translation status and XLIFF export of this text are #568.
- **The preview** (`design-preview.component.ts`): a manual, variant and language of the person's
  choosing, rendered with this design (`?design=<id>`, the working copy included for the author,
  `?workingCopy=true`): the title page and an inner page (with a pager), then the layout warnings
  (`…/pdf/layout-warnings`: a running head cut short, a region that overflows). After a save it
  renders again 600 ms later; the old pages stay, dimmed, until the new ones are there, in boxes
  of the page's shape, so nothing jumps.
- **The default design** (`pdf.design`) is chosen on the list and saved like a project setting
  (`ConfigDraft`), so only who may change the settings sets it.

## Admin: project settings (`src/app/admin/settings/`, `src/app/admin/variants/`)

The Project settings tab edits the project configuration (`openfolia.yaml`) like any other file: in
the chosen draft revision's working copy (`/change-sets/{id}/config/working-copy`), reviewed
and merged with the rest. It needs `content.edit` without restrictions and `admin.roles`, the
same as the API; anyone else, another author's revision, one in review, none chosen or another
revision holding the config lock shows the settings of the chosen content read-only, with the
reason.

- `config-draft.ts` (`ConfigDraft`, provided by the page) saves eagerly, like `ManualDraft`:
  each change shows at once, is checked against the content model's `StrictProjectConfig`, takes
  the `config` lock on the first save, and is sent queued with the working copy's version. A
  refusal puts the last saved configuration back: `config-in-use` (content still names a value)
  opens the decision, a lock or 403 turns the page read-only, a version conflict reads it again,
  anything else is a toast with Retry. A save point (`POST /commits`, subject `config`) follows
  30 seconds of quiet and leaving the screen.
- Sections (`project-settings.page.ts`, `?section=` in the address): languages (source and
  translation languages; a new source keeps the old one as a translation language), module types
  (restricted; snippets: a type whose modules are snippets, #136; safety: a type whose modules a
  derived manual gathers when its rule names no types, #669), audiences, facets with values, variant attributes, text attributes, safety
  symbols, code languages, output labels per language (`?labels=`, the built-in text as the
  placeholder) and the deepest heading. Lists are sortable (`of-sortable-list`: drag, or
  Alt+Arrow on the grip) and are not paged: they are edited whole, so they scroll in their own
  container instead. An ID is set when a value is added (from its label, until typed) and is
  not changed afterwards: content stores it. The facet releases name their products by (`release.productFacet`,
  else the first) cannot be removed, and moving another facet first names it explicitly, so
  releases keep their products.
- Every value shows how many modules and manuals use it (`GET /config/usages`, at the revision's branch, read again after each save point); a used one links to the content list filtered
  by it. Removing a used value opens `of-in-use-dialog` (`admin/variants/in-use-dialog.component.ts`)
  instead of saving: the counts, the link and, once the API refused, the places it named, each a
  link. Variant values offer Archive there instead: an archived value stays valid for content
  and is marked, not hidden, here.
- `admin/variants/` holds the parts the Variants tab (#91) builds on: the variant attribute
  editor (`of-variant-attributes-editor`) and the in-use decision. `config-model.ts` holds what
  is tested without a page: the checks of IDs, labels and language tags, the changes, the usage
  keys and the places of a refusal.

## Admin: system (`src/app/admin/system/`)

The System tab of Admin (#404, `system.page.ts`, `admin.roles`; it reads nothing at the chosen
change set, so it stays usable while its branch is gone):

- **Storage** (`GET /storage-usage`): what is used, as text ("17.4 MB of 20.5 MB used", or "17.4
  MB used" with "No storage limit is set" when the installation has none) and, with a limit, as a
  meter (`of-meter-bar`) and its share in words. From 80 % of the limit a notice
  (`role="status"`, warning colours) says uploads will be refused at the limit; at the limit it
  says they are (destructive colours). Both link to the media library's unused files
  (`/media?usage=unused`). Then the categories: media and archived PDFs (bytes and files, which
  count) and the Git content and the database (for information, "Not known yet" before the first
  recount), and when the totals were last counted afresh. A failed read says so with Retry.
- **Instance:** the licence and the source code's address, as `GET /about` names them.
- **Largest files** (`GET /storage-usage/files`): the uploaded files, largest first, paged
  (`?page=`, `?size=`), each linking to the media library searched by its hash, with it open (`/media?q=<hash>&file=<hash>`: the hash finds just that file; when the usual list has nothing for it and the person may list unused files, the library looks on the unused list); the
  rows scroll inside the list's frame and long names wrap.

## Preview (`src/app/preview/`)

`/preview` (screen 11, `preview.page.ts`), for anyone who reads content (`content.read`); reached
from the module editor's header ("Preview": `?module=&lang=`) and the manual builder ("Preview":
`?manual=&lang=&variant=`), at the chosen revision (an author's draft) or the released content.
The page and its images are read by `PreviewPages` (`preview-pages.ts`), shared with the module
editor's live preview.

- **Include unsaved changes:** for the person's own draft revision, on by default: the page,
  what is hidden and the PDF are read from its working copies (`?workingCopy=true`); off
  (`?unsaved=off`), the branch as committed. Anyone else's draft never offers it (the API answers
  403 or 404).
- **What:** "This module" (`GET /modules/:lang/:id/preview?variant=`) or "Whole manual" (`?scope=manual`:
  `GET /manuals/:id/variants/:variant/:lang/html`, as the PDF resolves it); a manual named alone
  is the whole manual. The manual is `?manual=` when the module is in it, else the first manual
  that includes the module (read from `GET /manuals`, as "Used in" is).
- **Language and variant:** the module's languages (its summary) or the configured ones for a
  manual; the variants are the manual's published ones (its manifest, `meta.variants`), the
  first by default. A module in no manual has none: its preview applies no variant.
- **Output:** "Portal" shows the rendered HTML; "PDF" builds the manual's PDF (`…/pdf`, read
  with the person's credentials) and opens it in a new tab, as the builder's PDF preview.
- **Rendered HTML is untrusted.** It is shown in `of-preview-frame`: an `<iframe
sandbox="allow-same-origin">` (no scripts, popups, forms or navigation of this page) whose
  `srcdoc` is a document `previewDocument` writes anew from the API's page: a CSP of its own (no
  script; styles and fonts only from the API's origin; images only as `blob:`), only the API's
  `preview/*.css` stylesheets, and the body without anything that could load, run or submit
  (scripts, frames, objects, forms, `<base>`, `<meta>`, event handlers, URL attributes other than
  a safe link `href` and an image `src`; every SVG and MathML). The one SVG kept is an image's
  callout overlay (#546, `svg.of-callouts__overlay` in its `of-callouts__picture`), drawn
  anew element by element: only `line`, `circle`, `g` and `text`, only the attributes the
  renderer writes with values matching their patterns (percentages, a radius, a style key, a
  callout's key), a marker's text a number or `?`. Hovering or focusing a callout's marker,
  legend entry or reference (a link to its picture) highlights all of them (#549): the frame runs
  no script, so this component listens from outside it, as `highlightCallouts` of
  `@openfolia/render-html` does on a page that runs script. A click on a numbered reference follows its link (the frame scrolls
  to the picture) rather than taking the editor to the paragraph. Images are read with `HttpClient` (so the demo user's
  header goes with them: a draft's images are its author's only) and shown as `blob:` URLs; a safety
  symbol's artwork (`GET /symbols/{id}`, #208) as a PNG, rasterised when it is an SVG. The
  frame follows the app's theme without a reload; a `#fragment` link scrolls the frame, an outside
  link opens in a new tab without an opener. `srcdoc` is set on the element, not bound: Angular's
  sanitizer would drop the stylesheets and IDs, and the frame's sandbox and policy are the wall.
- **What is hidden:** a bar above the page names what the variant hides
  (`…/hidden-content`, the first two, "and N more") and whether it is a draft; "Show hidden
  blocks" opens the paged list (`?hidden=shown`, `?hiddenPage=`): each item's label, where it is
  (a block in a module, a module, a chapter) and its condition as chips. With the PDF output, it
  is the manual's.
- **As released (`?tag=`):** a release's changelog links each module to the preview at the
  release's tag: everything (configuration, manuals, module, page, what is hidden, the PDF) is
  read at that tag, the header says which release, and no draft or unsaved changes are offered.
- **States:** a skeleton in the page's shape (first load only; a change keeps the last page,
  dimmed), failed with retry, not found, no access (a refused read), nothing to preview (no
  module or manual named), a manual without variants. The preview takes the height left under it,
  so the page never scrolls; the frame scrolls inside.

## Terminology (`src/app/terminology/`)

`/terminology` (#246), a sidebar entry after Media, for anyone who reads content (`content.read`),
read at the chosen revision's branch as other content reads. No canvas screen exists for it: it
follows the media library and the translations screens.

- **List** (`GET /terms`): a column per configured language with its preferred term (the first
  one also shows the ID where it differs), the definition (three lines at most), the domain and
  the status as a badge in words. Filters: language, domain (the domains `TermIndex` found),
  status, and a search over terms and definitions (`filter[q]`). Paged on the server; the rows
  scroll inside the list frame (sideways too, when the languages do not fit) with the pagination
  outside it; long values wrap. View state in the address: `?lang=`, `?domain=`, `?status=`,
  `?q=`, `?page=`, `?size=` and the open term `?term=`.
- **Panel** (a side panel; a sheet on a phone): status (a select; deprecated asks for an optional
  replacement among the other terms that are not deprecated), domain, and per language the
  preferred term, the allowed and forbidden variants as chips (`of-variant-chips`: Enter adds,
  Backspace in the empty field removes the last, each chip has its own remove button, a pasted
  list is split at its line breaks; forbidden ones are struck through besides their label) and
  the definition (`of-definition-field`: a small TipTap field with inline marks and line breaks
  only). Languages the term holds that are not configured show after the configured ones.
- **Editing** goes through the person's revision as in the module editor: `TermDraft` takes the
  lock (`{ type: 'term' }`), saves the working copy on every change (Saved, Saving, Not saved) and
  makes a save point (a commit) after 30 s without changes, when another term opens, and on
  leaving. Without a draft revision of their own, or while another revision holds the lock, the
  panel is read-only with the reason; a role without `content.edit` sees no reason and no Delete.
- **New term**: a dialog (preferred term, language, the ID made from the term and editable,
  an optional domain); the term is added to the revision as a new file and opens in the panel.
- **Delete term** (`TermWrites`): a confirm naming the term, then a commit with `deletes` (or,
  for a term only in the working copy, discarding it), and a toast with Undo, which restores it in
  the revision. A term another term names as its replacement cannot be deleted; the panel says
  which. (Modules do not link terms yet.)
- **Export**: TBX and CSV of the terms as filtered by language (`GET /terms/export`), saved as a
  file (`TermExport`).

## Releases (`src/app/releases/`)

`/releases` (screen 16, `releases.page.ts`) and `/releases/:id` (`release-detail.page.ts`), for
anyone who reads content (`content.read`); always the released content (`changeSetFree`).
Publishing (New release, Retry, Withdraw) needs `release.publish`; without it the screens are
read-only (the controls hidden, as the guard hides them).

- **List:** the releases, newest first, paged on the server (`GET /releases`), filtered by
  product (`filter[product]`, the product facet's values) and status (`filter[state]`):
  product, product version with a "Major" badge, how far the files are ("12 of 14 files ready",
  failed ones named), status as a badge with an icon and a word, and who published it when. The
  list's answer says where each release's files stand (`meta.outputs`, #481), kept in
  `ReleaseProgress`: no read per release, so the screen makes the same requests however many
  releases a page holds. While any of them still renders, the page is read again every 10 s (one
  request), its rows left as they are. A row opens the side panel (`?release=`): the release's
  first ready files to download, "Files and changes" (its page), webhook deliveries
  (`webhook.manage`) and "Withdraw release".
- **A release's page:** its notes (the summary, a language's own by `?notes=`), the changelog
  (`GET /releases/:id/changes`: each manual and language changed since the product's previous
  release, opening to its modules, each linking to the preview at the release's tag) and its
  files grouped by manual, then variant and language (`GET /releases/:id/outputs`): status, size,
  Download (read with the person's credentials and saved under its served name), Retry on a
  failed one (`release.publish`; shown queued at once, put back when it fails). While a file is
  queued or rendering, the page reads its files again every 5 s, quietly (no skeleton, no layout
  shift). A release without files offers "Plan the files again" (`POST …/outputs/plan`).
- **Withdraw** (`release.publish`): a dialog with the reason, required; withdrawing is final
  (#331), so there is no Undo. The release stays listed, as withdrawn, with the reason.
- **New release** (screen 15, `create-release-dialog.component.ts`, `?create=open`): four steps.
  1. Product and version: cut from `main` (or an open maintenance line, for those who may read
     them), the product (a value of the product facet), the product version, and the commit it
     will tag (main's head, `GET /refs`).
  2. Checks: every manual's checks at that ref (`GET /manuals/:id/checks`), manuals with blocking
     checks first, each check linking to its fix and "View all" to the checks screen. A banner on
     every step sums them up. While anything blocks, "Create release" is disabled with the
     reason; warnings need a confirmation that names their count.
  3. Outputs: what the release renders. The API renders every manual in each of its variants and
     every configured language as PDF (a manual the release does not change reuses the last
     release's file), so this step shows that, read-only, with how each language's translations
     stand (`GET /translations/status`: missing modules fall back to the source language).
  4. Notes: the summary, optional summaries per language, and "Major change" (subscribers are
     notified). The notes are checked as the API checks them.
     Then `POST /releases` (with `maintenanceLine` for a line); the new release's page opens.
- **Maintenance** (#250, `maintenance-tab.component.ts`, `?tab=maintenance`; shown to those who
  may read drafts): the maintenance lines, newest first, paged on the server
  (`GET /maintenance-lines`): product, product version, the release it started at (a link),
  open or closed (a badge with an icon and a word) and who started it when; never a branch.
  "Close" (`release.publish`) asks first, as closing is final (no Undo), shows the line closed at
  once and puts it back if refused. A published release's panel has a "Maintenance" section:
  its line's state with "Show in Maintenance", or "Start maintenance" (`release.publish`,
  `POST /maintenance-lines`; a second start is told the line exists).
- **States:** skeletons on the first load, empty (none yet; none for the filter), failed with
  retry, not found, no access.

## Texts and languages

Every text is a translation key (`frontend/ui/README.md`, "Internationalisation"): the editor's
own texts are the `editor` scope in `src/i18n/<language>.json` (English and German), the
library's the `ui` scope. `app.config.ts` provides `provideI18n({ scopes: ['editor'] })`, and the
build copies both scopes' files to `i18n/<scope>/`. Route titles, breadcrumbs, nav labels and
blocked reasons are keys; `TranslatedTitleStrategy` (`src/app/i18n/`) sets the document title in
the active language. A failed API call is shown with `apiErrorText(error)`: by its `code` and
`meta`, never its English `detail`. The language choice sits in the account menu under the theme.
German texts use the "Sie" form and one word per term, by the glossary (`frontend/ui/README.md`,
"German glossary"); `tools/i18n.test.mjs` refuses the rejected words and the "du" pronouns.

## What belongs here

- Routes, pages, state and the API client of the editor.
- App-specific components made of `frontend/ui` components.

## What does not belong here

- Generic components (buttons, dialogs, inputs, …) and styling tokens: they go into
  `frontend/ui` and `frontend/theme`. The app imports a component from its folder's entry
  (`@openfolia/ui/select`; never a file inside it, never the whole `@openfolia/ui`, never `../ui`); the lint
  rule `no-restricted-imports` and `@nx/enforce-module-boundaries` refuse the rest, and the local ESLint
  rule `openfolia/no-ui-duplicates` (`eslint-rules/`, with its own test run by `nx lint editor`)
  refuses a file in the app named like a component `frontend/ui` already provides.
- Tailwind configuration: `src/styles.css` only imports the library's stylesheet.

## Run

`pnpm nx serve editor` (development server), `pnpm nx build editor`. Nx targets: `test`
(Vitest in jsdom through Angular's unit-test builder: no browser to download), `lint`,
`typecheck`, `build`.

### The initial bundle

What the browser loads before the first screen is only Angular, the router, the translations and
the startup code: `main.ts`, `app.config.ts`, `app.routes.ts`, `app.ts` and the services they start
(`session/demo-session.ts`, `session/change-set-session.ts`, `session/change-set-url.ts`,
`permissions/me.ts`, `permissions/permission.service.ts`, `api/`, `i18n/`, `sign-in/sign-in.guards.ts`),
and the route tables they need (`shell/nav.ts`, `reports/report-tabs.ts`).
Every screen, the shell included, is a lazy route; the shell's code is fetched while `GET /me` is
answered (`app.config.ts`).

- The startup code imports the library from `@openfolia/ui/startup`: a barrel brings every module it
  re-exports into the bundle of whoever imports it (`frontend/ui/README.md`, "Entry points").
- Development aids (the showcase, the block editor playground) are guarded by `ngDevMode`, which a
  production build replaces with `false`, not by `isDevMode()`, which it cannot.
- The production budget (`project.json`): a warning at 650 kB and an error at 700 kB for the
  initial bundle (about 600 kB raw, 140 kB transferred, in #494). A build over it most likely has
  a barrel import in the startup code: `pnpm nx build editor --stats-json` writes
  `dist/browser-stats.json` (esbuild's metafile) to find it.

### Each screen's bundle

A screen loads the initial bundle, the shell and its own chunks, and only what those import (#500):

- **The library by folder:** `@openfolia/ui/select`, never the whole `@openfolia/ui` (the lint rule refuses
  it). With the whole library, every screen loaded every component that any screen used.
- **The editor's own folders by file:** `../session/change-set-session`, not `../session`. The
  component folders (`session/`, `search/`, `about/`, `permissions/`, `notifications/`) have no
  `index.ts` any more, so a barrel cannot come back: the sign-in page loaded the shell's
  change-set dialogs through the session barrel. `api/`, `i18n/` and `view-state/` keep theirs:
  they hold no components and are startup code.
- **The content model without its schemas:** `@openfolia/content-model/core`, the model's types and
  its schema-free helpers, without zod and yaml (about 540 kB raw together). A lint rule
  (`@typescript-eslint/no-restricted-imports`) refuses the full `@openfolia/content-model` outside the
  tests; a type-only import of it passes, since it is erased. A file that validates with a schema
  at run time imports the full entry and says so in a comment that disables the rule: the block
  editor's link, key and variant checks, its playground and the configuration check of the settings
  screens (`admin/settings/config-model.ts`, which the variants screen loads too). The
  terminology screen loads zod through the definition field's editor extensions
  (`@openfolia/content-editor-model`). Every other screen loads no zod.
- **Finding what a screen loads:** `pnpm nx build editor --stats-json` writes
  `dist/browser-stats.json`; a chunk's `imports` with `kind: "import-statement"` are what loads
  with it, and an input's `imports` show which file brought a module in.

The builder runs Vitest with `isolate: false`: a module shared by several spec files is
evaluated once per worker, so a `beforeEach` or `afterEach` at the top level of a test helper
reaches only the first spec file of each worker. Per-test cleanup goes with the test that needs
it (`onTestFinished`, as `testEditor()` destroys its editor), or into
`testing/test-setup.ts`, which runs for every spec file.

A test's 5 s timeout is for the test, not for a cold start (#499). A spec that navigates the
app's own routes imports their lazy chunks once in a `beforeAll` with a timeout of its own
(`loadLazyRoutes(routes)`, `src/app/testing/lazy-routes.ts`), so the first test that opens a
screen does not pay for importing it. A test that waits out a debounce again and again runs on
fake time (`vi.useFakeTimers()`, then `vi.advanceTimersByTimeAsync`, as the variant picker's
spec does): real waits add up, and a loaded machine stretches each of them.

A spec never waits a fixed stretch of real time for something a timer does (#562, as
`frontend/ui` since #543): no `await wait(30)`, no `await new Promise((r) => setTimeout(r, 300))`,
no race of `whenStable()` against a real timer. A debounce, a menu, a dialog's leave transition
or a poll runs on a timer that change detection sets, and change detection itself runs on a
timer, so on a busy machine a fixed wait can end before that timer is even set. Such a spec runs
on fake time: `vi.useFakeTimers()` before the component is made (after
`RouterTestingHarness.create()` for a routed page), then `advance(ms)` from
`src/app/testing/fake-time.ts` (it runs the timers due within `ms` of the fake clock, in order,
renders with `TestBed.tick()`, and runs what that render set) and `settled(promise)` for an
answer that comes after such a timer (it throws after 1,000 ms of fake time). Under fake timers
`fixture.whenStable()` waits on a faked timer, so a spec on fake time doesn't call it;
`testing/test-setup.ts` restores real timers after each test. A wait of one real
`setTimeout(…, 0)` turn, or for the state itself (`whenStable()` on real timers, `vi.waitFor`),
is not a fixed wait: one real turn comes after the work already queued (promises, earlier
timers) under any load, and a wait for the state ends when the state is there. Never a longer
timeout instead.

A test that times out does not stop: Vitest gives up on it, but its code goes on in the
background, in the window the next test shares (#615). So `advance()` and `settled()` throw at
their next step once the test that began it timed out (`testing/test-setup.ts` hands them each
test's signal, from its `beforeEach` to its `afterEach`). An abandoned test that was waiting on
something else and steps only after the next test began is not caught: it reads that test's
signal.

## API client (`src/app/api/`)

Typed access to the API, kept in the app rather than a library: it has one consumer, and a
library would need its own build and module boundaries for no gain. Plain Angular `HttpClient`,
generated types and a few helpers; no runtime client dependency.

- `schema.d.ts` is **generated** from the API's real OpenAPI document: `tools/generate-api-types.mjs`
  boots the built API in-process over a sample repository and runs openapi-typescript on the
  document. `pnpm nx run editor:api-types` rewrites it; `editor:check-api-types` fails when the
  committed file differs from what the current API produces, and `lint` depends on it, so
  `pnpm check` fails on drift. Commit the regenerated file together with the API change.
- `ApiClient.upload(…)` sends a file as an upload's form, an image or, with `kind: 'attachment'`,
  an attached file (`?kind=attachment`); `ApiClient.image(…)` reads an image's or attached file's
  bytes (`/assets/{hash}` at the chosen branch, or a revision's preview).
- `ApiClient.get(path, { path, query })` is typed by route: path and query parameters (`ref`,
  `page[number]`, `page[size]`, `filter[...]`) and the response document come from the schema.
  `pageQuery()` builds paging parameters; `Item<'/modules'>` and `Schema<'...'>` name types.
- Errors: `apiErrorInterceptor` turns every failed API call into an `ApiError` (`kind`, `status`,
  the API's stable `code`, `message`, `parameter`, `retryAfter`). `api-error.ts` is the only place
  that reads the error document; shared states and toasts switch on `kind`.
- Base URL: `API_BASE_URL` (default `/api`); override it with a provider.
- Identity: `API_DEMO_USER` is an optional signal; while it holds a name, `demoUserInterceptor`
  sends `X-Ccms-User`. `DemoSession` provides it, and only while the API is in demo mode.
- Reads follow the chosen revision: `ReadRef` holds its branch, and `ApiClient.get` adds `?ref=`
  on the routes that take one (`REF_ROUTES`, type-checked against the schema) unless the call
  names its own. `ApiClient.post` sends a JSON:API body to a route that answers 201; `ApiClient.act` posts to one
  that answers 200 or 202 (an action, a relationship, a queued job such as a release file's retry), `ApiClient.patch` changes a resource, and
  `ApiClient.delete` takes an optional body (removing from a relationship).
- Cross-site requests: the API refuses a state-changing call (any method but GET, HEAD, OPTIONS)
  that does not say `Content-Type: application/vnd.api+json`, also without a body
  (`backend/api/README.md`, "Cross-site requests"). `stateChangeInterceptor` adds it to every such
  API call that names no type, `ApiClient` included (transitions, locks, saves, save points,
  comments, `DELETE`); a `FormData` body (an upload, `multipart/form-data`) gets `X-Ccms-Request`
  instead.

### Local development and the token

The token is never in the bundle. `pnpm nx serve editor` proxies `/api` to the API
(`proxy.conf.mjs`) and adds `Authorization: Bearer <token>` in the dev-server process. It reads
`CCMS_API_TOKEN` and `CCMS_API_URL` from the environment, else from the worktree's local settings
file that `pnpm nx run api:setup-local` made. Without `CCMS_API_URL` the API is
`http://127.0.0.1:<PORT>` with the `PORT` of that settings file only (else 3100): the process's own
`PORT` is never read, since starting the dev server with one (`PORT=4300 pnpm nx serve editor`)
would make the proxy send every `/api` call to itself (and answer `index.html`). For an API on
another port, set `CCMS_API_URL`. The proxy prints its target at start-up. With `api:serve-local`
running it works unchanged.

The proxy refuses (403 `cross-origin-request`) any request whose `Origin` is not the dev server's
own (`tools/proxy-origin.mjs`), so a page on another site can never use the token it adds;
requests without `Origin` pass (a same-origin read, curl, and a cross-site `<img>` or link, which
browsers send without `Origin`: GETs change nothing and their answer stays unreadable). This check
is required: the dev server answers with CORS headers on what it proxies, so without it a page on
another origin could read the API through it. It compares `Origin` with the request's `Host`, so it
relies on the dev server's host check (Vite's `allowedHosts`, against DNS rebinding): keep it on,
never `allowedHosts: true`.

A deployment puts a reverse proxy at `/api` that adds the token the same way, and checks `Origin`
the same way: forward a request only when it has no `Origin` or the editor's exact origin. With
nginx, for example (the editor at `https://editor.example.com`):

```nginx
location /api/ {
    if ($http_origin !~ '^(https://editor\.example\.com)?$') {
        return 403;
    }
    proxy_set_header Authorization "Bearer <CCMS_API_TOKEN>";
    proxy_pass http://127.0.0.1:3100/;
}
```

The API's own rule (the JSON:API media type on every state-changing request) holds behind any
proxy; the `Origin` check keeps the proxy from lending its credentials to another site at all.
