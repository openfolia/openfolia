import { ModuleId } from '@openfolia/content-model';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { JsonApi } from '../../base/api/json-api.decorators.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { GetStyleReviewStatusAction } from '../core/actions/get-style-review-status.action.js';
import { ReviewModuleStyleAction } from '../core/actions/review-module-style.action.js';
import {
  StyleReviewDocument,
  StyleReviewRequestDocument,
  StyleReviewStatusDocument,
  toStyleReviewResource,
} from './style-review.resources.js';

const DESCRIPTION =
  'Asks the configured language model for style and consistency suggestions on one module of a change set: its working copy, else the file committed on its branch. **Off by default**: without a configured endpoint (`CCMS_STYLE_REVIEW_URL`) it is 404 `not-configured` and nothing is sent anywhere. **What is sent:** only the module’s translatable text (each block’s own text as plain text, by block ID) and the style guide in `openfolia.yaml` (`styleGuide`): no metadata, no comments, no other module. Nothing is stored; one `module.style-review` audit event records who asked, for which module, the outcome and how many suggestions (never the text). The suggestions are advice: each one names a block, a part and a range of its text; one that does not fit the module’s text is dropped (`meta.dropped`). Only the change set’s author, within their reading scope, as the working copy is read (403 for anyone else who holds `content.read.draft`; for anyone else another author’s change set is 404, exactly like a missing one). No body. Needs the `content.edit` permission (and `content.read`, which reading the module needs).';

/** The model-based style review of a module (#248). */
@ApiTags('style review')
@Controller()
@JsonApi()
export class StyleReviewController {
  constructor(
    private readonly reviewModuleStyle: ReviewModuleStyleAction,
    private readonly getStatus: GetStyleReviewStatusAction,
  ) {}

  @Get('style-review')
  @ApiOperation({
    summary: 'Whether the style review is set up',
    description:
      'Whether this server has a model-based style review (`attributes.configured`), so a client offers it only where it works; it says nothing else about the endpoint or the model. Needs the `content.edit` permission, as a review does.',
  })
  @ApiOkResponse({ standardSchema: StyleReviewStatusDocument })
  @ApiPermission('content.edit')
  async status(
    @CurrentActor() actor: Actor,
  ): Promise<z.infer<typeof StyleReviewStatusDocument>> {
    const { configured } = await this.getStatus.handle({ actor });
    return {
      data: {
        type: 'StyleReviewStatus',
        id: 'style-review',
        attributes: { configured },
      },
    };
  }

  @Post('change-sets/:changeSetId/modules/:lang/:moduleId/style-review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Review a module’s style with a model',
    description: DESCRIPTION,
  })
  @ApiParam({
    name: 'changeSetId',
    description:
      'The change set’s ID (a UUID). One that names no change set, malformed or not, is 404.',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiParam({
    name: 'lang',
    example: 'en',
    description:
      'A language with subtags of 2 to 8 characters (`en`, `pt-BR`); any case. One that is not is 404.',
  })
  @ApiParam({ name: 'moduleId', example: 'battery-charging' })
  @ApiOkResponse({ standardSchema: StyleReviewDocument })
  @ApiNotFoundResponse({
    description:
      '`not-configured`: no model endpoint is set up on this server. `not-found`: no change set with this ID, or neither a working copy nor a committed file of the module the reader may see.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`too-large`: the module’s text and the style guide are more than `meta.max` characters.',
    standardSchema: ErrorDocument,
  })
  @ApiTooManyRequestsResponse({
    description:
      '`rate-limited`: more reviews this minute than `CCMS_STYLE_REVIEW_PER_MINUTE` allows the caller; `Retry-After` (and `meta.retryAfter`) says when to try again.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description:
      '`style-review-timeout`: the model took longer than `CCMS_STYLE_REVIEW_TIMEOUT_MS`. `style-review-unavailable`: the endpoint failed or answered with something other than suggestions. `style-review-busy`: too many reviews at once on this server. Each with `Retry-After`.',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('content.edit')
  async review(
    @CurrentActor() actor: Actor,
    @Param('changeSetId') changeSetId: string,
    // Checked by the working copy's read (`LockSubject`), after the permission check.
    @Param('lang') lang: string,
    @Param('moduleId', { schema: ModuleId }) moduleId: string,
    @Body({ schema: StyleReviewRequestDocument })
    _body: StyleReviewRequestDocument,
  ): Promise<z.infer<typeof StyleReviewDocument>> {
    const review = await this.reviewModuleStyle.handle({
      actor,
      changeSetId,
      lang,
      moduleId,
    });
    return { data: toStyleReviewResource(review) };
  }
}
