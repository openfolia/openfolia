import { csvCell } from '@openfolia/content-model';
import type { AuditEvent, AuditFilter } from './audit-event.js';

/** The formats the audit log exports to. */
export const AUDIT_EXPORT_FORMATS = ['csv', 'jsonl'] as const;
export type AuditExportFormat = (typeof AUDIT_EXPORT_FORMATS)[number];

/** The columns of the CSV export, in order. */
export const AUDIT_CSV_COLUMNS = [
  'id',
  'at',
  'actor kind',
  'actor id',
  'action',
  'subject type',
  'subject id',
  'comment',
  'data',
] as const;

/** One CSV line: the cells through `csvCell` (the shared formula guard), ending in CRLF. */
function csvLine(cells: readonly string[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

/** The CSV export's header line. */
export function auditCsvHeader(): string {
  return csvLine(AUDIT_CSV_COLUMNS);
}

/**
 * One event as a CSV line (RFC 4180, CRLF): `at` in ISO 8601 UTC, no
 * comment as an empty cell, `data` as JSON text. A value a spreadsheet
 * would run as a formula starts with `'`.
 */
export function auditCsvLine(event: AuditEvent): string {
  return csvLine([
    event.id,
    event.at.toISOString(),
    event.actor.kind,
    event.actor.id,
    event.action,
    event.subject.type,
    event.subject.id,
    event.comment ?? '',
    JSON.stringify(event.data),
  ]);
}

/**
 * One event as the JSON exports and the sink carry it: the members
 * `GET /audit-events` gives its attributes, after its `id`.
 */
export function auditEventJson(event: AuditEvent): Record<string, unknown> {
  return {
    id: event.id,
    at: event.at.toISOString(),
    actor: event.actor,
    action: event.action,
    subject: event.subject,
    comment: event.comment,
    data: event.data,
  };
}

/**
 * JSON text with U+2028 and U+2029 escaped too (JSON escapes `\n` and `\r`
 * inside a string already), for readers that split lines on them, so it
 * is always one line.
 */
export function oneLineJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

/** One event as a JSON Lines line (`auditEventJson`, `oneLineJson`). */
export function auditJsonLine(event: AuditEvent): string {
  return `${oneLineJson(auditEventJson(event))}\n`;
}

/**
 * A filter as the `audit-log.export` event records it: the query values
 * it was given (`<type>/<id>`, `<kind>/<id>`, ISO times), only those set.
 */
export function describeAuditFilter(
  filter: AuditFilter,
): Record<string, string> {
  const { subject, actor, action, from, to } = filter;
  return {
    ...(subject && {
      subject:
        subject.id === undefined
          ? subject.type
          : `${subject.type}/${subject.id}`,
    }),
    ...(actor && {
      actor: actor.id === undefined ? actor.kind : `${actor.kind}/${actor.id}`,
    }),
    ...(action !== undefined && { action }),
    ...(from && { from: from.toISOString() }),
    ...(to && { to: to.toISOString() }),
  };
}
