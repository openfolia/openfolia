import {
  ChangeDetectionStrategy,
  Component,
  input,
  model,
} from '@angular/core';

/**
 * One choice of a segmented control; `label` is shown as it is (translate it first). `count`,
 * when given, is shown after the label in tabular figures (how many items the choice holds);
 * `null` or absent shows none.
 */
export interface SegmentedOption {
  readonly value: string;
  readonly label: string;
  readonly count?: number | null;
}

/**
 * A small set of choices shown side by side, one chosen (the look of `of-theme-choice`):
 * native radio buttons, so the group is one tab stop and the arrow keys move the choice. The
 * chosen one sits on the background with a shadow and a medium weight, never told by colour
 * alone. `label` names the group for assistive technology.
 */
@Component({
  selector: 'of-segmented',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'bg-muted inline-flex max-w-full flex-wrap rounded-lg p-0.5',
    role: 'radiogroup',
    '[attr.aria-label]': 'label() || null',
  },
  template: `
    @for (option of options(); track option.value) {
      <label
        class="text-foreground has-[:checked]:bg-background has-[:focus-visible]:ring-ring/50 relative flex h-7 cursor-pointer items-center justify-center rounded-md px-3 text-[0.8125rem] whitespace-nowrap transition-[background-color,box-shadow] duration-150 has-[:checked]:font-medium has-[:checked]:shadow-sm has-[:focus-visible]:ring-[3px] motion-reduce:transition-none"
      >
        <input
          type="radio"
          class="sr-only"
          [name]="name"
          [value]="option.value"
          [checked]="value() === option.value"
          (change)="value.set(option.value)"
        />
        {{ option.label }}
        @if (option.count !== null && option.count !== undefined) {
          <span
            class="text-muted-foreground ms-1.5 text-xs tabular-nums"
            data-slot="segmented-count"
            >{{ option.count }}</span
          >
        }
      </label>
    }
  `,
})
export class SegmentedComponent {
  private static nextId = 0;

  readonly options = input.required<readonly SegmentedOption[]>();
  readonly value = model('');
  /** The group's accessible name. */
  readonly label = input('');

  protected readonly name = `of-segmented-${SegmentedComponent.nextId++}`;
}
