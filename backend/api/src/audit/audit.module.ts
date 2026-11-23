import { readFileSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { auditSinkTarget } from '../config/audit-env.js';
import type { Env } from '../config/env.js';
import { ServerRole } from '../config/server-role.js';
import { AuditEventsController } from './api/audit-events.controller.js';
import { AuditExportController } from './api/audit-export.controller.js';
import { AuditSinkConsumer } from './api/audit-sink-consumer.js';
import { ExportAuditEventsAction } from './core/actions/export-audit-events.action.js';
import { ListAuditEventsAction } from './core/actions/list-audit-events.action.js';
import { PruneAuditLogAction } from './core/actions/prune-audit-log.action.js';
import { SendToAuditSinkAction } from './core/actions/send-to-audit-sink.action.js';
import { AuditLog } from './core/audit-log.js';
import {
  AuditSettings,
  AuditSink,
  AuditSinkCursor,
  type SinkResult,
} from './core/audit-sink.js';
import { DrizzleAuditLog } from './repos/drizzle-audit-log.js';
import { DrizzleAuditSinkCursor } from './repos/drizzle-audit-sink-cursor.js';
import { HttpsAuditSink } from './repos/https-audit-sink.js';
import { SyslogAuditSink } from './repos/syslog-audit-sink.js';

/** The sink while none is set: never called (the consumer asks `sinkEnabled` first). */
class NoAuditSink extends AuditSink {
  send(): Promise<SinkResult> {
    return Promise.resolve({ ok: false, error: 'connection' });
  }
}

/**
 * The append-only audit log: `AuditLog` for the components whose actions
 * record what they change (in the change's own transaction, `UnitOfWork`),
 * `GET /audit-events` to read it and `GET /audit-events/export` to take
 * it out as a file, and in the background (#379) the delivery to a sink
 * (`CCMS_AUDIT_SINK_URL`) and retention (`CCMS_AUDIT_KEEP_DAYS`).
 */
@Module({
  controllers: [AuditExportController, AuditEventsController],
  providers: [
    ListAuditEventsAction,
    ExportAuditEventsAction,
    SendToAuditSinkAction,
    PruneAuditLogAction,
    AuditSinkConsumer,
    { provide: AuditLog, useClass: DrizzleAuditLog },
    { provide: AuditSinkCursor, useClass: DrizzleAuditSinkCursor },
    {
      provide: AuditSettings,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): AuditSettings => ({
        sinkEnabled:
          config.get('CCMS_AUDIT_SINK_URL', { infer: true }) !== undefined,
        keepDays: config.get('CCMS_AUDIT_KEEP_DAYS', { infer: true }),
      }),
    },
    {
      provide: AuditSink,
      inject: [ConfigService, ServerRole],
      useFactory: (
        config: ConfigService<Env, true>,
        role: ServerRole,
      ): AuditSink => {
        const value = config.get('CCMS_AUDIT_SINK_URL', { infer: true });
        // Only a `worker` or `all` process sends (#527): an `api` one needs no CA file.
        if (value === undefined || !role.runsBackground)
          return new NoAuditSink();
        // Checked when the settings were read (`checkAuditEnv`).
        const target = auditSinkTarget(value);
        if (typeof target === 'string') {
          throw new Error(`CCMS_AUDIT_SINK_URL ${target}.`);
        }
        const caFile = config.get('CCMS_AUDIT_SINK_CA_FILE', { infer: true });
        // Read once at start: a missing or unreadable file stops the start.
        const ca = caFile === undefined ? undefined : readFileSync(caFile);
        const timeoutMs = config.get('CCMS_AUDIT_SINK_TIMEOUT_MS', {
          infer: true,
        });
        if (target.kind === 'syslog') {
          return new SyslogAuditSink({ ...target, timeoutMs, ca });
        }
        const secret = config.get('CCMS_AUDIT_SINK_SECRET', { infer: true });
        if (secret === undefined) {
          throw new Error(
            'CCMS_AUDIT_SINK_SECRET is required with an https:// CCMS_AUDIT_SINK_URL.',
          );
        }
        return new HttpsAuditSink({ url: target.url, secret, timeoutMs, ca });
      },
    },
  ],
  exports: [AuditLog],
})
export class AuditModule {}
