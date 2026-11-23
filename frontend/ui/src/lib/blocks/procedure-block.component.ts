import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideListChecks } from '@ng-icons/lucide';

/**
 * A procedure: numbered task steps under a small label, set apart from an ordered list by a
 * hairline frame. The steps are the projected content (an `<ol>`, or an editor's editable steps);
 * controls projected with the `header` attribute sit after the label.
 */
@Component({
  selector: 'of-procedure-block',
  imports: [NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideListChecks })],
  host: {
    role: 'group',
    '[attr.aria-label]': 'label()',
    class: 'block rounded-md border border-border px-3 py-2',
  },
  template: `
    <div
      class="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
    >
      <ng-icon name="lucideListChecks" class="shrink-0" aria-hidden="true" />
      <span class="font-medium">{{ label() }}</span>
      <ng-content select="[header]" />
    </div>
    <div class="mt-1 min-w-0 text-sm break-words"><ng-content /></div>
  `,
})
export class ProcedureBlockComponent {
  /** The block's name ("Procedure"). */
  readonly label = input.required<string>();
}
