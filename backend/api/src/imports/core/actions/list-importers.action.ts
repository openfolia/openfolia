import { Inject, Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  type PageRequest,
  type Paginated,
  paginate,
} from '../../../base/core/paging.js';
import { type Importer, ImporterRegistry } from '../importer.js';

/** The installed importers, by ID, paged (`admin.roles`: importing is an administrator's). */
@Injectable()
export class ListImportersAction extends ActorAction<
  { readonly actor: Actor; readonly page: PageRequest },
  Paginated<Importer>
> {
  readonly policy = 'admin.roles';

  constructor(
    @Inject(ImporterRegistry) private readonly registry: ImporterRegistry,
  ) {
    super();
  }

  protected async run({ page }: { page: PageRequest }) {
    return paginate(this.registry.list(), page);
  }
}
