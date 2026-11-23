import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import {
  type LocalizedText,
  ownTextIn,
  sourceTextOf,
  withTextIn,
} from '@openfolia/content-model/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { ZardInputComponent } from '@openfolia/ui/input';

import type { ProjectLanguages } from '../../i18n';
import {
  LocalizedTextFieldsComponent,
  typedTextIn,
} from '../../shared/localized-text-fields.component';
import {
  idProblem,
  keyFromLabel,
  LABEL_MAX,
  labelProblem,
} from './config-model';

/** Which ID rule a new option follows (`idProblem`'s list). */
export type NewOptionRule = Parameters<typeof idProblem>[0];

/** What the person asked to add. */
export interface NewOption {
  readonly id: string;
  /** One text, or one per language when other languages were given (#731). */
  readonly label: LocalizedText;
  /** The first value's label (a new facet), when asked for. */
  readonly first?: string;
}

const tidy = (text: string): string => text.trim().replace(/\s+/g, ' ');

/**
 * The Add dialog of a settings topic: the label, then the ID, made from the label as a slug until
 * typed and checked against the IDs already taken (fixed once added: content names it); for a
 * new facet also its first value. The topic adds what it hands over (`add`) at once, with Undo.
 */
@Component({
  selector: 'of-option-new-dialog',
  imports: [
    ZardDialogImports,
    ZardButtonComponent,
    ZardInputComponent,
    TranslocoPipe,
    LocalizedTextFieldsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <z-dialog
      [zVisible]="open()"
      (zVisibleChange)="$event || closed.emit()"
      class="sm:max-w-[28rem]"
    >
      <z-dialog-header>
        <z-dialog-title>{{ title() }}</z-dialog-title>
        <z-dialog-description>{{
          'editor.admin.settings.new.description' | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      @if (open()) {
        <form
          id="option-new-form"
          class="flex flex-col gap-4"
          novalidate
          (submit)="submit($event)"
        >
          <div class="flex flex-col gap-1.5">
            <label class="text-sm" for="option-new-label">{{
              'editor.admin.settings.option.newLabel' | transloco
            }}</label>
            <input
              id="option-new-label"
              z-input
              autocomplete="off"
              data-field="option-new-label"
              cdkFocusInitial
              [attr.maxlength]="labelMax"
              [attr.aria-invalid]="shown().label ? 'true' : null"
              [value]="label()"
              [attr.lang]="languages()?.source ?? null"
              (input)="setLabel($any($event.target).value)"
            />
            @if (shown().label; as p) {
              <p
                class="text-destructive m-0 text-xs"
                data-slot="option-new-label-problem"
              >
                {{ p | transloco }}
              </p>
            }
            @if (languages(); as langs) {
              <of-localized-text-fields
                idPrefix="option-new-label"
                mode="input"
                [text]="labelText()"
                [languages]="langs"
                [name]="'editor.admin.settings.option.labelName' | transloco"
                [showSource]="false"
                [maxlength]="labelMax"
                (changed)="labelText.set($event)"
              />
            }
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-sm" for="option-new-id">{{
              'editor.admin.settings.option.newId' | transloco
            }}</label>
            <input
              id="option-new-id"
              z-input
              autocomplete="off"
              spellcheck="false"
              class="font-mono"
              data-field="option-new-id"
              aria-describedby="option-new-id-hint"
              [attr.aria-invalid]="shown().id ? 'true' : null"
              [value]="id()"
              (input)="setId($any($event.target).value)"
            />
            <p
              id="option-new-id-hint"
              class="text-muted-foreground m-0 text-xs break-words"
              [class.text-destructive]="!!shown().id"
            >
              {{ shown().id ?? 'editor.admin.settings.new.idHint' | transloco }}
            </p>
          </div>
          @if (withFirst()) {
            <div class="flex flex-col gap-1.5">
              <label class="text-sm" for="option-new-first">{{
                'editor.admin.settings.facets.firstValue' | transloco
              }}</label>
              <input
                id="option-new-first"
                z-input
                autocomplete="off"
                data-field="option-new-first"
                [attr.maxlength]="labelMax"
                [attr.aria-invalid]="shown().first ? 'true' : null"
                [value]="first()"
                (input)="first.set($any($event.target).value)"
              />
              @if (shown().first; as p) {
                <p class="text-destructive m-0 text-xs">{{ p | transloco }}</p>
              }
            </div>
          }
        </form>
      }
      <z-dialog-footer>
        <button z-button zType="ghost" type="button" (click)="closed.emit()">
          {{ 'editor.admin.cancel' | transloco }}
        </button>
        <button
          z-button
          type="submit"
          form="option-new-form"
          data-slot="option-new-add"
        >
          {{ 'editor.admin.settings.option.add' | transloco }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class OptionNewDialogComponent {
  readonly open = input(false);
  /** The heading (translated). */
  readonly title = input('');
  readonly rule = input<NewOptionRule>('audiences');
  /** The IDs already taken in the list. */
  readonly taken = input<readonly string[]>([]);
  /** Asks for a first value too (a new facet). */
  readonly withFirst = input(false);
  /** The project's languages: the label may be given in each (#731). Null: one text. */
  readonly languages = input<ProjectLanguages | null>(null);

  readonly add = output<NewOption>();
  readonly closed = output<void>();

  protected readonly labelMax = LABEL_MAX;
  /** The label as typed, every language's (#731). */
  protected readonly labelText = signal<LocalizedText>('');
  /** The source language's label as typed. */
  protected readonly label = computed(() => {
    const text = this.labelText();
    const langs = this.languages();
    if (typeof text === 'string') return text;
    return (langs && sourceTextOf(text, langs.source)) ?? '';
  });
  protected readonly id = signal('');
  protected readonly first = signal('');
  private readonly idTyped = signal(false);
  private readonly tried = signal(false);

  private readonly problems = computed(() => ({
    label: labelProblem(this.label()),
    id: idProblem(this.rule(), this.id(), this.taken()),
    first: this.withFirst()
      ? (labelProblem(this.first()) ??
        (keyFromLabel(this.first()) === ''
          ? 'editor.admin.settings.problems.valueKey'
          : null))
      : null,
  }));
  /** An ID taken or malformed says so while typing; empty fields only once tried. */
  protected readonly shown = computed(() => {
    const p = this.problems();
    return this.tried()
      ? p
      : { label: null, id: this.id() === '' ? null : p.id, first: null };
  });

  constructor() {
    // Each opening starts empty.
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        this.labelText.set('');
        this.id.set('');
        this.first.set('');
        this.idTyped.set(false);
        this.tried.set(false);
      });
    });
  }

  protected setLabel(value: string): void {
    const langs = this.languages();
    this.labelText.set(
      langs
        ? typedTextIn(this.labelText(), langs.source, langs.source, value)
        : value,
    );
    if (this.idTyped()) return;
    this.id.set(
      this.rule() === 'codeLanguages'
        ? value.trim().toLowerCase().replace(/\s+/g, '-')
        : keyFromLabel(value),
    );
  }

  protected setId(value: string): void {
    this.idTyped.set(value !== '');
    this.id.set(value.trim());
  }

  /** The label tidied: each language's text, an empty one left out (#731). */
  private tidyLabel(): LocalizedText {
    const langs = this.languages();
    let label: LocalizedText = tidy(this.label());
    if (!langs) return label;
    const typed = this.labelText();
    for (const lang of langs.targets) {
      if (lang === langs.source) continue;
      const own = ownTextIn(typed, lang, langs.source);
      if (own) label = withTextIn(label, lang, langs.source, tidy(own));
    }
    return label;
  }

  protected submit(event: Event): void {
    event.preventDefault();
    this.tried.set(true);
    const p = this.problems();
    if (p.label || p.id || p.first) return;
    this.add.emit({
      id: this.id(),
      label: this.tidyLabel(),
      ...(this.withFirst() && { first: tidy(this.first()) }),
    });
  }
}
