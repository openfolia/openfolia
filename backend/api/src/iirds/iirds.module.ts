import { Module } from '@nestjs/common';
import { packageSendSettingsProvider } from '../base/api/package-send.js';
import { ContentModule } from '../content/content.module.js';
import { ManualsModule } from '../manuals/manuals.module.js';
import { PreviewModule } from '../preview/preview.module.js';
import { ReleasesModule } from '../releases/releases.module.js';
import {
  IirdsPackageFileController,
  IirdsPackagesController,
} from './api/iirds-packages.controller.js';
import {
  GetIirdsPackageAction,
  IirdsPlans,
  IirdsSends,
  ListIirdsPackagesAction,
} from './core/actions/iirds-packages.action.js';

/**
 * The iiRDS export (#431): a release's outputs as iiRDS packages, made on
 * request from the release's tag (its modules as HTML topics, its PDF,
 * metadata as the configuration's mapping makes it).
 */
@Module({
  // `ReleasesModule`: the releases and their outputs; `ManualsModule`: a
  // manual resolved; `PreviewModule`: the HTML renderer.
  imports: [ContentModule, ReleasesModule, ManualsModule, PreviewModule],
  controllers: [IirdsPackagesController, IirdsPackageFileController],
  providers: [
    IirdsPlans,
    IirdsSends,
    packageSendSettingsProvider,
    ListIirdsPackagesAction,
    GetIirdsPackageAction,
  ],
})
export class IirdsModule {}
