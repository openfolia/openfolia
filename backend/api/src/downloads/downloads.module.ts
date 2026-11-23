import { Module } from '@nestjs/common';
import { ContentModule } from '../content/content.module.js';
import { ReleasesModule } from '../releases/releases.module.js';
import {
  DownloadFileController,
  DownloadsController,
} from './api/downloads.controller.js';
import { DownloadFileAction } from './core/actions/download-file.action.js';
import { DownloadVersionsAction } from './core/actions/download-versions.action.js';
import { ListDownloadsAction } from './core/actions/list-downloads.action.js';
import { DownloadObservations } from './core/download-reads.js';

/**
 * The download centre (#139): a read model over attachments in modules (#236) and release
 * outputs (#249), per product and language, with each file's versions across releases. Part of
 * the delivery API; no upload path of its own.
 */
@Module({
  imports: [ContentModule, ReleasesModule],
  controllers: [DownloadsController, DownloadFileController],
  providers: [
    ListDownloadsAction,
    DownloadVersionsAction,
    DownloadFileAction,
    DownloadObservations,
  ],
})
export class DownloadsModule {}
