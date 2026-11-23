import type { BlobSettings } from '../../config/blob-env.js';
import type { BlobStore } from '../core/blob-store.js';
import { FsBlobStore } from './fs-blob-store.js';
import { S3BlobStore } from './s3-blob-store.js';

/** The adapter the settings choose (already validated by `checkBlobEnv`). */
export function blobStoreFrom(settings: BlobSettings): BlobStore {
  if (settings.CCMS_BLOB_DRIVER === 'fs') {
    return new FsBlobStore(required(settings.CCMS_BLOB_FS_ROOT));
  }
  const accessKeyId = settings.CCMS_S3_ACCESS_KEY_ID;
  const secretAccessKey = settings.CCMS_S3_SECRET_ACCESS_KEY;
  return new S3BlobStore({
    ...(settings.CCMS_S3_ENDPOINT
      ? { endpoint: settings.CCMS_S3_ENDPOINT }
      : {}),
    region: settings.CCMS_S3_REGION,
    bucket: required(settings.CCMS_S3_BUCKET),
    forcePathStyle: settings.CCMS_S3_FORCE_PATH_STYLE,
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
  });
}

function required(value: string | undefined): string {
  if (!value) throw new Error('blob store settings were not validated');
  return value;
}
