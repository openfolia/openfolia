import {
  PdfRenderer,
  type DesignTemplateCheck,
  type DesignTemplatePreview,
  type PdfAccessibilityProblem,
  type PdfTemplateProblem,
  type PdfExtras,
  type RenderOptions,
  type PdfLayoutWarning,
} from '../../src/manuals/core/pdf-renderer.js';
import type { ManualResolution } from '../../src/content/core/content.repository.js';

/**
 * A `PdfRenderer` that records the keys and pages asked for and renders
 * nothing; `fail` (if set) decides, per resolution, an error to throw instead.
 */
export class RecordingRenderer extends PdfRenderer {
  readonly keys: string[] = [];
  /** What each render was asked to print beside the manual (`PdfExtras`). */
  readonly extras: (PdfExtras | undefined)[] = [];
  readonly pages: { key: string; number: number; width: number }[] = [];
  /** How many renders were running at once, at most. */
  maxConcurrent = 0;
  #running = 0;
  fail?: (resolution: ManualResolution) => Error | undefined;
  /** What the layout of a resolution's PDF could not fit (#391); none by default. */
  warnings?: (resolution: ManualResolution) => PdfLayoutWarning[];
  /** The keys whose layout warnings were asked for. */
  readonly warned: string[] = [];
  async render(
    _s: unknown,
    resolution: ManualResolution,
    key: string,
    options?: RenderOptions,
  ) {
    this.keys.push(key);
    // What it prints, not how it runs (`background`).
    this.extras.push(options?.qrCode ? { qrCode: options.qrCode } : undefined);
    this.#running++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.#running);
    try {
      await Promise.resolve();
      const error = this.fail?.(resolution);
      if (error) throw error;
      return new Uint8Array([1, 2, 3]);
    } finally {
      this.#running--;
    }
  }
  override layoutWarnings(
    _s: unknown,
    resolution: ManualResolution,
    key: string,
  ) {
    this.warned.push(key);
    return Promise.resolve(this.warnings?.(resolution) ?? []);
  }
  /** The own templates checked (#396), as asked. */
  readonly templates: DesignTemplateCheck[] = [];
  /** Why a design's own template does not compile; none by default. */
  templateProblems?: (check: DesignTemplateCheck) => PdfTemplateProblem[];
  override checkDesignTemplate(check: DesignTemplateCheck) {
    this.templates.push(check);
    return Promise.resolve(this.templateProblems?.(check) ?? []);
  }
  /** The example template (#396): a small one by default. */
  example: Readonly<Record<string, string>> = {
    'manual.typ': '#import "design.typ": *\n',
    'design.typ': '// The layout.\n',
  };
  override exampleDesignTemplate() {
    return this.example;
  }
  /** The template previews asked for (#396). */
  readonly previews: DesignTemplatePreview[] = [];
  /** A preview's answer: an error to throw, else a PNG's bytes; `[7, 8, 9]` by default. */
  preview?: (preview: DesignTemplatePreview) => Error | Uint8Array;
  override previewDesignTemplate(preview: DesignTemplatePreview) {
    this.previews.push(preview);
    const answer = this.preview?.(preview) ?? new Uint8Array([7, 8, 9]);
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  }
  renderPage(
    _s: unknown,
    _r: unknown,
    key: string,
    page: { number: number; width: number },
  ) {
    this.pages.push({ key, ...page });
    return Promise.resolve(new Uint8Array([4, 5, 6]));
  }
}

/** Problems as the Typst renderer reports a refusal under PDF/UA-1. */
export const problem = (message: string): PdfAccessibilityProblem => ({
  message: `PDF/UA-1 error: ${message}`,
  hints: [],
});
