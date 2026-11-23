import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideMessageCircleQuestionMark } from '@ng-icons/lucide';

/**
 * An FAQ entry, a question and its answer, as an editor draws it: a quiet frame (the card's
 * border, no tint, so it never reads as a notice), a small label with a question icon, then the
 * projected content: the question as a heading-like line, the answer below it. Controls
 * projected with the `header` attribute sit after the label. A reader's copy (the HTML output)
 * is a disclosure; here the answer always shows, since it is being written.
 */
@Component({
  selector: 'of-faq-entry',
  imports: [NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideMessageCircleQuestionMark })],
  host: {
    class:
      'block rounded-lg border border-border bg-card px-3 py-2 text-card-foreground',
    role: 'group',
    '[attr.aria-label]': 'label()',
  },
  template: `
    <div
      class="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-muted-foreground"
    >
      <ng-icon
        name="lucideMessageCircleQuestionMark"
        class="shrink-0 text-sm"
        aria-hidden="true"
      />
      <span class="min-w-0 break-words">{{ label() }}</span>
      <ng-content select="[header]" />
    </div>
    <div class="mt-1 min-w-0 text-sm break-words"><ng-content /></div>
  `,
})
export class FaqEntryComponent {
  /** The block's name as the editor shows it ("FAQ entry"), in the UI language. */
  readonly label = input.required<string>();
}
