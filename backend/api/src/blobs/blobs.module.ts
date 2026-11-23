import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { BlobStore } from './core/blob-store.js';
import { blobStoreFrom } from './repos/blob-store-from.js';

/**
 * The blob store (`BlobStore`), global: `CCMS_BLOB_DRIVER` picks the
 * adapter (`s3` or `fs`), so swapping them needs no code change.
 */
@Global()
@Module({
  providers: [
    {
      provide: BlobStore,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        blobStoreFrom({
          CCMS_BLOB_DRIVER: config.get('CCMS_BLOB_DRIVER', { infer: true }),
          CCMS_BLOB_FS_ROOT: config.get('CCMS_BLOB_FS_ROOT', { infer: true }),
          CCMS_S3_ENDPOINT: config.get('CCMS_S3_ENDPOINT', { infer: true }),
          CCMS_S3_REGION: config.get('CCMS_S3_REGION', { infer: true }),
          CCMS_S3_BUCKET: config.get('CCMS_S3_BUCKET', { infer: true }),
          CCMS_S3_ACCESS_KEY_ID: config.get('CCMS_S3_ACCESS_KEY_ID', {
            infer: true,
          }),
          CCMS_S3_SECRET_ACCESS_KEY: config.get('CCMS_S3_SECRET_ACCESS_KEY', {
            infer: true,
          }),
          CCMS_S3_FORCE_PATH_STYLE: config.get('CCMS_S3_FORCE_PATH_STYLE', {
            infer: true,
          }),
        }),
    },
  ],
  exports: [BlobStore],
})
export class BlobsModule {}
