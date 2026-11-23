import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  blockPlaces,
  compareDesignWithRecord,
  compareManifestWithRecord,
  compareWithRecord,
  checkWriting,
  compileWritingRules,
  SENTENCE_RULE_ID,
  ExpansionBudget,
  ExpansionBudgetError,
  ExpansionTooLargeError,
  fontFormatOf,
  hasLegendBeside,
  manifestAssets,
  ownInlineContent,
  termLinks,
  textIn,
  toChunks,
  validateModule,
  variantSlug,
  walk,
  type Deprecation,
  type ExpansionLimits,
  type Inline,
  type LocalizedText,
  type Manifest,
  type ManifestEntry,
  type Module,
  pageDesignIdFor,
  type PageDesignResolveIssue,
  type ProjectConfig,
  type ResolveIssue,
  type Term,
  type Weight,
  weightOf,
  type WritingFinding,
  type WritingRules,
} from '@openfolia/content-model';
import {
  deliveryAccess,
  StableAddressSettings,
} from '../../addresses/core/stable-address.js';
import { nameFits } from '../../assets/core/attachment-types.js';
import {
  COVER_IMAGE_TYPES,
  sniffImageType,
} from '../../assets/core/sniff-image-type.js';
import {
  FailedError,
  InvalidContentError,
  UnavailableError,
  UnprocessableError,
} from '../../base/core/errors.js';
import {
  blobStoreUnavailable,
  BlobStore,
  isSha256,
} from '../../blobs/core/blob-store.js';
import type { LockSubject } from '../../change-sets/core/lock.js';
import type { ManualResolution } from '../../content/core/content.repository.js';
import { DesignsInUse } from '../../content/core/design-in-use.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { renderKey } from '../../manuals/core/actions/render-manual-pdf.action.js';
import {
  PdfAccessibilityError,
  PdfRenderer,
  PdfTemplateError,
  type DesignTemplateCheck,
  type PdfLayoutWarning,
  type PdfTemplateProblem,
} from '../../manuals/core/pdf-renderer.js';
import { OneAtATime } from '../../base/core/one-at-a-time.js';
import { Recent } from '../../base/core/recent.js';
import type { ChunkSetTooLargeError } from '../../chunks/core/chunk-set-too-large.js';
import {
  EXPANSION_LIMITS_TOKEN,
  expansionLimitsOf,
} from '../../chunks/core/expansion-limits.js';
import { CheckList, type Check, type CheckCode } from './check.js';

type ModuleSubject = Extract<LockSubject, { type: 'module' }>;

/** The check each issue resolving a page design gives (#554); `unknown-page-design` is `#pageDesign`'s. */
const DESIGN_ISSUE_CHECKS: Partial<
  Record<PageDesignResolveIssue['code'], CheckCode>
> = {
  'missing-translation': 'page-design-missing-translation',
  'dropped-text': 'page-design-dropped-text',
  'region-languages-differ': 'page-design-region-languages-differ',
  'missing-placeholder-value': 'page-design-missing-value',
  'missing-text-attribute': 'page-design-missing-text-attribute',
  'missing-variant-attribute': 'page-design-missing-variant-attribute',
};

/**
 * Placeholders (and title page fields) a manual's checks never have a value for: the release
 * and the date are not passed to the design yet (#533), so reporting them would warn of every
 * designed manual.
 */
const NOT_KNOWN_TO_CHECKS: ReadonlySet<string> = new Set(['release', 'date']);

/** How many images are looked up in the blob store at once. */
const IMAGES_AT_ONCE = 8;

/** How many outcomes of cutting a module's chunks (`#chunks`) are kept across checks. */
export const CHUNK_CUTS_KEPT = 10_000;

/**
 * Whether a module's chunks can be cut (`ok`, or the limit they pass), and what cutting them
 * spent (#711), counted as `toChunks` counts it: kept with the outcome, so a run that finds it
 * kept spends it from its budget all the same, and says the same whether it was kept or not.
 */
interface ChunkCut {
  readonly outcome: 'ok' | ExpansionTooLargeError['reason'];
  readonly spent: Readonly<Weight>;
}

/** How many languages' compiled writing checks (#55) are kept across checks, by commit. */
export const WRITING_RULES_KEPT = 8;

/** A budget that holds nothing back: it only counts what a walk spends (`ChunkCut.spent`). */
const UNBOUNDED: Readonly<Weight> = {
  nodes: Infinity,
  chars: Infinity,
  cells: Infinity,
};

/** How many module references one request follows at most, looking for cycles. */
export const CYCLE_STEPS = 100_000;

/** How many modules a cycle's message names at most (then `…`). */
const CYCLE_NAMED = 20;

/** A module read in one language: there, broken, or not there (missing or hidden alike). */
type Read =
  { readonly module: Module } | { readonly error: string } | undefined;

/**
 * The checks of content as one reader sees it (#71): validation issues,
 * broken references, missing images and missing translations, each at
 * its module (in one language) and block, or at the manual.
 *
 * Everything is read through `ReadableContent`, so only what the reader
 * may see is checked: a module they may not see is not there, exactly
 * like a missing one, and nothing is reported about it (neither listed
 * nor counted). A reference to a module that is missing everywhere is
 * reported only to a reader told what was left out, or from whom nothing
 * is hidden (`ReadableContent.missingModule`); a cross-reference to a
 * module the reader may not see is not reported at all.
 */
@Injectable()
export class ContentChecks {
  /**
   * The checks' renderings, across all requests: one at a time, so checks
   * never hold more than one of the renderer's workers or queue places and
   * the PDF routes keep the rest.
   */
  readonly #rendering = new RenderQueue();

  /**
   * Whether a module's retrieval chunks can be cut (#688), by commit, reading key, language and
   * module: the same for its key every time, and up to the expansion limits' work to find out,
   * so kept across requests (never for content read through an overlay).
   */
  readonly #cut = new Recent<ChunkCut>(CHUNK_CUTS_KEPT);

  /**
   * The writing checks (#55) of a commit's terms and configuration in one language, compiled:
   * the same for every reader (terms and the configuration carry no audience), so kept across
   * requests by commit and language (never for content read through an overlay).
   */
  readonly #writing = new Recent<WritingRules>(WRITING_RULES_KEPT);

  /**
   * The limits of #679 the modules' chunks are cut to, as `GET /chunks` cuts them: the content
   * model's `EXPANSION_LIMITS`, smaller only in tests (#726, `EXPANSION_LIMITS_TOKEN`, which no
   * module of the app provides).
   */
  readonly #limits: ExpansionLimits;

  constructor(
    private readonly blobs: BlobStore,
    private readonly renderer: PdfRenderer,
    private readonly addresses: StableAddressSettings,
    @Optional()
    @Inject(EXPANSION_LIMITS_TOKEN)
    limits?: ExpansionLimits,
  ) {
    this.#limits = expansionLimitsOf(limits);
  }

  /**
   * A manual's checks: its manifest's issues, every published variant
   * resolved in every language the reader may read it in, and the checks
   * of every module it includes (also through module references) in those
   * languages. `undefined` when there is no such manual for the reader.
   */
  async manual(
    snapshot: ReadableContent,
    manualId: string,
  ): Promise<Checked | undefined> {
    const run = new Run(
      snapshot,
      this.blobs,
      this.#render,
      this.addresses,
      this.#cut,
      this.#checkTemplate,
      this.#writing,
      this.#limits,
    );
    const found = await run.manual(manualId);
    return found ? await run.result() : undefined;
  }

  /**
   * The checks of what a change set changes, at its head (`snapshot`):
   * each changed module there (with its cross-references, missing
   * translations and the module reference cycles it is in), each changed
   * manual there (as `manual`), and, for a module gone from the head, the
   * manuals and modules there that still refer to it. The configuration
   * and terms are not checked here. `chunkSet`: whether the head's chunks are too large together
   * (#710, `ListChunksAction.tooLarge`), a `chunk-set-too-large` at each module it names.
   */
  async changes(
    snapshot: ReadableContent,
    subjects: readonly LockSubject[],
    chunkSet?: Promise<ChunkSetTooLargeError | undefined>,
    templates: readonly string[] = [],
  ): Promise<Checked> {
    const run = new Run(
      snapshot,
      this.blobs,
      this.#render,
      this.addresses,
      this.#cut,
      this.#checkTemplate,
      this.#writing,
      this.#limits,
    );
    const gone: string[] = [];
    // The designs whose own template to compile (#396): each changed design, and each design
    // there naming a template whose folder changed.
    const designs = new Set<string>();
    for (const subject of subjects) {
      if (subject.type === 'design') designs.add(subject.designId);
    }
    if (templates.length > 0) {
      for (const listed of await snapshot.pageDesigns()) {
        if (
          'design' in listed &&
          listed.design.template !== undefined &&
          templates.includes(listed.design.template)
        ) {
          designs.add(listed.id);
        }
      }
    }
    for (const designId of [...designs].sort()) {
      await run.changedDesign(designId);
    }
    for (const subject of subjects) {
      if (subject.type === 'manual') {
        await run.manual(subject.manualId);
        continue;
      }
      // The configuration and terms have no content checks of their own:
      // a configuration change is refused at save while it would make
      // content invalid (`configUsages`).
      if (subject.type !== 'module') continue;
      const there = await run.changedModule(subject);
      if (!there && !gone.includes(subject.moduleId)) {
        gone.push(subject.moduleId);
      }
    }
    await run.whereUsed(gone);
    const tooLarge = await chunkSet;
    if (tooLarge) run.chunkSetTooLarge(tooLarge);
    return await run.result();
  }

  /** `PdfRenderer.checkDesignTemplate`, one at a time with the checks' renderings (#396). */
  readonly #checkTemplate: CheckTemplate = (check) =>
    this.#rendering.run(() => this.renderer.checkDesignTemplate(check));

  /**
   * `PdfRenderer.render`, one at a time across all checks; with a page design, what its
   * layout could not fit (#391).
   */
  readonly #render: Render = (source, resolution, key) =>
    this.#rendering.run(async () => {
      await this.renderer.render(source, resolution, key);
      return resolution.design || hasLegendBeside(resolution.manual)
        ? this.renderer.layoutWarnings(source, resolution, key)
        : [];
    });
}

/** Compiles a page design's own template on the renderer's small manual (#396). */
type CheckTemplate = (
  check: DesignTemplateCheck,
) => Promise<readonly PdfTemplateProblem[]>;

/** Renders a manual's PDF; what its page design's layout could not fit. */
type Render = (
  ...args: Parameters<PdfRenderer['render']>
) => Promise<readonly PdfLayoutWarning[]>;

/** How many check renderings may wait (or run) at once, across all requests; more are 503. */
export const CHECK_RENDERS_WAITING = 8;

/**
 * The checks' renderings, one after another, at most `limit` waiting or running: past it 503
 * `renderer-busy` (`Retry-After`), as the renderer's own pool refuses when full.
 */
export class RenderQueue extends OneAtATime {
  constructor(limit = CHECK_RENDERS_WAITING) {
    super(
      limit,
      () =>
        new UnavailableError(
          'renderer-busy',
          'Too many checks are rendering PDFs; try again later.',
          30,
        ),
    );
  }
}

/** The checks found, and the modules checked (their IDs, once each, in any language). */
export interface Checked {
  readonly checks: readonly Check[];
  readonly modules: readonly string[];
}

/** A writing finding's parameters (#55): what it is about and where in the block's text. */
function writingParams(finding: WritingFinding): Record<string, string> {
  const { rule } = finding;
  return {
    field: finding.field,
    start: String(finding.start),
    end: String(finding.end),
    text: finding.text,
    ...(finding.image !== undefined && { callout: finding.blockId }),
    ...(finding.replacement !== undefined && {
      replacement: finding.replacement,
    }),
    ...(rule.kind === 'term'
      ? {
          term: rule.termId,
          status: rule.status,
          ...(rule.note !== undefined && { note: rule.note }),
        }
      : rule.kind === 'style'
        ? { rule: rule.ruleId, message: finding.message }
        : {
            rule: SENTENCE_RULE_ID,
            words: String(rule.words),
            max: String(rule.max),
          }),
  };
}

/** One request's checks, with its reads kept. */
class Run {
  readonly list = new CheckList();
  readonly #reads = new Map<string, Promise<Read>>();
  /** Each file's stored type, `undefined` when it is not stored. */
  readonly #files = new Map<string, Promise<string | undefined>>();
  /** Per font file (`sha256:<hash>`): whether it is stored as a font (#555). */
  readonly #fonts = new Map<string, Promise<boolean>>();
  /** Per cover image (#394), whether it is stored as an image. */
  readonly #images = new Map<string, Promise<boolean>>();
  /** Per module read, its blocks by ID (`#placesOf`), for the references to one block (#223). */
  readonly #places = new Map<Module, ReadonlyMap<string, unknown>>();
  /** `lang/moduleId` → the modules it refers to (`#refs`). */
  readonly #refsRead = new Map<
    string,
    Promise<readonly string[] | undefined>
  >();
  /** References followed looking for cycles in this request (`CYCLE_STEPS`). */
  #cycleSteps = 0;
  readonly #checked = new Set<string>();
  /** The IDs of the modules read and checked (found, in some language). */
  readonly #modules = new Set<string>();
  /** The titles of the manuals read, by ID. */
  readonly #manuals = new Map<string, string>();
  /** `lang/moduleId`s whose translation was compared with its source (`#outdated`). */
  readonly #compared = new Set<string>();
  /** `lang/moduleId` → block ID → position in the module. */
  readonly #order = new Map<string, Map<string, number>>();
  #config: Promise<ProjectConfig> | undefined;
  /** Terms read in this request, by ID: undefined when none, `'unreadable'` for a broken file. */
  readonly #terms = new Map<string, Promise<Term | 'unreadable' | undefined>>();
  /** The writing checks (#55) by language, compiled in this request or kept (`#writingRules`). */
  readonly #writingRules = new Map<string, Promise<WritingRules>>();
  /** A PDF took too long to render in this request (`#pdf`). */
  #tooSlow = false;
  /**
   * The modules whose retrieval chunks are still to be cut (`#cutAll`), by `lang/moduleId`:
   * once everything else is checked, so all of them share one budget (#711).
   */
  readonly #toCut = new Map<
    string,
    { readonly subject: ModuleSubject; readonly module: Module }
  >();

  constructor(
    readonly snapshot: ReadableContent,
    private readonly blobs: BlobStore,
    private readonly render: Render,
    private readonly addresses: Pick<StableAddressSettings, 'maxAccess'>,
    private readonly cut: Recent<ChunkCut>,
    private readonly checkTemplate: CheckTemplate,
    private readonly writing: Recent<WritingRules>,
    /** What chunks are cut to (`ContentChecks.#limits`). */
    private readonly limits: ExpansionLimits,
  ) {}

  config(): Promise<ProjectConfig> {
    return (this.#config ??= this.snapshot.config());
  }

  /**
   * The checks in order, each with its subject's title where the reader can read it; the
   * retrieval chunks of the modules checked are cut first (`#cutAll`).
   */
  async result(): Promise<Checked> {
    await this.#cutAll();
    const titles = new Map<string, Promise<string | undefined>>();
    const checks = await Promise.all(
      this.sorted().map(async (check) => {
        const key = JSON.stringify(check.subject);
        let title = titles.get(key);
        if (!title) {
          title = this.#titleOf(check.subject);
          titles.set(key, title);
        }
        const found = await title;
        return found === undefined ? check : { ...check, title: found };
      }),
    );
    return { checks, modules: [...this.#modules] };
  }

  async #titleOf(subject: LockSubject): Promise<string | undefined> {
    if (subject.type === 'manual') return this.#manuals.get(subject.manualId);
    if (subject.type === 'design') {
      // The design's name (#396); a file that is no design has none.
      return this.snapshot.pageDesign(subject.designId).then(
        (design) => design?.name,
        () => undefined,
      );
    }
    if (subject.type !== 'module') return undefined;
    const found = await this.read(subject.moduleId, subject.lang);
    return found && 'module' in found ? found.module.meta.title : undefined;
  }

  sorted(): Check[] {
    return this.list.sorted((subject, blockId) => {
      if (subject.type !== 'module') return Number.MAX_SAFE_INTEGER;
      return (
        this.#order.get(`${subject.lang}/${subject.moduleId}`)?.get(blockId) ??
        Number.MAX_SAFE_INTEGER
      );
    });
  }

  /** A module as the reader sees it in `lang`: a broken file only for one who may learn of it. */
  read(id: string, lang: string): Promise<Read> {
    const key = `${lang}/${id}`;
    let found = this.#reads.get(key);
    if (!found) {
      found = this.snapshot.module(id, lang).then(
        (module): Read => (module ? { module } : undefined),
        (error: unknown): Read => {
          if (error instanceof InvalidContentError) {
            return { error: error.message };
          }
          throw error;
        },
      );
      this.#reads.set(key, found);
    }
    return found;
  }

  /**
   * The language a module is read in for a manual in `lang`: `lang` where
   * the reader sees it (or, unless `parsed`, its broken file) there, else
   * the source language's, as resolving falls back; `undefined` when
   * neither.
   */
  async languageFor(
    id: string,
    lang: string,
    parsed = false,
  ): Promise<string | undefined> {
    const there = async (l: string) => {
      const found = await this.read(id, l);
      return found !== undefined && (!parsed || 'module' in found);
    };
    if (await there(lang)) return lang;
    const { source } = (await this.config()).languages;
    if (lang !== source && (await there(source))) return source;
    return undefined;
  }

  /**
   * The manual's page design (#589): one its manifest or the configuration names that is not in
   * the content (or whose file is no design) is `unknown-page-design`; the PDF uses the built-in
   * design then. Designs carry no audience, so every reader of the manual may learn of it.
   */
  async #pageDesign(
    manifest: Pick<Manifest, 'design'>,
    config: ProjectConfig,
    subject: Extract<LockSubject, { type: 'manual' }>,
  ): Promise<void> {
    const used = await new DesignsInUse(this.snapshot).of(manifest, config);
    if (!used.missing) return;
    const from = used.source === 'manual' ? 'manual' : 'config';
    this.list.add({
      code: 'unknown-page-design',
      subject,
      message:
        from === 'manual'
          ? `The manual names the page design "${used.id}", which does not exist; the built-in design is used.`
          : `The project's default page design "${used.id}" (pdf.design) does not exist; the built-in design is used.`,
      params: { design: used.id, from },
    });
  }

  async manual(manualId: string): Promise<boolean> {
    const subject = { type: 'manual', manualId } as const;
    let manual: Awaited<ReturnType<ReadableContent['manual']>>;
    try {
      manual = await this.snapshot.manual(manualId);
    } catch (error) {
      if (!(error instanceof InvalidContentError)) throw error;
      this.list.add({
        code: 'invalid-manifest',
        subject,
        message: error.message,
      });
      return true;
    }
    if (!manual) return false;
    const config = await this.config();
    this.#manuals.set(manualId, sourceTitle(manual.manifest.title, config));
    const replacedBy = manual.manifest.deprecated?.replacedBy;
    if (
      replacedBy !== undefined &&
      replacedBy !== manualId &&
      (await this.snapshot.missingManual(replacedBy))
    ) {
      this.list.add({
        code: 'unknown-replacement',
        subject,
        message: `The manual is deprecated in favour of "${replacedBy}", which does not exist.`,
        params: { replacedBy },
      });
    }
    await this.#pageDesign(manual.manifest, config, subject);
    await this.#coverImages(manual.manifest, subject);
    await this.#addresses(manualId, config);
    this.#manufacturer(subject, config);
    for (const issue of manual.issues) {
      if (issue.code === 'outside-scope') continue;
      const code: CheckCode = issue.code;
      this.list.add({
        code,
        subject,
        message: issue.message,
        ...(issue.at !== undefined && { params: { at: issue.at } }),
      });
    }
    const languages = [config.languages.source, ...config.languages.targets];
    const read: string[] = [];
    let fontsChecked = false;
    for (const lang of languages) {
      const resolutions = await Promise.all(
        manual.manifest.variants.map((variant) =>
          this.snapshot.resolve(manualId, variant, lang),
        ),
      );
      let resolvedHere = false;
      for (const [i, resolution] of resolutions.entries()) {
        if (!resolution) continue;
        resolvedHere = true;
        // A design's fonts (and its own template, #396) are the same in every variant and
        // language: looked at once.
        if (!fontsChecked && resolution.design) {
          fontsChecked = true;
          await this.#designFonts(resolution, manualId);
          await this.#knownTemplate(resolution.design, subject);
        }
        const slug = variantSlug(manual.manifest.variants[i] ?? {});
        for (const issue of resolution.issues) {
          await this.#resolutionIssue(issue, manualId, slug, lang);
        }
        this.#designIssues(resolution, manualId, slug, lang);
        // Too large (#679): nothing was resolved, so there is no PDF to check.
        if (resolution.issues.some((i) => i.code === 'expansion-too-large')) {
          continue;
        }
        await this.#pdf(resolution, manualId, slug, lang);
      }
      if (resolvedHere) read.push(lang);
    }
    await this.#outdatedOwnText(manual.manifest, manualId, config, read);
    // Every module the manual includes, in each language it was read in.
    const manifestNames = new Set(manifestModules(manual.manifest.entries));
    for (const lang of read) {
      const pending = [...manifestModules(manual.manifest.entries)];
      const seen = new Set<string>();
      while (pending.length > 0) {
        const id = pending.shift() as string;
        if (seen.has(id)) continue;
        seen.add(id);
        const at = await this.languageFor(id, lang);
        if (at === undefined) {
          // Resolving tells this only to readers of drafts; a reader from
          // whom nothing is hidden learns it too (`missingModule`).
          if (
            manifestNames.has(id) &&
            (await this.snapshot.missingModule(id))
          ) {
            this.list.add({
              code: 'missing-module',
              subject,
              message: `module "${id}" does not exist`,
              params: { module: id },
              language: lang,
            });
          }
          continue;
        }
        const found = await this.read(id, at);
        if (found && 'module' in found) {
          for (const { kind, node } of walk(found.module.blocks)) {
            if (kind === 'block' && node.type === 'moduleRef') {
              pending.push(node.module);
            }
          }
          const deprecated = await this.#deprecation(id, found.module);
          if (deprecated) {
            this.list.add({
              code: 'deprecated-module',
              subject,
              message: deprecated.replacedBy
                ? `The manual includes "${id}", which is deprecated in favour of "${deprecated.replacedBy}".`
                : `The manual includes "${id}", which is deprecated.`,
              params: {
                module: id,
                ...(deprecated.replacedBy !== undefined && {
                  replacedBy: deprecated.replacedBy,
                }),
              },
            });
          }
        }
        await this.module({ type: 'module', lang: at, moduleId: id });
      }
    }
    return true;
  }

  /**
   * The manufacturer's details (#395): with `release.checkManufacturer` on, a configuration
   * without them is `missing-manufacturer` at every manual, which would be released without its
   * imprint. Off (the default): nothing.
   */
  #manufacturer(
    subject: Extract<LockSubject, { type: 'manual' }>,
    config: ProjectConfig,
  ): void {
    if (config.release?.checkManufacturer !== true) return;
    if (config.manufacturer !== undefined) return;
    this.list.add({
      code: 'missing-manufacturer',
      subject,
      message:
        'The project has no manufacturer details (manufacturer): the manual would be released without its imprint.',
    });
  }

  /**
   * The manual's stable addresses (#553), by the configuration checked:
   *
   * - `delivery-access-capped` when `delivery.access` opens them further than the deployment's
   *   cap (`CCMS_DELIVERY_MAX_ACCESS`), which they are served at instead;
   * - `address-taken` for each of its addresses (its slug, its former ones) that is the ID of
   *   another manual the reader sees, and for each address of another manual the reader sees
   *   that is its own ID:
   *   the address opens the configured manual (`manualOfSlug`), never the one of that ID.
   */
  async #addresses(manualId: string, config: ProjectConfig): Promise<void> {
    const subject: LockSubject = { type: 'manual', manualId };
    const access = config.delivery.access;
    const served = deliveryAccess(config, this.addresses);
    if (served !== access) {
      this.list.add({
        code: 'delivery-access-capped',
        subject,
        message: `delivery.access is "${access}", but this deployment allows at most "${served}": the addresses are served as "${served}".`,
        params: { access, maxAccess: served },
      });
    }
    const taken = (
      address: string,
      manual: string,
      as: 'slug' | 'formerly',
      message: string,
    ) =>
      this.list.add({
        code: 'address-taken',
        subject,
        message,
        params: { address, manual, as },
      });
    const manuals = config.delivery.manuals;
    const own = manuals[manualId];
    if (own) {
      const addresses = [
        ...(own.slug === undefined
          ? []
          : [{ address: own.slug, as: 'slug' as const }]),
        ...own.formerly.map((address) => ({
          address,
          as: 'formerly' as const,
        })),
      ];
      for (const { address, as } of addresses) {
        if (address !== manualId && (await this.#manualThere(address))) {
          taken(
            address,
            address,
            as,
            `This manual's address "${address}" (${as}) is the ID of the manual "${address}": that manual's address opens this one.`,
          );
        }
      }
    }
    for (const [other, entry] of Object.entries(manuals)) {
      // Only a manual the reader sees is named (a listing for one gone or hidden is no taker).
      if (other === manualId || !(await this.#manualThere(other))) continue;
      for (const as of ['slug', 'formerly'] as const) {
        const claims =
          as === 'slug'
            ? entry.slug === manualId
            : entry.formerly.includes(manualId);
        if (claims) {
          taken(
            manualId,
            other,
            as,
            `The manual "${other}" has this manual's ID "${manualId}" as its address (${as}): this manual's address opens that one.`,
          );
        }
      }
    }
  }

  /** Whether the reader sees a manual of this ID (a broken one too, where they may learn of it). */
  async #manualThere(id: string): Promise<boolean> {
    try {
      return (await this.snapshot.manual(id)) !== undefined;
    } catch (error) {
      if (error instanceof InvalidContentError) return true;
      throw error;
    }
  }

  /**
   * A module's deprecation (#266): its source-language file's as the reader
   * sees it, else that of `read` (the file read in another language).
   */
  async #deprecation(
    id: string,
    read: Module,
  ): Promise<Deprecation | undefined> {
    const { source } = (await this.config()).languages;
    if (read.meta.lang === source) return read.meta.deprecated;
    const found = await this.read(id, source);
    return found && 'module' in found
      ? found.module.meta.deprecated
      : read.meta.deprecated;
  }

  /**
   * What resolving the manual's page design for a variant and language found (#554), as checks
   * at the manual, `params.design` the design: a text left out or in the source language, a
   * region whose translation has other blocks, a placeholder, field or attribute without a value.
   * A design that is not there is `#pageDesign`'s `unknown-page-design`; a placeholder for the
   * release or date is left out, as a manual's checks never know them (#533).
   */
  #designIssues(
    resolution: ManualResolution,
    manualId: string,
    variant: string,
    lang: string,
  ): void {
    const design = resolution.design?.id;
    if (design === undefined) return;
    for (const issue of resolution.designIssues ?? []) {
      const code = DESIGN_ISSUE_CHECKS[issue.code];
      if (code === undefined) continue;
      if (
        issue.code === 'missing-placeholder-value' &&
        issue.name !== undefined &&
        NOT_KNOWN_TO_CHECKS.has(issue.name)
      ) {
        continue;
      }
      this.list.add({
        code,
        subject: { type: 'manual', manualId },
        message: `The page design "${design}"${issue.at === undefined ? '' : ` at ${issue.at}`}: ${issue.message}.`,
        params: {
          design,
          ...(issue.at !== undefined && { at: issue.at }),
          ...(issue.name !== undefined && { name: issue.name }),
        },
        variant,
        language: lang,
      });
    }
  }

  /**
   * The manual's page design's font files (#555), those it may embed (`resolvePageDesign` drops
   * fonts whose licence nobody confirmed): one the store does not hold, or whose first bytes are
   * no TrueType, OpenType, WOFF or WOFF2 font, is `page-design-missing-font`; the PDF uses the
   * default font in its place (the renderer leaves out what it cannot load).
   */
  async #designFonts(
    resolution: ManualResolution,
    manualId: string,
  ): Promise<void> {
    const design = resolution.design;
    if (!design) return;
    for (const role of ['body', 'heading'] as const) {
      const font = design.fonts[role];
      if (!font) continue;
      for (const style of [
        'regular',
        'bold',
        'italic',
        'boldItalic',
      ] as const) {
        const asset = font[style];
        if (asset === undefined || (await this.#isFont(asset))) continue;
        this.list.add({
          code: 'page-design-missing-font',
          subject: { type: 'manual', manualId },
          message: `The page design "${design.id}" at fonts.${role}.${style}: the font ${asset} is not stored or is no font; the PDF uses the default font.`,
          params: { design: design.id, at: `fonts.${role}.${style}`, asset },
        });
      }
    }
  }

  /**
   * The manual's cover images (#394, `manifestAssets`): one the blob store does not hold, or whose
   * bytes are no image (`COVER_IMAGE_TYPES`), is `missing-cover-image` (`params.at` where the
   * manifest names it, `params.asset`); the PDF leaves it out, and the title page closes the gap.
   */
  async #coverImages(
    manifest: Manifest,
    subject: { type: 'manual'; manualId: string },
  ): Promise<void> {
    for (const { asset, path } of manifestAssets(manifest)) {
      if (await this.#isImage(asset)) continue;
      this.list.add({
        code: 'missing-cover-image',
        subject,
        message: `The cover image ${asset} at ${path} is not stored or is no image; the PDF goes without it.`,
        params: { at: path, asset },
      });
    }
  }

  /** Whether `asset` (`sha256:<hash>`) is stored as an image a cover may be (by its first bytes). */
  #isImage(asset: string): Promise<boolean> {
    let found = this.#images.get(asset);
    if (!found) {
      const hash = asset.slice('sha256:'.length);
      found = (async () => {
        if (!asset.startsWith('sha256:') || !isSha256(hash)) return false;
        const stored = await this.blobs.get(hash);
        if (!stored) return false;
        let head: Uint8Array;
        try {
          head = await firstBytes(stored.stream, 4096);
        } catch {
          throw blobStoreUnavailable();
        }
        return COVER_IMAGE_TYPES.has(sniffImageType(head));
      })();
      this.#images.set(asset, found);
    }
    return found;
  }

  /** Whether `asset` (`sha256:<hash>`) is stored as a font (by its first bytes, `fontFormatOf`). */
  #isFont(asset: string): Promise<boolean> {
    let found = this.#fonts.get(asset);
    if (!found) {
      const hash = asset.slice('sha256:'.length);
      found = (async () => {
        if (!asset.startsWith('sha256:') || !isSha256(hash)) return false;
        const stored = await this.blobs.get(hash);
        if (stored) {
          let head: Uint8Array;
          try {
            head = await firstBytes(stored.stream, 4);
          } catch {
            throw blobStoreUnavailable();
          }
          return fontFormatOf(head) !== undefined;
        }
        const data = await this.snapshot.designAsset(hash);
        return data !== undefined && fontFormatOf(data) !== undefined;
      })();
      this.#fonts.set(asset, found);
    }
    return found;
  }

  /**
   * A `pdf-accessibility` for each reason the variant's PDF in `lang`, as the
   * reader sees it, cannot meet the configured PDF standard (PDF/UA-1); none
   * when the standard is off (`pdf.standard: none`). The PDF is rendered as
   * the PDF route renders it (same key, so the route then answers from the
   * cache), one at a time so a manual's checks never fill the renderer's
   * queue (`ContentChecks.#render`: one at a time across all requests). A
   * renderer under load fails the checks (503, try again) rather than leaving
   * the check out; a PDF that cannot be rendered at all (too slow, a broken
   * template) is a `pdf-not-checked` warning, its cause the PDF route's to
   * report. Any other error fails the checks.
   */
  async #pdf(
    resolution: ManualResolution,
    manualId: string,
    variant: string,
    lang: string,
  ): Promise<void> {
    const standard = resolution.config.pdf.standard !== 'none';
    // A page design's checks (#391), and a callout legend beside its image's (#548), need the
    // PDF whatever the standard.
    const layout = resolution.design || hasLegendBeside(resolution.manual);
    if (!standard && !layout) return;
    // With the standard off, the layout is what was not checked (#554): said, never silent.
    const notChecked = (reason: string) =>
      this.list.add(
        standard
          ? {
              code: 'pdf-not-checked',
              subject: { type: 'manual', manualId },
              message: `The PDF could not be rendered (${reason}): PDF/UA-1 not checked.`,
              params: { reason },
              variant,
              language: lang,
            }
          : {
              code: 'pdf-layout-not-checked',
              subject: { type: 'manual', manualId },
              message: `The PDF could not be rendered (${reason}): its layout was not checked.`,
              params: { reason },
              variant,
              language: lang,
            },
      );
    // One PDF too slow to render: the others are not tried in this request,
    // so a slow manual never holds a worker for each of its outputs in turn.
    if (this.#tooSlow) {
      notChecked('render-timeout');
      return;
    }
    const source = this.snapshot.renderSource(resolution);
    const key = await renderKey(
      { snapshot: this.snapshot, id: manualId, variant, lang },
      resolution,
      source,
    );
    try {
      const warnings = await this.render(source, resolution, key);
      for (const warning of warnings) {
        this.#layoutWarning(warning, manualId, variant, lang);
      }
    } catch (error) {
      if (error instanceof UnavailableError) throw error;
      // The design's own template does not compile (#396): where, and why.
      if (error instanceof PdfTemplateError) {
        this.#templateProblems(
          error.design,
          error.template,
          error.problems,
          { type: 'manual', manualId },
          { variant, language: lang },
        );
        return;
      }
      if (!(error instanceof PdfAccessibilityError)) {
        // Too slow or a broken template: the PDF route reports it; here, that
        // PDF/UA was not checked, so the checks never look clean by omission.
        if (
          error instanceof UnprocessableError ||
          error instanceof FailedError
        ) {
          if (
            error.code === 'render-timeout' ||
            error.code === 'render-memory-exceeded'
          ) {
            this.#tooSlow = true;
          }
          notChecked(error.code);
          return;
        }
        throw error;
      }
      // Laid out before the standard refused it: its layout's warnings too (#554).
      for (const warning of error.warnings) {
        this.#layoutWarning(warning, manualId, variant, lang);
      }
      for (const { message } of error.problems) {
        const problem = message.replace(/^PDF\/UA-1 error: /, '');
        this.list.add({
          code: 'pdf-accessibility',
          subject: { type: 'manual', manualId },
          message: `The PDF cannot meet PDF/UA-1: ${problem}`,
          params: { problem },
          variant,
          language: lang,
        });
      }
    }
  }

  /**
   * A page design's own template the repository does not have (#396): `page-design-unknown-
   * template` at `subject` (the manual laid out with the design, or the design); its preset lays
   * the PDF out then. Whether it is there is told from the listing of `templates/`, never by
   * reading it.
   */
  async #knownTemplate(
    design: { readonly id: string; readonly template?: string },
    subject: Extract<LockSubject, { type: 'manual' | 'design' }>,
  ): Promise<boolean> {
    const template = design.template;
    if (template === undefined) return true;
    if ((await this.#templateIds()).includes(template)) return true;
    this.list.add({
      code: 'page-design-unknown-template',
      subject,
      message: `The page design "${design.id}" names the template "${template}", which does not exist (templates/${template}/manual.typ); its preset lays the PDF out.`,
      params: { design: design.id, template },
    });
    return false;
  }

  #templates: Promise<readonly string[]> | undefined;
  #templateIds(): Promise<readonly string[]> {
    return (this.#templates ??= this.snapshot.designTemplateIds());
  }

  /** Each problem of a design's own template (#396) as a blocking check at `subject`. */
  #templateProblems(
    design: string,
    template: string,
    problems: readonly PdfTemplateProblem[],
    subject: Extract<LockSubject, { type: 'manual' | 'design' }>,
    where: { variant?: string; language?: string } = {},
  ): void {
    for (const problem of problems) {
      const at =
        problem.line > 0
          ? `${problem.file}:${problem.line}:${problem.column}`
          : problem.file;
      this.list.add({
        code: 'page-design-template-error',
        subject,
        message: `The page design "${design}"'s template "${template}" does not compile: ${at}: ${problem.message}`,
        params: {
          design,
          template,
          file: problem.file,
          line: String(problem.line),
          column: String(problem.column),
          problem: problem.message,
        },
        ...where,
      });
    }
  }

  /**
   * A page design a change set changes (#396): its own template, if it names one, compiled on
   * the renderer's small manual (`PdfRenderer.checkDesignTemplate`), each problem a blocking
   * `page-design-template-error` at the design, and a template that is not there
   * `page-design-unknown-template`. A design file that cannot be read has its own errors
   * (the working copy's issues); nothing more is said of it here.
   */
  async changedDesign(designId: string): Promise<void> {
    let design: Awaited<ReturnType<ReadableContent['pageDesign']>>;
    try {
      design = await this.snapshot.pageDesign(designId);
    } catch (error) {
      if (error instanceof InvalidContentError) return;
      throw error;
    }
    if (design?.template === undefined) return;
    const subject = { type: 'design', designId } as const;
    if (!(await this.#knownTemplate(design, subject))) return;
    const template = design.template;
    let files: Record<string, Uint8Array> | undefined;
    try {
      files = await this.snapshot.designTemplate(template);
    } catch (error) {
      if (!(error instanceof InvalidContentError)) throw error;
      this.#templateProblems(
        designId,
        template,
        [
          {
            file: `templates/${template}`,
            line: 0,
            column: 0,
            message: error.message,
            trace: [],
          },
        ],
        subject,
      );
      return;
    }
    if (!files) return;
    const problems = await this.checkTemplate({
      design,
      config: await this.config(),
      files,
      asset: (hash) => this.snapshot.pageDesignAsset(designId, hash),
    });
    this.#templateProblems(designId, template, problems, subject);
  }

  /**
   * A page design's layout warning as a check at the manual (#391): `params.at` where in the
   * design, and for a running head the text it shortened (`params.text`).
   */
  #layoutWarning(
    warning: PdfLayoutWarning,
    manualId: string,
    variant: string,
    lang: string,
  ): void {
    const pages =
      warning.pages > 1
        ? `pages ${warning.page} and ${warning.pages - 1} more`
        : `page ${warning.page}`;
    if (warning.code === 'callout-label-overflow') {
      // `callouts.<module>.<image>.<callout>`, as the renderer wrote it.
      const [, module, image, callout] = warning.at.split('.');
      if (!module || !image || !callout) return;
      this.list.add({
        code: warning.code,
        subject: { type: 'manual', manualId },
        message: `The legend of callout "${callout}" on image "${image}" (module "${module}") does not fit beside the image even at its smallest size (${pages}): it is cut off.`,
        params: { at: warning.at, module, image, callout },
        variant,
        language: lang,
      });
      return;
    }
    if (warning.code === 'safety-message-split') {
      // `safety.<module>.<block>`, as the renderer wrote it.
      const [, module, block] = warning.at.split('.');
      if (!module || !block) return;
      this.list.add({
        code: warning.code,
        subject: { type: 'manual', manualId },
        message: `The safety message "${block}" (module "${module}") is taller than a page (${pages}): it is broken across pages.`,
        params: {
          at: warning.at,
          module,
          block,
          ...(warning.text !== undefined && { text: warning.text }),
        },
        variant,
        language: lang,
      });
      return;
    }
    this.list.add({
      code: warning.code,
      subject: { type: 'manual', manualId },
      message:
        warning.code === 'page-design-overflow'
          ? `The page design's ${warning.at} does not fit its place (${pages}): it is cut off.`
          : `The running head ${warning.at} does not fit on one line (${pages}): it is shortened with an ellipsis.`,
      params: {
        at: warning.at,
        ...(warning.text !== undefined && { text: warning.text }),
      },
      variant,
      language: lang,
    });
  }

  /** A changed module at the head; false when it is not there for the reader. */
  async changedModule(subject: ModuleSubject): Promise<boolean> {
    const found = await this.read(subject.moduleId, subject.lang);
    if (!found) return false;
    await this.module(subject);
    if (!('module' in found)) return true;
    await this.#cycles(subject, found.module);
    const config = await this.config();
    if (subject.lang !== config.languages.source) return true;
    for (const lang of config.languages.targets) {
      const translated = {
        ...found.module,
        meta: { ...found.module.meta, lang },
      };
      // Only a language the reader would see a translation in.
      if (!(await this.snapshot.wouldSee({ module: translated }))) continue;
      if (await this.read(subject.moduleId, lang)) {
        await this.#outdated({ ...subject, lang }, found.module);
        continue;
      }
      this.list.add({
        code: 'missing-translation',
        subject,
        message: `No "${lang}" translation.`,
        params: { lang },
      });
    }
    return true;
  }

  /**
   * An `outdated-translation` on a translation (`subject`, in a target
   * language) whose record says blocks of `source` (the source-language
   * module, as the reader sees it) changed since it was made, or were never
   * translated; once per translation and request. A translation without a
   * record, or with one that cannot be read, counts every block.
   */
  async #outdated(subject: ModuleSubject, source: Module): Promise<void> {
    const key = `${subject.lang}/${subject.moduleId}`;
    if (this.#compared.has(key)) return;
    this.#compared.add(key);
    let record: Awaited<ReturnType<ReadableContent['translationRecord']>>;
    try {
      record = await this.snapshot.translationRecord(
        subject.moduleId,
        subject.lang,
      );
    } catch (error) {
      if (!(error instanceof InvalidContentError)) throw error;
      record = undefined;
    }
    const blocks = compareWithRecord(source, record).filter(
      (b) => b.state === 'outdated',
    ).length;
    if (blocks === 0) return;
    this.list.add({
      code: 'outdated-translation',
      subject,
      message: `${blocks} block(s) changed in the source since this translation.`,
      params: { lang: subject.lang, blocks: String(blocks) },
    });
  }

  /**
   * An `outdated-translation` at the manual (#656) for each target language it was read in
   * (`langs`) where units of its own text, or of its page design's region text, have a version
   * in that language whose record does not name their current source (changed since, or never
   * imported): `params.at` `coverImage` for its cover images' alternative text, `params.design`
   * the design for its region text. A unit without a version of its own is not outdated but
   * missing, which resolving reports (`page-design-missing-translation`).
   */
  async #outdatedOwnText(
    manifest: Manifest,
    manualId: string,
    config: ProjectConfig,
    langs: readonly string[],
  ): Promise<void> {
    const source = config.languages.source;
    const designId = pageDesignIdFor(manifest, config);
    let design: Awaited<ReturnType<ReadableContent['pageDesign']>>;
    try {
      design = await this.snapshot.pageDesign(designId);
    } catch (error) {
      if (!(error instanceof InvalidContentError)) throw error;
      design = undefined;
    }
    const subject: LockSubject = { type: 'manual', manualId };
    for (const lang of langs) {
      if (!config.languages.targets.includes(lang)) continue;
      const cover = compareManifestWithRecord(manifest, lang, source).filter(
        (u) => u.state === 'outdated',
      ).length;
      if (cover > 0) {
        this.list.add({
          code: 'outdated-translation',
          subject,
          message: `${cover} cover image text(s) changed in the source since the "${lang}" translation.`,
          params: { lang, blocks: String(cover), at: 'coverImage' },
          language: lang,
        });
      }
      if (!design) continue;
      const units = compareDesignWithRecord(design, lang, source).filter(
        (u) => u.state === 'outdated',
      ).length;
      if (units > 0) {
        this.list.add({
          code: 'outdated-translation',
          subject,
          message: `${units} unit(s) of the page design "${design.id}" changed in the source since the "${lang}" translation.`,
          params: { lang, blocks: String(units), design: design.id },
          language: lang,
        });
      }
    }
  }

  /**
   * One module's own checks (once per request): validation, images,
   * module references and cross-references, and whether its retrieval
   * chunks can be cut (`#chunks`).
   */
  async module(subject: ModuleSubject): Promise<void> {
    const key = `${subject.lang}/${subject.moduleId}`;
    if (this.#checked.has(key)) return;
    this.#checked.add(key);
    const found = await this.read(subject.moduleId, subject.lang);
    if (!found) return;
    this.#modules.add(subject.moduleId);
    if ('error' in found) {
      this.list.add({ code: 'invalid-module', subject, message: found.error });
      return;
    }
    const { module } = found;
    const config = await this.config();
    this.#orderOf(subject, module);
    if (config.languages.targets.includes(subject.lang)) {
      // A translation: compared with its source, as the reader sees it.
      const source = await this.read(subject.moduleId, config.languages.source);
      if (source && 'module' in source) {
        await this.#outdated(subject, source.module);
      }
    }

    for (const issue of validateModule(module, config)) {
      this.list.add({
        code: issue.code,
        subject,
        message: issue.message,
        ...(issue.at !== undefined && { blockId: issue.at }),
      });
    }
    // A module's deprecation is its source-language file's.
    const replacedBy =
      subject.lang === config.languages.source
        ? module.meta.deprecated?.replacedBy
        : undefined;
    if (
      replacedBy !== undefined &&
      replacedBy !== module.id &&
      (await this.snapshot.missingModule(replacedBy))
    ) {
      this.list.add({
        code: 'unknown-replacement',
        subject,
        message: `The module is deprecated in favour of "${replacedBy}", which does not exist.`,
        params: { replacedBy },
      });
    }
    const nodes = [...walk(module.blocks)];
    // The images and attached files at once, in batches: one store
    // request each.
    const files = nodes.flatMap(({ kind, node }) =>
      kind === 'block' && (node.type === 'image' || node.type === 'attachment')
        ? [node]
        : [],
    );
    for (let i = 0; i < files.length; i += IMAGES_AT_ONCE) {
      const batch = files.slice(i, i + IMAGES_AT_ONCE);
      const stored = await Promise.all(
        batch.map((file) => this.#storedType(file.asset)),
      );
      for (const [j, file] of batch.entries()) {
        const type = stored[j];
        if (type !== undefined) {
          // Downloads never take a name that does not fit (`GetAssetAction`):
          // the block names its file as something else than it is.
          if (file.type === 'attachment' && !nameFits(file.fileName, type)) {
            this.list.add({
              code: 'attachment-file-name',
              subject,
              blockId: file.id,
              message: `The file name "${file.fileName}" does not fit the attached file, stored as ${type}.`,
              params: { fileName: file.fileName, contentType: type },
            });
          }
          continue;
        }
        this.list.add(
          file.type === 'image'
            ? {
                code: 'missing-image',
                subject,
                blockId: file.id,
                message: `The image ${file.asset} is not stored.`,
                params: { asset: file.asset },
              }
            : {
                code: 'missing-attachment',
                subject,
                blockId: file.id,
                message: `The attached file ${file.asset} is not stored.`,
                params: { asset: file.asset },
              },
        );
      }
    }
    for (const { kind, node } of nodes) {
      if (kind === 'block' && node.type === 'moduleRef') {
        const lang = await this.languageFor(node.module, subject.lang);
        if (!lang && (await this.snapshot.missingModule(node.module))) {
          this.list.add({
            code: 'missing-module',
            subject,
            blockId: node.id,
            message: `module "${node.module}" does not exist`,
            params: { module: node.module },
          });
        }
        if (lang && node.block !== undefined) {
          await this.#oneBlock(subject, node.id, node.module, node.block, lang);
        }
      }
      for (const inline of ownInlineContent(node)) {
        await this.#xref(subject, node.id, inline);
      }
    }
    await this.#termLinks(subject, module);
    await this.#writingChecks(subject, module);
    this.#toCut.set(key, { subject, module });
  }

  /**
   * A `chunk-set-too-large` (#710) at each module `error` names (`largest`: those the reader
   * may see that expanded the most), with what its chunks expanded to.
   */
  chunkSetTooLarge(error: ChunkSetTooLargeError): void {
    for (const spent of error.largest) {
      this.list.add({
        code: 'chunk-set-too-large',
        subject: { type: 'module', lang: spent.lang, moduleId: spent.moduleId },
        message: `The retrieval chunks of this commit are too large together (once released, \`GET /chunks\` refuses it): this module's expanded to ${spent.chars.toLocaleString('en')} characters and ${spent.nodes.toLocaleString('en')} content nodes, among the most. Refer to fewer modules, over fewer paths.`,
        params: {
          chars: String(spent.chars),
          nodes: String(spent.nodes),
          ...(error.kept && { kept: 'true' }),
        },
      });
    }
  }

  /**
   * Cuts the retrieval chunks of every module checked (`#chunks`), in module ID, then language
   * order, all on one budget (#711): `ExpansionBudget.forContent` over those modules, as
   * `GET /chunks` holds a commit's. Past it, the rest are not cut, and a `chunks-not-checked`
   * at the first of them says how many.
   */
  async #cutAll(): Promise<void> {
    if (this.#toCut.size === 0) return;
    const pending = [...this.#toCut.values()].sort(
      (a, b) =>
        codeUnits(a.subject.moduleId, b.subject.moduleId) ||
        codeUnits(a.subject.lang, b.subject.lang),
    );
    this.#toCut.clear();
    const config = await this.config();
    const budget = ExpansionBudget.forContent(
      pending.map(({ module }) => weightOf(module.blocks)),
      this.limits,
    );
    for (const [i, { subject, module }] of pending.entries()) {
      if (await this.#chunks(subject, module, config, budget)) continue;
      const modules = pending.length - i;
      this.list.add({
        code: 'chunks-not-checked',
        subject,
        message: `Cutting the retrieval chunks of the modules checked took more than their budget (${budget.limit.nodes.toLocaleString('en')} content nodes, ${budget.limit.chars.toLocaleString('en')} characters or ${budget.limit.cells.toLocaleString('en')} table cells): whether those of ${modules} module file(s), from this one on, can be cut was not checked.`,
        params: { modules: String(modules) },
      });
      return;
    }
  }

  /**
   * An `expansion-too-large` at a module whose retrieval chunks pass the limits of #679 once
   * the modules it refers to are included (#688), so `GET /chunks` leaves it out: made here as
   * there (`toChunks`, its own count, every variant block kept), from what the reader may see.
   * Reads what the chunks read first: each module it reaches by reference (in its language, or
   * the source language's), and each cross-reference target for its title, once per request.
   *
   * What the cut spends is spent from `budget`, the run's (#711); false, and nothing reported,
   * once that is spent. The outcome is kept with what it spent per commit, reading key,
   * language and module (`CHUNK_CUTS_KEPT`), so checking the same content again costs no work
   * and spends the same: a cut is kept only when the budget has room left for a whole module at
   * the limits, so it is never stopped by the run it was made for. With less room, or for
   * content read through an overlay, it is cut on the run's budget itself and not kept.
   */
  async #chunks(
    subject: ModuleSubject,
    module: Module,
    config: ProjectConfig,
    budget: ExpansionBudget,
  ): Promise<boolean> {
    let cut: ChunkCut;
    try {
      const key = [
        this.snapshot.commit,
        this.snapshot.readingKey,
        subject.lang,
        subject.moduleId,
      ].join('|');
      const kept = this.snapshot.overlaid ? undefined : this.cut.peek(key);
      if (
        kept ||
        (!this.snapshot.overlaid && roomForOne(budget, this.limits))
      ) {
        cut = await (kept ??
          this.cut.get(key, () =>
            this.#cutChunks(
              subject,
              module,
              config,
              new ExpansionBudget(UNBOUNDED),
            ),
          ));
        budget.charge(cut.spent.nodes, cut.spent.chars, cut.spent.cells);
      } else {
        cut = await this.#cutChunks(subject, module, config, budget);
      }
    } catch (error) {
      if (error instanceof ExpansionBudgetError) return false;
      throw error;
    }
    if (cut.outcome === 'ok') return true;
    this.list.add({
      code: 'expansion-too-large',
      subject,
      message:
        cut.outcome === 'depth'
          ? `The module's retrieval chunks are left out: its blocks and module references nest more than ${this.limits.depth} deep.`
          : `The module's retrieval chunks are left out: once its module references are included it holds more than ${this.limits.nodes.toLocaleString('en')} content nodes, ${this.limits.chars.toLocaleString('en')} characters or ${this.limits.cells.toLocaleString('en')} table cells (rows × columns) (a module referred to over several paths counts once per path).`,
      params: { reason: cut.outcome },
    });
    return true;
  }

  /**
   * Cuts the module's chunks as `GET /chunks` would, for `#chunks`, spending from `budget`
   * (`ExpansionBudgetError` past it).
   */
  async #cutChunks(
    subject: ModuleSubject,
    module: Module,
    config: ProjectConfig,
    budget: ExpansionBudget,
  ): Promise<ChunkCut> {
    const { lang } = subject;
    const { source } = config.languages;
    const langs = lang === source ? [source] : [lang, source];
    const loaded = new Map<string, Module>([[`${lang}/${module.id}`, module]]);
    /** Reads `id` in each language the chunks may read it in; the one they would include. */
    const load = async (id: string): Promise<Module | undefined> => {
      let first: Module | undefined;
      for (const lang of langs) {
        const found = await this.read(id, lang);
        if (!found || !('module' in found)) continue;
        loaded.set(`${lang}/${id}`, found.module);
        first ??= found.module;
      }
      return first;
    };
    const followed = new Set<string>([module.id]);
    const titled = new Set<string>([module.id]);
    const pending: Module[] = [module];
    for (let i = 0; i < pending.length; i++) {
      for (const { kind, node } of walk((pending[i] as Module).blocks)) {
        if (kind === 'block' && node.type === 'moduleRef') {
          if (followed.has(node.module)) continue;
          followed.add(node.module);
          titled.add(node.module);
          const next = await load(node.module);
          if (next) pending.push(next);
          continue;
        }
        for (const inline of ownInlineContent(node)) {
          for (const n of inline) {
            if (n.type !== 'xref' || titled.has(n.module)) continue;
            titled.add(n.module);
            await load(n.module);
          }
        }
      }
    }
    const before = budget.spent;
    let outcome: ChunkCut['outcome'] = 'ok';
    try {
      toChunks({
        module,
        config,
        loadModule: (id, lang) => loaded.get(`${lang}/${id}`),
        budget,
        limits: this.limits,
      });
    } catch (error) {
      if (!(error instanceof ExpansionTooLargeError)) throw error;
      outcome = error.reason;
    }
    const after = budget.spent;
    return {
      outcome,
      spent: {
        nodes: after.nodes - before.nodes,
        chars: after.chars - before.chars,
        cells: after.cells - before.cells,
      },
    };
  }

  /**
   * The term links of a module (#245): an `unknown-term` at each block
   * linking a term that does not exist (or whose file is no term), a
   * `deprecated-term` at each linking a deprecated one. Terms carry no
   * audience, so every reader of the commit reads them alike.
   */
  async #termLinks(subject: ModuleSubject, module: Module): Promise<void> {
    for (const { termId, blockId } of termLinks(module.blocks)) {
      const term = await this.#term(termId);
      if (term === undefined || term === 'unreadable') {
        this.list.add({
          code: 'unknown-term',
          subject,
          blockId,
          message:
            term === undefined
              ? `links the term "${termId}", which does not exist`
              : `links the term "${termId}", whose file cannot be read`,
          params: { term: termId },
        });
      } else if (term.status === 'deprecated') {
        this.list.add({
          code: 'deprecated-term',
          subject,
          blockId,
          message: term.replacedBy
            ? `links the term "${termId}", which is deprecated in favour of "${term.replacedBy}"`
            : `links the term "${termId}", which is deprecated`,
          params: {
            term: termId,
            ...(term.replacedBy !== undefined && {
              replacedBy: term.replacedBy,
            }),
          },
        });
      }
    }
  }

  /**
   * The writing checks of a module (#55, `checkWriting`): forbidden and deprecated term
   * variants and the style rules of its language, each a `forbidden-term` or `style-rule` at its
   * block (a callout's legend at its image) with the severity the configuration gives it, and a
   * `writing-not-checked` when they stopped before the end of its text.
   */
  async #writingChecks(subject: ModuleSubject, module: Module): Promise<void> {
    const rules = await this.#writingRulesFor(subject.lang);
    if (rules.empty) return;
    const result = checkWriting(module, rules);
    for (const finding of result.findings) {
      this.list.add({
        code: finding.code,
        subject,
        blockId: finding.image ?? finding.blockId,
        message: finding.message,
        severity: finding.severity,
        params: writingParams(finding),
      });
    }
    if (!result.complete) {
      this.list.add({
        code: 'writing-not-checked',
        subject,
        message: `The writing checks stopped before the end of the module's text (${result.stopped}): what comes after was not checked.`,
        params: { stopped: result.stopped ?? 'steps' },
      });
    }
  }

  /** The writing checks of `lang` at this commit: its terms and the configuration's rules. */
  #writingRulesFor(lang: string): Promise<WritingRules> {
    let found = this.#writingRules.get(lang);
    if (!found) {
      const make = async () => {
        const [config, listed] = await Promise.all([
          this.config(),
          this.snapshot.terms(),
        ]);
        return compileWritingRules({
          terms: listed.flatMap((entry) =>
            'term' in entry ? [entry.term] : [],
          ),
          styleRules: config.styleRules,
          terminology: config.terminology,
          lang,
        });
      };
      found = this.snapshot.overlaid
        ? make()
        : this.writing.get(JSON.stringify([this.snapshot.commit, lang]), make);
      this.#writingRules.set(lang, found);
    }
    return found;
  }

  #term(id: string): Promise<Term | 'unreadable' | undefined> {
    let found = this.#terms.get(id);
    if (!found) {
      found = this.snapshot.term(id).catch((error: unknown) => {
        if (error instanceof InvalidContentError) return 'unreadable' as const;
        throw error;
      });
      this.#terms.set(id, found);
    }
    return found;
  }

  /**
   * A `module-cycle` at each module reference block of a changed module
   * whose references lead back to it (#224), whether or not a manual
   * includes it: the block that closes the cycle, as resolving reports it
   * there (`params.module`: the module it refers to, unless itself).
   *
   * References are followed as the reader sees them, in the module's
   * language with the source language's file as fallback, as resolving
   * reads them, and whatever their variant conditions (a cycle in any
   * variant is one). A module the reader may not see, or whose file
   * cannot be read, is not followed: a cycle through one is not reported
   * to that reader (so it neither names nor counts it), only to one who
   * sees every module in it.
   *
   * One search per changed module (what it reaches, then back from it to
   * which of those lead to it), each module's references read once per
   * request (`#refs`), and at most `CYCLE_STEPS` references followed per
   * request: past that, only the cycles already found (and references to
   * itself) are reported. A message names at most `CYCLE_NAMED` modules.
   */
  async #cycles(subject: ModuleSubject, module: Module): Promise<void> {
    const self = subject.moduleId;
    const own = refsOf(module);
    // Who refers to whom, among the modules the changed one reaches.
    const referredBy = new Map<string, string[]>();
    const reached = new Set<string>([self]);
    const pending = [...own];
    for (const id of own) referredBy.set(id, [self]);
    for (const id of own) reached.add(id);
    // Queues walked by index: shifting a long array is slow.
    for (let i = 0; i < pending.length; i++) {
      const id = pending[i] as string;
      if (id === self) continue;
      const refs = await this.#refs(id, subject.lang);
      if (refs === undefined) continue;
      // Past the budget, only what was found so far (a reference to
      // itself still is).
      if ((this.#cycleSteps += refs.length) > CYCLE_STEPS) break;
      for (const to of refs) {
        const by = referredBy.get(to);
        if (by) by.push(id);
        else referredBy.set(to, [id]);
        if (!reached.has(to)) {
          reached.add(to);
          pending.push(to);
        }
      }
    }
    // Back from the changed module: the next step of each module's
    // shortest way to it (among those found).
    const next = new Map<string, string>();
    const back = [self];
    for (let i = 0; i < back.length; i++) {
      const id = back[i] as string;
      for (const from of referredBy.get(id) ?? []) {
        if (from === self || next.has(from)) continue;
        next.set(from, id);
        back.push(from);
      }
    }
    // The message names at most `CYCLE_NAMED` modules, once per target.
    const messages = new Map<string, string>();
    const messageFor = (target: string): string => {
      let found = messages.get(target);
      if (found === undefined) {
        const way = [self];
        let id = target;
        for (; id !== self && way.length < CYCLE_NAMED;) {
          way.push(id);
          id = next.get(id) as string;
        }
        if (id !== self) way.push('…');
        way.push(self);
        found = `module reference cycle: ${way.join(' → ')}`;
        messages.set(target, found);
      }
      return found;
    };
    for (const { kind, node } of walk(module.blocks)) {
      if (kind !== 'block' || node.type !== 'moduleRef') continue;
      const target = node.module;
      if (target !== self && !next.has(target)) continue;
      this.list.add({
        code: 'module-cycle',
        subject,
        blockId: node.id,
        message: messageFor(target),
        ...(target !== self && { params: { module: target } }),
      });
    }
  }

  /**
   * The modules a module refers to (once each), read in `lang` or as
   * resolving falls back; `undefined` when the reader cannot read it.
   * Kept for the request.
   */
  #refs(id: string, lang: string): Promise<readonly string[] | undefined> {
    const key = `${lang}/${id}`;
    let found = this.#refsRead.get(key);
    if (!found) {
      found = (async () => {
        const at = await this.languageFor(id, lang, true);
        if (at === undefined) return undefined;
        const read = await this.read(id, at);
        return read && 'module' in read ? refsOf(read.module) : undefined;
      })();
      this.#refsRead.set(key, found);
    }
    return found;
  }

  /**
   * Where the modules gone from the head are still used there: manuals
   * naming one, modules referring to one. Only modules missing everywhere
   * count (`missingModule`), as for any other reference.
   */
  async whereUsed(gone: readonly string[]): Promise<void> {
    const missing: string[] = [];
    for (const id of gone) {
      if (await this.snapshot.missingModule(id)) missing.push(id);
    }
    if (missing.length === 0) return;
    for (const listing of await this.snapshot.manuals()) {
      if (!('manifest' in listing)) continue;
      const named = new Set(manifestModules(listing.manifest.entries));
      for (const id of missing) {
        if (!named.has(id)) continue;
        this.#manuals.set(
          listing.id,
          sourceTitle(listing.manifest.title, await this.config()),
        );
        this.list.add({
          code: 'missing-module',
          subject: { type: 'manual', manualId: listing.id },
          message: `module "${id}" does not exist`,
          params: { module: id },
        });
      }
    }
    // Of the modules still referring to one, only those references: their
    // other problems are not this change's.
    for (const listing of await this.snapshot.modules()) {
      if (!('module' in listing)) continue;
      const subject: ModuleSubject = {
        type: 'module',
        lang: listing.lang,
        moduleId: listing.id,
      };
      for (const { kind, node } of walk(listing.module.blocks)) {
        if (
          kind === 'block' &&
          node.type === 'moduleRef' &&
          missing.includes(node.module)
        ) {
          this.list.add({
            code: 'missing-module',
            subject,
            blockId: node.id,
            message: `module "${node.module}" does not exist`,
            params: { module: node.module },
          });
        }
        for (const content of ownInlineContent(node)) {
          for (const n of content) {
            if (n.type !== 'xref' || !missing.includes(n.module)) continue;
            this.list.add({
              code: 'xref-unknown-module',
              subject,
              blockId: node.id,
              message: `links to "${n.module}", which does not exist`,
              params: { module: n.module },
            });
          }
        }
      }
      this.#orderOf(subject, listing.module);
    }
  }

  /**
   * A module reference to one block (#223): `module-ref-unknown-block` when the module, as the
   * reader sees it in `lang` (the language resolving reads it in), has no such block. Only a
   * module the reader may see is looked into, so the check names nothing they could not read.
   */
  async #oneBlock(
    subject: ModuleSubject,
    blockId: string,
    module: string,
    block: string,
    lang: string,
  ): Promise<void> {
    const target = await this.read(module, lang);
    if (!target || !('module' in target)) return;
    if (this.#placesOf(target.module).has(block)) return;
    this.list.add({
      code: 'module-ref-unknown-block',
      subject,
      blockId,
      message: `refers to the block "${block}" of "${module}", which does not exist`,
      params: { module, block },
    });
  }

  /** A module's blocks by ID (`blockPlaces`), worked out once per module read in this request. */
  #placesOf(module: Module): ReadonlyMap<string, unknown> {
    let found = this.#places.get(module);
    if (!found) {
      found = blockPlaces(module.blocks);
      this.#places.set(module, found);
    }
    return found;
  }

  async #xref(
    subject: ModuleSubject,
    blockId: string,
    content: readonly Inline[],
  ): Promise<void> {
    for (const node of content) {
      if (node.type !== 'xref') continue;
      const lang = await this.languageFor(node.module, subject.lang);
      if (lang === undefined) {
        if (await this.snapshot.missingModule(node.module)) {
          this.list.add({
            code: 'xref-unknown-module',
            subject,
            blockId,
            message: `links to "${node.module}", which does not exist`,
            params: { module: node.module },
          });
        }
        continue;
      }
      if (node.block === undefined) continue;
      const target = await this.read(node.module, lang);
      if (!target || !('module' in target)) continue;
      const has = [...walk(target.module.blocks)].some(
        ({ node: n }) => n.id === node.block,
      );
      if (!has) {
        this.list.add({
          code: 'xref-unknown-block',
          subject,
          blockId,
          message: `links to "${node.module}#${node.block}", which does not exist`,
          params: { module: node.module, block: node.block },
        });
      }
    }
  }

  async #resolutionIssue(
    issue: ResolveIssue,
    manualId: string,
    variant: string,
    lang: string,
  ): Promise<void> {
    // Not the reader's to fix; and a broken file is reported by its module.
    if (issue.code === 'outside-scope' || issue.code === 'invalid-module') {
      return;
    }
    let code: CheckCode = issue.code;
    let message = issue.message;
    let params: Record<string, string> | undefined;
    if (issue.target) {
      // Named by what it links to, as a module's own check names it, so
      // both find one check; nothing about a target the reader may not see.
      const { module: target, block } = issue.target;
      if ((await this.languageFor(target, lang)) === undefined) {
        if (!(await this.snapshot.missingModule(target))) return;
        code = 'xref-unknown-module';
        message = `links to "${target}", which does not exist`;
      }
      params = {
        module: target,
        ...(block !== undefined &&
          (code === 'xref-unknown-block' ||
            code === 'module-ref-unknown-block') && { block }),
      };
    } else if (
      issue.module !== undefined &&
      issue.at !== undefined &&
      issue.module !== issue.at.module
    ) {
      params = { module: issue.module };
    }
    const where = { variant, language: lang, message };
    const manual: LockSubject = { type: 'manual', manualId };
    const config = await this.config();
    if (issue.at) {
      // The file resolving read: a broken one in `lang` falls back.
      const at = await this.languageFor(issue.at.module, lang, true);
      if (at !== undefined) {
        this.list.add({
          ...where,
          code,
          subject: { type: 'module', lang: at, moduleId: issue.at.module },
          blockId: issue.at.block,
          ...(params && { params }),
        });
        return;
      }
    }
    if (issue.module !== undefined && code === 'missing-translation') {
      this.list.add({
        ...where,
        code,
        subject: {
          type: 'module',
          lang: config.languages.source,
          moduleId: issue.module,
        },
        params: { lang },
      });
      return;
    }
    if (issue.module !== undefined && code !== 'missing-module') {
      const at = await this.languageFor(issue.module, lang, true);
      if (at !== undefined) {
        this.list.add({
          ...where,
          code,
          subject: { type: 'module', lang: at, moduleId: issue.module },
        });
        return;
      }
    }
    this.list.add({
      ...where,
      code,
      subject: manual,
      ...(issue.module !== undefined && { params: { module: issue.module } }),
    });
  }

  /** Records where each block of `module` is, for ordering its checks. */
  #orderOf(subject: ModuleSubject, module: Module): void {
    const key = `${subject.lang}/${subject.moduleId}`;
    if (this.#order.has(key)) return;
    const order = new Map<string, number>();
    let position = 0;
    for (const { node } of walk(module.blocks)) order.set(node.id, position++);
    this.#order.set(key, order);
  }

  /**
   * The type a file is stored as: the blob store's, or the one sniffed
   * from a file in the repository (the old layout); `undefined` when it
   * is not stored.
   */
  #storedType(asset: string): Promise<string | undefined> {
    let found = this.#files.get(asset);
    if (!found) {
      const hash = asset.slice('sha256:'.length);
      found = (async () => {
        if (!isSha256(hash)) return undefined;
        const stored = await this.blobs.head(hash);
        if (stored) return stored.contentType;
        const data = await this.snapshot.asset(hash);
        return data === undefined ? undefined : sniffImageType(data);
      })();
      this.#files.set(asset, found);
    }
    return found;
  }
}

function* manifestModules(
  entries: readonly ManifestEntry[],
): Generator<string> {
  for (const entry of entries) {
    if ('module' in entry) yield entry.module;
    else yield* manifestModules(entry.entries);
  }
}

/** The modules a module's reference blocks name, once each, in order. */
function refsOf(module: Module): string[] {
  const ids = new Set<string>();
  for (const { kind, node } of walk(module.blocks)) {
    if (kind === 'block' && node.type === 'moduleRef') ids.add(node.module);
  }
  return [...ids];
}

/** The first `bytes` of `stream` (fewer for a shorter one); the rest is never read. */
async function firstBytes(
  stream: AsyncIterable<Uint8Array> & { destroy(): void },
  bytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      chunks.push(chunk);
      size += chunk.byteLength;
      if (size >= bytes) break;
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks).subarray(0, bytes);
}

/**
 * Whether `budget` has room left for a whole module at the limits of #679 (`limits`), so a cut
 * made on a budget of its own cannot pass it by more than its last count (`Run.#chunks`).
 */
function roomForOne(budget: ExpansionBudget, limits: ExpansionLimits): boolean {
  const { spent, limit } = budget;
  return (
    limit.nodes - spent.nodes >= limits.nodes &&
    limit.chars - spent.chars >= limits.chars &&
    limit.cells - spent.cells >= limits.cells
  );
}

/** Code-unit order, so the order does not depend on the locale. */
function codeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A title as a listing without a language names it: in the source language (#731). */
function sourceTitle(title: LocalizedText, config: ProjectConfig): string {
  return textIn(title, config.languages.source, config.languages.source);
}
