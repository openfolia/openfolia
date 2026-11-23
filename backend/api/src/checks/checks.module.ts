import { Module } from '@nestjs/common';
import { ChangeSetsModule } from '../change-sets/change-sets.module.js';
import { ChunksModule } from '../chunks/chunks.module.js';
import { ContentModule } from '../content/content.module.js';
import { ManualsModule } from '../manuals/manuals.module.js';
import { ChangeSetChecksController } from './api/change-set-checks.controller.js';
import { ManualChecksController } from './api/manual-checks.controller.js';
import { CheckContentAction } from './core/actions/check-content.action.js';
import { ListChangeSetChecksAction } from './core/actions/list-change-set-checks.action.js';
import { ListManualChecksAction } from './core/actions/list-manual-checks.action.js';
import { ContentChecks } from './core/content-checks.js';

/**
 * Checks (#71): blocking issues and warnings in a manual or in what a
 * change set changes, each at its module and block. Derived on every
 * request from the content and the blob store (`BlobsModule`, global),
 * and the PDF renderer for the PDF standard (`ManualsModule`), and a change set's head's chunks
 * as a whole (`ChunksModule`, #710); nothing is stored. `CheckContentAction` checks everything at
 * a commit for the CLI check (`check-content`, #55), which no route serves.
 */
@Module({
  imports: [ContentModule, ChangeSetsModule, ManualsModule, ChunksModule],
  controllers: [ManualChecksController, ChangeSetChecksController],
  providers: [
    ContentChecks,
    ListManualChecksAction,
    ListChangeSetChecksAction,
    CheckContentAction,
  ],
})
export class ChecksModule {}
