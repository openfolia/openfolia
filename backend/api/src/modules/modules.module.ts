import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { ChangeSetsModule } from '../change-sets/change-sets.module.js';
import { ContentModule } from '../content/content.module.js';
import { ModuleSummariesController } from './api/module-summaries.controller.js';
import { ModulesController } from './api/modules.controller.js';
import {
  ModuleCompareController,
  ModuleHistoryController,
} from './api/module-history.controller.js';
import { CompareModuleVersionsAction } from './core/actions/compare-module-versions.action.js';
import { GetModuleHistoryAction } from './core/actions/get-module-history.action.js';
import { GetModuleAction } from './core/actions/get-module.action.js';
import { GetModuleStatusesAction } from './core/actions/get-module-statuses.action.js';
import { ListModuleSummariesAction } from './core/actions/list-module-summaries.action.js';
import { GetModuleUsageAction } from './core/actions/get-module-usage.action.js';
import { ListModulesAction } from './core/actions/list-modules.action.js';
import { ModuleIndex, ModuleIndexStore } from './core/module-index.js';
import { ReadableModuleIndex } from './core/readable-module-index.js';
import { DrizzleModuleIndexStore } from './repos/drizzle-module-index-store.js';

@Module({
  // `ChangeSetTouches`: the open change sets changing a module;
  // `UserDirectory`: the users a module's history names.
  imports: [ContentModule, ChangeSetsModule, AccessModule],
  controllers: [
    ModulesController,
    ModuleSummariesController,
    ModuleHistoryController,
    ModuleCompareController,
  ],
  providers: [
    GetModuleHistoryAction,
    CompareModuleVersionsAction,
    ListModulesAction,
    GetModuleAction,
    GetModuleStatusesAction,
    ListModuleSummariesAction,
    GetModuleUsageAction,
    // The module index (#45): per commit, built from Git, kept in Postgres.
    ModuleIndex,
    ReadableModuleIndex,
    { provide: ModuleIndexStore, useClass: DrizzleModuleIndexStore },
  ],
  // Never the unfiltered `ModuleIndex`: other components read it as a reader
  // sees it. `GetModuleStatusesAction`: the chunks' release (`chunks`).
  exports: [ReadableModuleIndex, GetModuleStatusesAction],
})
export class ModulesModule {}
