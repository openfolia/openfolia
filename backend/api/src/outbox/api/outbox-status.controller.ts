import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { JsonApi } from '../../base/api/json-api.decorators.js';
import {
  GetOutboxStatusAction,
  READ_OUTBOX_STATUS,
} from '../core/actions/get-outbox-status.action.js';
import {
  OutboxStatusDocument,
  toOutboxStatusDocument,
} from './outbox-status.resources.js';

/** `GET /outbox/status` (#619): whether the outbox's consumers read on, for administrators. */
@ApiTags('jobs')
@Controller('outbox')
@JsonApi()
export class OutboxStatusController {
  constructor(private readonly getStatus: GetOutboxStatusAction) {}

  @Get('status')
  @ApiOperation({
    summary: 'Outbox consumers',
    description: `Whether the consumers of the outbox (notifications, webhooks, the change feed) read on. One whose position, or an outbox row, lay past every transaction of this database (restored from another server) is held and delivers nothing, so that nothing is skipped, until the operator runs the recipe in \`backend/api/README.md\`, "Outbox", "After a restore". Names only. Needs the \`${READ_OUTBOX_STATUS}\` permission.`,
  })
  @ApiOkResponse({ standardSchema: OutboxStatusDocument })
  @ApiPermission(READ_OUTBOX_STATUS)
  async status(
    @CurrentActor() actor: Actor,
  ): Promise<z.infer<typeof OutboxStatusDocument>> {
    return toOutboxStatusDocument(await this.getStatus.handle({ actor }));
  }
}
