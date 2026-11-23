import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

/** The colour of a meter's fill. */
export type MeterTone = 'success' | 'warning' | 'destructive';

/**
 * A share as a thin bar (`role="meter"`): how much of something is done, such as the modules of
 * a manual translated up to date. `value` is a percentage (rounded, kept within 0–100); `label`
 * names the meter for assistive technology and `valueText` says the value in words. A bar is
 * never the only way the value is told: show it as text next to it too. `tone` colours the fill:
 * `success` (the default), `warning` (nearly full) or `destructive` (full); say the state in words
 * too. The fill follows a new value smoothly, at once under reduced motion.
 */
@Component({
  selector: 'of-meter-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'meter',
    'data-slot': 'meter-bar',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    '[attr.aria-valuenow]': 'clamped()',
    '[attr.aria-label]': 'label() || null',
    '[attr.aria-valuetext]': 'valueText() || null',
    class: 'bg-muted block h-1.5 w-full overflow-hidden rounded-full',
  },
  template: `
    <span
      class="block h-full rounded-full transition-[width,background-color] duration-300 ease-out motion-reduce:transition-none"
      data-slot="meter-bar-fill"
      [attr.data-tone]="tone()"
      [class.bg-success]="tone() === 'success'"
      [class.bg-warning]="tone() === 'warning'"
      [class.bg-destructive]="tone() === 'destructive'"
      [style.width.%]="clamped()"
    ></span>
  `,
})
export class MeterBarComponent {
  readonly value = input.required<number>();
  readonly label = input('');
  readonly valueText = input('');
  readonly tone = input<MeterTone>('success');

  protected readonly clamped = computed(() => {
    const v = this.value();
    return Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : 0;
  });
}
