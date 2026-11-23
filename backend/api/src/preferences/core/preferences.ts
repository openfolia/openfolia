import { z } from 'zod';

/**
 * A tip's ID, as the editor's tip catalogue names it (`content.new-module`): lowercase letters
 * and digits in words joined by "." or "-". The server does not know the catalogue: it keeps
 * whichever IDs the person dismissed.
 */
export const TipId = z
  .string()
  .max(100)
  .regex(
    /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/,
    'lowercase letters and digits, joined by "." or "-", e.g. "content.new-module"',
  );

/** How many dismissed tips a person keeps at most. */
export const MAX_DISMISSED_TIPS = 500;

/**
 * A person's own preferences (#222): the editor's tips and first-run tour. Kept per person on the
 * server, so they follow the person from browser to browser.
 */
export interface Preferences {
  /** Whether the editor shows tips and the tour at all ("Show tips" in the account menu). */
  readonly showTips: boolean;
  /** The tips the person has seen and closed, never shown again (until "Reset tips"). */
  readonly dismissedTips: readonly string[];
  /** Whether the person finished or skipped the first-run tour. */
  readonly tourDone: boolean;
}

/** The preferences as stored, with when they last changed. */
export interface StoredPreferences {
  readonly preferences: Preferences;
  /** When they last changed; null: never (the defaults). */
  readonly updatedAt: Date | null;
}

/** What a person who has changed nothing has: tips on, none dismissed, the tour still to come. */
export const DEFAULT_PREFERENCES: Preferences = {
  showTips: true,
  dismissedTips: [],
  tourDone: false,
};

/** A change of preferences: what is left out stays. */
export type PreferenceChanges = Partial<Preferences>;
