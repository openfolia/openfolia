import { computed, inject, Injectable, signal } from '@angular/core';
import { isApplePlatform } from '@openfolia/ui/sidebar';

import { HelpService } from '../help/help.service';
import { PermissionService } from '../permissions/permission.service';
import { type PermissionRule } from '../permissions/permissions';
import { PALETTE_ACTIONS, type PaletteAction } from './palette-actions';
import { adminPages, type PalettePage } from './palette-pages';

/** The permission search needs: the API scopes results to what the person may read. */
export const SEARCH_RULE: PermissionRule = { permission: 'content.read' };

/** The palette's shortcut as people read it: `⌘K` on Apple platforms, `Ctrl+K` elsewhere. */
export function paletteShortcutLabel(apple = isApplePlatform()): string {
  return apple ? '⌘K' : 'Ctrl+K';
}

/** Whether a key press is the palette's shortcut (Cmd+K on Apple platforms, Ctrl+K elsewhere). */
export function isPaletteShortcut(
  event: Pick<
    KeyboardEvent,
    'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
  >,
  apple = isApplePlatform(),
): boolean {
  if (event.key.toLowerCase() !== 'k' || event.altKey || event.shiftKey) {
    return false;
  }
  return apple
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

/**
 * Whether the search palette is open, and what it may offer the current person. Shared by the
 * shell's trigger, the Cmd/Ctrl+K shortcut and the palette itself.
 */
@Injectable({ providedIn: 'root' })
export class SearchPalette {
  private readonly permissions = inject(PermissionService);
  private readonly help = inject(HelpService);
  private readonly openState = signal(false);

  readonly isOpen = this.openState.asReadonly();
  /** Whether the person may search content (otherwise the palette only offers actions). */
  readonly canSearch = computed(
    () => this.permissions.state(SEARCH_RULE).kind !== 'hidden',
  );
  /** The actions this role can ever use whose screens exist. */
  readonly actions = computed<readonly PaletteAction[]>(() =>
    PALETTE_ACTIONS.filter(
      (action) =>
        action.built &&
        !(action.notForContributors && this.permissions.suggestsOnly()) &&
        action.rules.some(
          (rule) => this.permissions.state(rule).kind !== 'hidden',
        ),
    ),
  );
  /** The admin pages and settings topics this role may open, found by name (#591). */
  readonly pages = computed<readonly PalettePage[]>(() =>
    adminPages((rule) => this.permissions.state(rule).kind !== 'hidden'),
  );
  /** Whether the palette finds the user guide's pages (#221): help links are on. */
  readonly canFindHelp = this.help.enabled;
  /**
   * Nothing to offer (no search, no action, no page, no help): no trigger, and the shortcut does
   * nothing.
   */
  readonly available = computed(
    () =>
      this.canSearch() ||
      this.actions().length > 0 ||
      this.pages().length > 0 ||
      this.canFindHelp(),
  );

  open(): void {
    if (this.available()) this.openState.set(true);
  }

  close(): void {
    this.openState.set(false);
  }

  toggle(): void {
    if (this.openState()) this.close();
    else this.open();
  }
}
