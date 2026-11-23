import { Injectable } from '@nestjs/common';
import { variantSlug } from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import type { ManualResolution } from '../../../content/core/content.repository.js';
import type {
  ReadableContent,
  ReleaseFacts,
} from '../../../content/core/readable-content.js';
import { refuseTooLarge } from '../too-large.js';

/**
 * A manual assembled for one of the variants its manifest lists and a
 * configured language, with only the modules the actor may see. Anything
 * else is not found, so clients cannot make the server assemble arbitrary
 * combinations; so is a manual the actor may not see, or not in that
 * language (the same answer as for a language not configured). `design`
 * lays it out with that page design in place of its own (#392). One that
 * passes a limit of #679 (`MAX_EXPANDED_NODES`, `MAX_EXPANDED_CHARS`,
 * `MAX_NESTING_DEPTH`) is 422 `expansion-too-large`, so nothing is made of it.
 */
@Injectable()
export class ResolveManualAction extends ActorAction<
  {
    actor: Actor;
    snapshot: ReadableContent;
    id: string;
    variant: string;
    lang: string;
    design?: string;
    release?: ReleaseFacts;
  },
  ManualResolution
> {
  readonly policy = 'content.read';

  protected async run({
    snapshot,
    id,
    variant: slug,
    lang,
    design,
    release,
  }: {
    snapshot: ReadableContent;
    id: string;
    variant: string;
    lang: string;
    design?: string;
    release?: ReleaseFacts;
  }): Promise<ManualResolution> {
    const config = await snapshot.config();
    const manual = await snapshot.manual(id);
    if (!manual) throw new NotFoundError(`No manual "${id}".`);
    const variant = manual.manifest.variants.find(
      (v) => variantSlug(v) === slug,
    );
    if (!variant) {
      throw new NotFoundError(`The manual has no variant "${slug}".`);
    }
    const noLanguage = () =>
      new NotFoundError(`Language "${lang}" is not configured.`);
    const { source, targets } = config.languages;
    if (lang !== source && !targets.includes(lang)) throw noLanguage();
    // The manual is there (checked above): only the language can keep it out.
    const resolution = await snapshot.resolve(id, variant, lang, {
      ...(design !== undefined && { design }),
      ...(release !== undefined && { release }),
    });
    if (!resolution) throw noLanguage();
    refuseTooLarge(resolution);
    return resolution;
  }
}
