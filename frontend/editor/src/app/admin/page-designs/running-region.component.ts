import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardSelectImports } from '@openfolia/ui/select';
import { ZardSwitchComponent } from '@openfolia/ui/switch';

import {
  RUNNING_CHOICE_LABELS,
  RUNNING_CHOICES,
  RUNNING_PLACES,
  runningChoiceOf,
  withRunningChoice,
  withRunningVariant,
  type RunningChoice,
  type RunningPlace,
  type RunningRegion,
  type RunningVariant,
} from './design-model';

const PLACE_LABELS: Readonly<Record<RunningPlace, string>> = {
  left: 'editor.admin.pageDesigns.running.places.left',
  centre: 'editor.admin.pageDesigns.running.places.centre',
  right: 'editor.admin.pageDesigns.running.places.right',
};

const VARIANT_LABELS: Readonly<Record<RunningVariant, string>> = {
  default: 'editor.admin.pageDesigns.running.variants.default',
  first: 'editor.admin.pageDesigns.running.variants.first',
  even: 'editor.admin.pageDesigns.running.variants.even',
};

/**
 * A running header's or footer's places (left, centre, right) on every page, and optionally on
 * the first page and, printed double-sided, on left pages (#388's inner pages): each place shows
 * one of the manual's data (`RUNNING_CHOICES`). A text written otherwise (by hand, per language)
 * shows as "Custom text" and is kept; editing such text is the region editor's (#393).
 */
@Component({
  selector: 'of-running-region',
  imports: [TranslocoPipe, ZardSelectImports, ZardSwitchComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-3' },
  template: `
    @for (variant of variants(); track variant) {
      <div
        class="flex min-w-0 flex-col gap-2"
        [attr.data-running]="kind() + '-' + variant"
      >
        <p class="text-muted-foreground m-0 text-xs font-medium">
          {{ variantLabels[variant] | transloco }}
        </p>
        <div class="grid min-w-0 gap-2 sm:grid-cols-3">
          @for (place of places; track place) {
            @let choice = choiceOf(variant, place);
            <z-select
              class="w-full min-w-0"
              zPosition="popper"
              [attr.data-place]="place"
              [zDisabled]="disabled()"
              [zPrefix]="placeLabels[place] | transloco"
              [zAriaLabel]="
                'editor.admin.pageDesigns.running.placeAria'
                  | transloco
                    : {
                        region: (kindLabel() | transloco),
                        pages: (variantLabels[variant] | transloco),
                        place: (placeLabels[place] | transloco),
                      }
              "
              [zValue]="choice"
              (zSelectionChange)="choose(variant, place, $any($event))"
            >
              @for (c of choicesFor(choice); track c) {
                <z-select-item [zValue]="c" [zDisabled]="c === 'custom'">{{
                  choiceLabels[c] | transloco
                }}</z-select-item>
              }
            </z-select>
          }
        </div>
      </div>
    }
    <div class="flex min-w-0 flex-col gap-2">
      <z-switch
        class="text-sm"
        [attr.data-toggle]="kind() + '-first'"
        [zDisabled]="disabled()"
        [zChecked]="!!region().first"
        (zCheckedChange)="toggle('first', $event)"
        >{{ 'editor.admin.pageDesigns.running.firstOwn' | transloco }}</z-switch
      >
      @if (doubleSided()) {
        <z-switch
          class="text-sm"
          [attr.data-toggle]="kind() + '-even'"
          [zDisabled]="disabled()"
          [zChecked]="!!region().even"
          (zCheckedChange)="toggle('even', $event)"
          >{{
            'editor.admin.pageDesigns.running.evenOwn' | transloco
          }}</z-switch
        >
      }
    </div>
  `,
})
export class RunningRegionComponent {
  readonly region = input.required<RunningRegion>();
  readonly kind = input.required<'header' | 'footer'>();
  /** Left pages have their own text only in double-sided print. */
  readonly doubleSided = input(false);
  readonly disabled = input(false);
  readonly regionChange = output<RunningRegion>();

  protected readonly places = RUNNING_PLACES;
  protected readonly placeLabels = PLACE_LABELS;
  protected readonly variantLabels = VARIANT_LABELS;
  protected readonly choiceLabels = RUNNING_CHOICE_LABELS;

  protected readonly kindLabel = computed(() =>
    this.kind() === 'header'
      ? 'editor.admin.pageDesigns.running.header'
      : 'editor.admin.pageDesigns.running.footer',
  );

  protected readonly variants = computed((): RunningVariant[] => {
    const r = this.region();
    return [
      'default',
      ...(r.first ? (['first'] as const) : []),
      ...(r.even && this.doubleSided() ? (['even'] as const) : []),
    ];
  });

  protected choiceOf(
    variant: RunningVariant,
    place: RunningPlace,
  ): RunningChoice {
    return runningChoiceOf(this.region()[variant]?.[place]);
  }

  /** The choices offered; "Custom text" only where a place holds such text. */
  protected choicesFor(current: RunningChoice): readonly RunningChoice[] {
    return current === 'custom'
      ? [...RUNNING_CHOICES, 'custom']
      : RUNNING_CHOICES;
  }

  protected choose(
    variant: RunningVariant,
    place: RunningPlace,
    value: string | string[],
  ): void {
    const choice = (Array.isArray(value) ? value[0] : value) as RunningChoice;
    if (!choice || choice === this.choiceOf(variant, place)) return;
    this.regionChange.emit(
      withRunningChoice(this.region(), variant, place, choice),
    );
  }

  protected toggle(variant: 'first' | 'even', on: boolean): void {
    if (on === !!this.region()[variant]) return;
    this.regionChange.emit(withRunningVariant(this.region(), variant, on));
  }
}
