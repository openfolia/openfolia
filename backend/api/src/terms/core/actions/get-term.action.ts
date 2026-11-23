import { Injectable } from '@nestjs/common';
import { validateTerm, type Issue, type Term } from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import {
  MAX_USED_IN,
  ReadableModuleIndex,
  type TermUsage,
} from '../../../modules/core/readable-module-index.js';

/**
 * One term, with the problems found checking it against the configuration
 * and where it is linked (#245): the module files the reader may see whose
 * term links name it (at most `MAX_USED_IN` named, all counted), from the
 * module index. Not found when there is no such file; a file that is no
 * term is `invalid-content`, as for every content read. Every reader of
 * the commit reads it.
 */
@Injectable()
export class GetTermAction extends ActorAction<
  { actor: Actor; snapshot: ReadableContent; id: string },
  { term: Term; issues: Issue[]; usage: TermUsage }
> {
  readonly policy = 'content.read';

  constructor(private readonly index: ReadableModuleIndex) {
    super();
  }

  protected async run({
    snapshot,
    id,
  }: {
    snapshot: ReadableContent;
    id: string;
  }): Promise<{ term: Term; issues: Issue[]; usage: TermUsage }> {
    const [term, config] = await Promise.all([
      snapshot.term(id),
      snapshot.config(),
    ]);
    if (!term) throw new NotFoundError(`No term "${id}".`);
    const { modules, uses } = (await this.index.of(snapshot)).termUsage(id);
    return {
      term,
      issues: validateTerm(term, config),
      usage: { modules, uses: uses.slice(0, MAX_USED_IN) },
    };
  }
}
