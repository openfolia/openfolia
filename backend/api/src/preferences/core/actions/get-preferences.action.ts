import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { UserDirectory } from '../../../access/core/user-directory.js';
import { isMailAddress } from '../../../mail/core/mail.js';
import { MailOutbox } from '../../../mail/core/mail-outbox.js';
import { NotificationEmailOptions } from '../notification-email-options.js';
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
 * Why notification emails cannot reach the person (#884): the installation sends no email
 * (`off`, `no-secret-key`), has no public URL to link to (`no-public-url`), or the person has no
 * address (`no-address`); null when they can.
 */
export type EmailUnavailable =
  | 'off'
  | 'no-secret-key'
  | 'no-public-url'
  | 'no-address';

/** The preferences with what the settings page needs to know beside them. */
export interface PreferencesView extends StoredPreferences {
  readonly email: { readonly unavailable: EmailUnavailable | null };
  /** The summary's hour for someone who chose none (`CCMS_NOTIFICATIONS_DIGEST_HOUR`). */
  readonly defaultDigestHour: number;
}

/** Reads what `PreferencesView` adds to a person's preferences. */
@Injectable()
export class PreferencesViews {
  constructor(
    private readonly mail: MailOutbox,
    private readonly users: UserDirectory,
    private readonly options: NotificationEmailOptions,
  ) {}

  async of(
    owner: string | undefined,
    stored: StoredPreferences,
  ): Promise<PreferencesView> {
    let unavailable: EmailUnavailable | null = this.mail.linksUnavailable;
    if (unavailable === null) {
      const email =
        owner === undefined
          ? null
          : ((await this.users.findUser(owner))?.email ?? null);
      if (email === null || !isMailAddress(email)) unavailable = 'no-address';
    }
    return {
      ...stored,
      email: { unavailable },
      defaultDigestHour: this.options.digestHour,
    };
  }
}

/**
 * The actor's own preferences (#222, #884); the defaults while they changed none, with whether
 * email can reach them. A service has none stored and reads the defaults. Any actor; nobody
 * reads another's.
 */
@Injectable()
export class GetPreferencesAction extends ActorAction<
  { readonly actor: Actor },
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
  }: {
    readonly actor: Actor;
  }): Promise<PreferencesView> {
    const owner = ownerOf(actor);
    const stored =
      owner === undefined
        ? { preferences: DEFAULT_PREFERENCES, updatedAt: null }
        : await this.store.read(owner);
    return this.views.of(owner, stored);
  }
}
