import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleAlert,
  lucideInfo,
  lucideLightbulb,
} from '@ng-icons/lucide';

/** The kinds of a non-safety call-out, as the content model has them. */
export type AdmonitionKind = 'note' | 'tip' | 'important';

export const admonitionKinds: readonly AdmonitionKind[] = [
  'note',
  'tip',
  'important',
];

/** Each kind's frame: a coloured edge and tint from the theme's status tokens. */
const frame: Record<AdmonitionKind, string> = {
  note: 'border-info bg-info-muted',
  tip: 'border-success bg-success-muted',
  important: 'border-warning bg-warning-muted',
};
const label: Record<AdmonitionKind, string> = {
  note: 'text-info',
  tip: 'text-success',
  important: 'text-warning',
};
const icons: Record<AdmonitionKind, string> = {
  note: 'lucideInfo',
  tip: 'lucideLightbulb',
  important: 'lucideCircleAlert',
};

/**
 * A call-out that is not about safety (a note, a tip, something important): a frame with a
 * thick coloured edge on the start side and a light tint, the kind's icon and its label, then the
 * projected content. Unlike a safety notice it has no coloured header bar and no signal word, so
 * the two never read alike. The label is an input (the configured word, in the document's
 * language); controls projected with the `header` attribute sit after it. Changing the kind fades
 * the colours over 300 ms (at once under reduced motion).
 */
@Component({
  selector: 'of-admonition',
  imports: [NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideCircleAlert, lucideInfo, lucideLightbulb }),
  ],
  host: {
    role: 'note',
    '[attr.aria-label]': 'label()',
    '[attr.data-kind]': 'kind()',
    '[class]': 'frameClass()',
  },
  template: `
    <div
      class="flex min-w-0 items-center gap-1.5 text-xs font-semibold transition-colors duration-300 ease-out motion-reduce:transition-none"
      [class]="labelClass()"
    >
      <ng-icon [name]="icon()" class="shrink-0 text-sm" aria-hidden="true" />
      <span class="min-w-0 break-words">{{ label() }}</span>
      <ng-content select="[header]" />
    </div>
    <div class="mt-1 min-w-0 text-sm break-words"><ng-content /></div>
  `,
})
export class AdmonitionComponent {
  readonly kind = input<AdmonitionKind>('note');
  /** The kind's word as the document shows it ("Note", "Tip", …). */
  readonly label = input.required<string>();

  protected readonly icon = computed(() => icons[this.kind()]);
  protected readonly labelClass = computed(() => label[this.kind()]);
  protected readonly frameClass = computed(
    () =>
      `block rounded-md border-s-4 px-3 py-2 text-card-foreground transition-colors duration-300 ease-out motion-reduce:transition-none ${frame[this.kind()]}`,
  );
}
