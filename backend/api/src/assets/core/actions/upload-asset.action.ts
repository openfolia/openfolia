import { Injectable, Logger } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  UnavailableError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import {
  BOUNDED,
  runContended,
  UnitOfWork,
} from '../../../base/core/unit-of-work.js';
import { BlobStore } from '../../../blobs/core/blob-store.js';
import { tooLarge } from '../../../blobs/core/digest.js';
import {
  StorageLimitReachedError,
  StorageQuota,
} from '../../../storage-usage/core/storage-quota.js';
import type { ChangeSet } from '../../../change-sets/core/change-set.js';
import { ChangeSetStore } from '../../../change-sets/core/change-set-store.js';
import {
  authorsChangeSet,
  ownChangeSet,
} from '../../../change-sets/core/working-copy-rules.js';
import { toFileName } from '@openfolia/content-model';
import {
  acceptedUploadType,
  type AssetUpload,
  MAX_FONTS_PER_CHANGE_SET,
  MAX_UPLOADS_PER_CHANGE_SET,
  SNIFF_BYTES,
  UPLOAD_TYPES,
  type UploadKind,
} from '../asset-upload.js';
import { ArchivedFiles } from '../archived-files.js';
import { AssetUploads } from '../asset-uploads.js';
import {
  ATTACHMENT_SNIFF_BYTES,
  type AttachmentRefusal,
  type AttachmentType,
  attachmentType,
  type AttachmentTypeRules,
  NO_TYPE_RULES,
  refusal,
} from '../attachment-types.js';
import { HeldBlobs } from '../held-blobs.js';
import { FONT_MEDIA_TYPES, inspectFont } from '../font-file.js';

const logger = new Logger('Assets');

/** The 403's detail for another author's change set (to a reader of drafts). */
export const UPLOAD_AUTHOR_ONLY =
  'Only its author uploads files into a change set.';

export interface UploadAssetInput {
  readonly actor: Actor;
  readonly changeSetId: string;
  /**
   * An image (PNG or JPEG, the default), an attachment (any type
   * `attachmentTypes` takes) or a font (TrueType, OpenType, WOFF or WOFF2).
   */
  readonly kind?: UploadKind;
  /**
   * The largest file stored, in bytes (`CCMS_MAX_UPLOAD_BYTES` for an
   * image, `CCMS_MAX_ATTACHMENT_BYTES` for an attachment,
   * `CCMS_MAX_FONT_BYTES` for a font).
   */
  readonly maxBytes: number;
  /** Which attachment types are taken (the `CCMS_ATTACHMENT_TYPES_*` settings). */
  readonly attachmentTypes?: AttachmentTypeRules;
  /**
   * The file's name as the client sent it, known once the first bytes are
   * read; kept as a `FileName` (`toFileName`), or not at all.
   */
  readonly fileName?: () => string | undefined;
  /**
   * The file's bytes. Called only once the actor may upload into the
   * change set, so a refused request is never read; reading stops as soon
   * as the bytes are refused (another type, too many).
   */
  readonly file: () => AsyncIterable<Uint8Array>;
}

export interface UploadAssetResult {
  readonly upload: AssetUpload;
  /** False when the change set held this image already: nothing changed. */
  readonly created: boolean;
}

/**
 * Uploads an image or an attachment into a change set: the bytes go into
 * the blob store under their SHA-256, and the upload is recorded
 * (Postgres, for retention) with its file name and an `asset.upload` audit
 * event in one transaction. Git is not touched: a module refers to the
 * file by `sha256:<hash>`, committed with the module at a save point. Only
 * the change set's author, only while it is a draft (as for locks and
 * working copies). The type is decided here, never taken from the
 * request: for an image sniffed from the bytes (PNG or JPEG; anything else
 * is 422 `unsupported-image-type`); for an attachment from the bytes and
 * the file name's extension (`attachmentType`), refused (422
 * `unsupported-attachment-type`) when the rules do not take it; for a font
 * from its structure, read whole (it is small: `CCMS_MAX_FONT_BYTES`) and
 * checked before anything is stored (`inspectFont`: 422
 * `unsupported-font-type` for anything but a well-formed TrueType,
 * OpenType, WOFF or WOFF2 font), at most `MAX_FONTS_PER_CHANGE_SET` fonts
 * a change set. The same file again is no new blob, record or event
 * (`created` false).
 *
 * Virus scanning would hook in here, between `readHead` and
 * `BlobStore.put` (a scanner reading the stream as it is stored) or right
 * after the put, before `record`: a refused file is then removed as an
 * unrecorded one is (`removeUnrecorded`).
 */
@Injectable()
export class UploadAssetAction extends ActorAction<
  UploadAssetInput,
  UploadAssetResult
> {
  readonly policy = 'content.edit';

  constructor(
    private readonly changeSets: ChangeSetStore,
    private readonly uploads: AssetUploads,
    private readonly blobs: BlobStore,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
    private readonly quota: StorageQuota,
    private readonly archived: ArchivedFiles,
    private readonly held: HeldBlobs,
  ) {
    super();
  }

  protected async run(input: UploadAssetInput): Promise<UploadAssetResult> {
    try {
      return await this.upload(input);
    } catch (error) {
      // Audited apart: the upload's own transaction rolled back.
      if (error instanceof StorageLimitReachedError) {
        await this.quota.refused(input.actor, error, {
          changeSetId: input.changeSetId,
        });
      }
      throw error;
    }
  }

  private async upload({
    actor,
    changeSetId,
    kind = 'image',
    maxBytes,
    attachmentTypes = NO_TYPE_RULES,
    fileName: rawFileName,
    file,
  }: UploadAssetInput): Promise<UploadAssetResult> {
    // Checked before a byte is read, and again in the transaction below.
    requireDraft(
      await authorsChangeSet(
        this.changeSets,
        actor,
        changeSetId,
        UPLOAD_AUTHOR_ONLY,
      ),
    );
    // A full change set takes no more bytes: refused before reading (an
    // image it holds already too, whose reference its author has), and
    // counted again in the transaction, for uploads at the same time.
    if (
      (await this.unit.run((tx) => this.uploads.count(tx, changeSetId))) >=
      MAX_UPLOADS_PER_CHANGE_SET
    ) {
      throw tooManyUploads();
    }
    if (
      kind === 'font' &&
      (await this.unit.run((tx) =>
        this.uploads.count(tx, changeSetId, 'font'),
      )) >= MAX_FONTS_PER_CHANGE_SET
    ) {
      throw tooManyFonts();
    }
    // With a storage limit, no room is refused before reading, and the
    // room left caps what is read (refused as the limit, not the size).
    const room = await this.quota.room();
    const capped = room !== undefined && room < maxBytes;
    const iterator = file()[Symbol.asyncIterator]();
    const limitReached = () =>
      this.quota.limit === null
        ? tooLarge(maxBytes)
        : new StorageLimitReachedError(
            this.quota.limit,
            this.quota.limit - (room ?? 0),
          );
    let stored: StoredUpload;
    try {
      // A font is read whole (at most its cap, and one byte past it), as its structure decides it.
      const head = await readHead(
        iterator,
        kind === 'image'
          ? SNIFF_BYTES
          : kind === 'font'
            ? maxBytes + 1
            : ATTACHMENT_SNIFF_BYTES,
      );
      const bytes = Buffer.concat(head);
      const raw = rawFileName?.();
      const fileName = raw === undefined ? undefined : toFileName(raw);
      let contentType: string;
      if (kind === 'image') {
        const type = acceptedUploadType(bytes);
        if (!type) throw unsupportedType();
        contentType = type;
      } else if (kind === 'font') {
        if (bytes.byteLength > maxBytes) throw tooLarge(maxBytes);
        if (capped && bytes.byteLength > room) throw limitReached();
        const font = inspectFont(bytes);
        if (!font.ok) throw unsupportedFont(font.reason, font.detail);
        contentType = FONT_MEDIA_TYPES[font.facts.format];
      } else {
        const type = attachmentType(bytes, fileName);
        const refused = refusal(type, attachmentTypes);
        if (refused) throw unsupportedAttachment(type, refused);
        contentType = type.mediaType;
      }
      const ref = await this.blobs
        .put(replay(head, iterator), {
          contentType,
          maxBytes: capped ? room : maxBytes,
        })
        .catch((error: unknown) => {
          if (
            capped &&
            error instanceof UnprocessableError &&
            error.code === 'too-large' &&
            this.quota.limit !== null
          ) {
            throw limitReached();
          }
          throw error;
        });
      // The same bytes stored before keep the type they were stored with
      // (the store's): record and answer what downloads are served as. A
      // new font record says the font it is, whatever type its bytes were
      // stored with before (it is served by its format: `GET /assets`); a
      // change set's earlier record of the same bytes is kept as it is.
      const kept =
        ref.created || kind === 'font'
          ? undefined
          : await this.blobs.head(ref.sha256);
      stored = {
        ...ref,
        contentType: kept?.contentType ?? contentType,
        ...(fileName !== undefined ? { fileName } : {}),
      };
    } finally {
      // Stops reading the request when the bytes were refused.
      await iterator.return?.();
    }
    try {
      return await this.record(actor, changeSetId, stored);
    } catch (error) {
      // Refused after the bytes were stored: a blob this put made, which
      // no record refers to, goes again.
      if (stored.created) await this.removeUnrecorded(stored.sha256);
      throw error;
    }
  }

  /** The upload's record and audit event, in one transaction. */
  private async record(
    actor: Actor,
    changeSetId: string,
    stored: StoredUpload,
  ): Promise<UploadAssetResult> {
    return runContended(
      this.unit,
      async (tx) => {
        requireDraft(
          ownChangeSet(
            await this.changeSets.lock(tx, changeSetId),
            actor,
            changeSetId,
            UPLOAD_AUTHOR_ONLY,
          ),
        );
        // Under the hash's lock, which removing an unrecorded blob takes
        // too: the blob is there now, and stays while this records it.
        await this.uploads.lockHash(tx, stored.sha256);
        // Uploaded again after it was deleted as unused: it may be used again.
        await this.uploads.clearDeleted(tx, stored.sha256);
        if (!(await this.blobs.exists(stored.sha256))) {
          throw new UnavailableError(
            'upload-interrupted',
            'The image was removed while it was recorded; upload it again.',
            1,
          );
        }
        // The hash's first upload record counts its bytes (and meets the
        // limit), decided under the hash's lock: of uploads of the same
        // bytes at the same time exactly one does, whichever put stored them.
        // Bytes the branding holds were counted by its upload (#559).
        const first =
          !(await this.uploads.recorded(tx, stored.sha256)) &&
          (await this.held.holds(tx, stored.sha256, 'branding')) === null;
        const result = await this.uploads.record(tx, {
          changeSetId,
          sha256: stored.sha256,
          size: stored.size,
          contentType: stored.contentType,
          ...(stored.fileName !== undefined
            ? { fileName: stored.fileName }
            : {}),
          uploadedBy: { kind: actor.kind, id: actor.id },
        });
        // Counted after the insert, in the transaction holding the change
        // set's row: one over the cap rolls back. An image it holds already
        // is no new one.
        if (
          result.created &&
          (await this.uploads.count(tx, changeSetId)) >
            MAX_UPLOADS_PER_CHANGE_SET
        ) {
          throw tooManyUploads();
        }
        if (
          result.created &&
          stored.contentType.startsWith('font/') &&
          (await this.uploads.count(tx, changeSetId, 'font')) >
            MAX_FONTS_PER_CHANGE_SET
        ) {
          throw tooManyFonts();
        }
        // Bytes no upload recorded yet count towards the storage used (and
        // its limit); the same bytes uploaded again add nothing.
        if (first) await this.quota.addMedia(tx, stored.sha256, stored.size);
        if (result.created) {
          await this.auditLog.record(tx, actor, {
            action: 'asset.upload',
            subject: { type: 'asset', id: stored.sha256 },
            data: {
              changeSetId,
              size: stored.size,
              contentType: stored.contentType,
              ...(stored.fileName !== undefined
                ? { fileName: stored.fileName }
                : {}),
            },
          });
        }
        return result;
      },
      BOUNDED,
    );
  }

  /**
   * Removes the blob `sha256`, which an upload stored and then could not
   * record, unless something took the same bytes on meanwhile: another
   * change set's upload of them, a release render of exactly these bytes
   * that recorded its output `done` (`ArchivedFiles`, #602), an import or
   * the branding (`HeldBlobs`), as deleting a file checks. Checked and
   * removed under the hash's lock, which recording an upload and finishing
   * a release output take too. Best effort: a failure is logged and left
   * to retention, which also removes blobs no record and no commit refers
   * to past their grace period.
   */
  private async removeUnrecorded(sha256: string): Promise<void> {
    try {
      await this.unit.run(async (tx) => {
        await this.uploads.lockHash(tx, sha256);
        if (
          (await this.uploads.recorded(tx, sha256)) ||
          (await this.archived.has(tx, sha256)) ||
          (await this.held.holds(tx, sha256)) !== null
        ) {
          return;
        }
        await this.blobs.delete(sha256);
      }, BOUNDED);
    } catch (error) {
      logger.warn(
        `An unrecorded upload ${sha256} could not be removed: ${String(error)}`,
      );
    }
  }
}

/** Images go only into a draft: a change set in review is frozen, as for saves. */
function requireDraft(changeSet: ChangeSet): void {
  if (changeSet.state !== 'draft') {
    throw new ConflictError(
      'invalid-state',
      `The change set is ${changeSet.state}; images are uploaded only into a draft.`,
      { state: changeSet.state },
    );
  }
}

function tooManyUploads(): ConflictError {
  return new ConflictError(
    'too-many-uploads',
    `A change set holds at most ${MAX_UPLOADS_PER_CHANGE_SET} uploaded files.`,
    { max: MAX_UPLOADS_PER_CHANGE_SET },
  );
}

function tooManyFonts(): ConflictError {
  return new ConflictError(
    'too-many-uploads',
    `A change set holds at most ${MAX_FONTS_PER_CHANGE_SET} fonts.`,
    { max: MAX_FONTS_PER_CHANGE_SET },
  );
}

/** The font formats an upload takes, as their media types (`meta.accepted`). */
const FONT_TYPES = Object.values(FONT_MEDIA_TYPES);

function unsupportedFont(
  reason: 'not-a-font' | 'malformed',
  detail: string,
): UnprocessableError {
  return new UnprocessableError(
    'unsupported-font-type',
    reason === 'not-a-font'
      ? 'Only TrueType, OpenType, WOFF and WOFF2 fonts can be uploaded, recognised by their bytes; a font collection and other files are refused.'
      : `The font is not well formed: ${detail}.`,
    { accepted: FONT_TYPES, reason },
  );
}

function unsupportedType(): UnprocessableError {
  return new UnprocessableError(
    'unsupported-image-type',
    'Only PNG and JPEG images can be uploaded, recognised by their bytes; SVG and other types are refused.',
    { accepted: [...UPLOAD_TYPES] },
  );
}

const REFUSAL_DETAIL: Record<AttachmentRefusal['reason'], string> = {
  mismatch: 'holds bytes of another type than its extension says',
  'not-allowed': 'is not among the types the settings take',
  denied: 'is refused by the settings',
  dangerous:
    'can run code or render as a page where it is opened (HTML, SVG, executables, installers and scripts are refused unless the settings open them)',
};

function unsupportedAttachment(
  type: AttachmentType,
  { reason }: AttachmentRefusal,
): UnprocessableError {
  const what =
    type.extension === undefined
      ? type.mediaType
      : `${type.mediaType} (${type.extension})`;
  return new UnprocessableError(
    'unsupported-attachment-type',
    `A file of type ${what} ${REFUSAL_DETAIL[reason]}.`,
    {
      contentType: type.mediaType,
      extension: type.extension ?? null,
      reason,
    },
  );
}

interface StoredUpload {
  readonly sha256: string;
  readonly size: number;
  readonly created: boolean;
  readonly contentType: string;
  readonly fileName?: string;
}

/** The first chunks, until they hold at least `bytes` bytes or the file ends. */
async function readHead(
  iterator: AsyncIterator<Uint8Array>,
  bytes: number,
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < bytes) {
    const next = await iterator.next();
    if (next.done) break;
    chunks.push(next.value);
    length += next.value.byteLength;
  }
  return chunks;
}

/** `head`, then the rest of `iterator`. */
async function* replay(
  head: readonly Uint8Array[],
  iterator: AsyncIterator<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  yield* head;
  for (;;) {
    const next = await iterator.next();
    if (next.done) return;
    yield next.value;
  }
}
