import type { PageDesign, ProjectConfig } from '@openfolia/content-model';
import {
  NotConfiguredError,
  UnprocessableError,
} from '../../base/core/errors.js';
import type {
  ManualResolution,
  RenderSource,
} from '../../content/core/content.repository.js';

/** Why a document cannot meet its PDF standard: the renderer's message and hints. */
export interface PdfAccessibilityProblem {
  readonly message: string;
  readonly hints: readonly string[];
}

/**
 * The manual cannot be rendered to its PDF standard (`pdf.standard`, PDF/UA-1
 * by default): answered 422 `pdf-accessibility`, `meta.problems` naming why;
 * the manual's checks report it as a blocking `pdf-accessibility` check.
 * The same problem (message and hints) is named once.
 */
export class PdfAccessibilityError extends UnprocessableError {
  /** The distinct problems, at most `MAX_PDF_PROBLEMS`. */
  readonly problems: readonly PdfAccessibilityProblem[];
  /**
   * What the layout could not fit (#554): the document was laid out before the PDF standard
   * refused it, so the manual's checks report its warnings beside the refusal. Not in the
   * 422's `meta`.
   */
  readonly warnings: readonly PdfLayoutWarning[];

  constructor(
    problems: readonly PdfAccessibilityProblem[],
    warnings: readonly PdfLayoutWarning[] = [],
  ) {
    const distinct = [
      ...new Map(
        problems.map((p) => [
          JSON.stringify([p.message, p.hints]),
          { message: p.message, hints: [...p.hints] },
        ]),
      ).values(),
    ];
    const kept = distinct.slice(0, MAX_PDF_PROBLEMS);
    super(
      'pdf-accessibility',
      `The PDF cannot meet PDF/UA-1: ${kept.map((p) => p.message).join('; ')}`,
      {
        problems: kept,
        ...(distinct.length > kept.length && {
          more: distinct.length - kept.length,
        }),
      },
    );
    this.problems = kept;
    this.warnings = warnings;
  }
}

/**
 * Why a page design's own template does not compile, where (#396): the file by its repository
 * path (`templates/<id>/manual.typ`, `main.typ` for the generated document), 1-based line and
 * column (0: no place), the compiler's message, and the calls that led there.
 */
export interface PdfTemplateProblem {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly trace: readonly {
    readonly file: string;
    readonly line: number;
    readonly message: string;
  }[];
}

/**
 * The manual's page design names its own template (#396), which does not compile, or whose
 * folder is too large to: answered 422 `template-error`, `meta.design`, `meta.template` and
 * `meta.problems` (where and why, safe to show the author); the manual's checks report it as a
 * blocking `page-design-template-error`.
 */
export class PdfTemplateError extends UnprocessableError {
  override readonly code = 'template-error';

  constructor(
    readonly design: string,
    readonly template: string,
    readonly problems: readonly PdfTemplateProblem[],
  ) {
    const first = problems[0];
    super(
      'template-error',
      `The page design's template "${template}" does not compile${first ? `: ${first.file}${first.line > 0 ? `:${first.line}:${first.column}` : ''}: ${first.message}` : '.'}`,
      { design, template, problems },
    );
  }
}

/**
 * What a PDF's layout could not fit, once per code and place: a page design's region clipped
 * to its slot (`page-design-overflow`, #391), a running head shortened with an ellipsis
 * (`running-head-truncated`, `text` the whole text), a callout legend beside its image cut off
 * at the image's height (`callout-label-overflow`, #548), a safety message taller than a page
 * broken across pages (`safety-message-split`, #668, `text` its hazard). `at` is where: in the
 * design (`regions.footer`, `header.default.right`), the callout
 * (`callouts.<module>.<image>.<callout>`) or the safety message (`safety.<module>.<block>`);
 * `page` the first page it happened on, `pages` on how many.
 */
export interface PdfLayoutWarning {
  readonly code:
    | 'page-design-overflow'
    | 'running-head-truncated'
    | 'callout-label-overflow'
    | 'safety-message-split';
  readonly at: string;
  readonly page: number;
  readonly pages: number;
  readonly text?: string;
}

/** A page design's layout warning: what the design screen's preview lists (#392). */
export type DesignLayoutWarning = PdfLayoutWarning & {
  readonly code: 'page-design-overflow' | 'running-head-truncated';
};

/**
 * Whether a layout warning is a page design's own (a region or a running head), not one about
 * the content: a callout legend cut off (#548) or a safety message split (#668).
 */
export const isDesignWarning = (
  warning: PdfLayoutWarning,
): warning is DesignLayoutWarning =>
  warning.code === 'page-design-overflow' ||
  warning.code === 'running-head-truncated';

/** The most problems a `PdfAccessibilityError` names (`meta.more` counts the rest). */
export const MAX_PDF_PROBLEMS = 50;

/**
 * What a PDF prints beside the manual (#450): `qrCode`, a QR code of `url` (its stable
 * address, also printed as text) on the title page or on a last page of its own.
 */
export interface PdfExtras {
  readonly qrCode?: {
    readonly url: string;
    readonly placement: 'title-page' | 'back-cover';
  };
}

/** How a rendering is run, and what it prints beside the manual (`PdfExtras`). */
export interface RenderOptions extends PdfExtras {
  /**
   * Bulk work nobody waits on (a release's files, #497): it starts only
   * once no interactive rendering (a download, a preview, a check) waits
   * for a worker, and its result is not kept in memory, so it never pushes
   * out what readers asked for.
   */
  readonly background?: boolean;
}

/**
 * A page design's own template to check (#396), on a small manual of the renderer's own that
 * uses every function of the template contract: the design as its file holds it, the
 * configuration (its languages and manufacturer), the template folder's files by path in it, and
 * the design's own files by hash (its logo and cover image; undefined: not stored, left out).
 */
export interface DesignTemplateCheck {
  readonly design: PageDesign;
  readonly config: ProjectConfig;
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly asset: (hash: string) => Promise<Uint8Array | undefined>;
}

/** A page of a page design's own template's probe manual to render (#396): the template screen's preview. */
export interface DesignTemplatePreview extends DesignTemplateCheck {
  /** 1-based, and the PNG's width in pixels. */
  readonly page: { readonly number: number; readonly width: number };
}

/** Typesets a resolved manual. */
export abstract class PdfRenderer {
  /**
   * `key` identifies the result (same key, same PDF), so implementations
   * may cache and share renderings: the caller makes it from everything the
   * PDF shows, so two readers who may see different content never share one. Throws `UnavailableError` under load or
   * during shutdown, `PdfAccessibilityError` for a document that cannot meet
   * the configuration's PDF standard, `UnprocessableError` for documents too
   * slow to render and `FailedError` when compiling fails.
   */
  abstract render(
    source: RenderSource,
    resolution: ManualResolution,
    key: string,
    options?: RenderOptions,
  ): Promise<Uint8Array>;

  /**
   * One page (1-based) of the same PDF as a PNG `width` pixels wide, for
   * thumbnails; `key` as for `render`. Throws `NotFoundError` when the
   * document has no such page, else as `render`.
   */
  abstract renderPage(
    source: RenderSource,
    resolution: ManualResolution,
    key: string,
    page: { number: number; width: number },
  ): Promise<Uint8Array>;

  /**
   * What the layout of the same PDF (`key` as for `render`) could not fit; renders it if it
   * is not rendered yet, and throws as `render`. None by default: a renderer without page
   * designs reports nothing.
   */
  layoutWarnings(
    source: RenderSource,
    resolution: ManualResolution,
    key: string,
  ): Promise<readonly PdfLayoutWarning[]> {
    void source;
    void resolution;
    void key;
    return Promise.resolve([]);
  }

  /**
   * Why the design's own template does not compile (#396), none when it does: compiled on the
   * renderer's own small manual, never a reader's, so a change set's checks can hold a broken
   * template before any manual uses it. One that does not finish in time or exhausts memory is a
   * problem too. Throws `UnavailableError` under load. None by default: a renderer without own
   * templates checks nothing.
   */
  checkDesignTemplate(
    check: DesignTemplateCheck,
  ): Promise<readonly PdfTemplateProblem[]> {
    void check;
    return Promise.resolve([]);
  }

  /**
   * One page (1-based) of the design's own template laid out on the renderer's small manual (the
   * one `checkDesignTemplate` compiles), as a PNG `width` pixels wide: the template screen's live
   * preview (#396). Throws `PdfTemplateError` when the template does not compile (or does not
   * finish in time, or exhausts memory), `NotFoundError` past the last page (`meta.pages`),
   * `UnavailableError` under load. By default a renderer without own templates has no preview:
   * 404 `not-configured`.
   */
  previewDesignTemplate(preview: DesignTemplatePreview): Promise<Uint8Array> {
    void preview;
    return Promise.reject(
      new NotConfiguredError('This server does not preview own templates.'),
    );
  }

  /**
   * The renderer's example template (#396): the files, by path in a template's folder, an own
   * template starts from, which lay a manual out as the built-in layout does. None by default: a
   * renderer without own templates has no example.
   */
  exampleDesignTemplate(): Readonly<Record<string, string>> {
    return {};
  }
}
