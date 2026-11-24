import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFlaskConical } from '@ng-icons/lucide';

/**
 * Where a control stood that a public sandbox (#826) leaves out (an upload, an import, …): one
 * quiet line that says why, in the banner's family (its flask in the info colour), so a missing
 * button never looks like a fault. `text` is the translated line.
 */
@Component({
  selector: 'of-sandbox-note',
  imports: [NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideFlaskConical })],
  host: { class: 'block min-w-0' },
  template: `
    <p
      data-testid="sandbox-off"
      class="text-muted-foreground m-0 flex min-w-0 items-start gap-1.5 text-xs/5"
    >
      <ng-icon
        name="lucideFlaskConical"
        class="text-info mt-0.5 size-3.5 shrink-0"
        size="14"
        strokeWidth="1.75"
        aria-hidden="true"
      />
      <span class="min-w-0 break-words">{{ text() }}</span>
    </p>
  `,
})
export class SandboxNoteComponent {
  readonly text = input.required<string>();
}
