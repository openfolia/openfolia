import { Module } from '@nestjs/common';
import { ContentModule } from '../content/content.module.js';
import { ManualsModule } from '../manuals/manuals.module.js';
import {
  ManualHtmlController,
  ModulePreviewController,
} from './api/preview.controller.js';
import {
  ManualHiddenContentController,
  ModuleHiddenContentController,
} from './api/hidden-content.controller.js';
import { PreviewFilesController } from './api/preview-files.controller.js';
import { PreviewResponder } from './api/preview-page.js';
import {
  ListHiddenManualContentAction,
  ListHiddenModuleContentAction,
} from './core/actions/list-hidden-content.action.js';
import { PreviewManualAction } from './core/actions/preview-manual.action.js';
import { PreviewModuleAction } from './core/actions/preview-module.action.js';
import { HtmlRenderer, PreviewFiles } from './core/html-renderer.js';
import { PackagePreviewFiles } from './repos/preview-files.js';
import { RenderHtmlRenderer } from './repos/render-html.renderer.js';

@Module({
  imports: [ContentModule, ManualsModule],
  controllers: [
    ModulePreviewController,
    ManualHtmlController,
    PreviewFilesController,
    ModuleHiddenContentController,
    ManualHiddenContentController,
  ],
  providers: [
    PreviewModuleAction,
    PreviewManualAction,
    ListHiddenModuleContentAction,
    ListHiddenManualContentAction,
    PreviewResponder,
    { provide: HtmlRenderer, useClass: RenderHtmlRenderer },
    { provide: PreviewFiles, useClass: PackagePreviewFiles },
  ],
  // For the stable addresses (#450): a release's manual as the same page; for the iiRDS
  // export (#431): a release's modules as HTML topics.
  exports: [PreviewManualAction, PreviewResponder, PreviewFiles, HtmlRenderer],
})
export class PreviewModule {}
