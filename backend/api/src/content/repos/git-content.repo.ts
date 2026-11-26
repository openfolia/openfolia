import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { buffer } from 'node:stream/consumers';
import { ConfigService } from '@nestjs/config';
import type { Manifest, Module, VariantValues } from '@openfolia/content-model';
import {
  ContentError,
  ContentRepo,
  Lru,
  type Snapshot,
} from '@openfolia/content-repo';
import {
  InvalidContentError,
  TableTooLargeContentError,
} from '../../base/core/errors.js';
import {
  blobStoreUnavailable,
  BlobStore,
  isSha256,
} from '../../blobs/core/blob-store.js';
import type { Env } from '../../config/env.js';
import {
  ContentRepository,
  type ContentSnapshot,
  type ModuleStandIn,
} from '../core/content.repository.js';

/** How many blob hashes found stored are kept (`GitContentRepo.stored`): about 200 bytes each. */
const STORED_HASHES_KEPT = 10_000;

/**
 * `ContentRepository` over the Git repository in `CCMS_CONTENT_DIR`. Images
 * (`sha256:<hash>`) are read from the blob store; one it does not hold is
 * still read from the repository's `assets/<hash>`, until that layout is
 * removed (`pnpm nx run api:blobs-import` moves them into the store).
 */
@Injectable()
export class GitContentRepo
  extends ContentRepository
  implements OnApplicationShutdown
{
  private readonly repo: ContentRepo;
  /**
   * Blob hashes found stored (`hasAsset`, #552): a stored blob's bytes never change and
   * only files nothing refers to are ever deleted, so a yes is kept; a no is asked again.
   */
  private readonly stored = new Lru<true>(STORED_HASHES_KEPT);

  constructor(
    config: ConfigService<Env, true>,
    private readonly blobs: BlobStore,
  ) {
    super();
    this.repo = ContentRepo.open(
      config.get('CCMS_CONTENT_DIR', { infer: true }),
      {
        parsedCacheBytes:
          config.get('CCMS_CONTENT_CACHE_MB', { infer: true }) * 1024 * 1024,
        indexCacheBytes:
          config.get('CCMS_CONTENT_INDEX_CACHE_MB', { infer: true }) *
          1024 *
          1024,
      },
    );
  }

  async at(ref: string): Promise<ContentSnapshot | undefined> {
    const snapshot = await this.repo.at(ref);
    return (
      snapshot && new GitContentSnapshot(snapshot, this.blobs, this.stored)
    );
  }

  override async atEach(
    refs: readonly string[],
  ): Promise<(ContentSnapshot | undefined)[]> {
    return (await this.repo.atEach(refs)).map(
      (snapshot) =>
        snapshot && new GitContentSnapshot(snapshot, this.blobs, this.stored),
    );
  }

  refs() {
    return this.repo.git.refs();
  }

  override forgetListings(): void {
    this.repo.git.forgetListings();
  }

  override releases() {
    return this.repo.git.tagsNewestFirst();
  }

  override async differingPaths(from: string, to: string): Promise<string[]> {
    return (await this.repo.git.changedPaths(from, to)).map((c) => c.path);
  }

  /** Runs after the HTTP server has stopped, so no request still reads. */
  onApplicationShutdown(): void {
    this.repo.close();
  }
}

/** Translates the repository's parse errors into the core's. */
class GitContentSnapshot implements ContentSnapshot {
  constructor(
    private readonly snapshot: Snapshot,
    private readonly blobs: BlobStore,
    /** Hashes found stored, shared between snapshots; none: asked each time. */
    private readonly stored?: Lru<true>,
  ) {}

  private readonly logger = new Logger('BlobStore');

  get commit() {
    return this.snapshot.commit;
  }
  config() {
    return translate(() => this.snapshot.config());
  }
  modules(lang?: string) {
    return translate(() => this.snapshot.modules(lang));
  }
  module(id: string, lang: string) {
    return translate(() => this.snapshot.module(id, lang));
  }
  moduleRevision(id: string, lang: string) {
    return this.snapshot.moduleRevision(id, lang);
  }
  moduleHistory(id: string, lang: string, max: number) {
    return this.snapshot.moduleHistory(id, lang, max);
  }
  deletedModules(max: number) {
    return this.snapshot.deletedModules(max);
  }
  moduleAtRevision(id: string, lang: string, revision: string) {
    return translate(() => this.snapshot.moduleAtRevision(id, lang, revision));
  }

  terms() {
    return translate(() => this.snapshot.terms());
  }
  term(id: string) {
    return translate(() => this.snapshot.term(id));
  }
  pageDesigns() {
    return translate(() => this.snapshot.pageDesigns());
  }
  pageDesign(id: string) {
    return translate(() => this.snapshot.pageDesign(id));
  }
  translationRecord(id: string, lang: string) {
    return translate(() => this.snapshot.translationRecord(id, lang));
  }
  manifests() {
    return translate(() => this.snapshot.manifests());
  }
  manifest(id: string) {
    return translate(() => this.snapshot.manifest(id));
  }
  manifestRevision(id: string) {
    return this.snapshot.manifestRevision(id);
  }
  manifestHistory(id: string, max: number) {
    return this.snapshot.manifestHistory(id, max);
  }
  deletedManifests(max: number) {
    return this.snapshot.deletedManifests(max);
  }
  manifestAtRevision(id: string, revision: string) {
    return translate(() => this.snapshot.manifestAtRevision(id, revision));
  }
  resolve(
    manifest: Manifest,
    variant: VariantValues,
    lang: string,
    visible: (module: Module) => boolean,
    standIn?: ModuleStandIn,
  ) {
    return translate(() =>
      this.snapshot.resolve(manifest.id, variant, lang, {
        visible,
        manifest,
        ...(standIn && { standIn }),
      }),
    );
  }
  /** From the blob store, else (the old layout) from `assets/<hash>` in Git. */
  async asset(hash: string): Promise<Uint8Array | undefined> {
    // A module's reference is authored text: only a well-formed hash is looked up.
    const stored = isSha256(hash) ? await this.blobs.get(hash) : undefined;
    if (stored) {
      try {
        return await buffer(stored.stream);
      } catch (error) {
        this.logger.error(
          `Blob ${hash} failed while being read: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw blobStoreUnavailable();
      }
    }
    return translate(() => this.snapshot.asset(hash));
  }
  async hasAsset(hash: string): Promise<boolean> {
    if (!isSha256(hash)) return false;
    if (this.stored?.get(hash)) return true;
    if (await this.blobs.exists(hash)) {
      this.stored?.set(hash, true);
      return true;
    }
    // The old layout: in Git at this commit only, so not kept across commits.
    return translate(() => this.snapshot.hasAsset(hash));
  }
  symbols() {
    return translate(() => this.snapshot.symbols());
  }
  file(path: string) {
    return translate(() => this.snapshot.file(path));
  }
  template() {
    return translate(() => this.snapshot.template());
  }
  designTemplate(id: string) {
    return translate(() => this.snapshot.designTemplate(id));
  }
  designTemplateIds() {
    return this.snapshot.designTemplateIds();
  }
  async designTemplateListing(id: string) {
    const listed = await this.snapshot.designTemplateListing(id);
    return listed.map((file) => ({ ...file, draft: false, committed: true }));
  }
  designTemplateFile(id: string, path: string) {
    return this.snapshot.designTemplateFile(id, path);
  }
  /** The commit's files alone: nothing beyond the commit. */
  designTemplateRevision() {
    return Promise.resolve('');
  }

  committedAt() {
    return this.snapshot.committedAt();
  }
}

async function translate<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ContentError) {
      // A table past the caps (#686) keeps its code: the reader can say what to change.
      throw error.code === 'table-too-large'
        ? new TableTooLargeContentError(error.path, error.message)
        : new InvalidContentError(error.path, error.message);
    }
    throw error;
  }
}

/** A blob store for tools that read no images: every call is unavailable. */
class NoBlobStore extends BlobStore {
  put(): Promise<never> {
    return Promise.reject(blobStoreUnavailable());
  }
  get(): Promise<never> {
    return Promise.reject(blobStoreUnavailable());
  }
  head(): Promise<never> {
    return Promise.reject(blobStoreUnavailable());
  }
  list(): Promise<never> {
    return Promise.reject(blobStoreUnavailable());
  }
  delete(): Promise<never> {
    return Promise.reject(blobStoreUnavailable());
  }
  ping(): Promise<never> {
    return Promise.reject(blobStoreUnavailable());
  }
}

/**
 * `ContentRepository` over the Git repository in `dir` without a blob store,
 * for command-line tools that read modules and manifests, never images
 * (the module index rebuild). Close it when done.
 */
export class ToolContentRepo extends ContentRepository {
  readonly #repo: ContentRepo;
  readonly #blobs = new NoBlobStore();

  constructor(dir: string) {
    super();
    this.#repo = ContentRepo.open(dir);
  }

  async at(ref: string): Promise<ContentSnapshot | undefined> {
    const snapshot = await this.#repo.at(ref);
    return snapshot && new GitContentSnapshot(snapshot, this.#blobs);
  }

  refs() {
    return this.#repo.git.refs();
  }

  override releases() {
    return this.#repo.git.tagsNewestFirst();
  }

  override async differingPaths(from: string, to: string): Promise<string[]> {
    return (await this.#repo.git.changedPaths(from, to)).map((c) => c.path);
  }

  close(): void {
    this.#repo.close();
  }
}
