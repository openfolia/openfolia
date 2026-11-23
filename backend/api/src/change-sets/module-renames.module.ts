import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CommentsModule } from '../comments/comments.module.js';
import { ContentModule } from '../content/content.module.js';
import { TranslationsModule } from '../translations/translations.module.js';
import { ModuleRenamesController } from './api/module-renames.controller.js';
import { ChangeSetsModule } from './change-sets.module.js';
import { GetModuleReferencesAction } from './core/actions/get-module-references.action.js';
import { RenameModuleAction } from './core/actions/rename-module.action.js';

/**
 * Changing a module's ID in a change set (#265). A module of its own, as
 * it takes the comments (`CommentsModule`, which needs change sets) and the
 * translation jobs along: `ChangeSetsModule` cannot import those.
 */
@Module({
  // `ChangeSetStore` from `AuthoredBranchesModule` and `WorkingCopyStore`
  // from `WorkingCopyReadsModule` (both global).
  imports: [
    ContentModule,
    AuditModule,
    ChangeSetsModule,
    CommentsModule,
    TranslationsModule,
  ],
  controllers: [ModuleRenamesController],
  providers: [RenameModuleAction, GetModuleReferencesAction],
})
export class ModuleRenamesModule {}
