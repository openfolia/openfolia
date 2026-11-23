import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import type { PageRequest, Paginated } from '../../../base/core/paging.js';
import { type StoredFile, StorageUsage } from '../storage-usage.js';
import { READ_STORAGE_USAGE } from './get-storage-usage.action.js';

/**
 * The uploaded files, largest first (#404), for the admin view's list
 * of what takes the most room. Administrators only: it names files of
 * every change set, as the audit log's upload events do.
 */
@Injectable()
export class ListStoredFilesAction extends ActorAction<
  { actor: Actor; page: PageRequest },
  Paginated<StoredFile>
> {
  readonly policy = READ_STORAGE_USAGE;

  constructor(private readonly usage: StorageUsage) {
    super();
  }

  protected run({
    page,
  }: {
    page: PageRequest;
  }): Promise<Paginated<StoredFile>> {
    return this.usage.largestFiles(page);
  }
}
