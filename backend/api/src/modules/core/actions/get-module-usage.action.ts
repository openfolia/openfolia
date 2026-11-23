import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import {
  type ModuleUsage,
  ReadableModuleIndex,
} from '../readable-module-index.js';

interface Input {
  actor: Actor;
  snapshot: ReadableContent;
  /** A module the actor may see in `snapshot` (the caller has read it). */
  id: string;
}

/**
 * Where a module is used (FR-19): the manuals including it, directly or
 * through module references, and the modules referring to it, from the
 * module index, counting only what the actor may see.
 */
@Injectable()
export class GetModuleUsageAction extends ActorAction<Input, ModuleUsage> {
  readonly policy = 'content.read';

  constructor(private readonly index: ReadableModuleIndex) {
    super();
  }

  protected async run({ snapshot, id }: Input): Promise<ModuleUsage> {
    return (await this.index.of(snapshot)).usage(id);
  }
}
