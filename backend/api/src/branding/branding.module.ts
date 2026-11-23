import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { BrandingController } from './api/branding.controller.js';
import { BrandingImageSweeper } from './api/branding-image-sweeper.js';
import { DeleteBrandingImageAction } from './core/actions/delete-branding-image.action.js';
import { GetBrandingAction } from './core/actions/get-branding.action.js';
import { GetBrandingImageAction } from './core/actions/get-branding-image.action.js';
import { ListBrandingImagesAction } from './core/actions/list-branding-images.action.js';
import { SweepBrandingImagesAction } from './core/actions/sweep-branding-images.action.js';
import { UpdateBrandingAction } from './core/actions/update-branding.action.js';
import { UploadBrandingImageAction } from './core/actions/upload-branding-image.action.js';
import { BrandingImageRemoval } from './core/branding-image-removal.js';
import { BrandingStore } from './core/branding-store.js';
import { DrizzleBrandingStore } from './repos/drizzle-branding-store.js';

/**
 * The platform's branding (#169): name, logos, mark, icons and colours, set
 * by holders of `admin.branding` and read by anyone. The blob store
 * (`BlobsModule`), the database and the storage limit (`StorageQuota`) are
 * global. `AssetUploads` from `AssetsModule`: an image is recorded under its
 * file's hash lock (#623); `AssetReferences`: an unused image's bytes that
 * content refers to stay when it is removed (#559).
 */
@Module({
  imports: [AuditModule, AssetsModule],
  controllers: [BrandingController],
  providers: [
    GetBrandingAction,
    GetBrandingImageAction,
    UpdateBrandingAction,
    UploadBrandingImageAction,
    ListBrandingImagesAction,
    DeleteBrandingImageAction,
    SweepBrandingImagesAction,
    BrandingImageRemoval,
    BrandingImageSweeper,
    { provide: BrandingStore, useClass: DrizzleBrandingStore },
  ],
  // For email (#609), which shows the name, colour and logo.
  exports: [BrandingStore],
})
export class BrandingModule {}
