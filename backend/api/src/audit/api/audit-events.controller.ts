import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  Filters,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { toPagedDocument } from '../../base/api/json-api.js';
import type { AuditKind } from '../core/audit-event.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  ListAuditEventsAction,
  READ_AUDIT_LOG,
} from '../core/actions/list-audit-events.action.js';
import {
  AUDIT_FILTER_DOCS,
  auditFilters,
  AuditEventPageDocument,
  toAuditEventResource,
  toAuditFilter,
} from './audit-event.resources.js';

type Parsed<K extends keyof typeof auditFilters> = z.output<
  (typeof auditFilters)[K]
>;

@ApiTags('audit')
@Controller('audit-events')
@JsonApi()
export class AuditEventsController {
  constructor(private readonly listAuditEvents: ListAuditEventsAction) {}

  @Get()
  @Paged()
  @Filters(...AUDIT_FILTER_DOCS)
  @ApiOperation({
    summary: 'List audit events',
    description: `The append-only audit log, newest first: who changed what, when, and why, and (kind \`read\`, #877) which service account read what over the API. \`GET /audit-events/export\` downloads every event the same filters select. Needs the \`${READ_AUDIT_LOG}\` permission.`,
  })
  @ApiOkResponse({ standardSchema: AuditEventPageDocument })
  @ApiPermission(READ_AUDIT_LOG)
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
    @Query('filter[subject]', { schema: auditFilters.subject.optional() })
    subject?: Parsed<'subject'>,
    @Query('filter[actor]', { schema: auditFilters.actor.optional() })
    by?: Parsed<'actor'>,
    @Query('filter[action]', { schema: auditFilters.action.optional() })
    action?: string,
    @Query('filter[kind]', { schema: auditFilters.kind.optional() })
    kind?: AuditKind,
    @Query('filter[from]', { schema: auditFilters.from.optional() })
    from?: Date,
    @Query('filter[to]', { schema: auditFilters.to.optional() })
    to?: Date,
  ): Promise<z.infer<typeof AuditEventPageDocument>> {
    const result = await this.listAuditEvents.handle({
      actor,
      page,
      filter: toAuditFilter({ subject, actor: by, action, kind, from, to }),
    });
    return toPagedDocument(req, page, result, toAuditEventResource);
  }
}
