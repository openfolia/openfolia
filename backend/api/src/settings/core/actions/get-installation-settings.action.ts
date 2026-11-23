import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import type { StoredInstallationSettings } from '../installation-settings.js';
import { InstallationSettingsStore } from '../installation-settings-store.js';

/**
 * The installation's settings (#588), for those who change them (`admin.roles`). The review
 * screen learns the self-approval rule from the change set's `meta.review` instead.
 */
@Injectable()
export class GetInstallationSettingsAction extends ActorAction<
  { readonly actor: Actor },
  StoredInstallationSettings
> {
  readonly policy = 'admin.roles';

  constructor(private readonly store: InstallationSettingsStore) {
    super();
  }

  protected run(): Promise<StoredInstallationSettings> {
    return this.store.read();
  }
}
