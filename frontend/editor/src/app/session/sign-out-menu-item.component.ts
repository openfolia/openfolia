import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLogOut } from '@ng-icons/lucide';

import { ZardDropdownImports } from '@openfolia/ui/dropdown-menu';
import { ToastService, translated } from '@openfolia/ui/startup';

import { toApiError } from '../api';
import { injectFailureText } from './failure-text';
import { SignInSession } from './sign-in-session';

/**
 * "Sign out" in the account menu (#37), projected into `of-account-menu`. The caller shows it
 * only for a signed-in session (`GET /me`'s `meta.session`). It ends the session at the API, then
 * leaves for the provider's sign-out page or the sign-in page; a failure says why in a toast with
 * a retry, and the session goes on.
 */
@Component({
  selector: 'of-sign-out-menu-item',
  imports: [ZardDropdownImports, NgIcon, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideLogOut })],
  host: { class: 'block' },
  template: `
    <z-dropdown-menu-separator />
    <z-dropdown-menu-item
      data-testid="sign-out"
      [attr.aria-busy]="session.busy()"
      (click)="signOut()"
    >
      <ng-icon
        name="lucideLogOut"
        class="text-foreground size-4 shrink-0"
        aria-hidden="true"
      />
      {{ 'editor.signIn.signOut' | transloco }}
    </z-dropdown-menu-item>
  `,
})
export class SignOutMenuItemComponent {
  protected readonly session = inject(SignInSession);
  private readonly toast = inject(ToastService);
  private readonly failureText = injectFailureText();

  protected async signOut(): Promise<void> {
    if (this.session.busy()) return;
    try {
      await this.session.signOut();
    } catch (error) {
      this.toast.error(
        this.failureText(
          translated('editor.signIn.signOutFailed'),
          toApiError(error),
        ),
        {
          actionLabel: translated('editor.session.retry'),
          onAction: () => void this.signOut(),
        },
      );
    }
  }
}
