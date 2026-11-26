import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { AboutModule } from './about/about.module.js';
import { AddressesModule } from './addresses/addresses.module.js';
import { StableAddressSettingsModule } from './addresses/stable-address-settings.module.js';
import { AccessAdminModule } from './access/access-admin.module.js';
import { AccessModule } from './access/access.module.js';
import { PeopleModule } from './access/people.module.js';
import { AssetsModule } from './assets/assets.module.js';
import { AuditModule } from './audit/audit.module.js';
import { BlobsModule } from './blobs/blobs.module.js';
import { BrandingModule } from './branding/branding.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { ApiExceptionFilter } from './base/api/api-exception.filter.js';
import { CrossSiteRequestGuard } from './base/api/cross-site.guard.js';
import { ChangeSetsModule } from './change-sets/change-sets.module.js';
import { ChangesModule } from './changes/changes.module.js';
import { WorkingCopyReadsModule } from './change-sets/working-copy-reads.module.js';
import { ChunksModule } from './chunks/chunks.module.js';
import { ChecksModule } from './checks/checks.module.js';
import { CommentsModule } from './comments/comments.module.js';
import { ModuleRenamesModule } from './change-sets/module-renames.module.js';
import { SchemaValidationPipe } from './base/api/validation.pipe.js';
import { validateEnv } from './config/env.js';
import { ServerRoleModule } from './config/server-role.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { ImportsModule } from './imports/imports.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { ManualsModule } from './manuals/manuals.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { PreferencesModule } from './preferences/preferences.module.js';
import { PreviewModule } from './preview/preview.module.js';
import { ModulesModule } from './modules/modules.module.js';
import { ProjectModule } from './project/project.module.js';
import { ReleasesModule } from './releases/releases.module.js';
import { IirdsModule } from './iirds/iirds.module.js';
import { DownloadsModule } from './downloads/downloads.module.js';
import { DitaModule } from './dita/dita.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { MaintenanceLineStoreModule } from './releases/maintenance-line-store.module.js';
import { SearchModule } from './search/search.module.js';
import { BackupsModule } from './backups/backups.module.js';
import { SecretsModule } from './secrets/secrets.module.js';
import { StorageUsageModule } from './storage-usage/storage-usage.module.js';
import { StyleReviewModule } from './style-review/style-review.module.js';
import { PageDesignsModule } from './page-designs/page-designs.module.js';
import { TermsModule } from './terms/terms.module.js';
import { VariantsModule } from './variants/variants.module.js';
import { TranslationImportsModule } from './translations/translation-imports.module.js';
import { TranslationsModule } from './translations/translations.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { MailModule } from './mail/mail.module.js';

import { SandboxModule } from './sandbox/sandbox.module.js';
import { ScimModule } from './scim/scim.module.js';
/**
 * Components follow a hexagonal layout: `api/` (controllers, JSON:API
 * resources) calls `core/` (actions: one use case each; ports as abstract
 * classes), whose ports `repos/` implement (Git, PDF renderer, the database). `core/` never imports from `api/` or `repos/`.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Settings come from the process environment only (use
      // `node --env-file=.env`), so a stray .env never changes a test run.
      ignoreEnvFile: true,
      validate: validateEnv,
      // Only validated values: otherwise get() falls back to the raw
      // environment for settings left blank, e.g. '' instead of unset.
      skipProcessEnv: true,
    }),
    ServerRoleModule,
    // The public sandbox (#826): before every module that asks it which adapter to take.
    SandboxModule,
    DatabaseModule,
    SecretsModule,
    JobsModule,
    BlobsModule,
    StorageUsageModule,
    BackupsModule,
    AccessModule,
    PeopleModule,
    HealthModule,
    AboutModule,
    BrandingModule,
    SettingsModule,
    ProjectModule,
    ModulesModule,
    ManualsModule,
    PreviewModule,
    SearchModule,
    ChunksModule,
    ChangesModule,
    AssetsModule,
    AuditModule,
    ChangeSetsModule,
    AccessAdminModule,
    ScimModule,
    WorkingCopyReadsModule,
    CommentsModule,
    ModuleRenamesModule,
    ChecksModule,
    TranslationsModule,
    TranslationImportsModule,
    ReportsModule,
    TermsModule,
    PageDesignsModule,
    VariantsModule,
    NotificationsModule,
    PreferencesModule,
    ReleasesModule,
    IirdsModule,
    DownloadsModule,
    DitaModule,
    MaintenanceLineStoreModule,
    StyleReviewModule,
    ImportsModule,
    WebhooksModule,
    MailModule,
    // Stable addresses (#450); the settings are global, for the release outputs' QR codes too.
    StableAddressSettingsModule,
    AddressesModule,
  ],
  providers: [
    // Every state-changing request must carry what a cross-site form cannot
    // send (the JSON:API media type, or X-Ccms-Request): on every route.
    { provide: APP_GUARD, useClass: CrossSiteRequestGuard },
    // The token and actor guard (ActorGuard) comes with AccessModule.
    // Every error becomes a JSON:API error document.
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    // Validates parameters that declare a `schema` (Zod) before the handler runs.
    { provide: APP_PIPE, useClass: SchemaValidationPipe },
  ],
})
export class AppModule {}
