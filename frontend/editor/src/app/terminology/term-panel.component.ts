import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideInfo,
  lucideLock,
  lucideTrash2,
  lucideX,
} from '@ng-icons/lucide';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { LanguageService } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardSelectImports } from '@openfolia/ui/select';
import { SaveStatusComponent } from '@openfolia/ui/states';

import { languageName } from '../content/browser-model';
import { GuardDirective } from '../permissions/guard.directive';
import type { IndexedTerm } from './term-index';
import type { TermMode } from './term-draft';
import { DefinitionFieldComponent } from './definition-field.component';
import {
  cleanLine,
  DOMAIN_MAX,
  STATUS_BADGES,
  STATUS_LABELS,
  TERM_STATUSES,
  VARIANT_MAX,
  variantsOf,
  withDomain,
  withLanguage,
  withStatus,
  type TermContent,
  type TermDefinition,
  type TermLanguageEntry,
  type TermStatus,
  type TermUse,
} from './terms-model';
import { VariantChipsComponent } from './variant-chips.component';

/** The replacement select's "none". */
const NO_REPLACEMENT = '-';

/** How many of the modules linking a term the panel names. */
const USED_IN_SHOWN = 5;

/** One language's part of the panel. */
interface LanguageView {
  readonly lang: string;
  readonly name: string;
  readonly entry: TermLanguageEntry | undefined;
  /** Not among the configured languages (`unknown-language`). */
  readonly unknown: boolean;
}

/**
 * One term's details and editing (the terminology's side panel; a sheet on phones): its
 * preferred variant and ID, the save state (Saved, Saving, Not saved) or why it is read-only,
 * its status (a deprecated term may name its replacement) and domain, and per language (the
 * configured ones, source first) the preferred variant, the allowed and forbidden variants as
 * chips and the definition as a small rich-text field. Every change is handed on as the whole
 * term (`changed`); the page saves it. "Delete term" asks the page (`deleteRequested`), or shows
 * why it cannot be deleted. Read-only, the same details stand without controls.
 */
@Component({
  selector: 'of-term-panel',
  imports: [
    RouterLink,
    TranslocoPipe,
    NgIcon,
    SaveStatusComponent,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardInputComponent,
    ZardSelectImports,
    GuardDirective,
    DefinitionFieldComponent,
    VariantChipsComponent,
  ],
  viewProviders: [
    provideIcons({ lucideInfo, lucideLock, lucideTrash2, lucideX }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-5 text-sm' },
  template: `
    @let t = term();
    <div class="flex items-start justify-between gap-2">
      <div class="flex min-w-0 flex-col gap-0.5">
        <h2
          class="m-0 min-w-0 text-base font-medium [overflow-wrap:anywhere]"
          data-slot="term-title"
          [attr.lang]="titleLang() || null"
        >
          {{ title() }}
        </h2>
        @if (title() !== t.id) {
          <span
            class="text-muted-foreground font-mono text-xs [overflow-wrap:anywhere]"
            data-slot="term-id"
            >{{ t.id }}</span
          >
        }
      </div>
      @if (closable()) {
        <button
          z-button
          zType="ghost"
          zSize="icon-sm"
          type="button"
          class="-me-1 -mt-1 shrink-0"
          data-slot="term-close"
          [attr.aria-label]="'editor.terminology.panel.close' | transloco"
          (click)="closed.emit()"
        >
          <ng-icon name="lucideX" aria-hidden="true" />
        </button>
      }
    </div>

    @if (editable() || readReason()) {
      <p
        class="text-muted-foreground m-0 flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
        data-slot="term-state"
      >
        @if (editable()) {
          <span class="min-w-0 break-words">{{
            'editor.terminology.panel.savedIn'
              | transloco: { changeSet: changeSetTitle() }
          }}</span>
          @if (changeSetId()) {
            <span aria-hidden="true">·</span>
            <a
              class="text-foreground focus-visible:ring-ring/50 rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2"
              routerLink="/review"
              data-slot="term-open-review"
              [queryParams]="{ cs: changeSetId() }"
              >{{ 'editor.terminology.panel.openReview' | transloco }}</a
            >
          }
          @if (saveState(); as s) {
            <of-save-status class="ms-auto" [status]="s" />
          }
        } @else if (readReason()) {
          <ng-icon
            [name]="lockedElsewhere() ? 'lucideLock' : 'lucideInfo'"
            class="shrink-0"
            size="16"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 break-words">{{
            readReason()! | transloco
          }}</span>
        }
      </p>
    }

    <div class="grid min-w-0 gap-3 sm:grid-cols-2">
      <div class="flex min-w-0 flex-col gap-1.5">
        <span class="text-muted-foreground text-xs" id="term-status-label">{{
          'editor.terminology.panel.status' | transloco
        }}</span>
        @if (editable()) {
          <z-select
            zPosition="popper"
            data-slot="term-status"
            [zAriaLabel]="'editor.terminology.panel.status' | transloco"
            [zValue]="t.status"
            (zSelectionChange)="setStatus($any($event))"
          >
            @for (s of statuses; track s) {
              <z-select-item [zValue]="s">{{
                statusLabel(s) | transloco
              }}</z-select-item>
            }
          </z-select>
        } @else {
          <span>
            <z-badge
              [zType]="badge(t.status)"
              class="font-normal"
              data-slot="term-status"
              >{{ statusLabel(t.status) | transloco }}</z-badge
            >
          </span>
        }
      </div>
      <div class="flex min-w-0 flex-col gap-1.5">
        <label class="text-muted-foreground text-xs" for="term-domain">{{
          'editor.terminology.panel.domain' | transloco
        }}</label>
        @if (editable()) {
          <input
            z-input
            id="term-domain"
            autocomplete="off"
            data-slot="term-domain"
            [attr.maxlength]="domainMax"
            [placeholder]="'editor.terminology.panel.noDomain' | transloco"
            [value]="t.domain ?? ''"
            (keydown.enter)="$any($event.target).blur()"
            (blur)="setDomain($any($event.target).value)"
          />
        } @else {
          <span class="break-words" data-slot="term-domain">{{
            t.domain ?? ('editor.terminology.panel.noDomain' | transloco)
          }}</span>
        }
      </div>
      @if (t.status === 'deprecated') {
        <div class="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
          <span class="text-muted-foreground text-xs">{{
            'editor.terminology.panel.replacedBy' | transloco
          }}</span>
          @if (editable()) {
            <z-select
              zPosition="popper"
              data-slot="term-replaced-by"
              [zAriaLabel]="'editor.terminology.panel.replacedBy' | transloco"
              [zValue]="t.replacedBy ?? none"
              (zSelectionChange)="setReplacement($any($event))"
            >
              <z-select-item [zValue]="none">{{
                'editor.terminology.panel.noReplacement' | transloco
              }}</z-select-item>
              @for (c of candidates(); track c.id) {
                <z-select-item [zValue]="c.id">{{ c.label }}</z-select-item>
              }
            </z-select>
          } @else {
            <span class="break-words" data-slot="term-replaced-by">{{
              replacementLabel() ??
                ('editor.terminology.panel.noReplacement' | transloco)
            }}</span>
          }
        </div>
      }
    </div>

    @for (l of languageViews(); track l.lang) {
      <section
        class="border-border flex min-w-0 flex-col gap-3 border-t pt-4"
        [attr.aria-labelledby]="'term-lang-' + l.lang"
        [attr.data-lang]="l.lang"
      >
        <h3
          class="m-0 flex flex-wrap items-center gap-2 text-sm font-medium"
          [id]="'term-lang-' + l.lang"
        >
          <span class="break-words">{{ l.name }}</span>
          <z-badge zType="outline" class="font-normal uppercase">{{
            l.lang
          }}</z-badge>
          @if (l.unknown) {
            <z-badge zType="outline" class="font-normal">{{
              'editor.terminology.panel.unknownLanguage' | transloco
            }}</z-badge>
          }
        </h3>

        <div class="flex min-w-0 flex-col gap-1.5">
          <label
            class="text-muted-foreground text-xs"
            [for]="'term-preferred-' + l.lang"
            >{{ 'editor.terminology.panel.preferred' | transloco }}</label
          >
          @if (editable()) {
            <input
              z-input
              autocomplete="off"
              data-slot="term-preferred"
              [id]="'term-preferred-' + l.lang"
              [attr.lang]="l.lang"
              [attr.maxlength]="variantMax"
              [attr.aria-invalid]="problems()[l.lang] ? 'true' : null"
              [attr.aria-describedby]="
                problems()[l.lang]
                  ? 'term-preferred-' + l.lang + '-problem'
                  : null
              "
              [placeholder]="
                l.entry
                  ? ''
                  : ('editor.terminology.panel.notInLanguage' | transloco)
              "
              [value]="l.entry?.preferred ?? ''"
              (keydown.enter)="$any($event.target).blur()"
              (blur)="setPreferred(l, $any($event.target))"
            />
            @if (problems()[l.lang]; as p) {
              <p
                class="text-destructive m-0 text-xs break-words"
                aria-live="polite"
                [id]="'term-preferred-' + l.lang + '-problem'"
              >
                {{ p | transloco }}
              </p>
            }
          } @else {
            @if (l.entry; as e) {
              <span
                class="font-medium break-words"
                data-slot="term-preferred"
                [attr.lang]="l.lang"
                >{{ e.preferred }}</span
              >
            } @else {
              <span class="text-muted-foreground" data-slot="term-preferred">{{
                'editor.terminology.panel.notInLanguage' | transloco
              }}</span>
            }
          }
        </div>

        @if (l.entry; as e) {
          <div class="flex min-w-0 flex-col gap-1.5" data-slot="term-allowed">
            <label
              class="text-muted-foreground text-xs"
              [for]="'term-allowed-' + l.lang"
              >{{ 'editor.terminology.panel.allowed' | transloco }}</label
            >
            <of-variant-chips
              [inputId]="'term-allowed-' + l.lang"
              [label]="
                'editor.terminology.panel.allowedIn'
                  | transloco: { language: l.name }
              "
              [lang]="l.lang"
              [editable]="editable()"
              [words]="words(e.allowed)"
              [taken]="[e.preferred].concat(words(e.forbidden))"
              (changed)="setVariants(l, 'allowed', $event)"
            />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5" data-slot="term-forbidden">
            <label
              class="text-muted-foreground text-xs"
              [for]="'term-forbidden-' + l.lang"
              >{{ 'editor.terminology.panel.forbidden' | transloco }}</label
            >
            <of-variant-chips
              [inputId]="'term-forbidden-' + l.lang"
              [label]="
                'editor.terminology.panel.forbiddenIn'
                  | transloco: { language: l.name }
              "
              [lang]="l.lang"
              [forbidden]="true"
              [editable]="editable()"
              [words]="words(e.forbidden)"
              [taken]="[e.preferred].concat(words(e.allowed))"
              (changed)="setVariants(l, 'forbidden', $event)"
            />
          </div>
          <div
            class="flex min-w-0 flex-col gap-1.5"
            data-slot="term-definition"
          >
            <span
              class="text-muted-foreground text-xs"
              [id]="'term-definition-' + l.lang + '-label'"
              >{{ 'editor.terminology.panel.definition' | transloco }}</span
            >
            @if (editable() || e.definition) {
              <of-definition-field
                [inputId]="'term-definition-' + l.lang"
                [label]="
                  'editor.terminology.panel.definitionIn'
                    | transloco: { language: l.name }
                "
                [lang]="l.lang"
                [editable]="editable()"
                [value]="e.definition"
                (changed)="setDefinition(l, $event)"
              />
            } @else {
              <span class="text-muted-foreground">{{
                'editor.terminology.panel.noDefinition' | transloco
              }}</span>
            }
          </div>
        }
      </section>
    }

    @if (deletable()) {
      <div
        class="border-border flex min-w-0 flex-col items-start gap-2 border-t pt-4"
      >
        <button
          z-button
          zType="outline"
          zSize="sm"
          type="button"
          class="text-destructive"
          data-slot="term-delete"
          [ofGuard]="{
            permission: 'content.edit',
            blockedReason: deleteBlocked(),
          }"
          (click)="deleteRequested.emit()"
        >
          <ng-icon
            name="lucideTrash2"
            data-icon="inline-start"
            aria-hidden="true"
          />
          {{ 'editor.terminology.delete.action' | transloco }}
        </button>
        @if (usedInCount() > 0) {
          <p
            class="text-muted-foreground m-0 text-xs break-words"
            data-slot="term-used-in"
          >
            {{
              'editor.terminology.delete.usedIn'
                | transloco: { modules: usedInLabels(), count: usedInCount() }
            }}
          </p>
        }
        @if (linkedBy().length > 0) {
          <p
            class="text-muted-foreground m-0 text-xs break-words"
            data-slot="term-linked"
          >
            {{
              'editor.terminology.delete.linked'
                | transloco: { terms: linkedLabels(), count: linkedBy().length }
            }}
          </p>
        }
      </div>
    }
  `,
})
export class TermPanelComponent {
  private readonly language = inject(LanguageService);

  readonly term = input.required<TermContent>();
  readonly mode = input.required<TermMode>();
  /** The configured languages, source first. */
  readonly languages = input.required<readonly string[]>();
  readonly saveState = input<'saved' | 'saving' | 'not-saved' | null>(null);
  readonly changeSetTitle = input('');
  /** The change set edits go into: "Open in review" leads there. */
  readonly changeSetId = input<string | null>(null);
  /** The terms the index knows (what a deprecated term may be replaced by). */
  readonly terms = input<readonly IndexedTerm[]>([]);
  /** The terms naming this one as their replacement: it cannot be deleted while they do. */
  readonly linkedBy = input<readonly IndexedTerm[]>([]);
  /** The module files whose term links name this term (#245, the first the API names): it cannot be deleted while they do. */
  readonly usedIn = input<readonly TermUse[]>([]);
  /** How many module files link it, all counted. */
  readonly usedInCount = input(0);
  readonly closable = input(true);
  readonly changed = output<TermContent>();
  readonly closed = output();
  readonly deleteRequested = output();

  protected readonly statuses = TERM_STATUSES;
  protected readonly none = NO_REPLACEMENT;
  protected readonly domainMax = DOMAIN_MAX;
  protected readonly variantMax = VARIANT_MAX;
  /** Per language, why its preferred variant was not taken (a key). */
  protected readonly problems = signal<Readonly<Record<string, string>>>({});

  protected readonly editable = computed(() => this.mode().kind === 'edit');

  protected readonly readReason = computed((): string | null => {
    const m = this.mode();
    return m.kind === 'read' ? m.reason : null;
  });

  protected readonly lockedElsewhere = computed(
    () => this.readReason() === 'editor.terminology.blocked.locked',
  );

  /** Delete is offered where editing is; read-only for a role that never edits, none. */
  protected readonly deletable = computed(
    () => this.editable() || this.readReason() !== null,
  );

  protected readonly deleteBlocked = computed((): string | null => {
    const reason = this.readReason();
    if (reason) return reason;
    if (this.linkedBy().length > 0)
      return 'editor.terminology.delete.linkedShort';
    if (this.usedInCount() > 0) return 'editor.terminology.delete.usedInShort';
    return null;
  });

  protected readonly titleLang = computed(() => {
    const t = this.term();
    return (
      this.languages().find((l) => t.languages[l]) ??
      Object.keys(t.languages)[0] ??
      ''
    );
  });

  protected readonly title = computed(
    () => this.term().languages[this.titleLang()]?.preferred ?? this.term().id,
  );

  protected readonly languageViews = computed((): LanguageView[] => {
    const locale = this.language.locale();
    const t = this.term();
    const configured = this.languages();
    const extra = Object.keys(t.languages)
      .filter((l) => !configured.includes(l))
      .sort();
    return [...configured, ...extra].map((lang) => ({
      lang,
      name: languageName(locale, lang),
      entry: t.languages[lang],
      unknown: !configured.includes(lang),
    }));
  });

  protected readonly candidates = computed(() => {
    const id = this.term().id;
    const lang = this.titleLang();
    return this.terms()
      .filter((t) => t.id !== id && t.status !== 'deprecated')
      .map((t) => ({ id: t.id, label: this.labelOf(t, lang) }))
      .sort((a, b) => a.label.localeCompare(b.label, this.language.locale()));
  });

  protected readonly replacementLabel = computed(() => {
    const id = this.term().replacedBy;
    if (!id) return null;
    const found = this.terms().find((t) => t.id === id);
    return found ? this.labelOf(found, this.titleLang()) : id;
  });

  /** The first few modules linking it, by title and language; an ellipsis when there are more. */
  protected usedInLabels(): string {
    const shown = this.usedIn().slice(0, USED_IN_SHOWN);
    const labels = shown.map((u) => `${u.title} (${u.lang})`).join(', ');
    return this.usedInCount() > shown.length ? `${labels}, …` : labels;
  }

  protected linkedLabels(): string {
    return this.linkedBy()
      .map((t) => this.labelOf(t, this.titleLang()))
      .join(', ');
  }

  private labelOf(t: IndexedTerm, lang: string): string {
    const word = t.preferred[lang] ?? Object.values(t.preferred)[0];
    return word && word !== t.id ? `${word} (${t.id})` : t.id;
  }

  protected statusLabel(status: TermStatus): string {
    return STATUS_LABELS[status];
  }

  protected badge(status: TermStatus) {
    return STATUS_BADGES[status];
  }

  protected words(variants: readonly { term: string }[]): string[] {
    return variants.map((v) => v.term);
  }

  protected setStatus(status: string): void {
    const next = TERM_STATUSES.find((s) => s === status);
    const t = this.term();
    if (!next || next === t.status) return;
    this.changed.emit(withStatus(t, next));
  }

  protected setReplacement(value: string): void {
    const t = this.term();
    const id = value === NO_REPLACEMENT ? undefined : value;
    if (id === t.replacedBy) return;
    this.changed.emit(withStatus(t, 'deprecated', id));
  }

  protected setDomain(value: string): void {
    const t = this.term();
    const next = withDomain(t, value.slice(0, DOMAIN_MAX));
    if (next.domain === t.domain) return;
    this.changed.emit(next);
  }

  protected setPreferred(l: LanguageView, field: HTMLInputElement): void {
    const t = this.term();
    const word = cleanLine(field.value);
    const entry = t.languages[l.lang];
    this.problem(l.lang, null);
    if (word === (entry?.preferred ?? '')) {
      field.value = word;
      return;
    }
    if (word === '') {
      if (!entry) return;
      const holdsMore =
        entry.allowed.length > 0 ||
        entry.forbidden.length > 0 ||
        !!entry.definition ||
        !!entry.usage;
      const next = holdsMore ? null : withLanguage(t, l.lang, null);
      if (!next) {
        field.value = entry.preferred;
        this.problem(
          l.lang,
          holdsMore
            ? 'editor.terminology.panel.preferredNeeded'
            : 'editor.terminology.panel.lastLanguage',
        );
        return;
      }
      this.changed.emit(next);
      return;
    }
    if (word.length > VARIANT_MAX || /\p{Cc}/u.test(word)) {
      this.problem(l.lang, 'editor.terminology.variants.tooLong');
      return;
    }
    field.value = word;
    const next = withLanguage(t, l.lang, {
      allowed: [],
      forbidden: [],
      ...entry,
      preferred: word,
    });
    if (next) this.changed.emit(next);
  }

  protected setVariants(
    l: LanguageView,
    kind: 'allowed' | 'forbidden',
    words: readonly string[],
  ): void {
    const t = this.term();
    const entry = t.languages[l.lang];
    if (!entry) return;
    const next = withLanguage(t, l.lang, {
      ...entry,
      [kind]: variantsOf(words, entry[kind]),
    });
    if (next) this.changed.emit(next);
  }

  protected setDefinition(
    l: LanguageView,
    definition: TermDefinition | undefined,
  ): void {
    const t = this.term();
    const entry = t.languages[l.lang];
    if (!entry) return;
    const changed: TermLanguageEntry = { ...entry };
    delete changed.definition;
    if (definition) changed.definition = definition;
    const next = withLanguage(t, l.lang, changed);
    if (next) this.changed.emit(next);
  }

  private problem(lang: string, key: string | null): void {
    this.problems.update((all) => {
      const next = { ...all };
      if (key) next[lang] = key;
      else delete next[lang];
      return next;
    });
  }
}
