import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { ForbiddenError } from '../../../base/core/errors.js';
import { PreferenceStore } from '../preference-store.js';
import type { PreferenceChanges } from '../preferences.js';
import {
  ownerOf,
  type PreferencesView,
  PreferencesViews,
} from './get-preferences.action.js';

/**
 * Changes the actor's own preferences (#222): what is left out stays; `dismissedTips` replaces
 * the list (each ID once, in the order first given; the body holds at most
 * `MAX_DISMISSED_TIPS`); notification settings (#884) change setting by setting, their
 * `choices` kind by kind. A service has no preferences to change.
 * Any person; nobody changes another's.
 */
@Injectable()
export class UpdatePreferencesAction extends ActorAction<
  { readonly actor: Actor; readonly changes: PreferenceChanges },
  PreferencesView
> {
  readonly policy = 'any-actor';

  constructor(
    private readonly store: PreferenceStore,
    private readonly views: PreferencesViews,
  ) {
    super();
  }

  protected async run({
    actor,
    changes,
  }: {
    readonly actor: Actor;
    readonly changes: PreferenceChanges;
  }): Promise<PreferencesView> {
    const owner = ownerOf(actor);
    if (owner === undefined) {
      throw new ForbiddenError('A service has no preferences.');
    }
    const next: PreferenceChanges =
      changes.dismissedTips === undefined
        ? changes
        : { ...changes, dismissedTips: [...new Set(changes.dismissedTips)] };
    if (nothingIn(next)) {
      // Nothing to change: answered as it stands, and nothing is written.
      return this.views.of(owner, await this.store.read(owner));
    }
    const stored = await this.store.write(owner, next);
    // The actor resolved from a user that is gone by now (deleted meanwhile).
    if (!stored) throw new ForbiddenError('No such user.');
    return this.views.of(owner, stored);
  }
}

/** Whether `changes` change nothing (every setting left out, no notification choice given). */
function nothingIn(changes: PreferenceChanges): boolean {
  const { notifications, ...rest } = changes;
  return (
    Object.values(rest).every((value) => value === undefined) &&
    Object.entries(notifications ?? {}).every(
      ([key, value]) =>
        value === undefined ||
        (key === 'choices' && Object.keys(value as object).length === 0),
    )
  );
}
