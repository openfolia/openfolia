import { Injectable } from '@nestjs/common';
import {
  validateModule,
  type Issue,
  type Module,
} from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';

interface Input {
  actor: Actor;
  snapshot: ReadableContent;
  id: string;
  lang: string;
}

/**
 * One module in one language, with the problems found checking it against
 * the configuration. A module outside the actor's reading scope is not
 * found, exactly as if it did not exist; so is a file that cannot be read,
 * unless the actor may read everything in its language (`ReadableContent`).
 */
@Injectable()
export class GetModuleAction extends ActorAction<
  Input,
  { module: Module; issues: Issue[] }
> {
  readonly policy = 'content.read';

  protected async run({
    snapshot,
    id,
    lang,
  }: Input): Promise<{ module: Module; issues: Issue[] }> {
    const config = await snapshot.config();
    const module = await snapshot.module(id, lang);
    if (!module) throw new NotFoundError(`No module "${id}" in "${lang}".`);
    return { module, issues: validateModule(module, config) };
  }
}
