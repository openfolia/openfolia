import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideSend } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardTextareaComponent } from '@openfolia/ui/textarea';

import { DESCRIPTION_MAX } from '../session/change-set-session';

/**
 * A contributor's suggestion (#137), beside the focused module editor: "What did you change?"
 * (required; kept as the change set's description, so it survives a reload, and sent as the
 * submit's comment) and "Submit for review", which makes a save point and submits in one step.
 * The page owns the state: this shows it and says what the person did.
 */
@Component({
  selector: 'of-suggestion-panel',
  imports: [TranslocoPipe, NgIcon, ZardButtonComponent, ZardTextareaComponent],
  viewProviders: [provideIcons({ lucideSend })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section
      class="border-border bg-card flex flex-col gap-3 rounded-2xl border p-3.5"
      data-slot="suggestion-panel"
      aria-labelledby="of-suggestion-heading"
    >
      <div class="flex flex-col gap-1">
        <h2
          id="of-suggestion-heading"
          class="m-0 text-sm leading-5 font-medium"
        >
          {{ 'editor.suggestion.heading' | transloco }}
        </h2>
        <p
          class="text-muted-foreground m-0 text-[0.8125rem] leading-5 break-words"
        >
          {{ 'editor.suggestion.hint' | transloco }}
        </p>
      </div>
      <label class="flex flex-col gap-1.5 text-sm">
        <span>
          {{ 'editor.suggestion.note' | transloco }}
          <span class="text-muted-foreground text-xs">{{
            'editor.suggestion.required' | transloco
          }}</span>
        </span>
        <textarea
          #noteField
          z-textarea
          rows="4"
          required
          class="min-h-24 resize-y"
          name="suggestion-note"
          [attr.maxlength]="noteMax"
          [attr.aria-invalid]="missing() || null"
          [attr.aria-describedby]="missing() ? 'of-suggestion-missing' : null"
          [placeholder]="'editor.suggestion.notePlaceholder' | transloco"
          [disabled]="submitting()"
          [value]="note()"
          (input)="noteChange.emit($any($event.target).value)"
          (blur)="noteDone.emit()"
        ></textarea>
      </label>
      @if (missing()) {
        <p
          id="of-suggestion-missing"
          class="text-destructive m-0 text-xs leading-5 break-words"
          role="alert"
        >
          {{ 'editor.suggestion.noteMissing' | transloco }}
        </p>
      }
      <button
        z-button
        type="button"
        class="self-start"
        data-slot="suggestion-submit"
        [zLoading]="submitting()"
        [zDisabled]="submitting() || !!blocked()"
        [attr.title]="blocked() ? (blocked()! | transloco) : null"
        (click)="submitted.emit()"
      >
        @if (!submitting()) {
          <ng-icon
            name="lucideSend"
            data-icon="inline-start"
            aria-hidden="true"
          />
        }
        {{
          (submitting()
            ? 'editor.suggestion.submitting'
            : 'editor.suggestion.submit'
          ) | transloco
        }}
      </button>
      @if (blocked(); as reason) {
        <p class="text-muted-foreground m-0 text-xs leading-5 break-words">
          {{ reason | transloco }}
        </p>
      }
    </section>
  `,
})
export class SuggestionPanelComponent {
  /** What the person wrote so far. */
  readonly note = input('');
  /** Submit was asked with no note: the field says it is needed. */
  readonly missing = input(false);
  /** The save point and the submit are on their way. */
  readonly submitting = input(false);
  /** Why Submit cannot go now (a translation key: the text not saved yet), or null. */
  readonly blocked = input<string | null>(null);

  readonly noteChange = output<string>();
  /** The field lost the focus: a moment to keep the note. */
  readonly noteDone = output<void>();
  readonly submitted = output<void>();

  protected readonly noteMax = DESCRIPTION_MAX;
  private readonly field = viewChild.required<
    string,
    ElementRef<HTMLTextAreaElement>
  >('noteField', {
    read: ElementRef,
  });

  /** Puts the caret in the note (Submit without one). */
  focusNote(): void {
    this.field().nativeElement.focus();
  }
}
