# portal

The static portal: released manuals for one audience, a site per language, that readers browse
and search without the API. Built with [Astro](https://astro.build) (static output) from the
API at build time with a service token, the manuals rendered by `@openfolia/render-html`, searched
with [Pagefind](https://pagefind.app). Hosting and any sign-in in front of a non-public portal
are not part of it: the output is plain files for any static host.

## Building a portal

```sh
CCMS_PORTAL_API_URL=https://docs-api.example.com \
CCMS_PORTAL_TOKEN=ccms_sat_… \
CCMS_PORTAL_AUDIENCE=public \
pnpm nx run portal:site
```

The settings are read from the environment (`.env.example`, "Portal"): the API, the token, the
audience, and optionally the languages, the releases (default: each product's newest release
that is not withdrawn), the output folder (default `frontend/portal/dist`) and the path the
site is served under. The output holds `<lang>/` per language and an `index.html` that sends
the reader to the first. It replaces the output folder only once every language is built, and
puts the previous one back when the new one cannot be moved in.

## The audience

One build serves one audience level (`audiences` in `openfolia.yaml`, least restricted first), and
nothing above it reaches the files:

- **The token.** Before fetching any content the build reads `GET /me` (after the releases and
  their configuration, which every reader may read) and refuses a token whose
  roles hold anything but `content.read`, read more than the audience (a `maxAudience` above it,
  or none: every level), or that is not a service account's.
- **The content, again.** Every manual's audience (none counts as the most restricted level) and
  every module a resolved manual holds, including what a module reference brought in, are
  checked against the audience; a module whose audience the token cannot list is refused too.
  The modules are read from the manual's own structure (each block's ID names its module), not
  only from the API's `origins`, and a block whose ID names none refuses the build. The pages
  check the snapshot a third time when they read it, counting the modules again.
- **Refusing** stops the build with a message that names the manual, module or role, and the
  output folder is left as it was.

## The token

Only in the `Authorization` header of requests to the API (redirects refused, http only to this
machine). Never in an error message, the log, the snapshot the pages are built from, or the
pages' environment (Astro runs in a child process without it). Before the output is put in
place, every file is searched for the token and its secret, and the build fails on a match.

## What is in the site

- **Pages** (`src/pages/`): a start page that leads with search and lists each product's
  manuals; the list of all manuals (`manuals/`, `?product=` preselects one) with filters for
  product, the variant attributes and the title, paged, scrolling inside its own frame; a page
  per release, manual, variant and language; search (`search/?q=`); a 404 that offers search.
  The pages switch between English and German texts by the site's language, and between light
  and dark.
- **The look** (#784, "Reference book", `src/styles/portal.css`): a running head with the
  manual's guide words, a thumb index of the products down the page's edge (a menu on narrow
  screens; the column scrolls past a dozen products), the manual set in Literata at a book's
  measure, the rest in Geist, colours only from `@openfolia/theme`'s tokens. On the manual page
  the contents mark the section in view, and a switch per variant attribute opens the same
  manual in another variant (`src/lib/variant-switch.ts`). When that exact combination is not
  published, the option leads to the published variant that keeps the most values and says what
  else changes ("only as Electric"); the page it opens names the change in a notice it reads
  from the link's query and drops from the address (#844). Pages change with the browser's View
  Transitions (the head, the thumb index and the contents stay; the page cross-fades, both
  pages at once, so it never dips through a blank page); none of the motion plays under
  reduced motion. Literata is bundled (`src/fonts/`, SIL Open Font License), never loaded from
  a font service. A print stylesheet prints the manual alone.
- **Branding** (`CCMS_PORTAL_BRANDING`, on by default): the build reads the API's public
  `GET /branding` and puts the organisation's name, logos (light and dark), favicon and colours
  on every page; its images are checked against their hash and kept only when they are PNG or
  WebP, the name only without control characters, the colours (`brand.css`, only the tokens a
  brand may set) only when every contrast check the API made passes. With it off, or nothing
  set, or an API without branding, the site has OpenFolia's default look. Safety colours never
  change with a brand.
- **PDFs**: each manual page links its variant's PDF of the release in the site's language when
  the release has one (`GET /releases/:id/outputs`), copied into the site after checking its
  hash and that it is a PDF; a PDF whose audience is above the build's refuses the build, an
  API that answers 404 or 403 for the outputs leaves the links out.
- **Manual HTML** is `@openfolia/render-html` output only (escaped by construction; its property test
  is `packages/render-html/src/lib/xss.spec.ts`), inserted with `set:html` from the snapshot the
  build wrote. No markup from the API is inserted as such.
- **Images and attachments** are written by their SHA-256 after checking the bytes match it;
  bytes that do not fail the build (the content changed under it, or the store is corrupt).
  Raster images are kept; an SVG is drawn to a PNG (one that names an outside resource or
  declares entities is left out, its alternative text shown), so no file can run script. An
  attachment keeps a plain extension (pdf, zip, json, csv, txt) only when its bytes are that
  type, otherwise `.bin`, and its link then downloads it as `<name>.bin`. Each file is fetched
  once per build (a refused one too) and written to a staging folder as it arrives, so a build
  holds no files in memory; each language's site gets the files its pages link.
- **Scripts** are files, never inline: each page carries a Content Security Policy without
  `'unsafe-inline'` for scripts. In the browser the manual page loads `@openfolia/render-html/browser`
  (term popovers, callout highlighting), not the renderer.
- **Search** is Pagefind's index of the manual pages (`data-pagefind-body`), with product and
  variant attribute filters, built per language. Results group a manual's variants and show its
  matching sections (every heading carries an ID, `@openfolia/render-html`), a few per page; the
  passages are built as text and `mark` nodes, never as markup.
- **Typeahead** (#845, `src/scripts/typeahead.ts`): the running head's and the start page's
  search fields (any `form[data-typeahead]`) show up to six passages from two characters on,
  and a last row leading to the search page, as an ARIA combobox with a list popup. It shares
  the index loading and the excerpt building with the search page (`src/scripts/pagefind.ts`).
  Without script, or when the index cannot load, the fields submit to the search page. The
  hidden filter and meta values of a manual page are read by Pagefind but not indexed as text.

## Hosting

The output is plain files: any static file server or host serves them, each language at
`<basePath><lang>/`, a folder answering with its `index.html` and a missing path with the
language's `404.html`. Every page carries its Content Security Policy as a meta tag, so the
files are safe on any host. A meta tag cannot say everything, though, so the host must send
these headers on every response:

| Header                      | Value                             | Why                                                                                            |
| --------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`   | the policy below                  | the pages' own policy plus `frame-ancestors`, which browsers ignore in a meta tag              |
| `X-Content-Type-Options`    | `nosniff`                         | a file is only ever what its type says: an attachment written as `.bin` is never run as a page |
| `Referrer-Policy`           | `strict-origin-when-cross-origin` | as the pages' meta tag, for the files that are not pages                                       |
| `Strict-Transport-Security` | `max-age=31536000` (over HTTPS)   | readers always come back over HTTPS                                                            |

The policy (`src/lib/csp.ts`, `HOST_CSP`; a test keeps this copy and `deploy/README.md`'s equal
to it):

```text
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

On the attachments written as `.bin` (`<lang>/assets/*.bin`), send `Content-Type:
application/octet-stream` and `Content-Disposition: attachment` too: not every server knows the
extension (some send no type at all for it). `deploy/README.md`, "The static portal", has
examples for nginx and Caddy.

## Layout

| Path               | What                                                                           |
| ------------------ | ------------------------------------------------------------------------------ |
| `build/`           | the build in Node: settings, the API client, the audience checks, assets       |
| `scripts/build.ts` | the command (`portal:site`)                                                    |
| `src/`             | the Astro site, built from `snapshot.json` (`src/lib/snapshot.ts`)             |
| `public/theme.js`  | light and dark mode before the page paints                                     |
| `testing/`         | the fixture repository, API and brand: public, internal and restricted content |
| `tests/`           | Vitest: settings, client, audience, assets, fetch, the build against the API   |
| `e2e/`             | Playwright over the built fixture sites: leaks, search, behaviour, axe         |

## Targets

- `portal:build` builds the fixture sites into `dist-fixture/` (a public build in English and
  German with the branding off, an internal one in English with the fixture's brand) from the
  API booted in process over `testing/`.
- `portal:e2e` checks them: no internal or restricted text in the public files or its search
  index, no token anywhere, no inline script, the pages in a browser at desktop and phone width
  in light and dark, and WCAG 2.1 AA with axe on every kind of page in both languages.
- `portal:test`, `portal:lint`, `portal:typecheck` (`astro check` and `tsc`).
