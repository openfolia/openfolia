import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessModule } from '../access/access.module.js';
import { AssetsModule } from '../assets/assets.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { ChangeSetsModule } from '../change-sets/change-sets.module.js';
import type { Env } from '../config/env.js';
import { ContentModule } from '../content/content.module.js';
import { ApplyImportJobHandler } from './api/import-job.handler.js';
import { ImportSweeper } from './api/import-sweeper.js';
import {
  ImportersController,
  ImportsController,
} from './api/imports.controller.js';
import { ApplyImportAction } from './core/actions/apply-import.action.js';
import { CreateImportAction } from './core/actions/create-import.action.js';
import { GetImportAction } from './core/actions/get-import.action.js';
import { ListImportersAction } from './core/actions/list-importers.action.js';
import {
  FailImportAction,
  RunImportAction,
} from './core/actions/run-import.action.js';
import { SweepImportsAction } from './core/actions/sweep-imports.action.js';
import { BundleImporter } from './core/bundle-importer.js';
import { DitaConversionSettings, DitaImporter } from './core/dita-importer.js';
import { ImportSettings } from './core/import.js';
import { ImportPipeline } from './core/import-pipeline.js';
import { ImportStore } from './core/import-store.js';
import { ImportUploads } from './core/import-uploads.js';
import { type Importer, IMPORTERS, ImporterRegistry } from './core/importer.js';
import { DrizzleImportStore } from './repos/drizzle-import-store.js';

/**
 * Imports (#256): importers behind the `Importer` port (the built-in one
 * reads the documented import format), a dry-run report, and applying an
 * import into a change set in a background job, through the change-set and
 * asset actions. Another importer is one more provider in `IMPORTERS`.
 */
@Module({
  imports: [
    ContentModule,
    AuditModule,
    AccessModule,
    AssetsModule,
    ChangeSetsModule,
  ],
  controllers: [ImportersController, ImportsController],
  providers: [
    BundleImporter,
    DitaImporter,
    {
      provide: DitaConversionSettings,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<Env, true>,
      ): DitaConversionSettings => ({
        maxMemoryMb: config.get('CCMS_IMPORT_CONVERT_MAX_MEMORY_MB', {
          infer: true,
        }),
        timeoutMs: config.get('CCMS_IMPORT_CONVERT_TIMEOUT_MS', {
          infer: true,
        }),
        maxDocumentBytes: config.get('CCMS_IMPORT_MAX_DOCUMENT_BYTES', {
          infer: true,
        }),
      }),
    },
    {
      provide: IMPORTERS,
      inject: [BundleImporter, DitaImporter],
      useFactory: (bundle: BundleImporter, dita: DitaImporter): Importer[] => [
        bundle,
        dita,
      ],
    },
    {
      provide: ImporterRegistry,
      inject: [IMPORTERS],
      useFactory: (importers: Importer[]) => new ImporterRegistry(importers),
    },
    {
      provide: ImportSettings,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): ImportSettings => ({
        maxBytes: config.get('CCMS_IMPORT_MAX_BYTES', { infer: true }),
        maxFiles: config.get('CCMS_IMPORT_MAX_FILES', { infer: true }),
        maxUnpackedBytes: config.get('CCMS_IMPORT_MAX_UNPACKED_BYTES', {
          infer: true,
        }),
        maxPathDepth: config.get('CCMS_IMPORT_MAX_PATH_DEPTH', { infer: true }),
        maxJsonDepth: config.get('CCMS_IMPORT_MAX_JSON_DEPTH', { infer: true }),
        maxDocumentBytes: config.get('CCMS_IMPORT_MAX_DOCUMENT_BYTES', {
          infer: true,
        }),
        commitFiles: config.get('CCMS_IMPORT_COMMIT_FILES', { infer: true }),
        commitBytes: config.get('CCMS_IMPORT_COMMIT_BYTES', { infer: true }),
        maxImageBytes: config.get('CCMS_MAX_UPLOAD_BYTES', { infer: true }),
        maxAttachmentBytes: config.get('CCMS_MAX_ATTACHMENT_BYTES', {
          infer: true,
        }),
        attachmentTypes: {
          allow: config.get('CCMS_ATTACHMENT_TYPES_ALLOW', { infer: true }),
          deny: config.get('CCMS_ATTACHMENT_TYPES_DENY', { infer: true }),
          open: config.get('CCMS_ATTACHMENT_TYPES_OPEN', { infer: true }),
        },
      }),
    },
    { provide: ImportStore, useClass: DrizzleImportStore },
    ImportPipeline,
    ImportUploads,
    ListImportersAction,
    CreateImportAction,
    GetImportAction,
    ApplyImportAction,
    RunImportAction,
    FailImportAction,
    SweepImportsAction,
    ApplyImportJobHandler,
    ImportSweeper,
  ],
})
export class ImportsModule {}
