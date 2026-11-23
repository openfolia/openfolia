import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
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
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideCircleAlert } from '@ng-icons/lucide';

import { CollapseComponent } from '@openfolia/ui/collapse';
import { LanguageService } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';

import { languageName } from '../content/browser-model';
import type { ProjectLanguages } from '../i18n/ui-texts';

/** One text as typed: trimmed, its runs of white space one space. */
export function tidyText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * `text` with its version in `lang` set to `value` as a form holds it while it is typed (#731): the
 * source language's may be empty for now (the form refuses it on submit), another language's
 * empty is none (it falls back to the source language's).
 */
export function typedTextIn(
  text: LocalizedText,
  lang: string,
  source: string,
  value: string,
): LocalizedText {
  if (lang !== source) return withTextIn(text, lang, source, value);
  if (typeof text === 'string') return value;
  return { ...text, [source]: value };
}

/**
 * A text the project writes per language (#731: a configured label, a manual's or a group's
 * title), one field per configured language. The source language's field comes first and is
 * required; the other languages' fields sit behind "Other languages" (opened smoothly), each
 * optional: an empty one shows the source language's text as its placeholder, and its readers
 * get that text. A text never translated stays one text (`withTextIn`).
 *
 * `mode: 'change'` (settings that save as they change): a field is kept when it is left, tidied;
 * emptying the source language's is refused, the field put back and the reason shown. `mode:
 * 'input'` (a form saved by its own button): every keystroke is `changed`, as typed (the form
 * tidies and checks it on submit; `sourceError` shows its refusal). `showSource: false` leaves the
 * source language's field out, where the text is edited in place elsewhere (a list's row).
 */
@Component({
  selector: 'of-localized-text-fields',
  imports: [TranslocoPipe, NgIcon, CollapseComponent, ZardInputComponent],
  viewProviders: [provideIcons({ lucideChevronDown, lucideCircleAlert })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: '@container flex min-w-0 flex-col gap-1.5',
    'data-slot': 'localized-text',
  },
  template: `
    @if (showSource()) {
      @let src = languages().source;
      <label
        class="text-sm font-medium break-words"
        [attr.for]="idPrefix() + '-' + src"
        >{{
          (targets().length > 0
            ? 'editor.localizedText.sourceField'
            : 'editor.localizedText.onlyField'
          ) | transloco: { name: name(), language: languageLabel(src) }
        }}</label
      >
      @if (editable()) {
        <!-- Keyed by the resets: a refused text is drawn again from the saved one. -->
        @for (key of sourceKey(); track key) {
          <input
            z-input
            autocomplete="off"
            dir="auto"
            [attr.maxlength]="maxlength()"
            [attr.lang]="src"
            [attr.data-lang]="src"
            [attr.aria-invalid]="sourceInvalid() ? true : null"
            [attr.aria-describedby]="
              sourceInvalid() ? idPrefix() + '-source-error' : null
            "
            [id]="idPrefix() + '-' + src"
            [value]="valueIn(src)"
            (input)="typed(src, $event)"
            (change)="committed(src, $event)"
            (keydown.enter)="enter($event)"
          />
        }
      } @else {
        <p
          class="m-0 text-sm break-words"
          dir="auto"
          [attr.lang]="src"
          [attr.data-lang]="src"
        >
          {{ valueIn(src) }}
        </p>
      }
      @if (sourceInvalid()) {
        <p
          class="text-destructive m-0 flex items-start gap-1.5 text-xs break-words"
          data-slot="localized-text-error"
          [id]="idPrefix() + '-source-error'"
        >
          <ng-icon
            name="lucideCircleAlert"
            class="mt-px shrink-0"
            aria-hidden="true"
          />
          {{
            'editor.localizedText.sourceRequired'
              | transloco: { language: languageLabel(src) }
          }}
        </p>
      }
    }
    @if (targets().length > 0 && collapsible()) {
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -mx-1 flex min-w-0 items-center gap-1.5 self-start rounded-md px-1 py-0.5 text-start text-xs transition-colors duration-150 outline-none focus-visible:ring-2 motion-reduce:transition-none"
        data-slot="localized-text-toggle"
        [attr.aria-expanded]="open()"
        [attr.aria-controls]="idPrefix() + '-targets'"
        (click)="open.set(!open())"
      >
        <ng-icon
          name="lucideChevronDown"
          size="14"
          aria-hidden="true"
          class="shrink-0 transition-transform duration-200 motion-reduce:transition-none"
          [class.rotate-180]="open()"
        />
        <span class="min-w-0 break-words">{{
          'editor.localizedText.otherLanguages'
            | transloco: { given: given(), total: targets().length }
        }}</span>
      </button>
    }
    @if (targets().length > 0) {
      <of-collapse
        [open]="open() || !collapsible()"
        [attr.id]="idPrefix() + '-targets'"
      >
        <div class="flex min-w-0 flex-col gap-2 pt-1 pb-0.5">
          <div class="grid min-w-0 gap-x-4 gap-y-2 @lg:grid-cols-2">
            @for (field of fields(); track field.key) {
              @let lang = field.lang;
              <div class="flex min-w-0 flex-col gap-1">
                <label
                  class="text-muted-foreground text-xs break-words"
                  [attr.for]="idPrefix() + '-' + lang"
                  >{{
                    'editor.localizedText.targetField'
                      | transloco
                        : { name: name(), language: languageLabel(lang) }
                  }}</label
                >
                @if (editable()) {
                  <input
                    z-input
                    autocomplete="off"
                    dir="auto"
                    [attr.maxlength]="maxlength()"
                    [attr.lang]="lang"
                    [attr.data-lang]="lang"
                    [id]="idPrefix() + '-' + lang"
                    [placeholder]="sourceText()"
                    [value]="valueIn(lang)"
                    (input)="typed(lang, $event)"
                    (change)="committed(lang, $event)"
                    (keydown.enter)="enter($event)"
                  />
                } @else {
                  <p
                    class="m-0 text-sm break-words"
                    dir="auto"
                    [attr.lang]="lang"
                    [attr.data-lang]="lang"
                    [class.text-muted-foreground]="valueIn(lang) === ''"
                  >
                    {{ valueIn(lang) || sourceText() }}
                  </p>
                }
              </div>
            }
          </div>
          <p class="text-muted-foreground m-0 text-xs break-words">
            {{
              'editor.localizedText.fallbackHint'
                | transloco: { language: languageLabel(languages().source) }
            }}
          </p>
        </div>
      </of-collapse>
    }
  `,
})
export class LocalizedTextFieldsComponent {
  private readonly language = inject(LanguageService);

  readonly text = input.required<LocalizedText>();
  readonly languages = input.required<ProjectLanguages>();
  /** Makes the fields' IDs: `<idPrefix>-<lang>`; unique on the page. */
  readonly idPrefix = input.required<string>();
  /** What the text is, translated ("Label", "Title"), for the fields' labels. */
  readonly name = input.required<string>();
  readonly editable = input(true);
  readonly maxlength = input(500);
  readonly mode = input<'change' | 'input'>('change');
  readonly showSource = input(true);
  /** The form refused the source language's text (`mode: 'input'`). */
  readonly sourceError = input(false);
  /** The other languages' fields start open. */
  readonly startOpen = input(false);
  /** The other languages' fields open and close by a toggle; else they are always shown. */
  readonly collapsible = input(true);

  readonly changed = output<LocalizedText>();

  protected readonly open = signal(false);
  /** The source language's field was emptied and put back (`mode: 'change'`). */
  private readonly refused = signal(false);
  /** Bumps when a refused or unchanged text is put back: the fields are drawn again from `text`. */
  private readonly resets = signal(0);

  constructor() {
    let first = true;
    effect(() => {
      const start = this.startOpen();
      if (first) untracked(() => this.open.set(start));
      first = false;
    });
    // Another text (another row, a reload): an earlier refusal was about the old one.
    effect(() => {
      this.text();
      untracked(() => this.refused.set(false));
    });
  }

  /** The target languages, in the configuration's order, never the source language. */
  protected readonly targets = computed(() => {
    const { source, targets } = this.languages();
    return targets.filter((l) => l !== source);
  });

  protected readonly fields = computed(() => {
    const n = this.resets();
    return this.targets().map((lang) => ({ lang, key: `${lang}:${n}` }));
  });

  protected readonly sourceText = computed(
    () => sourceTextOf(this.text(), this.languages().source) ?? '',
  );

  /** How many target languages have a text of their own. */
  protected readonly given = computed(
    () =>
      this.targets().filter(
        (l) => !!ownTextIn(this.text(), l, this.languages().source),
      ).length,
  );

  protected readonly sourceInvalid = computed(
    () => this.refused() || this.sourceError(),
  );

  protected readonly sourceKey = computed(() => [this.resets()]);

  protected valueIn(lang: string): string {
    const source = this.languages().source;
    return lang === source
      ? this.sourceText()
      : (ownTextIn(this.text(), lang, source) ?? '');
  }

  protected languageLabel(lang: string): string {
    return `${languageName(this.language.locale(), lang)} (${lang})`;
  }

  protected typed(lang: string, event: Event): void {
    if (this.mode() !== 'input') return;
    const value = (event.target as HTMLInputElement).value;
    this.changed.emit(
      typedTextIn(this.text(), lang, this.languages().source, value),
    );
  }

  protected committed(lang: string, event: Event): void {
    if (this.mode() !== 'change') return;
    const value = tidyText((event.target as HTMLInputElement).value);
    const source = this.languages().source;
    if (lang === source && value === '') {
      this.refused.set(true);
      this.resets.update((n) => n + 1);
      return;
    }
    if (lang === source) this.refused.set(false);
    const next = withTextIn(this.text(), lang, source, value);
    if (JSON.stringify(next) === JSON.stringify(this.text())) {
      // Nothing changed (a text tidied back to itself): drawn again as saved.
      this.resets.update((n) => n + 1);
      return;
    }
    this.changed.emit(next);
  }

  /** Enter keeps the text (in a form, it submits as it would). */
  protected enter(event: Event): void {
    if (this.mode() === 'change') (event.target as HTMLInputElement).blur();
  }
}
