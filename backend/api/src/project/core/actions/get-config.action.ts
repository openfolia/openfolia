import { Injectable } from '@nestjs/common';
import type { ProjectConfig } from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';

/** The project configuration (`openfolia.yaml`). */
@Injectable()
export class GetConfigAction extends ActorAction<
  { actor: Actor; snapshot: ReadableContent },
  ProjectConfig
> {
  readonly policy = 'content.read';

  protected run({
    snapshot,
  }: {
    snapshot: ReadableContent;
  }): Promise<ProjectConfig> {
    return snapshot.config();
  }
}
