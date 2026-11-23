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
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardSelectImports } from '@openfolia/ui/select';

import { ApiClient, type Schema } from '../api';
import { UiTexts } from '../i18n';

export type Deprecation = Schema<'Deprecation'>;

/** The longest reason the content model takes (`MAX_DEPRECATION_REASON_LENGTH`). */
export const MAX_REASON_LENGTH = 500;

/** How many candidates for a replacement are offered (one page of the list). */
export const REPLACEMENT_CANDIDATES = 200;

/** What the dialog deprecates. */
export interface DeprecateTarget {
  readonly kind: 'module' | 'manual';
  readonly id: string;
  readonly title: string;
}

/** A module or manual that may replace it. */
export interface Replacement {
  readonly id: string;
  readonly title: string;
}

/** The select's value for "no replacement". */
const NONE = '-';

/**
 * Deprecates a module or a manual (#266): a required reason, one line, and an optional
 * replacement chosen from the modules (or manuals) that are not deprecated themselves. It hands
 * the deprecation on (`confirm`); the page puts it into the content of its revision, where it is
 * saved, reviewed and merged like any edit. Undo is the page's toast, afterwards, not a question
 * here.
 */
@Component({
  selector: 'of-deprecate-dialog',
  imports: [
    ZardDialogImports,
    ZardButtonComponent,
    ZardInputComponent,
    ZardSelectImports,
    CollapseComponent,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <z-dialog
      [zVisible]="!!target()"
      (zVisibleChange)="$event || cancel()"
      class="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-[32rem]"
    >
      @if (target(); as t) {
        <z-dialog-header>
          <z-dialog-title class="break-words">{{
            'editor.deprecation.dialog.title' | transloco: { title: t.title }
          }}</z-dialog-title>
          <z-dialog-description class="break-words">{{
            (t.kind === 'module'
              ? 'editor.deprecation.dialog.moduleDescription'
              : 'editor.deprecation.dialog.manualDescription'
            ) | transloco
          }}</z-dialog-description>
        </z-dialog-header>
        <form
          id="deprecate-form"
          class="flex min-h-0 flex-col gap-4 overflow-y-auto"
          (submit)="$event.preventDefault(); submit()"
        >
          <div class="flex flex-col gap-1">
            <label for="deprecate-reason" class="text-sm font-medium">{{
              'editor.deprecation.dialog.reason' | transloco
            }}</label>
            <input
              id="deprecate-reason"
              z-input
              autocomplete="off"
              data-autofocus
              [attr.maxlength]="maxReason"
              [attr.aria-invalid]="showMissing() ? 'true' : null"
              aria-describedby="deprecate-reason-hint"
              [value]="reason()"
              (input)="reason.set($any($event.target).value)"
            />
            <p
              id="deprecate-reason-hint"
              class="text-muted-foreground m-0 text-xs"
            >
              {{ 'editor.deprecation.dialog.reasonHint' | transloco }}
            </p>
            <of-collapse [open]="showMissing()">
              <p class="text-destructive m-0 pt-1 text-xs" role="alert">
                {{ 'editor.deprecation.dialog.reasonMissing' | transloco }}
              </p>
            </of-collapse>
          </div>
          <div class="flex flex-col gap-1">
            <span
              id="deprecate-replacement-label"
              class="text-sm font-medium"
              >{{
                (t.kind === 'module'
                  ? 'editor.deprecation.dialog.replacementModule'
                  : 'editor.deprecation.dialog.replacementManual'
                ) | transloco
              }}</span
            >
            <z-select
              zPosition="popper"
              zSearchable
              data-slot="deprecate-replacement"
              [zAriaLabel]="
                (t.kind === 'module'
                  ? 'editor.deprecation.dialog.replacementModule'
                  : 'editor.deprecation.dialog.replacementManual'
                ) | transloco
              "
              [zDisabled]="candidatesState() !== 'ready'"
              [zValue]="replacement()"
              (zSelectionChange)="replacement.set(single($event))"
            >
              <z-select-item [zValue]="none">{{
                'editor.deprecation.dialog.noReplacement' | transloco
              }}</z-select-item>
              @for (c of candidates(); track c.id) {
                <z-select-item [zValue]="c.id">{{ c.title }}</z-select-item>
              }
            </z-select>
            <of-collapse [open]="candidatesState() === 'failed'">
              <p
                class="text-muted-foreground m-0 flex flex-wrap items-center gap-2 pt-1 text-xs"
              >
                {{ 'editor.deprecation.dialog.candidatesFailed' | transloco }}
                <button
                  z-button
                  zType="link"
                  zSize="xs"
                  type="button"
                  (click)="loadCandidates()"
                >
                  {{ 'ui.states.error.retry' | transloco }}
                </button>
              </p>
            </of-collapse>
          </div>
        </form>
        <z-dialog-footer>
          <button z-button zType="ghost" type="button" (click)="cancel()">
            {{ 'editor.deprecation.dialog.cancel' | transloco }}
          </button>
          <button
            z-button
            type="submit"
            form="deprecate-form"
            data-slot="deprecate-confirm"
          >
            {{ 'editor.deprecation.dialog.confirm' | transloco }}
          </button>
        </z-dialog-footer>
      }
    </z-dialog>
  `,
})
export class DeprecateDialogComponent {
  private readonly api = inject(ApiClient);
  private readonly texts = inject(UiTexts);

  /** What to deprecate; null: closed. */
  readonly target = input<DeprecateTarget | null>(null);
  readonly confirm = output<Deprecation>();
  readonly closed = output<void>();

  protected readonly none = NONE;
  protected readonly maxReason = MAX_REASON_LENGTH;
  protected readonly reason = signal('');
  protected readonly replacement = signal(NONE);
  protected readonly candidates = signal<readonly Replacement[]>([]);
  protected readonly candidatesState = signal<'loading' | 'ready' | 'failed'>(
    'loading',
  );
  private readonly tried = signal(false);
  private runs = 0;

  /** The reason as stored: one line, white space collapsed. */
  private readonly cleaned = computed(() =>
    this.reason().replace(/\s+/g, ' ').trim(),
  );
  protected readonly showMissing = computed(
    () => this.tried() && !this.cleaned(),
  );

  constructor() {
    // Every opening starts afresh.
    effect(() => {
      const t = this.target();
      untracked(() => {
        this.runs++;
        if (!t) return;
        this.reason.set('');
        this.replacement.set(NONE);
        this.tried.set(false);
        void this.loadCandidates();
      });
    });
  }

  protected single(value: string | string[]): string {
    return (Array.isArray(value) ? value[0] : value) || NONE;
  }

  /** The modules (or manuals) that may replace it: not itself, not deprecated themselves. */
  protected async loadCandidates(): Promise<void> {
    const t = this.target();
    if (!t) return;
    const run = this.runs;
    this.candidatesState.set('loading');
    try {
      const found: Replacement[] =
        t.kind === 'module'
          ? (
              await firstValueFrom(
                this.api.get('/module-summaries', {
                  query: {
                    'filter[deprecated]': 'false',
                    'page[number]': 1,
                    'page[size]': REPLACEMENT_CANDIDATES,
                  },
                }),
              )
            ).data.map((s) => ({ id: s.id, title: s.attributes.title }))
          : (
              await firstValueFrom(
                this.api.get('/manuals', {
                  query: {
                    'page[number]': 1,
                    'page[size]': REPLACEMENT_CANDIDATES,
                  },
                }),
              )
            ).data.flatMap((m) =>
              'attributes' in m && !m.attributes.deprecated
                ? [{ id: m.id, title: this.texts.text(m.attributes.title) }]
                : [],
            );
      if (run !== this.runs) return;
      this.candidates.set(found.filter((c) => c.id !== t.id));
      this.candidatesState.set('ready');
    } catch {
      if (run === this.runs) this.candidatesState.set('failed');
    }
  }

  protected submit(): void {
    this.tried.set(true);
    const reason = this.cleaned();
    if (!this.target() || !reason) return;
    const replacedBy = this.replacement();
    this.confirm.emit({
      reason: reason.slice(0, MAX_REASON_LENGTH),
      ...(replacedBy !== NONE && { replacedBy }),
    });
  }

  protected cancel(): void {
    this.closed.emit();
  }
}
