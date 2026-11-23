/**
 * Page designs in print (#391): the layout presets as Typst templates, built on the default
 * template's block styles, and the design's settings as data.
 *
 * - The settings (`designData`) reach the template as JSON in `sys.inputs` (`"openfolia-design"`),
 *   which Typst parses with `json()`: values, never code. Every value is checked here first
 *   (colours, numbers, link addresses, file paths), so even a design that skipped validation
 *   cannot become markup.
 * - The design's texts (regions, running header and footer) are content: `renderTypst` writes
 *   them into the generated document with the block rendering every module uses (string
 *   literals only) and hands them over in the Typst state `"openfolia-design"`.
 * - The layout reports what did not fit as `metadata` labelled `<openfolia-warning>`, which the
 *   compiler reads back (`LayoutWarning`): a region clipped to its slot, a running head
 *   truncated.
 */
import {
  COLOUR_PATTERN,
  isLinkHref,
  TYPE_SCALE,
  type ResolvedPageDesign,
  type TypeScaleStep,
} from '@openfolia/content-model';
import { DEFAULT_TEMPLATE } from './template.js';
import { str } from './typst-string.js';

/** Where the default template is, for the design layer to build on (the compiler's own file). */
export const DEFAULT_TEMPLATE_PATH = 'openfolia/default.typ';
/** The design layer the presets import (the compiler's own file). */
export const DESIGN_LAYER_PATH = 'openfolia/design.typ';
/** The `sys.inputs` key the design's settings arrive under, as JSON. */
export const DESIGN_INPUT = 'openfolia-design';

/**
 * The family a design's font for `role` is loaded as (`RenderResult.fonts`), so the document
 * finds it whatever family the file names itself (#555).
 */
export const designFontFamily = (role: 'body' | 'heading'): string =>
  `openfolia-${role}-font`;
/**
 * The `sys.inputs` key a designed manual's back-cover QR code arrives under (#450), as JSON
 * `{ path, url }`: the design's back page prints it.
 */
export const QR_INPUT = 'openfolia-qr';
/**
 * The state the design layer sets once its back page has printed that code: the document's own
 * QR page follows only when nothing did (a repository's template that ignores `QR_INPUT`).
 */
export const QR_PRINTED = 'openfolia-qr-printed';

/**
 * What the layout reports: a region clipped to its slot, a running head truncated, a callout
 * legend beside its image cut off at the image's height (#548, `at`
 * `callouts.<module>.<image>.<callout>`), a safety message taller than a page that a page
 * design breaks across pages (#668, `at` `safety.<module>.<block>`, `text` its hazard).
 */
export const LAYOUT_WARNING_CODES = [
  'page-design-overflow',
  'running-head-truncated',
  'callout-label-overflow',
  'safety-message-split',
] as const;

/**
 * The label the generated document marks each safety message with, just before it, when it has
 * a page design (#668): `metadata` holding `safety.<module>.<block>`, where the design layer
 * reports one it has to break across pages.
 */
export const SAFETY_AT_LABEL = 'openfolia-safety-at';
export type LayoutWarningCode = (typeof LAYOUT_WARNING_CODES)[number];

/**
 * Something the page design's layout could not fit, once per code and place: where in the
 * design (`regions.footer`, `header.default.right`), the first page it happened on, on how many
 * pages, and the text that did not fit (a running head's; none for a region).
 */
export interface LayoutWarning {
  code: LayoutWarningCode;
  at: string;
  page: number;
  pages: number;
  text?: string;
}

/** The longest `at` and `text` a warning keeps: what a template reports is not trusted. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;
const MAX_WARNING_TEXT = 500;
/** How many reported values are read, and how many distinct warnings kept, at most. */
const MAX_WARNING_VALUES = 1000;
export const MAX_LAYOUT_WARNINGS = 50;
/**
 * Where in a design: a dotted path of lowercase words (`header.default.left`, `regions.footer`);
 * a callout's (#548) holds a module ID and two block IDs, which may hold `_`.
 */
const DESIGN_PATH = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;
/** A callout's place (#548): `callouts.<module ID>.<image block ID>.<callout ID>`. */
const CALLOUT_PATH =
  /^callouts\.[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z_][a-z0-9_-]*\.[a-z_][a-z0-9_-]*$/;
/** A safety message's place (#668): `safety.<module ID>.<block ID>`. */
const SAFETY_PATH = /^safety\.[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z_][a-z0-9_-]*$/;
/** Which warnings count apart toward `MAX_LAYOUT_WARNINGS`, so many of one never crowd out another. */
const family = (code: unknown): string =>
  code === 'callout-label-overflow'
    ? 'callout'
    : code === 'safety-message-split'
      ? 'safety'
      : 'design';

/**
 * The warnings a compiled document reported (the `<openfolia-warning>` metadata's values), checked
 * and merged: one per code and place, the first page and the count kept, at most
 * `MAX_LAYOUT_WARNINGS` of the page design's and as many callouts' (#548). Anything else a
 * template labels so is dropped, a callout's at any other place than a callout's too.
 */
export function layoutWarnings(values: unknown): LayoutWarning[] {
  if (!Array.isArray(values)) return [];
  const byKey = new Map<string, LayoutWarning>();
  for (const value of values.slice(0, MAX_WARNING_VALUES)) {
    if (typeof value !== 'object' || value === null) continue;
    const { code, at, page, text } = value as Record<string, unknown>;
    if (
      !LAYOUT_WARNING_CODES.includes(code as LayoutWarningCode) ||
      typeof at !== 'string' ||
      at.length === 0 ||
      at.length > MAX_WARNING_TEXT ||
      !DESIGN_PATH.test(at) ||
      (code === 'callout-label-overflow') !== CALLOUT_PATH.test(at) ||
      (code === 'safety-message-split') !== SAFETY_PATH.test(at) ||
      !Number.isSafeInteger(page) ||
      (page as number) < 1
    ) {
      continue;
    }
    const key = `${code as string}|${at}`;
    const seen = byKey.get(key);
    if (seen) {
      seen.pages++;
      seen.page = Math.min(seen.page, page as number);
      continue;
    }
    // Callout legends cut off, safety messages split and the page design's own count apart.
    const kept = [...byKey.values()].filter(
      (w) => family(w.code) === family(code),
    ).length;
    if (kept >= MAX_LAYOUT_WARNINGS) continue;
    // Text for logs and checks: no control characters.
    const shown =
      typeof text === 'string'
        ? text.replace(CONTROL_CHARACTERS, ' ').slice(0, MAX_WARNING_TEXT)
        : '';
    byKey.set(key, {
      code: code as LayoutWarningCode,
      at,
      page: page as number,
      pages: 1,
      ...(shown.trim() !== '' && { text: shown }),
    });
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.page - b.page ||
      a.code.localeCompare(b.code) ||
      a.at.localeCompare(b.at),
  );
}

/** The built-in design's colours, for a colour that is no `#rrggbb` (validation reports it). */
const FALLBACK_COLOURS = {
  primary: '#1f4e79',
  accent: '#2563eb',
  text: '#1f2328',
};

/** A number within bounds; `fallback` for anything else. */
function within(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : fallback;
}

/** One of `allowed`, else the first. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  return allowed.includes(value as T) ? (value as T) : (allowed[0] as T);
}

/** A colour as `#rrggbb`, else the fallback. */
function colour(value: unknown, fallback: string): string {
  return typeof value === 'string' && COLOUR_PATTERN.test(value)
    ? value
    : fallback;
}

/** A single line of text (no control characters), or null. */
function line(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ');
}

/** `list`, else `fallback` when it is empty. */
function nonEmpty<T>(list: T[], fallback: T[]): T[] {
  return list.length > 0 ? list : fallback;
}

/** The step's multiple of the body text size; an unknown step the body size. */
function scale(step: TypeScaleStep): number {
  return Object.hasOwn(TYPE_SCALE, step) ? TYPE_SCALE[step] : 1;
}

/** An absolute path in the workspace for the template's `image()`, from `assetPath`. */
function rooted(path: string): string {
  return `/${path.replace(/^\/+/, '')}`;
}

/** What `designData` needs besides the design: the files' paths, as `renderTypst` names them. */
export interface DesignPaths {
  assetPath: (asset: string) => string;
}

/**
 * The design's settings as plain data for the template (`sys.inputs`, JSON): only checked
 * values (colours `#rrggbb`, numbers in their ranges, options from their lists, link
 * addresses the model allows, file paths from `assetPath`); texts are strings, never markup.
 * `hasBackRegions` says the back page has region text (the content comes as a state).
 */
export function designData(
  design: ResolvedPageDesign,
  paths: DesignPaths,
  hasBackRegions: boolean,
): Record<string, unknown> {
  const margins = design.page.margins;
  const manufacturer = design.backPage?.manufacturer;
  const logoAlt = manufacturer ? line(manufacturer.name) : null;
  return {
    preset: oneOf(design.preset, ['classic', 'image-led', 'minimal']),
    paper: oneOf(design.page.size, ['a4', 'us-letter', 'a5']),
    margins: {
      top: within(margins.top, 0, 100, 26),
      right: within(margins.right, 0, 100, 22),
      bottom: within(margins.bottom, 0, 100, 24),
      left: within(margins.left, 0, 100, 22),
    },
    'double-sided': design.page.doubleSided === true,
    colours: {
      primary: colour(design.colours.primary, FALLBACK_COLOURS.primary),
      accent: colour(design.colours.accent, FALLBACK_COLOURS.accent),
      text: colour(design.colours.text, FALLBACK_COLOURS.text),
    },
    fonts: {
      body: design.fonts.body ? designFontFamily('body') : null,
      heading: design.fonts.heading ? designFontFamily('heading') : null,
    },
    logo: design.logo ? rooted(paths.assetPath(design.logo.light)) : null,
    'logo-dark': design.logo?.dark
      ? rooted(paths.assetPath(design.logo.dark))
      : null,
    'logo-alt': logoAlt,
    cover: design.coverImage
      ? {
          path: rooted(paths.assetPath(design.coverImage.asset)),
          alt: line(design.coverImage.alt),
        }
      : null,
    'title-fields': design.titlePage.fields
      .filter((f) => f.field !== 'title')
      .map((f) => ({ value: line(f.value) ?? '' }))
      .filter((f) => f.value !== ''),
    'back-page': design.backPage
      ? {
          position: oneOf(design.backPage.position, ['last', 'inside-cover']),
          manufacturer: manufacturer
            ? {
                name: line(manufacturer.name) ?? '',
                address: manufacturer.address
                  .map(line)
                  .filter((l): l is string => l !== null),
                contact: line(manufacturer.contact),
                website:
                  manufacturer.website !== undefined &&
                  isLinkHref(manufacturer.website)
                    ? manufacturer.website
                    : null,
              }
            : null,
          copyright: line(design.backPage.copyright),
          'document-number': line(design.backPage.documentNumber),
          date: line(design.backPage.date),
        }
      : null,
    'back-regions': hasBackRegions,
    headings: {
      numbering: nonEmpty(
        design.headings.numbering.map((n) => oneOf(n, ['decimal', 'none'])),
        ['decimal'],
      ),
      sizes: nonEmpty(design.headings.sizes.map(scale), [2, 1.5, 1.25, 1]),
      colour: colour(
        design.colours[
          oneOf(design.headings.colour, ['text', 'primary', 'accent'])
        ],
        FALLBACK_COLOURS.text,
      ),
      'page-break-before-level1':
        design.headings.pageBreakBeforeLevel1 !== false,
    },
    body: {
      'font-size': within(design.body.fontSize, 6, 24, 10),
      'line-height': within(design.body.lineHeight, 1, 3, 1.45),
      'paragraph-spacing': within(design.body.paragraphSpacing, 0, 36, 7),
      columns: design.body.columns === 2 ? 2 : 1,
    },
    tables: {
      'header-tint': design.tables.headerTint !== false,
      borders: oneOf(design.tables.borders, ['horizontal', 'none', 'grid']),
      zebra: design.tables.zebra === true,
    },
    steps: { marker: oneOf(design.steps.marker, ['filled-circle', 'number']) },
    notes: { style: oneOf(design.notes.style, ['tinted', 'framed']) },
    safety: {
      standard: oneOf(design.safety.standard, ['ansi-z535', 'iso-3864']),
    },
  };
}

/** The settings a design template falls back to when a document passes none (built-in values). */
const DEFAULT_DATA = {
  preset: 'classic',
  paper: 'a4',
  margins: { top: 26, right: 22, bottom: 24, left: 22 },
  'double-sided': false,
  colours: FALLBACK_COLOURS,
  fonts: { body: null, heading: null },
  logo: null,
  'logo-dark': null,
  'logo-alt': null,
  cover: null,
  'title-fields': [],
  'back-page': null,
  'back-regions': false,
  headings: {
    numbering: ['decimal'],
    sizes: [2, 1.5, 1.25, 1],
    colour: FALLBACK_COLOURS.text,
    'page-break-before-level1': true,
  },
  body: {
    'font-size': 10,
    'line-height': 1.45,
    'paragraph-spacing': 7,
    columns: 1,
  },
  tables: { 'header-tint': true, borders: 'horizontal', zebra: false },
  steps: { marker: 'filled-circle' },
  notes: { style: 'tinted' },
  safety: { standard: 'ansi-z535' },
};

/**
 * The design layer (`openfolia/design.typ`): the default template's block styles with the design's
 * settings applied (colours, fonts, headings, body, tables, steps, notes, the safety layout by
 * its standard), the running header and footer from the design's regions, the title page's
 * parts (fitting title, regions clipped to their slots) and the back page. A preset template
 * imports it and adds its title page.
 */
export const DESIGN_LAYER =
  String.raw`// The page design layer of @openfolia/render-typst (#391), over the default template's block styles.
// The design's settings arrive as JSON in sys.inputs (parsed, never evaluated); its texts as
// content in the state "openfolia-design" (regions, header, footer).
#import "/openfolia/default.typ": *
#import "/openfolia/default.typ" as base
#import "/tokens.typ": theme

#let design = json(bytes(sys.inputs.at("openfolia-design", default: DEFAULT_DATA)))
// The stable address's QR code for the back page (#450, delivery.pdfQrCode: back-cover); none.
#let back-qr = { let q = sys.inputs.at("openfolia-qr", default: none); if q == none { none } else { json(bytes(q)) } }

#let primary = rgb(design.colours.primary)
#let accent = rgb(design.colours.accent)
#let ink = rgb(design.colours.text)
#let muted-ink = color.mix((ink, 65%), (white, 35%))
#let tint = color.mix((primary, 12%), (white, 88%))
#let zebra-tint = color.mix((primary, 5%), (white, 95%))
#let font-list(family) = {
  let sans = if type(theme.font-sans) == array { theme.font-sans } else { (theme.font-sans,) }
  if family == none { sans } else { (family, ..sans) }
}
#let body-fonts = font-list(design.fonts.body)
#let heading-fonts = font-list(if design.fonts.heading != none { design.fonts.heading } else { design.fonts.body })

// A file path from the document (relative to the project root, where main.typ is) for image()
// here, in openfolia/: from the root.
#let rooted(path) = if path.starts-with("/") { path } else { "/" + path }

// The design's texts (regions, running header and footer), set by the generated document.
#let design-texts() = state("openfolia-design", (:)).final()

// What did not fit, for the compiler to read back (the render log and the checks).
#let layout-warning(code, at, text: none) = [#metadata((code: code, at: at, page: here().page(), text: text))<openfolia-warning>]

// The plain text of content, for truncating a running head.
#let plain-text(it) = {
  if it == none { "" }
  else if type(it) == str { it }
  else if type(it) != content { "" }
  else if it.has("text") { if type(it.text) == str { it.text } else { plain-text(it.text) } }
  else if it.has("children") { it.children.map(plain-text).join("") }
  else if it.has("body") { plain-text(it.body) }
  else if it.func() == linebreak or it == [ ] { " " }
  else { "" }
}

// One line of text in "width": shrunk down to "min-size", then cut with an ellipsis (reported).
// Call in context.
#let fit-line(body, plain, width, size: 7.5pt, min-size: 6pt, at: "") = {
  let fits(s, c) = measure(text(size: s, c)).width <= width
  let s = size
  while s > min-size and not fits(s, body) { s -= 0.25pt }
  if fits(s, body) { return text(size: s, body) }
  let clusters = plain.trim().clusters()
  let cut(n) = if n == 0 { "…" } else { clusters.slice(0, n).join("").trim() + "…" }
  let (lo, hi) = (0, clusters.len())
  while lo < hi {
    let mid = calc.quo(lo + hi + 1, 2)
    if fits(min-size, cut(mid)) { lo = mid } else { hi = mid - 1 }
  }
  layout-warning("running-head-truncated", at, text: plain)
  text(size: min-size, cut(lo))
}

// A page field of a running head: the page number, the page count, the chapter. Call in context.
#let page-field-text(key) = {
  if key == "page" { counter(page).display() }
  else if key == "page-count" { str(counter(page).final().first()) }
  else if key == "chapter" {
    let here-page = here().page()
    let chapters = query(heading.where(level: 1, outlined: true)).filter(h => h.location().page() <= here-page)
    if chapters.len() == 0 { "" } else { plain-text(chapters.last().body) }
  } else { "" }
}
#let page-field(key) = context page-field-text(key)

// A running header or footer ("header" or "footer") on this page: the first content page (where
// the body starts, after the title and contents pages) takes "first", even pages printed
// double-sided "even", any other "default".
#let running(where) = context {
  let page-no = here().page()
  let starts = query(<openfolia-body-start>)
  let body-page = if starts.len() == 0 { none } else { starts.first().location().page() }
  let region = design-texts().at(where, default: (:))
  let (kind, slots) = if page-no == body-page and "first" in region { ("first", region.first) }
    else if design.double-sided and calc.even(page-no) and "even" in region { ("even", region.even) }
    else { ("default", region.at("default", default: (:))) }
  let cell(place, alignment) = {
    let pieces = slots.at(place, default: none)
    if pieces == none { return [] }
    let parts = pieces.map(p => if type(p) == dictionary { page-field-text(p.field) } else { p })
    let body = parts.join()
    let plain = parts.map(plain-text).join("")
    layout(size => align(alignment, fit-line(body, plain, size.width, at: where + "." + kind + "." + place)))
  }
  let centre = "centre" in slots
  set text(fill: muted-ink, font: body-fonts)
  set par(justify: false)
  if slots.len() > 0 {
    block(width: 100%, inset: if where == "header" { (bottom: 5pt) } else { (top: 5pt) },
      stroke: if where == "header" { (bottom: 0.5pt + primary) } else { (top: 0.5pt + primary) },
      grid(columns: if centre { (1fr, 1fr, 1fr) } else { (1fr, 1fr) }, column-gutter: 1em,
        cell("left", start), ..if centre { (cell("centre", center),) }, cell("right", end)))
  }
}

// A region of the title or back page, at most "height" high: clipped (and reported) beyond it.
#let region(name, height, size: none) = context {
  let body = design-texts().at("regions", default: (:)).at(name, default: none)
  if body != none {
    // Lines from ascender to descender: clipping keeps every glyph whole.
    let shown = { set text(top-edge: "ascender", bottom-edge: "descender"); if size == none { body } else { text(size: size, body) } }
    layout(page-size => {
      let needed = measure(block(width: page-size.width, shown)).height
      if needed > height { layout-warning("page-design-overflow", "regions." + name) }
      block(width: 100%, height: if needed > height { height } else { auto }, clip: true, spacing: 0pt, shown)
    })
  }
}

// The title, as large as "size" while it keeps to "lines" lines, down to "min-size"; beyond that it wraps.
#let fit-title(title, size: 28pt, min-size: 18pt, lines: 2, fill: ink, width: 100%) = layout(page-size => {
  let w = if type(width) == ratio { page-size.width * width } else { width }
  let set-at(s, c) = block(width: w, text(size: s, weight: 600, fill: fill, font: heading-fonts, par(leading: 0.3em, justify: false, c)))
  let reference(s) = measure(set-at(s, range(lines).map(_ => "X").join(linebreak()))).height
  let s = size
  while s > min-size and measure(set-at(s, title)).height > reference(s) + 0.1pt { s -= 1pt }
  set-at(s, title)
})

// The title page's data fields (but the title), each on its line.
#let title-fields(size: 10pt, fill: muted-ink, lead-size: 13pt) = {
  let fields = design.title-fields
  if fields.len() == 0 { return }
  block(below: 0pt, {
    block(below: 6pt, text(size: lead-size, weight: 500, fill: fill, fields.first().value))
    for f in fields.slice(1) { block(above: 4pt, below: 0pt, text(size: size, fill: fill, f.value)) }
  })
}

// The logo: the design's (dark: on a coloured band), else branding's; none: no logo. With the
// manufacturer's name as its alternative text, else decoration (an artifact).
#let design-logo(height, dark: false) = context {
  let path = if dark and design.logo-dark != none { design.logo-dark } else if design.logo != none { design.logo } else { base.document-info("logo") }
  let path = if path == none { none } else { rooted(path) }
  if path == none { }
  else if design.logo-alt != none { image(path, height: height, alt: design.logo-alt) }
  else { pdf.artifact(image(path, height: height)) }
}

// The stable address's QR code on the title page (#450, delivery.pdfQrCode: title-page): at the
// foot, at the end of the line, size wide; nothing when the document prints none. A preset
// places it beside its "footer" region, which foot-width narrows by the block's measured width
// (the address under the code is wider than the code), in context.
#let title-qr(size) = context {
  let qr = base.document-info("qr")
  if qr != none { base.qr-block(qr.path, qr.url, size, end) }
}
#let foot-width(size, width: 100%) = {
  let qr = base.document-info("qr")
  if qr == none { width } else { width - measure(base.qr-block(qr.path, qr.url, size, end)).width - 8mm }
}

// The cover image: with its alternative text, else decoration (an artifact). "cover" fills the
// box (cropping), "contain" shows all of it inside the box.
#let cover-image(width: 100%, height: auto, fit: "cover") = {
  let cover = design.cover
  if cover == none { return }
  if cover.alt != none { image(cover.path, width: width, height: height, fit: fit, alt: cover.alt) }
  else { pdf.artifact(image(cover.path, width: width, height: height, fit: fit)) }
}

#let margins = {
  let m = design.margins
  if design.double-sided { (top: m.top * 1mm, bottom: m.bottom * 1mm, inside: m.left * 1mm, outside: m.right * 1mm) }
  else { (top: m.top * 1mm, bottom: m.bottom * 1mm, left: m.left * 1mm, right: m.right * 1mm) }
}

// Where the back page goes (#395): "last", or "inside-cover", right after the title page.
#let back-position = if design.back-page == none { "last" } else { design.back-page.at("position", default: "last") }

// The back page (imprint): the "back" region, the manufacturer, copyright, document number and
// date, the "back-footer" region at the foot; on an even page printed double-sided. On the
// inside of the title page ("inside") it prints no QR code: a back-cover code stays on the
// document's last page, a page of its own.
#let back-page(inside: false) = {
  let data = design.back-page
  let back-qr = if inside { none } else { back-qr }
  if data == none and not design.back-regions and back-qr == none { return }
  pagebreak(weak: true, to: if design.double-sided { "even" } else { none })
  page(header: none, footer: none, columns: 1, {
    region("back", 9cm)
    if data != none {
      set text(size: 9pt, fill: ink)
      v(1fr)
      let m = data.manufacturer
      if m != none {
        block(below: 0.6em, text(weight: 600, m.name))
        for l in m.address { block(above: 0pt, below: 0.25em, l) }
        if m.contact != none { block(above: 0.5em, below: 0.25em, m.contact) }
        if m.website != none { block(above: 0pt, below: 0.25em, link(m.website, m.website)) }
      }
      let facts = (data.document-number, data.date).filter(x => x != none)
      if facts.len() > 0 { block(above: 1em, below: 0.25em, text(fill: muted-ink, facts.join(" · "))) }
      if data.copyright != none { block(above: 0.6em, text(fill: muted-ink, data.copyright)) }
    } else { v(1fr) }
    // At the end of the line, above the back page's footer.
    if back-qr != none {
      block(width: 100%, above: 1.2em, below: 1.2em, align(end, base.qr-block(back-qr.path, back-qr.url, 3.2cm, end)))
      state("openfolia-qr-printed", false).update(true)
    }
    region("back-footer", 3cm, size: 8pt)
  })
}

// A table's header cell: tinted from the design's primary colour, or plain.
#let header-cell(..args, body) = table.cell(..args, fill: if design.tables.header-tint { tint } else { none }, text(weight: 600, body))

// Steps: the number in a filled circle of the primary colour, or the plain number.
#let step-circle(n) = move(dy: -0.36em, circle(radius: 0.72em, fill: primary, inset: 0pt,
  align(center + horizon, text(size: 0.85em, weight: 600, fill: white, str(n)))))
#let step-number(n) = text(weight: 600, fill: primary, str(n) + ".")
#let procedure(title: none, ..steps) = {
  if title != none { block(above: 1.3em, below: 0.7em, sticky: true, text(weight: 600, title)) }
  enum(numbering: if design.steps.marker == "number" { step-number } else { step-circle },
    indent: 0pt, body-indent: 0.75em, spacing: 0.75em, ..steps.pos())
}

// Image callouts (#546): markers, leader lines and references in the design's primary colour.
#let callout-colours = (..base.callout-colours, fill: primary)
#let callout-marker = base.callout-marker.with(colours: callout-colours)
#let callout-ref = base.callout-ref.with(colours: callout-colours)
#let callout-image = base.callout-image.with(colours: callout-colours)

// Notes (admonitions): tinted as in the preview, or framed in their colour.
#let admonition(kind: "note", body) = {
  let (colour, background) = base.admonition-colours.at(kind, default: base.admonition-colours.note)
  let framed = design.notes.style == "framed"
  block(width: 100%, inset: (x: 0.9em, y: 0.7em), radius: theme.radius,
    fill: if framed { none } else { background }, stroke: if framed { 1pt + colour } else { none },
    above: 1.3em, below: 1.3em)[
    #block(below: 0.5em, text(fill: colour, weight: 700, label-text(kind)))
    #body
  ]
}

// The general warning sign (ISO 7010 W001): black on safety yellow. Decoration (the signal word
// and hazard are the text), so an artifact screen readers skip.
#let warning-sign(size) = pdf.artifact(box(width: size, height: size * 0.88, {
  place(polygon(fill: theme.safety-caution, stroke: (paint: theme.safety-caution-foreground, thickness: size * 0.06, join: "round"),
    (size * 0.05, size * 0.85), (size * 0.5, size * 0.04), (size * 0.95, size * 0.85)))
  place(dx: size * 0.455, dy: size * 0.3, rect(width: size * 0.09, height: size * 0.32, radius: size * 0.03, fill: theme.safety-caution-foreground))
  place(dx: size * 0.45, dy: size * 0.68, circle(radius: size * 0.05, fill: theme.safety-caution-foreground))
}))

// Safety notices by the design's standard; the colours are always the standard's (the theme's
// fixed safety colours), never the design's.
// - ANSI Z535: the signal word panel on top (the default template's layout).
// - ISO 3864 / EN 82079-1: the safety sign beside the text (the notice's symbols, else the
//   general warning sign; NOTICE has none), the signal word on its colour above the hazard.
#let safety-notice(severity, hazard, symbols, breakable, body) = {
  if design.safety.standard != "iso-3864" { return base.safety(severity: severity, hazard: hazard, symbols: symbols, breakable: breakable, body) }
  let (colour, on-colour) = base.safety-colours.at(severity)
  let signs = if symbols.len() > 0 { symbols.map(s => image(s, width: 3em)) } else if severity != "notice" { (warning-sign(3em),) } else { () }
  block(width: 100%, breakable: breakable, above: 1.3em, below: 1.3em, inset: 0.9em,
    stroke: 1.5pt + colour, radius: theme.radius,
    grid(columns: if signs.len() > 0 { (auto, 1fr) } else { (1fr,) }, column-gutter: 0.9em,
      ..if signs.len() > 0 { (pdf.artifact(stack(spacing: 0.5em, ..signs)),) },
      [
        #box(fill: colour, inset: (x: 0.5em, y: 0.3em), radius: base.small-radius,
          text(fill: on-colour, weight: 700, tracking: 0.08em, label-text(severity)))
        #parbreak()
        #text(weight: 600, hazard)
        #parbreak()
        #body
      ]))
}

// A safety message is kept whole on a page (#668): one that does not fit the rest of a page
// starts on the next. One taller than a whole page (a column, with two) could never be kept
// whole: it breaks across pages instead of running off the page, and is reported
// ("safety-message-split", at the message's module and block, which the generated document
// marks before it (SAFETY_AT_LABEL); the hazard as its text).
#let safety(severity: "warning", hazard: [], symbols: (), body) = {
  let symbols = symbols.map(rooted)
  // The notice's spacing around the wrapper: inside layout() it would not meet its neighbours'.
  block(width: 100%, above: 1.3em, below: 1.3em, layout(region => {
    let whole = safety-notice(severity, hazard, symbols, false, body)
    if measure(whole, width: region.width).height <= region.height { return whole }
    let marks = query(selector(label("${SAFETY_AT_LABEL}")).before(here()))
    let at = if marks.len() == 0 { "" } else { marks.last().value }
    // Unmarked (a design region's, or a template's own document): not reported.
    if at != "" { layout-warning("safety-message-split", at, text: plain-text(hazard)) }
    safety-notice(severity, hazard, symbols, true, body)
  }))
}

// The manual: the design's page, body, headings, tables and running heads; "title-page"
// (the preset's) gets the title and subtitle; the contents, the body and the back page follow.
#let design-manual(title-page: none, title: none, subtitle: none, lang: "en", body) = {
  set document(title: title)
  let size = design.body.font-size * 1pt
  set text(lang: lang, font: body-fonts, size: size, fill: ink)
  // Typst's leading is the gap between lines (from the baseline to the next line's cap height);
  // between paragraphs the design's spacing comes on top of it.
  let leading = calc.max(design.body.line-height - 0.7, 0.1) * size
  set par(leading: leading, spacing: leading + design.body.paragraph-spacing * 1pt)
  set page(paper: design.paper, margin: margins,
    header: running("header"), footer: running("footer"))

  // Headings: numbered per level (1.2.3, or none), sizes from the type scale, the design's colour.
  let numbering-of(level) = design.headings.numbering.at(level - 1, default: design.headings.numbering.last())
  let size-of(level) = design.headings.sizes.at(level - 1, default: design.headings.sizes.last())
  set heading(numbering: (..n) => if numbering-of(n.pos().len()) == "none" { none } else { n.pos().map(str).join(".") })
  // A region's heading (#393: neither outlined nor bookmarked; the contents' own title is
  // bookmarked "auto") starts no page and takes the second level's size.
  show heading: it => {
    let region = not it.outlined and it.bookmarked == false
    if it.level == 1 and not region and design.headings.page-break-before-level1 { pagebreak(weak: true) }
    set text(size: size-of(if region { 2 } else { it.level }) * 1em, weight: 600, fill: rgb(design.headings.colour), font: heading-fonts)
    set par(leading: 0.35em, justify: false)
    block(above: 1.5em, below: 0.6em, sticky: true, {
      if it.numbering != none and numbering-of(it.level) != "none" {
        text(fill: muted-ink, counter(heading).display(it.numbering))
        h(0.55em)
      }
      it.body
    })
  }

  set outline(depth: 3, indent: auto)
  set outline.entry(fill: box(width: 1fr, repeat(gap: 0.25em, text(fill: theme.border, "."))))
  show outline.entry.where(level: 1): set block(above: 1.1em)
  show outline.entry.where(level: 1): set text(weight: 600)

  show link: it => if type(it.dest) == label and str(it.dest).starts-with("_term-") { it } else {
    underline(offset: 0.18em, stroke: 0.5pt, text(fill: primary, it))
  }
  set list(indent: 0.3em, body-indent: 0.6em, marker: ([•], [–]))
  set enum(indent: 0.3em, body-indent: 0.6em)
  set strong(delta: 300)
  show raw: set text(font: theme.font-mono, size: 1.125em)
  set raw(theme: none)
  show raw.where(block: true): it => block(
    width: 100%, fill: theme.muted, radius: base.small-radius,
    inset: (x: 1em, y: 0.75em), above: 1.1em, below: 1.1em,
    { set par(leading: 0.55em); it },
  )

  // Tables: borders none, horizontal or a grid; zebra rows; the header tinted (header-cell).
  let rule = 0.6pt + theme.border
  set table(inset: (x: 0.6em, y: 0.45em), align: start + top,
    stroke: if design.tables.borders == "grid" { rule }
      else if design.tables.borders == "horizontal" { (x, y) => (top: if y == 0 { none } else { rule }, bottom: rule) }
      else { none },
    fill: if design.tables.zebra { (x, y) => if y > 0 and calc.even(y) { zebra-tint } } else { none })
  show table.cell: set par(spacing: 0.6em)
  set figure(gap: 0.6em)
  show figure: set block(above: 1.3em, below: 1.3em)
  show figure: set align(start)
  show figure.where(kind: table): set figure.caption(position: top)
  show figure.where(kind: table): set figure(supplement: label-text("table"))
  show figure.where(kind: image): set figure(supplement: label-text("figure"))
  show figure.caption: it => align(start, text(size: 0.9em, fill: muted-ink,
    [#text(weight: 600)[#it.supplement #context it.counter.display(it.numbering)#it.separator]#it.body]))

  title-page(title, subtitle)
  if back-position == "inside-cover" { back-page(inside: true) }
  context outline(title: state("openfolia-labels", (:)).final().at("contents", default: base.fallback-labels.contents))
  pagebreak(weak: true)
  set page(columns: design.body.columns)
  [#metadata(none)<openfolia-body-start>]
  body
  if back-position != "inside-cover" { back-page() }
}
`.replace('DEFAULT_DATA', () => str(JSON.stringify(DEFAULT_DATA)));

/**
 * The layout presets' title pages (#389), each a Typst template over the design layer. Reading
 * order puts the title first: what stands above it (the logo, the `above-title` region, the
 * cover image) is placed there after it.
 */
export const PRESET_TITLE_PAGES: Readonly<Record<string, string>> = {
  // Logo top, the title block with a rule in the accent colour, the data fields, the
  // "below-fields" region; "above-title" over the title, "footer" at the foot.
  classic: String.raw`#let title-page(title, subtitle) = page(header: none, footer: none, columns: 1, {
  v(1.6cm + 3.4cm)
  fit-title(title, width: 85%)
  v(12pt)
  line(length: 1.6cm, stroke: 2pt + accent)
  v(16pt)
  title-fields()
  v(14pt)
  // The cover image, when the manual or the design has one (#394); none: no gap.
  if design.cover != none {
    block(width: 100%, height: 6.5cm, spacing: 0pt, cover-image(height: 100%, fit: "contain"))
    v(14pt)
  }
  region("below-fields", 5cm)
  place(top + left, design-logo(1.4cm))
  place(top + left, dy: 1.6cm + 0.4cm, block(width: 100%, region("above-title", 2.8cm)))
  context place(bottom + start, block(width: foot-width(2.6cm), region("footer", 3cm, size: 8pt)))
  place(bottom + end, title-qr(2.6cm))
})`,
  // The cover image across the top, the title over a band in the primary colour with the data
  // fields and the "band" region, "footer" at the foot.
  'image-led': String.raw`#let title-page(title, subtitle) = page(header: none, footer: none, columns: 1, margin: 0pt, {
  let side = margins.at("left", default: margins.at("inside", default: 22mm))
  // Without a cover image (#394) the band starts at the top, below the logo: no empty box.
  let has-cover = design.cover != none
  let cover-height = if has-cover { 52% } else { 0% }
  v(cover-height)
  block(width: 100%, fill: primary, inset: (x: side, top: if has-cover { 1.4cm } else { 1.2cm + 1.2cm + 1.4cm }, bottom: 1.2cm), spacing: 0pt, {
    fit-title(title, fill: white)
    v(10pt)
    title-fields(fill: white)
    v(10pt)
    set text(fill: white)
    region("band", 4cm)
  })
  if has-cover { place(top + left, block(width: 100%, height: cover-height, clip: true, spacing: 0pt, cover-image(height: 100%))) }
  place(top + right, dx: -side, dy: 1.2cm, design-logo(1.2cm, dark: not has-cover))
  context place(bottom + start, dx: if text.dir == rtl { -side } else { side }, dy: -1.6cm, block(width: foot-width(2.2cm, width: 100% - 2 * side), region("footer", 2.6cm, size: 8pt)))
  context place(bottom + end, dx: if text.dir == rtl { side } else { -side }, dy: -1.6cm, title-qr(2.2cm))
})`,
  // Title and fields only, low on the page, with lots of white space; "footer" at the foot.
  minimal: String.raw`#let title-page(title, subtitle) = page(header: none, footer: none, columns: 1, {
  v(38%)
  fit-title(title, size: 24pt, min-size: 16pt, width: 80%)
  v(18pt)
  title-fields(lead-size: 11pt, size: 9.5pt)
  // The cover image above the title, when there is one (#394); none: the white space stays.
  if design.cover != none { place(top + left, block(width: 100%, height: 32%, spacing: 0pt, cover-image(height: 100%, fit: "contain"))) }
  context place(bottom + start, block(width: foot-width(2.4cm), region("footer", 2.6cm, size: 8pt)))
  place(bottom + end, title-qr(2.4cm))
})`,
};

/** A preset's template: the design layer, its title page, and `manual` from both. */
function presetTemplate(preset: string): string {
  return [
    `// Page design preset "${preset}" for @openfolia/render-typst (#391): the design layer and its title page.`,
    `#import "/${DESIGN_LAYER_PATH}": *`,
    PRESET_TITLE_PAGES[preset],
    '#let manual = design-manual.with(title-page: title-page)',
    '',
  ].join('\n');
}

/** The layout presets' templates, by preset ID (`PAGE_DESIGN_PRESETS`). */
export const PRESET_TEMPLATES: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.keys(PRESET_TITLE_PAGES).map((preset) => [
      preset,
      presetTemplate(preset),
    ]),
  );

/** The template for a design's preset; `classic` for a preset the renderer has none for. */
export function designTemplate(preset: string): string {
  return PRESET_TEMPLATES[preset] ?? (PRESET_TEMPLATES['classic'] as string);
}

/** The compiler's own files for designs: the default template to build on and the layer. */
export const DESIGN_FILES: Readonly<Record<string, string>> = {
  [DEFAULT_TEMPLATE_PATH]: DEFAULT_TEMPLATE,
  [DESIGN_LAYER_PATH]: DESIGN_LAYER,
};
