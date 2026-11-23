import { Injectable } from '@nestjs/common';
import type { Manifest } from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import {
  DesignsInUse,
  type DesignInUse,
} from '../../../content/core/design-in-use.js';
import type {
  ManualIssue,
  ReadableContent,
} from '../../../content/core/readable-content.js';
import { summarizeVariants, type VariantSummary } from '../variants.js';

/**
 * A manual definition: its manifest, published variants, problems and the
 * page design it is printed with (`DesignsInUse`, #589), naming
 * only the modules the actor may see. One the actor may not see is not
 * found, exactly as if it did not exist.
 */
@Injectable()
export class GetManualAction extends ActorAction<
  { actor: Actor; snapshot: ReadableContent; id: string },
  {
    manifest: Manifest;
    variants: VariantSummary[];
    issues: ManualIssue[];
    design: DesignInUse;
  }
> {
  readonly policy = 'content.read';

  protected async run({
    snapshot,
    id,
  }: {
    snapshot: ReadableContent;
    id: string;
  }): Promise<{
    manifest: Manifest;
    variants: VariantSummary[];
    issues: ManualIssue[];
    design: DesignInUse;
  }> {
    const config = await snapshot.config();
    const manual = await snapshot.manual(id);
    if (!manual) throw new NotFoundError(`No manual "${id}".`);
    return {
      ...manual,
      variants: summarizeVariants(manual.manifest, config),
      design: await new DesignsInUse(snapshot).of(manual.manifest, config),
    };
  }
}
