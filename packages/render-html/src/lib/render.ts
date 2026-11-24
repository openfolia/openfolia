import {
  placeholderText,
  CALLOUT_LEGENDS,
  calloutNumber,
  CONFIG_KEY_PATTERN,
  directionOf,
  isLinkHref,
  formatFileSize,
  resolveOutputLabels,
  sameMark,
  sortMarks,
  type Block,
  type CalloutPoint,
  type Image,
  type Inline,
  type Item,
  type Mark,
  type OutputLabels,
  type OutputLabelSet,
  type ResolvedEntry,
  type ResolvedManual,
  type ResolvedTerm,
  type Table,
  assertTableWithinLimits,
} from '@openfolia/content-model';
import { escapeHtml as esc, safeUrl } from './escape.js';

export interface HtmlRenderOptions {
  /**
   * The URL of an image, given its SHA-256 (64 lowercase hex digits, without
   * the `sha256:` prefix), e.g. `(hash) => `/assets/${hash}``. Images are
   * only ever linked through it, never by a path from the content.
   */
  assetUrl: (sha256: string) => string;
  /** The URL of a safety symbol's artwork, or undefined to leave the symbol out. */
  symbolUrl?: (symbol: string) => string | undefined;
  /** The symbol's name, as its alternative text (e.g. the configured label). Default: none (decorative). */
  symbolLabel?: (symbol: string) => string | undefined;
  /**
   * The configuration's output labels per language (`ProjectConfig.outputLabels`).
   * The fixed texts follow the manual's language, over the shipped defaults,
   * with English for anything missing (as in the PDF).
   */
  outputLabels?: Readonly<Record<string, OutputLabelSet>>;
  /** Shown under the manual's title, e.g. "L-400 · Software 2.3 · EU". */
  subtitle?: string;
  /**
   * Prefix of every element ID the output defines (and of the fragment
   * links to them), so they cannot clash with the host page's IDs or
   * globals. Letters, digits, "_" and "-", starting with a letter.
   * Default `of-`.
   */
  idPrefix?: string;
  /** Heading level of the outermost title (the manual's, or the module's): 1 to 6. Default 1. */
  headingLevel?: number;
  /** Whether a manual starts with a table of contents. Default true. */
  toc?: boolean;
  /**
   * The link for a cross-reference, e.g. to another page of a portal.
   * `id` is the target's output ID when it is part of the manual, without
   * the prefix. Return undefined for the default: a fragment link when the
   * target is part of what is rendered, else plain text.
   */
  xrefHref?: (target: XrefTarget) => string | undefined;
  /**
   * The editor's preview, which shows what readers never see: a page break
   * as a marker ("Page break (PDF)"), and a text attribute the preview has
   * no value for (a module previewed without a manual) as a chip with the
   * attribute's label. Leave it out for the HTML readers get: there a page
   * break shows nothing, and an attribute without a value stays `{name}`.
   */
  preview?: PreviewOptions;
}

export interface PreviewOptions {
  /** The text attribute's label (`ProjectConfig.textAttributes`), for its chip. Default: its name. */
  attributeLabel?: (name: string) => string | undefined;
}

/**
 * The preview's own texts, in the manual's language (its primary subtag),
 * English for any other. They are not output labels: no output prints them.
 */
export const PREVIEW_LABELS: Readonly<
  Record<string, { pageBreak: string; attributeNotSet: string }>
> = {
  en: {
    pageBreak: 'Page break (PDF)',
    attributeNotSet: 'Not set for this preview',
  },
  de: {
    pageBreak: 'Seitenumbruch (PDF)',
    attributeNotSet: 'In dieser Vorschau nicht gesetzt',
  },
  fr: {
    pageBreak: 'Saut de page (PDF)',
    attributeNotSet: 'Non défini pour cet aperçu',
  },
};

export interface XrefTarget {
  module: string;
  block?: string;
  /**
   * The output ID it resolves to in this manual (`ResolvedManual.anchors`),
   * if any. For a link to a whole module that is the module's first block;
   * the module's own section has the module ID.
   */
  id?: string;
}

export interface HtmlRenderResult {
  /** An HTML fragment (no `<html>` or `<body>`): one `<article class="of-content …">`. */
  html: string;
  /** Image assets the fragment uses (`sha256:…`), each linked through `assetUrl`. */
  assets: string[];
  /** Attached files the fragment links for download (`sha256:…`), through `assetUrl` too. */
  attachments: string[];
  /** Safety symbols the fragment shows. */
  symbols: string[];
}

/** Thrown for input the renderer cannot take: an unresolved block, an invalid option. */
export class HtmlRenderError extends Error {
  override name = 'HtmlRenderError';
}

/** Ends in "-" or "_", so a prefixed ID is never a JavaScript identifier a global could be clobbered by. */
const ID_PREFIX = /^[A-Za-z][A-Za-z0-9_-]*[-_]$/;
const LANG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
const ASSET = /^sha256:([a-f0-9]{64})$/;
const MEDIA_TYPE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9+#._-]*$/;

/** Renders a whole resolved manual: title, table of contents, groups and modules. */
export function renderManualHtml(
  manual: ResolvedManual,
  options: HtmlRenderOptions,
): HtmlRenderResult {
  const r = new Renderer(manual, options, manual.entries);
  return r.renderManual();
}

/**
 * Renders one module of a resolved manual (its first occurrence) on its
 * own: figures and tables count from 1, and cross-references to anything
 * outside it are plain text unless `xrefHref` links them.
 * Undefined when the manual does not contain the module as an entry.
 *
 * To preview a single module, resolve a manifest that lists only it.
 */
export function renderModuleHtml(
  manual: ResolvedManual,
  module: string,
  options: HtmlRenderOptions,
): HtmlRenderResult | undefined {
  const entry = findEntry(manual.entries, module);
  if (!entry) return undefined;
  const r = new Renderer(manual, options, [entry]);
  return r.renderModule(entry);
}

type ModuleEntry = Extract<ResolvedEntry, { kind: 'module' }>;

class Renderer {
  private readonly prefix: string;
  private readonly level: number;
  private readonly labels: OutputLabels;
  private readonly previewLabels: (typeof PREVIEW_LABELS)[string];
  private readonly assets = new Set<string>();
  private readonly attachments = new Set<string>();
  private readonly symbols = new Set<string>();
  /** Output IDs (and module IDs) that are part of what is rendered: default fragment links go only to these. */
  private readonly rendered: Set<string>;
  /** Modules whose section got the module's ID (the first occurrence). */
  private readonly moduleIds = new Set<string>();
  private readonly sectionTitles: Map<string, string>;
  private figures = 0;
  private tables = 0;
  /** Term links rendered so far: each one's definition gets an ID of its own. */
  private termLinks = 0;
  /** The manual's linked terms by ID (`ResolvedManual.terms`). */
  private readonly terms: ReadonlyMap<string, ResolvedTerm>;
  /** Whether the glossary is part of what is rendered (a whole manual asking for one). */
  private glossaryShown = false;
  /** The term links open in `inline`, innermost last (undefined: a term the manual has not). */
  private readonly openTerms: (
    { term: ResolvedTerm; tip: string | undefined } | undefined
  )[] = [];
  /** The language of the module being rendered: it differs from the manual's when a translation was missing. */
  private contentLang: string;

  constructor(
    private readonly manual: ResolvedManual,
    private readonly options: HtmlRenderOptions,
    entries: readonly ResolvedEntry[],
  ) {
    const prefix = options.idPrefix ?? 'of-';
    if (!ID_PREFIX.test(prefix)) {
      throw new HtmlRenderError(
        `idPrefix must be letters, digits, "_" and "-", starting with a letter and ending in "-" or "_"; got "${prefix}"`,
      );
    }
    const level = options.headingLevel ?? 1;
    if (!Number.isInteger(level) || level < 1 || level > 6) {
      throw new HtmlRenderError(
        `headingLevel must be a whole number from 1 to 6; got ${level}`,
      );
    }
    if (typeof options.assetUrl !== 'function') {
      throw new HtmlRenderError('assetUrl is required');
    }
    this.prefix = prefix;
    this.level = level;
    this.contentLang = manual.lang;
    this.labels = resolveOutputLabels(manual.lang, options.outputLabels).labels;
    const primary = manual.lang.split('-')[0]?.toLowerCase() ?? '';
    this.previewLabels = Object.hasOwn(PREVIEW_LABELS, primary)
      ? (PREVIEW_LABELS[primary] as (typeof PREVIEW_LABELS)[string])
      : (PREVIEW_LABELS['en'] as (typeof PREVIEW_LABELS)[string]);
    this.rendered = collectIds(entries);
    this.sectionTitles = sectionTitles(manual.entries);
    this.terms = new Map(
      (Array.isArray(manual.terms) ? manual.terms : []).map((t) => [t.id, t]),
    );
  }

  renderManual(): HtmlRenderResult {
    const { manual, level } = this;
    const subtitle = this.options.subtitle
      ? `<p class="of-manual__subtitle">${esc(this.options.subtitle)}</p>`
      : '';
    const header = `<header class="of-manual__header">${heading(level, 'of-manual__title', esc(manual.title))}${subtitle}</header>`;
    this.glossaryShown = manual.glossary === true && this.terms.size > 0;
    const toc =
      (this.options.toc ?? true) && manual.entries.length > 0
        ? this.toc(manual.entries)
        : '';
    const body = this.entries(manual.entries, level + 1);
    const glossary = this.glossaryShown ? this.glossary(level + 1) : '';
    return this.result(
      `<article class="of-content of-manual"${this.langAttr(manual.lang)}>${header}${toc}${body}${glossary}</article>`,
    );
  }

  /**
   * The generated glossary (#245): the terms the manual links, in the order
   * resolving gives them (alphabetical in the manual's language), each its
   * preferred variant and definition, the target of the term links. A term
   * in another language (its translation missing) says so.
   */
  private glossary(level: number): string {
    const entries = [...this.terms.values()]
      .map((term) => {
        // In the term's own language (a fallback's), so its code is isolated by its direction.
        this.contentLang = term.lang;
        const definition = term.definition
          ? this.inline(term.definition, true, false)
          : '';
        this.contentLang = this.manual.lang;
        return `<div class="of-glossary__entry"${this.idAttr(glossaryId(term.id))}${term.lang === this.manual.lang ? '' : this.langAttr(term.lang)}><dt class="of-glossary__term"><dfn>${esc(term.preferred)}</dfn></dt> <dd class="of-glossary__definition">${definition}</dd></div>`;
      })
      .join('');
    return `<section class="of-glossary"${this.idAttr(GLOSSARY_ID)}>${heading(level, 'of-glossary__title', esc(this.labels.glossary), this.idAttr(headingIdOf(GLOSSARY_ID)))}<dl class="of-glossary__list">${entries}</dl></section>`;
  }

  renderModule(entry: ModuleEntry): HtmlRenderResult {
    return this.result(
      this.moduleSection(entry, this.level, 'article', 'of-content '),
    );
  }

  private result(html: string): HtmlRenderResult {
    return {
      html,
      assets: [...this.assets],
      attachments: [...this.attachments],
      symbols: [...this.symbols],
    };
  }

  // -------------------------------------------------------------------------
  // Manual structure

  private toc(list: readonly ResolvedEntry[]): string {
    const seen = new Set<string>();
    const items = (entries: readonly ResolvedEntry[], last = ''): string =>
      `<ol class="of-toc__list">${entries
        .map((e) => {
          if (e.kind === 'group') {
            return `<li class="of-toc__item of-toc__item--group"><span class="of-toc__group">${esc(e.title)}</span>${items(e.entries)}</li>`;
          }
          const first = !seen.has(e.module);
          seen.add(e.module);
          const title = this.otherLang(e.lang, esc(e.title));
          const text = first
            ? `<a class="of-toc__link" href="#${esc(this.prefix + e.module)}">${title}</a>`
            : title;
          return `<li class="of-toc__item">${text}</li>`;
        })
        .join('')}${last}</ol>`;
    // The glossary is the last entry, after the modules.
    const glossary = this.glossaryShown
      ? `<li class="of-toc__item"><a class="of-toc__link" href="#${esc(this.prefix + GLOSSARY_ID)}">${esc(this.labels.glossary)}</a></li>`
      : '';
    return `<nav class="of-toc" aria-label="${esc(this.labels.contents)}">${heading(this.level + 1, 'of-toc__title', esc(this.labels.contents))}${items(list, glossary)}</nav>`;
  }

  private entries(list: readonly ResolvedEntry[], level: number): string {
    return list
      .map((entry) =>
        entry.kind === 'group'
          ? `<section class="of-group">${heading(level, 'of-group__title', esc(entry.title))}${this.entries(entry.entries, level + 1)}</section>`
          : this.moduleSection(entry, level, 'section', ''),
      )
      .join('');
  }

  private moduleSection(
    entry: ModuleEntry,
    level: number,
    tag: 'section' | 'article',
    extraClass: string,
  ): string {
    // A module listed twice gets its ID (the target of links to it) once.
    const id = this.moduleIds.has(entry.module)
      ? ''
      : this.idAttr(entry.module);
    this.moduleIds.add(entry.module);
    this.contentLang = entry.lang;
    // A module that fell back to the source language says so, for screen readers and hyphenation.
    const lang =
      tag === 'article'
        ? this.langAttr(entry.lang)
        : entry.lang === this.manual.lang
          ? ''
          : this.langAttr(entry.lang);
    const headingId = id === '' ? '' : this.idAttr(headingIdOf(entry.module));
    const html = `<${tag} class="${extraClass}of-module"${id}${lang}>${heading(level, 'of-module__title', esc(entry.title), headingId)}${this.blocks(entry.blocks, level + 1, true)}</${tag}>`;
    this.contentLang = this.manual.lang;
    return html;
  }

  /** Text in `lang` inside content in the manual's language: wrapped so it carries its own language. */
  private otherLang(lang: string, html: string): string {
    return lang === this.manual.lang
      ? html
      : `<span${this.langAttr(lang)}>${html}</span>`;
  }

  /**
   * The `lang` of a fixed label: the labels are in the manual's language, so
   * inside a module that fell back to another language they say so.
   */
  private labelLang(): string {
    return this.contentLang === this.manual.lang
      ? ''
      : this.langAttr(this.manual.lang);
  }

  // -------------------------------------------------------------------------
  // Blocks

  /**
   * `flow`: directly in a module or a section, where a page can break (as
   * in the PDF, a page break anywhere else, brought in by a module
   * reference, does nothing and shows nothing).
   */
  private blocks(list: readonly Block[], level: number, flow = false): string {
    return list
      .map((block) =>
        block.type === 'pageBreak'
          ? flow
            ? this.pageBreak(block)
            : ''
          : this.block(block, level, flow),
      )
      .join('');
  }

  /** In the preview a labelled marker; in what readers get, nothing. */
  private pageBreak(block: Extract<Block, { type: 'pageBreak' }>): string {
    if (!this.options.preview) return '';
    return `<div class="of-page-break" role="separator" aria-label="${esc(this.previewLabels.pageBreak)}"${this.idAttr(block.id)}${this.labelLang()}><span class="of-page-break__label" aria-hidden="true">${esc(this.previewLabels.pageBreak)}</span></div>`;
  }

  /**
   * One renderer per block type: the switch is exhaustive, so a block type
   * added to the model (an FAQ block, say) fails to compile here until it
   * has one, and the test over the model's schema fails until it is tested.
   */
  private block(block: Block, level: number, flow = false): string {
    const id = this.idAttr(block.id);
    switch (block.type) {
      case 'paragraph':
        return `<p class="of-paragraph"${id}>${this.inline(block.content)}</p>`;
      case 'section':
        return `<section class="of-section"${id}>${heading(level, 'of-section__title', this.inline(block.title), this.idAttr(headingIdOf(block.id)))}${this.blocks(block.blocks, level + 1, flow)}</section>`;
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        return `<${tag} class="of-list of-list--${block.ordered ? 'ordered' : 'unordered'}"${id}>${block.items
          .map((item) => this.item(item, 'of-list__item', level))
          .join('')}</${tag}>`;
      }
      case 'procedure': {
        const title = block.title
          ? `<p class="of-procedure__title">${this.inline(block.title)}</p>`
          : '';
        return `<div class="of-procedure"${id}>${title}<ol class="of-procedure__steps" role="list">${block.steps
          .map((step) => this.item(step, 'of-procedure__step', level))
          .join('')}</ol></div>`;
      }
      case 'table':
        return this.table(block, id, level);
      case 'image':
        return this.image(block, id);
      case 'attachment':
        return this.attachment(block, id);
      case 'safety': {
        const severity = SEVERITIES.has(block.severity)
          ? block.severity
          : 'warning';
        const symbols = this.safetySymbols(block.symbols);
        return `<div class="of-safety of-safety--${severity}" role="note"${id}><p class="of-safety__signal"${this.labelLang()}>${esc(this.labels[severity])}</p><div class="of-safety__body">${symbols}<div class="of-safety__content"><p class="of-safety__hazard">${this.inline(block.hazard)}</p>${this.blocks(block.blocks, level)}</div></div></div>`;
      }
      case 'admonition': {
        const kind = KINDS.has(block.kind) ? block.kind : 'note';
        return `<div class="of-admonition of-admonition--${kind}" role="note"${id}><p class="of-admonition__label"${this.labelLang()}>${esc(this.labels[kind])}</p>${this.blocks(block.blocks, level)}</div>`;
      }
      case 'faq':
        // A disclosure: the browser makes the question a button, focusable and
        // toggled with Enter or Space, and tells screen readers whether it is open.
        return `<details class="of-faq"${id}><summary class="of-faq__question">${this.inline(block.question)}</summary><div class="of-faq__answer">${this.blocks(block.blocks, level)}</div></details>`;
      case 'literal': {
        const language =
          block.language && TOKEN.test(block.language)
            ? ` data-language="${esc(block.language)}"`
            : '';
        return `<pre class="of-literal"${id}${language}${this.ltrIsolate()}><code>${esc(block.text)}</code></pre>`;
      }
      case 'passthrough':
        // Refused, never interpreted: the raw source shows as text, marked as unconverted.
        return `<div class="of-unconverted" role="note"${id}><p class="of-unconverted__label"${this.labelLang()}>${esc(this.labels.unconverted)} <span class="of-unconverted__format">(${esc(block.format)})</span></p><pre class="of-unconverted__source"${this.ltrIsolate()}><code>${esc(block.raw)}</code></pre></div>`;
      case 'pageBreak':
        // Written by `blocks`, which knows whether a page can break there.
        return '';
      case 'variant':
      case 'moduleRef':
        throw new HtmlRenderError(
          `the HTML renderer expects a resolved manual, but found a ${block.type} block ("${block.id}")`,
        );
      default:
        block satisfies never;
        throw new HtmlRenderError(
          `no renderer for block type "${(block as { type: unknown }).type}"`,
        );
    }
  }

  private item(item: Item, className: string, level: number): string {
    return `<li class="${className}"${this.idAttr(item.id)}><p class="of-item__text">${this.inline(item.content)}</p>${this.blocks(item.blocks, level)}</li>`;
  }

  private image(block: Extract<Block, { type: 'image' }>, id: string): string {
    const hash = ASSET.exec(block.asset)?.[1];
    const url =
      hash === undefined ? undefined : safeUrl(this.options.assetUrl(hash));
    if (url !== undefined) this.assets.add(block.asset);
    const src = url === undefined ? '' : ` src="${esc(url)}"`;
    const width = percent(block.width);
    const style = width === undefined ? '' : ` style="width:${width}%"`;
    const callouts = block.callouts ?? [];
    // With callouts, the width goes to the picture the markers are drawn over.
    const img = `<img class="of-figure__image"${src} alt="${esc(block.alt)}"${callouts.length > 0 ? '' : style} loading="lazy" decoding="async">`;
    const picture =
      callouts.length > 0 ? this.callouts(block, img, style) : img;
    if (!block.title) return `<div class="of-image"${id}>${picture}</div>`;
    this.figures++;
    return `<figure class="of-figure"${id}>${picture}<figcaption class="of-caption"><span class="of-caption__label"${this.labelLang()}>${esc(`${this.labels.figure} ${this.figures}`)}:</span> ${this.inline(block.title)}</figcaption></figure>`;
  }

  /**
   * An image with its callouts (#546): the picture with an SVG over it that draws the leader
   * lines and the numbered markers at their places (percentages of the picture, so they scale
   * with it and need no size; image coordinates, never mirrored), and the legend under or
   * beside it (which follows the text's direction), or none. The markers repeat the legend, so
   * the drawing is hidden from screen readers. Every value is a number formatted here or escaped
   * text; a style key is written only when it is a configuration key.
   */
  private callouts(block: Image, img: string, style: string): string {
    const numbered = (block.callouts ?? []).map((callout, i) => ({
      callout,
      n:
        calloutNumber(this.manual, { block: block.id, callout: callout.id }) ??
        i + 1,
    }));
    const lines = numbered
      .filter(({ callout }) => callout.label)
      .map(({ callout }) => {
        const a = svgPoint(callout.anchor);
        const b = svgPoint(callout.label as CalloutPoint);
        const key = calloutKey(block.id, callout.id);
        return `<line class="of-callouts__leader"${key} x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"></line><circle class="of-callouts__anchor"${key} cx="${a.x}" cy="${a.y}" r="2.5"></circle>`;
      });
    const markers = numbered.map(({ callout, n }) => {
      const at = svgPoint(callout.label ?? callout.anchor);
      const kind =
        callout.style !== undefined && CONFIG_KEY_PATTERN.test(callout.style)
          ? ` data-callout-style="${esc(callout.style)}"`
          : '';
      return `<g class="of-callouts__marker"${calloutKey(block.id, callout.id)}${kind}><circle cx="${at.x}" cy="${at.y}" r="10"></circle><text x="${at.x}" y="${at.y}" text-anchor="middle" dominant-baseline="central">${esc(numberText(n))}</text></g>`;
    });
    const svg = `<svg class="of-callouts__overlay" width="100%" height="100%" aria-hidden="true" focusable="false">${lines.join('')}${markers.join('')}</svg>`;
    const placement = (CALLOUT_LEGENDS as readonly string[]).includes(
      block.calloutLegend ?? '',
    )
      ? (block.calloutLegend as string)
      : 'below';
    const legend =
      placement === 'none'
        ? ''
        : `<ol class="of-callouts__legend" role="list">${numbered
            .map(
              ({ callout, n }) =>
                `<li class="of-callouts__entry"${calloutKey(block.id, callout.id)}>${calloutBadge('of-callout-number', n)} <span class="of-callouts__text">${this.inline(callout.legend)}</span></li>`,
            )
            .join('')}</ol>`;
    return `<div class="of-callouts of-callouts--${placement}"><div class="of-callouts__picture"${style}>${img}${svg}</div>${legend}</div>`;
  }

  /**
   * A download link to the file (through `assetUrl`, as images are; the
   * server sends it as a download), with its name, file name, type and
   * size, and the description below. An invalid reference leaves the name
   * without a link.
   */
  private attachment(
    block: Extract<Block, { type: 'attachment' }>,
    id: string,
  ): string {
    const hash = ASSET.exec(block.asset)?.[1];
    const url =
      hash === undefined ? undefined : safeUrl(this.options.assetUrl(hash));
    if (url !== undefined) this.attachments.add(block.asset);
    const type = MEDIA_TYPE.test(block.mediaType)
      ? ` type="${esc(block.mediaType)}"`
      : '';
    const name = `<span class="of-attachment__name">${esc(block.name)}</span>`;
    const link =
      url === undefined
        ? name
        : `<a class="of-attachment__link" href="${esc(url)}" download="${esc(block.fileName)}"${type}>${name}</a>`;
    const size =
      Number.isSafeInteger(block.size) && block.size >= 0
        ? `, <span class="of-attachment__size">${esc(formatFileSize(block.size, this.manual.lang))}</span>`
        : '';
    const facts = `<span class="of-attachment__facts">(<span class="of-attachment__file">${esc(block.fileName)}</span>, <span class="of-attachment__type">${esc(block.mediaType)}</span>${size})</span>`;
    const description =
      block.description === undefined
        ? ''
        : `<p class="of-attachment__description">${esc(block.description)}</p>`;
    return `<div class="of-attachment"${id}><p class="of-attachment__line"><span class="of-attachment__label"${this.labelLang()}>${esc(this.labels.attachment)}:</span> ${link} ${facts}</p>${description}</div>`;
  }

  private safetySymbols(ids: readonly string[]): string {
    const images = ids.flatMap((symbol) => {
      const raw = this.options.symbolUrl?.(symbol);
      const url = raw === undefined ? undefined : safeUrl(raw);
      if (url === undefined) return [];
      this.symbols.add(symbol);
      const label = this.options.symbolLabel?.(symbol) ?? '';
      return [
        `<img class="of-safety__symbol" src="${esc(url)}" alt="${esc(label)}">`,
      ];
    });
    return images.length > 0
      ? `<div class="of-safety__symbols">${images.join('')}</div>`
      : '';
  }

  private table(table: Table, id: string, level: number): string {
    // Never a table past the caps (#686), whose grid costs a place per row and column: content
    // that went through the schema has none.
    assertTableWithinLimits(table);
    const columns = table.columns.length;
    const total = table.columns.reduce(
      (sum, c) => sum + (positive(c.width) ?? 0),
      0,
    );
    const colgroup =
      total > 0
        ? `<colgroup>${table.columns
            .map((c) => {
              const share = percent(((positive(c.width) ?? 0) / total) * 100);
              return share === undefined
                ? '<col>'
                : `<col style="width:${share}%">`;
            })
            .join('')}</colgroup>`
        : '';
    let caption = '';
    if (table.title) {
      this.tables++;
      caption = `<caption class="of-caption"><span class="of-caption__label"${this.labelLang()}>${esc(`${this.labels.table} ${this.tables}`)}:</span> ${this.inline(table.title)}</caption>`;
    }
    // Which grid columns each row's cells start in, accounting for cells spanning rows above.
    const taken: number[] = [];
    const rows = table.rows.map((row, r) => {
      const head = table.header && r === 0;
      let column = 0;
      const cells = row.cells.map((cell) => {
        while ((taken[column] ?? 0) > r) column++;
        const colspan = span(cell.colspan);
        // A header cell cannot span into the body: browsers clip it at the row group.
        const rowspan = head ? 1 : span(cell.rowspan);
        for (let c = column; c < column + colspan; c++) taken[c] = r + rowspan;
        const align =
          column < columns ? table.columns[column]?.align : undefined;
        column += colspan;
        const tag = head ? 'th' : 'td';
        const attrs = [
          head ? ' scope="col"' : '',
          colspan > 1 ? ` colspan="${colspan}"` : '',
          rowspan > 1 ? ` rowspan="${rowspan}"` : '',
        ].join('');
        const alignClass =
          align === 'center' || align === 'right'
            ? ` of-table__cell--${align}`
            : '';
        return `<${tag} class="of-table__cell${alignClass}"${attrs}>${this.blocks(cell.blocks, level)}</${tag}>`;
      });
      return `<tr>${cells.join('')}</tr>`;
    });
    const [first, ...rest] = rows;
    const body = table.header
      ? `<thead>${first ?? ''}</thead><tbody>${rest.join('')}</tbody>`
      : `<tbody>${rows.join('')}</tbody>`;
    // The wrapper scrolls sideways, so a wide table never widens the page.
    return `<div class="of-table"${id}><table class="of-table__table">${caption}${colgroup}${body}</table></div>`;
  }

  // -------------------------------------------------------------------------
  // Inline content

  /**
   * Marks open in canonical order and stay open across runs that share them, as in the PDF.
   * `allowLinks` false: no link (a cross-reference's text); `allowTerms` false: no term link
   * (a definition, shown where a term link is).
   */
  private inline(
    nodes: readonly Inline[],
    allowLinks = true,
    allowTerms = allowLinks,
  ): string {
    let out = '';
    const stack: Mark[] = [];
    const closeTo = (depth: number) => {
      while (stack.length > depth) {
        const mark = stack.pop() as Mark;
        out += mark.type === 'term' ? this.closeTerm() : closeMark(mark);
      }
    };
    for (const node of nodes) {
      const marks =
        node.type === 'text'
          ? sortMarks(node.marks ?? []).filter(
              (m) =>
                (allowLinks || m.type !== 'link') &&
                (allowTerms || m.type !== 'term'),
            )
          : [];
      let keep = 0;
      while (
        keep < stack.length &&
        keep < marks.length &&
        sameMark(stack[keep] as Mark, marks[keep] as Mark)
      )
        keep++;
      closeTo(keep);
      for (const mark of marks.slice(keep)) {
        out +=
          mark.type === 'term'
            ? this.openTerm(mark.termId)
            : openMark(mark, this.ltrIsolate());
        stack.push(mark);
      }
      out += this.inlineNode(node);
    }
    closeTo(0);
    return out;
  }

  /**
   * A term link (#245): the text, a link to the term's glossary entry when
   * the glossary is rendered (else focusable text), with the definition in
   * a tooltip the stylesheet shows on hover and on keyboard focus, and
   * screen readers announce as its description. A term the manual has no
   * entry for is plain text.
   */
  private openTerm(termId: string): string {
    const term = this.terms.get(termId);
    if (!term) {
      this.openTerms.push(undefined);
      return '<span class="of-term of-term--unresolved">';
    }
    const tip = term.definition ? `_term-tip-${++this.termLinks}` : undefined;
    this.openTerms.push({ term, tip });
    const described =
      tip === undefined ? '' : ` aria-describedby="${esc(this.prefix + tip)}"`;
    const inner = this.glossaryShown
      ? `<a class="of-term__link" href="#${esc(this.prefix + glossaryId(term.id))}"${described}>`
      : `<span class="of-term__link"${tip === undefined ? '' : ' tabindex="0"'}${described}>`;
    return `<span class="of-term">${inner}`;
  }

  /** Closes the innermost term link: its link, then its definition's tooltip after it. */
  private closeTerm(): string {
    const open = this.openTerms.pop();
    if (!open) return '</span>';
    const close = this.glossaryShown ? '</a>' : '</span>';
    const { term, tip } = open;
    if (tip === undefined || !term.definition) return `${close}</span>`;
    const lang = term.lang === this.contentLang ? '' : this.langAttr(term.lang);
    return `${close}<span class="of-term__definition" role="tooltip" data-pagefind-ignore${this.idAttr(tip)}${lang}>${this.inline(term.definition, true, false)}</span></span>`;
  }

  private inlineNode(node: Inline): string {
    switch (node.type) {
      case 'text':
        return esc(node.text);
      case 'attribute':
        // Normally filled in by resolveManual; left when there was no value.
        return this.attribute(node.name);
      case 'xref':
        return this.xref(node);
      case 'kbd':
        return `<kbd class="of-kbd"${this.ltrIsolate()}>${node.keys
          .map((key) => `<kbd class="of-kbd__key">${esc(key)}</kbd>`)
          .join('<span class="of-kbd__separator">+</span>')}</kbd>`;
      case 'calloutRef':
        return this.calloutRef(node);
      case 'hardBreak':
        return '<br>';
      case 'placeholder':
        // A page design's data field: filled in on a design's pages, never in a module's text.
        return esc(placeholderText(node.key));
      default:
        node satisfies never;
        throw new HtmlRenderError(
          `no renderer for inline type "${(node as { type: unknown }).type}"`,
        );
    }
  }

  /**
   * A text attribute without a value: in the preview a chip with its label,
   * saying it is not set there (a module previewed without a manual); in
   * what readers get, `{name}` as it is.
   */
  private attribute(name: string): string {
    const preview = this.options.preview;
    if (!preview)
      return `<span class="of-attribute of-attribute--missing">${esc(`{${name}}`)}</span>`;
    const label = preview.attributeLabel?.(name) || name;
    return `<span class="of-attribute of-attribute--unset" title="${esc(this.previewLabels.attributeNotSet)}"${this.labelLang()}>${esc(label)}</span>`;
  }

  private xref(node: Extract<Inline, { type: 'xref' }>): string {
    const id = ownValue(
      this.manual.anchors,
      node.block ? `${node.module}#${node.block}` : node.module,
    );
    const text = node.text?.length
      ? this.inline(
          node.text.filter((n) => n.type === 'text'),
          false,
        )
      : esc(
          (node.block && id && this.sectionTitles.get(id)) ||
            moduleTitle(this.manual, node.module),
        );
    const custom = this.options.xrefHref?.({
      module: node.module,
      ...(node.block ? { block: node.block } : {}),
      ...(id ? { id } : {}),
    });
    let href: string | undefined;
    if (custom !== undefined) {
      href = safeUrl(custom);
    } else if (!node.block && this.isEntry(node.module)) {
      href = `#${this.prefix}${node.module}`;
    } else if (id !== undefined && this.rendered.has(id)) {
      href = `#${this.prefix}${id}`;
    }
    return href === undefined
      ? `<span class="of-xref of-xref--unresolved">${text}</span>`
      : `<a class="of-xref" href="${esc(href)}">${text}</a>`;
  }

  /**
   * A callout reference: its callout's number in this variant (#498), "?" (muted) for one it
   * hides or that is missing. A numbered one links to its image (#549), so it takes the keyboard
   * focus and leads to the picture without script, and carries its callout's key
   * (`data-callout`) for a host's hover highlighting (`highlightCallouts`).
   */
  private calloutRef(node: Extract<Inline, { type: 'calloutRef' }>): string {
    const n = calloutNumber(this.manual, node);
    const text = numberText(n);
    if (text === '?' || !this.rendered.has(node.block))
      return calloutBadge('of-callout-ref', n);
    return `<a class="of-callout-ref" href="#${esc(this.prefix + node.block)}"${calloutKey(node.block, node.callout)}>${esc(text)}</a>`;
  }

  /** Whether the module is a rendered entry (so its section carries the module's ID). */
  private isEntry(module: string): boolean {
    return this.rendered.has(`module:${module}`);
  }

  // -------------------------------------------------------------------------
  // Attributes

  private idAttr(id: string): string {
    return ` id="${esc(this.prefix + id)}"`;
  }

  /**
   * `lang` and `dir` for an element whose text is in `lang`: the direction as the manual's
   * configuration gives it (`directionOf`), so a fallback module or term in a language of the
   * other direction runs, and is isolated, in its own.
   */
  private langAttr(lang: string): string {
    return LANG.test(lang)
      ? ` lang="${esc(lang)}" dir="${directionOf(this.manual, lang)}"`
      : '';
  }

  /**
   * ` dir="ltr"` for code (a code span, a literal block, a keyboard shortcut) in right-to-left
   * text: code reads left to right, and as its own isolated run it keeps its characters' order
   * (`E-104`, `a/b`) among the text around it. Nothing in left-to-right text.
   */
  private ltrIsolate(): string {
    return directionOf(this.manual, this.contentLang) === 'rtl'
      ? ' dir="ltr"'
      : '';
  }
}

/** The glossary's output ID: starting with `_`, it is no module's or block's. */
const GLOSSARY_ID = '_glossary';

/** A glossary entry's output ID. */
const glossaryId = (termId: string) => `_term-${termId}`;

const SEVERITIES = new Set(['danger', 'warning', 'caution', 'notice'] as const);
const KINDS = new Set(['note', 'tip', 'important'] as const);

/**
 * The output ID of the heading of a module, a section or the glossary (#784): its own ID under
 * `_h-`, so it is no module's or block's. A search index (Pagefind) finds a page's passages by
 * headings that carry an ID.
 */
export const headingIdOf = (id: string) => `_h-${id}`;

/**
 * A heading of level 1 to 6; deeper levels are an `<h6>` with their real `aria-level`. `id` is
 * the attribute (` id="…"`) or empty.
 */
function heading(
  level: number,
  className: string,
  content: string,
  id = '',
): string {
  const tag = `h${Math.min(level, 6)}`;
  const aria = level > 6 ? ` aria-level="${level}"` : '';
  return `<${tag} class="${className}"${id}${aria}>${content}</${tag}>`;
}

/**
 * A link mark's address if it may be one: only the model's (`isLinkHref`: an absolute http,
 * https or mailto address), and only what `safeUrl` lets into an attribute. A resolved manual
 * may come from anywhere, so the renderer checks again.
 */
function linkHref(href: string): string | undefined {
  return isLinkHref(href) ? safeUrl(href) : undefined;
}

/** `ltr`: the ` dir="ltr"` code spans get in right-to-left text (or nothing). */
function openMark(mark: Mark, ltr: string): string {
  switch (mark.type) {
    case 'link': {
      const href = linkHref(mark.href);
      // A refused URL keeps its text, without a link.
      return href === undefined
        ? '<span class="of-link of-link--refused">'
        : `<a class="of-link" href="${esc(href)}" rel="noopener noreferrer">`;
    }
    case 'ui':
      return '<span class="of-ui">';
    case 'strong':
      return '<strong>';
    case 'emphasis':
      return '<em>';
    case 'code':
      return `<code class="of-code"${ltr}>`;
    case 'sub':
      return '<sub>';
    case 'sup':
      return '<sup>';
    case 'term':
      // The renderer's own (`openTerm`): it needs the manual's terms.
      throw new HtmlRenderError('a term link is opened by the renderer');
    default:
      mark satisfies never;
      throw new HtmlRenderError(
        `no renderer for mark type "${(mark as { type: unknown }).type}"`,
      );
  }
}

function closeMark(mark: Mark): string {
  switch (mark.type) {
    case 'link':
      return linkHref(mark.href) === undefined ? '</span>' : '</a>';
    case 'ui':
      return '</span>';
    case 'strong':
      return '</strong>';
    case 'emphasis':
      return '</em>';
    case 'code':
      return '</code>';
    case 'sub':
      return '</sub>';
    case 'sup':
      return '</sup>';
    case 'term':
      throw new HtmlRenderError('a term link is closed by the renderer');
    default:
      mark satisfies never;
      return '';
  }
}

/** A colspan or rowspan: a whole number from 1 to 100, anything else counts as 1. */
function span(value: number | undefined): number {
  return Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 100
    ? (value as number)
    : 1;
}

function positive(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** A callout's number as text: a whole number from 1, else "?" (a callout the variant does not show). */
function numberText(n: number | undefined): string {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0
    ? String(n)
    : '?';
}

/** An image's output ID, as written in a callout's key. */
const CALLOUT_IMAGE_ID = /^[a-z0-9_-]{1,200}$/;
/** A callout's ID (a block ID), as written in a callout's key. */
const CALLOUT_ID = /^[a-z_][a-z0-9_-]{0,63}$/;

/**
 * ` data-callout="<image>:<callout>"`, the key that ties a callout's marker, leader line, legend
 * entry and references together for a host's hover highlighting (#549); nothing when either ID
 * is not one the model allows.
 */
function calloutKey(image: string, callout: string): string {
  return CALLOUT_IMAGE_ID.test(image) && CALLOUT_ID.test(callout)
    ? ` data-callout="${esc(`${image}:${callout}`)}"`
    : '';
}

/** A callout's number in its marker style: `?`, muted, for none. */
function calloutBadge(className: string, n: number | undefined): string {
  const text = numberText(n);
  const muted = text === '?' ? ` ${className}--unresolved` : '';
  return `<span class="${className}${muted}">${esc(text)}</span>`;
}

/** A callout point as SVG coordinates: percentages of the picture, from its top left corner. */
function svgPoint(p: CalloutPoint): { x: string; y: string } {
  const coordinate = (v: number) =>
    `${(Number.isFinite(v) ? Math.min(1, Math.max(0, v)) * 100 : 0).toFixed(2)}%`;
  return { x: coordinate(p.x), y: coordinate(p.y) };
}

/** A percentage for a style attribute: a finite number in (0, 100], at most two decimals. */
function percent(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0)
    return undefined;
  return String(Math.round(Math.min(value, 100) * 100) / 100);
}

function findEntry(
  list: readonly ResolvedEntry[],
  module: string,
): ModuleEntry | undefined {
  for (const e of list) {
    if (e.kind === 'module' && e.module === module) return e;
    if (e.kind === 'group') {
      const found = findEntry(e.entries, module);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * What a cross-reference to a whole module reads as without its own text: the module's title,
 * from its entry or the resolution's titles of the modules that are none (#796), else its ID.
 */
function moduleTitle(manual: ResolvedManual, module: string): string {
  return (
    findEntry(manual.entries, module)?.title ??
    ownValue(manual.xrefTitles ?? {}, module) ??
    module
  );
}

function plain(nodes: readonly Inline[]): string {
  return nodes
    .map((n) =>
      n.type === 'text'
        ? n.text
        : n.type === 'hardBreak'
          ? ' '
          : n.type === 'kbd'
            ? n.keys.join('+')
            : n.type === 'attribute'
              ? `{${n.name}}`
              : '',
    )
    .join('');
}

/** Child block lists of a block, for the walks below. */
function children(block: Block): readonly Block[][] {
  switch (block.type) {
    case 'section':
    case 'safety':
    case 'admonition':
    case 'faq':
    case 'variant':
      return [block.blocks];
    case 'list':
      return block.items.map((i) => i.blocks);
    case 'procedure':
      return block.steps.map((i) => i.blocks);
    case 'table':
      return block.rows.flatMap((r) => r.cells.map((c) => c.blocks));
    case 'paragraph':
    case 'image':
    case 'attachment':
    case 'moduleRef':
    case 'literal':
    case 'passthrough':
    case 'pageBreak':
      return [];
    default:
      // Exhaustive, so a new block type with children must be listed here.
      block satisfies never;
      throw new HtmlRenderError(
        `no renderer for block type "${(block as { type: unknown }).type}"`,
      );
  }
}

/** An object's own property, never one inherited from its prototype (`constructor`, `__proto__`). */
function ownValue(
  record: Readonly<Record<string, string>>,
  key: string,
): string | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function eachBlock(
  entries: readonly ResolvedEntry[],
  visit: (block: Block) => void,
  visitEntry: (entry: ModuleEntry) => void = () => undefined,
): void {
  const blocks = (list: readonly Block[]): void => {
    for (const b of list) {
      visit(b);
      children(b).forEach(blocks);
    }
  };
  for (const e of entries) {
    if (e.kind === 'group') eachBlock(e.entries, visit, visitEntry);
    else {
      visitEntry(e);
      blocks(e.blocks);
    }
  }
}

/** Output IDs of every rendered block and item, and `module:<id>` for every rendered module entry. */
function collectIds(entries: readonly ResolvedEntry[]): Set<string> {
  const ids = new Set<string>();
  eachBlock(
    entries,
    (b) => {
      ids.add(b.id);
      if (b.type === 'list') b.items.forEach((i) => ids.add(i.id));
      if (b.type === 'procedure') b.steps.forEach((i) => ids.add(i.id));
    },
    (e) => ids.add(`module:${e.module}`),
  );
  return ids;
}

/** A heading of a rendered manual: the element ID it links to (`idPrefix` included) and its text. */
export interface ManualHeading {
  readonly id: string;
  readonly text: string;
}

/**
 * The headings `renderManualHtml` gives a manual's modules and sections, in document order, each
 * with the element ID it carries (a module listed twice once, as its ID is): for a search over
 * titles and headings, such as the offline package's (#59). Plain text, unescaped.
 */
export function manualHeadings(
  manual: ResolvedManual,
  idPrefix = 'of-',
): ManualHeading[] {
  const headings: ManualHeading[] = [];
  const seen = new Set<string>();
  const add = (id: string, text: string) => {
    if (seen.has(id) || text.trim() === '') return;
    seen.add(id);
    headings.push({ id: idPrefix + id, text });
  };
  eachBlock(
    manual.entries,
    (b) => {
      if (b.type === 'section') add(b.id, plain(b.title));
    },
    (e) => add(e.module, e.title),
  );
  return headings;
}

/** Plain-text section titles by output ID: link text for cross-references to a section without their own text. */
function sectionTitles(entries: readonly ResolvedEntry[]): Map<string, string> {
  const titles = new Map<string, string>();
  eachBlock(entries, (b) => {
    if (b.type === 'section') titles.set(b.id, plain(b.title));
  });
  return titles;
}
