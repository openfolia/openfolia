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
import { ZardPopoverImports } from '@openfolia/ui/popover';

import { KeywordFieldComponent } from './keyword-field.component';

/**
 * The content browser's keyword filter as a pill, like the other filter chips ("Keyword All", or
 * the keywords chosen), opening a popover with the keyword field: every keyword added narrows the
 * list to modules that have all of them. Keywords are free-form, so they are typed, not picked.
 */
@Component({
  selector: 'of-keyword-filter-chip',
  imports: [
    ZardButtonComponent,
    ZardPopoverImports,
    KeywordFieldComponent,
    NgIcon,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideChevronDown })],
  host: { class: 'inline-flex max-w-full' },
  template: `
    <button
      z-button
      zType="outline"
      type="button"
      zPopover
      [zContent]="panel"
      zPlacement="bottom"
      zAlign="start"
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
    <ng-template #panel>
      <z-popover class="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-3">
        <div z-popover-header>
          <h3 z-popover-title>{{ label() }}</h3>
          <p z-popover-description>
            {{ 'editor.content.filters.keywordHint' | transloco }}
          </p>
        </div>
        <of-keyword-field
          inputId="browser-keyword-filter"
          [label]="label()"
          [keywords]="value()"
          (keywordsChange)="changed.emit($event)"
        />
        @if (value().length > 0) {
          <button
            z-button
            zType="ghost"
            zSize="sm"
            type="button"
            class="self-start"
            (click)="changed.emit([])"
          >
            {{ 'editor.content.filters.clearKeywords' | transloco }}
          </button>
        }
      </z-popover>
    </ng-template>
  `,
})
export class KeywordFilterChipComponent {
  readonly label = input.required<string>();
  /** The keywords chosen; empty for All. */
  readonly value = input<readonly string[]>([]);
  /** The text for All, translated by the caller. */
  readonly allLabel = input.required<string>();
  readonly changed = output<readonly string[]>();

  protected readonly chosenLabel = computed(() =>
    this.value().length > 0 ? this.value().join(', ') : this.allLabel(),
  );
}
