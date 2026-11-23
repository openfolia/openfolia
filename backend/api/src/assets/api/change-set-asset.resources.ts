import { AssetRef, FileName, MediaType } from '@openfolia/content-model';
import { z } from 'zod';
import {
  resourceObject,
  singleDocument,
  toOne,
} from '../../base/api/json-api.js';
import { type AssetUpload, assetReference } from '../core/asset-upload.js';

export const ChangeSetAssetResource = resourceObject('ChangeSetAsset', {
  attributes: z.object({
    reference: AssetRef.describe(
      'How a module refers to the file: `sha256:<hash>`, an image or attachment block’s `asset`.',
    ),
    contentType: MediaType.describe(
      'The media type the server decided: from the bytes for an image (`image/png` or `image/jpeg`); from the bytes and the file name for an attachment. An attachment block’s `mediaType`.',
    ),
    size: z.int().min(0).describe('In bytes. An attachment block’s `size`.'),
    fileName: FileName.nullable().describe(
      'The file’s name as uploaded, made a valid file name (no path, no control characters, at most 255 characters); null when none was sent. An attachment block’s `fileName`. The first upload’s, when the same file is uploaded again.',
    ),
    uploadedBy: z
      .object({ kind: z.enum(['user', 'service']), id: z.string() })
      .describe('Who uploaded it into the change set first.'),
    uploadedAt: z.iso
      .datetime({ offset: true })
      .describe('When it was first uploaded into the change set.'),
  }),
  relationships: z.object({ changeSet: toOne('ChangeSet') }),
})
  .describe(
    '`id` is `<changeSetId>/<sha256>`. The author previews it at `GET /change-sets/{changeSetId}/assets/{hash}`; once a module the reader may see refers to it, `GET /assets/{hash}` serves it.',
  )
  .meta({ id: 'ChangeSetAssetResource' });

export const ChangeSetAssetDocument = singleDocument(
  ChangeSetAssetResource,
).meta({ id: 'ChangeSetAssetDocument' });
export type ChangeSetAssetDocument = z.infer<typeof ChangeSetAssetDocument>;

export function toChangeSetAssetResource(
  upload: AssetUpload,
): z.infer<typeof ChangeSetAssetResource> {
  return {
    type: 'ChangeSetAsset',
    id: `${upload.changeSetId}/${upload.sha256}`,
    attributes: {
      reference: assetReference(upload.sha256),
      contentType: upload.contentType,
      size: upload.size,
      fileName: upload.fileName ?? null,
      uploadedBy: upload.uploadedBy,
      uploadedAt: upload.uploadedAt.toISOString(),
    },
    relationships: {
      changeSet: { data: { type: 'ChangeSet', id: upload.changeSetId } },
    },
  };
}
