import { createHash } from 'node:crypto';
import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Lru } from '@openfolia/content-repo';
import {
  designTemplatePath,
  hasLegendBeside,
  Manifest,
  resolvePageDesign,
  type ResolvedPageDesign,
  variantLabel,
} from '@openfolia/content-model';
import {
  closeWorkerPool,
  compilePagePngInWorker,
  compilePdfReportInWorker,
  type CompileInput,
  configureWorkerPool,
  defaultPoolSize,
  qrCodeSvg,
  designTemplate,
  renderTypst,
  repositoryTemplate,
  TemplateFolderError,
  templateProbe,
  templateProblems,
  TypstMemoryError,
  TypstAccessibilityError,
  TypstBusyError,
  TypstClosedError,
  TypstCompileError,
  TypstPageNotFoundError,
  TypstTimeoutError,
  EXAMPLE_TEMPLATE,
} from '@openfolia/render-typst';
import {
  FailedError,
  InvalidContentError,
  NotFoundError,
  UnavailableError,
  UnprocessableError,
} from '../../base/core/errors.js';
import type { Env } from '../../config/env.js';
import { pdfWorkersFor } from '../../config/role.js';
import type {
  ManualResolution,
  RenderSource,
} from '../../content/core/content.repository.js';
import {
  PdfAccessibilityError,
  PdfRenderer,
  PdfTemplateError,
  type DesignTemplateCheck,
  type DesignTemplatePreview,
  type PdfTemplateProblem,
  type PdfExtras,
  type PdfLayoutWarning,
  type RenderOptions,
} from '../core/pdf-renderer.js';

/** Where the QR code's image is in the compile's files (#450). */
const QR_FILE = 'qr/address.svg';
import {
  COVER_IMAGE_TYPES,
  sniffImageType,
} from '../../assets/core/sniff-image-type.js';

/** The page design's own template a rendering uses (#396): its errors are the template's. */
interface OwnTemplate {
  readonly design: string;
  readonly template: string;
}

/** A compilation, with the own template it uses, if any. */
interface Prepared {
  readonly input: CompileInput;
  readonly own?: OwnTemplate;
}

/** The compiler's error for a document laid out by an own template: the template's (#396). */
function ownError(error: unknown, own: OwnTemplate | undefined): unknown {
  if (own && error instanceof TypstCompileError) {
    return new PdfTemplateError(
      own.design,
      own.template,
      templateProblems(error.diagnostics),
    );
  }
  return error;
}

/**
 * How long a background render (a release's file) may wait for a PDF worker behind readers'
 * PDFs (#497), apart from its own deadline (`CCMS_PDF_TIMEOUT_MS`, its compilation's): then it
 * is refused as the renderer busy, and its job tries again later. Within the job's 10 minutes.
 */
const BACKGROUND_WAIT_MS = 5 * 60_000;

/** Upper bound for cached PDFs and page images, in bytes. */
const CACHE_BYTES = 200 * 1024 * 1024;

/**
 * `PdfRenderer` with Typst on a pool of worker processes. Results (PDFs and
 * page images) are cached by key, and concurrent requests for the same
 * result share one rendering.
 */
@Injectable()
export class TypstPdfRenderer
  extends PdfRenderer
  implements OnModuleInit, BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly logger = new Logger(TypstPdfRenderer.name);
  private readonly cache = new Lru<Uint8Array>(
    CACHE_BYTES,
    (pdf) => pdf.length,
  );
  private readonly rendering = new Map<string, Promise<Uint8Array>>();
  /**
   * The background renders under way, by key, each with the signal that moves it ahead once a
   * reader asks for the same PDF (#497, `WorkerOptions.raise`).
   */
  private readonly raising = new Map<string, AbortController>();
  /**
   * Documents refused for their PDF standard, by key: a refusal is as
   * deterministic as a PDF, so the next request (the PDF route, a manual's
   * checks) answers at once instead of rendering it again.
   */
  private readonly refused = new Lru<PdfAccessibilityError>(10_000);
  /** How many pages a PDF has, once a request past its end found out: such requests answer at once. */
  private readonly pageCounts = new Lru<number>(10_000);
  /** What each rendered PDF's layout could not fit (#391), by key, as `layoutWarnings` answers. */
  private readonly warnings = new Lru<readonly PdfLayoutWarning[]>(10_000);
  private closing?: Promise<void>;

  constructor(private readonly config: ConfigService<Env, true>) {
    super();
  }

  /**
   * Sets the pool's limits; its worker processes start with the first
   * render. The `api` role (#527) renders only what readers ask for, so
   * its pool defaults to `API_ROLE_PDF_WORKERS` (release files render on
   * the workers); its queue stays bounded (`CCMS_PDF_QUEUE`, else 4 per
   * worker), past which a request gets 503 `renderer-busy`.
   */
  onModuleInit(): void {
    const size = pdfWorkersFor(
      this.config.get('CCMS_ROLE', { infer: true }),
      this.config.get('CCMS_PDF_WORKERS', { infer: true }),
      defaultPoolSize(),
    );
    const maxQueue = this.config.get('CCMS_PDF_QUEUE', { infer: true });
    const memoryLimitMb = this.config.get('CCMS_PDF_MEMORY_MB', {
      infer: true,
    });
    configureWorkerPool({
      size,
      ...(maxQueue === undefined ? {} : { maxQueue }),
      ...(memoryLimitMb === undefined ? {} : { memoryLimitMb }),
    });
  }

  /**
   * Before the HTTP server stops: ends running PDF jobs, so their requests
   * get 503 at once instead of holding the shutdown up, and refuses new ones.
   */
  beforeApplicationShutdown(): void {
    this.closing = closeWorkerPool().catch((error: unknown) =>
      this.logger.error('Closing the PDF workers failed', error),
    );
  }

  /** After the HTTP server has stopped: waits until workers and temporary folders are gone. */
  async onApplicationShutdown(): Promise<void> {
    await this.closing;
  }

  render(
    source: RenderSource,
    resolution: ManualResolution,
    key: string,
    { background = false, ...extras }: RenderOptions = {},
  ): Promise<Uint8Array> {
    const raise = background ? new AbortController() : undefined;
    return this.once(
      key,
      async () => {
        const { input, own } = await this.input(source, resolution, extras);
        const { pdf, warnings } = await compilePdfReportInWorker(input, {
          ...this.workerOptions(),
          ...(raise
            ? {
                priority: 'background',
                raise: raise.signal,
                waitMs: BACKGROUND_WAIT_MS,
              }
            : { priority: 'interactive' }),
        }).catch((error: unknown) => {
          throw ownError(error, own);
        });
        // Only a designed manual's layout reports, or one with a callout legend beside its
        // image (#548); the others would only fill the store.
        if (resolution.design || hasLegendBeside(resolution.manual)) {
          this.warnings.set(key, warnings);
        }
        // The render log: what a page design's layout clipped or shortened.
        for (const w of warnings) {
          this.logger.warn(
            `${w.code} at ${JSON.stringify(w.at)} (page ${w.page}${w.pages > 1 ? ` and ${w.pages - 1} more` : ''}) in ${key.split('|').slice(0, 4).join('|')}`,
          );
        }
        return pdf;
      },
      // Bulk work (a release's files) is stored elsewhere: kept here, it
      // would push out what readers asked for.
      { keep: !background, ...(raise && { raise }) },
    );
  }

  override async layoutWarnings(
    source: RenderSource,
    resolution: ManualResolution,
    key: string,
  ): Promise<readonly PdfLayoutWarning[]> {
    const known = this.warnings.get(key);
    if (known) return known;
    await this.render(source, resolution, key);
    const found = this.warnings.get(key);
    if (found) return found;
    // The PDF came from the cache, its warnings were dropped: render it once more for them.
    await this.once(
      `${key}|warnings`,
      async () => {
        const { input, own } = await this.input(source, resolution);
        const { pdf, warnings } = await compilePdfReportInWorker(
          input,
          this.workerOptions(),
        ).catch((error: unknown) => {
          throw ownError(error, own);
        });
        this.warnings.set(key, warnings);
        return pdf;
      },
      { keep: false },
    );
    return this.warnings.get(key) ?? [];
  }

  renderPage(
    source: RenderSource,
    resolution: ManualResolution,
    key: string,
    page: { number: number; width: number },
  ): Promise<Uint8Array> {
    const pages = this.pageCounts.get(key);
    if (pages !== undefined && page.number > pages) {
      return Promise.reject(translate(new TypstPageNotFoundError(pages)));
    }
    return this.once(`${key}|page|${page.number}|${page.width}`, async () => {
      const { input, own } = await this.input(source, resolution);
      try {
        return await compilePagePngInWorker(input, page, this.workerOptions());
      } catch (error) {
        if (error instanceof TypstPageNotFoundError) {
          this.pageCounts.set(key, error.pages);
        }
        throw ownError(error, own);
      }
    });
  }

  override async checkDesignTemplate(
    check: DesignTemplateCheck,
  ): Promise<readonly PdfTemplateProblem[]> {
    if (check.design.template === undefined) return [];
    const probe = await this.probe(check);
    if ('problems' in probe) return probe.problems;
    try {
      await compilePdfReportInWorker(probe.input, this.workerOptions());
      return [];
    } catch (error) {
      const problems = templateFailure(error, probe.entry);
      if (problems) return problems;
      throw translate(error);
    }
  }

  /** The renderer's example template (#396), the files a new own template starts from. */
  override exampleDesignTemplate(): Readonly<Record<string, string>> {
    return EXAMPLE_TEMPLATE;
  }

  /**
   * One page of the template's probe manual as PNG (#396: the template screen's preview), cached
   * by what it compiles (the template's files, the design, the page and its width), so the same
   * draft is rendered once whoever asks. A template that does not compile, does not finish in
   * time or exhausts memory is a `PdfTemplateError` with its problems; a page past the last a
   * `NotFoundError` (`meta.pages`).
   */
  override async previewDesignTemplate(
    preview: DesignTemplatePreview,
  ): Promise<Uint8Array> {
    const { design, page } = preview;
    const template = design.template;
    if (template === undefined) {
      throw new Error('previewDesignTemplate needs a design naming a template');
    }
    const probe = await this.probe(preview);
    if ('problems' in probe) {
      throw new PdfTemplateError(design.id, template, probe.problems);
    }
    const hash = createHash('sha256');
    hash.update(probe.input.source);
    const files = probe.input.files ?? {};
    for (const path of Object.keys(files).sort()) {
      hash.update(`\0${path}\0`);
      hash.update(files[path] as Uint8Array);
    }
    hash.update(JSON.stringify(probe.input.inputs ?? {}));
    const key = `template-preview|${hash.digest('hex')}|${page.number}|${page.width}`;
    return this.once(key, async () => {
      try {
        return await compilePagePngInWorker(
          probe.input,
          page,
          this.workerOptions(),
        );
      } catch (error) {
        const problems = templateFailure(error, probe.entry);
        if (problems) throw new PdfTemplateError(design.id, template, problems);
        throw error;
      }
    });
  }

  /**
   * The probe manual laid out with the design and its own template, ready to compile; or why the
   * template's folder cannot be compiled (too many files, too large, no `manual.typ`).
   */
  private async probe(
    check: DesignTemplateCheck,
  ): Promise<
    { input: CompileInput; entry: string } | { problems: PdfTemplateProblem[] }
  > {
    const { design, config, files, asset } = check;
    const id = design.template as string;
    const entry = designTemplatePath(id);
    let own: ReturnType<typeof repositoryTemplate>;
    try {
      own = repositoryTemplate(id, files);
    } catch (error) {
      if (error instanceof TemplateFolderError) {
        return {
          problems: [
            {
              file: entry,
              line: 0,
              column: 0,
              message: error.message,
              trace: [],
            },
          ],
        };
      }
      throw error;
    }
    const lang = config.languages.source;
    const manual = templateProbe(lang);
    const resolved = resolvePageDesign({
      design,
      manifest: Manifest.parse({
        schemaVersion: 1,
        id: 'template-check',
        title: manual.title,
        variants: [{}],
        entries: [{ module: 'probe' }],
      }),
      variant: {},
      lang,
      config,
    }).design;
    const read = new Map<string, Promise<Uint8Array | undefined>>();
    const stored = (ref: string) => {
      const hash = ref.replace(/^sha256:/, '');
      let found = read.get(hash);
      if (!found) {
        found = asset(hash);
        read.set(hash, found);
      }
      return found;
    };
    const shown = await storedOnly(resolved, stored);
    const { source, assets, inputs } = renderTypst(manual, {
      design: shown,
      templatePath: own.templatePath,
      outputLabels: config.outputLabels,
      symbolPath: () => undefined,
    });
    const compileFiles: Record<string, Uint8Array> = { ...own.files };
    await Promise.all(
      assets.map(async (ref) => {
        const data = await stored(ref);
        if (data) compileFiles[`assets/${ref.replace(/^sha256:/, '')}`] = data;
      }),
    );
    return {
      entry,
      input: {
        source,
        files: compileFiles,
        ...(Object.keys(inputs).length > 0 && { inputs }),
        // Whether it compiles; meeting PDF/UA-1 is each manual's check.
        standard: 'none',
        creationTimestamp: 0,
      },
    };
  }

  /**
   * The cached result for `key`, else one rendering shared by every request
   * for it, kept in the cache unless `keep` is false.
   */
  private once(
    key: string,
    make: () => Promise<Uint8Array>,
    {
      keep = true,
      raise,
    }: {
      keep?: boolean;
      /** A background render's: aborted once a reader joins it. */
      raise?: AbortController;
    } = {},
  ): Promise<Uint8Array> {
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    const refused = this.refused.get(key);
    if (refused) return Promise.reject(refused);
    let job = this.rendering.get(key);
    if (!job) {
      job = make()
        .catch((error: unknown) => {
          const translated = translate(error);
          if (translated instanceof PdfAccessibilityError) {
            this.refused.set(key, translated);
          }
          throw translated;
        })
        .then((result) => {
          if (keep) this.cache.set(key, result);
          return result;
        })
        .finally(() => {
          this.rendering.delete(key);
          this.raising.delete(key);
        });
      this.rendering.set(key, job);
      if (raise) this.raising.set(key, raise);
    } else if (keep) {
      // A reader joining a release's background render (#497): it goes
      // ahead as the reader's, and is kept for the next reader, though the
      // render itself is not.
      this.raising.get(key)?.abort();
      return job.then((result) => {
        this.cache.set(key, result);
        return result;
      });
    }
    return job;
  }

  private workerOptions(): { timeoutMs?: number } {
    const timeoutMs = this.config.get('CCMS_PDF_TIMEOUT_MS', { infer: true });
    return timeoutMs === undefined ? {} : { timeoutMs };
  }

  private async input(
    content: RenderSource,
    resolution: ManualResolution,
    extras?: PdfExtras,
  ): Promise<Prepared> {
    const qr = extras?.qrCode;
    const { manual, config } = resolution;
    const [symbolFiles, template, committedAt, ownFiles] = await Promise.all([
      content.symbols(),
      content.template(),
      content.committedAt(),
      ownTemplateFiles(content, resolution),
    ]);
    const own = ownFiles && {
      design: ownFiles.design,
      template: ownFiles.template,
    };
    // Each stored file read once, the design's logo and cover image too.
    const read = new Map<string, Promise<Uint8Array | undefined>>();
    const asset = (ref: string) => {
      const hash = ref.replace(/^sha256:/, '');
      let found = read.get(hash);
      if (!found) {
        found = content.asset(hash);
        read.set(hash, found);
      }
      return found;
    };
    const design =
      resolution.design && (await storedOnly(resolution.design, asset));
    const { source, assets, symbols, fonts, inputs } = renderTypst(manual, {
      ...(ownFiles && { templatePath: ownFiles.templatePath }),
      subtitle: variantLabel(manual.variant, config, manual.lang),
      symbolPath: (id) => symbolFiles.get(id),
      outputLabels: config.outputLabels,
      ...(qr && {
        qrCode: { path: QR_FILE, url: qr.url, placement: qr.placement },
      }),
      ...(design && { design }),
      ...(config.pdf.calloutLabelMinSize !== undefined && {
        calloutLabelMinSize: config.pdf.calloutLabelMinSize,
      }),
    });
    // The own template's folder first (#396): at its repository paths, beside the assets.
    const files: Record<string, Uint8Array> = { ...ownFiles?.files };
    // Made here, without a network call: the address is the caller's (`CCMS_PUBLIC_URL`).
    if (qr) files[QR_FILE] = new TextEncoder().encode(qrCodeSvg(qr.url));
    const fontFiles: { data: Uint8Array; family: string }[] = [];
    await Promise.all([
      // The design's fonts (#391), in the order it names them: only those whose embedding the
      // design confirmed reach here (`resolvePageDesign`).
      ...fonts.map(async ({ file, family }, i) => {
        const data = await asset(file);
        if (data) fontFiles[i] = { data, family };
      }),
      ...assets.map(async (ref) => {
        const data = await asset(ref);
        if (data) files[`assets/${ref.replace(/^sha256:/, '')}`] = data;
      }),
      ...symbols.map(async (path) => {
        const data = await content.file(path);
        if (data) files[path] = data;
      }),
    ]);
    // A design's own template (#396) is imported by the document itself (`templatePath`); else a
    // repository's own template wins, else a design's preset, else the default template.
    const layout = ownFiles
      ? undefined
      : (template ?? (design && designTemplate(design.preset)));
    const input: CompileInput = {
      source,
      files,
      ...(fontFiles.length > 0 && { fonts: fontFiles.filter(Boolean) }),
      ...(Object.keys(inputs).length > 0 && { inputs }),
      standard: config.pdf.standard,
      // The commit's time, not the time of rendering: the same commit
      // always gives the same bytes (#328), a release tag's PDF too.
      creationTimestamp: committedAt,
      ...(layout ? { template: layout } : {}),
    };
    return own ? { input, own } : { input };
  }
}

/**
 * The files of the own template the manual's page design names (#396), ready to compile; none
 * when it names none or the repository has no such template (the design's checks report
 * `page-design-unknown-template`; the preset lays it out). A folder that cannot be compiled (too
 * large, a file outside it) is the template's error, `PdfTemplateError`.
 */
async function ownTemplateFiles(
  content: RenderSource,
  resolution: ManualResolution,
): Promise<
  | (OwnTemplate & { templatePath: string; files: Record<string, Uint8Array> })
  | undefined
> {
  const design = resolution.design;
  const id = design?.template;
  if (!design || id === undefined) return undefined;
  const fail = (message: string) =>
    new PdfTemplateError(design.id, id, [
      { file: `templates/${id}`, line: 0, column: 0, message, trace: [] },
    ]);
  let found: Record<string, Uint8Array> | undefined;
  try {
    found = await content.designTemplate();
  } catch (error) {
    if (error instanceof InvalidContentError) throw fail(error.message);
    throw error;
  }
  if (!found) return undefined;
  try {
    const { templatePath, files } = repositoryTemplate(id, found);
    return { design: design.id, template: id, templatePath, files };
  } catch (error) {
    if (error instanceof TemplateFolderError) throw fail(error.message);
    throw error;
  }
}

/**
 * The design without a logo or cover image the store does not have (the design's own checks
 * report it, `missing-asset`; a manual's cover image, `missing-cover-image`), so its PDF still
 * renders, with the slot empty (#394: the layout closes the gap). A cover image whose bytes are
 * no image (PNG, JPEG, GIF, WebP or SVG) is left out the same way, never handed to the compiler.
 */
async function storedOnly(
  design: ResolvedPageDesign,
  asset: (ref: string) => Promise<Uint8Array | undefined>,
): Promise<ResolvedPageDesign> {
  const has = async (ref: string | undefined) =>
    ref !== undefined && (await asset(ref)) !== undefined;
  const isImage = async (ref: string | undefined) => {
    const data = ref === undefined ? undefined : await asset(ref);
    return data !== undefined && COVER_IMAGE_TYPES.has(sniffImageType(data));
  };
  const [light, dark, cover] = await Promise.all([
    has(design.logo?.light),
    has(design.logo?.dark),
    isImage(design.coverImage?.asset),
  ]);
  const { logo, coverImage, ...rest } = design;
  return {
    ...rest,
    ...(logo &&
      light && {
        logo: { light: logo.light, ...(dark && { dark: logo.dark }) },
      }),
    ...(coverImage && cover && { coverImage }),
  };
}

/**
 * A template's compilation that failed for the template's own sake (#396): its problems (where
 * and why), one that did not finish in time or exhausted memory as a problem at its entry file;
 * undefined for anything else (load, shutdown), which is no problem of the template.
 */
function templateFailure(
  error: unknown,
  entry: string,
): PdfTemplateProblem[] | undefined {
  const problem = (message: string): PdfTemplateProblem[] => [
    { file: entry, line: 0, column: 0, message, trace: [] },
  ];
  if (error instanceof TypstCompileError) {
    return templateProblems(error.diagnostics);
  }
  if (error instanceof TypstTimeoutError && !error.queued) {
    return problem(
      `the template did not finish compiling in time (${error.message})`,
    );
  }
  if (error instanceof TypstMemoryError) {
    return problem(
      `the template used more than ${error.limitMb} MiB of memory while compiling`,
    );
  }
  return undefined;
}

/** The worker pool's errors in the core's terms. */
function translate(error: unknown): unknown {
  if (error instanceof TypstTimeoutError) {
    // Mostly waiting for a worker: load, so a retry later may work.
    if (error.queued) {
      return new UnavailableError(
        'renderer-busy',
        'The PDF renderer is busy; try again later.',
        30,
      );
    }
    // The document itself is too slow to render: a retry would fail again.
    return new UnprocessableError(
      'render-timeout',
      'This document takes too long to render as PDF.',
    );
  }
  if (error instanceof TypstMemoryError) {
    // The document (or its template, #396) needs more memory than a worker may use.
    return new UnprocessableError(
      'render-memory-exceeded',
      'This document needs too much memory to render as PDF.',
    );
  }
  if (error instanceof TypstBusyError) {
    return new UnavailableError(
      'renderer-busy',
      'Too many PDFs are being rendered; try again later.',
      30,
    );
  }
  if (error instanceof TypstClosedError) {
    return new UnavailableError(
      'shutting-down',
      'The server is shutting down.',
      5,
    );
  }
  if (error instanceof TypstPageNotFoundError) {
    return new NotFoundError(
      `The PDF has ${error.pages} page${error.pages === 1 ? '' : 's'}.`,
      { pages: error.pages },
    );
  }
  if (error instanceof TypstAccessibilityError) {
    return new PdfAccessibilityError(error.problems, error.warnings);
  }
  if (error instanceof TypstCompileError) {
    return new FailedError('render-failed', 'PDF rendering failed.', {
      diagnostics: error.diagnostics,
    });
  }
  return error;
}
