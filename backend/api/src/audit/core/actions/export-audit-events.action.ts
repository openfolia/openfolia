import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import type { AuditEvent, AuditFilter } from '../audit-event.js';
import {
  type AuditExportFormat,
  describeAuditFilter,
} from '../audit-export.js';
import { AuditLog } from '../audit-log.js';
import { READ_AUDIT_LOG } from './list-audit-events.action.js';

/** What an export of the audit log is recorded as. */
export const AUDIT_EXPORT_EVENT = {
  action: 'audit-log.export',
  subject: { type: 'audit-log', id: 'audit-events' },
} as const;

/**
 * The audit log's events matching a filter, for an export (#379), for an
 * actor allowed to read the log. Before a single event is handed out the
 * export itself is recorded (`audit-log.export`, with the filter and the
 * format) and committed: an export that could not be recorded fails, so
 * nobody takes the log out unseen.
 */
@Injectable()
export class ExportAuditEventsAction extends ActorAction<
  { actor: Actor; filter: AuditFilter; format: AuditExportFormat },
  AsyncIterable<AuditEvent>
> {
  readonly policy = READ_AUDIT_LOG;

  constructor(
    private readonly auditLog: AuditLog,
    private readonly unitOfWork: UnitOfWork,
  ) {
    super();
  }

  protected async run({
    actor,
    filter,
    format,
  }: {
    actor: Actor;
    filter: AuditFilter;
    format: AuditExportFormat;
  }): Promise<AsyncIterable<AuditEvent>> {
    await this.unitOfWork.run((tx) =>
      this.auditLog.record(tx, actor, {
        ...AUDIT_EXPORT_EVENT,
        data: { format, filter: describeAuditFilter(filter) },
      }),
    );
    return this.auditLog.stream(filter);
  }
}
