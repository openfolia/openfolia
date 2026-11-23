import { z } from 'zod';
import {
  pagedDocument,
  resourceObject,
  singleDocument,
  toOne,
} from '../../base/api/json-api.js';
import { ChangeSetDescription, hasControl } from '../core/change-set.js';
import { type Lock, LockSubject, parseSubject } from '../core/lock.js';

/** A lock's subject as the API writes it (requests and responses alike). */
export const SubjectSchema = LockSubject.describe(
  'A module in one language (`{ type: "module", lang, moduleId }`), a manual, by its manifest (`{ type: "manual", manualId }`), the configuration (`{ type: "config" }`, `openfolia.yaml`) or a term (`{ type: "term", termId }`, `terms/<termId>.yaml`). It need not exist yet.',
).meta({ id: 'LockSubject' });

export const LockAttributes = z
  .object({
    subject: SubjectSchema,
    holder: z
      .object({ kind: z.enum(['user', 'service']), id: z.string() })
      .describe('Who took it.'),
    since: z.iso.datetime({ offset: true }).describe('When it was taken.'),
  })
  .meta({ id: 'LockAttributes' });

export const LockResource = resourceObject('Lock', {
  attributes: LockAttributes,
  relationships: z.object({ changeSet: toOne('ChangeSet') }),
}).meta({ id: 'LockResource' });

export const LockDocument = singleDocument(LockResource).meta({
  id: 'LockDocument',
});

export const LockPageDocument = pagedDocument(LockResource).meta({
  id: 'LockPageDocument',
});

export function toLockResource(lock: Lock): z.infer<typeof LockResource> {
  return {
    type: 'Lock',
    id: lock.id,
    attributes: {
      subject: lock.subject,
      holder: lock.holder,
      since: lock.since.toISOString(),
    },
    relationships: {
      changeSet: { data: { type: 'ChangeSet', id: lock.changeSetId } },
    },
  };
}

/** `POST /change-sets/{changeSetId}/locks`: the subject to lock. */
export const AcquireLockDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('Lock'),
      attributes: z.strictObject({ subject: SubjectSchema }),
    }),
  })
  .meta({ id: 'AcquireLockDocument' });
export type AcquireLockDocument = z.output<typeof AcquireLockDocument>;

/** `POST /locks/{lockId}/break`: why, required. */
export const BreakLockDocument = z
  .strictObject({
    meta: z.strictObject({
      comment: ChangeSetDescription.describe(
        'Why the lock is broken, recorded in the audit log. Required.',
      ),
    }),
  })
  .meta({ id: 'BreakLockDocument' });
export type BreakLockDocument = z.output<typeof BreakLockDocument>;

const holderId = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => !hasControl(s), 'no control characters');

/** `POST /locks/break`: why (required) and whose locks: exactly one of a change set or a holder. */
export const BreakLocksDocument = z
  .strictObject({
    meta: z
      .strictObject({
        comment: ChangeSetDescription.describe(
          'Why the locks are broken, recorded on each lock’s audit event. Required.',
        ),
        changeSet: z
          .uuid()
          .optional()
          .describe('Break every lock of this change set (its ID).'),
        holder: z
          .strictObject({
            kind: z.enum(['user', 'service']),
            id: holderId,
          })
          .optional()
          .describe('Break every lock this user or service holds.'),
      })
      .refine((m) => (m.changeSet === undefined) !== (m.holder === undefined), {
        message: 'give exactly one of `changeSet` and `holder`',
      }),
  })
  .meta({ id: 'BreakLocksDocument' });
export type BreakLocksDocument = z.output<typeof BreakLocksDocument>;

/** The answer of `POST /locks/break`: how many locks were broken. */
export const BreakLocksResultDocument = z
  .strictObject({
    meta: z.strictObject({
      count: z.int().min(0).describe('How many locks were broken.'),
    }),
  })
  .meta({ id: 'BreakLocksResultDocument' });

/** Filter parameters of `GET /locks`, validated before any query. */
export const lockFilters = {
  // A user's ID or a service's (which no user ID can look like).
  holder: z
    .string()
    .min(1)
    .max(200)
    .refine((s) => !hasControl(s), 'no control characters'),
  changeSet: z.uuid(),
  subject: z
    .string()
    .max(300)
    .transform((text, ctx) => {
      const subject = parseSubject(text);
      if (!subject) {
        ctx.addIssue({
          code: 'custom',
          message:
            '`module/<lang>/<moduleId>`, `manual/<manualId>`, `config` or `term/<termId>`, e.g. `module/en/battery-charging`',
        });
        return z.NEVER;
      }
      return subject;
    }),
};
