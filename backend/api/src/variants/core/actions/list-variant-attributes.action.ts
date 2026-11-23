import { Injectable } from '@nestjs/common';
import type { VariantAttribute } from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../../base/core/paging.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';

/**
 * One page of the configured variant attributes (`openfolia.yaml`), in their
 * configured order, each with its values (enum attributes): what a variant
 * picker offers.
 */
@Injectable()
export class ListVariantAttributesAction extends ActorAction<
  { actor: Actor; snapshot: ReadableContent; page: PageRequest },
  Paginated<VariantAttribute>
> {
  readonly policy = 'content.read';

  protected async run({
    snapshot,
    page,
  }: {
    snapshot: ReadableContent;
    page: PageRequest;
  }): Promise<Paginated<VariantAttribute>> {
    const config = await snapshot.config();
    return paginate(config.variantAttributes, page);
  }
}
