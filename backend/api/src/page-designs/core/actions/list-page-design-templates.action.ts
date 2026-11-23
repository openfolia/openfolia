import { Injectable } from '@nestjs/common';
import { designTemplatePath } from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../../base/core/paging.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';

/** A page design template (#396): its ID and its entry file. */
export interface PageDesignTemplateEntry {
  readonly id: string;
  readonly path: string;
}

/**
 * One page of the page design templates at the snapshot's commit (#396): every folder
 * `templates/<id>/` with a `manual.typ`, by ID, for a design to name as its `template`. Only the
 * listing is read, never a template's files. Templates carry no audience, as designs: every
 * reader of the commit learns of them.
 */
@Injectable()
export class ListPageDesignTemplatesAction extends ActorAction<
  { actor: Actor; snapshot: ReadableContent; page: PageRequest },
  Paginated<PageDesignTemplateEntry>
> {
  readonly policy = 'content.read';

  protected async run({
    snapshot,
    page,
  }: {
    snapshot: ReadableContent;
    page: PageRequest;
  }): Promise<Paginated<PageDesignTemplateEntry>> {
    const ids = await snapshot.designTemplateIds();
    return paginate(
      ids.map((id) => ({ id, path: designTemplatePath(id) })),
      page,
    );
  }
}
