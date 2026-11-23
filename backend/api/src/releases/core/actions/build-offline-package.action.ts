import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { sanitizeSvg, SVG_LIMITS } from '@openfolia/xml';
import {
  directionOf,
  labelOf,
  type ResolvedEntry,
  type TextDirection,
  textIn,
  variantLabel,
  variantSlug,
  walk,
} from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { allowsManual } from '../../../access/core/allows.js';
import type { UnguardedAction } from '../../../access/core/policy.js';
import { DANGEROUS_TYPES } from '../../../assets/core/attachment-types.js';
import { sniffImageType } from '../../../assets/core/sniff-image-type.js';
import {
  ContendedError,
  DomainError,
  NotFoundError,
  TooManyRequestsError,
  UnavailableError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import {
  type LazyZipEntry,
  ZipLimitError,
  zipStreamOf,
} from '../../../base/core/zip-stream.js';
import { BlobStore, isSha256 } from '../../../blobs/core/blob-store.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { ManualResolution } from '../../../content/core/content.repository.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { mediaExtension } from '../../../iirds/core/iirds-package.js';
import { ResolveManualAction } from '../../../manuals/core/actions/resolve-manual.action.js';
import { HtmlRenderer } from '../../../preview/core/html-renderer.js';
import {
  MAX_PACKAGE_ENTRIES,
  MAX_SEARCH_ENTRIES,
  type OfflineIndexInput,
  OfflineSite,
  pathPart,
  UniqueNames,
} from '../offline-package.js';
import type { Release } from '../release.js';
import { ReleaseArchiveSettings } from '../release-archive.js';
import { RELEASE_READER } from '../release-changes.js';
import { outputRenderer, type ReleaseOutput } from '../release-output.js';
import { ReleaseOutputStore } from '../release-output-store.js';

const encoder = new TextEncoder();

/** Where a page is, from the package's root, and back. */
const PAGE_ROOT = '../../';

/** A file the package names, how it is read when its turn comes. */
type Source = {
  readonly kind: 'blob' | 'git';
  readonly sha256: string;
  /** An SVG: written made inert (`sanitizeSvg`), never as it is stored. */
  readonly svg: boolean;
};

const SVG_TYPE = 'image/svg+xml';

/**
 * A file's name in the package by its type (`media/<sha256><extension>`): an
 * SVG keeps `.svg` (it is written made inert), and any other type a browser
 * renders as a page or runs (HTML, XML, scripts, executables) gets `.bin`, so
 * opening it from the unpacked folder shows or runs nothing (an attachment's
 * link still saves it under its own name, `download`).
 */
function mediaName(hash: string, type: string): string {
  if (type === SVG_TYPE) return `media/${hash}.svg`;
  const runs = DANGEROUS_TYPES.has(type) || /[+/]xml$/.test(type);
  return `media/${hash}${runs ? '.bin' : mediaExtension(type)}`;
}

/** What the manifest says of each file: its path, size and SHA-256. */
interface ManifestFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

/** Something the package leaves out, and why: a manual's variant that cannot be resolved, a file stored nowhere. */
interface LeftOut {
  readonly manual?: string;
  readonly variant?: string;
  readonly file?: string;
  readonly code: string;
}

/**
 * Whether an error resolving one manual says it can never be read at this
 * tag (broken content, too large to expand): that manual is left out, noted in
 * the manifest, and the package is made of the rest. Anything else (Git, the
 * blob store or the database failing) fails the attempt, to be retried.
 */
function leavesOut(error: unknown): error is DomainError {
  return (
    error instanceof DomainError &&
    !(error instanceof UnavailableError) &&
    !(error instanceof ContendedError) &&
    !(error instanceof TooManyRequestsError)
  );
}

type ModuleEntry = Extract<ResolvedEntry, { kind: 'module' }>;

function moduleEntries(entries: readonly ResolvedEntry[]): ModuleEntry[] {
  return entries.flatMap((e) =>
    e.kind === 'module' ? [e] : moduleEntries(e.entries),
  );
}

/** The image and attachment references a resolved manual's blocks name, in order. */
function mediaRefs(resolution: ManualResolution): string[] {
  const refs: string[] = [];
  for (const entry of moduleEntries(resolution.manual.entries)) {
    for (const found of walk(entry.blocks)) {
      if (
        found.kind === 'block' &&
        (found.node.type === 'image' || found.node.type === 'attachment')
      ) {
        refs.push(found.node.asset);
      }
    }
  }
  return refs;
}

/** `entries`, stopping before the next once `signal` is aborted (an attempt cut off). */
async function* stopping<T>(
  entries: AsyncIterable<T>,
  signal: AbortSignal | undefined,
): AsyncGenerator<T> {
  for await (const entry of entries) {
    signal?.throwIfAborted();
    yield entry;
  }
}

/** The most characters of a heading the search holds: the index stays small whatever the titles. */
const SEARCH_TEXT_MAX = 200;
const clip = (text: string) =>
  text.length <= SEARCH_TEXT_MAX
    ? text
    : `${text.slice(0, SEARCH_TEXT_MAX - 1)}…`;

/** `iterable`'s bytes as they pass, counted and hashed into `files` once the last one went by. */
async function* hashed(
  path: string,
  iterable: AsyncIterable<Uint8Array>,
  files: ManifestFile[],
): AsyncGenerator<Uint8Array> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of iterable) {
    hash.update(chunk);
    size += chunk.length;
    yield chunk;
  }
  files.push({ path, size, sha256: hash.digest('hex') });
}

/**
 * Builds a release's offline package (#59), one language and audience level,
 * as the `release.outputs` job renders a PDF: at the release's tag only, read
 * through `ReadableContent` as a service actor of exactly the package's
 * audience (`outputRenderer`), never a wider one, so the package holds only
 * what that level reads: the manuals it may read, each resolved as it reads
 * them (a module above it is not there), the images and attached files those
 * pages show, and the release's PDFs of those manuals in that language
 * (rendered as the manual's audience reads it, at most the package's).
 *
 * **Streamed and bounded:** the ZIP is written while the blob store reads it,
 * one entry at a time (a page rendered when its turn comes, a PDF or image
 * read from the blob store chunk by chunk), so no package is ever held in
 * memory; past `CCMS_RELEASE_ARCHIVE_MAX_BYTES` or `MAX_PACKAGE_ENTRIES`
 * files it stops with 422 `offline-package-too-large`. The manifest
 * (`manifest.json`, last) gives every other file's SHA-256, counted as it went
 * out. Every entry is dated with the release's `publishedAt`.
 */
@Injectable()
export class BuildOfflinePackageAction implements UnguardedAction {
  readonly policy = 'internal';
  private readonly logger = new Logger(BuildOfflinePackageAction.name);

  constructor(
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly resolveManual: ResolveManualAction,
    private readonly renderer: HtmlRenderer,
    private readonly site: OfflineSite,
    private readonly outputs: ReleaseOutputStore,
    private readonly blobs: BlobStore,
    private readonly settings: ReleaseArchiveSettings,
  ) {}

  /** The package's largest size in bytes: the archive's limit (#469). */
  get maxBytes(): number {
    return this.settings.maxBytes;
  }

  private async open(release: Release, actor: Actor): Promise<ReadableContent> {
    const content = await this.openSnapshot.handle({ actor, ref: release.tag });
    if (content.commit !== release.commit) {
      throw new NotFoundError(`The tag of release ${release.id} moved.`);
    }
    return content;
  }

  /**
   * The package of `output` (an `offline-package` output of `release`): its
   * bytes, made as they are read. Throws `offline-package-too-large` once it
   * passes its bounds.
   */
  async *stream(
    release: Release,
    output: ReleaseOutput,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    const config = await (await this.open(release, RELEASE_READER)).config();
    // Exactly the package's audience, never a wider one.
    const actor = outputRenderer(output.audience, config);
    const content = await this.open(release, actor);
    try {
      yield* zipStreamOf(
        stopping(this.entries(release, output, actor, content), signal),
        release.publishedAt,
        { maxBytes: this.maxBytes, maxEntries: MAX_PACKAGE_ENTRIES },
      );
    } catch (error) {
      if (!(error instanceof ZipLimitError)) throw error;
      throw new UnprocessableError(
        'offline-package-too-large',
        error.limit === 'bytes'
          ? `The offline package would be larger than ${error.max} bytes (CCMS_RELEASE_ARCHIVE_MAX_BYTES).`
          : `The offline package would hold more than ${error.max} files.`,
        { limit: error.limit, max: error.max },
      );
    }
  }

  private async *entries(
    release: Release,
    output: ReleaseOutput,
    actor: Actor,
    content: ReadableContent,
  ): AsyncGenerator<LazyZipEntry> {
    const config = await content.config();
    const lang = output.lang;
    const source = config.languages.source;
    const files: ManifestFile[] = [];
    const leftOut: LeftOut[] = [];
    const entry = (
      path: string,
      open: () => Promise<AsyncIterable<Uint8Array>>,
    ): LazyZipEntry => ({
      name: path,
      open: async () => hashed(path, await open(), files),
    });
    const text = (path: string, body: string) =>
      entry(path, async () => Readable.from([encoder.encode(body)]));

    const productFacet = config.facets.find(
      (f) => f.id === release.productFacet,
    );
    const productValue = productFacet?.values.find(
      (v) => v.id === release.product,
    );
    const product = productValue
      ? textIn(productValue.label, lang, source)
      : release.product;
    const title = `${product} ${release.revision}`;
    const audienceLabel =
      output.audience === null
        ? undefined
        : (labelOf(config, 'audiences', output.audience, lang) ??
          output.audience);
    const languageName = (() => {
      try {
        return new Intl.DisplayNames([lang], { type: 'language' }).of(lang);
      } catch {
        return undefined;
      }
    })();
    const subtitle = [languageName ?? lang, audienceLabel]
      .filter((p) => p !== undefined)
      .join(' · ');
    const footer = `${title} · ${release.publishedAt.toISOString().slice(0, 10)}`;

    const listings = (await content.manuals())
      .filter((l) => !('error' in l))
      .sort((a, b) => a.id.localeCompare(b.id));
    const listed = new Set(listings.map((l) => l.id));
    const levels = config.audiences.map((a) => a.id);

    // The release's PDFs this package holds: of a manual it lists, in its
    // language, done, of an audience it reads (as the PDF was rendered).
    const pdfNames = new UniqueNames();
    const pdfs = new Map<
      string,
      { readonly name: string; readonly sha256: string }
    >();
    for (const pdf of await this.outputs.all(release.id)) {
      if (
        pdf.kind !== 'pdf' ||
        pdf.lang !== lang ||
        pdf.state !== 'done' ||
        pdf.sha256 === null ||
        !listed.has(pdf.manualId) ||
        !allowsManual(actor, 'content.read', {
          audiences: levels,
          audience: pdf.audience ?? undefined,
          lang,
        }) ||
        !(await this.blobs.exists(pdf.sha256))
      ) {
        continue;
      }
      pdfs.set(`${pdf.manualId}\0${pdf.variant}`, {
        name: pdfNames.name(
          `pdf/${pathPart(pdf.manualId)}/${pathPart(lang)}/${pathPart(pdf.variant)}`,
          '.pdf',
        ),
        sha256: pdf.sha256,
      });
    }

    const artwork = await content.symbolArtwork();
    const media = new Map<
      string,
      { readonly name: string; readonly source: Source } | null
    >();
    const usedMedia = new Set<string>();
    const usedSymbols = new Set<string>();
    const pageNames = new UniqueNames();
    const index: OfflineIndexInput['manuals'][number][] = [];
    const search: OfflineIndexInput['search'][number][] = [];
    let dir: TextDirection | undefined;

    for (const listing of listings) {
      const variants: OfflineIndexInput['manuals'][number]['variants'][number][] =
        [];
      let manualTitle: string | undefined;
      for (const variant of 'manifest' in listing
        ? listing.manifest.variants
        : []) {
        const slug = variantSlug(variant);
        let resolution: ManualResolution;
        try {
          resolution = await this.resolveManual.handle({
            actor,
            snapshot: content,
            id: listing.id,
            variant: slug,
            lang,
          });
        } catch (error) {
          if (!leavesOut(error)) throw error;
          leftOut.push({ manual: listing.id, variant: slug, code: error.code });
          continue;
        }
        dir ??= directionOf(resolution.manual, lang);
        manualTitle ??= resolution.manual.title;
        for (const ref of mediaRefs(resolution)) {
          if (!media.has(ref)) media.set(ref, await this.mediaOf(content, ref));
        }
        const label = variantLabel(variant, config, lang);
        const fragment = this.renderer.manual(resolution, {
          assetUrl: (sha256) =>
            `${PAGE_ROOT}${media.get(`sha256:${sha256}`)?.name ?? `media/${sha256}`}`,
          symbolUrl: (id) => {
            const path = artwork.get(id);
            return path === undefined ? undefined : `${PAGE_ROOT}${path}`;
          },
          ...(label !== '' && { subtitle: label }),
        });
        for (const ref of [
          ...(fragment.assets ?? []),
          ...(fragment.attachments ?? []),
        ]) {
          usedMedia.add(ref);
        }
        for (const id of fragment.symbols ?? []) {
          if (artwork.has(id)) usedSymbols.add(id);
        }
        const page = pageNames.name(
          `manuals/${pathPart(listing.id)}/${pathPart(slug)}`,
          '.html',
        );
        const pdf = pdfs.get(`${listing.id}\0${slug}`);
        const pageTitle =
          label === ''
            ? resolution.manual.title
            : `${resolution.manual.title} · ${label}`;
        const html = this.site.page({
          lang: resolution.manual.lang,
          dir: directionOf(resolution.manual, resolution.manual.lang),
          title: pageTitle,
          root: PAGE_ROOT,
          fragment: fragment.html,
          ...(pdf && { pdf: pdf.name }),
          footer,
        });
        yield text(page, html);
        variants.push({ label, page, ...(pdf && { pdf: pdf.name }) });
        for (const heading of [
          { id: '', text: resolution.manual.title },
          ...this.site.headings(resolution),
        ]) {
          if (search.length >= MAX_SEARCH_ENTRIES) break;
          search.push({
            text: clip(heading.text),
            page: heading.id === '' ? page : `${page}#${heading.id}`,
            context: clip(pageTitle),
          });
        }
      }
      if (variants.length > 0) {
        index.push({ title: manualTitle ?? listing.id, variants });
      }
    }

    // The images and attached files the pages show, from the blob store (else, the old layout, Git).
    for (const ref of [...usedMedia].sort()) {
      const found = media.get(ref);
      if (!found) {
        leftOut.push({ file: ref, code: 'missing-file' });
        continue;
      }
      if (found.source.svg) {
        // Read whole (an SVG is bounded, `SVG_LIMITS`) and made inert first.
        const clean = this.inert(await this.svgOf(content, found), found.name);
        if (clean === undefined) {
          leftOut.push({ file: ref, code: 'unsafe-svg' });
          continue;
        }
        yield text(found.name, clean);
        continue;
      }
      yield entry(found.name, () => this.read(content, found));
    }
    for (const id of [...usedSymbols].sort()) {
      const path = artwork.get(id) as string;
      const found = await content.symbolFile(id);
      if (!found) throw new Error(`The symbol "${id}" is gone.`);
      if (path.endsWith('.svg')) {
        const clean = this.inert(found.bytes, path);
        if (clean === undefined) {
          leftOut.push({ file: path, code: 'unsafe-svg' });
          continue;
        }
        yield text(path, clean);
        continue;
      }
      const bytes = found.bytes;
      yield entry(path, async () => Readable.from([bytes]));
    }
    for (const pdf of [...pdfs.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      yield entry(pdf.name, () =>
        this.read(content, {
          name: pdf.name,
          source: { kind: 'blob', sha256: pdf.sha256, svg: false },
        }),
      );
    }
    for (const file of this.site.files()) {
      yield entry(file.path, async () => Readable.from([file.bytes]));
    }
    yield text(
      'index.html',
      this.site.index({
        lang,
        dir: dir ?? directionOf({}, lang),
        title,
        subtitle,
        manuals: index,
        search,
        footer,
      }),
    );
    // Last: every other file is written, so its hash is known.
    const manifest = {
      format: 'openfolia-offline-package',
      version: 1,
      release: {
        id: release.id,
        tag: release.tag,
        commit: release.commit,
        publishedAt: release.publishedAt.toISOString(),
        withdrawn: release.withdrawal !== null,
      },
      product: release.product,
      productFacet: release.productFacet,
      revision: release.revision,
      lang,
      audience: output.audience,
      files,
      leftOut,
    };
    yield text('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  }

  /**
   * Where a reference's file is and what it is named in the package
   * (`media/<sha256><extension>`, the extension from its stored type): the blob
   * store, else (an image of the old layout) the repository, read as the
   * package's actor (so only a file a module it reads refers to); null when it
   * is stored nowhere.
   */
  private async mediaOf(
    content: ReadableContent,
    ref: string,
  ): Promise<{ readonly name: string; readonly source: Source } | null> {
    const hash = ref.startsWith('sha256:') ? ref.slice(7) : '';
    if (!isSha256(hash)) return null;
    const stored = await this.blobs.head(hash);
    if (stored) {
      return {
        name: mediaName(hash, stored.contentType),
        source: {
          kind: 'blob',
          sha256: hash,
          svg: stored.contentType === SVG_TYPE,
        },
      };
    }
    const bytes = await content.asset(hash);
    if (!bytes) return null;
    const type = sniffImageType(bytes);
    return {
      name: mediaName(hash, type),
      source: { kind: 'git', sha256: hash, svg: type === SVG_TYPE },
    };
  }

  /**
   * An SVG made inert (`sanitizeSvg`): only its drawing, nothing that runs or
   * reaches out; undefined (left out, logged) for one that is no SVG, too
   * large or not well-formed.
   */
  private inert(
    bytes: Uint8Array | undefined,
    name: string,
  ): string | undefined {
    if (bytes === undefined) return undefined;
    if (bytes.length > SVG_LIMITS.maxLength) {
      this.logger.warn(
        `The SVG "${name}" is left out of an offline package: larger than ${SVG_LIMITS.maxLength} bytes.`,
      );
      return undefined;
    }
    try {
      return sanitizeSvg(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
    } catch (error) {
      this.logger.warn(
        `The SVG "${name}" is left out of an offline package: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /** An SVG's bytes, at most `SVG_LIMITS.maxLength` of them; undefined past it. */
  private async svgOf(
    content: ReadableContent,
    file: { readonly name: string; readonly source: Source },
  ): Promise<Uint8Array | undefined> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of await this.read(content, file)) {
      size += chunk.length;
      if (size > SVG_LIMITS.maxLength) {
        this.logger.warn(
          `The SVG "${file.name}" is left out of an offline package: larger than ${SVG_LIMITS.maxLength} bytes.`,
        );
        return undefined;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  /** A file's bytes when its turn comes: streamed from the blob store, or read from Git again. */
  private async read(
    content: ReadableContent,
    file: { readonly name: string; readonly source: Source },
  ): Promise<AsyncIterable<Uint8Array>> {
    if (file.source.kind === 'blob') {
      const blob = await this.blobs.get(file.source.sha256);
      // Gone since it was looked up: the attempt fails and is tried again.
      if (!blob) throw new Error(`The file "${file.name}" is gone.`);
      return blob.stream;
    }
    const bytes = await content.asset(file.source.sha256);
    if (!bytes) throw new Error(`The file "${file.name}" is gone.`);
    return Readable.from([bytes]);
  }
}
