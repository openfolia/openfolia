import { Body, Controller, Get, Header, Patch } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiBadRequestResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { JsonApi } from '../../base/api/json-api.decorators.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { GetInstallationSettingsAction } from '../core/actions/get-installation-settings.action.js';
import { UpdateInstallationSettingsAction } from '../core/actions/update-installation-settings.action.js';
import {
  InstallationSettingsDocument,
  toChanges,
  toInstallationSettingsResource,
  UpdateInstallationSettingsDocument,
} from './settings.resources.js';

const ADMIN = 'Needs the `admin.roles` permission.';

/**
 * The installation's own settings (#588): `GET /settings` and `PATCH /settings`, for holders of
 * `admin.roles`. Not the project configuration (`GET /config`, in Git, changed in a change set).
 */
@ApiTags('settings')
@Controller('settings')
@JsonApi()
export class SettingsController {
  constructor(
    private readonly getSettings: GetInstallationSettingsAction,
    private readonly updateSettings: UpdateInstallationSettingsAction,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Read the installation settings',
    description: `The installation’s own settings, kept in the database and changed at once: not the project configuration (\`GET /config\`), which changes in a change set. \`selfApproval\` says who may approve their own change set; the review screen reads it from a change set’s \`meta.review.selfApproval\`. ${ADMIN}`,
  })
  @ApiOkResponse({ standardSchema: InstallationSettingsDocument })
  @ApiPermission('admin.roles')
  async read(
    @CurrentActor() actor: Actor,
  ): Promise<InstallationSettingsDocument> {
    return {
      data: toInstallationSettingsResource(
        await this.getSettings.handle({ actor }),
      ),
    };
  }

  @Patch()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Change the installation settings',
    description: `What is left out stays. Applies at once. A changed \`selfApproval\` is audited as \`settings.self-approval\` (\`from\`, \`to\`); approvals already given stay, whatever it changes to (the rule is read when an approval is given). A change that changes nothing records nothing. ${ADMIN}`,
  })
  @ApiOkResponse({ standardSchema: InstallationSettingsDocument })
  @ApiBadRequestResponse({
    description:
      'The body is not an installation settings document (an unknown setting or value).',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description: '`database-timeout`: the change waited too long for another.',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('admin.roles')
  async update(
    @CurrentActor() actor: Actor,
    @Body({ schema: UpdateInstallationSettingsDocument })
    body: UpdateInstallationSettingsDocument,
  ): Promise<InstallationSettingsDocument> {
    return {
      data: toInstallationSettingsResource(
        await this.updateSettings.handle({
          actor,
          changes: toChanges(body.data.attributes),
        }),
      ),
    };
  }
}
