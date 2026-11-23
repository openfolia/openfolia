import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * A page break as the editor shows it: a thin dashed rule across the column with its label in
 * the middle ("Page break (PDF)"). It holds nothing; the whole block is the mark.
 */
@Component({
  selector: 'of-page-break-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'separator',
    '[attr.aria-label]': 'label()',
    class:
      'flex items-center gap-3 py-2 text-xs font-medium text-muted-foreground select-none',
  },
  template: `
    <span
      class="h-0 min-w-4 flex-1 border-t border-dashed border-border"
      aria-hidden="true"
    ></span>
    <span
      class="shrink-0 text-center [overflow-wrap:anywhere]"
      aria-hidden="true"
      >{{ label() }}</span
    >
    <span
      class="h-0 min-w-4 flex-1 border-t border-dashed border-border"
      aria-hidden="true"
    ></span>
  `,
})
export class PageBreakBlockComponent {
  /** What the rule says, e.g. "Page break (PDF)"; also its accessible name. */
  readonly label = input.required<string>();
}
