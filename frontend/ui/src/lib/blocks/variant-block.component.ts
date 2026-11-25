import { injectTranslate } from '../i18n/text.pipe';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePlus, lucideSplit } from '@ng-icons/lucide';

import { ZardTooltipImports } from '../tooltip/tooltip.imports';

/** One condition: a variant attribute and the values it must have (names come from the configuration). */
export interface VariantCondition {
  attribute: string;
  values: readonly string[];
}

/**
 * A variant block: a dashed frame around content that applies only when its condition holds.
 * The condition shows as chips ("attribute: value, value"); the button emits `pick` so the
 * host opens its variant picker, or, with `pickDisabledReason`, stays in view, disabled, and says
 * why. Attribute names and values are inputs, never a fixed list.
 */
@Component({
  selector: 'of-variant-block',
  imports: [TranslocoPipe, NgIcon, ...ZardTooltipImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucidePlus, lucideSplit })],
  host: {
    class:
      'block rounded-lg border border-dashed bg-muted/50 px-3 py-3 text-card-foreground',
    role: 'group',
    '[attr.aria-label]': 'labelText()',
    '[attr.data-tip]': 'tipAnchor() || null',
    '[class.border-foreground]': 'selected()',
    '[class.border-ring]': '!selected()',
  },
  template: `
    <div class="mb-2 flex flex-wrap items-center gap-1.5">
      <ng-icon
        name="lucideSplit"
        class="text-muted-foreground"
        aria-hidden="true"
      />
      <span class="text-xs font-semibold">{{ labelText() }}</span>
      @if (conditions().length) {
        <span class="text-xs text-muted-foreground">{{
          shownForLabel() || ('ui.blocks.variant.shownFor' | transloco)
        }}</span>
      }
      @for (condition of conditions(); track condition.attribute) {
        <span
          class="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-background px-2.5 py-0.5 text-xs break-all text-foreground"
          data-chip
        >
          <span class="text-muted-foreground">{{ condition.attribute }}:</span>
          {{ condition.values.join(', ') }}
        </span>
      } @empty {
        <span class="text-xs text-muted-foreground">{{
          emptyText() || ('ui.blocks.variant.everyVariant' | transloco)
        }}</span>
      }
      @if (editable()) {
        <button
          type="button"
          class="inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-xs font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground aria-disabled:no-underline"
          [attr.aria-disabled]="pickDisabledReason() ? 'true' : null"
          [zTooltip]="pickDisabledReason()"
          (click)="pickDisabledReason() || pick.emit()"
        >
          <ng-icon name="lucidePlus" aria-hidden="true" />
          {{ pickLabel() || ('ui.blocks.variant.add' | transloco) }}
        </button>
      }
    </div>
    <div class="min-w-0"><ng-content /></div>
  `,
})
export class VariantBlockComponent {
  readonly conditions = input<readonly VariantCondition[]>([]);
  /** The texts; each defaults to its translation ("Variant block", "Shown for", …). */
  readonly label = input('');
  readonly shownForLabel = input('');
  readonly emptyText = input('');
  readonly pickLabel = input('');
  private readonly t = injectTranslate();
  protected readonly labelText = computed(
    () => this.label() || this.t('ui.blocks.variant.label'),
  );
  readonly editable = input(true);
  readonly selected = input(false);
  /** The `data-tip` of the whole frame, where a tip may point (its card sits below the frame); none by default. */
  readonly tipAnchor = input('');
  /** Why the button can't be used now; non-empty disables it and shows the reason as its tooltip. */
  readonly pickDisabledReason = input('');
  /** The button was used: open the variant picker. */
  readonly pick = output<void>();
}
