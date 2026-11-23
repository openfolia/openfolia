# `frontend/theme` (`@openfolia/theme`)

The design tokens and assets every frontend shares. **CSS and assets only**: no framework, no
JavaScript, no Tailwind syntax. A portal (a static site) can use it as readily as the editor.

## What belongs here

- `src/theme.css`: `@font-face` rules and the design tokens as plain CSS custom properties
  (`--background`, `--primary`, `--radius`, `--font-sans`, …) with Zard UI's token names, plus
  `--success`, `--warning`, `--info`, `--destructive` (each with `-muted`), the `--sidebar-*` set
  and the four **fixed** `--safety-*` colours (ISO 3864 / ANSI Z535: a rebrand does not change
  them and `.dark` does not redefine them). `.dark` holds the dark values; `:root` and `.light`
  the light ones (`.light` scopes them under a dark page, as screen 0's light panel does).
  Changing this file alone restyles every screen: it is the only place a colour is written.
- **The default brand's palette** (OpenFolia, the palette of the product's website):
  - light: the working area, cards and menus on paper `#fffdfb`, Iron Grey `#394648` text, muted
    text `#5a6467`, lines `#e6e2dc`, hover and selection in the highlight `#eef4eb`, tab bars and
    table heads in a warm grey `#f3efeb`; the sidebar in Lavender Blush `#f8e9e9` with its line
    `#e6cfcb` and the selected item on paper;
  - dark: the page `#1e2628`, cards and menus `#252f31`, the sidebar on the deepest surface
    `#151b1c` (lines `#283133`), text `#eef0ec`, muted text `#a9b4b2`, lines `#384548` (fields `#46555a`), hover
    and selection `#2e3a3c`;
  - the accent (`--primary`, `--ring`, `--sidebar-primary`, `--sidebar-ring`): the UI green
    `#4a7740` in light (5.2:1 on paper, with white text; 4.45:1 on Lavender Blush, so not for
    text there) and the dark green `#8fc07f` in dark, with `#12200f` text on it (8.1:1). Buttons,
    links, the focus ring, the selected nav item's icon and the PDF's accents (the title rule,
    step circles, links) take it from these tokens;
  - the brand's other colours (Sage Green `#69995d`, Tan `#cbac88`) are in the artwork only:
    Sage Green is 3.3:1 on white, not for text. Status (`--success`, `--warning`,
    `--destructive`, `--info`), safety and diff colours are not brand colours and do not change
    with it.
- `src/brand/`: the default brand's assets, the owner's outlined masters as delivered (not
  redrawn or re-exported), with only their provenance metadata (content credentials: an SVG's
  `<metadata>`, a PNG's `caBX` chunk) removed, the paths, colours and pixels unchanged
  (`tests/brand.test.ts` refuses a file that carries it again): the mark and the horizontal lockup, each as `color-light` (for light
  backgrounds) and `color-dark` (for dark ones); the app icon set: `favicon.svg` (the app icon, an
  Iron Grey rounded square that reads on a light and a dark tab bar), `favicon-16.png`,
  `favicon-32.png`, `favicon.ico` (16, 32, 48 px), `apple-touch-icon-180.png` and `icon-192.png`/
  `icon-512.png` for the editor's web manifest. The editor serves them at
  `assets/brand/` (and `favicon.ico` at its root); the PDF's title page shows the light mark. An
  installation's branding replaces them in Admin → Branding (the editor, #169; the defaults are in `frontend/editor/src/docs.config.ts`)
  and, for PDFs, in the document's `logo` (`@openfolia/render-typst`).
- `src/brand/` is only for what the product uses; the rest of the brand kit (stacked lockups,
  mono and white versions, print PDFs) stays with the owner.
- `src/fonts/`: Geist and Geist Mono (variable WOFF2, SIL Open Font License, see `LICENSE.txt`),
  bundled in the repository and served by the app that imports the theme: never loaded from a
  third-party CDN.
- `src/fonts/ttf/`: the same fonts as static TTF for print (Typst cannot read WOFF2): Geist
  Regular, Italic, Medium, SemiBold and Bold (each with its italic), Geist Mono Regular and Bold,
  with their licence (`LICENSE.txt`). From the upstream release v1.9.2 (the OFL release of the
  Geist font project), the release the WOFF2 files come from. `@openfolia/render-typst` loads them and
  turns the light tokens of `theme.css` into `tokens.typ` for its PDF template.
- Noto Sans Arabic and Noto Sans Hebrew (SIL Open Font License, `LICENSE-Noto.txt`), for
  right-to-left languages (#458): variable WOFF2 in `src/fonts/` (each `@font-face` limited to
  its script by `unicode-range`, so a page without Arabic or Hebrew text loads neither), and
  Regular, Medium, SemiBold and Bold as static TTF in `src/fonts/ttf/` for print. They follow
  Geist in `--font-sans`, so Latin text keeps Geist.

## What does not belong here

Components, Angular or Tailwind code (the mapping from these variables to Tailwind utilities is
in `frontend/ui/src/styles/ui.css`), screens.

## Use

```css
@import '@openfolia/theme/theme.css';
```

Fonts are reachable as `@openfolia/theme/fonts/*`, the brand's assets as `@openfolia/theme/brand/*`. Nx targets: `test` (vitest: the CSS stays plain,
every referenced font file exists and is local), `lint`, `typecheck`, `build` (copies `src/` to
`dist/`).

Tests also keep the token list on screen 0 (`frontend/editor`) and the Tailwind mapping in
`frontend/ui/src/styles/ui.css` in step with this file, hold text/background pairs at 4.5:1 and
the accent as a shape or outline (a button's fill, the focus ring, the selected nav item's icon)
at 3:1 against the surfaces it sits on, in light and dark (`tests/tokens.test.ts`), keep the
brand's assets self-contained (no script, no external reference: `tests/brand.test.ts`), and
fail when a `.ts`, `.html` or `.css` file in `frontend/ui` or `frontend/editor` hard-codes a colour
(hex, `rgb()`/`oklch()`/…, Tailwind palette classes). Allow-list: spec files, image assets, and the
`ALLOWED` map in `tests/no-hardcoded-colors.test.ts` (empty, each entry needs a reason).
