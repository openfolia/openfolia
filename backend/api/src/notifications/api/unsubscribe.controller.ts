import {
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { CarriesOwnAuthority } from '../../base/api/cross-site.guard.js';
import { AcceptsBodyOf, JsonApi } from '../../base/api/json-api.decorators.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { Public } from '../../base/api/public.decorator.js';
import { UnsubscribeToken } from '../../mail/core/templates/notification-templates.js';
import { ChosenKind } from '../core/notification.js';
import { UnsubscribeAction } from '../core/actions/unsubscribe.action.js';

export const UnsubscribedDocument = z
  .object({
    meta: z.object({
      kinds: z
        .array(ChosenKind)
        .describe(
          'Of the kinds the link is for (the email’s), those that send you no email now.',
        ),
      changed: z
        .array(ChosenKind)
        .describe(
          'Of those, the ones whose email this turned off (they come in the app only now); empty when none came by email any more.',
        ),
    }),
  })
  .meta({ id: 'UnsubscribedDocument' });
export type UnsubscribedDocument = z.infer<typeof UnsubscribedDocument>;

/**
 * The one-click unsubscribe of a notification email (#884, RFC 8058): the URL of the email's
 * `List-Unsubscribe` header, which a mail client POSTs `List-Unsubscribe=One-Click` to, and
 * what the editor's unsubscribe page calls. Public: the token in the path is the authority.
 */
@ApiTags('notifications')
@Controller('notifications/unsubscribe')
@JsonApi()
export class UnsubscribeController {
  constructor(private readonly unsubscribe: UnsubscribeAction) {}

  @Post(':token')
  @Public()
  @CarriesOwnAuthority()
  @AcceptsBodyOf(
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    'text/plain',
  )
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Stop a notification email',
    description:
      'Stops the email for the kinds the email was about, the way it came (at once, or in the daily summary): those kinds come in the app only from now on, without signing in. The link’s sealed token names the person, those kinds and the way; it changes nothing else and turns nothing on. A mail client posts `List-Unsubscribe=One-Click` (any body, which is not read); the editor posts nothing. Answering it again changes nothing more.',
  })
  @ApiOkResponse({ standardSchema: UnsubscribedDocument })
  @ApiNotFoundResponse({
    description:
      '`unsubscribe-link-invalid`: not a link this server made, or its person is gone.',
    standardSchema: ErrorDocument,
  })
  async post(
    @Param('token', { schema: UnsubscribeToken }) token: string,
  ): Promise<UnsubscribedDocument> {
    const done = await this.unsubscribe.handle({ token });
    return { meta: { kinds: [...done.kinds], changed: [...done.changed] } };
  }
}
