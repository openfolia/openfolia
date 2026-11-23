import { computed, inject, Injectable, signal } from '@angular/core';

import { PermissionService } from '../permissions/permission.service';
import { ChangeSetSession } from '../session/change-set-session';

/**
 * Whether a new module can be started now, and a request to open the new-module dialog from
 * elsewhere (the search palette). The content browser hosts the dialog and takes the request
 * when it can: at once, or once its configuration has loaded.
 */
@Injectable({ providedIn: 'root' })
export class NewModuleRequest {
  private readonly changeSets = inject(ChangeSetSession);
  private readonly permissions = inject(PermissionService);
  private readonly asked = signal(false);

  /** Whether a request waits for the content browser. */
  readonly pending = this.asked.asReadonly();

  /** The chosen change set's state; undefined for the released content. */
  readonly changeSetState = computed(() => {
    const id = this.changeSets.selected()?.id;
    return id === undefined
      ? undefined
      : this.changeSets.options().find((o) => o.id === id)?.state;
  });

  /** Why a new module cannot be started now (a translation key), or null. */
  readonly blocked = computed((): string | null => {
    const chosen = this.changeSets.selected();
    if (this.changeSets.switching()) return 'editor.changeSet.switchingReason';
    // A contributor's new module is a suggestion of its own: its change set is made for it.
    if (this.permissions.suggestsOnly()) {
      return this.changeSets.starting() !== null
        ? 'editor.changeSet.startingReason'
        : null;
    }
    if (!chosen) return 'editor.content.new.needsChangeSet';
    if (chosen.branch === null) return 'editor.changeSet.startingReason';
    const state = this.changeSetState();
    if (state !== undefined && state !== 'draft') {
      return 'editor.content.new.notDraft';
    }
    return null;
  });

  /** Asks the content browser to open the dialog. */
  request(): void {
    this.asked.set(true);
  }

  /** The content browser took the request (or it no longer applies). */
  take(): void {
    this.asked.set(false);
  }
}
