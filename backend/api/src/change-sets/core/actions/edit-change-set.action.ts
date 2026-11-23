import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import { ConflictError } from '../../../base/core/errors.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { type ChangeSet, OPEN_STATES } from '../change-set.js';
import { type ChangeSetEdit, ChangeSetStore } from '../change-set-store.js';
import { ownChangeSet } from '../working-copy-rules.js';

export interface EditChangeSetInput extends ChangeSetEdit {
  readonly actor: Actor;
  readonly id: string;
  /** The ID the request's resource object names: must be `id`. */
  readonly resourceId?: string;
}

/**
 * Renames an open change set (`draft`, `in-review`, `approved`) or
 * corrects its description (`null` clears it), with a `change-set.edit`
 * audit event holding the old and new title and whether the description
 * changed (not its text), in one
 * transaction holding the change set's row from the check to the change.
 * Only its author, answered for anyone else as abandoning is (403 for a
 * draft reader, else 404 exactly like a missing change set, #125); a
 * change set no longer open is 409 `invalid-state`, and a resource object
 * naming another ID than the path 409 `id-mismatch`. Nothing that differs
 * changes nothing and is not audited.
 */
@Injectable()
export class EditChangeSetAction extends ActorAction<
  EditChangeSetInput,
  ChangeSet
> {
  readonly policy = 'content.edit';

  constructor(
    private readonly store: ChangeSetStore,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected run({
    actor,
    id,
    resourceId,
    title,
    description,
  }: EditChangeSetInput): Promise<ChangeSet> {
    if (resourceId !== undefined && resourceId !== id) {
      return Promise.reject(
        new ConflictError(
          'id-mismatch',
          'The resource object’s `id` is not the change set in the path.',
        ),
      );
    }
    return this.unit.run(async (tx) => {
      const found = ownChangeSet(
        await this.store.lock(tx, id),
        actor,
        id,
        'Only its author may edit a change set.',
      );
      if (!OPEN_STATES.includes(found.state)) {
        throw new ConflictError(
          'invalid-state',
          `The change set is ${found.state}; only an open one can be edited.`,
          { state: found.state },
        );
      }
      const change: { title?: string; description?: string | null } = {};
      if (title !== undefined && title !== found.title) change.title = title;
      if (description !== undefined && description !== found.description) {
        change.description = description;
      }
      if (Object.keys(change).length === 0) return found;
      const edited = await this.store.edit(tx, id, change);
      // The description is free text the append-only log would keep for
      // good, as `change-set.create` keeps none: only that it changed.
      const retitled = change.title !== undefined;
      await this.auditLog.record(tx, actor, {
        action: 'change-set.edit',
        subject: { type: 'change-set', id },
        data: {
          from: retitled ? { title: found.title } : {},
          to: retitled ? { title: change.title } : {},
          descriptionChanged: 'description' in change,
        },
      });
      return edited;
    }, BOUNDED);
  }
}
