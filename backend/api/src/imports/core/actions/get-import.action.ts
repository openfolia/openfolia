import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import { type ImportRecord, isImportId } from '../import.js';
import { ImportStore } from '../import-store.js';

/** Whether `actor` is the one who uploaded `record`. */
export const importedBy = (record: ImportRecord, actor: Actor): boolean =>
  record.createdBy.kind === actor.kind && record.createdBy.id === actor.id;

/**
 * The stored import, for the one who uploaded it; anyone else's, a
 * removed one and an ID that names none (malformed or not) are 404 alike.
 */
export async function ownImport(
  store: ImportStore,
  actor: Actor,
  id: string,
): Promise<ImportRecord> {
  const record = isImportId(id) ? await store.find(id) : undefined;
  if (!record || !importedBy(record, actor)) {
    throw new NotFoundError(`No import "${id}".`);
  }
  return record;
}

/** One import with its report and its job's progress (`admin.roles`; only its own). */
@Injectable()
export class GetImportAction extends ActorAction<
  { readonly actor: Actor; readonly id: string },
  ImportRecord
> {
  readonly policy = 'admin.roles';

  constructor(private readonly store: ImportStore) {
    super();
  }

  protected run({ actor, id }: { actor: Actor; id: string }) {
    return ownImport(this.store, actor, id);
  }
}
