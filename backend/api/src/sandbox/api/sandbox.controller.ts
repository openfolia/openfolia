import { Controller, Get } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { JsonApi } from '../../base/api/json-api.decorators.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import type { Actor } from '../../access/core/actor.js';
import { GetSandboxAction } from '../core/actions/get-sandbox.action.js';
import { SandboxDocument, toSandboxDocument } from './sandbox.resources.js';

/** `GET /sandbox` (#826): whether this instance is a public sandbox, its caps and its end. */
@ApiTags('sandbox')
@Controller('sandbox')
@JsonApi()
export class SandboxController {
  constructor(private readonly getSandbox: GetSandboxAction) {}

  @Get()
  @ApiOperation({
    summary: 'The public sandbox',
    description:
      'Public sandbox only (`CCMS_PUBLIC_SANDBOX=on`): its caps (`attributes.limits`, past one 422 `sandbox-limit-reached`), what is used of them and when it ends (`meta.endsAt`, the earlier of `idleMinutes` after the last request that did something and `maxMinutes` after it started), for a banner. In a sandbox nothing leaves the instance and nothing reaches other people: users, service accounts, tokens, invitations, uploads, imports, template changes, webhooks, test email and backups are 403 `sandbox-not-allowed`. Reading this does not count as activity. Any actor with the token.',
  })
  @ApiOkResponse({ standardSchema: SandboxDocument })
  @ApiNotFoundResponse({
    description:
      '`not-configured`: this instance is no public sandbox, which is how a client learns it is not.',
    standardSchema: ErrorDocument,
  })
  async get(
    @CurrentActor() actor: Actor,
  ): Promise<z.infer<typeof SandboxDocument>> {
    return toSandboxDocument(await this.getSandbox.handle({ actor }));
  }
}
