import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditModule } from '../audit/audit.module.js';
import { ChangeSetsModule } from '../change-sets/change-sets.module.js';
import type { Env } from '../config/env.js';
import { ContentModule } from '../content/content.module.js';
import { TranslationImportsController } from './api/translation-imports.controller.js';
import { MarkTranslationCurrentAction } from './core/actions/mark-translation-current.action.js';
import {
  ApplyTranslationImportAction,
  GetTranslationImportAction,
  TranslationImportGate,
  ValidateTranslationImportAction,
} from './core/actions/translation-imports.action.js';
import { TranslationEvents } from './core/translation-events.js';
import {
  TranslationImportCheck,
  TranslationImportSettings,
} from './core/translation-import-check.js';
import { TranslationImportStore } from './core/translation-import-store.js';
import { DrizzleTranslationEvents } from './repos/drizzle-translation-events.js';
import { MemoryTranslationImportStore } from './repos/memory-translation-import-store.js';
import { TranslationsModule } from './translations.module.js';

/**
 * Translation imports (#51): an XLIFF of a translation job checked unit by
 * unit, then written into a change set through the change-set actions;
 * and marking a translation current. Its own module, since it builds on
 * both the translation jobs and the change sets.
 */
@Module({
  imports: [ContentModule, AuditModule, ChangeSetsModule, TranslationsModule],
  controllers: [TranslationImportsController],
  providers: [
    {
      provide: TranslationImportSettings,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<Env, true>,
      ): TranslationImportSettings => ({
        maxBytes: config.get('CCMS_MAX_UPLOAD_BYTES', { infer: true }),
      }),
    },
    {
      provide: TranslationImportStore,
      useFactory: () => new MemoryTranslationImportStore(),
    },
    { provide: TranslationEvents, useClass: DrizzleTranslationEvents },
    TranslationImportCheck,
    TranslationImportGate,
    ValidateTranslationImportAction,
    GetTranslationImportAction,
    ApplyTranslationImportAction,
    MarkTranslationCurrentAction,
  ],
})
export class TranslationImportsModule {}
