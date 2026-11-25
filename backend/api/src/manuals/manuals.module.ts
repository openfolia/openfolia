import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { ContentModule } from '../content/content.module.js';
import {
  ManualCompareController,
  ManualHistoryController,
} from './api/manual-history.controller.js';
import { ManualLayoutController } from './api/manual-layout.controller.js';
import { ManualPdfController } from './api/manual-pdf.controller.js';
import { ManualsController } from './api/manuals.controller.js';
import { CompareManualVersionsAction } from './core/actions/compare-manual-versions.action.js';
import { GetManualHistoryAction } from './core/actions/get-manual-history.action.js';
import { GetManualAction } from './core/actions/get-manual.action.js';
import { ListManualsAction } from './core/actions/list-manuals.action.js';
import { ManualLayoutWarningsAction } from './core/actions/manual-layout-warnings.action.js';
import { RenderManualPageAction } from './core/actions/render-manual-page.action.js';
import { RenderManualPdfAction } from './core/actions/render-manual-pdf.action.js';
import { ResolveManualAction } from './core/actions/resolve-manual.action.js';
import { GetUpdateGuideAction } from './core/actions/get-update-guide.action.js';
import { PdfRenderer } from './core/pdf-renderer.js';
import { TypstPdfRenderer } from './repos/typst-pdf-renderer.js';

@Module({
  // `UserDirectory`: the users a manual's history names.
  imports: [ContentModule, AccessModule],
  controllers: [
    ManualsController,
    ManualHistoryController,
    ManualCompareController,
    ManualPdfController,
    ManualLayoutController,
  ],
  providers: [
    GetManualHistoryAction,
    CompareManualVersionsAction,
    ListManualsAction,
    GetManualAction,
    ResolveManualAction,
    GetUpdateGuideAction,
    RenderManualPdfAction,
    RenderManualPageAction,
    ManualLayoutWarningsAction,
    { provide: PdfRenderer, useClass: TypstPdfRenderer },
  ],
  exports: [ResolveManualAction, RenderManualPdfAction, PdfRenderer],
})
export class ManualsModule {}
