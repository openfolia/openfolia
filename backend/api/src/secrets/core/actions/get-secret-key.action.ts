import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import { ActorAction } from '../../../access/core/policy.js';
import { InstanceSecretKey } from '../instance-secret-key.js';
import type { SecretKeyOrigin } from '../secret-key.js';
import { SecretKeySettings } from '../secret-key-ports.js';

/** Who reads where the key is: administrators (`admin.roles`), as for the storage used. */
export const READ_SECRET_KEY = 'admin.roles' satisfies Permission;

export interface SecretKeyReport {
  readonly origin: SecretKeyOrigin;
  /** Whether the server makes the key file when there is none. */
  readonly generate: boolean;
}

/**
 * Where the instance secret key comes from (#470), for Admin → System:
 * the key file (and its path), a variable, or none. Never the key.
 */
@Injectable()
export class GetSecretKeyAction extends ActorAction<
  { actor: Actor },
  SecretKeyReport
> {
  readonly policy = READ_SECRET_KEY;

  constructor(
    private readonly key: InstanceSecretKey,
    private readonly settings: SecretKeySettings,
  ) {
    super();
  }

  protected async run(): Promise<SecretKeyReport> {
    return { origin: this.key.origin, generate: this.settings.generate };
  }
}
