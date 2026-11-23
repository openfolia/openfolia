import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { ConfigKey, type Condition } from '@openfolia/content-model';
import type { Request } from 'express';
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  AcceptsQuery,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  CONTENT_HEADERS,
  CurrentSnapshot,
  ReadsContent,
} from '../../content/api/read-content.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { ListVariantAttributesAction } from '../core/actions/list-variant-attributes.action.js';
import { ListVariantUsesAction } from '../core/actions/list-variant-uses.action.js';
import { MatchVariantsAction } from '../core/actions/match-variants.action.js';
import {
  ConditionText,
  MAX_CONDITION_LENGTH,
  toVariantAttributeResource,
  toVariantBuildResource,
  toVariantUseResource,
  VariantAttributePageDocument,
  VariantBuildPageDocument,
  VariantUsePageDocument,
} from './variant.resources.js';

/** Variant attributes and the builds a condition holds for, for the editor's variant picker (#69). */
@ApiTags('variants')
@Controller('variants')
@JsonApi()
@ReadsContent()
export class VariantsController {
  constructor(
    private readonly listAttributes: ListVariantAttributesAction,
    private readonly matchVariants: MatchVariantsAction,
    private readonly listUses: ListVariantUsesAction,
  ) {}

  @Get()
  @Paged()
  @ApiOperation({
    summary: 'List variant attributes',
    description:
      'The variant attributes of the project configuration at `?ref=`, in their configured order: an enum attribute with its values, a version attribute (compared numerically) without. What a variant picker offers; conditions name them by `id`.',
  })
  @ApiPermission('content.read')
  @ApiOkResponse({
    standardSchema: VariantAttributePageDocument,
    headers: CONTENT_HEADERS,
  })
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
  ): Promise<z.infer<typeof VariantAttributePageDocument>> {
    const result = await this.listAttributes.handle({
      actor,
      snapshot,
      page,
    });
    return toPagedDocument(req, page, result, toVariantAttributeResource);
  }

  @Get('matches')
  @Paged()
  @AcceptsQuery('when')
  @ApiQuery({
    name: 'when',
    required: true,
    description: `A condition, as a variant block's \`when="…"\` writes it in AsciiDoc: \`model in (large, small)\`, \`software >= 2.3\` (\`<\`, \`<=\`, \`>\`, \`>=\` on version attributes), \`!(…)\`, \`&&\` (binds tighter) and \`||\`, parentheses; a value that is not letters, digits, \`.\`, \`_\` and \`-\` in single quotes. At most ${MAX_CONDITION_LENGTH} characters.`,
    example: 'model in (large) && software >= 2.3',
    schema: { type: 'string', maxLength: MAX_CONDITION_LENGTH },
  })
  @ApiOperation({
    summary: 'Builds a condition holds for',
    description:
      'Every variant combination a manual the reader may see lists (`variants:` in its manifest) that the condition holds for, in the order `GET /manuals` lists the manuals, then in the manifest’s order: `meta.page.total` is the number of builds it appears in. Evaluated as a manual is resolved: versions compare numerically (`2.10 > 2.9`, `2.3 = 2.3.0`), and a test on an attribute a combination does not set does not hold, not even negated. Manuals outside the reader’s scope are never named nor counted; one whose manifest cannot be read lists none.',
  })
  @ApiPermission('content.read')
  @ApiBadRequestResponse({
    description:
      '`invalid-parameter` (`source.parameter`: `when`): no condition, or one that does not parse; `detail` is the parser’s message.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`unknown-variant`: the condition names an attribute or value the configuration does not hold, compares an enum attribute, or compares a version attribute with something that is not a version (`software >= abc`); one error per problem, `meta.issue` its validation code. (`invalid-content` for a broken file, as on every content route.)',
    standardSchema: ErrorDocument,
  })
  @ApiOkResponse({
    standardSchema: VariantBuildPageDocument,
    headers: CONTENT_HEADERS,
  })
  async matches(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
    @Query('when', { schema: ConditionText }) when: Condition,
  ): Promise<z.infer<typeof VariantBuildPageDocument>> {
    const result = await this.matchVariants.handle({
      actor,
      snapshot,
      when,
      page,
    });
    return toPagedDocument(req, page, result, toVariantBuildResource);
  }

  @Get(':attributeId/usages')
  @Paged()
  @AcceptsQuery('filter[value]')
  @ApiParam({ name: 'attributeId', example: 'model' })
  @ApiQuery({
    name: 'filter[value]',
    required: false,
    description:
      'Only where this value of the attribute is named (an enum attribute’s value ID); without it, where the attribute is named at all, by any value or comparison.',
    schema: { type: 'string' },
  })
  @ApiOperation({
    summary: 'Where a variant attribute or value is used',
    description:
      'The manuals (variant combinations, conditions of entries and text attributes) and then the modules (variant blocks, in any language: `languages`) that name the attribute, or with `filter[value]` that value of it, at `?ref=`, each by title, then ID: what the variants admin lists before a value is archived or removed (`meta.page.total` counts them). Read from the module index, so only what the reader may see is listed or counted. Not checked against the configuration: a value it no longer holds is still found where content names it. The builds a value appears in are `GET /variants/matches`.',
  })
  @ApiPermission('content.read')
  @ApiBadRequestResponse({
    description:
      '`invalid-parameter`: `attributeId` or `filter[value]` is no configuration key.',
    standardSchema: ErrorDocument,
  })
  @ApiOkResponse({
    standardSchema: VariantUsePageDocument,
    headers: CONTENT_HEADERS,
  })
  async usages(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @CurrentSnapshot() snapshot: ReadableContent,
    @PageParams() page: PageRequest,
    @Param('attributeId', { schema: ConfigKey }) attribute: string,
    @Query('filter[value]', { schema: ConfigKey.optional() })
    value: string | undefined,
  ): Promise<z.infer<typeof VariantUsePageDocument>> {
    const result = await this.listUses.handle({
      actor,
      snapshot,
      attribute,
      value,
      page,
    });
    return toPagedDocument(req, page, result, toVariantUseResource);
  }
}
