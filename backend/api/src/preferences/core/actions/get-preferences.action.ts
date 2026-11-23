import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { PreferenceStore } from '../preference-store.js';
import { DEFAULT_PREFERENCES, type StoredPreferences } from '../preferences.js';

/**
 * Whose preferences `actor` reads and changes: their own, as a user. A service (the API token, a
 * service account) has none.
 */
export function ownerOf(actor: Actor): string | undefined {
  return actor.kind === 'user' ? actor.id : undefined;
}

/**
 * The actor's own preferences (#222); the defaults while they changed none. A service has none
 * stored and reads the defaults. Any actor; nobody reads another's.
 */
@Injectable()
export class GetPreferencesAction extends ActorAction<
  { readonly actor: Actor },
  StoredPreferences
> {
  readonly policy = 'any-actor';

  constructor(private readonly store: PreferenceStore) {
    super();
  }

  protected async run({
    actor,
  }: {
    readonly actor: Actor;
  }): Promise<StoredPreferences> {
    const owner = ownerOf(actor);
    if (owner === undefined) {
      return { preferences: DEFAULT_PREFERENCES, updatedAt: null };
    }
    return this.store.read(owner);
  }
}
