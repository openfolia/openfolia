import { Injectable } from '@nestjs/common';
import type { VariantValues } from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../../base/core/paging.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { ResolveManualAction } from '../../../manuals/core/actions/resolve-manual.action.js';
import { hiddenItems, type HiddenItem } from '../hidden-content.js';
import { resolveModuleFor } from './preview-module.action.js';

export interface HiddenPage extends Paginated<HiddenItem> {
  /** The commit read. */
  commit: string;
}

/**
 * What a module's variant blocks leave out for a variant: the companion of
 * its HTML preview (`PreviewModuleAction`), resolved the same way, so a
 * module the actor may not see is not found exactly as there.
 */
@Injectable()
export class ListHiddenModuleContentAction extends ActorAction<
  {
    actor: Actor;
    snapshot: ReadableContent;
    id: string;
    lang: string;
    /** None: no attribute is set. */
    variant?: VariantValues;
    page: PageRequest;
  },
  HiddenPage
> {
  readonly policy = 'content.read';

  protected async run({
    snapshot,
    id,
    lang,
    variant = {},
    page,
  }: {
    snapshot: ReadableContent;
    id: string;
    lang: string;
    variant?: VariantValues;
    page: PageRequest;
  }): Promise<HiddenPage> {
    const resolution = await resolveModuleFor(snapshot, id, lang, variant);
    return {
      ...paginate(hiddenItems(resolution.hidden), page),
      commit: snapshot.commit,
    };
  }
}

/**
 * What a manual's conditions leave out for one of its published variants:
 * the companion of its HTML preview and PDF, resolved exactly as they are
 * (`ResolveManualAction`), so it lists only what the actor could read.
 */
@Injectable()
export class ListHiddenManualContentAction extends ActorAction<
  {
    actor: Actor;
    snapshot: ReadableContent;
    id: string;
    variant: string;
    lang: string;
    page: PageRequest;
  },
  HiddenPage
> {
  readonly policy = 'content.read';

  constructor(private readonly resolveManual: ResolveManualAction) {
    super();
  }

  protected async run(input: {
    actor: Actor;
    snapshot: ReadableContent;
    id: string;
    variant: string;
    lang: string;
    page: PageRequest;
  }): Promise<HiddenPage> {
    const resolution = await this.resolveManual.handle(input);
    return {
      ...paginate(hiddenItems(resolution.hidden), input.page),
      commit: input.snapshot.commit,
    };
  }
}
