import { Readable } from 'node:stream';
import { extname } from 'node:path';
import { Injectable } from '@nestjs/common';
import {
  type Module,
  noticeRuleOf,
  parseVariantSlug,
  type ProjectConfig,
  type VariantValues,
  variantSlug,
  walk,
} from '@openfolia/content-model';
import { DitaExportTooLargeError, exportDita } from '@openfolia/dita';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  NotFoundError,
  TooManyRequestsError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import {
  PackageSends,
  PackageSendSettings,
} from '../../../base/core/package-sends.js';
import type { PageRequest, Paginated } from '../../../base/core/paging.js';
import {
  MAX_ZIP_BYTES,
  MAX_ZIP_ENTRIES,
  zipSize,
  zipStream,
} from '../../../base/core/zip-stream.js';
import { BlobStore, isSha256 } from '../../../blobs/core/blob-store.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { sniffImageType } from '../../../assets/core/sniff-image-type.js';
import { mediaExtension } from '../../../iirds/core/iirds-package.js';
import {
  releaseAt,
  visibleIn,
} from '../../../releases/core/actions/release-outputs.action.js';
import type { Release } from '../../../releases/core/release.js';
import { ReleaseArchiveSettings } from '../../../releases/core/release-archive.js';
import {
  outputRenderer,
  type OutputFilter,
  type ReleaseOutput,
} from '../../../releases/core/release-output.js';
import { ReleaseOutputStore } from '../../../releases/core/release-output-store.js';
import { ReleaseStore } from '../../../releases/core/release-store.js';
import {
  type DitaFile,
  ditaFileName,
  type DitaOptions,
  type DitaPlan,
} from '../dita-package.js';

/** How many packages' plans made are kept (`DitaPlans`), beside those still being made. */
export const PLANS_KEPT = 32;

/**
 * The most bytes the plans kept may hold of their own (the XML made for
 * them and the safety symbols), together; a plan holding more than a
 * quarter of it is not kept, so one large manual never flushes the others.
 */
export const PLANS_KEPT_BYTES = 64 * 1024 * 1024;

/** How many packages are made at once, server-wide; more wait their turn. */
export const PLANS_MADE_AT_ONCE = 2;

/** How many may wait for their turn; past it a request is 429 `rate-limited`. */
export const PLANS_WAITING = 16;

/** The most modules one package reads: `MAX_PACKAGE_MODULES` lookups per language (a module in a language, found or not); past it 422 `dita-package-too-large`. */
export const MAX_PACKAGE_MODULES = 20_000;

/** The export's bounds (`@openfolia/dita`): elements and texts, and characters as written (escaped), of every file together. */
export const MAX_PACKAGE_NODES = 1_000_000;
export const MAX_PACKAGE_CHARS = 48 * 1024 * 1024;

/** The DITA package files being sent (`PackageSends`): their turns apart from the iiRDS packages'. */
@Injectable()
export class DitaSends extends PackageSends {
  constructor(settings: PackageSendSettings) {
    super(settings, 'DITA package');
  }
}

const encoder = new TextEncoder();

function tooLarge(
  detail: string,
  meta?: Record<string, number>,
): UnprocessableError {
  return new UnprocessableError('dita-package-too-large', detail, meta);
}

/**
 * Makes the plan of a release output's DITA package (#433), and keeps the
 * last `PLANS_KEPT`: the same output with the same options always makes
 * the same plan, since the release's tag fixes the content and the
 * configuration, and the package is made as the manual's audience reads
 * it (`outputRenderer`), never as the reader does. Who may read it, and
 * which languages, is judged before a plan is looked up.
 */
@Injectable()
export class DitaPlans {
  /** The plans, least recently used first; those being made are never dropped, so a second request joins one. */
  private readonly kept = new Map<
    string,
    { plan: Promise<DitaPlan>; bytes: number; settled: boolean }
  >();
  private keptSettled = 0;
  private keptBytes = 0;
  private making = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly snapshots: OpenSnapshotAction,
    private readonly blobs: BlobStore,
  ) {}

  /** The plan of `output`'s package in `languages` (judged for the reader already), `config` the configuration at the tag. */
  plan(
    release: Release,
    output: ReleaseOutput,
    config: ProjectConfig,
    languages: readonly string[],
    references: DitaOptions['references'],
  ): Promise<DitaPlan> {
    const key = [output.id, languages.join(','), references].join('|');
    const found = this.kept.get(key);
    if (found) {
      this.kept.delete(key);
      this.kept.set(key, found);
      return found.plan;
    }
    const entry = {
      plan: this.turn(() =>
        this.make(release, output, config, languages, references),
      ),
      bytes: 0,
      settled: false,
    };
    this.kept.set(key, entry);
    entry.plan.then(
      (plan) => {
        if (this.kept.get(key) !== entry) return;
        const bytes = plan.files.reduce(
          (sum, f) => sum + ('bytes' in f ? f.size : 0),
          0,
        );
        if (bytes > PLANS_KEPT_BYTES / 4) {
          this.kept.delete(key);
          return;
        }
        entry.settled = true;
        entry.bytes = bytes;
        this.keptSettled++;
        this.keptBytes += bytes;
        this.trim();
      },
      () => {
        if (this.kept.get(key) === entry) this.kept.delete(key);
      },
    );
    return entry.plan;
  }

  private async turn<T>(make: () => Promise<T>): Promise<T> {
    if (this.making >= PLANS_MADE_AT_ONCE) {
      if (this.waiting.length >= PLANS_WAITING) {
        throw new TooManyRequestsError(
          'Too many DITA packages are being made: try again shortly.',
          10,
        );
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.making++;
    }
    try {
      return await make();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.making--;
    }
  }

  private trim(): void {
    for (const [key, entry] of this.kept) {
      if (
        this.keptSettled <= PLANS_KEPT &&
        this.keptBytes <= PLANS_KEPT_BYTES
      ) {
        return;
      }
      if (!entry.settled) continue;
      this.kept.delete(key);
      this.keptSettled--;
      this.keptBytes -= entry.bytes;
    }
  }

  private async make(
    release: Release,
    output: ReleaseOutput,
    config: ProjectConfig,
    languages: readonly string[],
    references: DitaOptions['references'],
  ): Promise<DitaPlan> {
    // As the manual's audience reads it, as its PDF was rendered.
    const actor = outputRenderer(output.audience, config);
    const content = await this.snapshots.handle({ actor, ref: release.tag });
    if (content.commit !== release.commit) {
      throw new NotFoundError(`No release "${release.id}".`);
    }
    const manual = await content.manual(output.manualId);
    if (!manual) {
      throw new NotFoundError(
        `No DITA package "${output.id}" of this release.`,
      );
    }
    const { manifest } = manual;
    // A DITA map holds whole modules as topics: a manual of gathered safety notices (#670),
    // a part of each module, regrouped, is not one.
    if (noticeRuleOf(manifest)) {
      throw new UnprocessableError(
        'dita-notices-unsupported',
        'This manual gathers safety notices from its source manual (`rule.notices`): a DITA package holds whole modules, so it has none. Its PDF and iiRDS package hold it.',
      );
    }
    const variant: VariantValues =
      manifest.variants.find((v) => variantSlug(v) === output.variant) ??
      parseVariantSlug(output.variant) ??
      {};

    // Every module the export may read, in each language and the source
    // language (a missing translation's fallback): the manual's, and those
    // their module references name, read before the export (which is pure).
    const source = config.languages.source;
    const langs = [...new Set([...languages, source])];
    const modules = new Map<string, Module>();
    const seen = new Set<string>();
    const queue: string[] = [];
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      queue.push(id);
    };
    const entries = (list: typeof manifest.entries): void => {
      for (const entry of list) {
        if ('module' in entry) visit(entry.module);
        else entries(entry.entries);
      }
    };
    entries(manifest.entries);
    // Each lookup counts, found or not, so references to modules that do not exist are bounded too.
    let lookups = 0;
    while (queue.length > 0) {
      const id = queue.shift() as string;
      for (const lang of langs) {
        if (++lookups > MAX_PACKAGE_MODULES * langs.length) {
          throw tooLarge(
            `The package would read more than ${MAX_PACKAGE_MODULES} modules (each looked up in each of its ${langs.length} languages, found or not).`,
            { limit: MAX_PACKAGE_MODULES },
          );
        }
        const module = await content.module(id, lang);
        if (!module) continue;
        modules.set(`${lang}/${id}`, module);
        for (const { node } of walk(module.blocks)) {
          if ('type' in node && node.type === 'moduleRef') visit(node.module);
        }
      }
    }

    // The images and attached files those modules show: the blob store's,
    // else (an image of the old layout) the repository's, read as the
    // renderer's actor; one stored nowhere the export reports.
    const media = new Map<
      string,
      { extension: string; file: (name: string) => DitaFile }
    >();
    const refs = new Set<string>();
    for (const module of modules.values()) {
      for (const { node } of walk(module.blocks)) {
        if (
          'type' in node &&
          (node.type === 'image' || node.type === 'attachment')
        ) {
          refs.add(node.asset);
        }
      }
    }
    for (const ref of [...refs].sort()) {
      const hash = ref.startsWith('sha256:') ? ref.slice(7) : '';
      if (!isSha256(hash)) continue;
      const stored = await this.blobs.head(hash);
      if (stored) {
        media.set(ref, {
          extension: mediaExtension(stored.contentType),
          file: (name) => ({ name, size: stored.size, blob: hash }),
        });
        continue;
      }
      const bytes = await content.asset(hash);
      if (bytes) {
        const size = bytes.length;
        media.set(ref, {
          extension: mediaExtension(sniffImageType(bytes)),
          file: (name) => ({
            name,
            size,
            load: async () => {
              const again = await content.asset(hash);
              if (!again || again.length !== size) {
                throw new NotFoundError(`The file "${name}" is gone.`);
              }
              return again;
            },
          }),
        });
      }
    }
    const artwork = await content.symbolArtwork();
    // A derived manual's keys are its source's text attributes under its own (#451).
    const attributes = await content.textAttributesOf(manifest);

    let exported;
    try {
      exported = exportDita({
        config,
        manifest: { ...manifest, attributes },
        languages,
        variants: [variant],
        references,
        module: (id, lang) => modules.get(`${lang}/${id}`),
        asset: (ref) => media.get(ref),
        symbol: (id) => {
          const path = artwork.get(id);
          return path === undefined
            ? undefined
            : { extension: extname(path).toLowerCase() };
        },
        limits: { maxNodes: MAX_PACKAGE_NODES, maxChars: MAX_PACKAGE_CHARS },
      });
    } catch (error) {
      if (error instanceof DitaExportTooLargeError) {
        throw tooLarge(
          `The package would hold more than its bounds allow (${MAX_PACKAGE_NODES} elements and texts, ${MAX_PACKAGE_CHARS} characters).`,
          { nodes: MAX_PACKAGE_NODES, chars: MAX_PACKAGE_CHARS },
        );
      }
      throw error;
    }

    const files: DitaFile[] = [];
    let mediaCount = 0;
    for (const file of exported.files) {
      if ('text' in file) {
        const bytes = encoder.encode(file.text);
        files.push({ name: file.path, size: bytes.length, bytes });
      } else if ('asset' in file) {
        const found = media.get(file.asset);
        if (!found) continue;
        files.push(found.file(file.path));
        mediaCount++;
      } else {
        const found = await content.symbolFile(file.symbol);
        if (!found) continue;
        files.push({
          name: file.path,
          size: found.bytes.length,
          bytes: found.bytes,
        });
        mediaCount++;
      }
    }
    return {
      files,
      warnings: exported.warnings,
      warningsDropped: exported.warningsDropped,
      languages,
      topics: exported.topics,
      media: mediaCount,
    };
  }
}

/** The release and the output, once the reader may read it (`seesWholeManualIn`, as the outputs list judges it); else 404. */
async function readableOutput(
  outputs: ReleaseOutputStore,
  content: ReadableContent,
  release: Release,
  packageId: string,
): Promise<ReleaseOutput> {
  const output = await outputs.find(packageId);
  if (
    !output ||
    output.releaseId !== release.id ||
    output.kind !== 'pdf' ||
    !(await content.seesWholeManualIn(
      output.audience ?? undefined,
      output.lang,
    ))
  ) {
    throw new NotFoundError(`No DITA package "${packageId}" of this release.`);
  }
  return output;
}

/** The languages a package holds for this reader: the output's, or every configured one they may read the whole manual in (the output's among them). */
async function languagesFor(
  content: ReadableContent,
  config: ProjectConfig,
  output: ReleaseOutput,
  languages: DitaOptions['languages'],
): Promise<string[]> {
  if (languages === 'output') return [output.lang];
  const found: string[] = [];
  for (const lang of [config.languages.source, ...config.languages.targets]) {
    if (
      lang === output.lang ||
      (await content.seesWholeManualIn(output.audience ?? undefined, lang))
    ) {
      found.push(lang);
    }
  }
  return found;
}

/** One page of a release's DITA packages: one per output the reader may read. */
export interface DitaPackagesPage extends Paginated<ReleaseOutput> {
  readonly release: Release;
}

/**
 * `GET /releases/:id/dita-packages` (#433): the release's DITA packages,
 * one per output (a manual in a variant and a language) the reader may
 * read, judged exactly as `GET /releases/:id/outputs` judges them
 * (`seesWholeManualIn`, filtered before paging). Listing makes none.
 */
@Injectable()
export class ListDitaPackagesAction extends ActorAction<
  {
    actor: Actor;
    releaseId: string;
    filter: Omit<OutputFilter, 'state'>;
    page: PageRequest;
  },
  DitaPackagesPage
> {
  readonly policy = 'content.read';

  constructor(
    private readonly store: ReleaseStore,
    private readonly outputs: ReleaseOutputStore,
    private readonly snapshots: OpenSnapshotAction,
  ) {
    super();
  }

  protected async run({
    actor,
    releaseId,
    filter,
    page,
  }: {
    actor: Actor;
    releaseId: string;
    filter: Omit<OutputFilter, 'state'>;
    page: PageRequest;
  }): Promise<DitaPackagesPage> {
    const { release, content } = await releaseAt(
      this.store,
      this.snapshots,
      actor,
      releaseId,
    );
    const visible = await visibleIn(this.outputs, content, release.id);
    // A package per PDF output (#59: an offline package is none).
    const found = await this.outputs.list(
      release.id,
      { ...filter, kind: 'pdf' },
      visible,
      page,
    );
    return { ...found, release };
  }
}

/** A release output's DITA package, as `GET …/dita-packages/:id` describes it and `…/file` sends it. */
export interface DitaPackage {
  readonly release: Release;
  readonly output: ReleaseOutput;
  readonly options: DitaOptions;
  readonly plan: DitaPlan;
  /** The name it downloads as (`ditaFileName`). */
  readonly fileName: string;
  /** The ZIP's exact length in bytes. */
  readonly size: number;
  /** The ZIP's bytes, every entry stored and dated with the release's `publishedAt`, so the same plan makes the same bytes. */
  readonly stream: () => AsyncIterable<Uint8Array>;
}

/**
 * `GET /releases/:id/dita-packages/:packageId` and its `file` (#433): the
 * DITA 1.3 package of one release output (`packageId` is the output's
 * ID), for a reader who may read the output (else 404, exactly like a
 * missing one). Made on request (`DitaPlans`, which keeps the last few) as
 * the manual's audience reads it at the release's tag (`@openfolia/dita`'s
 * `exportDita`): a map and a topic per module in each language, the
 * images, files and symbols they show, and the variant's DITAVAL file.
 * 422 `dita-package-too-large` past its bounds or
 * `CCMS_RELEASE_ARCHIVE_MAX_BYTES`; 422 `dita-notices-unsupported` for a
 * derived manual gathering safety notices (#670), which is no set of whole
 * modules.
 */
@Injectable()
export class GetDitaPackageAction extends ActorAction<
  {
    actor: Actor;
    releaseId: string;
    packageId: string;
    options: DitaOptions;
  },
  DitaPackage
> {
  readonly policy = 'content.read';

  constructor(
    private readonly store: ReleaseStore,
    private readonly outputs: ReleaseOutputStore,
    private readonly snapshots: OpenSnapshotAction,
    private readonly plans: DitaPlans,
    private readonly settings: ReleaseArchiveSettings,
    private readonly blobs: BlobStore,
  ) {
    super();
  }

  protected async run({
    actor,
    releaseId,
    packageId,
    options,
  }: {
    actor: Actor;
    releaseId: string;
    packageId: string;
    options: DitaOptions;
  }): Promise<DitaPackage> {
    const { release, content } = await releaseAt(
      this.store,
      this.snapshots,
      actor,
      releaseId,
    );
    const output = await readableOutput(
      this.outputs,
      content,
      release,
      packageId,
    );
    const config = await content.config();
    const languages = await languagesFor(
      content,
      config,
      output,
      options.languages,
    );
    const plan = await this.plans.plan(
      release,
      output,
      config,
      languages,
      options.references,
    );
    const size = zipSize(plan.files);
    const limit = Math.min(this.settings.maxBytes, MAX_ZIP_BYTES);
    if (size > limit || plan.files.length > MAX_ZIP_ENTRIES) {
      throw tooLarge(
        `The package would make ${size} bytes in ${plan.files.length} files, more than one package may hold (${limit} bytes, ${MAX_ZIP_ENTRIES} files).`,
        { size, limit, files: plan.files.length },
      );
    }
    const blobs = this.blobs;
    return {
      release,
      output,
      options,
      plan,
      fileName: ditaFileName(output, release.revision, options.languages),
      size,
      stream: () =>
        zipStream(
          plan.files.map((file) => ({
            name: file.name,
            size: file.size,
            open: async (): Promise<AsyncIterable<Uint8Array>> => {
              if ('bytes' in file) return Readable.from([file.bytes]);
              if ('load' in file) return Readable.from([await file.load()]);
              const blob = await blobs.get(file.blob);
              if (!blob) {
                throw new NotFoundError(`The file "${file.name}" is gone.`);
              }
              return blob.stream;
            },
          })),
          release.publishedAt,
        ),
    };
  }
}
