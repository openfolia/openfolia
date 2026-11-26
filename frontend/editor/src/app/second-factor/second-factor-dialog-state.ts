import { inject, Injectable, signal } from '@angular/core';

/** Whether the dialog of one's own second factor is open: the menu item opens it, the shell holds it. */
@Injectable({ providedIn: 'root' })
export class SecondFactorDialogState {
  readonly open = signal(false);
  /** The dialog's question before it goes; null while there is no dialog. */
  asksBeforeLeaving: (() => Promise<boolean>) | null = null;

  /** Whether the screen may be left: asks while recovery codes show that are not put away yet. */
  leave(): Promise<boolean> {
    return this.asksBeforeLeaving?.() ?? Promise.resolve(true);
  }
}

/** For the shell's routes (`canActivateChild`, `canDeactivate`): Back leaves no codes unseen (#611). */
export const recoveryCodesPutAway = (): Promise<boolean> =>
  inject(SecondFactorDialogState).leave();
