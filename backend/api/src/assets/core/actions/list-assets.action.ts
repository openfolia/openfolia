import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { type PageRequest, type Paginated } from '../../../base/core/paging.js';
import { ChangeSetStore } from '../../../change-sets/core/change-set-store.js';
import { authorsChangeSet } from '../../../change-sets/core/working-copy-rules.js';
import { foldKeyword } from '../../../content/core/module-filter.js';
import type {
  AssetUse,
  ManualCoverUse,
  ReadableContent,
} from '../../../content/core/readable-content.js';
import { ArchivedFiles } from '../archived-files.js';
import { AssetInfoReader, type AssetInfo } from '../asset-info.js';
import { type AssetUpload, UPLOAD_TYPES } from '../asset-upload.js';
import { AssetReferences } from '../asset-references.js';
import { AssetRenditions } from '../asset-renditions.js';
import { AssetUploads } from '../asset-uploads.js';
import { BlobStore, isSha256 } from '../../../blobs/core/blob-store.js';
import { requireEditsEverything, UNUSED_GRACE_MS } from '../unused.js';
import { PREVIEW_AUTHOR_ONLY } from './get-change-set-asset.action.js';

/** At most this many modules are named per image (`usedIn`); `usedInCount` counts them all. */
export const USED_IN_SHOWN = 50;

/** How many files are read at once for their facts. */
const READ_AT_ONCE = 8;

/** `filter[type]` for the files an attachment block attaches (or uploaded as one). */
export const ATTACHMENT_FILTER = 'attachment';

/** One file of the list. */
export interface ListedAsset {
  /** Its SHA-256, 64 lowercase hex characters. */
  readonly sha256: string;
  /** Its facts; absent when neither the blob store nor the repository holds it. */
  readonly info?: AssetInfo;
  /** The first `USED_IN_SHOWN` modules the reader may see that show it. */
  readonly usedIn: readonly AssetUse[];
  /** How many modules the reader may see show it. */
  readonly usedInCount: number;
  /** The manuals the reader may see that have it as their cover image (#394), each once. */
  readonly usedInManuals: readonly ManualCoverUse[];
  /** Uploaded into the change set asked for (preview it there until a module shows it). */
  readonly uploaded: boolean;
  /**
   * The name a download of it is saved under: the first attachment block
   * the reader may see that attaches it, else its upload's; absent when
   * neither names one.
   */
  readonly fileName?: string;
  /** The languages of the modules the reader may see that use it, sorted. */
  readonly languages: readonly string[];
  /** Whether an image block the reader may see shows it. */
  readonly usedAsImage: boolean;
  /** Whether an attachment block the reader may see attaches it. */
  readonly usedAsAttachment: boolean;
}

export interface ListAssetsInput {
  actor: Actor;
  snapshot: ReadableContent;
  /**
   * `image` (a top-level type), `image/png` (exactly that type) or
   * `attachment` (what attachment blocks attach, and uploads other than
   * an image's types).
   */
  type?: string | undefined;
  /**
   * Only files this text is found in (case and diacritics aside): the alt
   * text or title of an image block showing it, the name, description or
   * file name of an attachment block attaching it, the title or ID of a
   * module showing it (only modules the reader may see count), or the
   * file name of its upload into the change set asked for.
   */
  query?: string | undefined;
  /** Also the images uploaded into this change set (its author only). */
  changeSetId?: string | undefined;
  /** Only files a module in this language the reader may see uses. */
  lang?: string | undefined;
  /**
   * Instead, the files nobody uses (`AssetReferences`) and nobody uploaded
   * or stored within `UNUSED_GRACE_MS`: uploads into any change set and
   * blobs without an upload, renditions and archived release PDFs
   * without an upload aside. Needs `content.read.draft`
   * and `content.edit`, each in a role whose scope restricts nothing
   * (`editsEverything`). With `changeSetId`, only its uploads.
   */
  unused?: boolean | undefined;
  page: PageRequest;
}

/**
 * The images a reader may see at a ref: those a module they may see
 * refers to, each with the modules showing it (only those they may see),
 * in the order of the first such module's ID. With a change set, its
 * images uploaded into it come first (last uploaded first), also before a
 * module refers to them: only for its author, as their preview is (403
 * for another reader of drafts, 404 for anyone else). The total counts
 * only what is listed, so it tells nothing about content outside the
 * reader's scope. The `query` and `type` filters run before paging; the
 * query is matched only against what modules the reader may see say.
 */
@Injectable()
export class ListAssetsAction extends ActorAction<
  ListAssetsInput,
  Paginated<ListedAsset>
> {
  readonly policy = 'content.read';

  constructor(
    private readonly infos: AssetInfoReader,
    private readonly changeSets: ChangeSetStore,
    private readonly uploads: AssetUploads,
    private readonly references: AssetReferences,
    private readonly renditions: AssetRenditions,
    private readonly blobs: BlobStore,
    private readonly archived: ArchivedFiles,
  ) {
    super();
  }

  /** The clock for the grace period; tests set their own. */
  now: () => number = Date.now;

  protected async run(input: ListAssetsInput): Promise<Paginated<ListedAsset>> {
    return input.unused ? this.unused(input) : this.used(input);
  }

  private async used({
    actor,
    snapshot,
    type,
    query,
    changeSetId,
    lang,
    page,
  }: ListAssetsInput): Promise<Paginated<ListedAsset>> {
    let uploads: AssetUpload[] = [];
    if (changeSetId !== undefined) {
      await authorsChangeSet(
        this.changeSets,
        actor,
        changeSetId,
        PREVIEW_AUTHOR_ONLY,
      );
      uploads = await this.uploads.list(changeSetId);
    }
    const uploaded = uploads.map((u) => u.sha256);
    const uploadOf = new Map(uploads.map((u) => [u.sha256, u]));
    const [usage, covers] = await Promise.all([
      snapshot.assetUsage(),
      snapshot.manualCoverAssets(),
    ]);
    const referenced: string[] = [];
    for (const reference of usage.keys()) {
      const hash = reference.slice('sha256:'.length);
      // A reference of another form names no file this route could serve.
      if (reference.startsWith('sha256:') && isSha256(hash)) {
        referenced.push(hash);
      }
    }
    // The manuals' cover images (#394), after the modules' images: images, in no language.
    if (type === undefined || type === 'image' || type.startsWith('image/')) {
      for (const reference of covers.keys()) {
        const hash = reference.slice('sha256:'.length);
        if (isSha256(hash)) referenced.push(hash);
      }
    }
    const coversOf = (hash: string) => covers.get(`sha256:${hash}`) ?? [];
    // Fonts (#555): no module names one, the page designs at the ref do (every reader's: designs
    // carry no audience), after the change set's own uploads.
    if (type !== undefined && (type === 'font' || type.startsWith('font/'))) {
      for (const reference of await snapshot.pageDesignAssets()) {
        const hash = reference.slice('sha256:'.length);
        if (isSha256(hash)) referenced.push(hash);
      }
    }
    const fromUploads = new Set(uploaded);
    let hashes = [
      ...new Set([
        ...uploaded,
        ...referenced.filter((hash) => !fromUploads.has(hash)),
      ]),
    ];
    if (query !== undefined) {
      // Folded as the texts are; a query of nothing but marks or spaces
      // finds nothing (as `GET /search`), never everything.
      const wanted = foldKeyword(query);
      const uploadName = (hash: string) => {
        const name = uploadOf.get(hash)?.fileName;
        return name === undefined ? '' : foldKeyword(name);
      };
      const whole = wholeHash(query);
      hashes = hashes.filter(
        (hash) =>
          hash === whole ||
          (wanted !== '' &&
            ((usage.get(`sha256:${hash}`) ?? []).some((use) =>
              use.searchText.includes(wanted),
            ) ||
              coversOf(hash).some(
                (use) =>
                  foldKeyword(use.manualId).includes(wanted) ||
                  foldKeyword(use.title).includes(wanted),
              ) ||
              uploadName(hash).includes(wanted))),
      );
    }
    if (lang !== undefined) {
      hashes = hashes.filter((hash) =>
        (usage.get(`sha256:${hash}`) ?? []).some((use) => use.lang === lang),
      );
    }
    if (type === ATTACHMENT_FILTER) {
      // Decided by the blocks and the uploads, not the bytes: no file is read.
      hashes = hashes.filter(
        (hash) =>
          (usage.get(`sha256:${hash}`) ?? []).some(
            (use) => use.fileNames.length > 0,
          ) || isAttachmentUpload(uploadOf.get(hash)),
      );
    }
    const listed = (sha256: string, info: AssetInfo | undefined) => {
      const uses = usage.get(`sha256:${sha256}`) ?? [];
      const fileName =
        uses.find((use) => use.fileNames.length > 0)?.fileNames[0] ??
        uploadOf.get(sha256)?.fileName;
      return {
        sha256,
        ...(info ? { info } : {}),
        usedIn: uses.slice(0, USED_IN_SHOWN),
        usedInCount: uses.length,
        usedInManuals: coversOf(sha256).slice(0, USED_IN_SHOWN),
        languages: [...new Set(uses.map((use) => use.lang))].sort(compare),
        uploaded: fromUploads.has(sha256),
        ...(fileName !== undefined ? { fileName } : {}),
        // A cover image (#394) is used as an image too.
        usedAsImage:
          uses.some((use) => use.asImage) || coversOf(sha256).length > 0,
        usedAsAttachment: uses.some((use) => use.fileNames.length > 0),
      };
    };
    return this.paged(snapshot, hashes, type, page, listed);
  }

  /**
   * The files nobody uses, last uploaded or stored first (ties by hash):
   * nothing refers to them anywhere (`AssetReferences`), and their last
   * upload or storing is more than `UNUSED_GRACE_MS` ago. An archived
   * release PDF (`ArchivedFiles`) only while an upload records its bytes. `query` matches
   * an upload's file name; `type` as for the other list (`attachment`: an
   * upload of a type an image upload never has).
   */
  private async unused({
    actor,
    snapshot,
    type,
    query,
    changeSetId,
    lang,
    page,
  }: ListAssetsInput): Promise<Paginated<ListedAsset>> {
    requireEditsEverything(actor);
    let only: Set<string> | undefined;
    if (changeSetId !== undefined) {
      await authorsChangeSet(
        this.changeSets,
        actor,
        changeSetId,
        PREVIEW_AUTHOR_ONLY,
      );
      only = new Set(
        (await this.uploads.list(changeSetId)).map((u) => u.sha256),
      );
    }
    // A file used in no module has no language.
    if (lang !== undefined) return { items: [], total: 0 };
    const [files, renditions, stored, referenced, archived] = await Promise.all(
      [
        this.uploads.files(),
        this.renditions.renditionHashes(),
        this.storedBlobs(),
        this.references.referenced(),
        this.archived.hashes(),
      ],
    );
    const uploadOf = new Map(files.map((file) => [file.sha256, file]));
    const since = new Map<string, number>();
    for (const [hash, storedAt] of stored) since.set(hash, storedAt);
    for (const file of files) {
      since.set(
        file.sha256,
        Math.max(since.get(file.sha256) ?? 0, file.lastUploadedAt.getTime()),
      );
    }
    const cutoff = this.now() - UNUSED_GRACE_MS;
    const wanted = query === undefined ? undefined : foldKeyword(query);
    let hashes = [...since.entries()]
      .filter(
        ([hash, at]) =>
          at < cutoff &&
          !referenced.has(hash) &&
          !renditions.has(hash) &&
          // An archived release PDF is kept for good: only its uploads can go.
          (!archived.has(hash) || uploadOf.has(hash)) &&
          (only === undefined || only.has(hash)),
      )
      .sort(([a, at], [b, bt]) => bt - at || compare(a, b))
      .map(([hash]) => hash);
    if (wanted !== undefined) {
      const whole = query === undefined ? undefined : wholeHash(query);
      hashes = hashes.filter((hash) => {
        const name = uploadOf.get(hash)?.fileName;
        return (
          hash === whole ||
          (wanted !== '' &&
            name !== undefined &&
            foldKeyword(name).includes(wanted))
        );
      });
    }
    if (type === ATTACHMENT_FILTER) {
      hashes = hashes.filter((hash) => {
        const upload = uploadOf.get(hash);
        return isAttachmentUpload(upload);
      });
    }
    const listed = (sha256: string, info: AssetInfo | undefined) => {
      const fileName = uploadOf.get(sha256)?.fileName;
      return {
        sha256,
        ...(info ? { info } : {}),
        usedIn: [],
        usedInCount: 0,
        usedInManuals: [],
        languages: [],
        uploaded: only?.has(sha256) ?? false,
        ...(fileName !== undefined ? { fileName } : {}),
        usedAsImage: false,
        usedAsAttachment: false,
      };
    };
    return this.paged(snapshot, hashes, type, page, listed);
  }

  /** Every blob in the store with when it was stored (ms). */
  private async storedBlobs(): Promise<Map<string, number>> {
    const found = new Map<string, number>();
    let after: string | undefined;
    for (;;) {
      const page = await this.blobs.list(after);
      for (const blob of page.blobs) {
        found.set(blob.sha256, blob.storedAt.getTime());
      }
      if (page.next === undefined) return found;
      after = page.next;
    }
  }

  /** One page of `hashes`, the type filter applied first when it needs the files' types. */
  private async paged(
    snapshot: ReadableContent,
    hashes: readonly string[],
    type: string | undefined,
    page: PageRequest,
    listed: (sha256: string, info: AssetInfo | undefined) => ListedAsset,
  ): Promise<Paginated<ListedAsset>> {
    const infoOf = (hash: string) => this.infos.info(snapshot, hash);
    const start = (page.number - 1) * page.size;
    if (type === undefined || type === ATTACHMENT_FILTER) {
      const onPage = hashes.slice(start, start + page.size);
      const infos = await mapAtMost(READ_AT_ONCE, onPage, infoOf);
      return {
        items: onPage.map((hash, n) => listed(hash, infos[n])),
        total: hashes.length,
      };
    }
    // The type of every image is needed before paging.
    const infos = await mapAtMost(READ_AT_ONCE, hashes, infoOf);
    const matching = hashes.flatMap((hash, n) => {
      const info = infos[n];
      return info && isOfType(info.contentType, type)
        ? [listed(hash, info)]
        : [];
    });
    return {
      items: matching.slice(start, start + page.size),
      total: matching.length,
    };
  }
}

/** Code-unit order, so the result does not depend on the locale. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * An upload of a type an image or font upload is never: so it was uploaded as an attachment.
 * (The same bytes uploaded into the same change set again keep their first record: a font
 * uploaded as an attachment first stays one there.)
 */
function isAttachmentUpload(
  upload: Pick<AssetUpload, 'contentType'> | undefined,
): boolean {
  return (
    upload !== undefined &&
    !(UPLOAD_TYPES as readonly string[]).includes(upload.contentType) &&
    !upload.contentType.startsWith('font/')
  );
}

/** `image` matches every `image/…`; `image/png` only itself. */
function isOfType(contentType: string, type: string): boolean {
  return type.includes('/')
    ? contentType === type
    : contentType.startsWith(`${type}/`);
}

/** `items.map(f)`, with at most `limit` calls running at once; none started after one fails. */
async function mapAtMost<T, R>(
  limit: number,
  items: readonly T[],
  f: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    // After a failure the answer is that failure: nothing more is read.
    while (next < items.length && !failed) {
      const n = next++;
      try {
        results[n] = await f(items[n] as T);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/**
 * A query that is a whole SHA-256 (any case) also finds the file of that
 * hash, among the files the list holds anyway (#404: the storage view's
 * largest files link here).
 */
function wholeHash(query: string): string | undefined {
  const hash = query.trim().toLowerCase();
  return isSha256(hash) ? hash : undefined;
}
