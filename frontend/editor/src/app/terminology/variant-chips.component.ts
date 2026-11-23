import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX } from '@ng-icons/lucide';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardInputComponent } from '@openfolia/ui/input';

import {
  cleanLine,
  VARIANT_MAX,
  VARIANTS_MAX,
  variantProblem,
} from './terms-model';

/**
 * A term's variants in one language (allowed or forbidden) as chips. Typing and Enter adds one
 * (a pasted list is split at its line breaks, and what is typed is added when the field loses the
 * focus), Backspace in the empty field removes the last, each chip's button removes it (Tab
 * reaches it, Enter or Space presses it). A variant already there (case aside) is not added twice.
 * Every change is one `changed` with the whole list. Read-only, the chips stand alone.
 */
@Component({
  selector: 'of-variant-chips',
  imports: [
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardInputComponent,
    NgIcon,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideX })],
  host: { class: 'flex min-w-0 flex-col gap-1.5' },
  template: `
    @if (words().length > 0) {
      <ul
        class="m-0 flex min-w-0 list-none flex-wrap gap-1.5 p-0"
        [attr.aria-label]="label()"
        data-slot="variant-chips"
      >
        @for (w of words(); track w) {
          <li class="min-w-0">
            <z-badge
              [zType]="forbidden() ? 'outline' : 'secondary'"
              class="h-auto max-w-full gap-0.5 py-0.5 text-start font-normal whitespace-normal [overflow-wrap:anywhere]"
              [class.pe-0.5]="editable()"
              [class.line-through]="forbidden()"
              [class.decoration-1]="forbidden()"
            >
              <span class="min-w-0" [attr.lang]="lang() || null">{{ w }}</span>
              @if (editable()) {
                <button
                  z-button
                  zType="ghost"
                  zSize="icon-xs"
                  type="button"
                  class="size-4 shrink-0 rounded-sm no-underline"
                  data-slot="variant-remove"
                  [attr.aria-label]="
                    'editor.terminology.variants.remove'
                      | transloco: { term: w }
                  "
                  (click)="remove(w)"
                >
                  <ng-icon name="lucideX" class="size-3" aria-hidden="true" />
                </button>
              }
            </z-badge>
          </li>
        }
      </ul>
    } @else if (!editable()) {
      <p class="text-muted-foreground m-0 text-sm" data-slot="variant-none">
        {{ 'editor.terminology.variants.none' | transloco }}
      </p>
    }
    @if (editable()) {
      <input
        #field
        z-input
        autocomplete="off"
        data-slot="variant-input"
        [id]="inputId()"
        [attr.lang]="lang() || null"
        [attr.aria-label]="label()"
        [attr.aria-describedby]="inputId() + '-hint'"
        [attr.aria-invalid]="problem() ? 'true' : null"
        [placeholder]="'editor.terminology.variants.placeholder' | transloco"
        [value]="draft()"
        (input)="typed($any($event.target).value)"
        (paste)="pasted($event)"
        (keydown)="key($event)"
        (blur)="commit()"
      />
      <p
        class="text-muted-foreground m-0 text-xs break-words"
        [class.text-destructive]="!!problem()"
        [id]="inputId() + '-hint'"
        aria-live="polite"
      >
        @if (problem(); as p) {
          {{ p | transloco: { max: maxLength, count: maxCount } }}
        } @else {
          {{ 'editor.terminology.variants.hint' | transloco }}
        }
      </p>
    }
  `,
})
export class VariantChipsComponent {
  readonly words = input<readonly string[]>([]);
  /** The field's accessible name. */
  readonly label = input.required<string>();
  readonly inputId = input.required<string>();
  /** The language the variants are in (`lang` on them, for screen readers and spelling). */
  readonly lang = input('');
  readonly editable = input(false);
  /** Forbidden variants: struck through, outlined (the field's label says it in words). */
  readonly forbidden = input(false);
  /** Other words already used in the language (the preferred one): never added here. */
  readonly taken = input<readonly string[]>([]);
  readonly changed = output<readonly string[]>();

  protected readonly maxLength = VARIANT_MAX;
  protected readonly maxCount = VARIANTS_MAX;
  protected readonly draft = signal('');
  private readonly refused = signal<string | null>(null);
  private readonly field = viewChild('field', {
    read: ElementRef<HTMLInputElement>,
  });

  /** Why the last variant could not be added, or the one being typed is too long (a key). */
  readonly problem = computed(() =>
    cleanLine(this.draft()).length > VARIANT_MAX
      ? 'editor.terminology.variants.tooLong'
      : this.refused(),
  );

  protected typed(value: string): void {
    this.refused.set(null);
    this.draft.set(value);
  }

  /** A pasted list: each line is a variant; what cannot be added stays in the field. */
  protected pasted(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!/[\r\n]/.test(text)) return;
    event.preventDefault();
    const lines = text.split(/\r\n|\r|\n/);
    let words = this.words();
    for (let i = 0; i < lines.length; i++) {
      const next = this.adding(words, lines[i] ?? '');
      if (next === null) {
        this.emit(words);
        this.setDraft(lines.slice(i).join('\n').trim());
        return;
      }
      words = next;
    }
    this.emit(words);
    this.setDraft('');
  }

  protected key(event: KeyboardEvent): void {
    // An input method's Enter confirms what is being composed, nothing more.
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commit();
    } else if (
      event.key === 'Backspace' &&
      this.draft() === '' &&
      this.words().length > 0
    ) {
      event.preventDefault();
      this.emit(this.words().slice(0, -1));
      this.refused.set(null);
    }
  }

  /** Adds what is typed, if anything. */
  commit(): void {
    if (cleanLine(this.draft()) === '') return;
    const next = this.adding(this.words(), this.draft());
    if (next === null) return;
    this.emit(next);
    this.setDraft('');
  }

  protected remove(word: string): void {
    this.emit(this.words().filter((w) => w !== word));
    this.refused.set(null);
    this.field()?.nativeElement.focus();
  }

  /** `words` with `text` added (unchanged when it is there already), or null with the reason shown. */
  private adding(
    words: readonly string[],
    text: string,
  ): readonly string[] | null {
    const word = cleanLine(text);
    if (word === '') return words;
    const key = word.toLowerCase();
    const same = (w: string) => w.normalize('NFC').toLowerCase() === key;
    if (words.some(same)) return words;
    if (this.taken().some(same)) {
      this.refused.set('editor.terminology.variants.taken');
      return null;
    }
    const problem = variantProblem(word, words);
    if (problem) {
      this.refused.set(problem);
      return null;
    }
    return [...words, word];
  }

  private emit(words: readonly string[]): void {
    if (
      words.length === this.words().length &&
      words.every((w, i) => w === this.words()[i])
    )
      return;
    this.changed.emit(words);
  }

  private setDraft(value: string): void {
    this.draft.set(value);
    const el = this.field()?.nativeElement;
    if (el && el.value !== value) el.value = value;
  }
}
