import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { JsonApi } from '../../base/api/json-api.decorators.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import {
  GetMailSettingsAction,
  MANAGE_MAIL,
  SendTestMailAction,
} from '../core/actions/mail-settings.actions.js';
import {
  MailMessageDocument,
  MailSettingsDocument,
  SendTestMailDocument,
  toMailMessageDocument,
  toMailSettingsDocument,
} from './mail.resources.js';

/** `GET /mail` and `POST /mail/test` (#609), for Admin › System › Email. */
@ApiTags('system')
@Controller('mail')
@JsonApi()
export class MailController {
  constructor(
    private readonly getSettings: GetMailSettingsAction,
    private readonly sendTest: SendTestMailAction,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Email’s settings',
    description: `Whether the server sends email, and through which mail server: its host, port and TLS, whether it signs in, the sender’s address and name. Never the user or the password. Read-only: the settings are in the environment (\`CCMS_MAIL_*\`). Needs the \`${MANAGE_MAIL}\` permission.`,
  })
  @ApiOkResponse({ standardSchema: MailSettingsDocument })
  @ApiPermission(MANAGE_MAIL)
  async get(
    @CurrentActor() actor: Actor,
  ): Promise<z.infer<typeof MailSettingsDocument>> {
    return toMailSettingsDocument(await this.getSettings.handle({ actor }));
  }

  @Post('test')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Send a test email',
    description: `Queues a test email to the signed-in administrator’s own address, in \`language\` (else the installation’s), with the branding. It is sent in the background, as every email is, and retried; a failure for good is recorded as \`mail.failed\`. Recorded as \`mail.test\`. Needs the \`${MANAGE_MAIL}\` permission.`,
  })
  @ApiAcceptedResponse({ standardSchema: MailMessageDocument })
  @ApiNotFoundResponse({
    description:
      '`not-configured`: email is off; `meta.reason` is `off` (no mail server, `CCMS_MAIL_URL`) or `no-secret-key` (no instance secret key).',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`no-email-address`: the signed-in actor has no email address (a service account, a user without one).',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description:
      '`database-timeout`: the transaction waited too long; nothing was queued. `Retry-After` says when to try again.',
    standardSchema: ErrorDocument,
  })
  @ApiPermission(MANAGE_MAIL)
  async test(
    @CurrentActor() actor: Actor,
    @Body({ schema: SendTestMailDocument }) body: SendTestMailDocument,
  ): Promise<z.infer<typeof MailMessageDocument>> {
    return toMailMessageDocument(
      await this.sendTest.handle({
        actor,
        language: body.data.attributes?.language ?? null,
      }),
    );
  }
}
