import { Body, Controller, Get, Header, Patch, Req } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiBadRequestResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import { sessionCookie } from '../../access/api/sign-in-attempts.js';
import { hashSessionToken } from '../../access/core/sessions.js';
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
    description: `The installation’s own settings, kept in the database and changed at once: not the project configuration (\`GET /config\`), which changes in a change set. \`selfApproval\` says who may approve their own change set; the review screen reads it from a change set’s \`meta.review.selfApproval\`. \`secondFactor\` says who must sign in with a second factor, \`singleSignOn\` whether with an identity provider, \`breakGlassAccount\` who may still use a password then, and the session limits how long a session lasts. ${ADMIN}`,
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
    description: `What is left out stays. Applies at once. A changed \`selfApproval\` is audited as \`settings.self-approval\` (\`from\`, \`to\`); approvals already given stay, whatever it changes to (the rule is read when an approval is given). A changed \`secondFactor\` is audited as \`settings.second-factor\`; sessions already running go on, and someone without a second factor sets one up at their next sign-in. A changed \`singleSignOn\` (\`settings.single-sign-on\`), \`breakGlassAccount\` (\`settings.break-glass\`) or session limit (\`settings.session-limits\`) counts for running sessions too: what it refuses ends at once (\`settings.sign-ins-ended\`, the counts). A change that changes nothing records nothing. ${ADMIN}`,
  })
  @ApiOkResponse({ standardSchema: InstallationSettingsDocument })
  @ApiBadRequestResponse({
    description:
      'The body is not an installation settings document (an unknown setting or value).',
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description:
      '`second-factor-unavailable`: requiring a second factor needs the instance secret key. `second-factor-own-first`: turn on your own first (when you sign in with a password or a code by email), so nobody is locked out. `single-sign-on-unavailable`: no identity provider answers now. `single-sign-on-own-first`: your own session would end; sign in with the identity provider, or as the break-glass account, first.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`break-glass-not-usable` (`meta.problem`): the account could not be signed in to. `session-limits-crossed`: the idle limit is longer than a session lasts.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description: '`database-timeout`: the change waited too long for another.',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('admin.roles')
  async update(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @Body({ schema: UpdateInstallationSettingsDocument })
    body: UpdateInstallationSettingsDocument,
  ): Promise<InstallationSettingsDocument> {
    const token = req.signInSession ? sessionCookie(req) : undefined;
    return {
      data: toInstallationSettingsResource(
        await this.updateSettings.handle({
          actor,
          provider: req.signInSession?.provider,
          sessionHash:
            token === undefined ? undefined : hashSessionToken(token),
          changes: toChanges(body.data),
        }),
      ),
    };
  }
}
