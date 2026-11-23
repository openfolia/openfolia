import {
  Body,
  Controller,
  Get,
  Header,
  HttpStatus,
  Patch,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { JsonApi } from '../../base/api/json-api.decorators.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { GetPreferencesAction } from '../core/actions/get-preferences.action.js';
import { UpdatePreferencesAction } from '../core/actions/update-preferences.action.js';
import {
  PreferencesDocument,
  preferencesIdOf,
  toChanges,
  toPreferencesResource,
  UpdatePreferencesDocument,
} from './preferences.resources.js';

const OWN_ONLY =
  'Only your own: nobody reads or changes another person’s. Any person; no permission needed.';

/**
 * Each person's own preferences (#222): `GET /me/preferences` and `PATCH /me/preferences`, the
 * editor's tips and first-run tour, kept on the server so they follow the person across browsers.
 */
@ApiTags('preferences')
@Controller('me/preferences')
@JsonApi()
export class PreferencesController {
  constructor(
    private readonly getPreferences: GetPreferencesAction,
    private readonly updatePreferences: UpdatePreferencesAction,
  ) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Read your preferences',
    description: `Whether the editor shows you tips and the first-run tour, the tips you closed and whether you finished the tour; the defaults (tips on, none closed, the tour to come) until you change one. A service reads the defaults. ${OWN_ONLY}`,
  })
  @ApiOkResponse({ standardSchema: PreferencesDocument })
  async read(@CurrentActor() actor: Actor): Promise<PreferencesDocument> {
    return {
      data: toPreferencesResource(
        actor,
        await this.getPreferences.handle({ actor }),
      ),
    };
  }

  @Patch()
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Change your preferences',
    description: `What is left out stays; \`dismissedTips\` replaces the whole list. Applies at once and is not audited (it changes nothing anyone else sees). ${OWN_ONLY}`,
  })
  @ApiOkResponse({ standardSchema: PreferencesDocument })
  @ApiBadRequestResponse({
    description:
      'The body is not a preferences document (an unknown preference, a malformed tip ID, more than 500 tips).',
    standardSchema: ErrorDocument,
  })
  @ApiForbiddenResponse({
    description: '`forbidden`: a service has no preferences to change.',
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description: '`id-mismatch`: `data.id` is given and is not your user ID.',
    standardSchema: ErrorDocument,
  })
  async update(
    @CurrentActor() actor: Actor,
    @Body({ schema: UpdatePreferencesDocument })
    body: UpdatePreferencesDocument,
  ): Promise<PreferencesDocument> {
    if (body.data.id !== undefined && body.data.id !== preferencesIdOf(actor)) {
      throw new JsonApiException(HttpStatus.CONFLICT, [
        {
          code: 'id-mismatch',
          detail: '`data.id` must be your own user ID.',
          source: { pointer: '/data/id' },
        },
      ]);
    }
    return {
      data: toPreferencesResource(
        actor,
        await this.updatePreferences.handle({
          actor,
          changes: toChanges(body.data.attributes),
        }),
      ),
    };
  }
}
