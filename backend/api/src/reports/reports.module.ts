import { Module } from '@nestjs/common';
import { ContentModule } from '../content/content.module.js';
import { ModulesModule } from '../modules/modules.module.js';
import { TranslationsModule } from '../translations/translations.module.js';
import { ReportCsvController } from './api/report-csv.controller.js';
import { ReportsController } from './api/reports.controller.js';
import { ReportModuleUsageAction } from './core/actions/report-module-usage.action.js';
import { ReportTranslationsAction } from './core/actions/report-translations.action.js';

/**
 * Reports for leads (#56, FR-19): translation coverage per manual and
 * language (from the translation status and the open translation jobs),
 * and where each module is used (from the module index as the reader sees
 * it). Read-only; nothing of its own is stored.
 */
@Module({
  imports: [ContentModule, ModulesModule, TranslationsModule],
  controllers: [ReportsController, ReportCsvController],
  providers: [ReportTranslationsAction, ReportModuleUsageAction],
})
export class ReportsModule {}
