import { computed, inject, type Signal } from '@angular/core';

import { ChangeSetSession } from '../session/change-set-session';

/**
 * Why a module cannot be changed in the chosen change set right now (a translation key), or
 * null: Delete and Translate need a draft change set, as every write does. The lock is the
 * caller's to add (the module editor knows it; the content browser's dialog reads it).
 */
export function injectDraftBlocked(): Signal<string | null> {
  const changeSets = inject(ChangeSetSession);
  return computed(() => {
    if (changeSets.switching()) return 'editor.changeSet.switchingReason';
    const chosen = changeSets.selected();
    if (!chosen) return 'editor.moduleActions.needsChangeSet';
    if (chosen.branch === null) return 'editor.changeSet.startingReason';
    const state = changeSets.options().find((o) => o.id === chosen.id)?.state;
    if (state !== undefined && state !== 'draft') {
      return 'editor.moduleActions.notDraft';
    }
    return null;
  });
}
