# `frontend/ui` (`@openfolia/ui`)

The Angular component library: [Zard UI](https://zardui.com) components and our own, styled with
Tailwind CSS v4 on the tokens of `frontend/theme`. Standalone components, signals, `OnPush`.
Every frontend app imports its components from here, never from files of its own.

## What belongs here

- Zard components, installed with the Zard CLI into `src/lib/<component>/` (`components.json` at
  the repository root holds its settings): `npx zard-cli@latest add <component> -p frontend/ui/src/lib`.
  The CLI copies the source, so a Zard component is ours to change; keep one folder per component.
  The source can also be taken from the registry (`https://zardui.com/r/<name>.json`) with its
  `@/shared/...` imports made relative. Installed so far: button, badge, sidebar, tooltip,
  separator, skeleton, tabs, breadcrumb, table, input (with input-group), textarea, select, checkbox,
  radio-group, switch, dialog, alert-dialog, sheet, command, popover and dropdown-menu (folder
  `dropdown-menu/`, Zard's `dropdown`) and their `core/` helpers. Our changes to them:
  - **`provideZard()`** (in `core/`, add it to the app's providers and to a test that renders
    these components): Zard's templates use an event modifier syntax (`(keydown.{enter,space}.prevent)`)
    that a plugin implements. Without it select, command and dropdown menu get no keys. `ui.css` carries
    Zard's state variants (`data-checked:`, `data-selected:` …) and its `no-scrollbar` and
    `scrollbar-thin` utilities;
  - strict typing (`noUncheckedIndexedAccess`) in select, command, dropdown, radio and popover;
  - dialog, alert dialog and sheet on Back and Forward (`zCloseOnNavigation`, on by default; in
    place of the CDK's `disposeOnNavigation`, which removed the overlay without telling the
    component, so it still said open and could not be opened again): the overlay closes as on its
    own close (exit transition, focus back) and reports it (`zVisibleChange`) only once the router
    has finished the navigation and the page has rendered it, and only if the host still says
    open, so a host that writes the address on close builds on the address Back went to
    (`core/overlay-navigation.ts`). Off, it stays while its page does: for an overlay the address
    opens and closes (the module editor's preview, the media details, the notifications) and for
    one holding something shown once (the service-token sheet);
  - the scrim behind dialog, alert dialog and sheet is `foreground` 40 % in light and `background`
    70 % in dark (no black), the dialog footer has no tinted background;
  - alert dialog: `zDescription` is plain text (Zard's showed it as HTML), as the dialog's and
    the sheet's are, so a name in it (a person, a group, a title) shows as typed, markup
    included. A translation that needs its own markup (emphasis, a line break) goes into
    `zDescriptionHtml` as its key and parameters (a `TranslatedText`): the dialog escapes every
    string parameter, nested ones too, before it translates, and Angular sanitises the result;
    with both given, `zDescription` is shown. A dialog's or sheet's string `zContent` is still
    HTML. The lint rule `no-html-text` (`eslint-rules/`, on here and in the editor) refuses
    `[innerHTML]`, a write to `innerHTML` and a `zContent` built from a string or a translation;
    a place that has to show HTML says why in an `eslint-disable-next-line` comment (the rule is
    `openfolia/no-html-text` here and `openfolia-ui/no-html-text` in the editor). A `zDescriptionHtml`
    translation puts its parameters in text or in quoted attributes, never in `href`, `src` or an
    unquoted attribute, and a parameter it selects on (`{kind, select, …}`) is a plain word, since
    it is escaped too;
  - select got `zPrefix`, a muted word before the value inside the trigger ("Language English"),
    not read out (the accessible name is `zAriaLabel`);
  - select and checkbox got `zAriaLabel` (the accessible name of the field; for the select it
    reads `name: value`); select, popover and dropdown panels are at most the viewport wide;
  - every panel anchored to a trigger (dropdown menu, submenu, popover, select) is placed by one
    helper, `createTriggerOverlay` (`core/trigger-overlay.ts`): it follows the trigger on every
    scroll (the window, the shell's content area, a list frame, any container around it), flips to
    another side when there is no room and is never pushed off the trigger; it only slides along
    the trigger's edge into the viewport (usable at 320 px), and a panel beside its trigger falls
    back to below or above it. Once the trigger has scrolled out of view the panel closes with
    its usual animation, and a focus that was inside goes back to the trigger without scrolling;
  - a dropdown menu opened by its trigger (`[z-dropdown]`, `ZardDropdownService`) is at most
    `max-h-96` high by its own class, not by its pane; a long menu
    whose entries should all show where the window has room passes `class="max-h-none"` and is
    then held to the room beside its trigger, scrolling inside itself past that (#694);
  - command: each command's ids are unique (`z-command-<n>-list` …) and it shows "No results
    found."; an option added while it is open (a list that loaded during a search) joins once its inputs are set, never read before; the input points at the highlighted option (`aria-activedescendant`, each option has
    an id) and a disabled option is `aria-disabled`; `zShouldFilter="false"` shows every option
    (results a server searched), with no "No results" and no count; `z-command-input` takes
    `zVariant="palette"` (the search row of a Cmd/Ctrl+K palette, a key hint projected as
    `data-slot="command-input-trailing"`) and `label` (its accessible name); an option takes a
    richer label as `data-slot="command-option-label"` (two lines, highlighted matches); checkbox, radio and switch borders use `muted-foreground` so they show against both themes;
  - tooltip: `text` (a signal) lets a directive on the same element set the text (the editor's
    permission guard does), and a focused trigger keeps its tooltip when the page scrolls; placement is ours
    (`placeTooltip`): the preferred side if it has room (8px margin), else the opposite side, then the
    two across, the body slides along the trigger's edge into the viewport and the arrow keeps pointing
    at the trigger's centre; `dismiss()` closes it now; the directive skips `z-sidebar-menu-button`
    (which has its own `zTooltip`);
  - sidebar: the active item is marked by the `sidebar-accent` background and a medium weight, with no edge bar; table: the header background is on the row (never the cells, which would show seams), rounded by `clip-path: inset(0 round var(--radius))`, with dark header text; a hovered or selected row is clipped the same way; rows have dividers, the last one too inside a list frame; checkbox: the input is always `size-4`, a caller's width never applies;
  - sidebar: floating variant with our gutter and radius, the Ctrl/Cmd+B shortcut ignored in
    editable fields (it is Bold there), the trigger's icon follows the state, the mobile drawer's
    `data-[state=…]` variants (Tailwind v4's `data-closed:` needs a `data-closed` attribute);
  - tabs: `nav[z-tab-nav]` with `a[z-tab-link]`, tabs that are routes (`routerLinkActive` sets
    `data-active`; or `zActive`, which wins, when the page decides the current tab, one a query
    parameter tells apart, and then sets `aria-current` too), next to Zard's in-page tab group;
  - strict-mode typing fixes in tooltip and tabs, and theme colours in place of `black`.
- `src/lib/shell/`: `of-account-menu` (initials, the name when expanded; a Dropdown Menu with the
  name and role, the theme choice and the interface language as menu radio items, and the projected `z-dropdown-menu-item`s) and `of-page-header` (the `h1` and the page's actions; an element marked `ofTitleAside`
  sits next to the title, such as a save status, then `of-page-help`). `of-page-help` (#221)
  is the screen's help link: a ghost question-mark button opening `PAGE_HELP` (a
  `Signal<PageHelpLink | null>` the app provides; without it, or while it is null, nothing shows)
  in a new tab, `noopener noreferrer`, named "Help: <title> (opens in a new tab)". A screen with a
  heading of its own puts `<of-page-help />` beside it.
- `src/lib/tip/` (#222): `TipOverlay.open({ anchor, content, onAction, onDismiss })` shows a
  `of-tip-card` beside an element (placed by `createTriggerOverlay`; `anchor: null` centres it
  near the top), one at a time: a non-modal dialog named by its title and described by its text,
  "Learn more" (`noopener noreferrer`, a new tab), and "Got it" and "Turn off tips", or, with a
  `step`, "2 of 5", ×, Back and Next (Done on the last); a step may name its main button (`next`),
  add a quiet button that ends the tour (`dismiss`, "Not now") and leave Back out (`back: false`,
  #869). `learnMore.read` names the guide page instead ("Read “Your first edit”"). It
  fades and scales in and out (150 ms; at once under reduced motion), takes the focus as it opens
  and gives it back as it closes; Escape closes it; `update()` moves it to the next step's anchor.
  With `focus: false` it leaves the focus where it is (a step that comes while the person types)
  and says its title and text politely in the page's one live region (CDK `LiveAnnouncer`), once
  per step. `keepClear` names what it must not cover (the person's own edit): a card that would
  moves below it, or above it with no room below (`clearOf`), and drops its arrow. A centred step
  is a little wider, so its title breaks well.
  Its texts are keys, translated in the card. `pageBusy()` says whether a tip must wait: a modal
  open, a menu, select or popover open in the overlay container, or the focus in a field (but not
  in `typingIn`, the field a tour step asks the person to type in).
- `src/lib/theme/`: dark mode. `ThemeService` (`preference`: `light`, `dark` or `system`;
  `resolved`; `choose()`) puts `.dark` and `color-scheme` on `<html>`, follows the device while
  the choice is `system` and remembers a choice in `localStorage` (`of-theme`; storage that
  throws is ignored). `of-theme-choice` is the Light / Dark / System control for the account
  menu. A choice crossfades the whole page (`withThemeFade`: `document.startViewTransition`,
  300 ms ease-out, the sun/moon icon named `theme-icon` turns out and back in with an overshoot;
  the rules are in `ui.css`) and is instant where view transitions are missing or the person
  asked for reduced motion. An app adds a small inline script to `index.html` that applies the
  stored choice before the first paint.
- Our own shared components, in the same layout (one folder per component, an `index.ts` each).
- `src/lib/module-tree/`: `of-module-tree`, an outline that is reordered and nested: drag
  (Angular CDK) with a 2px line where the row lands, Alt+Arrow Up/Down to move a row with its
  subtree, Tab and Shift+Tab to change its level, numbering (`1`, `1.1`, …). Rows (`items`, two-way)
  carry `id`, `title`, `level` and optionally `nesting`: `'none'` (a leaf, never a parent) or
  `'required'` (a group that keeps at least one row under it); every move keeps those rules (the
  logic is in `module-tree.logic.ts`). `selected` (two-way) marks a row (`aria-selected`), Enter or
  a click on a title emits `activate`, `readonly` shows the outline without grips and refuses
  every move. A `trailing` template adds badges or a menu per row.
- `src/lib/sortable-list/`: `of-sortable-list`, a flat list put in order by dragging a row's
  grip (Angular CDK) or, on the focused grip (a button named "Move <label>"), with Alt+Arrow
  Up/Down; a polite live region says the new place. Rows (`items`: `id` and `label`) are drawn by
  `<ng-template ofSortableRow let-item let-index="index">` and may hold fields and buttons,
  which keep their own keys; `itemsChange` emits the whole new order, `readonly` drops the grips.
  `moveItem(list, from, to)` is the move itself.
- `src/lib/meter-bar/`: `of-meter-bar`, a share as a thin bar (`role="meter"`, `value` a percentage kept within 0–100, `label` its accessible name, `valueText` the value in words, `tone` the fill's colour: `success` by default, `warning` or `destructive`; the fill grows smoothly, at once under reduced motion). Never the only way a value is told: show it as text beside it (the editor's reports, #56; storage used, #404).
- `src/lib/avatar/`: `of-avatar`, a person as round initials (`name`; at most two, `initialsOf`),
  in the foreground colour on the background's, `size` `sm`, `md` (default) or `lg`. Decoration:
  hidden from screen readers, so the name is always shown beside it.
- `src/lib/kbd/`: `kbd[of-kbd]`, a key or shortcut as a small keycap (`Esc`, `⌘K`).
- `src/lib/highlighted-text/`: `of-highlighted-text`, plain text with search matches marked
  (bold, underlined and tinted, so never by colour alone) from UTF-16 offsets; the text is
  always bound as text, never as HTML, and offsets out of range or overlapping are tolerated
  (`highlightSegments`).
- `src/lib/code-editor/`: `of-code-editor` (#396), a text file edited as code: a plain `<textarea>`
  over the same text drawn with syntax highlighting (`highlightCode`: Typst, YAML, JSON, XML/SVG,
  by `languageOf` a path; approximate, it only colours, in the theme's colours), line numbers in a
  gutter that stays while the code scrolls sideways, and `markers`, the lines with a problem
  (tinted, the number in the destructive colour, the field `aria-invalid`; the problem itself is
  told in words beside it). The browser's own caret, selection and undo; Tab indents the line or
  the selected lines, Shift+Tab takes it back, Enter keeps the indent, Escape and then Tab leaves
  the field (say so in a hint, `describedBy`); Ctrl/Cmd+S is `saveRequest`. `revealLine(line,
column)` puts the caret there and scrolls it into view; `caretChange` reports where it is.
  The host gives it a height; the code scrolls inside it.
- `src/lib/logo/`: `of-logo`, the product logo (small mark, full logo, or small mark next to the
  product name when no full logo is configured). It takes its URLs and name as inputs; the app
  reads them from its branding config. `smallDark` and `fullDark` (optional) are the same logos
  for a dark page: the component shows the light one or the dark one by the theme's `dark:`
  variant, and the light one in both when no dark one is given.
- `src/lib/ui/merge-classes.ts`: the `mergeClasses` helper the Zard components use.
- `src/styles/ui.css`: the one stylesheet an app imports. It brings in Tailwind, the theme
  (`@openfolia/theme/theme.css`) and maps the theme's variables to Tailwind utilities; it tells
  Tailwind to scan this library's templates.
- `src/lib/showcase/`: the component showcase (below).

Anything exported for apps goes through `src/index.ts`. Screens do not belong here (they live in
the app that owns them); neither does anything that talks to the API.

## Entry points

- `@openfolia/ui/<folder>` (`src/lib/<folder>/index.ts`, for example `@openfolia/ui/select`): one folder's
  components, for an app's screens. A screen imports each component from its folder, so it loads
  only the folders it uses: esbuild counts every module a barrel re-exports as reached by whoever
  imports the barrel, so a screen that imported the whole library would load every component any
  screen uses (#500). `mergeClasses` is `@openfolia/ui/ui`.
- `@openfolia/ui/startup` (`src/startup.ts`): the few things an app needs before its first screen
  (`provideZard`, `provideI18n`, `ThemeService`, `RouteFadeDirective`, `ToastService`,
  `translated`, `injectTranslate`). An app's bootstrap code imports from here: one folder's barrel
  in the startup code puts that whole folder in the initial bundle. For the same reason
  `startup.ts` names each file, not a folder's `index.ts`.
- `@openfolia/ui` (`src/index.ts`): everything at once, the entry ng-packagr packages. The editor's lint
  rule refuses it in the app.
- Inside the library, a component imports another folder's component by its file
  (`../core/id.directive`), never by the folder's `index.ts`: the checkbox would otherwise bring
  the whole of `core/`, the CDK overlay with it, to every screen with a checkbox.
- `@openfolia/ui/<folder>` and `@openfolia/ui/startup` are source paths, like `@openfolia/ui` itself: an app maps
  them in its tsconfig (`frontend/editor/tsconfig.base.json`); the ng-packagr build packages
  `src/index.ts` only.
- The package is marked `"sideEffects": false`: nothing here runs on import.

## Shared states, list frame and toasts (screen 20)

- `src/lib/states/`: `of-empty-state`, `of-skeleton-rows` (loading for lists: no spinner;
  `header` adds the table-header bar; delayed 150 ms and faded in, see "Smooth UI"), `of-error-state` (retry when trying again can help;
  `heading` overrides the title), `of-no-access` (`heading`; may project a link such as "See my
  roles"), `of-save-status` (`saved`, `saving`, `draft`, `not-saved`, with a `detail`: icon and word,
  never colour alone; `draft` is a normal step of writing, muted, and only `not-saved` is in the
  destructive colour; a new state fades in where the old one stood). The empty, error and no-access states show their icon in a 48 px rounded
  square.
- `src/lib/list-frame/`: `of-list-frame`, the frame every list sits in. `pageSizes` adds a "Rows per page" Select to the pagination (`pageSizeChange`). Rows scroll inside
  the frame (`overflow-y-auto`, capped to `100dvh` minus the `offset` input, which is the space
  above the frame); the pagination sits below the scroller, always visible; long values wrap.
  The scroller is positioned (it clips its rows' absolutely positioned parts, an `sr-only`
  status too, which would otherwise stretch the page's scroller, #563) and stops scrolling at its
  ends (`overscroll-contain`), so the page never scrolls with it;
  loading, empty, error and no-access are built in. Rows come from an
  `<ng-template ofListRow let-item>`; a list read as a table gives `<ng-template ofListTable let-items>`
  with a `<table z-table>` of the page instead (sticky header row; the scroller then scrolls sideways
  inside the frame below the table's width), and a list of tiles `<ng-template ofListGrid let-items>`
  that lays out the page itself (a CSS grid of images; its first load shows placeholder tiles). An
  empty state may project an action with `ofListEmpty`.
  A list of rows sits in a bordered card; `cards` drops that card for rows that are cards of their own (set apart by a gap: the review's revisions); a table has no card around it (the design's header band
  and dividers frame it). **Loading never jumps:** the first load shows skeleton rows (`tall`, the
  table's row height), faded in after 150 ms so a quick answer never flashes them; a reload keeps
  the current rows on screen, dimmed and inert, with the pagination in place and disabled, until
  the new page arrives. **A filter that adds or removes items moves them** (same page, some items
  kept): a removed item fades out in its place, then the others slide up to close the gap; the
  others slide down to make room for an added item, which then fades in (FLIP with the Web
  Animations API, 150 + 220 ms). Another page, a first answer, an answer that keeps no item, or
  reduced motion: the switch is at once. Items are told apart by `trackBy` (by default their
  `id`); rows of `ofListRow` take part by themselves, a table's rows and a grid's tiles with
  `[ofListItem]="item"` (the `@for` tracks by the same key).
- `src/lib/blocks/`: the documentation blocks as an editor's node views draw them: `of-safety-notice`,
  `of-safety-symbol` (a safety symbol's artwork on a white tile, its label as the text
  alternative; a skeleton while it loads; without artwork the label marked "No artwork", never a
  broken image; `compact` for a menu entry; hand it a raster, never an SVG's `blob:` URL),
  `of-variant-block`, `of-module-reference-card` and `of-image-block` (the picture at its
  width, a percentage of the column, or its own size; the caption; the alt text under it, or "No
  alt text" as a problem in words; a skeleton while it loads, missing and failed in words in a
  muted box at most 20rem wide, failed with Retry, never an empty or broken `<img>`; an optional
  action such as Edit, disabled with its reason, centred on one line with the caption and alt text
  in one text size; an overlay projected over the picture with `ofImageOverlay`),
  `of-callout-overlay` (an image's callouts on its picture: numbered markers, leader lines,
  dragged or moved with the arrow keys, Delete; read-only it is decoration, hidden from screen
  readers; a marker hovered or focused emits `hoverChange`, and the `highlighted` one is drawn
  larger with a ring and its leader line thicker, #549), `of-attachment-block` (an attached file in the image block's frame: an
  icon by its type (`attachmentIcon`), the name, the file name, type and size, the description,
  Download with a spinner while it saves and an optional action such as Edit; missing and empty
  say so in words), `of-admonition` (a note,
  tip or something important: a thick coloured edge and a tint from the status tokens, the kind's
  icon and word, never a coloured header bar like a safety notice's; the colours fade on a kind
  change, at once under reduced motion), `of-faq-entry` (an FAQ entry: a quiet bordered frame,
  never tinted like a notice, a question icon and its label, then the question and its answer as
  projected content; a `group` named by the label), `of-procedure-block` (numbered steps under a label),
  `of-code-block` (monospace, whitespace kept, the language in the header) and
  `of-passthrough-block` (unconverted source: read-only, its format, "Show source" opens it
  smoothly, always as text) and `of-page-break-block` (a page break: a dashed rule with its
  label in the middle, a `separator` named by the label).
- `src/lib/collapse/`: `of-collapse`, content that opens and closes smoothly (`[open]`): the
  grid row animates from `0fr` to `1fr` with a fade, instant under reduced motion. Closed content
  is `inert`; it clips only while closed or moving, so focus rings show once open; created open,
  it is open at once. Used for the content browser's folder tree.
- `src/lib/search-shortcut/`: `ofSearchShortcut` on a page's search input: `/` focuses and
  selects it (`aria-keyshortcuts="/"`), like the palette's Cmd/Ctrl+K. Only when focus is not in
  a field, no modal dialog is open and the box is visible and enabled; the first one created wins (a closing dialog, `data-state="closed"`, no longer counts).
  `isPageShortcut(event)` is that test for other page-wide keys (the editor's `?`). `Esc` in the empty box gives focus back. Pair it with a `/` keycap
  (`<kbd of-kbd aria-hidden="true">/</kbd>` in an `inline-end` addon) that fades out while the
  box is focused or filled.
- `src/lib/segmented/`: `of-segmented`, a few choices side by side, one chosen (`options`,
  `[(value)]`, `label`): native radio buttons, as `of-theme-choice` (one tab stop, arrow keys
  move the choice; the chosen one on the background, medium weight). An option's optional
  `count` shows after its label in muted tabular figures (how many items the choice holds). The
  review's filter (with counts) and its Inline / Side by side / Rendered switch.
- `src/lib/badges/`: `of-language-badge` has a `legend` display (a coloured dot and the word in
  plain text, no badge) for keys under a table.
- `src/lib/toast/`: `ToastService` (`show`, `success`, `error`, `runAction`, `dismiss`; a toast
  may carry an action such as Undo), `of-toaster`, mounted once in the app shell, and
  `of-toast`, one toast as it looks (inverted: foreground colour as background, in both themes). It is our
  own small service in the role of Zard's Sonner (no extra dependency); errors stay until dismissed.

The library never imports the editor, so the frame's inputs are small structural types. An app
maps its API layer onto them:

```ts
// the editor's paged document and ApiError
<of-list-frame
  [items]="doc()?.data ?? []"
  [page]="doc()?.meta.page ?? null"          // { currentPage, lastPage, perPage, total } as the API sends it
  [loading]="loading()"
  [error]="error() && { kind: error().kind, message: error().message }"   // ApiError satisfies ListFrameError
  (pageChange)="load($event)"                // → pageQuery(n, size)
  (retry)="reload()"
>
  <ng-template ofListRow let-item>…</ng-template>
</of-list-frame>
```

`kind` is the editor's `ApiErrorKind`: `unauthorized` shows the no-access state, `unavailable`,
`network` and `unknown` an error with retry, `not-found` and `invalid` an error without retry.

## Smooth UI

Every screen loads and changes calmly, as the content browser does. Use these pieces (in
`src/lib/smooth/`, `of-side-panel` among them, plus `of-skeleton-rows` and `of-collapse`) instead of writing the classes
by hand:

| Pattern                                                                                                                                                                                                                                                                                           | How                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **First load only: a delayed skeleton.** Placeholders appear after 150 ms and fade in (300 ms), so a quick answer never flashes them.                                                                                                                                                             | `of-skeleton-rows` does this by default. Any other placeholder: `ofFadeIn="delayed"` on its wrapper (never on an element with its own `animate-*` class, such as `animate-pulse`: that animation would win).                                                                                                                               |
| **A reload keeps the content, dimmed.** No skeleton, no jump: the last answer stays in place at 60 % (300 ms ease-out), `inert` and `aria-busy`, until the new one replaces it. Controls around it (pagination) stay in place, disabled.                                                          | `[ofRefreshing]="loading() && items().length > 0"` on the region.                                                                                                                                                                                                                                                                          |
| **New content fades in** (300 ms) instead of popping in.                                                                                                                                                                                                                                          | `ofFadeIn` on what an `@if`/`@for` adds (the rows that replace a skeleton).                                                                                                                                                                                                                                                                |
| **Route changes fade the page in** (200 ms ease-out, opacity only).                                                                                                                                                                                                                               | `<router-outlet ofRouteFade />` (the rule is in `ui.css`).                                                                                                                                                                                                                                                                                 |
| **Expand and collapse** grow and shrink smoothly (200 ms ease-out).                                                                                                                                                                                                                               | `<of-collapse [open]="…">`.                                                                                                                                                                                                                                                                                                                |
| **A side panel beside a list** (an item's details) opens and closes by growing and shrinking its width (250 ms) while the list narrows with it; the last item stays, inert, until it has shrunk; another item swaps in place with a crossfade (180 ms); focus moves in on open and back on close. | `<of-side-panel>` with `<ng-template [ofSidePanelContent]="selected()" let-item>`; size it with `--of-side-panel-width`, `--of-side-panel-gap` (the parent's gap) and `--of-side-panel-closed-width` (`100%` where it stacks under the list).                                                                                              |
| **A panel opening in a column's place** (the module editor's preview over its details): the panel grows while the column shrinks, in the same frames, so the column between them changes width once; the column stays rendered (its tab and scroll kept), `inert` and hidden once collapsed.      | `ofCollapseWidth` on the column's wrapper, bound to the panel's `opened()`, with `[ofCollapseWidthInstant]="!panel.animates()"`; the column's open width a length class (`lg:w-80`), `--of-collapse-gap` the parent's gap. On the panel, `[takeFocus]="false"` leaves focus on a toggle and `fill` makes the content as tall as the panel. |
| **Items a filter adds or removes move, never pop.** A removed item fades out (150 ms), then the rest slide to close the gap (220 ms); an added one gets room, then fades in. Another page switches at once.                                                                                       | `of-list-frame` does it for its rows; a table or grid template adds `[ofListItem]="item"` to each row or tile, and the frame's `trackBy` names the key when items have no `id`.                                                                                                                                                            |
| **What comes and goes in a bar keeps its place** (Reset filters, Clear): hidden, it fades out and turns `invisible`, `inert` and `aria-hidden`, so the bar never wraps or moves what is below it; focus inside moves to the element before it.                                                    | `[ofReservedSlot]="hasFilters()"`. A filter bar also gives its search its own column (`sm:flex-row`, the filters `flex-1 flex-wrap`), so the filters' row never wraps into it.                                                                                                                                                             |
| **No layout shift.** A placeholder takes the space of what replaces it (`tall`, `header`, `count`); a reload keeps the old content's size; nothing animates position or size except a collapse, a side panel, a column giving way to one and a list's items moving.                               |                                                                                                                                                                                                                                                                                                                                            |
| **Reduced motion.** Every animation and transition has its `motion-reduce:` variant: fades and transitions are instant, a delayed placeholder still waits its 150 ms (so it still never flashes).                                                                                                 | Built into the pieces above; add `motion-reduce:` to any class of your own.                                                                                                                                                                                                                                                                |
| **Hover and selection** match the design's radii: the highlight has the radius of the shape the design draws (a table clips hovered and selected rows to `--radius`; nav items, folders and options are `rounded-md`), never a square band inside a rounded card.                                 |                                                                                                                                                                                                                                                                                                                                            |

Small motions of our own use tw-animate-css classes (`animate-in fade-in-0 zoom-in-95 duration-200`)
with `motion-reduce:animate-none`. `of-list-frame` is built from these pieces; it is the
reference for a list.

## Internationalisation

Every text a person reads goes through [Transloco](https://jsverse.gitbook.io/transloco): one
build serves every language, each language's texts are JSON files loaded when it is chosen, and
the switch changes every text at once, with no reload. English is the source and the fallback;
German ships with it. This is the interface language, separate from the content languages of
manuals and modules (PDF labels follow the manual's language: `packages/render-typst`).

- **Scopes.** This library's texts are the `ui` scope (`src/i18n/<language>.json`, keys
  `ui.…`), so it works on its own; an app has its own scope (the editor: `editor.…` in
  `frontend/editor/src/i18n/`). One language's files are loaded together and served at
  `i18n/<scope>/<language>.json` (the app's `project.json` copies them as assets).
- **Setup.** `provideI18n({ scopes: ['editor'] })` in the app's providers: Transloco, ICU
  messages (`@jsverse/transloco-messageformat`), the loader, and an app initializer that loads
  the starting language before the first render. `LanguageService` (`active`, `locale`,
  `languages`, `choose()`) picks the remembered choice (`localStorage`, `of-language`; a user
  profile once there is one), else the browser's language if we ship it, else English; it sets
  `<html lang>`. `of-language-choice` is the segmented picker (the showcase header); the
  account menu has the same choice under the theme. Tests: `provideI18nTesting({ en: { ui } })`,
  which every spec gets through the project's `providersFile` (`testing/test-providers.ts`).
- **In templates:** `{{ 'ui.listFrame.next' | transloco }}`,
  `[attr.aria-label]="'ui.dialog.close' | transloco"`, parameters as
  `'ui.listFrame.pageOf' | transloco: { page, last, total }`. A component whose text an app may
  replace takes an input that defaults to `''` and shows `label() || ('ui.…' | transloco)`.
- **In code:** `injectTranslate()` gives `t(key, params)`; call it in a `computed` and the value
  follows a language switch. A text made in code and shown later (a toast, a blocked reason) is a
  key, not a translated string: `toast.success(translated('editor.….saved', { name }))`, shown with
  the `ofText` pipe, so an open toast changes language too. Nav labels and route titles are keys
  (the editor's `TranslatedTitleStrategy` sets the document title).
- **Keys are written out in full** (`'ui.badges.status.draft'`, never `'ui.badges.status.' + s`):
  a value-to-text map is a record of whole keys. The unused-key check finds keys by their literal.
- **Messages are ICU** (`{name}`, `{count, plural, one {# module} other {# modules}}`,
  `{total, number}`), never Transloco's `{{ }}`. A `'` before `{` quotes it; `#` in a plural is the
  number.
- **Dates, numbers, relative times** with `Intl` in the UI language: the `ofDate`, `ofNumber`
  and `ofRelativeTime` pipes (`relativeTime()` in code), or `{n, number}` in a message. Never
  build them by hand.
- **API errors** are translated by their stable `code` and the parameters in `meta`
  (`apiErrorText()` in the editor); the API's `title` and `detail` stay English for developers and
  logs, and no UI code reads `detail`.
- **Layout:** logical properties only (`ps-`/`pe-`/`start`/`end`), so a right-to-left language
  needs no layout change. Texts wrap (`break-words`); nothing assumes the English length.

### Guard rails

- `openfolia/no-literal-text` (`eslint-rules/`, used by this library and the editor): no literal text
  in templates, in text attributes (`aria-label`, `title`, `placeholder`, `zTooltip`, `label`, …)
  or as a string literal shown as text. Text without letters passes; `allow` lists exceptions.
  Its tests run with `nx lint ui`.
- `tools/i18n.test.mjs` (here and in the editor, run before `nx test`): every language has the
  source's keys and no others, each message is valid ICU with the same arguments as English,
  every key is used and every key the code uses exists; the editor's also checks that each error
  text names a code the API sends.
- **The pseudo-locale** `en-XA` (development builds, last in the picker): English with accents,
  padded by about a third and framed in `⟦ ⟧`. A text that stays plain English does not go
  through a translation; a cut-off frame shows an overflow.

### Adding a UI language

1. Copy `src/i18n/en.json` here and `src/i18n/en.json` of each app to `<id>.json` (a BCP 47 tag)
   and translate the values, keeping every key, argument name and ICU structure.
2. Add `{ id, label }` to `UI_LANGUAGES` (`src/lib/i18n/languages.ts`), the label in the
   language itself ("Français").
3. `nx test ui` and `nx test editor` tell you about a missing key or a changed argument. Check the
   screens at phone width: a longer language must wrap, never overflow.

### German glossary

Natural, concise UI German in the "Sie" form ("Geben Sie … ein", "Ihr Konto"; never "du",
"dein", "dich", "dir" or a "du" imperative), with the terms common in software. One word per
term: the word the main screen for that thing uses. New texts follow this table; the editor's
`tools/i18n.test.mjs` refuses the words in the last column (all but "Attribut" and "Freigabe",
which name other things too: a text attribute, an approval) and the "du" pronouns in its
`de.json`, with exceptions only in its `REJECTED_ALLOWED`, each with a reason.

| English               | German                                        | Not                         |
| --------------------- | --------------------------------------------- | --------------------------- |
| revision              | Überarbeitung                                 |                             |
| product version       | Produktversion                                |                             |
| module                | Modul                                         |                             |
| manual                | Anleitung                                     |                             |
| variant               | Variante                                      |                             |
| variant attribute     | Variantenmerkmal (short: Merkmal)             | Variantenattribut, Attribut |
| text attribute        | Textattribut                                  |                             |
| block                 | Block                                         |                             |
| review                | Prüfung                                       |                             |
| sign-off, sign off    | Abzeichnung, abzeichnen                       | Abnahme, abnehmen, Freigabe |
| release (noun)        | Veröffentlichung                              | Release                     |
| approved              | Freigegeben                                   |                             |
| released              | Veröffentlicht                                |                             |
| save point            | Speicherpunkt                                 | Sicherungspunkt             |
| unsaved               | ungespeichert                                 | ungesichert                 |
| callout (on an image) | Positionsnummer                               | Callout, Bildmarkierung     |
| translation           | Übersetzung                                   |                             |
| role, permission      | Rolle, Berechtigung                           |                             |
| lock                  | Sperre                                        |                             |
| draft                 | Entwurf                                       |                             |
| theme                 | Darstellung                                   |                             |
| admin (section)       | Verwaltung                                    |                             |
| sidebar               | Seitenleiste                                  |                             |
| toast                 | Benachrichtigung                              |                             |
| Undo                  | Rückgängig                                    |                             |
| Try again             | Erneut versuchen                              |                             |
| Nothing here yet      | Noch nichts vorhanden                         |                             |
| an administrator      | eine Administratorin oder einen Administrator |                             |

## Component showcase

A showcase **route**, not Storybook: `ShowcasePage` renders every component in its variants on
one page, and an app mounts it (the editor serves it at `/showcase` in development builds, not in production). It was chosen because it
adds no dependency and no extra build, it is compiled, type-checked and linted with the app
that mounts it, and it needs no browser to build or test. Storybook would add a second bundler
and a few hundred packages to a monorepo that runs the whole check on every PR. Add a section
to `showcase.page.ts` with each new component. `base-showcase.component.ts` holds table, input, textarea, code editor, select, checkbox, radio group, switch, dialog, alert dialog, sheet, command (inline and as a palette in a dialog), popover, tooltip and dropdown menu in every state; the overlays open from buttons. Screen 20 is `states-showcase.component.ts`:
the six cards of the design (empty, loading, error, no access, save status, toasts), then a
switch that puts the list frame in each state (rows, 1,000 rows, loading, empty, error, no access).

## Nx targets

`test` (Angular's unit-test builder on Vitest in jsdom: no browser to download; first
`test-i18n`, the translation checks), `lint` (angular-eslint; first `test-lint-rules`), `typecheck` (`ngc` for the library, `tsc` for the specs), `build` (ng-packagr).
The editor compiles this library from source through TypeScript paths (`@openfolia/ui/<folder>`); the
library is not published, so `build` (ng-packagr) is the check that it packages cleanly, and
`ui.css` is used from source.

A spec never waits a fixed stretch of real time for something a timer does (#543). An overlay,
a menu or a tooltip opens and closes on a timer that change detection sets, and change detection
itself runs on a timer, so on a busy machine a fixed `await wait(60)` can end before that timer
is even set. Such a spec runs on fake time (`vi.useFakeTimers()`, then
`vi.advanceTimersByTimeAsync(ms)` and `TestBed.tick()`, as `base-components.spec.ts` and
`shell.spec.ts` do): the fake clock runs every timer due in the step, in order, however slow the
machine is.
