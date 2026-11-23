import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import { ActorAction } from '../../../access/core/policy.js';
import type { PageRequest, Paginated } from '../../../base/core/paging.js';
import type { AuditEvent, AuditFilter } from '../audit-event.js';
import { AuditLog } from '../audit-log.js';

/**
 * The permission that reads the audit log: `admin.roles`, until the open
 * question on who may read it says otherwise.
 */
export const READ_AUDIT_LOG = 'admin.roles' satisfies Permission;

/** One page of the audit log, newest first, for an actor allowed to read it. */
@Injectable()
export class ListAuditEventsAction extends ActorAction<
  { actor: Actor; filter: AuditFilter; page: PageRequest },
  Paginated<AuditEvent>
> {
  readonly policy = READ_AUDIT_LOG;

  constructor(private readonly auditLog: AuditLog) {
    super();
  }

  protected run({
    filter,
    page,
  }: {
    filter: AuditFilter;
    page: PageRequest;
  }): Promise<Paginated<AuditEvent>> {
    return this.auditLog.list(filter, page);
  }
}
