import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideInbox } from '@ng-icons/lucide';

/** Nothing here yet. Project an action (a button) as content to offer the next step. */
@Component({
  selector: 'of-empty-state',
  imports: [NgIcon, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideInbox })],
  host: {
    class:
      'flex flex-col items-center gap-2.5 px-6 py-12 text-center text-foreground',
    'data-state': 'empty',
  },
  template: `
    <span
      class="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-xl"
      aria-hidden="true"
    >
      <ng-icon name="lucideInbox" size="20" strokeWidth="1.5" />
    </span>
    <h3 class="text-base/5 font-medium">
      {{ title() || ('ui.states.empty.title' | transloco) }}
    </h3>
    @if (description()) {
      <p class="text-muted-foreground max-w-80 text-sm break-words">
        {{ description() }}
      </p>
    }
    <div class="empty:hidden"><ng-content /></div>
  `,
})
export class EmptyStateComponent {
  /** Default: "Nothing here yet". */
  readonly title = input('');
  readonly description = input('');
}
