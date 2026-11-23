import { DEFAULT_CALLOUT_LABEL_MIN_SIZE } from '@openfolia/content-model';

/**
 * The `sys.inputs` key the smallest size of a legend beside its image arrives under (#548):
 * `pdf.calloutLabelMinSize`, in points, as a decimal number.
 */
export const CALLOUT_MIN_SIZE_INPUT = 'openfolia-callout-min-size';

/**
 * Image callouts in print (#546): the Typst functions that draw an image's
 * numbered markers and leader lines over it, its legend under or beside it,
 * and a callout reference in the text. The default template defines them;
 * a document with callouts defines them before importing the template too
 * (`calloutFallback`), so a repository's own template without them keeps
 * working, and its own definitions replace these.
 *
 * `theme` names the tokens' dictionary (`/tokens.typ`'s `theme`): every
 * colour comes from it, never from a literal. A design layer passes its own
 * colours through the functions' `colours:` argument.
 */
export function calloutFunctions(theme: string): string {
  return String.raw`// Image callouts (#546). The colours: the marker's fill and ink, and the muted pair a reference
// to a callout the variant does not show ("?") is drawn in.
#let callout-colours = (
  fill: ${theme}.primary, ink: ${theme}.primary-foreground,
  muted: ${theme}.muted, muted-ink: ${theme}.muted-foreground,
)
// A callout's number in its marker: a filled circle (a pill for wider numbers) at the size of
// the text around it. none: "?", muted.
#let callout-marker(n, colours: callout-colours) = context {
  let fill = if n == none { colours.muted } else { colours.fill }
  let ink = if n == none { colours.muted-ink } else { colours.ink }
  let number = text(size: 0.72em, weight: 600, fill: ink, number-width: "tabular",
    if n == none { "?" } else { str(n) })
  let height = 1.35em.to-absolute()
  let width = calc.max(height, measure(number).width + 0.5em.to-absolute())
  box(width: width, height: height, radius: height / 2, fill: fill, inset: 0pt,
    align(center + horizon, number))
}
// The smallest text a legend beside its image shrinks to (#548): the configuration's
// pdf.calloutLabelMinSize, in points, as the renderer passes it in sys.inputs.
#let callout-min-size = float(sys.inputs.at("${CALLOUT_MIN_SIZE_INPUT}", default: "${DEFAULT_CALLOUT_LABEL_MIN_SIZE}")) * 1pt
// A legend entry cut off (#548): reported, as a page design's overflow is, at its callout.
#let callout-overflow(at) = context [#metadata((code: "callout-label-overflow", at: at, page: here().page(), text: none))<openfolia-warning>]
// The legend: a numbered list, each entry's number in its marker. "marker-width": the width the
// numbers take (auto: the widest of these entries'), so a part of a legend lays out as it does
// in the whole.
// (An enum number sits at the top of the first line: the marker moves up to centre on it.)
#let callout-legend(legend, colours: callout-colours, marker-width: auto) = enum(
  numbering: n => {
    let marker = move(dy: -0.28em, callout-marker(n, colours: colours))
    if marker-width == auto { marker } else { box(width: marker-width, align(end, marker)) }
  },
  body-indent: 0.6em, spacing: 0.55em,
  ..legend.map(entry => enum.item(entry.n, entry.body)))
// The legend beside an image (#548), in "width" and no taller than the image ("height"): it wraps
// (hyphenated), then shrinks in half points down to callout-min-size (the largest size that fits,
// found by halving); what still does not fit is cut off at the image's height, and each entry cut
// (from the first one that ends below it, found by halving too) is reported with its "at".
#let callout-legend-beside(legend, width, height, colours: callout-colours) = context {
  // Lines from ascender to descender (their leading less by as much): clipping keeps every glyph
  // whole. Room above for the first entry's marker, which sits higher than its line.
  let set-at(size, entries) = block(width: width, inset: (top: 0.3em), {
    set text(size: size, hyphenate: true, top-edge: "ascender", bottom-edge: "descender")
    set par(justify: false, leading: 0.3em)
    context {
      // Every part of the legend with the whole legend's number column.
      let widest = calc.max(..legend.map(entry => measure(callout-marker(entry.n, colours: colours)).width))
      callout-legend(entries, colours: colours, marker-width: widest)
    }
  })
  let fits(size, entries) = measure(set-at(size, entries)).height <= height
  let floor = calc.min(callout-min-size, text.size)
  // In half points above the floor: the largest step at which the whole legend fits (the step
  // past the last is the text's own size, known not to).
  let steps = calc.floor((text.size - floor) / 0.5pt)
  let size-at(step) = calc.min(text.size, floor + step * 0.5pt)
  if fits(text.size, legend) { return block(width: width, clip: true, set-at(text.size, legend)) }
  let (low, high) = (-1, steps + 1)
  while high - low > 1 {
    let mid = calc.quo(low + high, 2)
    if fits(size-at(mid), legend) { low = mid } else { high = mid }
  }
  if low >= 0 { return block(width: width, clip: true, set-at(size-at(low), legend)) }
  let size = floor
  // The most entries from the start that fit: those after are cut.
  let (fit, over) = (0, legend.len())
  while over - fit > 1 {
    let mid = calc.quo(fit + over, 2)
    if fits(size, legend.slice(0, mid)) { fit = mid } else { over = mid }
  }
  for entry in legend.slice(fit) { if "at" in entry { callout-overflow(entry.at) } }
  block(width: width, height: height, clip: true, set-at(size, legend))
}
// A callout reference in the text: the number in the marker's style, on the line.
#let callout-ref(n, colours: callout-colours) = box(baseline: 0.3em, callout-marker(n, colours: colours))
// An image with its callouts. markers: ((n:, x:, y:, label:, style:), …), x and y (and label's,
// none for a marker at its anchor) from 0 to 1 across and down the image; legend: ((n:, body:), …)
// in number order (an entry's "at", where an overflow is reported, optional); placement: "below",
// "beside" or "none". The markers are image coordinates:
// placed from the image's top left corner, never mirrored in right-to-left text, while the legend
// follows the text's direction. They repeat what the legend says, so they are artifacts.
#let callout-image(path: "", alt: "", width: auto, markers: (), legend: (), placement: "below",
  colours: callout-colours) = layout(size => {
  // The path is the document's, from the project root: read from here (a template, perhaps in
  // a folder of its own) it has to say so.
  let path = if path.starts-with("/") { path } else { "/" + path }
  let natural = measure(image(path, width: width), width: size.width)
  // Beside its legend, an image takes at most 60 % of the line, whatever its width, so the
  // legend keeps room.
  let room = if placement == "beside" { size.width * 0.6 } else { size.width }
  let scale = calc.min(1, room / natural.width)
  let w = natural.width * scale
  let h = natural.height * scale
  let at(point) = (point.x * w, point.y * h)
  let drawn = box(width: w, height: h, {
    place(top + left, image(path, alt: alt, width: w))
    pdf.artifact({
      for marker in markers {
        let anchor = at(marker)
        let tip = if marker.label == none { none } else { at(marker.label) }
        if tip != none {
          place(top + left, line(start: anchor, end: tip, stroke: 0.9pt + colours.fill))
          place(top + left, dx: anchor.at(0) - 1.8pt, dy: anchor.at(1) - 1.8pt,
            circle(radius: 1.8pt, fill: colours.fill))
        }
        let centre = if tip == none { anchor } else { tip }
        let badge = callout-marker(marker.n, colours: colours)
        let m = measure(badge)
        place(top + left, dx: centre.at(0) - m.width / 2, dy: centre.at(1) - m.height / 2, badge)
      }
    })
  })
  if placement == "none" or legend.len() == 0 { drawn }
  else if placement == "beside" {
    // A grid follows the text's direction: the legend at the end of the line, the left in
    // right-to-left text. It never grows past the picture's height (#548).
    let gutter = 1.2em.to-absolute()
    grid(columns: (w, 1fr), column-gutter: gutter, align: top, drawn,
      callout-legend-beside(legend, calc.max(0pt, size.width - w - gutter), h, colours: colours))
  } else {
    // Below the image, the legend only wraps.
    stack(dir: ttb, spacing: 0.8em, drawn, block(width: 100%, callout-legend(legend, colours: colours)))
  }
})
`;
}

/** The tokens' name in a document's fallback definitions (an import of `/tokens.typ`'s `theme`). */
const FALLBACK_THEME = 'openfolia-callout-theme';

/**
 * The callout functions for a template without them, defined before the template is imported
 * (whose own replace them); only in documents with callouts, so other documents stay as they were.
 */
export const CALLOUT_FALLBACK = `#import "/tokens.typ": theme as ${FALLBACK_THEME}\n${calloutFunctions(FALLBACK_THEME)}`;
