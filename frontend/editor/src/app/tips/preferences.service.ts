import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiClient, type Schema } from '../api';
import { isUnconfirmed, MeService } from '../permissions/me';
import { readStored, writeStored } from '../session/stored';

/** The person's tip preferences, as `GET /me/preferences` has them. */
export interface TipPreferences {
  readonly showTips: boolean;
  readonly dismissedTips: readonly string[];
  readonly tourDone: boolean;
}

/** Where the preferences stand: read from the API, kept in this browser only (the API could not be read), or not yet. */
export type PreferencesStatus = 'pending' | 'ready' | 'local';

const DEFAULTS: TipPreferences = {
  showTips: true,
  dismissedTips: [],
  tourDone: false,
};

/** The browser's copy, per person: the fallback while the API cannot be read. */
const storageKey = (person: string) => `openfolia.tips:${person}`;

/** What the API accepts as a tip ID, and as many as it keeps: a stored copy is held to it. */
const TIP_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const MAX_DISMISSED = 500;

/** A stored copy read back, each value checked; anything else is the defaults. */
export function parseStored(text: string | null): TipPreferences | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return null;
    const { showTips, dismissedTips, tourDone } = value as Record<
      string,
      unknown
    >;
    return {
      showTips: typeof showTips === 'boolean' ? showTips : DEFAULTS.showTips,
      dismissedTips: Array.isArray(dismissedTips)
        ? dismissedTips
            .filter(
              (id): id is string =>
                typeof id === 'string' && id.length <= 100 && TIP_ID.test(id),
            )
            .slice(0, MAX_DISMISSED)
        : [],
      tourDone: typeof tourDone === 'boolean' ? tourDone : DEFAULTS.tourDone,
    };
  } catch {
    return null;
  }
}

const fromDocument = (doc: Schema<'PreferencesDocument'>): TipPreferences => ({
  showTips: doc.data.attributes.showTips,
  dismissedTips: doc.data.attributes.dismissedTips,
  tourDone: doc.data.attributes.tourDone,
});

/**
 * The person's own tip preferences (#222): "Show tips", the tips they dismissed and whether they
 * finished the tour, kept on the server (`/me/preferences`) so they follow the person from browser
 * to browser. A change shows at once and is sent after, one at a time in order. The browser keeps a
 * copy per person: what is used while the API cannot be read, and where a change that could not
 * be sent is kept. Read again for each person `GET /me` names.
 */
@Injectable({ providedIn: 'root' })
export class PreferencesService {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService).me;

  private readonly state = signal<TipPreferences>(DEFAULTS);
  private readonly loadStatus = signal<PreferencesStatus>('pending');
  /** The person the state is for; a reply for another is dropped. */
  private person = '';
  /** Changes go out one after another, so the last one written is the last one sent. */
  private queue: Promise<unknown> = Promise.resolve();

  readonly preferences = this.state.asReadonly();
  readonly status = this.loadStatus.asReadonly();
  /** Read, from the API or this browser: the tips and the tour may be scheduled. */
  readonly ready = computed(() => this.loadStatus() !== 'pending');
  readonly showTips = computed(() => this.state().showTips);
  readonly tourDone = computed(() => this.state().tourDone);
  readonly dismissed = computed(() => new Set(this.state().dismissedTips));

  constructor() {
    effect(() => {
      const me = this.me();
      const id = me.kind === 'user' && !isUnconfirmed(me.id) ? me.id : '';
      if (id === this.person) return;
      this.person = id;
      void this.load(id);
    });
  }

  private async load(person: string): Promise<void> {
    this.loadStatus.set('pending');
    this.state.set(DEFAULTS);
    if (!person) return;
    try {
      const doc = await firstValueFrom(this.api.get('/me/preferences'));
      if (person !== this.person) return;
      this.state.set(fromDocument(doc));
      this.loadStatus.set('ready');
      writeStored(storageKey(person), JSON.stringify(this.state()));
    } catch {
      if (person !== this.person) return;
      this.state.set(parseStored(readStored(storageKey(person))) ?? DEFAULTS);
      this.loadStatus.set('local');
    }
  }

  /** Never shows `id` again (until "Reset tips"). */
  dismiss(id: string): void {
    if (this.state().dismissedTips.includes(id)) return;
    this.change({ dismissedTips: [...this.state().dismissedTips, id] });
  }

  setShowTips(showTips: boolean): void {
    this.change({ showTips });
  }

  finishTour(): void {
    this.change({ tourDone: true });
  }

  /** The tour comes again; "Show tips" stays as the person set it. */
  restartTour(): void {
    this.change({ tourDone: false });
  }

  /** Every tip shows again, with tips on. */
  resetTips(): void {
    this.change({ dismissedTips: [], showTips: true });
  }

  private change(changes: Partial<TipPreferences>): void {
    const person = this.person;
    if (!person) return;
    this.state.update((current) => ({ ...current, ...changes }));
    writeStored(storageKey(person), JSON.stringify(this.state()));
    const { dismissedTips, ...rest } = changes;
    const attributes = {
      ...rest,
      ...(dismissedTips && { dismissedTips: [...dismissedTips] }),
    };
    this.queue = this.queue
      .then(() =>
        firstValueFrom(
          this.api.patch(
            '/me/preferences',
            { path: {} as never },
            { data: { type: 'Preferences', attributes } },
          ),
        ),
      )
      // Kept in this browser: the next change (or the next read that fails) carries on from it.
      .catch(() => undefined);
  }
}
