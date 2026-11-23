import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideInfo,
  lucideOctagonAlert,
  lucideTriangleAlert,
} from '@ng-icons/lucide';

/** The four fixed severities of the safety standards; the signal word shown for each is an input. */
export type SafetyLevel = 'danger' | 'warning' | 'caution' | 'notice';

export const safetyLevels: readonly SafetyLevel[] = [
  'danger',
  'warning',
  'caution',
  'notice',
];

const header: Record<SafetyLevel, string> = {
  danger: 'bg-safety-danger text-safety-danger-foreground',
  warning: 'bg-safety-warning text-safety-warning-foreground',
  caution: 'bg-safety-caution text-safety-caution-foreground',
  notice: 'bg-safety-notice text-safety-notice-foreground',
};
const frame: Record<SafetyLevel, string> = {
  danger: 'border-safety-danger bg-safety-danger/10',
  warning: 'border-safety-warning bg-safety-warning/10',
  caution: 'border-safety-caution bg-safety-caution/10',
  notice: 'border-safety-notice bg-safety-notice/10',
};
const icons: Record<SafetyLevel, string> = {
  danger: 'lucideOctagonAlert',
  warning: 'lucideTriangleAlert',
  caution: 'lucideTriangleAlert',
  notice: 'lucideInfo',
};

/**
 * A safety notice (changing the level fades the colours over 300 ms; instant under reduced
 * motion): a header with the signal word on the level's fixed safety colour, then the
 * hazard, its consequence and the measure. Presentational: text comes from inputs, or from
 * projected content in the `hazard`, `consequence` and `measure` slots. With `body`, the three
 * fields give way to the projected content as it is (an editor's node view projects its editable
 * content there). Controls projected with the `header` attribute sit in the header, after the
 * word. The signal word and field labels are inputs, so the words are configuration and never a
 * fixed list.
 */
@Component({
  selector: 'of-safety-notice',
  imports: [TranslocoPipe, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideInfo, lucideOctagonAlert, lucideTriangleAlert }),
  ],
  host: {
    role: 'note',
    '[attr.aria-label]': 'signalWord()',
    '[attr.data-level]': 'level()',
    '[class]': 'frameClass()',
  },
  template: `
    <div
      class="flex items-center gap-2 px-4 py-2 text-sm font-bold tracking-widest uppercase transition-colors duration-300 ease-out motion-reduce:transition-none"
      [class]="headerClass()"
    >
      <ng-icon [name]="icon()" class="text-base" aria-hidden="true" />
      <span>{{ signalWord() }}</span>
      <ng-content select="[header]" />
    </div>
    @if (body()) {
      <div class="px-4 py-3 text-sm break-words"><ng-content /></div>
    } @else {
      <dl class="m-0 flex flex-col gap-2 px-4 py-3 text-sm break-words">
        <div class="grid grid-cols-[6.5rem_1fr] gap-3 has-[dd:empty]:hidden">
          <dt class="text-xs text-muted-foreground">
            {{ hazardLabel() || ('ui.blocks.safety.hazard' | transloco) }}
          </dt>
          <!-- prettier-ignore -->
          <dd class="m-0 font-medium">{{ hazard() }}<ng-content select="[hazard]" /></dd>
        </div>
        <div class="grid grid-cols-[6.5rem_1fr] gap-3 has-[dd:empty]:hidden">
          <dt class="text-xs text-muted-foreground">
            {{
              consequenceLabel() || ('ui.blocks.safety.consequence' | transloco)
            }}
          </dt>
          <!-- prettier-ignore -->
          <dd class="m-0">{{ consequence() }}<ng-content select="[consequence]" /></dd>
        </div>
        <div class="grid grid-cols-[6.5rem_1fr] gap-3 has-[dd:empty]:hidden">
          <dt class="text-xs text-muted-foreground">
            {{ measureLabel() || ('ui.blocks.safety.measure' | transloco) }}
          </dt>
          <dd class="m-0">{{ measure() }}<ng-content select="[measure]" /></dd>
        </div>
      </dl>
    }
  `,
})
export class SafetyNoticeComponent {
  readonly level = input<SafetyLevel>('notice');
  /** The word in the header, in the document's language. */
  readonly signalWord = input.required<string>();
  readonly hazard = input('');
  readonly consequence = input('');
  readonly measure = input('');
  /** The field names; default: "Hazard", "Consequence", "Measure", translated. */
  readonly hazardLabel = input('');
  readonly consequenceLabel = input('');
  readonly measureLabel = input('');
  /** Shows the projected content in place of the hazard, consequence and measure fields. */
  readonly body = input(false);

  protected readonly icon = computed(() => icons[this.level()]);
  protected readonly headerClass = computed(() => header[this.level()]);
  protected readonly frameClass = computed(
    () =>
      `block overflow-hidden rounded-lg border text-card-foreground transition-colors duration-300 ease-out motion-reduce:transition-none ${frame[this.level()]}`,
  );
}
