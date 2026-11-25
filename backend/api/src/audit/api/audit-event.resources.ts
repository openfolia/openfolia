import { z } from 'zod';
import { pagedDocument, resourceObject } from '../../base/api/json-api.js';
import {
  AuditAction,
  AuditActor,
  type AuditEvent,
  type AuditFilter,
  AuditKind,
  SubjectId,
  SubjectType,
} from '../core/audit-event.js';

export const AuditEventAttributes = z
  .object({
    at: z.iso
      .datetime({ offset: true })
      .describe('When the change was made (its transaction began).'),
    kind: AuditKind.describe(
      '`write`: a change. `read` (#877): a request of a service account’s token that changed nothing (`api.read`), one event per request, or reads of one account that could not be recorded one by one (`api.read-gap`, with `data.count`).',
    ),
    actor: AuditActor.describe('Who made it.'),
    action: AuditAction.describe('What happened, e.g. `role.assign`.'),
    subject: z
      .object({ type: SubjectType, id: SubjectId })
      .describe('What it happened to, e.g. `{ type: "role", id: "author" }`.'),
    comment: z.string().nullable().describe('Why, in the actor’s words.'),
    data: z
      .record(z.string(), z.unknown())
      .describe('The change’s details; their shape depends on `action`.'),
  })
  .meta({ id: 'AuditEventAttributes' });

export const AuditEventResource = resourceObject('AuditEvent', {
  attributes: AuditEventAttributes,
})
  .describe(
    '`id` increases in the order events were inserted, which is not always commit order: not a cursor for following the log.',
  )
  .meta({ id: 'AuditEventResource' });

export const AuditEventPageDocument = pagedDocument(AuditEventResource).meta({
  id: 'AuditEventPageDocument',
});

export function toAuditEventResource(
  event: AuditEvent,
): z.infer<typeof AuditEventResource> {
  return {
    type: 'AuditEvent',
    id: event.id,
    attributes: {
      at: event.at.toISOString(),
      kind: event.kind,
      actor: event.actor,
      action: event.action,
      subject: event.subject,
      comment: event.comment,
      data: event.data,
    },
  };
}

/** `<type>` or `<type>/<id>`; the ID may hold "/" itself (a module's does). */
const typeAndId = <H extends string>(
  head: z.ZodType<H, string>,
  id: z.ZodType<string, string>,
  example: string,
) =>
  z
    .string()
    .max(600)
    .regex(/^[^/]+(?:\/.+)?$/, `e.g. "${example}"`)
    .transform((value) => {
      const slash = value.indexOf('/');
      return slash < 0
        ? { head: value, id: undefined }
        : { head: value.slice(0, slash), id: value.slice(slash + 1) };
    })
    .pipe(z.object({ head, id: id.optional() }));

/**
 * A point in time with its offset (`2026-01-31T00:00:00Z`, `…+01:00`), to
 * the millisecond, in years 1 to 9999 (the four-digit years of ISO 8601,
 * as `toISOString` writes them back).
 */
const instant = z.iso
  .datetime({
    offset: true,
    error: 'an ISO 8601 date and time with offset',
  })
  .refine(
    (value) => !/\.\d{4,}/.test(value),
    'at most milliseconds (three digits after the point)',
  )
  .transform((value) => new Date(value))
  .refine((at) => {
    const year = at.getUTCFullYear();
    return year >= 1 && year <= 9999;
  }, 'a time in the years 1 to 9999');

/**
 * Filter parameters of `GET /audit-events` and `GET /audit-events/export`,
 * validated before any query: the same on both, so an export holds what
 * the list pages through.
 */
export const auditFilters = {
  subject: typeAndId(SubjectType, SubjectId, 'module/en/battery-charging'),
  actor: typeAndId(
    AuditActor.shape.kind,
    AuditActor.shape.id,
    'user/sample-author',
  ),
  action: AuditAction,
  kind: AuditKind,
  from: instant,
  to: instant,
};

/** The filters' documentation, for `@Filters(...)`. */
export const AUDIT_FILTER_DOCS = [
  {
    name: 'subject',
    description:
      'Only events about this subject: `<type>` (e.g. `role`) or `<type>/<id>` (e.g. `role/author`, `module/en/battery-charging`).',
  },
  {
    name: 'actor',
    description:
      'Only events by this actor: `<kind>` (`user` or `service`) or `<kind>/<id>` (e.g. `user/sample-author`).',
  },
  { name: 'action', description: 'Only this action, e.g. `role.assign`.' },
  {
    name: 'kind',
    description:
      'Only changes (`write`) or only reads (`read`: a service account’s requests, #877).',
  },
  {
    name: 'from',
    description:
      'Only events at or after this time: ISO 8601 with an offset, e.g. `2026-01-01T00:00:00Z`.',
  },
  {
    name: 'to',
    description:
      'Only events before this time (exclusive): ISO 8601 with an offset, e.g. `2026-02-01T00:00:00Z`.',
  },
];

type Parsed<K extends keyof typeof auditFilters> = z.output<
  (typeof auditFilters)[K]
>;

/** The parsed filter parameters as an `AuditFilter`. */
export function toAuditFilter(params: {
  subject?: Parsed<'subject'>;
  actor?: Parsed<'actor'>;
  action?: string;
  kind?: AuditKind;
  from?: Date;
  to?: Date;
}): AuditFilter {
  const { subject, actor, action, kind, from, to } = params;
  return {
    ...(subject && {
      subject: {
        type: subject.head,
        ...(subject.id !== undefined && { id: subject.id }),
      },
    }),
    ...(actor && {
      actor: {
        kind: actor.head,
        ...(actor.id !== undefined && { id: actor.id }),
      },
    }),
    ...(action !== undefined && { action }),
    ...(kind !== undefined && { kind }),
    ...(from && { from }),
    ...(to && { to }),
  };
}
