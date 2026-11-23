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
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardCheckboxComponent } from '@openfolia/ui/checkbox';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { LanguageService } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardSelectImports } from '@openfolia/ui/select';

import { ApiClient, pageQuery } from '../api';
import {
  languageName,
  languagesOf,
  type ModuleSummary,
  type ProjectConfig,
  unsetAudienceLevel,
} from './browser-model';
import { KeywordFieldComponent } from './keyword-field.component';
import type { NewModule } from './module-creation';
import { MODULE_ID, moduleIdOf } from './module-id';

const TITLE_MAX = 200;
/** How many modules the copy picker offers; its search narrows them. */
const COPY_PAGE_SIZE = 200;

/**
 * Screen 7: a new module's title, type, facet values (the product lines), audience, source
 * language and keywords, optionally starting from a copy of another module. Submitting closes the dialog at
 * once and hands the module to the caller, which creates it in the current change set. The ID is
 * made from the title; one taken among the modules listed here is refused at once, any other
 * taken one by the creation itself.
 */
@Component({
  selector: 'of-new-module-dialog',
  imports: [
    ZardDialogImports,
    ZardButtonComponent,
    ZardInputComponent,
    ZardSelectImports,
    ZardCheckboxComponent,
    KeywordFieldComponent,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <z-dialog [(zVisible)]="open" class="sm:max-w-[40rem]">
      <z-dialog-header>
        <z-dialog-title>{{
          (suggest()
            ? 'editor.content.new.suggest'
            : 'editor.content.new.title'
          ) | transloco
        }}</z-dialog-title>
        <z-dialog-description>{{
          suggest()
            ? ('editor.content.new.suggestDescription' | transloco)
            : manualTitle()
              ? ('editor.content.new.descriptionManual'
                | transloco
                  : { changeSet: changeSetTitle(), manual: manualTitle() })
              : ('editor.content.new.description'
                | transloco: { changeSet: changeSetTitle() })
        }}</z-dialog-description>
      </z-dialog-header>
      @if (open()) {
        <form
          id="new-module-form"
          class="flex flex-col gap-4"
          novalidate
          (submit)="submit($event)"
        >
          <div class="flex flex-col gap-1.5">
            <label class="text-sm" for="new-module-title">{{
              'editor.content.new.titleField' | transloco
            }}</label>
            <input
              id="new-module-title"
              z-input
              autocomplete="off"
              required
              [attr.maxlength]="titleMax"
              [attr.aria-invalid]="titleError() ? 'true' : null"
              aria-describedby="new-module-id"
              [value]="title()"
              (input)="title.set($any($event.target).value)"
            />
            <p
              id="new-module-id"
              class="text-muted-foreground m-0 text-xs break-words"
              [class.text-destructive]="!!titleError()"
              aria-live="polite"
            >
              @if (titleError(); as error) {
                {{ error | transloco: { id: id() } }}
              } @else if (id()) {
                {{ 'editor.content.new.idHint' | transloco: { id: id() } }}
              } @else if (title().trim()) {
                {{ 'editor.content.new.idEmpty' | transloco }}
              } @else {
                {{ 'editor.content.new.idFromTitle' | transloco }}
              }
            </p>
          </div>

          <div class="grid gap-4 sm:grid-cols-2">
            <div class="flex flex-col gap-1.5">
              <span class="text-sm" id="new-module-lang">{{
                'editor.content.new.sourceLanguage' | transloco
              }}</span>
              <z-select
                zPosition="popper"
                [zAriaLabel]="'editor.content.new.sourceLanguage' | transloco"
                [zValue]="lang()"
                (zSelectionChange)="lang.set(single($event))"
              >
                @for (l of languages(); track l) {
                  <z-select-item [zValue]="l">{{
                    languageName(l)
                  }}</z-select-item>
                }
              </z-select>
            </div>
            <div class="flex flex-col gap-1.5">
              <span class="text-sm">{{
                'editor.content.new.audience' | transloco
              }}</span>
              <z-select
                zPosition="popper"
                [zAriaLabel]="'editor.content.new.audience' | transloco"
                [zPlaceholder]="
                  'editor.content.new.noAudience'
                    | transloco: { level: unsetLevel() }
                "
                [zValue]="audience()"
                (zSelectionChange)="audience.set(single($event))"
              >
                <z-select-item zValue="">{{
                  'editor.content.new.noAudience'
                    | transloco: { level: unsetLevel() }
                }}</z-select-item>
                @for (a of config().audiences; track a.id) {
                  <z-select-item [zValue]="a.id">{{ a.label }}</z-select-item>
                }
              </z-select>
            </div>
          </div>

          <div class="flex flex-col gap-1.5" data-slot="new-module-type">
            <span class="text-sm">{{
              'editor.content.new.type' | transloco
            }}</span>
            <!-- A select, as the types are configured: two today, maybe ten later. -->
            <z-select
              zPosition="popper"
              [zAriaLabel]="'editor.content.new.type' | transloco"
              [zPlaceholder]="'editor.content.new.typePlaceholder' | transloco"
              [zInvalid]="typeMissing()"
              [zValue]="type()"
              (zSelectionChange)="type.set(single($event))"
            >
              @for (t of config().moduleTypes; track t.id) {
                <z-select-item [zValue]="t.id">{{ t.label }}</z-select-item>
              }
            </z-select>
            @if (typeMissing()) {
              <p class="text-destructive m-0 text-xs">
                {{ 'editor.content.new.typeMissing' | transloco }}
              </p>
            }
          </div>

          @if (config().facets.length > 0) {
            <div class="grid gap-4 sm:grid-cols-2">
              @for (f of config().facets; track f.id) {
                <div class="flex flex-col gap-1.5">
                  <span class="text-sm">{{ f.label }}</span>
                  <z-select
                    zMultiple
                    zPosition="popper"
                    [zMaxLabelCount]="3"
                    [zAriaLabel]="f.label"
                    [zPlaceholder]="'editor.content.new.facetNone' | transloco"
                    [zValue]="facetValues(f.id)"
                    (zSelectionChange)="setFacet(f.id, $event)"
                  >
                    @for (v of f.values; track v.id) {
                      <z-select-item [zValue]="v.id">{{
                        v.label
                      }}</z-select-item>
                    }
                  </z-select>
                </div>
              }
            </div>
          }

          <div class="flex flex-col gap-1.5">
            <label class="text-sm" for="new-module-keywords">{{
              'editor.keywords.label' | transloco
            }}</label>
            <of-keyword-field
              inputId="new-module-keywords"
              [label]="'editor.keywords.label' | transloco"
              [(keywords)]="keywords"
            />
          </div>

          <div class="flex flex-col gap-2">
            <z-checkbox (checkChange)="copy.set($event)">{{
              'editor.content.new.copy' | transloco
            }}</z-checkbox>
            @if (copy()) {
              <z-select
                zSearchable
                zPosition="popper"
                [zAriaLabel]="'editor.content.new.copyFrom' | transloco"
                [zPlaceholder]="
                  (copyStatus() === 'loading'
                    ? 'ui.states.loading'
                    : 'editor.content.new.copyFrom'
                  ) | transloco
                "
                [zInvalid]="copyMissing()"
                [zValue]="copyFrom()"
                (zSelectionChange)="copyFrom.set(single($event))"
              >
                @for (m of copyOptions(); track m.id) {
                  <z-select-item [zValue]="m.id">{{
                    m.attributes.title
                  }}</z-select-item>
                }
              </z-select>
              @if (copyStatus() === 'error') {
                <p
                  class="text-destructive m-0 flex flex-wrap items-center gap-2 text-xs"
                >
                  {{ 'editor.content.new.copyFailed' | transloco }}
                  <button
                    z-button
                    zType="link"
                    zSize="xs"
                    type="button"
                    (click)="loadCopyOptions()"
                  >
                    {{ 'ui.states.error.retry' | transloco }}
                  </button>
                </p>
              } @else if (copyMissing()) {
                <p class="text-destructive m-0 text-xs">
                  {{ 'editor.content.new.copyMissing' | transloco }}
                </p>
              }
            }
          </div>
        </form>
      }
      <z-dialog-footer>
        <button z-button zType="ghost" type="button" z-dialog-close>
          {{ 'editor.content.new.cancel' | transloco }}
        </button>
        <button z-button type="submit" form="new-module-form">
          {{
            (manualTitle()
              ? 'editor.content.new.createAdd'
              : 'editor.content.new.create'
            ) | transloco
          }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class NewModuleDialogComponent {
  private readonly api = inject(ApiClient);
  private readonly language = inject(LanguageService);

  readonly open = model(false);
  readonly config = input.required<ProjectConfig>();
  /** The change set the module goes into, named in the description. */
  readonly changeSetTitle = input('');
  /**
   * A contributor's suggestion (#137): the module goes into a change set of its own, made for it
   * and named after it, so none is named here.
   */
  readonly suggest = input(false);
  /** The title the dialog opens with (the manual builder's search text). */
  readonly initialTitle = input('');
  /** The source language it opens with, when configured; else the project's source language. */
  readonly initialLang = input<string | null>(null);
  /**
   * The manual the module is added to once created (the manual builder), named in the
   * description instead of "opens in the editor".
   */
  readonly manualTitle = input('');
  readonly create = output<NewModule>();

  protected readonly titleMax = TITLE_MAX;
  protected readonly title = signal('');
  protected readonly lang = signal('');
  protected readonly type = signal('');
  protected readonly audience = signal('');
  private readonly facets = signal<Readonly<Record<string, string[]>>>({});
  protected readonly keywords = signal<readonly string[]>([]);
  private readonly keywordField = viewChild(KeywordFieldComponent);
  protected readonly copy = signal(false);
  protected readonly copyFrom = signal('');
  protected readonly copyStatus = signal<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  private readonly copyList = signal<readonly ModuleSummary[]>([]);
  private readonly submitted = signal(false);
  private copyRuns = 0;

  protected readonly languages = computed(() => languagesOf(this.config()));
  /** The level a module without an audience counts as (#693). */
  protected readonly unsetLevel = computed(() =>
    unsetAudienceLevel(this.config()),
  );
  protected readonly id = computed(() => moduleIdOf(this.title()));
  protected readonly copyOptions = this.copyList.asReadonly();

  protected readonly titleError = computed((): string | null => {
    const title = this.title().trim();
    if (!this.submitted() && title === '') return null;
    if (title === '') return 'editor.content.new.titleMissing';
    if (!MODULE_ID.test(this.id())) return 'editor.content.new.idEmpty';
    if (this.copyList().some((m) => m.id === this.id())) {
      return 'editor.content.new.idTaken';
    }
    return null;
  });
  protected readonly typeMissing = computed(
    () => this.submitted() && !this.type(),
  );
  protected readonly copyMissing = computed(
    () => this.submitted() && this.copy() && !this.copyFrom(),
  );

  constructor() {
    // Every opening starts afresh: the initial title and language, else empty and the source.
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        this.title.set(this.initialTitle());
        const lang = this.initialLang();
        this.lang.set(
          lang && this.languages().includes(lang)
            ? lang
            : this.config().languages.source,
        );
        // Exactly one configured type: nothing to choose, so it is chosen.
        const types = this.config().moduleTypes;
        this.type.set(types.length === 1 ? (types[0]?.id ?? '') : '');
        this.audience.set('');
        this.facets.set({});
        this.keywords.set([]);
        this.copy.set(false);
        this.copyFrom.set('');
        this.submitted.set(false);
        void this.loadCopyOptions();
      });
    });
  }

  /** The modules to copy from (and whose IDs are taken): one page, the first by title. */
  protected async loadCopyOptions(): Promise<void> {
    const run = ++this.copyRuns;
    this.copyStatus.set('loading');
    try {
      const doc = await firstValueFrom(
        this.api.get('/module-summaries', {
          query: pageQuery({ number: 1, size: COPY_PAGE_SIZE }),
        }),
      );
      if (run !== this.copyRuns) return; // an older read (the dialog opened again)
      this.copyList.set(doc.data);
      this.copyStatus.set('ready');
    } catch {
      if (run === this.copyRuns) this.copyStatus.set('error');
    }
  }

  protected languageName(lang: string): string {
    return languageName(this.language.locale(), lang);
  }

  protected single(value: string | string[]): string {
    return Array.isArray(value) ? (value[0] ?? '') : value;
  }

  protected facetValues(id: string): string[] {
    return this.facets()[id] ?? [];
  }

  protected setFacet(id: string, value: string | string[]): void {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    this.facets.update((all) => ({ ...all, [id]: values }));
  }

  protected submit(event: Event): void {
    event.preventDefault();
    // What is still typed in the keyword field counts too.
    this.keywordField()?.commit();
    this.submitted.set(true);
    if (
      this.titleError() ||
      this.typeMissing() ||
      this.copyMissing() ||
      this.keywordField()?.problem()
    ) {
      return;
    }
    const source = this.copyList().find((m) => m.id === this.copyFrom());
    this.create.emit({
      id: this.id(),
      title: this.title().trim().replace(/\s+/g, ' '),
      lang: this.lang(),
      type: this.type(),
      audience: this.audience() || undefined,
      facets: this.facets(),
      keywords: this.keywords(),
      copyFrom:
        this.copy() && source
          ? {
              id: source.id,
              // The blocks in the new module's language when the source has it.
              lang: source.attributes.languages.includes(this.lang())
                ? this.lang()
                : source.attributes.titleLang,
            }
          : undefined,
    });
    this.open.set(false);
  }
}
