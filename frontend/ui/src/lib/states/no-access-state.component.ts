import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLock } from '@ng-icons/lucide';

/**
 * The person may not see this. No retry: asking again changes nothing. A projected link ("See my
 * roles") may offer the way to more access.
 */
@Component({
  selector: 'of-no-access',
  imports: [NgIcon, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideLock })],
  host: {
    class: 'flex flex-col items-center gap-2.5 px-6 py-12 text-center',
    role: 'alert',
    'data-state': 'no-access',
  },
  template: `
    <span
      class="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-xl"
      aria-hidden="true"
    >
      <ng-icon name="lucideLock" size="20" strokeWidth="1.5" />
    </span>
    <h3 class="text-base/5 font-medium">
      {{ heading() || ('ui.states.noAccess.title' | transloco) }}
    </h3>
    <p class="text-muted-foreground max-w-80 text-sm break-words">
      {{ message() || ('ui.states.noAccess.message' | transloco) }}
    </p>
    <div class="empty:hidden"><ng-content /></div>
  `,
})
export class NoAccessStateComponent {
  /** Overrides the title ("You can't open this module"). */
  readonly heading = input('');
  readonly message = input('');
}
