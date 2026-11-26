import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ContentModule } from '../content/content.module.js';
import { ModulesModule } from '../modules/modules.module.js';
import { TranslationJobFileController } from './api/translation-job-file.controller.js';
import { TranslationJobsController } from './api/translation-jobs.controller.js';
import { TranslationsController } from './api/translations.controller.js';
import { CancelTranslationJobAction } from './core/actions/cancel-translation-job.action.js';
import { ExportTranslationsAction } from './core/actions/export-translations.action.js';
import { GetTranslationStatusAction } from './core/actions/get-translation-status.action.js';
import { ListTranslationStatusesAction } from './core/actions/list-translation-statuses.action.js';
import {
  GetTranslationJobAction,
  ListTranslationJobsAction,
} from './core/actions/read-translation-jobs.action.js';
import { TranslationJobFileAction } from './core/actions/translation-job-file.action.js';
import { TranslationJobPackageAction } from './core/actions/translation-job-package.action.js';
import { TranslationExchange } from './core/translation-exchange.js';
import { TranslationReads } from './core/translation-index.js';
import { TranslationJobs } from './core/translation-jobs.js';
import { TranslationWebhookHandler } from './core/translation-webhook-handler.js';
import { CotiPackageExchange } from './repos/coti-package-exchange.js';
import { DrizzleTranslationJobs } from './repos/drizzle-translation-jobs.js';

/**
 * Translation state per module and language (#243), and the delta
 * translation exports (#50) that put blocks `at-provider`.
 */
@Module({
  // `ReadableModuleIndex`: the translation status is read from the module index (#480).
  imports: [ContentModule, AuditModule, ModulesModule],
  controllers: [
    TranslationsController,
    TranslationJobsController,
    TranslationJobFileController,
  ],
  providers: [
    // How the translations' webhook event is made, and who may know of it (#974).
    TranslationWebhookHandler,
    ListTranslationStatusesAction,
    GetTranslationStatusAction,
    ExportTranslationsAction,
    ListTranslationJobsAction,
    GetTranslationJobAction,
    TranslationJobFileAction,
    TranslationJobPackageAction,
    CancelTranslationJobAction,
    TranslationReads,
    { provide: TranslationJobs, useClass: DrizzleTranslationJobs },
    // COTI level 1 packages (#140); another exchange goes behind the same port.
    { provide: TranslationExchange, useClass: CotiPackageExchange },
  ],
  // A module with blocks at a provider is not renamed (#265); the coverage report reads
  // what the translation status reads.
  // The import reads a returned package through the exchange (#140).
  exports: [TranslationJobs, TranslationReads, TranslationExchange],
})
export class TranslationsModule {}
