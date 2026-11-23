import { Module } from '@nestjs/common';
import { ContentModule } from '../content/content.module.js';
import { ModulesModule } from '../modules/modules.module.js';
import { TermExportController } from './api/term-export.controller.js';
import { TermsController } from './api/terms.controller.js';
import { ExportTermsAction } from './core/actions/export-terms.action.js';
import { GetTermAction } from './core/actions/get-term.action.js';
import { ListTermsAction } from './core/actions/list-terms.action.js';

@Module({
  // `ReadableModuleIndex`: where a term is linked (#245).
  imports: [ContentModule, ModulesModule],
  // The export first: `GET /terms/export` is matched before `GET /terms/:termId`.
  controllers: [TermExportController, TermsController],
  providers: [ListTermsAction, GetTermAction, ExportTermsAction],
})
export class TermsModule {}
