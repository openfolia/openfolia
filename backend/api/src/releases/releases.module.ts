import { ReleaseOutputSweeper } from './api/release-output-sweeper.js';
import { SweepReleaseOutputsAction } from './core/actions/sweep-release-outputs.action.js';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { defaultPoolSize } from '@openfolia/render-typst';
import type { Env } from '../config/env.js';
import { defaultRenderConcurrencyFor, pdfWorkersFor } from '../config/role.js';
import { AuditModule } from '../audit/audit.module.js';
import { ChangeSetsModule } from '../change-sets/change-sets.module.js';
import { ContentModule } from '../content/content.module.js';
import { ManualsModule } from '../manuals/manuals.module.js';
import { PreviewModule } from '../preview/preview.module.js';
import { BuildOfflinePackageAction } from './core/actions/build-offline-package.action.js';
import { OfflineSite } from './core/offline-package.js';
import { RenderHtmlOfflineSite } from './repos/render-html-offline-site.js';
import { ChangelogController } from './api/changelog.controller.js';
import {
  PlanReleaseOutputsJobHandler,
  RenderReleaseOutputJobHandler,
  BuildOfflinePackageJobHandler,
} from './api/release-output-jobs.handler.js';
import {
  ReleaseOutputFileController,
  ReleaseOutputsController,
} from './api/release-outputs.controller.js';
import { ReleasesController } from './api/releases.controller.js';
import { CreateReleaseAction } from './core/actions/create-release.action.js';
import {
  GetReleaseAction,
  ListReleasesAction,
} from './core/actions/read-releases.action.js';
import {
  ListChangelogAction,
  ListReleaseChangesAction,
  ReleaseChangeReader,
} from './core/actions/release-changes.action.js';
import { ReleaseArchiveAction } from './core/actions/release-archive.action.js';
import { ReleaseArchiveSettings } from './core/release-archive.js';
import { PlanReleaseOutputsAction } from './core/actions/plan-release-outputs.action.js';
import { PlanningTurns } from './core/planning-turns.js';
import { DatabasePlanningTurns } from './repos/database-planning-turns.js';
import {
  ListReleaseOutputsAction,
  ReleaseOutputsProgressAction,
  ReleaseOutputFileAction,
  ReplanReleaseOutputsAction,
  RetryReleaseOutputAction,
} from './core/actions/release-outputs.action.js';
import {
  FailReleaseOutputAction,
  RenderReleaseOutputAction,
} from './core/actions/render-release-output.action.js';
import { WithdrawReleaseAction } from './core/actions/withdraw-release.action.js';
import { ReleaseOutputSettings } from './core/release-output.js';
import { ReaderPromotions } from './core/reader-promotions.js';
import { ScheduleReleaseOutputsAction } from './core/actions/schedule-release-outputs.action.js';
import { ReleaseOutputStore } from './core/release-output-store.js';
import { ReleaseEvents } from './core/release-events.js';
import { ReleaseStore } from './core/release-store.js';
import { ReleaseDiffStore } from './core/release-diff-store.js';
import { DrizzleReleaseDiffStore } from './repos/drizzle-release-diff-store.js';
import { ReleaseTags } from './core/release-tags.js';
import { DrizzleReleaseEvents } from './repos/drizzle-release-events.js';
import { DrizzleReleaseOutputStore } from './repos/drizzle-release-output-store.js';
import { DrizzleReleaseStore } from './repos/drizzle-release-store.js';
import { GitReleaseTags } from './repos/git-release-tags.js';
import { MaintenanceLinesController } from './api/maintenance-lines.controller.js';
import {
  CloseMaintenanceLineAction,
  GetMaintenanceLineAction,
  ListMaintenanceLineReleasesAction,
  ListMaintenanceLinesAction,
  StartMaintenanceLineAction,
} from './core/actions/maintenance-lines.action.js';
import { MaintenanceBranches } from './core/maintenance-branches.js';
import { GitMaintenanceBranches } from './repos/git-maintenance-branches.js';

/**
 * Releases (#40): product revisions as annotated tags of `main`, recorded
 * in Postgres next to the tag, listed and read as released content; their
 * notes, changelog and withdrawal (#138); their outputs, PDFs rendered
 * in background jobs and kept in the blob store (#249); and maintenance
 * lines (#60), the branches older revisions are fixed on.
 */
@Module({
  // `ChangeSetsModule`: `ChangeSetBranches`, which compares two commits;
  // `ManualsModule`: the PDF of a manual (#249), a manual resolved;
  // `PreviewModule`: the HTML renderer, for the offline packages (#59).
  imports: [
    ContentModule,
    AuditModule,
    ChangeSetsModule,
    ManualsModule,
    PreviewModule,
  ],
  // `MaintenanceLineStore` comes from `MaintenanceLineStoreModule` (global).
  controllers: [
    ReleasesController,
    ChangelogController,
    ReleaseOutputsController,
    ReleaseOutputFileController,
    MaintenanceLinesController,
  ],
  providers: [
    ListReleasesAction,
    GetReleaseAction,
    CreateReleaseAction,
    WithdrawReleaseAction,
    ReleaseChangeReader,
    ListReleaseChangesAction,
    ListChangelogAction,
    ListMaintenanceLinesAction,
    GetMaintenanceLineAction,
    ListMaintenanceLineReleasesAction,
    StartMaintenanceLineAction,
    CloseMaintenanceLineAction,
    { provide: MaintenanceBranches, useClass: GitMaintenanceBranches },
    { provide: ReleaseStore, useClass: DrizzleReleaseStore },
    { provide: ReleaseDiffStore, useClass: DrizzleReleaseDiffStore },
    { provide: ReleaseTags, useClass: GitReleaseTags },
    { provide: ReleaseEvents, useClass: DrizzleReleaseEvents },
    { provide: ReleaseOutputStore, useClass: DrizzleReleaseOutputStore },
    PlanReleaseOutputsAction,
    { provide: PlanningTurns, useClass: DatabasePlanningTurns },
    SweepReleaseOutputsAction,
    ReleaseOutputSweeper,
    RenderReleaseOutputAction,
    BuildOfflinePackageAction,
    { provide: OfflineSite, useClass: RenderHtmlOfflineSite },
    FailReleaseOutputAction,
    ListReleaseOutputsAction,
    ReleaseOutputsProgressAction,
    ReleaseOutputFileAction,
    ReleaseArchiveAction,
    {
      provide: ReleaseArchiveSettings,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<Env, true>,
      ): ReleaseArchiveSettings => ({
        maxBytes: config.get('CCMS_RELEASE_ARCHIVE_MAX_BYTES', { infer: true }),
      }),
    },
    {
      provide: ReleaseOutputSettings,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<Env, true>,
      ): ReleaseOutputSettings => ({
        maxOutputs: config.get('CCMS_RELEASE_MAX_OUTPUTS', { infer: true }),
        offlinePackages: config.get('CCMS_OFFLINE_PACKAGES', { infer: true }),
        // At most the PDF workers (the configuration checks it), half of them by default.
        renderConcurrency:
          config.get('CCMS_RENDER_CONCURRENCY', { infer: true }) ??
          defaultRenderConcurrencyFor(
            config.get('CCMS_ROLE', { infer: true }),
            pdfWorkersFor(
              config.get('CCMS_ROLE', { infer: true }),
              config.get('CCMS_PDF_WORKERS', { infer: true }),
              defaultPoolSize(),
            ),
          ),
      }),
    },
    ScheduleReleaseOutputsAction,
    // One per server: each reader's promotions a minute (#497).
    { provide: ReaderPromotions, useFactory: () => new ReaderPromotions() },
    RetryReleaseOutputAction,
    ReplanReleaseOutputsAction,
    PlanReleaseOutputsJobHandler,
    RenderReleaseOutputJobHandler,
    BuildOfflinePackageJobHandler,
  ],
  // For webhooks (#42): what a release changed, as a subscriber's owner sees
  // it; for the iiRDS export (#431): its outputs, and how large a download may get;
  // for the stable addresses (#450): the latest release and its PDFs.
  // For the download centre (#139): a PDF's file as #249's route sends it.
  exports: [
    ReleaseStore,
    ReleaseChangeReader,
    ReleaseOutputStore,
    ReleaseArchiveSettings,
    ReleaseOutputFileAction,
  ],
})
export class ReleasesModule {}
