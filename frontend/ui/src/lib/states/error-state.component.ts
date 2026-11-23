import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCloudOff,
  lucideRotateCcw,
  lucideTriangleAlert,
} from '@ng-icons/lucide';

import { ZardButtonComponent } from '../button/button.component';
import { errorTitles, isRetryable, type StateErrorKind } from './state-kind';

/**
 * A failed load, with a retry button when trying again can help. The title names the kind, so
 * the state never relies on colour (or the icon) alone. For `unauthorized` use `NoAccessStateComponent`
 * (the list frame does).
 */
@Component({
  selector: 'of-error-state',
  imports: [NgIcon, ZardButtonComponent, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideCloudOff, lucideRotateCcw, lucideTriangleAlert }),
  ],
  host: {
    class: 'flex flex-col items-center gap-2.5 px-6 py-12 text-center',
    role: 'alert',
    'data-state': 'error',
  },
  template: `
    <span
      class="bg-destructive-muted text-destructive flex size-12 items-center justify-center rounded-xl"
      aria-hidden="true"
    >
      <ng-icon
        [name]="kind() === 'network' ? 'lucideCloudOff' : 'lucideTriangleAlert'"
        size="20"
        strokeWidth="1.5"
      />
    </span>
    <h3 class="text-base/5 font-medium">
      {{ heading() || (titleKey() | transloco) }}
    </h3>
    @if (message()) {
      <p class="text-muted-foreground max-w-80 text-sm break-words">
        {{ message() }}
      </p>
    }
    @if (canRetry()) {
      <button z-button zType="outline" (click)="retry.emit()">
        <ng-icon
          name="lucideRotateCcw"
          data-icon="inline-start"
          strokeWidth="1.5"
          aria-hidden="true"
        />
        {{ 'ui.states.error.retry' | transloco }}
      </button>
    }
  `,
})
export class ErrorStateComponent {
  readonly kind = input<StateErrorKind>('unknown');
  readonly message = input('');
  /** Overrides the default: retry for `unavailable`, `network` and `unknown` only. */
  readonly retryable = input<boolean | undefined>(undefined);
  readonly retry = output<void>();

  /** Overrides the title the kind gives ("Couldn't load the modules"). */
  readonly heading = input('');
  protected readonly titleKey = computed(() => errorTitles[this.kind()]);
  protected readonly canRetry = computed(
    () => this.retryable() ?? isRetryable(this.kind()),
  );
}
