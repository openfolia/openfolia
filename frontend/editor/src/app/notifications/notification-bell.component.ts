import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBell } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardTooltipDirective } from '@openfolia/ui/tooltip';

import { NotificationCenter } from './notification-center';

/** The keys that open and close the sheet from anywhere (`aria-keyshortcuts`). */
export const NOTIFICATIONS_SHORTCUT = 'Alt+Shift+N';

/** Alt+Shift+N, by the key's place (Alt changes the character it types on a Mac). */
export function isNotificationsShortcut(event: KeyboardEvent): boolean {
  return (
    event.altKey &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    event.code === 'KeyN'
  );
}

/**
 * The bell in the shell's header: the unread count as a number (not a dot alone), in its name
 * too, so it never relies on colour. A click (or Alt+Shift+N) opens the notifications sheet.
 * It starts the count's polling (`NotificationCenter.watch`) for as long as it is there.
 */
@Component({
  selector: 'of-notification-bell',
  imports: [TranslocoPipe, NgIcon, ZardButtonComponent, ZardTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideBell })],
  template: `
    <button
      type="button"
      z-button
      zType="ghost"
      zSize="icon"
      class="text-muted-foreground hover:text-foreground relative"
      data-testid="notification-bell"
      data-tip="shell.notifications"
      [attr.aria-label]="
        'editor.notifications.bell' | transloco: { count: count() ?? 0 }
      "
      [attr.aria-expanded]="open()"
      aria-haspopup="dialog"
      [attr.aria-keyshortcuts]="shortcut"
      [zTooltip]="
        'editor.notifications.bellTooltip' | transloco: { shortcut: shortcut }
      "
      zPosition="bottom"
      (click)="pressed.emit()"
    >
      <ng-icon
        name="lucideBell"
        size="18"
        strokeWidth="1.5"
        aria-hidden="true"
      />
      @if (badge(); as text) {
        <span
          class="bg-primary text-primary-foreground animate-in fade-in-0 zoom-in-75 absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.625rem]/none font-medium tabular-nums duration-200 motion-reduce:animate-none"
          data-testid="notification-count"
          aria-hidden="true"
          >{{ text }}</span
        >
      }
    </button>
  `,
})
export class NotificationBellComponent {
  private readonly center = inject(NotificationCenter);

  /** Whether the sheet is open. */
  readonly open = input(false);
  /** The bell was pressed: open or close the sheet. */
  readonly pressed = output<void>();

  protected readonly shortcut = NOTIFICATIONS_SHORTCUT;
  protected readonly count = this.center.unread;
  /** The number on the bell: none at 0, "99+" past 99. */
  protected readonly badge = computed(() => {
    const n = this.count() ?? 0;
    return n <= 0 ? null : n > 99 ? '99+' : String(n);
  });

  constructor() {
    this.center.watch();
  }
}
