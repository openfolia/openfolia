import { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import {
  directionOf,
  type LocalizedText,
  moduleTypeMapping,
  noticeRuleOf,
  type ProjectConfig,
  type ResolvedEntry,
  textIn,
  walk,
} from '@openfolia/content-model';
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
import { ResolveManualAction } from '../../../manuals/core/actions/resolve-manual.action.js';
import { HtmlRenderer } from '../../../preview/core/html-renderer.js';
import {
  releaseAt,
  visibleIn,
} from '../../../releases/core/actions/release-outputs.action.js';
import type { Release } from '../../../releases/core/release.js';
import { ReleaseArchiveSettings } from '../../../releases/core/release-archive.js';
import {
  outputFileName,
  outputRenderer,
  type OutputFilter,
  type ReleaseOutput,
} from '../../../releases/core/release-output.js';
import { ReleaseOutputStore } from '../../../releases/core/release-output-store.js';
import { ReleaseStore } from '../../../releases/core/release-store.js';
import {
  escapeXml,
  iirdsMetadata,
  type IirdsInstance,
  type IirdsTopic,
  type Relations,
  type TocNode,
} from '../iirds-metadata.js';
import {
  IIRDS_MEDIA_TYPE,
  iirdsFileName,
  type IirdsFile,
  type IirdsPlan,
  type IirdsWarning,
  iriSegment,
  mediaExtension,
} from '../iirds-package.js';

/** A release whose configuration at its tag holds no iiRDS mapping: 422 `iirds-not-configured`. */
function notConfigured(release: Release): UnprocessableError {
  return new UnprocessableError(
    'iirds-not-configured',
    `The configuration at release ${release.tag} holds no iiRDS mapping (\`iirds\` in openfolia.yaml): its manuals are not exported as iiRDS packages.`,
  );
}

/** How many packages' plans made are kept (`IirdsPlans`), beside those still being made. */
export const PLANS_KEPT = 32;

/**
 * The most bytes the plans kept may hold of their own (the files made for
 * them: metadata, topics, safety symbols), together; a plan holding more
 * than a quarter of it is not kept, so one large manual never flushes the
 * others.
 */
export const PLANS_KEPT_BYTES = 64 * 1024 * 1024;

/** How many packages are made at once, server-wide; more wait their turn. */
export const PLANS_MADE_AT_ONCE = 2;

/** How many may wait for their turn; past it a request is 429 `rate-limited`. */
export const PLANS_WAITING = 16;

const encoder = new TextEncoder();

/**
 * Makes the plan of a release output's iiRDS package (#431), and keeps the
 * last `PLANS_KEPT`: the same output (with the same PDF state and the
 * release standing or withdrawn) always makes the same plan, since the
 * release's tag fixes the content and the configuration, and the package
 * is made as the manual's audience reads it (`outputRenderer`), never as
 * the reader does, so it is the same for every reader who may read the
 * output. Who may read it is judged before a plan is looked up.
 */
@Injectable()
export class IirdsPlans {
  /**
   * The plans, least recently used first: those made (`settled`) and those
   * still being made, which are never dropped (#551), so a second request
   * for one joins it instead of making it again. Only the plans made count
   * towards `PLANS_KEPT` and `PLANS_KEPT_BYTES`; those being made are
   * bounded by the queue (`PLANS_MADE_AT_ONCE` and `PLANS_WAITING`) and
   * come on top.
   */
  private readonly kept = new Map<
    string,
    { plan: Promise<IirdsPlan>; bytes: number; settled: boolean }
  >();
  private keptSettled = 0;
  private keptBytes = 0;
  private making = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly snapshots: OpenSnapshotAction,
    private readonly resolveManual: ResolveManualAction,
    private readonly renderer: HtmlRenderer,
    private readonly blobs: BlobStore,
  ) {}

  /** The plan of `output`'s package, `config` being the configuration at the release's tag (with a mapping). */
  plan(
    release: Release,
    output: ReleaseOutput,
    config: ProjectConfig,
  ): Promise<IirdsPlan> {
    const key = [
      output.id,
      output.state === 'done' ? output.sha256 : '',
      release.withdrawal === null ? 'standing' : 'withdrawn',
    ].join('|');
    const found = this.kept.get(key);
    if (found) {
      // Most recently used last.
      this.kept.delete(key);
      this.kept.set(key, found);
      return found.plan;
    }
    const entry = {
      plan: this.turn(() => this.make(release, output, config)),
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
        this.keptBytes += entry.bytes;
        this.trim();
      },
      () => {
        // A failure (an outage, a broken file) is never kept.
        if (this.kept.get(key) === entry) this.kept.delete(key);
      },
    );
    return entry.plan;
  }

  /** Runs `make` once fewer than `PLANS_MADE_AT_ONCE` packages are being made. */
  private async turn<T>(make: () => Promise<T>): Promise<T> {
    if (this.making >= PLANS_MADE_AT_ONCE) {
      if (this.waiting.length >= PLANS_WAITING) {
        throw new TooManyRequestsError(
          'Too many iiRDS packages are being made: try again shortly.',
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
      // The turn passes on (`making` unchanged), or ends.
      if (next) next();
      else this.making--;
    }
  }

  /** Drops the least recently used plans made, until those left fit; never one being made. */
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

  private async open(release: Release, actor: Actor): Promise<ReadableContent> {
    const content = await this.snapshots.handle({ actor, ref: release.tag });
    if (content.commit !== release.commit) {
      throw new NotFoundError(`No release "${release.id}".`);
    }
    return content;
  }

  private async make(
    release: Release,
    output: ReleaseOutput,
    config: ProjectConfig,
  ): Promise<IirdsPlan> {
    const mapping = config.iirds;
    if (!mapping) throw notConfigured(release);
    // As the manual's audience reads it, as its PDF was rendered.
    const actor = outputRenderer(output.audience, config);
    const content = await this.open(release, actor);
    const resolution = await this.resolveManual.handle({
      actor,
      snapshot: content,
      id: output.manualId,
      variant: output.variant,
      lang: output.lang,
    });
    const warnings = new Map<string, IirdsWarning>();
    const warn = (warning: IirdsWarning) => {
      const key = `${warning.code} ${warning.id}`;
      if (!warnings.has(key)) warnings.set(key, warning);
    };
    // Labels in the package's language (#731), else the source language's.
    const inLang = (text: LocalizedText) =>
      textIn(text, output.lang, config.languages.source);
    const base = mapping.baseIri;
    const variant = iriSegment(output.variant);
    const documentIri = `${base}releases/${iriSegment(release.id)}/manuals/${iriSegment(output.manualId)}/${variant}/${iriSegment(output.lang)}`;

    // What the manual relates to: its audience, its variant's values and the release's product.
    const lastAudience = config.audiences.at(-1)?.id;
    const qualification = (audience: string | undefined) => {
      const id = audience ?? lastAudience;
      if (id === undefined) return [];
      const kind = Object.hasOwn(mapping.audiences, id)
        ? mapping.audiences[id]
        : undefined;
      if (kind === undefined) {
        warn({
          code: 'unmapped-audience',
          id,
          detail: `Audience "${id}" has no iiRDS qualification class (\`iirds.audiences\`): the units of that audience relate to no qualification.`,
        });
        return [];
      }
      const found = config.audiences.find((a) => a.id === id);
      const label = found ? inLang(found.label) : id;
      return [
        {
          iri: `${base}audiences/${iriSegment(id)}`,
          class: kind,
          label,
        } satisfies IirdsInstance,
      ];
    };
    const facetRelations = (
      facets: Readonly<Record<string, readonly string[]>>,
    ): Relations => {
      const instances: IirdsInstance[] = [];
      const lifecyclePhases: Relations['lifecyclePhases'][number][] = [];
      for (const facetId of Object.keys(facets).sort()) {
        const values = facets[facetId] ?? [];
        const facet = config.facets.find((f) => f.id === facetId);
        const lifecycle = mapping.lifecyclePhases;
        if (lifecycle?.facet === facetId) {
          for (const value of values) {
            const phase = Object.hasOwn(lifecycle.values, value)
              ? lifecycle.values[value]
              : undefined;
            if (phase === undefined) {
              warn({
                code: 'unmapped-lifecycle-phase',
                id: `${facetId}/${value}`,
                detail: `Value "${value}" of the lifecycle phase facet "${facetId}" has no iiRDS lifecycle phase (\`iirds.lifecyclePhases.values\`).`,
              });
            } else {
              lifecyclePhases.push(phase);
            }
          }
          continue;
        }
        const kind = Object.hasOwn(mapping.facets, facetId)
          ? mapping.facets[facetId]
          : undefined;
        if (kind === undefined) {
          warn({
            code: 'unmapped-facet',
            id: facetId,
            detail: `Facet "${facetId}" has no iiRDS product metadata class (\`iirds.facets\`): its values are left out of the metadata.`,
          });
          continue;
        }
        for (const value of values) {
          const found = facet?.values.find((v) => v.id === value);
          instances.push({
            iri: `${base}facets/${iriSegment(facetId)}/${iriSegment(value)}`,
            class: kind,
            label: `${facet ? inLang(facet.label) : facetId}: ${found ? inLang(found.label) : value}`,
          });
        }
      }
      return { instances, lifecyclePhases };
    };
    const variantInstances: IirdsInstance[] = [];
    const values = resolution.manual.variant;
    for (const attributeId of Object.keys(values).sort()) {
      const value = values[attributeId];
      if (value === undefined) continue;
      const kind = Object.hasOwn(mapping.variantAttributes, attributeId)
        ? mapping.variantAttributes[attributeId]
        : undefined;
      if (kind === undefined) {
        warn({
          code: 'unmapped-variant-attribute',
          id: attributeId,
          detail: `Variant attribute "${attributeId}" has no iiRDS product metadata class (\`iirds.variantAttributes\`): the variant's value of it is left out of the metadata.`,
        });
        continue;
      }
      const attribute = config.variantAttributes.find(
        (a) => a.id === attributeId,
      );
      const found =
        attribute?.kind === 'enum'
          ? attribute.values.find((v) => v.id === value)
          : undefined;
      variantInstances.push({
        iri: `${base}variant-attributes/${iriSegment(attributeId)}/${iriSegment(value)}`,
        class: kind,
        label: `${attribute ? inLang(attribute.label) : attributeId}: ${found ? inLang(found.label) : value}`,
      });
    }
    // The release's product: a value of its product facet, mapped as that facet is.
    const product = facetRelations({
      [release.productFacet]: [release.product],
    });
    const manualRelations: Relations = {
      instances: [
        ...qualification(resolution.manifest.audience),
        ...variantInstances,
        ...product.instances,
      ],
      lifecyclePhases: product.lifecyclePhases,
    };

    // The media files the modules show, known before rendering so their names carry their type.
    const entries = moduleEntries(resolution.manual.entries);
    const media = await this.media(content, entries, warn);
    const artwork = await content.symbolArtwork();
    const topicFile = (module: string) => `content/${module}.html`;
    // Which topic file holds an output ID (a block of the manual), for cross-references.
    const holder = new Map<string, string>();
    for (const entry of entries) {
      for (const { node } of walk(entry.blocks)) {
        if (!holder.has(node.id)) holder.set(node.id, entry.module);
      }
    }
    const isEntry = new Set(entries.map((e) => e.module));

    const files: IirdsFile[] = [];
    const topics: IirdsTopic[] = [];
    const usedMedia = new Set<string>();
    const usedSymbols = new Set<string>();
    const topicIri = (module: string) =>
      `${documentIri}/modules/${iriSegment(module)}`;
    // A manual of safety notices grouped by level (#670) holds a module once per level: its one
    // topic holds the module's notices of every level.
    const topicSource = noticeRuleOf(resolution.manifest)
      ? {
          ...resolution,
          manual: { ...resolution.manual, entries: oneEntryPerModule(entries) },
        }
      : resolution;
    for (const entry of entries) {
      if (topics.some((t) => t.iri === topicIri(entry.module))) continue;
      const fragment = this.renderer.module(topicSource, entry.module, {
        assetUrl: (sha256) =>
          `../${media.get(`sha256:${sha256}`)?.name ?? `media/${sha256}`}`,
        symbolUrl: (id) => {
          const path = artwork.get(id);
          return path === undefined ? undefined : `../${path}`;
        },
        xrefHref: ({ module, id }) => {
          const file = id === undefined ? undefined : holder.get(id);
          if (file !== undefined) return `${file}.html#of-${id}`;
          return isEntry.has(module) ? `${module}.html` : undefined;
        },
      });
      if (!fragment) continue;
      for (const ref of [
        ...(fragment.assets ?? []),
        ...(fragment.attachments ?? []),
      ]) {
        usedMedia.add(ref);
      }
      for (const id of fragment.symbols ?? []) usedSymbols.add(id);
      const html = encoder.encode(
        topicHtml(
          entry.lang,
          directionOf(resolution.manual, entry.lang),
          entry.title,
          fragment.html,
        ),
      );
      files.push({
        name: topicFile(entry.module),
        size: html.length,
        bytes: html,
      });
      const meta = (
        (await content.module(entry.module, entry.lang)) ??
        (await content.module(entry.module, config.languages.source))
      )?.meta;
      const type = meta && moduleTypeMapping(mapping, meta.type);
      if (meta && !type) {
        warn({
          code: 'unmapped-module-type',
          id: meta.type,
          detail: `Module type "${meta.type}" has no iiRDS topic type or subject (\`iirds.moduleTypes\`): its topics have neither.`,
        });
      }
      const facets = facetRelations(meta?.facets ?? {});
      topics.push({
        iri: topicIri(entry.module),
        objectIri: `${base}modules/${iriSegment(entry.module)}`,
        title: entry.title,
        lang: entry.lang,
        source: topicFile(entry.module),
        topicType: type?.topicType,
        subjects: type?.subjects ?? [],
        // Resolved for the manual's variant: they relate to it as the manual does.
        instances: [
          ...(meta ? qualification(meta.audience) : []),
          ...variantInstances,
          ...product.instances,
          ...facets.instances,
        ],
        lifecyclePhases: [
          ...product.lifecyclePhases,
          ...facets.lifecyclePhases,
        ],
      });
    }

    // A manual its audience reads nothing of in this variant (#551): its
    // document all the same (and its PDF), with no topic and no table of
    // contents, so every package the list shows is one GET delivers.
    if (topics.length === 0) {
      warn({
        code: 'manual-empty',
        id: output.manualId,
        detail: `Manual "${output.manualId}" holds no module its audience reads in this variant: the package holds its document only, with no topic.`,
      });
    }
    const mediaFiles: IirdsFile[] = [];
    for (const ref of [...usedMedia].sort()) {
      const found = media.get(ref);
      if (found) mediaFiles.push(found.file);
    }
    const symbolFiles: IirdsFile[] = [];
    for (const id of [...usedSymbols].sort()) {
      const found = await content.symbolFile(id);
      if (found) {
        symbolFiles.push({
          name: found.path,
          size: found.bytes.length,
          bytes: found.bytes,
        });
      }
    }

    const pdfDone = holdsPdf(output);
    const pdfName = `pdf/${outputFileName(output, release.revision)}`;
    if (!pdfDone) {
      warn({
        code: 'pdf-not-included',
        id: output.id,
        detail: `The manual's PDF is ${output.state === 'failed' ? 'failed' : 'not rendered yet'}: the package holds its HTML topics only.`,
      });
    }

    const metadata = encoder.encode(
      iirdsMetadata({
        package: {
          iri: `${base}releases/${iriSegment(release.id)}/packages/${iriSegment(output.manualId)}/${variant}/${iriSegment(output.lang)}`,
          title: resolution.manual.title,
          lang: output.lang,
          revision: release.revision,
          createdAt: release.publishedAt,
        },
        document: {
          iri: documentIri,
          objectIri: `${base}manuals/${iriSegment(output.manualId)}`,
          title: resolution.manual.title,
          lang: output.lang,
          revision: release.revision,
          documentTypes: Object.hasOwn(
            mapping.manualDocumentTypes,
            output.manualId,
          )
            ? (mapping.manualDocumentTypes[output.manualId] ??
              mapping.documentTypes)
            : mapping.documentTypes,
          status: release.withdrawal
            ? { value: 'Withdrawn', at: release.withdrawal.at }
            : { value: 'Released', at: release.publishedAt },
          pdf: pdfDone ? { source: pdfName } : undefined,
          ...manualRelations,
        },
        topics,
        toc:
          topics.length === 0 ? [] : tocOf(resolution.manual.entries, topicIri),
        instances: [
          ...manualRelations.instances,
          ...topics.flatMap((t) => t.instances),
        ],
      }),
    );
    const mimetype = encoder.encode(IIRDS_MEDIA_TYPE);
    const all: IirdsFile[] = [
      // First and stored, as the standard requires.
      { name: 'mimetype', size: mimetype.length, bytes: mimetype },
      { name: 'META-INF/metadata.rdf', size: metadata.length, bytes: metadata },
      ...files,
      ...mediaFiles,
      ...symbolFiles,
      ...(pdfDone
        ? [
            {
              name: pdfName,
              size: output.size as number,
              blob: output.sha256 as string,
            },
          ]
        : []),
    ];
    return {
      files: all,
      warnings: [...warnings.values()],
      topics: topics.length,
      media: mediaFiles.length + symbolFiles.length,
      pdf: pdfDone,
    };
  }

  /**
   * The images and attached files the manual's modules refer to, by
   * reference (`sha256:…`), with their name in the package
   * (`media/<hash><extension>`, the extension from the stored type): from
   * the blob store, else (an image of the old layout) the repository,
   * read as the renderer's actor (so only a file the manual's modules
   * refer to). One stored nowhere is a warning, and left out.
   */
  private async media(
    content: ReadableContent,
    entries: readonly ModuleEntry[],
    warn: (warning: IirdsWarning) => void,
  ): Promise<Map<string, { name: string; file: IirdsFile }>> {
    const refs = new Set<string>();
    for (const entry of entries) {
      for (const found of walk(entry.blocks)) {
        if (
          found.kind === 'block' &&
          (found.node.type === 'image' || found.node.type === 'attachment')
        ) {
          refs.add(found.node.asset);
        }
      }
    }
    const found = new Map<string, { name: string; file: IirdsFile }>();
    for (const ref of [...refs].sort()) {
      const hash = ref.startsWith('sha256:') ? ref.slice(7) : '';
      if (!isSha256(hash)) continue;
      const stored = await this.blobs.head(hash);
      if (stored) {
        const name = `media/${hash}${mediaExtension(stored.contentType)}`;
        found.set(ref, { name, file: { name, size: stored.size, blob: hash } });
        continue;
      }
      const bytes = await content.asset(hash);
      if (bytes) {
        const name = `media/${hash}${mediaExtension(sniffImageType(bytes))}`;
        // Read again when the package is sent, never kept with the plan
        // (so the closure holds the size, not the bytes).
        const size = bytes.length;
        const load = async () => {
          const again = await content.asset(hash);
          if (!again || again.length !== size) {
            throw new NotFoundError(`The file "${name}" is gone.`);
          }
          return again;
        };
        found.set(ref, { name, file: { name, size, load } });
        continue;
      }
      warn({
        code: 'missing-asset',
        id: ref,
        detail: `The file "${ref}" a module refers to is not stored: it is left out of the package.`,
      });
    }
    return found;
  }
}

/** Whether a package of `output` holds its PDF: once it is done. */
export function holdsPdf(output: ReleaseOutput): boolean {
  return (
    output.state === 'done' && output.sha256 !== null && output.size !== null
  );
}

type ModuleEntry = Extract<ResolvedEntry, { kind: 'module' }>;

/** The manual's module entries in order, through its groups. */
function moduleEntries(entries: readonly ResolvedEntry[]): ModuleEntry[] {
  return entries.flatMap((e) =>
    e.kind === 'module' ? [e] : moduleEntries(e.entries),
  );
}

/** Each module's entries as one, at its first, with the blocks of all of them in order. */
function oneEntryPerModule(entries: readonly ModuleEntry[]): ModuleEntry[] {
  const merged = new Map<string, ModuleEntry>();
  for (const entry of entries) {
    const found = merged.get(entry.module);
    if (found) found.blocks = [...found.blocks, ...entry.blocks];
    else merged.set(entry.module, { ...entry, blocks: [...entry.blocks] });
  }
  return [...merged.values()];
}

/** The manual's structure for the table of contents. */
function tocOf(
  entries: readonly ResolvedEntry[],
  topicIri: (module: string) => string,
): TocNode[] {
  return entries.map((e) =>
    e.kind === 'module'
      ? { kind: 'topic', topic: topicIri(e.module) }
      : { kind: 'group', title: e.title, children: tocOf(e.entries, topicIri) },
  );
}

/** A topic's HTML file: the module's fragment (escaped by the renderer) in a document of its own, in its language's direction (#458). */
function topicHtml(
  lang: string,
  dir: 'ltr' | 'rtl',
  title: string,
  fragment: string,
): string {
  return `<!DOCTYPE html>\n<html lang="${escapeXml(lang)}" dir="${dir === 'rtl' ? 'rtl' : 'ltr'}">\n<head>\n<meta charset="utf-8">\n<title>${escapeXml(title)}</title>\n</head>\n<body>\n${fragment}\n</body>\n</html>\n`;
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
    throw new NotFoundError(`No iiRDS package "${packageId}" of this release.`);
  }
  return output;
}

/** One page of a release's iiRDS packages: one per output (manual, variant and language) the reader may read. */
export interface IirdsPackagesPage extends Paginated<ReleaseOutput> {
  readonly release: Release;
}

/**
 * The iiRDS package files being sent (`PackageSends`, #654): their turns
 * apart from the DITA packages'. A plan too large for `IirdsPlans` to keep
 * is held by its download until it ends, so this bounds what slow
 * downloads hold.
 */
@Injectable()
export class IirdsSends extends PackageSends {
  constructor(settings: PackageSendSettings) {
    super(settings, 'iiRDS package');
  }
}

/**
 * `GET /releases/:id/iirds-packages` (#431): the release's iiRDS packages,
 * one per output (a manual in a variant and a language) the reader may
 * read, judged exactly as `GET /releases/:id/outputs` judges them
 * (`seesWholeManualIn`, filtered before paging). Each is made on request
 * from the output: listing makes none. 422 `iirds-not-configured` when the
 * configuration at the release's tag holds no iiRDS mapping.
 */
@Injectable()
export class ListIirdsPackagesAction extends ActorAction<
  {
    actor: Actor;
    releaseId: string;
    filter: Omit<OutputFilter, 'state'>;
    page: PageRequest;
  },
  IirdsPackagesPage
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
  }): Promise<IirdsPackagesPage> {
    const { release, content } = await releaseAt(
      this.store,
      this.snapshots,
      actor,
      releaseId,
    );
    if (!(await content.config()).iirds) throw notConfigured(release);
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

/** A release output's iiRDS package, as `GET …/iirds-packages/:id` describes it and `…/file` sends it. */
export interface IirdsPackage {
  readonly release: Release;
  readonly output: ReleaseOutput;
  readonly plan: IirdsPlan;
  /** The name it downloads as (`iirdsFileName`). */
  readonly fileName: string;
  /** The ZIP's exact length in bytes. */
  readonly size: number;
  /**
   * The ZIP's bytes, every entry stored and dated with the release's
   * `publishedAt` (so the same plan makes the same bytes), a blob read from
   * the blob store only when its turn comes.
   */
  readonly stream: () => AsyncIterable<Uint8Array>;
}

/**
 * `GET /releases/:id/iirds-packages/:packageId` and its `file` (#431): the
 * iiRDS package of one release output (`packageId` is the output's ID),
 * for a reader who may read the output (else 404, exactly like a missing
 * one). Made on request (`IirdsPlans`, which keeps the last few) as the
 * manual's audience reads it at the release's tag: its HTML topics, the
 * images, attached files and safety symbols they show, its PDF once that is
 * done, and `META-INF/metadata.rdf` as the configured mapping
 * (`iirds` in `openfolia.yaml` at the tag) makes it. 422 `iirds-not-configured`
 * without a mapping, 422 `iirds-package-too-large` past
 * `CCMS_RELEASE_ARCHIVE_MAX_BYTES` (or a ZIP without ZIP64's limits).
 */
@Injectable()
export class GetIirdsPackageAction extends ActorAction<
  { actor: Actor; releaseId: string; packageId: string },
  IirdsPackage
> {
  readonly policy = 'content.read';

  constructor(
    private readonly store: ReleaseStore,
    private readonly outputs: ReleaseOutputStore,
    private readonly snapshots: OpenSnapshotAction,
    private readonly plans: IirdsPlans,
    private readonly settings: ReleaseArchiveSettings,
    private readonly blobs: BlobStore,
  ) {
    super();
  }

  protected async run({
    actor,
    releaseId,
    packageId,
  }: {
    actor: Actor;
    releaseId: string;
    packageId: string;
  }): Promise<IirdsPackage> {
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
    if (!config.iirds) throw notConfigured(release);
    const plan = await this.plans.plan(release, output, config);
    const size = zipSize(plan.files);
    const limit = Math.min(this.settings.maxBytes, MAX_ZIP_BYTES);
    if (size > limit || plan.files.length > MAX_ZIP_ENTRIES) {
      throw new UnprocessableError(
        'iirds-package-too-large',
        `The package would make ${size} bytes in ${plan.files.length} files, more than one package may hold (${limit} bytes, ${MAX_ZIP_ENTRIES} files).`,
        { size, limit, files: plan.files.length },
      );
    }
    const blobs = this.blobs;
    return {
      release,
      output,
      plan,
      fileName: iirdsFileName(output, release.revision),
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
