import { Module } from '@nestjs/common';
import { ContentModule } from '../content/content.module.js';
import { ManualsModule } from '../manuals/manuals.module.js';
import { PageDesignTemplatePreviewController } from './api/page-design-template-preview.controller.js';
import {
  PageDesignTemplateExampleController,
  PageDesignTemplatesController,
} from './api/page-design-templates.controller.js';
import { PageDesignsController } from './api/page-designs.controller.js';
import {
  GetDesignTemplateFileAction,
  GetExampleDesignTemplateAction,
  ListDesignTemplateFilesAction,
  PreviewDesignTemplateAction,
} from './core/actions/design-template-files.actions.js';
import { GetPageDesignAction } from './core/actions/get-page-design.action.js';
import { ListPageDesignTemplatesAction } from './core/actions/list-page-design-templates.action.js';
import { ListPageDesignsAction } from './core/actions/list-page-designs.action.js';

/**
 * The page designs (#390), read at a ref; written through change sets (`design` subjects), and
 * the own templates they may name (#396): their files, read at a ref and written through change
 * sets too (`template` subjects), and their live preview (`ManualsModule`: the PDF renderer).
 */
@Module({
  imports: [ContentModule, ManualsModule],
  controllers: [
    PageDesignsController,
    PageDesignTemplatesController,
    PageDesignTemplatePreviewController,
    PageDesignTemplateExampleController,
  ],
  providers: [
    ListPageDesignsAction,
    GetPageDesignAction,
    ListPageDesignTemplatesAction,
    ListDesignTemplateFilesAction,
    GetDesignTemplateFileAction,
    PreviewDesignTemplateAction,
    GetExampleDesignTemplateAction,
  ],
})
export class PageDesignsModule {}
