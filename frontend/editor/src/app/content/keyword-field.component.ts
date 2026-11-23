import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  input,
  model,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX } from '@ng-icons/lucide';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardInputComponent } from '@openfolia/ui/input';

/** As the content model has them (`Keyword`, `MAX_KEYWORDS`). */
export const KEYWORD_MAX_LENGTH = 64;
export const KEYWORDS_MAX = 32;

/** A keyword as stored: NFC, runs of whitespace as one space, trimmed. */
export function cleanKeyword(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Why a keyword cannot be added (a key), or null: too long, or one too many. */
export function keywordProblem(
  keyword: string,
  keywords: readonly string[],
): string | null {
  if (keyword.length > KEYWORD_MAX_LENGTH) {
    return 'editor.keywords.tooLong';
  }
  if (keywords.length >= KEYWORDS_MAX) return 'editor.keywords.tooMany';
  // A control character (only a paste brings one).
  if (/\p{Cc}/u.test(keyword)) return 'editor.keywords.invalid';
  return null;
}

/** `keywords` with `added` at the end, unless one of them is it already (case aside). */
export function withKeyword(
  keywords: readonly string[],
  added: string,
): readonly string[] {
  const key = added.toLowerCase();
  return keywords.some((k) => k.normalize('NFC').toLowerCase() === key)
    ? keywords
    : [...keywords, added];
}

/**
 * Free-form keywords as chips: typing and Enter or a comma adds one (a pasted list is split at its
 * commas, and what is typed is added when the field loses the focus), Backspace in the empty field
 * removes the last, each chip's button removes it. A keyword already there (case aside) is not
 * added twice. Enter in the empty field is left alone, so it still submits a form around it.
 */
@Component({
  selector: 'of-keyword-field',
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
    @if (keywords().length > 0) {
      <ul
        class="m-0 flex min-w-0 list-none flex-wrap gap-1.5 p-0"
        [attr.aria-label]="label()"
      >
        @for (k of keywords(); track k) {
          <li class="min-w-0">
            <z-badge
              zType="secondary"
              class="h-auto max-w-full gap-0.5 py-0.5 pe-0.5 text-start whitespace-normal [overflow-wrap:anywhere]"
            >
              <span class="min-w-0">{{ k }}</span>
              <button
                z-button
                zType="ghost"
                zSize="icon-xs"
                type="button"
                class="size-4 shrink-0 rounded-sm"
                [attr.aria-label]="
                  'editor.keywords.remove' | transloco: { keyword: k }
                "
                (click)="remove(k)"
              >
                <ng-icon name="lucideX" class="size-3" aria-hidden="true" />
              </button>
            </z-badge>
          </li>
        }
      </ul>
    }
    <input
      #field
      z-input
      autocomplete="off"
      [id]="inputId()"
      [attr.aria-label]="label()"
      [attr.aria-describedby]="inputId() + '-hint'"
      [attr.aria-invalid]="problem() ? 'true' : null"
      [placeholder]="'editor.keywords.placeholder' | transloco"
      [value]="draft()"
      (input)="typed($any($event.target).value)"
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
        {{ 'editor.keywords.hint' | transloco }}
      }
    </p>
  `,
})
export class KeywordFieldComponent {
  readonly keywords = model<readonly string[]>([]);
  /** The field's accessible name. */
  readonly label = input.required<string>();
  readonly inputId = input('keywords');

  protected readonly maxLength = KEYWORD_MAX_LENGTH;
  protected readonly maxCount = KEYWORDS_MAX;
  protected readonly draft = signal('');
  private readonly refused = signal<string | null>(null);
  private readonly field = viewChild('field', {
    read: ElementRef<HTMLInputElement>,
  });

  /** Why the last keyword could not be added, or the one being typed is too long (a key). */
  readonly problem = computed(() =>
    cleanKeyword(this.draft()).length > KEYWORD_MAX_LENGTH
      ? 'editor.keywords.tooLong'
      : this.refused(),
  );

  protected typed(value: string): void {
    this.refused.set(null);
    if (value.includes(',')) {
      // Every piece before the last comma is done; the rest is still being typed.
      const parts = value.split(',');
      const rest = parts.pop() ?? '';
      for (let i = 0; i < parts.length; i++) {
        if (!this.add(parts[i] ?? '')) {
          // Keep what could not be added, so nothing typed is lost.
          const kept = parts.slice(i).join(',');
          this.setDraft(rest === '' ? kept : `${kept},${rest}`);
          return;
        }
      }
      this.setDraft(rest);
      return;
    }
    this.draft.set(value);
  }

  protected key(event: KeyboardEvent): void {
    // An input method's Enter confirms what is being composed, nothing more.
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      if (cleanKeyword(this.draft()) === '') return; // the form's Enter
      event.preventDefault();
      this.commit();
    } else if (
      event.key === 'Backspace' &&
      this.draft() === '' &&
      this.keywords().length > 0
    ) {
      event.preventDefault();
      this.keywords.update((all) => all.slice(0, -1));
      this.refused.set(null);
    }
  }

  /** Adds what is typed, if anything. */
  commit(): void {
    if (cleanKeyword(this.draft()) === '') return;
    // As if a comma ended it: every piece is added, or kept when it cannot be.
    this.typed(`${this.draft()},`);
  }

  protected remove(keyword: string): void {
    this.keywords.update((all) => all.filter((k) => k !== keyword));
    this.refused.set(null);
    this.field()?.nativeElement.focus();
  }

  /** Adds one keyword; false (with the reason shown) when it cannot be. */
  private add(text: string): boolean {
    const keyword = cleanKeyword(text);
    if (keyword === '') return true;
    const next = withKeyword(this.keywords(), keyword);
    if (next === this.keywords()) return true; // there already
    const problem = keywordProblem(keyword, this.keywords());
    if (problem) {
      this.refused.set(problem);
      return false;
    }
    this.keywords.set(next);
    return true;
  }

  private setDraft(value: string): void {
    this.draft.set(value);
    const el = this.field()?.nativeElement;
    if (el && el.value !== value) el.value = value;
  }
}
