import { DestroyRef, inject, Injectable, untracked } from '@angular/core';

/**
 * The admin header's primary action ("New role", "New user"), handed to the open tab's screen:
 * the header sits on the admin page, the screen in its outlet. Provided by the admin page.
 *
 * Handed on at once, in the click: never through an effect, which runs only when the page next
 * renders, so a key typed in between would land in the form the action replaces (and a role
 * with a changed name then asks to discard it).
 */
@Injectable()
export class AdminActions {
  private readonly handlers = new Map<string, Set<() => void>>();

  /** The header's action was chosen while `tab` is open. */
  request(tab: string): void {
    for (const run of [...(this.handlers.get(tab) ?? [])]) untracked(run);
  }

  /**
   * Runs `run` each time the action of `tab` is chosen from now on (not for a request made
   * before the screen opened), until the screen is destroyed. Call in an injection context.
   */
  on(tab: string, run: () => void): void {
    let runs = this.handlers.get(tab);
    if (!runs) {
      runs = new Set();
      this.handlers.set(tab, runs);
    }
    const all = runs;
    all.add(run);
    inject(DestroyRef).onDestroy(() => all.delete(run));
  }
}

/** The page's `AdminActions`, or none outside it (a screen shown on its own in a test). */
export const injectAdminActions = () =>
  inject(AdminActions, { optional: true });
