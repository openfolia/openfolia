import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

import { mergeClasses } from '../ui/merge-classes';

/**
 * The product logo, from the branding config (`docs.config.ts` in the app): the app passes the
 * values, so a rebrand touches no component.
 *
 * `variant="small"` shows the square mark; `variant="full"` the mark with the name. When no
 * full logo is configured, `full` falls back to the small mark next to the product name as text.
 * `smallDark` and `fullDark` are the same images for a dark page (under `.dark`); without them
 * the light one shows there too. The image always has an accessible name: the product name, or
 * an empty `alt` when the name is written next to it.
 */
@Component({
  selector: 'of-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class]': 'classes()' },
  template: `
    <img
      [src]="image().light"
      [alt]="alt()"
      [class]="image().dark ? 'h-full w-auto dark:hidden' : 'h-full w-auto'"
    />
    @if (image().dark; as dark) {
      <img [src]="dark" [alt]="alt()" class="hidden h-full w-auto dark:block" />
    }
    @if (withName()) {
      <span class="text-[15px] font-semibold whitespace-nowrap">{{
        productName()
      }}</span>
    }
  `,
})
export class LogoComponent {
  readonly variant = input<'small' | 'full'>('small');
  readonly productName = input.required<string>();
  /** URL of the square mark. */
  readonly small = input.required<string>();
  /** URL of the square mark on a dark page; optional. */
  readonly smallDark = input<string | undefined>(undefined);
  /** URL of the mark with the name; optional. */
  readonly full = input<string | undefined>(undefined);
  /** URL of the mark with the name on a dark page; optional. */
  readonly fullDark = input<string | undefined>(undefined);
  readonly class = input<string>('');

  protected readonly showFull = computed(
    () => this.variant() === 'full' && !!this.full(),
  );
  protected readonly withName = computed(
    () => this.variant() === 'full' && !this.full(),
  );
  protected readonly image = computed(() =>
    this.showFull()
      ? { light: this.full() as string, dark: this.fullDark() }
      : { light: this.small(), dark: this.smallDark() },
  );
  protected readonly alt = computed(() =>
    this.withName() ? '' : this.productName(),
  );
  protected readonly classes = computed(() =>
    mergeClasses(
      'inline-flex h-7 items-center gap-2 text-foreground',
      this.class(),
    ),
  );
}
