import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { ProjectConfig } from '@openfolia/content-model/core';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { ZardInputComponent } from '@openfolia/ui/input';

import { MODULE_ID, MODULE_ID_MAX, moduleIdOf } from '../content/module-id';

const TITLE_MAX = 200;

/** What "Save as snippet" asks for: the snippet's title, its type and its ID. */
export interface SnippetDetails {
  readonly title: string;
  readonly type: string;
  readonly id: string;
}

/** What the dialog is opened with: the snippet types to choose from and the edited module. */
export interface SnippetDialogRequest {
  /** The configured snippet types (`snippet: true`), in their order. */
  readonly types: ProjectConfig['moduleTypes'];
  /** The edited module's ID: a snippet can't take it. */
  readonly moduleId: string;
}

/**
 * "Save as snippet" (#309): the new snippet's title, its type (one of the snippet types,
 * preselected when there is only one) and its ID, made from the title as the new-module dialog
 * makes it until the person types one of their own. `open()` resolves to the details, or null
 * when cancelled, once the dialog has closed and the focus is back where it was.
 */
@Component({
  selector: 'of-save-snippet-dialog',
  imports: [
    ZardDialogImports,
    ZardButtonComponent,
    ZardInputComponent,
    CollapseComponent,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <z-dialog
      [zVisible]="visible()"
      (zVisibleChange)="$event || cancel()"
      (zAfterClose)="closed()"
      class="sm:max-w-[32rem]"
    >
      <z-dialog-header>
        <z-dialog-title>{{
          'editor.moduleEditor.saveSnippet.title' | transloco
        }}</z-dialog-title>
        <z-dialog-description>{{
          'editor.moduleEditor.saveSnippet.description' | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      @if (request(); as r) {
        <form
          id="save-snippet-form"
          class="flex flex-col gap-4"
          novalidate
          (submit)="submit($event)"
        >
          <div class="flex flex-col gap-1.5">
            <label class="text-sm" for="save-snippet-title">{{
              'editor.moduleEditor.saveSnippet.titleField' | transloco
            }}</label>
            <input
              id="save-snippet-title"
              z-input
              autocomplete="off"
              required
              [attr.maxlength]="titleMax"
              [attr.aria-invalid]="titleError() ? 'true' : null"
              [attr.aria-describedby]="
                titleError() ? 'save-snippet-title-problem' : null
              "
              [value]="title()"
              (input)="title.set($any($event.target).value)"
            />
            <of-collapse class="-mt-1" [open]="!!titleError()">
              <p
                id="save-snippet-title-problem"
                class="text-destructive m-0 pt-1 text-xs"
              >
                @if (titleError(); as key) {
                  {{ key | transloco }}
                }
              </p>
            </of-collapse>
          </div>

          @if (r.types.length > 1) {
            <fieldset class="m-0 flex flex-col gap-1.5 border-0 p-0">
              <legend class="mb-1.5 p-0 text-sm">
                {{ 'editor.moduleEditor.saveSnippet.type' | transloco }}
              </legend>
              <div class="flex flex-wrap gap-2" data-slot="snippet-types">
                @for (t of r.types; track t.id) {
                  <button
                    z-button
                    zType="outline"
                    type="button"
                    [attr.aria-pressed]="type() === t.id"
                    [attr.data-type]="t.id"
                    [class]="
                      type() === t.id
                        ? 'bg-muted border-foreground/40 font-medium'
                        : ''
                    "
                    (click)="type.set(t.id)"
                  >
                    {{ t.label }}
                  </button>
                }
              </div>
              <of-collapse [open]="typeMissing()">
                <p class="text-destructive m-0 text-xs">
                  {{
                    'editor.moduleEditor.saveSnippet.typeMissing' | transloco
                  }}
                </p>
              </of-collapse>
            </fieldset>
          } @else {
            <p class="text-muted-foreground m-0 text-sm break-words">
              {{
                'editor.moduleEditor.saveSnippet.onlyType'
                  | transloco: { label: r.types[0]?.label ?? '' }
              }}
            </p>
          }

          <div class="flex flex-col gap-1.5">
            <label class="text-sm" for="save-snippet-id">{{
              'editor.moduleEditor.saveSnippet.id' | transloco
            }}</label>
            <input
              id="save-snippet-id"
              z-input
              class="font-mono"
              autocomplete="off"
              spellcheck="false"
              [attr.maxlength]="idMax"
              [attr.aria-invalid]="idError() ? 'true' : null"
              aria-describedby="save-snippet-id-hint"
              [value]="id()"
              (input)="typedId.set($any($event.target).value)"
            />
            <p
              id="save-snippet-id-hint"
              class="text-muted-foreground m-0 text-xs break-words"
              [class.text-destructive]="!!idError()"
              aria-live="polite"
            >
              {{
                idError() ?? 'editor.moduleEditor.saveSnippet.idHint'
                  | transloco
              }}
            </p>
          </div>
        </form>
      }
      <z-dialog-footer>
        <button z-button zType="ghost" type="button" (click)="cancel()">
          {{ 'editor.moduleEditor.saveSnippet.cancel' | transloco }}
        </button>
        <button
          z-button
          type="submit"
          form="save-snippet-form"
          data-slot="save-snippet-submit"
        >
          {{ 'editor.moduleEditor.saveSnippet.save' | transloco }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class SaveSnippetDialogComponent {
  protected readonly titleMax = TITLE_MAX;
  protected readonly idMax = MODULE_ID_MAX;

  protected readonly visible = signal(false);
  protected readonly request = signal<SnippetDialogRequest | null>(null);
  protected readonly title = signal('');
  protected readonly type = signal('');
  /** The ID as typed; null while it follows the title. */
  protected readonly typedId = signal<string | null>(null);
  private readonly submitted = signal(false);

  private resolve: ((details: SnippetDetails | null) => void) | null = null;
  private answerWith: SnippetDetails | null = null;

  protected readonly id = computed(
    () => this.typedId() ?? moduleIdOf(this.title()),
  );

  protected readonly titleError = computed((): string | null =>
    this.submitted() && this.title().trim() === ''
      ? 'editor.moduleEditor.saveSnippet.titleMissing'
      : null,
  );
  protected readonly typeMissing = computed(
    () => this.submitted() && !this.type(),
  );
  /** Why the ID can't be taken (a translation key), or null. */
  protected readonly idError = computed((): string | null => {
    const id = this.id();
    if (id === '') {
      return this.submitted() || this.typedId() !== null
        ? 'editor.moduleEditor.saveSnippet.idMissing'
        : null;
    }
    if (!MODULE_ID.test(id) || id.length > MODULE_ID_MAX)
      return 'editor.moduleEditor.saveSnippet.idInvalid';
    if (id === this.request()?.moduleId)
      return 'editor.moduleEditor.saveSnippet.idSelf';
    return null;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.answer(null));
  }

  /**
   * Opens the dialog and resolves to the snippet's details, or null when cancelled. Opening again
   * while open answers the earlier call with null.
   */
  open(request: SnippetDialogRequest): Promise<SnippetDetails | null> {
    this.answer(null);
    this.request.set(request);
    this.title.set('');
    this.type.set(request.types.length === 1 ? request.types[0]!.id : '');
    this.typedId.set(null);
    this.submitted.set(false);
    this.visible.set(true);
    return new Promise((resolve) => (this.resolve = resolve));
  }

  protected submit(event: Event): void {
    event.preventDefault();
    this.submitted.set(true);
    if (this.titleError() || this.typeMissing() || this.idError()) return;
    this.answerWith = {
      title: this.title().trim().replace(/\s+/g, ' '),
      type: this.type(),
      id: this.id(),
    };
    this.visible.set(false);
  }

  protected cancel(): void {
    this.answerWith = null;
    this.visible.set(false);
  }

  /** Closed (and the focus back): the answer goes out now. */
  protected closed(): void {
    const details = this.answerWith;
    this.answerWith = null;
    this.answer(details);
  }

  private answer(details: SnippetDetails | null): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(details);
  }
}
