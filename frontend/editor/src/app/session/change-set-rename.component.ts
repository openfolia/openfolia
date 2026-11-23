import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  input,
  linkedSignal,
  output,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardTextareaComponent } from '@openfolia/ui/textarea';

import { DESCRIPTION_MAX, TITLE_MAX } from './change-set-session';

/** What a rename sets: the title, and the description (null clears it). */
export interface ChangeSetRename {
  readonly title: string;
  readonly description: string | null;
}

/**
 * The inline form that renames a change set: its title and its description, filled in with what
 * they are now. Save is offered once something differs and the title is not blank; Escape or
 * Cancel leaves it as it was. Used in the header's change-set control (in a popover) and in the
 * review panel (in place of the details it edits).
 */
@Component({
  selector: 'of-change-set-rename',
  imports: [
    TranslocoPipe,
    ZardButtonComponent,
    ZardInputComponent,
    ZardTextareaComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <form
      class="flex flex-col gap-3"
      (submit)="submit($event)"
      (keydown.escape)="escape($event)"
    >
      <label class="flex flex-col gap-1.5 text-sm">
        {{ 'editor.changeSet.titleField' | transloco }}
        <input
          #titleInput
          z-input
          required
          [attr.maxlength]="titleMax"
          autocomplete="off"
          [value]="draftTitle()"
          (input)="draftTitle.set($any($event.target).value)"
        />
      </label>
      <label class="flex flex-col gap-1.5 text-sm">
        {{ 'editor.changeSet.descriptionField' | transloco }}
        <textarea
          z-textarea
          rows="3"
          class="min-h-20 resize-y"
          [attr.maxlength]="descriptionMax"
          [placeholder]="'editor.changeSet.descriptionHint' | transloco"
          [value]="draftDescription()"
          (input)="draftDescription.set($any($event.target).value)"
        ></textarea>
      </label>
      <div class="flex flex-wrap justify-end gap-2">
        <button
          z-button
          zType="outline"
          type="button"
          (click)="dismissed.emit()"
        >
          {{ 'ui.dialog.cancel' | transloco }}
        </button>
        <button z-button type="submit" [zDisabled]="!canSave()">
          {{ 'editor.changeSet.renameSave' | transloco }}
        </button>
      </div>
    </form>
  `,
})
export class ChangeSetRenameComponent {
  /** The title now. */
  readonly title = input.required<string>();
  /** The description now (null: none). */
  readonly description = input<string | null>(null);

  readonly save = output<ChangeSetRename>();
  readonly dismissed = output<void>();

  protected readonly titleMax = TITLE_MAX;
  protected readonly descriptionMax = DESCRIPTION_MAX;
  protected readonly draftTitle = linkedSignal(() => this.title());
  protected readonly draftDescription = linkedSignal(
    () => this.description() ?? '',
  );
  // `z-input` is a component: read the element, not the component.
  private readonly titleInput = viewChild<string, ElementRef<HTMLInputElement>>(
    'titleInput',
    { read: ElementRef },
  );

  protected readonly canSave = computed(() => {
    const title = this.draftTitle().trim();
    const description = this.draftDescription().trim() || null;
    return (
      title.length > 0 &&
      (title !== this.title() || description !== this.description())
    );
  });

  constructor() {
    afterNextRender(() => {
      const field = this.titleInput()?.nativeElement;
      field?.focus();
      field?.select();
    });
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (!this.canSave()) return;
    this.save.emit({
      title: this.draftTitle().trim(),
      description: this.draftDescription().trim() || null,
    });
  }

  protected escape(event: Event): void {
    event.stopPropagation();
    this.dismissed.emit();
  }
}
