import { computed, inject, Injectable, signal } from '@angular/core';

import { ChangeSetSession } from '../session/change-set-session';

/**
 * Whether a new manual can be started now, and a request to open the new-manual dialog from
 * elsewhere (the search palette). The manual builder hosts the dialog and takes the request when
 * it can: at once, or once its lists have loaded.
 */
@Injectable({ providedIn: 'root' })
export class NewManualRequest {
  private readonly changeSets = inject(ChangeSetSession);
  private readonly asked = signal(false);

  /** Whether a request waits for the manual builder. */
  readonly pending = this.asked.asReadonly();

  /** Why a new manual cannot be started now (a translation key), or null. */
  readonly blocked = computed((): string | null => {
    const chosen = this.changeSets.selected();
    if (this.changeSets.switching()) return 'editor.changeSet.switchingReason';
    if (!chosen) return 'editor.manuals.new.needsChangeSet';
    if (chosen.branch === null) return 'editor.changeSet.startingReason';
    const state = this.changeSets
      .options()
      .find((o) => o.id === chosen.id)?.state;
    if (state !== undefined && state !== 'draft') {
      return 'editor.manuals.new.notDraft';
    }
    return null;
  });

  /** Asks the manual builder to open the dialog. */
  request(): void {
    this.asked.set(true);
  }

  /** The manual builder took the request (or it no longer applies). */
  take(): void {
    this.asked.set(false);
  }
}
