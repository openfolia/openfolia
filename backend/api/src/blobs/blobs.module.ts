import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { BlobStore } from './core/blob-store.js';
import { blobStoreFrom } from './repos/blob-store-from.js';
import { SandboxBlobStore } from './repos/sandbox-blob-store.js';
import { Sandbox } from '../sandbox/core/sandbox.js';
import { StartupError } from '../config/startup-error.js';

/**
 * The blob store (`BlobStore`), global: `CCMS_BLOB_DRIVER` picks the
 * adapter (`s3` or `fs`), so swapping them needs no code change.
 */
@Global()
@Module({
  providers: [
    {
      provide: BlobStore,
      inject: [ConfigService, Sandbox],
      useFactory: (config: ConfigService<Env, true>, sandbox: Sandbox) => {
        // A public sandbox (#826) keeps its files on its own disk: never S3 (the settings
        // refuse it at start; this holds should they ever let it through).
        if (
          sandbox.on &&
          config.get('CCMS_BLOB_DRIVER', { infer: true }) !== 'fs'
        ) {
          throw new StartupError(
            'A public sandbox (CCMS_PUBLIC_SANDBOX=on) keeps its files on its own disk: set CCMS_BLOB_DRIVER=fs.',
          );
        }
        const store = blobStoreFrom({
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
        });
        // Every byte put spends the sandbox's write budget.
        return sandbox.on ? new SandboxBlobStore(store, sandbox) : store;
      },
    },
  ],
  exports: [BlobStore],
})
export class BlobsModule {}
