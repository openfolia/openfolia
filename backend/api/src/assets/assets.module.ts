import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import {
  AssetReferenceIndex,
  AssetReferenceStore,
} from './core/asset-reference-index.js';
import { AssetReferences } from './core/asset-references.js';
import { AssetRenditions } from './core/asset-renditions.js';
import { DeleteAssetAction } from './core/actions/delete-asset.action.js';
import { ImageResizer } from './core/image-resizer.js';
import { Renditions, RenditionSettings } from './core/renditions.js';
import { DrizzleAssetRenditions } from './repos/drizzle-asset-renditions.js';
import { SharpImageResizer } from './repos/sharp-image-resizer.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthoredBranchesModule } from '../change-sets/authored-branches.module.js';
import { ContentModule } from '../content/content.module.js';
import { AssetDeleteController } from './api/asset-delete.controller.js';
import { AssetListController } from './api/asset-list.controller.js';
import { AssetsController } from './api/assets.controller.js';
import { ChangeSetAssetsController } from './api/change-set-assets.controller.js';
import { SymbolsController } from './api/symbols.controller.js';
import { GetSymbolAction } from './core/actions/get-symbol.action.js';
import { GetAssetAction } from './core/actions/get-asset.action.js';
import { ListAssetsAction } from './core/actions/list-assets.action.js';
import { AssetInfoReader } from './core/asset-info.js';
import { GetChangeSetAssetAction } from './core/actions/get-change-set-asset.action.js';
import { UploadAssetAction } from './core/actions/upload-asset.action.js';
import { AssetUploads } from './core/asset-uploads.js';
import { ReadableAssets } from './core/readable-assets.js';
import { DrizzleAssetUploads } from './repos/drizzle-asset-uploads.js';
import { ArchivedFiles } from './core/archived-files.js';
import { HeldBlobs } from './core/held-blobs.js';
import { DrizzleArchivedFiles } from './repos/drizzle-archived-files.js';
import { DrizzleHeldBlobs } from './repos/drizzle-held-blobs.js';
import { DrizzleAssetReferenceStore } from './repos/drizzle-asset-reference-store.js';

/**
 * Images: listed (`GET /assets`), served by their hash (`GET /assets/:hash`, also as renditions),
 * deleted when unused (`DELETE /assets/:hash`), uploaded into a
 * change set (`POST /change-sets/:changeSetId/assets`, recorded in
 * `asset_uploads`) and previewed there by its author. The bytes are in
 * the blob store (`BlobsModule`, global). Also the safety symbols'
 * artwork from the repository (`GET /symbols/:id`).
 */
@Module({
  // `ChangeSetStore` comes from `AuthoredBranchesModule` (global).
  imports: [ContentModule, AuditModule, AuthoredBranchesModule],
  controllers: [
    AssetListController,
    AssetsController,
    AssetDeleteController,
    ChangeSetAssetsController,
    SymbolsController,
  ],
  providers: [
    GetAssetAction,
    GetSymbolAction,
    UploadAssetAction,
    GetChangeSetAssetAction,
    ListAssetsAction,
    AssetInfoReader,
    DeleteAssetAction,
    AssetReferences,
    AssetReferenceIndex,
    Renditions,
    ReadableAssets,
    { provide: AssetUploads, useClass: DrizzleAssetUploads },
    { provide: HeldBlobs, useClass: DrizzleHeldBlobs },
    { provide: ArchivedFiles, useClass: DrizzleArchivedFiles },
    { provide: AssetReferenceStore, useClass: DrizzleAssetReferenceStore },
    { provide: AssetRenditions, useClass: DrizzleAssetRenditions },
    {
      provide: ImageResizer,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new SharpImageResizer({
          maxPixels: config.get('CCMS_RENDITION_MAX_PIXELS', { infer: true }),
          timeoutMs: config.get('CCMS_RENDITION_TIMEOUT_MS', { infer: true }),
        }),
    },
    {
      provide: RenditionSettings,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): RenditionSettings => ({
        concurrency: config.get('CCMS_RENDITION_CONCURRENCY', { infer: true }),
        maxSourceBytes: config.get('CCMS_RENDITION_MAX_SOURCE_BYTES', {
          infer: true,
        }),
      }),
    },
  ],
  // For the live preview (`WorkingCopyReadsModule`): the images uploaded into a change set.
  // `UploadAssetAction` for imports (#256), whose files take the upload path.
  // `AssetReferences` for the import sweeper: an import's bundle content refers to stays.
  // `ReadableAssets`: the files an import, a working copy or a save point may name (#332, #335).
  // `GetAssetAction`, `GetSymbolAction`: the images of a stable address's page (#450).
  // `ArchivedFiles`, `HeldBlobs`: what an import's bytes may be kept for (#602).
  exports: [
    AssetUploads,
    ArchivedFiles,
    HeldBlobs,
    UploadAssetAction,
    AssetReferences,
    ReadableAssets,
    GetAssetAction,
    GetSymbolAction,
  ],
})
export class AssetsModule {}
