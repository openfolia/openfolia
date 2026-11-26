import { effect, inject, Injectable, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { LanguageService } from '@openfolia/ui/i18n';

import { ApiClient, type Schema } from '../api';
import { PreferencesService } from '../tips/preferences.service';
import { browserTimeZone } from './notification-settings-model';

type Preferences = Schema<'PreferencesResource'>;
type Changes = NonNullable<
  Schema<'UpdatePreferencesDocument'>['data']['attributes']['notifications']
>;

/** The languages an email is written in: another interface language leaves it as it is. */
const EMAIL_LANGUAGES = new Set(['en', 'de']);

/**
 * The person's notification settings (#884): read and changed by the Notifications page
 * (`account/notifications`), each change sent at once. It also keeps the language of the
 * person's email to the interface's, and gives a person with no time zone the browser's, so a
 * daily summary comes at their hour in words they read, without opening the page. Started by
 * the shell.
 */
@Injectable({ providedIn: 'root' })
export class NotificationSettingsService {
  private readonly api = inject(ApiClient);
  private readonly preferences = inject(PreferencesService);
  private readonly language = inject(LanguageService);
  /** What the server holds for the person, as this browser last knew it: what syncing compares with. */
  private known: {
    person: string;
    language: string | null;
    timeZone: string | null;
  } | null = null;

  constructor() {
    effect(() => {
      const doc = this.preferences.document();
      const language = this.language.active();
      // A preferences answer without notifications (an older API, a stub): nothing to keep.
      if (!doc || doc.id === 'service' || !doc.attributes.notifications) return;
      untracked(() => void this.sync(doc, language));
    });
  }

  /** The person's preferences as the server has them now. */
  async load(): Promise<Preferences> {
    const doc = await firstValueFrom(this.api.get('/me/preferences'));
    this.remember(doc.data);
    return doc.data;
  }

  /** Sends `changes`; the preferences as they are after it. Throws what the API refused. */
  async change(changes: Changes): Promise<Preferences> {
    const doc = await firstValueFrom(
      this.api.patch(
        '/me/preferences',
        { path: {} as never },
        {
          data: { type: 'Preferences', attributes: { notifications: changes } },
        },
      ),
    );
    this.remember(doc.data);
    return doc.data;
  }

  private remember(doc: Preferences): void {
    this.known = {
      person: doc.id,
      language: doc.attributes.notifications.language,
      timeZone: doc.attributes.notifications.timeZone,
    };
  }

  private async sync(doc: Preferences, language: string): Promise<void> {
    if (this.known?.person !== doc.id) this.remember(doc);
    const known = this.known!;
    const changes: { language?: 'en' | 'de'; timeZone?: string } = {};
    if (EMAIL_LANGUAGES.has(language) && known.language !== language) {
      changes.language = language as 'en' | 'de';
    }
    const zone = browserTimeZone();
    if (known.timeZone === null && zone) changes.timeZone = zone;
    if (Object.keys(changes).length === 0) return;
    // Taken as sent: a failure is tried again on the next read, never in a loop.
    Object.assign(known, changes);
    try {
      await this.change(changes);
    } catch {
      // Not important enough to bother anyone: the next session tries again.
    }
  }
}
