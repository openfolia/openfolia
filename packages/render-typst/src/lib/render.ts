import {
  placeholderText,
  calloutNumber,
  directionOf,
  isLinkHref,
  formatFileSize,
  OUTPUT_LABEL_KEYS,
  resolveOutputLabels,
  sameMark,
  sortMarks,
  CALLOUT_LEGENDS,
  DEFAULT_CALLOUT_LABEL_MIN_SIZE,
  MAX_CALLOUT_LABEL_SIZE,
  MIN_CALLOUT_LABEL_SIZE,
  roundCoordinate,
  type Block,
  type CalloutPoint,
  type Image,
  type Inline,
  type Item,
  type Mark,
  type OutputLabelSet,
  type ResolvedEntry,
  type ResolvedManual,
  type ResolvedPageDesign,
  type Table,
  assertTableWithinLimits,
  isPagePlaceholder,
} from '@openfolia/content-model';
import { MISSING_SYMBOL_PATH } from './builtins.js';
import { CALLOUT_FALLBACK, CALLOUT_MIN_SIZE_INPUT } from './callouts.js';
import {
  DESIGN_INPUT,
  designData,
  designFontFamily,
  SAFETY_AT_LABEL,
  QR_INPUT,
  QR_PRINTED,
} from './design.js';
import { str } from './typst-string.js';

export { str };

export interface RenderOptions {
  /** File path (relative to the document) for an image asset (`sha256:…`). */
  assetPath?: (asset: string) => string;
  /** File path for a safety symbol's artwork, or undefined when it has none (a neutral sign stands in). */
  symbolPath?: (symbol: string) => string | undefined;
  /** Shown under the title and in the page header, e.g. "L-400 · Software 2.3 · EU". */
  subtitle?: string;
  /** The release the PDF shows on its title page (e.g. a tag), if known. */
  release?: string;
  /** The date the PDF shows on its title page, as it should read, if known. */
  date?: string;
  /**
   * The configuration's output labels per language (`ProjectConfig.outputLabels`).
   * The document gets the set for the manual's language, on top of the
   * shipped defaults, with English for anything missing.
   */
  outputLabels?: Readonly<Record<string, OutputLabelSet>>;
  /** Module path of the template, imported by the generated document. */
  templatePath?: string;
  /**
   * The manual's page design, resolved for its variant and language (#391): its settings go
   * to the template as data (`RenderResult.inputs`), its regions and running header and footer
   * into the state `"openfolia-design"`. Compile with a preset's template (`designTemplate`) to lay
   * them out. None: the document is as without designs.
   */
  design?: ResolvedPageDesign;
  /**
   * A QR code to print (#450): `path`, the file of its image (an SVG the caller provides
   * in `files`), `url`, the address it holds (also printed as text, and its alt text), and
   * `placement`, on the title page or on a page of its own at the end (`back-cover`).
   */
  qrCode?: QrCodeOption;
  /**
   * The smallest text size, in points, a callout legend beside its image shrinks to before it
   * is cut off and reported (#548): the configuration's `pdf.calloutLabelMinSize`. Absent:
   * `DEFAULT_CALLOUT_LABEL_MIN_SIZE`, 6. Clamped to `MIN_CALLOUT_LABEL_SIZE` …
   * `MAX_CALLOUT_LABEL_SIZE`.
   */
  calloutLabelMinSize?: number;
}

/** Where and what QR code a PDF prints (`RenderOptions.qrCode`). */
export interface QrCodeOption {
  readonly path: string;
  readonly url: string;
  readonly placement: 'title-page' | 'back-cover';
}

export interface RenderResult {
  /** The generated Typst document. */
  source: string;
  /** Image assets the document uses; the caller must provide them at `assetPath(asset)`. */
  assets: string[];
  /** Safety symbol files the document uses; the caller provides them (not the neutral sign standing in for missing artwork, which the compiler has). */
  symbols: string[];
  /**
   * Font files (`sha256:…`) the design names, each with the family it is loaded as (one per
   * text role, `designFontFamily`, whatever the file calls itself); the caller passes them as
   * `CompileInput.fonts`, `{ data, family }`.
   */
  fonts: { file: string; family: string }[];
  /**
   * `sys.inputs` for the compiler (`CompileInput.inputs`): the design's settings, when there is
   * one; the smallest size of a callout legend beside its image, when there is one (#548).
   */
  inputs: Record<string, string>;
}

const defaultAssetPath = (asset: string) =>
  `assets/${asset.replace(/^sha256:/, '')}`;

/**
 * Renders a resolved manual as a Typst document that imports the template.
 * All text is emitted as Typst string literals, so no content can be read
 * as Typst markup.
 */
/** The attachment box for templates without one (before `attachment` was a template function). */
const ATTACHMENT_FALLBACK =
  '#let attachment(name: "", file-name: "", media-type: "", size: "", description: none) = ' +
  'block(width: 100%, inset: 8pt, radius: 3pt, stroke: 0.5pt + luma(160))[' +
  '#block(breakable: false, sticky: true)[#text(weight: "bold")[#context state("openfolia-labels", (:)).final().at("attachment", default: "Attachment"): #name] #text(size: 0.9em)[(#file-name, #media-type, #size)]]' +
  '#if description != none [#linebreak()#description]' +
  '#linebreak()#text(size: 0.9em, style: "italic", context state("openfolia-labels", (:)).final().at("attachmentNote", default: "Download the file from the online version of this document."))]';

/** A table's header cell for templates without one (before `header-cell` was a template function): a plain cell. */
const HEADER_CELL_FALLBACK =
  '#let header-cell(..args, body) = table.cell(..args, body)';

/** An FAQ entry for templates without one (before `faq` was a template function): the question in bold, kept with its answer. */
const FAQ_FALLBACK =
  '#let faq(question: [], body) = [#block(sticky: true)[#text(weight: "bold", question)] #body]';

/** A term link and a glossary entry for templates without them (#245): a plain link, a bold term over its definition. */
const TERM_FALLBACK =
  '#let term(target, body) = if target == none { body } else { link(label(target), body) }';
/** A page field (#391) for templates without one: the page number and count; a chapter needs the design layer. */
const PAGE_FIELD_FALLBACK =
  '#let page-field(key) = context if key == "page" { counter(page).display() } else if key == "page-count" { str(counter(page).final().first()) } else { "" }';
const GLOSSARY_ENTRY_FALLBACK =
  '#let glossary-entry(term: "", body) = block(above: 0.9em, below: 0.9em)[#block(sticky: true, below: 0.4em, text(weight: "bold", term)) #body]';

/**
 * The QR code's page for templates without `qr-code` (#450): the code centred, the address
 * under it. The template's own replaces it.
 */
const QR_CODE_FALLBACK =
  '#let qr-code(path: "", url: "") = align(center + horizon)[#image(path, width: 3.5cm, alt: url) #v(6pt) #text(dir: ltr, size: 8pt, url)]';

/** A callout's number as a Typst literal: a whole number from 1, else `none` (drawn as "?"). */
function calloutNumberLiteral(n: number | undefined): string {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0
    ? String(n)
    : 'none';
}

/** A callout point as Typst dictionary members: `x` and `y`, numbers from 0 to 1 the renderer formats itself. */
function point(p: CalloutPoint): string {
  const coordinate = (v: number) =>
    Number.isFinite(v)
      ? roundCoordinate(Math.min(1, Math.max(0, v))).toFixed(4)
      : '0.0000';
  return `x: ${coordinate(p.x)}, y: ${coordinate(p.y)}`;
}

/** The glossary entry's label: starting with `_`, it is no output ID of a module or block. */
const glossaryLabel = (termId: string) => `_term-${termId}`;

export function renderTypst(
  manual: ResolvedManual,
  options: RenderOptions = {},
): RenderResult {
  const assetPath = options.assetPath ?? defaultAssetPath;
  const symbolPath = options.symbolPath ?? (() => undefined);
  const assets = new Set<string>();
  const symbols = new Set<string>();
  const targets = collectTargets(manual);
  const titles = sectionTitles(manual);
  const { labels } = resolveOutputLabels(manual.lang, options.outputLabels);

  /** `lang`, `region` and `dir` for text in `tag`, its direction from the manual's configuration (#458). */
  const langArgs = (tag: string) =>
    `${typstLangArgs(tag)}, dir: ${directionOf(manual, tag)}`;

  const anchor = (id: string) => (targets.has(id) ? `#anchor(${str(id)})` : '');
  /** Set while a design's text is written: its page placeholders are filled in on each page. */
  let designText = false;
  /** Whether the document draws a callout or a reference to one: it then defines their fallbacks. */
  let hasCallouts = false;
  /** Whether it prints a legend beside an image (#548): its layout then reports what it cut off. */
  let hasLegendBeside = false;

  // The linked terms (#245): a glossary at the end when the manifest asks for one.
  const terms = new Map((manual.terms ?? []).map((t) => [t.id, t]));
  const glossaryShown = manual.glossary === true && terms.size > 0;
  /** A term link: to its glossary entry when there is one; a term the manual has not is plain text. */
  const openTerm = (termId: string): string => {
    if (!terms.has(termId)) return '#[';
    return `#term(${glossaryShown ? str(glossaryLabel(termId)) : 'none'})[`;
  };

  const inline = (nodes: readonly Inline[]): string => {
    let out = '';
    let stack: Mark[] = [];
    const closeTo = (depth: number) => {
      while (stack.length > depth) {
        stack = stack.slice(0, -1);
        out += ']';
      }
    };
    for (const node of nodes) {
      const marks = node.type === 'text' ? sortMarks(node.marks ?? []) : [];
      let keep = 0;
      while (
        keep < stack.length &&
        keep < marks.length &&
        sameMark(stack[keep] as Mark, marks[keep] as Mark)
      )
        keep++;
      closeTo(keep);
      for (const mark of marks.slice(keep)) {
        out += mark.type === 'term' ? openTerm(mark.termId) : openMark(mark);
        stack = [...stack, mark];
      }
      switch (node.type) {
        case 'text':
          out += `#${str(node.text)}`;
          break;
        case 'attribute':
          // Normally filled in by resolveManual; shown as-is if a value was missing.
          out += `#${str(`{${node.name}}`)}`;
          break;
        case 'xref': {
          const target = ownValue(
            manual.anchors,
            node.block ? `${node.module}#${node.block}` : node.module,
          );
          const text = node.text
            ? inline(node.text)
            : `#${str((node.block && target && titles.get(target)) || moduleTitle(manual, node.module))}`;
          out += `#xref(${target ? str(target) : 'none'})[${text}]`;
          break;
        }
        case 'kbd':
          out += `#kbd(${node.keys.map(str).join(', ')})`;
          break;
        case 'calloutRef':
          // The callout's number in this variant in its marker (#546); "?" (none) for one it
          // hides or that is missing.
          hasCallouts = true;
          out += `#callout-ref(${calloutNumberLiteral(calloutNumber(manual, node))})`;
          break;
        case 'hardBreak':
          out += '#linebreak()';
          break;
        case 'placeholder':
          // A page design's data field: filled in on a design's pages, never in a module's text.
          out +=
            designText && isPagePlaceholder(node.key)
              ? `#page-field(${str(node.key)})`
              : `#${str(placeholderText(node.key))}`;
          break;
        default:
          node satisfies never;
      }
    }
    closeTo(0);
    return out;
  };

  /**
   * `flow`: directly in a module or a section, where a page can break. A
   * page break anywhere else (a module reference inlined into a list item
   * or a notice brings one along) is left out: Typst refuses a page break
   * inside a container.
   */
  const blocks = (
    list: readonly Block[],
    level: number,
    flow = false,
  ): string =>
    list
      .map(
        (block) =>
          // A page break keeps its anchor, wherever it stands: a link to it must find it.
          anchor(block.id) +
          (block.type === 'pageBreak'
            ? flow
              ? '#pagebreak(weak: true)'
              : ''
            : renderBlock(block, level, flow)),
      )
      .filter((source) => source !== '')
      .join('\n\n');

  const item = (it: Item, level: number) =>
    `[${anchor(it.id)}${inline(it.content)}${it.blocks.length > 0 ? `\n\n${blocks(it.blocks, level)}` : ''}]`;

  /**
   * A procedure's step: like a list item, but a step whose first block is an image keeps its
   * text with the image (a sticky block: never the text at a page's foot, its picture overleaf).
   * The image stands in the step's body, so it is indented with the step and the numbering goes on.
   */
  const step = (it: Item, level: number) =>
    it.blocks[0]?.type === 'image'
      ? `[${anchor(it.id)}#block(sticky: true)[${inline(it.content)}]\n\n${blocks(it.blocks, level)}]`
      : item(it, level);

  /** `flow`: the block itself stands where a page can break (so a section's blocks do too). */
  const renderBlock = (block: Block, level: number, flow = false): string => {
    switch (block.type) {
      case 'paragraph':
        return inline(block.content);
      case 'section':
        return [
          // A design's region heading (#393): a heading for PDF/UA, never numbered, in the
          // contents or the bookmarks, and no chapter for the running heads.
          designText
            ? `#heading(level: ${level}, numbering: none, outlined: false, bookmarked: false)[${inline(block.title)}]`
            : `#heading(level: ${level})[${inline(block.title)}]`,
          blocks(block.blocks, level + 1, flow),
        ]
          .filter(Boolean)
          .join('\n\n');
      case 'list':
        return `#${block.ordered ? 'enum' : 'list'}(\n${block.items.map((i) => `  ${item(i, level)},`).join('\n')}\n)`;
      case 'procedure':
        return `#procedure(${block.title ? `title: [${inline(block.title)}], ` : ''}\n${block.steps
          .map((i) => `  ${step(i, level)},`)
          .join('\n')}\n)`;
      case 'table':
        return renderTable(block, level);
      case 'image': {
        assets.add(block.asset);
        const width =
          block.width === undefined ? '' : `, width: ${block.width}%`;
        const image =
          block.callouts && block.callouts.length > 0
            ? calloutImage(block)
            : `image(${str(assetPath(block.asset))}, alt: ${str(block.alt)}${width})`;
        // An image with callouts is laid out by the template: a figure of kind image all the same.
        return block.title
          ? `#figure(${block.callouts?.length ? 'kind: image, ' : ''}${image}, caption: [${inline(block.title)}])`
          : `#${image}`;
      }
      case 'attachment': {
        // A PDF cannot carry the file: the template prints its name, facts
        // and description, with the note where to download it.
        const description = block.description ? str(block.description) : 'none';
        return `#attachment(name: ${str(block.name)}, file-name: ${str(block.fileName)}, media-type: ${str(block.mediaType)}, size: ${str(formatFileSize(block.size, manual.lang))}, description: ${description})`;
      }
      case 'safety': {
        // A symbol without artwork keeps its place, as the compiler's neutral sign.
        const paths = block.symbols.map((id) => {
          const path = symbolPath(id);
          if (path === undefined) return MISSING_SYMBOL_PATH;
          symbols.add(path);
          return path;
        });
        // With a page design, marked with its module and block: where the design layer reports
        // one it has to break across pages (#668). One without an origin (a design region's)
        // is marked empty, so it never takes the place of the message before it.
        const origin = manual.origins[block.id];
        const mark = options.design
          ? `#metadata(${str(origin && !designText ? `safety.${origin.module}.${origin.block}` : '')})<${SAFETY_AT_LABEL}>`
          : '';
        return `${mark}#safety(severity: ${str(block.severity)}, hazard: [${inline(block.hazard)}], symbols: (${paths
          .map((p) => `${str(p)},`)
          .join(' ')}))[${blocks(block.blocks, level)}]`;
      }
      case 'admonition':
        return `#admonition(kind: ${str(block.kind)})[${blocks(block.blocks, level)}]`;
      case 'faq':
        return `#faq(question: [${inline(block.question)}])[${blocks(block.blocks, level)}]`;
      case 'literal':
        return `#raw(block: true, ${block.language ? `lang: ${str(block.language)}, ` : ''}${str(block.text)})`;
      case 'passthrough':
        return `#unconverted(${str(block.format)}, ${str(block.raw)})`;
      case 'pageBreak':
        // Written by `blocks`, which knows whether a page can break there.
        return '';
      case 'variant':
      case 'moduleRef':
        throw new Error(
          `renderTypst expects a resolved manual, but found a ${block.type} block ("${block.id}")`,
        );
      default:
        return block satisfies never;
    }
  };

  /**
   * An image with its callouts (#546), drawn by the template's `callout-image`: the markers in
   * number order (a resolved image holds only the callouts the variant shows, in that order),
   * each at its anchor or its label, from 0 to 1 across and down the image; the legend, each
   * entry its number and text; where the legend goes. Numbers are formatted here, every text
   * is a string literal or inline content.
   */
  const calloutImage = (block: Image): string => {
    hasCallouts = true;
    const callouts = block.callouts ?? [];
    const numbered = callouts.map((callout, i) => ({
      callout,
      n:
        calloutNumber(manual, { block: block.id, callout: callout.id }) ??
        i + 1,
    }));
    const markers = numbered.map(
      ({ callout, n }) =>
        `(n: ${calloutNumberLiteral(n)}, ${point(callout.anchor)}, label: ${callout.label ? `(${point(callout.label)})` : 'none'}, style: ${str(callout.style ?? '')})`,
    );
    // Where a legend entry cut off beside the image is reported (#548): its module, image and
    // callout, the IDs as the module has them.
    const origin = manual.origins[block.id];
    const legend = numbered.map(({ callout, n }) => {
      const at = origin
        ? `, at: ${str(`callouts.${origin.module}.${origin.block}.${callout.id}`)}`
        : '';
      return `(n: ${calloutNumberLiteral(n)}, body: [${inline(callout.legend)}]${at})`;
    });
    const placement = (CALLOUT_LEGENDS as readonly string[]).includes(
      block.calloutLegend ?? '',
    )
      ? (block.calloutLegend as string)
      : 'below';
    if (placement === 'beside' && legend.length > 0) hasLegendBeside = true;
    const width =
      typeof block.width === 'number' && Number.isFinite(block.width)
        ? `${block.width}%`
        : 'auto';
    return `callout-image(path: ${str(assetPath(block.asset))}, alt: ${str(block.alt)}, width: ${width}, markers: (${markers.map((m) => `${m},`).join(' ')}), legend: (${legend.map((l) => `${l},`).join(' ')}), placement: ${str(placement)})`;
  };

  const renderTable = (table: Table, level: number): string => {
    // Never a table past the caps (#686), whose grid Typst lays out a place per row and column:
    // content that went through the schema has none.
    assertTableWithinLimits(table);
    const columns = table.columns.map((c) => `${c.width}fr`).join(', ');
    // A column's `left` and `right` are the start and end of the text's direction (#458).
    const aligns = table.columns.map((c) => typstAlign(c.align)).join(', ');
    const cells = table.rows.map((row, r) =>
      row.cells
        .map((cell) => {
          const spans = [
            ...(cell.colspan ? [`colspan: ${cell.colspan}`] : []),
            ...(cell.rowspan ? [`rowspan: ${cell.rowspan}`] : []),
          ];
          const content = `[${blocks(cell.blocks, level)}]`;
          // The header row's cells through the template's `header-cell`, so it styles them.
          if (r === 0 && table.header) {
            return `header-cell(${spans.join(', ')})${content}`;
          }
          return spans.length > 0
            ? `table.cell(${spans.join(', ')})${content}`
            : content;
        })
        .map((c) => (r === 0 && table.header ? c : `  ${c},`))
        .join(r === 0 && table.header ? ', ' : '\n'),
    );
    const [first, ...rest] = cells;
    const body = table.header ? [`  table.header(${first}),`, ...rest] : cells;
    const tableCode = `table(\n  columns: (${columns},),\n  align: (${aligns},),\n${body.join('\n')}\n)`;
    return table.title
      ? `#figure(kind: table, caption: [${inline(table.title)}], ${tableCode})`
      : `#${tableCode}`;
  };

  const entries = (list: readonly ResolvedEntry[], level: number): string =>
    list
      .map((entry) => {
        if (entry.kind === 'group') {
          return [
            `#heading(level: ${level}, ${str(entry.title)})`,
            entries(entry.entries, level + 1),
          ].join('\n\n');
        }
        // Module headings use the module's language, which differs when a translation was missing.
        const heading = `#heading(level: ${level}, ${str(entry.title)})`;
        const body = blocks(entry.blocks, level + 1, true);
        const content = [heading, body].filter(Boolean).join('\n\n');
        return entry.lang === manual.lang
          ? content
          : `#[\n#set text(${langArgs(entry.lang)})\n${content}\n]`;
      })
      .join('\n\n');

  /**
   * The glossary: an unnumbered top-level heading (the `glossary` label),
   * then each term, alphabetical as resolving sorted them, with its anchor
   * (the target of its links) and its definition; a term in another
   * language than the manual's (no translation) typeset in its own.
   */
  const glossary = (): string => {
    const list = [...terms.values()].map((term) => {
      const entry = `#anchor(${str(glossaryLabel(term.id))})#glossary-entry(term: ${str(term.preferred)})[${term.definition ? inline(term.definition) : ''}]`;
      return term.lang === manual.lang
        ? entry
        : `#[\n#set text(${langArgs(term.lang)})\n${entry}\n]`;
    });
    return [
      `#heading(level: 1, numbering: none, ${str(labels.glossary)})`,
      ...list,
    ].join('\n\n');
  };

  const qr = options.qrCode;
  // On a page of its own after everything else; on the title page, the template reads it from
  // the document's state (`qr`). With a design, the design layer's back page prints it (from
  // `sys.inputs`, `QR_INPUT`) and says so in the state `QR_PRINTED`; the page of its own
  // follows only if nothing did, as under a repository's own template that ignores the input.
  const qrCall = qr
    ? `qr-code(path: ${str(qrPath(qr.path))}, url: ${str(qr.url)})`
    : '';
  const backCover =
    qr?.placement !== 'back-cover'
      ? []
      : options.design
        ? [
            `#context if not state(${str(QR_PRINTED)}, false).final() { pagebreak(weak: true); ${qrCall} }`,
          ]
        : [`#pagebreak(weak: true)\n#${qrCall}`];
  const design = options.design;
  const designState = design ? designTexts(design) : undefined;

  const body = [
    entries(manual.entries, 1),
    ...(glossaryShown ? [glossary()] : []),
    ...backCover,
  ].join('\n\n');
  const labelDict = OUTPUT_LABEL_KEYS.map(
    (key) => `${key}: ${str(labels[key])}`,
  ).join(', ');
  const optional = (value: string | undefined) => (value ? str(value) : 'none');
  const documentDict = [
    `language: ${str(languageName(manual.lang))}`,
    `variant: ${optional(options.subtitle)}`,
    `release: ${optional(options.release)}`,
    `date: ${optional(options.date)}`,
    ...(qr?.placement === 'title-page'
      ? [`qr: (path: ${str(qrPath(qr.path))}, url: ${str(qr.url)})`]
      : []),
  ].join(', ');
  const header = [
    '// Generated by @openfolia/render-typst. Do not edit; change the modules and manifest instead.',
    // The title PDF/UA needs, whatever the template does (the default one sets it too);
    // no date, so a PDF/UA document (whose metadata would carry the time) stays reproducible.
    `#set document(title: ${str(manual.title)}, date: none)`,
    // For templates that define no attachment(), header-cell() or faq(): built-in functions only.
    // The glob import below replaces it when the template has its own.
    ATTACHMENT_FALLBACK,
    HEADER_CELL_FALLBACK,
    FAQ_FALLBACK,
    TERM_FALLBACK,
    GLOSSARY_ENTRY_FALLBACK,
    PAGE_FIELD_FALLBACK,
    // Only where the document prints one, so other documents stay as they were.
    ...(backCover.length > 0 ? [QR_CODE_FALLBACK] : []),
    ...(hasCallouts ? [CALLOUT_FALLBACK] : []),
    `#import ${str(options.templatePath ?? 'template.typ')}: *`,
    // Code reads left to right in any text (#458): before the template's show rule too, so code
    // a template puts on its title page, header or footer does as well (#396).
    `#show raw: set text(dir: ltr)`,
    // Before the template, so its title page and contents get the region too,
    // and again after it, so the body keeps it even if the template sets
    // its own. Templates need not know about regions.
    `#set text(${langArgs(manual.lang)})`,
    `#show: manual.with(title: ${str(manual.title)}, subtitle: ${str(options.subtitle ?? '')}, lang: ${str(typstLocale(manual.lang)[0])})`,
    `#set text(${langArgs(manual.lang)})`,
    // Code reads left to right in any text (#458), whatever the template does.
    `#show raw: set text(dir: ltr)`,
    // The template reads them with `state("openfolia-labels").final()`.
    `#state("openfolia-labels", (:)).update((${labelDict}))`,
    // What the title page shows besides the title; read the same way.
    `#state("openfolia-document", (:)).update((${documentDict}))`,
    // The design's texts (#391), as content; its settings come as data (`inputs`).
    ...(designState
      ? [`#state("openfolia-design", (:)).update(${designState})`]
      : []),
  ].join('\n');

  const fonts = new Map<string, { file: string; family: string }>();
  const inputs: Record<string, string> = {};
  if (hasLegendBeside) {
    const asked = options.calloutLabelMinSize;
    const size =
      typeof asked === 'number' && Number.isFinite(asked)
        ? Math.min(
            MAX_CALLOUT_LABEL_SIZE,
            Math.max(MIN_CALLOUT_LABEL_SIZE, asked),
          )
        : DEFAULT_CALLOUT_LABEL_MIN_SIZE;
    // A decimal number Typst's `float` reads (never an exponent: the size is 4 to 12).
    inputs[CALLOUT_MIN_SIZE_INPUT] = String(Math.round(size * 100) / 100);
  }
  if (design && qr?.placement === 'back-cover') {
    inputs[QR_INPUT] = JSON.stringify({ path: qrPath(qr.path), url: qr.url });
  }
  if (design) {
    const hasBackRegions = ['back', 'back-footer'].some(
      (slot) => (design.regions[slot] ?? []).length > 0,
    );
    inputs[DESIGN_INPUT] = JSON.stringify(
      designData(design, { assetPath }, hasBackRegions),
    );
    if (design.logo) {
      assets.add(design.logo.light);
      if (design.logo.dark) assets.add(design.logo.dark);
    }
    if (design.coverImage) assets.add(design.coverImage.asset);
    for (const role of ['body', 'heading'] as const) {
      const font = design.fonts[role];
      if (!font) continue;
      const family = designFontFamily(role);
      for (const file of [
        font.regular,
        font.bold,
        font.italic,
        font.boldItalic,
      ]) {
        if (file) fonts.set(`${family} ${file}`, { file, family });
      }
    }
  }

  return {
    source: `${header}\n\n${body}\n`,
    assets: [...assets],
    symbols: [...symbols],
    fonts: [...fonts.values()],
    inputs,
  };

  /**
   * The design's texts as a Typst dictionary of content: each region's blocks, and each running
   * header's and footer's places as pieces (content, or `(field: key)` for a page placeholder,
   * which the layer fills in per page and can measure and shorten as text).
   */
  function designTexts(d: ResolvedPageDesign): string {
    designText = true;
    try {
      const regions = Object.entries(d.regions)
        .filter(([, list]) => list.length > 0)
        .map(([slot, list]) => `${str(slot)}: [${blocks(list, 1)}]`);
      const pieces = (nodes: readonly Inline[]): string => {
        const out: string[] = [];
        let run: Inline[] = [];
        const flush = () => {
          if (run.length > 0) out.push(`[${inline(run)}]`);
          run = [];
        };
        for (const node of nodes) {
          if (node.type === 'placeholder' && isPagePlaceholder(node.key)) {
            flush();
            out.push(`(field: ${str(node.key)})`);
          } else {
            run.push(node);
          }
        }
        flush();
        return `(${out.map((p) => `${p},`).join(' ')})`;
      };
      const running = (r: ResolvedPageDesign['header']): string => {
        const pages = (['default', 'first', 'even'] as const).flatMap(
          (kind) => {
            const slots = r[kind];
            if (!slots) return [];
            const places = (['left', 'centre', 'right'] as const).flatMap(
              (place) => {
                const nodes = slots[place];
                return nodes && nodes.length > 0
                  ? [`${place}: ${pieces(nodes)}`]
                  : [];
              },
            );
            return [
              `${kind}: (${places.length > 0 ? places.join(', ') : ':'})`,
            ];
          },
        );
        return `(${pages.join(', ')})`;
      };
      return `(regions: (${regions.length > 0 ? regions.join(', ') : ':'}), header: ${running(d.header)}, footer: ${running(d.footer)})`;
    } finally {
      designText = false;
    }
  }
}

/** A file path from the project root, as the template reads images (`/qr/…`). */
function qrPath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * A column's alignment in Typst: `left` and `right` as the text direction's start and end, so
 * a translation into a right-to-left language mirrors its source's table; anything else (none,
 * or a value no model allows) the start.
 */
function typstAlign(align: unknown): 'start' | 'center' | 'end' {
  return align === 'center' ? 'center' : align === 'right' ? 'end' : 'start';
}

/** The language's own name for itself, "Deutsch" for `de`; the tag if the runtime knows none. */
function languageName(tag: string): string {
  try {
    const name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag);
    if (!name) return tag;
    return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1);
  } catch {
    return tag;
  }
}

/** Typst's language and region for a BCP 47 tag: "pt-BR" → ["pt", "BR"]; no region → undefined. */
function typstLocale(tag: string): [string, string | undefined] {
  const [language = tag, ...rest] = tag.split('-');
  const region = rest.find((part) => /^[A-Za-z]{2}$/.test(part));
  return [language.toLowerCase(), region?.toUpperCase()];
}

/** `lang: "pt", region: "BR"`; region `none` when the tag has none, so it is never inherited. */
function typstLangArgs(tag: string): string {
  const [language, region] = typstLocale(tag);
  return `lang: ${str(language)}, region: ${region ? str(region) : 'none'}`;
}

function openMark(mark: Mark): string {
  switch (mark.type) {
    case 'link':
      // Only the model's addresses (absolute http, https, mailto) become a link; any other
      // keeps its text, in a plain content block that the same `]` closes.
      return isLinkHref(mark.href) ? `#link(${str(mark.href)})[` : '#[';
    case 'ui':
      return '#ui[';
    case 'strong':
      return '#strong[';
    case 'emphasis':
      return '#emph[';
    case 'code':
      return '#code-span[';
    case 'sub':
      return '#sub[';
    case 'sup':
      return '#super[';
    case 'term':
      // Opened by `renderTypst` (`openTerm`), which knows the manual's terms.
      throw new Error('a term link is opened by renderTypst');
  }
}

/** `record[key]` when it is the record's own: never a property every object has (`constructor`). */
function ownValue(
  record: Readonly<Record<string, string>>,
  key: string,
): string | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * What a cross-reference to a whole module reads as without its own text: the module's title,
 * from its entry or the resolution's titles of the modules that are none (#796), else its ID.
 */
function moduleTitle(manual: ResolvedManual, module: string): string {
  const find = (list: readonly ResolvedEntry[]): string | undefined => {
    for (const e of list) {
      if (e.kind === 'module' && e.module === module) return e.title;
      if (e.kind === 'group') {
        const t = find(e.entries);
        if (t) return t;
      }
    }
    return undefined;
  };
  return (
    find(manual.entries) ?? ownValue(manual.xrefTitles ?? {}, module) ?? module
  );
}

/** Plain-text section titles by output ID: link text for cross-references to a section without their own text. */
function sectionTitles(manual: ResolvedManual): Map<string, string> {
  const titles = new Map<string, string>();
  const plain = (nodes: readonly Inline[]) =>
    nodes
      .map((n) =>
        n.type === 'text'
          ? n.text
          : n.type === 'hardBreak'
            ? ' '
            : n.type === 'attribute'
              ? `{${n.name}}`
              : '',
      )
      .join('');
  const visit = (list: readonly Block[]): void => {
    for (const b of list) {
      if (b.type === 'section') {
        titles.set(b.id, plain(b.title));
        visit(b.blocks);
      }
    }
  };
  const visitEntries = (list: readonly ResolvedEntry[]): void => {
    for (const e of list) {
      if (e.kind === 'group') visitEntries(e.entries);
      else visit(e.blocks);
    }
  };
  visitEntries(manual.entries);
  return titles;
}

/** Output IDs that some cross-reference links to; only these get anchors. */
function collectTargets(manual: ResolvedManual): Set<string> {
  const targets = new Set<string>();
  const visitInline = (nodes: readonly Inline[]) => {
    for (const n of nodes) {
      if (n.type !== 'xref') continue;
      const target = ownValue(
        manual.anchors,
        n.block ? `${n.module}#${n.block}` : n.module,
      );
      if (target) targets.add(target);
    }
  };
  const visitBlocks = (list: readonly Block[]): void => {
    for (const b of list) {
      switch (b.type) {
        case 'paragraph':
          visitInline(b.content);
          break;
        case 'section':
          visitInline(b.title);
          visitBlocks(b.blocks);
          break;
        case 'list':
        case 'procedure':
          if (b.type === 'procedure' && b.title) visitInline(b.title);
          for (const i of b.type === 'list' ? b.items : b.steps) {
            visitInline(i.content);
            visitBlocks(i.blocks);
          }
          break;
        case 'table':
          if (b.title) visitInline(b.title);
          b.rows.forEach((r) => r.cells.forEach((c) => visitBlocks(c.blocks)));
          break;
        case 'image':
          if (b.title) visitInline(b.title);
          break;
        case 'safety':
          visitInline(b.hazard);
          visitBlocks(b.blocks);
          break;
        case 'faq':
          visitInline(b.question);
          visitBlocks(b.blocks);
          break;
        case 'admonition':
        case 'variant':
          visitBlocks(b.blocks);
          break;
        default:
          break;
      }
    }
  };
  const visitEntries = (list: readonly ResolvedEntry[]): void => {
    for (const e of list) {
      if (e.kind === 'group') visitEntries(e.entries);
      else visitBlocks(e.blocks);
    }
  };
  visitEntries(manual.entries);
  return targets;
}
