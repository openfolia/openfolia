import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFlaskConical } from '@ng-icons/lucide';

/**
 * A whole screen a public sandbox (#826) leaves out (an import): the library's empty state, in
 * its card, with the banner's flask in the info colour instead of the inbox, so it reads as a
 * choice of this mode and not as missing content. `title` and `description` are translated.
 */
@Component({
  selector: 'of-sandbox-off-state',
  imports: [NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideFlaskConical })],
  host: {
    class: 'border-border bg-card block rounded-xl border',
    'data-testid': 'sandbox-off-state',
  },
  template: `
    <div
      class="text-foreground flex flex-col items-center gap-2.5 px-6 py-12 text-center"
      data-state="empty"
    >
      <span
        class="bg-info-muted text-info flex size-12 items-center justify-center rounded-xl"
        aria-hidden="true"
      >
        <ng-icon name="lucideFlaskConical" size="20" strokeWidth="1.5" />
      </span>
      <h2 class="m-0 text-base/5 font-medium">{{ title() }}</h2>
      <p class="text-muted-foreground m-0 max-w-96 text-sm break-words">
        {{ description() }}
      </p>
    </div>
  `,
})
export class SandboxOffStateComponent {
  readonly title = input.required<string>();
  readonly description = input.required<string>();
}
