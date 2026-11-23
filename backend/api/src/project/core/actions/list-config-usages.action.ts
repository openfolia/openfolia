import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../../base/core/paging.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import {
  countConfigUsages,
  type ConfigValueUsage,
} from '../config-usage-counts.js';

/**
 * One page of the configured values (languages, module types, audiences,
 * facets and their values, variant attributes and their values, text
 * attributes, safety symbols), in the configuration's order, each with how
 * many modules and manuals name it: what the project settings show next to
 * a value. Counted on what the actor may read (a module or manual outside
 * their scope is not counted); unreadable files are left out.
 */
@Injectable()
export class ListConfigUsagesAction extends ActorAction<
  { actor: Actor; snapshot: ReadableContent; page: PageRequest },
  Paginated<ConfigValueUsage>
> {
  readonly policy = 'content.read';

  protected async run({
    snapshot,
    page,
  }: {
    snapshot: ReadableContent;
    page: PageRequest;
  }): Promise<Paginated<ConfigValueUsage>> {
    const [config, modules, manuals] = await Promise.all([
      snapshot.config(),
      snapshot.modules(),
      snapshot.manuals(),
    ]);
    return paginate(
      countConfigUsages(
        config,
        modules.flatMap((m) => ('module' in m ? [m.module] : [])),
        manuals.flatMap((m) => ('manifest' in m ? [m.manifest] : [])),
      ),
      page,
    );
  }
}
