import { Module } from '@nestjs/common';
import { ContentModule } from '../content/content.module.js';
import { ModulesModule } from '../modules/modules.module.js';
import { VariantsController } from './api/variants.controller.js';
import { ListVariantAttributesAction } from './core/actions/list-variant-attributes.action.js';
import { ListVariantUsesAction } from './core/actions/list-variant-uses.action.js';
import { MatchVariantsAction } from './core/actions/match-variants.action.js';

@Module({
  // `ReadableModuleIndex`: where a variant value is used.
  imports: [ContentModule, ModulesModule],
  controllers: [VariantsController],
  providers: [
    ListVariantAttributesAction,
    MatchVariantsAction,
    ListVariantUsesAction,
  ],
})
export class VariantsModule {}
