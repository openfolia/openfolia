import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLanguages } from '@ng-icons/lucide';

import { LanguageService } from './language.service';

/**
 * The interface language as a segmented control of native radio buttons, the same look as
 * `of-theme-choice` (arrow keys move the choice, the group is one tab stop). Each language is
 * named in itself ("Deutsch"), so a person finds theirs whatever is on screen.
 */
@Component({
  selector: 'of-language-choice',
  imports: [NgIcon, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideLanguages })],
  host: { class: 'block' },
  template: `
    <fieldset class="flex flex-col gap-1.5">
      <legend
        class="text-muted-foreground mb-1.5 flex items-center gap-2 text-xs"
      >
        <ng-icon
          name="lucideLanguages"
          class="text-foreground size-4 shrink-0"
          aria-hidden="true"
        />
        {{ 'ui.language.label' | transloco }}
      </legend>
      <div class="bg-muted flex flex-wrap rounded-lg p-[3px]">
        @for (option of language.languages; track option.id) {
          <label
            class="text-foreground has-[:checked]:bg-background has-[:focus-visible]:ring-ring/50 relative flex h-7 flex-1 cursor-pointer items-center justify-center rounded-md px-2 text-sm whitespace-nowrap has-[:checked]:font-medium has-[:checked]:shadow-sm has-[:focus-visible]:ring-[3px]"
            [attr.lang]="option.id"
          >
            <input
              type="radio"
              class="sr-only"
              [name]="name"
              [value]="option.id"
              [checked]="language.active() === option.id"
              (change)="language.choose(option.id)"
            />
            {{ option.label }}
          </label>
        }
      </div>
    </fieldset>
  `,
})
export class LanguageChoiceComponent {
  private static nextId = 0;

  protected readonly language = inject(LanguageService);
  protected readonly name = `of-language-${LanguageChoiceComponent.nextId++}`;
}
