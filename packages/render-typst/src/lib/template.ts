/**
 * The default Typst template: an A4 layout in the product's design, from the
 * theme's tokens (`tokens.typ`, generated from `@openfolia/theme`) and fonts, styled
 * after the HTML preview's stylesheet (`@openfolia/render-html`), adapted for print.
 * Organisations replace it with their own corporate design; generated
 * documents only rely on the functions defined here (`manual`, `anchor`,
 * `safety`, `admonition`, `procedure`, `ui`, `code-span`, `kbd`, `xref`,
 * `unconverted`; `attachment`, `header-cell`, `faq`, `term`,
 * `glossary-entry`, `callout-image` and `callout-ref` are optional).
 */
import { calloutFunctions } from './callouts.js';

export const DEFAULT_TEMPLATE = String.raw`// Default template for @openfolia/render-typst. Replace it to apply a corporate design.

// The theme's light values (colours, radius, fonts), generated from @openfolia/theme.
#import "/tokens.typ": theme

// The fixed texts follow the manual's language. The generated document sets
// them in the state "openfolia-labels" (a dictionary: danger, warning, caution,
// notice, note, tip, important, contents, figure, table, unconverted,
// attachment, attachmentNote, glossary);
// these English texts only apply when a document sets none.
#let fallback-labels = (
  danger: "DANGER", warning: "WARNING", caution: "CAUTION", notice: "NOTICE",
  note: "Note", tip: "Tip", important: "Important",
  contents: "Contents", figure: "Figure", table: "Table",
  unconverted: "Unconverted content",
  attachment: "Attachment",
  attachmentNote: "Download the file from the online version of this document.",
  glossary: "Glossary",
)
// final(): the labels are known wherever they are read, even on the title page.
#let label-text(key) = context state("openfolia-labels", (:)).final().at(key, default: fallback-labels.at(key))
// What the title page shows besides the title (state "openfolia-document": language,
// variant, release, date, logo, qr); none where unknown. Call inside context.
#let document-info(key) = state("openfolia-document", (:)).final().at(key, default: none)

// Safety colours are the theme's fixed ones (ISO 3864 / ANSI Z535): each with the ink on it.
#let safety-colours = (
  danger: (theme.safety-danger, theme.safety-danger-foreground),
  warning: (theme.safety-warning, theme.safety-warning-foreground),
  caution: (theme.safety-caution, theme.safety-caution-foreground),
  notice: (theme.safety-notice, theme.safety-notice-foreground),
)
// Admonitions as in the preview: notes info, tips success, important points warning.
#let admonition-colours = (
  note: (theme.info, theme.info-muted),
  tip: (theme.success, theme.success-muted),
  important: (theme.warning, theme.warning-muted),
)
#let spacing = 1.1em
#let small-radius = theme.radius / 2

// A table's header cell: the preview's tint and semibold text. renderTypst writes every cell
// of a header row with it (rebuilding a table in a show rule would break its tagging, so the
// header is styled where it is made); a table nested in the body keeps its own look.
#let header-cell(..args, body) = table.cell(..args, fill: theme.muted, text(weight: 600, body))

// A QR code with the address it holds under it (as wide as it needs), set left to right in a
// right-to-left manual too (an image is never mirrored; a URL's slashes would be); the address is its alt
// text too.
#let qr-block(path, url, size, side) = stack(dir: ttb, spacing: 4pt,
  align(side, image(path, width: size, alt: url)),
  align(side, text(dir: ltr, size: 7pt, fill: theme.muted-foreground, url)))
// The QR code on a page of its own at the end (#450, delivery.pdfQrCode: back-cover).
#let qr-code(path: "", url: "") = align(center + horizon, qr-block(path, url, 4cm, center))

#let manual(title: none, subtitle: none, lang: "en", body) = {
  set document(title: title)
  set text(lang: lang, font: theme.font-sans, size: 10pt, fill: theme.foreground)
  set par(leading: 0.72em, spacing: spacing)
  set page(
    paper: "a4",
    margin: (x: 2.2cm, top: 2.6cm, bottom: 2.4cm),
    header: context if counter(page).get().first() > 1 {
      set text(size: 7.5pt, fill: theme.muted-foreground)
      block(width: 100%, inset: (bottom: 5pt), stroke: (bottom: 0.5pt + theme.border),
        grid(columns: (1fr, auto), gutter: 1em, title, subtitle))
    },
    footer: context if counter(page).get().first() > 1 {
      set text(size: 7.5pt, fill: theme.muted-foreground)
      block(width: 100%, inset: (top: 5pt), stroke: (top: 0.5pt + theme.border),
        grid(columns: (1fr, auto), gutter: 1em, document-info("language"), counter(page).display("1")))
    },
  )

  // Headings: the preview's scale (2em, 1.5em, 1.25em), semibold, numbers muted.
  set heading(numbering: "1.1")
  show heading: it => {
    let size = (2em, 1.5em, 1.25em).at(it.level - 1, default: 1em)
    if it.level == 1 { pagebreak(weak: true) }
    set text(size: size, weight: 600)
    set par(leading: 0.35em, justify: false)
    block(above: 1.5em, below: 0.6em, sticky: true, {
      if it.numbering != none {
        text(fill: theme.muted-foreground, counter(heading).display(it.numbering))
        h(0.55em)
      }
      it.body
    })
  }

  // Contents: chapters semibold, dotted leaders in the border colour.
  set outline(depth: 3, indent: auto)
  set outline.entry(fill: box(width: 1fr, repeat(gap: 0.25em, text(fill: theme.border, "."))))
  show outline.entry.where(level: 1): set block(above: 1.1em)
  show outline.entry.where(level: 1): set text(weight: 600)

  // Text
  // A term link (to its glossary entry, "_term-…") keeps the text's colour: term() styles it.
  show link: it => if type(it.dest) == label and str(it.dest).starts-with("_term-") { it } else {
    underline(offset: 0.18em, stroke: 0.5pt, text(fill: theme.primary, it))
  }
  set list(indent: 0.3em, body-indent: 0.6em, marker: ([•], [–]))
  set enum(indent: 0.3em, body-indent: 0.6em)
  set strong(delta: 300)
  // Code in the theme's mono, unhighlighted as in the preview (the language stays on the
  // element). Typst sets raw text at 0.8em: 1.125 × 0.8em is the preview's 0.9em.
  show raw: set text(font: theme.font-mono, size: 1.125em)
  set raw(theme: none)
  show raw.where(block: true): it => block(
    width: 100%, fill: theme.muted, radius: small-radius,
    inset: (x: 1em, y: 0.75em), above: spacing, below: spacing,
    { set par(leading: 0.55em); it },
  )

  // Tables and figures: borders and header tint as in the preview, captions muted with a semibold label.
  set table(stroke: 0.6pt + theme.border, inset: (x: 0.6em, y: 0.45em), align: start + top)
  show table.cell: set par(spacing: 0.6em)
  set figure(gap: 0.6em)
  show figure: set block(above: 1.3em, below: 1.3em)
  show figure: set align(start)
  show figure.where(kind: table): set figure.caption(position: top)
  show figure.where(kind: table): set figure(supplement: label-text("table"))
  show figure.where(kind: image): set figure(supplement: label-text("figure"))
  show figure.caption: it => align(start, text(size: 0.9em, fill: theme.muted-foreground,
    [#text(weight: 600)[#it.supplement #context it.counter.display(it.numbering)#it.separator]#it.body]))

  // Title page: a logo slot (branding's logo; the compiler's default mark,
  // /openfolia/logo.svg, when none is set), the title with a short rule,
  // then variant, language, release and date where known.
  page(header: none, footer: none, margin: (x: 2.2cm, top: 2.2cm, bottom: 2.4cm), context {
    let logo = document-info("logo")
    // The logo is decoration: an artifact, which screen readers skip.
    block(height: 1.4cm, pdf.artifact(image(if logo != none { logo } else { "/openfolia/logo.svg" }, height: 1.4cm)))
    v(22%)
    block(width: 85%, text(size: 28pt, weight: 600, par(leading: 0.3em, title)))
    v(12pt)
    line(length: 1.6cm, stroke: 2pt + theme.primary)
    v(16pt)
    if subtitle != none and subtitle != "" {
      block(below: 6pt, text(size: 13pt, weight: 500, subtitle))
    }
    let details = ("language", "release", "date").map(document-info).filter(x => x != none)
    text(size: 10pt, fill: theme.muted-foreground, details.join(" · "))
    // The stable address's QR code (#450, delivery.pdfQrCode: title-page), at the foot.
    let qr = document-info("qr")
    if qr != none {
      place(bottom + end, qr-block(qr.path, qr.url, 2.6cm, end))
    }
  })
  // The title read in context around the outline, not inside it: PDF/UA needs a heading's
  // title as text, which contextual content is not.
  context outline(title: state("openfolia-labels", (:)).final().at("contents", default: fallback-labels.contents))
  pagebreak(weak: true)
  body
}

// A link target: xrefs point at it with link(label(id)).
#let anchor(id) = [#metadata(id)#label(id)]

#let ui(body) = text(weight: 600, body)
// highlight(), not a box: a code span breaks across lines like the preview's.
#let code-span(body) = highlight(
  fill: theme.muted, radius: small-radius, extent: 0.15em, top-edge: "ascender", bottom-edge: "descender",
  text(font: theme.font-mono, size: 0.9em, body),
)
// A key combination reads left to right in any text (#458): one box, so it keeps its order.
#let kbd(..keys) = box(text(dir: ltr, keys.pos().map(key => box(
  stroke: (rest: 0.6pt + theme.border, bottom: 1.4pt + theme.border),
  fill: theme.muted, radius: small-radius, inset: (x: 0.35em), outset: (y: 0.25em),
  text(font: theme.font-mono, size: 0.9em, key),
)).join(h(0.15em) + [+] + h(0.15em))))
#let xref(target, body) = if target == none { body } else { link(label(target), body) }
// A term link: the text with a dotted underline, a link to its glossary entry when the
// manual has one (target none: the term on its own).
#let term(target, body) = {
  let marked = underline(offset: 0.2em, stroke: (paint: theme.muted-foreground, thickness: 0.5pt, dash: "dotted"), body)
  if target == none { marked } else { link(label(target), marked) }
}
// A glossary entry: the term in semibold, kept with its definition, which is indented below it.
#let glossary-entry(term: "", body) = block(width: 100%, above: 0.9em, below: 0.9em, breakable: true)[
  #block(sticky: true, below: 0.35em, text(weight: 600, term))
  // Indented from the start of the line: the right in right-to-left text.
  #context pad(..if text.dir == rtl { (right: 1.2em) } else { (left: 1.2em) }, body)
]

// The safety alert symbol (ANSI Z535): a triangle with an exclamation mark. Decoration
// (the signal word beside it is the text), so an artifact screen readers skip.
#let alert-symbol(ink, mark) = pdf.artifact(box(width: 1.1em, height: 0.95em, baseline: 0.12em, {
  place(polygon(fill: ink, (0em, 0.95em), (0.55em, 0em), (1.1em, 0.95em)))
  place(dx: 0.49em, dy: 0.32em, rect(width: 0.12em, height: 0.34em, radius: 0.04em, fill: mark))
  place(dx: 0.485em, dy: 0.73em, circle(radius: 0.065em, fill: mark))
}))
// Kept whole on a page ("breakable": false, the default); a page design's layer lets one taller
// than a page break (#668).
#let safety(severity: "warning", hazard: [], symbols: (), breakable: false, body) = {
  let (colour, ink) = safety-colours.at(severity)
  block(
    width: 100%, breakable: breakable, above: 1.3em, below: 1.3em, clip: true,
    stroke: 1pt + colour, radius: theme.radius,
    fill: color.mix((colour, 10%), (theme.background, 90%)),
  )[
    #block(width: 100%, fill: colour, inset: (x: 0.9em, y: 0.5em), spacing: 0pt,
      text(fill: ink, weight: 700, tracking: 0.08em, {
        // The safety alert symbol precedes DANGER, WARNING and CAUTION, never NOTICE.
        if severity != "notice" { alert-symbol(ink, colour) + h(0.5em) }
        label-text(severity)
      }))
    #block(width: 100%, inset: 0.9em, spacing: 0pt, grid(
      columns: if symbols.len() > 0 { (auto, 1fr) } else { (1fr,) },
      gutter: 0.9em,
      ..if symbols.len() > 0 {
        // The symbols repeat what the signal word and hazard say: artifacts, no alt text needed.
        (pdf.artifact(stack(spacing: 0.5em, ..symbols.map(s => image(s, width: 3em)))),)
      },
      [#text(weight: 600, hazard) #parbreak() #body],
    ))
  ]
}

#let admonition(kind: "note", body) = {
  let (colour, background) = admonition-colours.at(kind, default: admonition-colours.note)
  block(width: 100%, inset: (x: 0.9em, y: 0.7em), radius: theme.radius, fill: background,
    above: 1.3em, below: 1.3em)[
    #block(below: 0.5em, text(fill: colour, weight: 700, label-text(kind)))
    #body
  ]
}

// An FAQ entry: the question in bold, never left at a page's foot without
// its answer, then the answer.
#let faq(question: [], body) = block(width: 100%, above: 1.3em, below: 1.3em)[
  #block(sticky: true, below: 0.6em, text(weight: 700, question))
  #body
]

// Steps numbered in filled circles, as in the preview.
// (Enum numbers sit at the top of the first line: the circle moves up to centre on it.)
#let step-number(n) = move(dy: -0.36em, circle(radius: 0.72em, fill: theme.primary, inset: 0pt,
  align(center + horizon, text(size: 0.85em, weight: 600, fill: theme.primary-foreground, str(n)))))
#let procedure(title: none, ..steps) = {
  if title != none { block(above: 1.3em, below: 0.7em, sticky: true, text(weight: 600, title)) }
  enum(numbering: step-number, indent: 0pt, body-indent: 0.75em, spacing: 0.75em, ..steps.pos())
}

// An attachment: a PDF cannot carry the file, so its name, facts and description,
// framed as in the preview, with the note where to download it. All strings
// (the size already formatted in the manual's language); description may be none.
#let attachment(name: "", file-name: "", media-type: "", size: "", description: none) = block(
  width: 100%, inset: (x: 0.9em, y: 0.7em), radius: theme.radius,
  stroke: 0.6pt + theme.border, above: 1.3em, below: 1.3em,
)[
  // The name and facts stay together and with what follows; a long description may break.
  #block(breakable: false, sticky: true, below: 0pt)[
    #text(weight: 600)[#label-text("attachment"): #name]
    #h(0.3em) #text(size: 0.9em, fill: theme.muted-foreground)[#file-name · #media-type · #size]
  ]
  #if description != none { block(above: 0.5em, below: 0pt, description) }
  #block(above: 0.5em, below: 0pt, text(size: 0.9em, style: "italic", fill: theme.muted-foreground, label-text("attachmentNote")))
]

${calloutFunctions('theme')}
// Content an importer could not convert; shown loudly so it gets cleaned up.
#let unconverted(format, source) = block(
  width: 100%, inset: (x: 0.9em, y: 0.7em), radius: small-radius,
  stroke: (paint: theme.destructive, thickness: 0.75pt, dash: "dashed"),
)[
  #text(fill: theme.destructive, weight: 600)[#label-text("unconverted") #text(weight: 400)[(#format)]]
  #raw(source, block: true)
]
`;
