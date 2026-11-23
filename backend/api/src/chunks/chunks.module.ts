import { Module } from '@nestjs/common';
import { ContentModule } from '../content/content.module.js';
import { ModulesModule } from '../modules/modules.module.js';
import { ChunksController } from './api/chunks.controller.js';
import { ListChunksAction } from './core/actions/list-chunks.action.js';
import { ContentChanges } from './core/content-changes.js';
import { GitContentChanges } from './repos/git-content-changes.js';

/** Retrieval chunks (#52): the content as Markdown chunks for retrieval pipelines. */
@Module({
  // `GetModuleStatusesAction`: a chunk's newest release.
  imports: [ContentModule, ModulesModule],
  controllers: [ChunksController],
  providers: [
    ListChunksAction,
    { provide: ContentChanges, useClass: GitContentChanges },
  ],
  // The change feed (#43) compares chunk sets, from the same kept sets.
  exports: [ListChunksAction],
})
export class ChunksModule {}
