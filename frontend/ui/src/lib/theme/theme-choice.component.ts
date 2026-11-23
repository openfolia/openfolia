import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideMoon, lucideSun } from '@ng-icons/lucide';

import { themeIconMotion } from './theme-fade';
import { type ThemePreference, ThemeService } from './theme.service';

const OPTIONS: readonly { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'ui.theme.light' },
  { value: 'dark', label: 'ui.theme.dark' },
  { value: 'system', label: 'ui.theme.system' },
];

/**
 * Light, dark or the device's setting, as a segmented control of native radio buttons (arrow
 * keys move the choice, the group is one tab stop). The sun or moon in front shows the look on
 * screen and turns over when it changes (`themeIconMotion`): keep one theme choice per page,
 * since a view-transition name must be unique.
 */
@Component({
  selector: 'of-theme-choice',
  imports: [NgIcon, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideSun, lucideMoon })],
  host: { class: 'block' },
  template: `
    <fieldset class="flex flex-col gap-1.5">
      <legend
        class="text-muted-foreground mb-1.5 flex items-center gap-2 text-xs"
      >
        <ng-icon
          [name]="theme.resolved() === 'dark' ? 'lucideMoon' : 'lucideSun'"
          [class]="iconClass"
          aria-hidden="true"
        />
        {{ 'ui.theme.label' | transloco }}
      </legend>
      <div class="bg-muted flex rounded-lg p-[3px]">
        @for (option of options; track option.value) {
          <label
            class="text-foreground has-[:checked]:bg-background has-[:focus-visible]:ring-ring/50 relative flex h-7 flex-1 cursor-pointer items-center justify-center rounded-md px-2 text-sm has-[:checked]:font-medium has-[:checked]:shadow-sm has-[:focus-visible]:ring-[3px]"
          >
            <input
              type="radio"
              class="sr-only"
              [name]="name"
              [value]="option.value"
              [checked]="theme.preference() === option.value"
              (change)="theme.choose(option.value)"
            />
            {{ option.label | transloco }}
          </label>
        }
      </div>
    </fieldset>
  `,
})
export class ThemeChoiceComponent {
  private static nextId = 0;

  protected readonly theme = inject(ThemeService);
  protected readonly options = OPTIONS;
  protected readonly name = `of-theme-${ThemeChoiceComponent.nextId++}`;
  protected readonly iconClass = `size-4 shrink-0 text-foreground ${themeIconMotion}`;
}
