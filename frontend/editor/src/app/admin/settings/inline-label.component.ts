import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardInputComponent } from '@openfolia/ui/input';

import { LABEL_MAX, labelProblem } from './config-model';

/**
 * A label read first and edited on demand: shown as text; where the person may edit, a click (or
 * Enter on it) turns it into a field in place. Enter or leaving the field keeps the new label
 * (`rename`, tidied; nothing when empty or unchanged), Escape puts the old one back. `edit()`
 * opens the field from elsewhere (a row's Rename).
 */
@Component({
  selector: 'of-inline-label',
  imports: [TranslocoPipe, ZardInputComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0' },
  template: `
    @if (editing()) {
      <input
        #field
        z-input
        class="h-8 min-w-0 flex-1"
        autocomplete="off"
        data-field="inline-label"
        [attr.maxlength]="max"
        [attr.aria-label]="ariaLabel()"
        [value]="label()"
        (keydown.enter)="refocus = true; $any($event.target).blur()"
        (keydown.escape)="cancel($event)"
        (blur)="commit($any($event.target).value)"
      />
    } @else if (editable()) {
      <button
        #shown
        type="button"
        class="hover:bg-muted focus-visible:ring-ring/50 -mx-1.5 min-w-0 cursor-text rounded-md px-1.5 py-0.5 text-start break-words transition-colors duration-150 outline-none focus-visible:ring-2 motion-reduce:transition-none"
        data-slot="inline-label"
        [attr.title]="'editor.admin.settings.option.clickToRename' | transloco"
        [attr.aria-label]="
          'editor.admin.settings.option.renameOf'
            | transloco: { label: label() }
        "
        (click)="edit()"
      >
        {{ label() }}
      </button>
    } @else {
      <span class="min-w-0 break-words" data-slot="inline-label">{{
        label()
      }}</span>
    }
  `,
})
export class InlineLabelComponent {
  private readonly injector = inject(Injector);

  readonly label = input.required<string>();
  readonly editable = input(false);
  /** The field's accessible name. */
  readonly ariaLabel = input('');
  readonly rename = output<string>();

  protected readonly max = LABEL_MAX;
  protected readonly editing = signal(false);
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');
  private readonly shown = viewChild<ElementRef<HTMLButtonElement>>('shown');
  private cancelled = false;
  /** Closed from the keyboard: focus goes back to the label. */
  protected refocus = false;

  /** Opens the field, its text selected. */
  edit(): void {
    if (!this.editable()) return;
    this.cancelled = false;
    this.editing.set(true);
    afterNextRender(
      () => {
        const el = this.field()?.nativeElement;
        el?.focus();
        el?.select();
      },
      { injector: this.injector },
    );
  }

  protected cancel(event: Event): void {
    event.stopPropagation();
    this.cancelled = true;
    this.refocus = true;
    this.close();
  }

  private close(): void {
    this.editing.set(false);
    if (!this.refocus) return;
    this.refocus = false;
    afterNextRender(() => this.shown()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected commit(value: string): void {
    if (!this.editing()) return;
    this.close();
    if (this.cancelled) return;
    const label = value.trim().replace(/\s+/g, ' ');
    if (labelProblem(label) === null && label !== this.label()) {
      this.rename.emit(label);
    }
  }
}
