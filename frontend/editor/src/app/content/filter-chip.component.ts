import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDropdownImports } from '@openfolia/ui/dropdown-menu';

/** One choice of a filter; `''` is "All". */
export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

/**
 * A filter of the content browser as a pill: its name and the chosen value ("Type All"), opening
 * a menu of radio items. "All" comes first and clears the filter.
 */
@Component({
  selector: 'of-filter-chip',
  imports: [ZardDropdownImports, ZardButtonComponent, NgIcon, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideChevronDown })],
  host: { class: 'inline-flex' },
  template: `
    <button
      z-button
      zType="outline"
      type="button"
      z-dropdown
      [zDropdownMenu]="menu"
      class="h-8 max-w-full rounded-full px-3"
      [attr.aria-label]="
        'editor.content.filters.chipLabel'
          | transloco: { name: label(), value: chosenLabel() }
      "
    >
      <span class="text-muted-foreground">{{ label() }}</span>
      <span class="max-w-40 truncate font-medium">{{ chosenLabel() }}</span>
      <ng-icon
        name="lucideChevronDown"
        class="text-muted-foreground size-4"
        aria-hidden="true"
      />
    </button>
    <z-dropdown-menu-content
      #menu
      class="max-h-80 w-56 max-w-[calc(100vw-2rem)] overflow-y-auto"
    >
      <z-dropdown-menu-radio-group
        [zValue]="value()"
        (zValueChange)="changed.emit($event ?? '')"
        [attr.aria-label]="label()"
      >
        <z-dropdown-menu-radio-item zValue="">{{
          'editor.content.filters.all' | transloco
        }}</z-dropdown-menu-radio-item>
        @for (option of options(); track option.value) {
          <z-dropdown-menu-radio-item [zValue]="option.value">{{
            option.label
          }}</z-dropdown-menu-radio-item>
        }
      </z-dropdown-menu-radio-group>
    </z-dropdown-menu-content>
  `,
})
export class FilterChipComponent {
  readonly label = input.required<string>();
  readonly options = input.required<readonly FilterOption[]>();
  /** The chosen value; `''` for All. */
  readonly value = input('');
  /** The text for All, translated by the caller. */
  readonly allLabel = input.required<string>();
  readonly changed = output<string>();

  protected readonly chosenLabel = computed(
    () =>
      this.options().find((o) => o.value === this.value())?.label ??
      this.allLabel(),
  );
}
