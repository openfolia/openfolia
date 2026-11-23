import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { LanguageService } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardSelectImports } from '@openfolia/ui/select';

import { languageName } from '../content/browser-model';
import {
  cleanLine,
  DOMAIN_MAX,
  isTermId,
  newTerm,
  TERM_ID_MAX,
  termIdOf,
  VARIANT_MAX,
  type TermContent,
} from './terms-model';

/**
 * "New term" (the terminology's dialog): the preferred variant in a language (the source one
 * first), the ID derived from it (a slug, editable; once edited it stays as typed) and an optional
 * domain. An ID a term has already is refused here as far as the page knows (`takenIds`), and by
 * the API in any case. Adding hands the new term on (`created`); the page adds it to the change set
 * and then opens its panel. While it does, the dialog waits (`busy`); a refusal is shown in it
 * (`failure`, a key).
 */
@Component({
  selector: 'of-new-term-dialog',
  imports: [
    TranslocoPipe,
    ZardButtonComponent,
    ZardDialogImports,
    ZardInputComponent,
    ZardSelectImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <z-dialog [(zVisible)]="open" class="sm:max-w-[34rem]">
      <z-dialog-header>
        <z-dialog-title>{{
          'editor.terminology.new.title' | transloco
        }}</z-dialog-title>
        <z-dialog-description class="break-words">{{
          'editor.terminology.new.description'
            | transloco: { changeSet: changeSetTitle() }
        }}</z-dialog-description>
      </z-dialog-header>
      @if (open()) {
        <form
          id="new-term-form"
          class="flex flex-col gap-4"
          novalidate
          (submit)="submit($event)"
        >
          <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
            <div class="flex min-w-0 flex-col gap-1.5">
              <label class="text-sm" for="new-term-preferred">{{
                'editor.terminology.new.preferred' | transloco
              }}</label>
              <input
                id="new-term-preferred"
                z-input
                autocomplete="off"
                required
                data-slot="new-term-preferred"
                [attr.lang]="lang()"
                [attr.maxlength]="variantMax"
                [attr.aria-invalid]="preferredMissing() ? 'true' : null"
                [value]="preferred()"
                (input)="typedPreferred($any($event.target).value)"
              />
              @if (preferredMissing()) {
                <p class="text-destructive m-0 text-xs">
                  {{ 'editor.terminology.new.preferredMissing' | transloco }}
                </p>
              }
            </div>
            <div class="flex min-w-0 flex-col gap-1.5">
              <span class="text-sm">{{
                'editor.terminology.new.language' | transloco
              }}</span>
              <z-select
                zPosition="popper"
                data-slot="new-term-language"
                [zAriaLabel]="'editor.terminology.new.language' | transloco"
                [zValue]="lang()"
                (zSelectionChange)="lang.set(single($event))"
              >
                @for (l of languages(); track l) {
                  <z-select-item [zValue]="l">{{ name(l) }}</z-select-item>
                }
              </z-select>
            </div>
          </div>

          <div class="flex min-w-0 flex-col gap-1.5">
            <label class="text-sm" for="new-term-id">{{
              'editor.terminology.new.id' | transloco
            }}</label>
            <input
              id="new-term-id"
              z-input
              autocomplete="off"
              spellcheck="false"
              class="font-mono"
              data-slot="new-term-id"
              aria-describedby="new-term-id-hint"
              [attr.maxlength]="idMax"
              [attr.aria-invalid]="idError() ? 'true' : null"
              [value]="id()"
              (input)="typedId($any($event.target).value)"
            />
            <p
              id="new-term-id-hint"
              class="text-muted-foreground m-0 text-xs break-words"
              [class.text-destructive]="!!idError()"
              aria-live="polite"
            >
              {{ idError() ?? 'editor.terminology.new.idHint' | transloco }}
            </p>
          </div>

          <div class="flex min-w-0 flex-col gap-1.5">
            <label class="text-sm" for="new-term-domain">{{
              'editor.terminology.new.domain' | transloco
            }}</label>
            <input
              id="new-term-domain"
              z-input
              autocomplete="off"
              data-slot="new-term-domain"
              [attr.maxlength]="domainMax"
              [placeholder]="'editor.terminology.panel.noDomain' | transloco"
              [value]="domain()"
              (input)="domain.set($any($event.target).value)"
            />
          </div>

          @if (failure(); as f) {
            <p
              class="text-destructive m-0 text-sm break-words"
              role="alert"
              data-slot="new-term-failure"
            >
              {{ f | transloco }}
            </p>
          }
        </form>
      }
      <z-dialog-footer>
        <button z-button zType="ghost" type="button" (click)="open.set(false)">
          {{ 'editor.terminology.new.cancel' | transloco }}
        </button>
        <button
          z-button
          type="submit"
          form="new-term-form"
          data-slot="new-term-submit"
          [zLoading]="busy()"
        >
          {{ 'editor.terminology.new.submit' | transloco }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class NewTermDialogComponent {
  private readonly language = inject(LanguageService);

  readonly open = model(false);
  /** The configured languages, source first. */
  readonly languages = input.required<readonly string[]>();
  readonly changeSetTitle = input('');
  /** The IDs terms have already, as far as the page knows. */
  readonly takenIds = input<ReadonlySet<string>>(new Set());
  readonly busy = input(false);
  /** Why adding failed (a key), shown in the dialog. */
  readonly failure = input<string | null>(null);
  readonly created = output<TermContent>();

  protected readonly variantMax = VARIANT_MAX;
  protected readonly idMax = TERM_ID_MAX;
  protected readonly domainMax = DOMAIN_MAX;
  protected readonly preferred = signal('');
  protected readonly lang = signal('');
  protected readonly id = signal('');
  protected readonly domain = signal('');
  /** The ID was typed: it no longer follows the preferred variant. */
  private readonly idTyped = signal(false);
  private readonly tried = signal(false);

  protected readonly preferredMissing = computed(
    () => this.tried() && cleanLine(this.preferred()) === '',
  );

  protected readonly idError = computed((): string | null => {
    const id = this.id();
    if (id === '') {
      return this.tried() || this.idTyped()
        ? 'editor.terminology.new.idMissing'
        : null;
    }
    if (!isTermId(id)) return 'editor.terminology.new.idInvalid';
    if (this.takenIds().has(id)) return 'editor.terminology.new.idTaken';
    return null;
  });

  constructor() {
    // Each opening starts afresh, in the source language.
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        this.preferred.set('');
        this.id.set('');
        this.domain.set('');
        this.idTyped.set(false);
        this.tried.set(false);
        this.lang.set(this.languages()[0] ?? '');
      });
    });
  }

  protected typedPreferred(value: string): void {
    this.preferred.set(value);
    if (!this.idTyped()) this.id.set(termIdOf(value));
  }

  protected typedId(value: string): void {
    this.idTyped.set(true);
    this.id.set(value.trim().toLowerCase());
  }

  protected single(value: string | string[]): string {
    return Array.isArray(value) ? (value[0] ?? '') : value;
  }

  protected name(lang: string): string {
    return languageName(this.language.locale(), lang);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (this.busy()) return;
    this.tried.set(true);
    const preferred = cleanLine(this.preferred());
    if (preferred === '' || this.idError() || !this.lang()) return;
    this.created.emit(
      newTerm(this.id(), this.lang(), preferred, this.domain()),
    );
  }
}
