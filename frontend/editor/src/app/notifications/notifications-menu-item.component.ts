import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBellRing } from '@ng-icons/lucide';

import { ZardDropdownImports } from '@openfolia/ui/dropdown-menu';
import { ZardSidebarService } from '@openfolia/ui/sidebar';

import { ChangeSetUrl } from '../session/change-set-url';

/** Where the Notifications page is (#884). */
export const NOTIFICATION_SETTINGS_PATH = '/account/notifications';

/**
 * "Notifications" in the account menu (#884), projected into `of-account-menu`: opens the page
 * where the person chooses how each kind of notification reaches them. For a person only.
 */
@Component({
  selector: 'of-notifications-menu-item',
  imports: [ZardDropdownImports, NgIcon, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideBellRing })],
  host: { class: 'block' },
  template: `
    <z-dropdown-menu-item data-testid="notification-settings" (click)="open()">
      <ng-icon
        name="lucideBellRing"
        class="text-foreground size-4 shrink-0"
        aria-hidden="true"
      />
      {{ 'editor.notificationSettings.menu' | transloco }}
    </z-dropdown-menu-item>
  `,
})
export class NotificationsMenuItemComponent {
  private readonly router = inject(Router);
  private readonly changeSetUrl = inject(ChangeSetUrl);
  /** The shell's sidebar: below 768 px a drawer, closed as a sidebar link closes it. */
  private readonly sidebar = inject(ZardSidebarService, { optional: true });

  protected open(): void {
    this.sidebar?.setOpenMobile(false);
    void this.router.navigate([NOTIFICATION_SETTINGS_PATH], {
      queryParams: this.changeSetUrl.paramsFor(NOTIFICATION_SETTINGS_PATH),
    });
  }
}
