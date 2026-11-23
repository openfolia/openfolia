import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditModule } from '../audit/audit.module.js';
import type { Env } from '../config/env.js';
import { ChangeSetsModule } from '../change-sets/change-sets.module.js';
import { ContentModule } from '../content/content.module.js';
import { StyleReviewController } from './api/style-review.controller.js';
import { GetStyleReviewStatusAction } from './core/actions/get-style-review-status.action.js';
import { ReviewModuleStyleAction } from './core/actions/review-module-style.action.js';
import { StyleReviewer, StyleReviewLimits } from './core/style-reviewer.js';
import { HttpStyleReviewer } from './repos/http-style-reviewer.js';
import { NoStyleReviewer } from './repos/no-style-reviewer.js';

/**
 * The model-based style review (#248): off (`NoStyleReviewer`) unless
 * `CCMS_STYLE_REVIEW_URL` names an endpoint (`HttpStyleReviewer`).
 */
@Module({
  imports: [ContentModule, ChangeSetsModule, AuditModule],
  controllers: [StyleReviewController],
  providers: [
    ReviewModuleStyleAction,
    GetStyleReviewStatusAction,
    {
      provide: StyleReviewer,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): StyleReviewer => {
        const url = config.get('CCMS_STYLE_REVIEW_URL', { infer: true });
        const model = config.get('CCMS_STYLE_REVIEW_MODEL', { infer: true });
        if (!url || !model) return new NoStyleReviewer();
        return new HttpStyleReviewer({
          url,
          model,
          apiKey: config.get('CCMS_STYLE_REVIEW_API_KEY', { infer: true }),
        });
      },
    },
    {
      provide: StyleReviewLimits,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): StyleReviewLimits => ({
        perMinute: config.get('CCMS_STYLE_REVIEW_PER_MINUTE', { infer: true }),
        timeoutMs: config.get('CCMS_STYLE_REVIEW_TIMEOUT_MS', { infer: true }),
      }),
    },
  ],
})
export class StyleReviewModule {}
