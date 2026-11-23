import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardCheckboxComponent } from '@openfolia/ui/checkbox';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardSelectImports } from '@openfolia/ui/select';
import { ZardTextareaComponent } from '@openfolia/ui/textarea';

import {
  type OptionField,
  type OptionProblem,
  type OptionValue,
  type OptionValues,
} from './options-schema';

/** One field changed. */
export interface OptionChange {
  readonly name: string;
  readonly value: OptionValue;
}

/**
 * An importer's options (#93), one field per property of its options schema (`optionFields`):
 * a text field, a checkbox, a select, or JSON for anything else, each with its label and
 * description; a field's problem shows under it once it was changed or the form was sent
 * (`showProblems`). Below them, always, "Update existing" (the upload's own field, not an
 * importer option): without it, what exists already is skipped.
 */
@Component({
  selector: 'of-import-options',
  imports: [
    FormsModule,
    TranslocoPipe,
    ZardCheckboxComponent,
    ZardInputComponent,
    ZardSelectImports,
    ZardTextareaComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-4', 'data-slot': 'options' },
  template: `
    @for (f of fields(); track f.name) {
      @let problem = shownProblem(f.name);
      @let id = 'import-option-' + $index;
      <div class="flex min-w-0 flex-col gap-1.5" [attr.data-option]="f.name">
        @switch (f.kind) {
          @case ('boolean') {
            <z-checkbox
              class="min-w-0 break-words"
              [zId]="id"
              [zDisabled]="disabled()"
              [ngModel]="values()[f.name] === true"
              [ngModelOptions]="{ standalone: true }"
              (checkChange)="optionChange.emit({ name: f.name, value: $event })"
              >{{ f.label }}</z-checkbox
            >
          }
          @case ('select') {
            <span class="text-sm font-medium break-words" aria-hidden="true">{{
              f.label
            }}</span>
            <z-select
              [attr.id]="id"
              [zAriaLabel]="f.label"
              [zDisabled]="disabled()"
              [zValue]="textOf(f.name)"
              [zPlaceholder]="'editor.admin.import.options.choose' | transloco"
              (zSelectionChange)="
                optionChange.emit({ name: f.name, value: $any($event) })
              "
            >
              @for (c of f.choices; track c) {
                <z-select-item [zValue]="c">{{ c }}</z-select-item>
              }
            </z-select>
          }
          @case ('json') {
            <label class="text-sm font-medium break-words" [for]="id">{{
              f.label
            }}</label>
            <textarea
              z-textarea
              class="min-h-20 font-mono text-[0.8125rem]"
              spellcheck="false"
              [id]="id"
              [disabled]="disabled()"
              [attr.aria-invalid]="problem ? 'true' : null"
              [attr.aria-describedby]="describedBy(f, id, problem)"
              [value]="textOf(f.name)"
              (input)="
                optionChange.emit({
                  name: f.name,
                  value: $any($event.target).value,
                })
              "
            ></textarea>
          }
          @default {
            <label class="text-sm font-medium break-words" [for]="id">{{
              f.label
            }}</label>
            <input
              z-input
              type="text"
              [id]="id"
              [disabled]="disabled()"
              [attr.aria-invalid]="problem ? 'true' : null"
              [attr.aria-required]="f.required ? 'true' : null"
              [attr.aria-describedby]="describedBy(f, id, problem)"
              [value]="textOf(f.name)"
              (input)="
                optionChange.emit({
                  name: f.name,
                  value: $any($event.target).value,
                })
              "
            />
          }
        }
        @if (f.description) {
          <p
            class="text-muted-foreground m-0 text-xs break-words"
            [id]="id + '-hint'"
          >
            {{ f.description }}
            @if (f.kind === 'json') {
              {{ 'editor.admin.import.options.jsonHint' | transloco }}
            }
          </p>
        } @else if (f.kind === 'json') {
          <p
            class="text-muted-foreground m-0 text-xs break-words"
            [id]="id + '-hint'"
          >
            {{ 'editor.admin.import.options.jsonHint' | transloco }}
          </p>
        }
        @if (problem) {
          <p
            class="text-destructive m-0 text-xs break-words"
            role="alert"
            [id]="id + '-problem'"
            data-slot="option-problem"
          >
            {{ problem | transloco }}
          </p>
        }
      </div>
    }

    <div class="flex min-w-0 flex-col gap-0.5">
      <z-checkbox
        class="min-w-0 break-words"
        zId="import-update-existing"
        data-slot="update-existing"
        [zDisabled]="disabled()"
        [ngModel]="updateExisting()"
        [ngModelOptions]="{ standalone: true }"
        (checkChange)="updateExistingChange.emit($event)"
        >{{
          'editor.admin.import.options.updateExisting' | transloco
        }}</z-checkbox
      >
      <p class="text-muted-foreground m-0 ms-6 text-xs break-words">
        {{ 'editor.admin.import.options.updateExistingHint' | transloco }}
      </p>
    </div>
  `,
})
export class ImportOptionsComponent {
  readonly fields = input.required<readonly OptionField[]>();
  readonly values = input.required<OptionValues>();
  readonly problems = input<Readonly<Record<string, OptionProblem>>>({});
  /** The fields whose problem shows: changed ones, or all once the form was sent. */
  readonly shown = input<ReadonlySet<string> | 'all'>(new Set());
  readonly updateExisting = input(false);
  readonly disabled = input(false);

  readonly optionChange = output<OptionChange>();
  readonly updateExistingChange = output<boolean>();

  private readonly visible = computed(() => {
    const shown = this.shown();
    const problems = this.problems();
    return (name: string): OptionProblem | null =>
      shown === 'all' || shown.has(name) ? (problems[name] ?? null) : null;
  });

  protected shownProblem(name: string): OptionProblem | null {
    return this.visible()(name);
  }

  protected textOf(name: string): string {
    const value = this.values()[name];
    return typeof value === 'string' ? value : '';
  }

  protected describedBy(
    field: OptionField,
    id: string,
    problem: OptionProblem | null,
  ): string | null {
    const ids = [
      ...(field.description || field.kind === 'json' ? [`${id}-hint`] : []),
      ...(problem ? [`${id}-problem`] : []),
    ];
    return ids.length > 0 ? ids.join(' ') : null;
  }
}
