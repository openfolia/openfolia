import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotConfiguredError } from '../../../base/core/errors.js';
import { Sandbox, type SandboxStatus } from '../sandbox.js';

interface Input {
  readonly actor: Actor;
}

/**
 * The public sandbox's status (#826): its caps, what is used of them and when it ends, for the
 * editor's banner. 404 `not-configured` when the instance is no sandbox, which is how a client
 * learns it is not. Any actor: reading it does not count as activity.
 */
@Injectable()
export class GetSandboxAction extends ActorAction<Input, SandboxStatus> {
  readonly policy = 'any-actor';

  constructor(private readonly sandbox: Sandbox) {
    super();
  }

  protected run(): Promise<SandboxStatus> {
    const status = this.sandbox.status();
    if (status === undefined) {
      throw new NotConfiguredError('This instance is no public sandbox.');
    }
    return Promise.resolve(status);
  }
}
