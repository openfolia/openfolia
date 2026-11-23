import { ConfigKey } from '@openfolia/content-model';
import { z } from 'zod';
import type { AuditActionName } from './audit-actions.js';

/** Postgres refuses U+0000 in `text` and `jsonb`: refused here, by name. */
const NUL = '\u0000';
const noNul = (s: string) => !s.includes(NUL);
const NO_NUL = 'must not contain U+0000';

/** Text Postgres can store: no U+0000. */
const text = () => z.string().refine(noNul, NO_NUL);

/**
 * What happened, as `<subject>.<verb>` in lowercase keys, e.g.
 * `role.assign` or `change-set.approve`. Each action that writes the log
 * names its own; the list grows with them.
 */
export const AuditAction = z
  .string()
  .max(100)
  .regex(
    /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/,
    'lowercase keys joined by ".", e.g. "role.assign"',
  );
export type AuditAction = z.infer<typeof AuditAction>;

/** The kind of thing an event is about, e.g. `role`, `module`, `change-set`. */
export const SubjectType = ConfigKey;

/** Its ID, as the API names it (a module's is `<lang>/<moduleId>`). */
export const SubjectId = text().min(1).max(500);

/** Who acted: the actor's kind and ID only, never its roles or a credential. */
export const AuditActor = z.strictObject({
  kind: z.enum(['user', 'service']),
  id: text().min(1).max(200),
});
export type AuditActor = z.infer<typeof AuditActor>;

/** At most this many UTF-16 code units of `data`, serialized as JSON. */
export const MAX_DATA_LENGTH = 64 * 1024;

/**
 * What `z.json()` would change or Postgres refuse, found in the raw value
 * before parsing: an own `__proto__` key (parsing drops it silently,
 * changing the record) or U+0000 in a key or string. Undefined when none.
 */
function unstorable(value: unknown, depth = 0): string | undefined {
  if (depth > 100) return 'nested too deeply';
  if (typeof value === 'string') return noNul(value) ? undefined : NO_NUL;
  if (typeof value !== 'object' || value === null) return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (!noNul(key)) return `a key ${NO_NUL}`;
    const problem = unstorable(item, depth + 1);
    if (problem) return problem;
  }
  if (!Array.isArray(value) && Object.hasOwn(value, '__proto__')) {
    return '"__proto__" is not allowed as a key';
  }
  return undefined;
}

/** A JSON object, stored exactly as given. */
const JsonObject = z
  .custom<Record<string, unknown>>()
  .superRefine((value, ctx) => {
    const problem = unstorable(value);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  })
  .pipe(z.record(z.string(), z.json()))
  .refine(
    (data) => JSON.stringify(data).length <= MAX_DATA_LENGTH,
    `at most ${MAX_DATA_LENGTH} characters as JSON`,
  );

/**
 * What an action records about one change (the actor comes separately,
 * from the request). `data` holds the change's details for later reading
 * (e.g. `{ "from": "draft", "to": "review" }`): never a token, a password or
 * personal data beyond IDs.
 */
export const NewAuditEvent = z.strictObject({
  action: AuditAction,
  subject: z.strictObject({ type: SubjectType, id: SubjectId }),
  /** Why, in the actor's words (e.g. a review comment). */
  comment: text().min(1).max(10_000).optional(),
  data: JsonObject.optional(),
});
/** Its `action` one of the catalogue's (`AUDIT_ACTIONS`): a new action is listed there first. */
export type NewAuditEvent = Omit<z.input<typeof NewAuditEvent>, 'action'> & {
  action: AuditActionName;
};

/** An event checked and ready to append. */
export interface CheckedAuditEvent {
  readonly actor: AuditActor;
  readonly action: string;
  readonly subject: { readonly type: string; readonly id: string };
  readonly comment: string | null;
  readonly data: Readonly<Record<string, unknown>>;
}

/** An event as recorded: never changed or removed afterwards. */
export interface AuditEvent extends CheckedAuditEvent {
  /**
   * Increasing in the order events were inserted (not committed: a
   * transaction that commits later may hold a smaller one), so not a
   * cursor for following the log.
   */
  readonly id: string;
  /** When the transaction that recorded it started. */
  readonly at: Date;
}

/**
 * Which events to list or export; every field optional. `subject.id` and
 * `actor.id` narrow within their type or kind; `from` and `to` bound `at`
 * (from inclusive, to exclusive).
 */
export interface AuditFilter {
  readonly subject?: { readonly type: string; readonly id?: string };
  readonly actor?: { readonly kind: AuditActor['kind']; readonly id?: string };
  readonly action?: string;
  /** Only events at or after this time. */
  readonly from?: Date;
  /** Only events before this time. */
  readonly to?: Date;
}

/** Whether `event` is one `filter` selects: the one rule every adapter follows. */
export function matchesAuditFilter(
  event: AuditEvent,
  { subject, actor, action, from, to }: AuditFilter,
): boolean {
  return (
    (!subject ||
      (event.subject.type === subject.type &&
        (subject.id === undefined || event.subject.id === subject.id))) &&
    (!actor ||
      (event.actor.kind === actor.kind &&
        (actor.id === undefined || event.actor.id === actor.id))) &&
    (action === undefined || event.action === action) &&
    (from === undefined || event.at.getTime() >= from.getTime()) &&
    (to === undefined || event.at.getTime() < to.getTime())
  );
}
