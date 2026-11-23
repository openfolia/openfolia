import { Module } from '@nestjs/common';
import { packageSendSettingsProvider } from '../base/api/package-send.js';
import { ContentModule } from '../content/content.module.js';
import { ReleasesModule } from '../releases/releases.module.js';
import {
  DitaPackageFileController,
  DitaPackagesController,
} from './api/dita-packages.controller.js';
import {
  DitaPlans,
  DitaSends,
  GetDitaPackageAction,
  ListDitaPackagesAction,
} from './core/actions/dita-packages.action.js';

/**
 * The DITA export (#433): a release's outputs as DITA 1.3 packages, made
 * on request from the release's tag by `@openfolia/dita`'s `exportDita` (a map,
 * a topic per module, the media they show, a DITAVAL file per variant).
 */
@Module({
  // `ReleasesModule`: the releases, their outputs and the archive's bound.
  imports: [ContentModule, ReleasesModule],
  controllers: [DitaPackagesController, DitaPackageFileController],
  providers: [
    DitaPlans,
    DitaSends,
    packageSendSettingsProvider,
    ListDitaPackagesAction,
    GetDitaPackageAction,
  ],
})
export class DitaModule {}
