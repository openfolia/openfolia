import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardInputComponent } from '@openfolia/ui/input';

const TITLE_MAX = 200;

/**
 * The manual's title in the builder's header, renamed in place: `start()` (the header's "Rename")
 * turns it into a field; Enter or leaving the field saves, Escape cancels. Required and one line:
 * an empty title is refused on Enter with the reason and put back on leaving. Otherwise it shows
 * its projected content (the manual switcher), which gets the focus back after a rename from the
 * keyboard.
 */
@Component({
  selector: 'of-manual-title',
  imports: [TranslocoPipe, ZardInputComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex min-w-0 max-w-full flex-col' },
  template: `
    @if (editing()) {
      <input
        #field
        z-input
        data-testid="manual-title-input"
        class="h-auto w-[min(32rem,100%)] py-0.5 text-[1.75rem]/9 font-medium"
        autocomplete="off"
        [attr.maxlength]="max"
        [attr.aria-label]="'editor.manuals.rename.label' | transloco"
        [attr.aria-invalid]="empty() ? 'true' : null"
        [attr.aria-describedby]="empty() ? 'manual-title-error' : null"
        [value]="draft()"
        (input)="draft.set($any($event.target).value)"
        (keydown.enter)="$event.preventDefault(); save(true)"
        (keydown.escape)="$event.preventDefault(); cancel()"
        (blur)="save(false)"
      />
      @if (empty()) {
        <span
          id="manual-title-error"
          class="text-xs font-normal text-destructive"
          aria-live="polite"
          >{{ 'editor.manuals.rename.required' | transloco }}</span
        >
      }
    } @else {
      <ng-content />
    }
  `,
})
export class ManualTitleComponent {
  readonly title = input.required<string>();
  readonly rename = output<string>();

  protected readonly max = TITLE_MAX;
  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  private readonly tried = signal(false);
  private readonly field = viewChild<string, ElementRef<HTMLInputElement>>(
    'field',
    { read: ElementRef },
  );
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly clean = computed(() =>
    this.draft().replace(/\s+/g, ' ').trim(),
  );
  protected readonly empty = computed(
    () => this.tried() && this.clean() === '',
  );

  start(): void {
    this.draft.set(this.title());
    this.tried.set(false);
    this.editing.set(true);
    this.focusField = true;
  }

  /** Whether the field takes the focus once it is drawn (a start comes before its render). */
  private focusField = false;

  constructor() {
    afterRenderEffect(() => {
      const field = this.field()?.nativeElement;
      if (!field || !this.focusField) return;
      this.focusField = false;
      field.focus();
      field.select();
    });
  }

  /** Enter (`refuseEmpty`) keeps an empty field open with the reason; leaving it puts the title back. */
  protected save(refuseEmpty: boolean): void {
    if (!this.editing()) return;
    const title = this.clean().slice(0, TITLE_MAX);
    if (!title) {
      if (refuseEmpty) {
        this.tried.set(true);
        return;
      }
      this.editing.set(false);
      return;
    }
    this.finish(refuseEmpty);
    if (title !== this.title()) this.rename.emit(title);
  }

  protected cancel(): void {
    this.finish(true);
  }

  /** Back to the text; from the keyboard, the focus goes back to it too. */
  private finish(refocus: boolean): void {
    this.editing.set(false);
    if (refocus) {
      setTimeout(() =>
        this.host.nativeElement.querySelector('button')?.focus(),
      );
    }
  }
}
