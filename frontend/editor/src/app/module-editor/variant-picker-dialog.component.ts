import type { LocalizedText } from '@openfolia/content-model/core';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  resource,
  signal,
  untracked,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleAlert,
  lucideLayers,
  lucidePlus,
  lucideSearch,
  lucideX,
} from '@ng-icons/lucide';
import { formatCondition, type Condition } from '@openfolia/content-model/core';
import {
  catchError,
  concat,
  debounceTime,
  distinctUntilChanged,
  firstValueFrom,
  map,
  of,
  switchMap,
  type Observable,
} from 'rxjs';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardCheckboxComponent } from '@openfolia/ui/checkbox';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { injectTranslate, LanguageService } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardInputGroupImports } from '@openfolia/ui/input-group';
import { ListFrameComponent, ListRowDirective } from '@openfolia/ui/list-frame';
import {
  SegmentedComponent,
  type SegmentedOption,
} from '@openfolia/ui/segmented';
import { ZardSelectImports } from '@openfolia/ui/select';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { FadeInDirective, RefreshingDirective } from '@openfolia/ui/smooth';
import {
  EmptyStateComponent,
  ErrorStateComponent,
  NoAccessStateComponent,
} from '@openfolia/ui/states';
import { ZardTextareaComponent } from '@openfolia/ui/textarea';

import {
  ApiClient,
  pageQuery,
  ReadRef,
  toApiError,
  type ApiError,
  type Response,
} from '../api';
import type { VariantPick } from '../doc-editor/blocks/doc-blocks-context';
import { apiErrorText, UiTexts } from '../i18n';
import { MeService } from '../permissions/me';
import {
  addComparison,
  COMPARE_OPS,
  fromCondition,
  groupOf,
  isVersion,
  MAX_CONDITION_LENGTH,
  parseText,
  removeComparison,
  setComparison,
  setNegate,
  toText,
  toggleValue,
  unknownNames,
  type Builder,
  type CompareOp,
  type UnknownName,
  type VariantAttributeInfo,
} from './variant-builder';

/** An attribute as `GET /variants` gives it: its labels one text, or one per language (#731). */
type StoredAttributeInfo = Omit<VariantAttributeInfo, 'label' | 'values'> & {
  readonly label: LocalizedText;
  readonly values: readonly {
    readonly id: string;
    readonly label: LocalizedText;
    readonly archived?: boolean;
  }[];
};

/** What the variant picker is opened for. */
export interface VariantPickRequest {
  /** The block's condition now; null for a new block. */
  readonly current: Condition | null;
  /** The module's title, under the dialog's title. */
  readonly moduleTitle: string;
  /**
   * The dialog's title and the line under it, in place of a variant block's (for a manual's row
   * or a text attribute's value); `moduleTitle` is then unused.
   */
  readonly labels?: { readonly title: string; readonly subtitle: string };
}

/** How long typing or clicking pauses before the builds are asked for, in ms. */
const MATCH_DEBOUNCE = 300;
/** Builds a page. */
const PAGE_SIZE = 10;
/** Variant attributes a page, and the pages read at most. */
const ATTRIBUTE_PAGE = 200;
const ATTRIBUTE_PAGES = 10;

type Build = Response<'/variants/matches'>['data'][number];

interface MatchKey {
  readonly open: boolean;
  readonly text: string;
  readonly page: number;
  readonly ref: string | undefined;
  readonly user: string;
  readonly attempt: number;
}

interface MatchPage {
  readonly text: string;
  readonly builds: readonly Build[];
  readonly meta: Response<'/variants/matches'>['meta']['page'];
}

type MatchState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly previous: MatchPage | null }
  | { readonly status: 'ready'; readonly page: MatchPage }
  /** The API refused the condition itself: 400 (it does not read) or 422 (unknown names). */
  | {
      readonly status: 'refused';
      readonly text: string;
      readonly error: ApiError;
    }
  | { readonly status: 'error'; readonly error: ApiError };

const sameKey = (a: MatchKey, b: MatchKey): boolean =>
  a.open === b.open &&
  a.text === b.text &&
  a.page === b.page &&
  a.ref === b.ref &&
  a.user === b.user &&
  a.attempt === b.attempt;

/** The texts of the issues the API names in an `unknown-variant` answer (`meta.issue`). */
const ISSUE_TEXTS: Readonly<Record<UnknownName['issue'], string>> = {
  'unknown-variant-attribute':
    'editor.variantPicker.issues.unknown-variant-attribute',
  'unknown-variant-value': 'editor.variantPicker.issues.unknown-variant-value',
  'version-compare-on-enum':
    'editor.variantPicker.issues.version-compare-on-enum',
  'invalid-version-value': 'editor.variantPicker.issues.invalid-version-value',
};

const OP_LABELS: Readonly<Record<CompareOp, string>> = {
  '>=': 'editor.variantPicker.ops.gte',
  '>': 'editor.variantPicker.ops.gt',
  '<=': 'editor.variantPicker.ops.lte',
  '<': 'editor.variantPicker.ops.lt',
  '=': 'editor.variantPicker.ops.eq',
};

const OP_NAMES: Readonly<Record<CompareOp, string>> = {
  '>=': 'gte',
  '>': 'gt',
  '<=': 'lte',
  '<': 'lt',
  '=': 'eq',
};

/** One group of the rule's sentence. */
interface RulePart {
  readonly attribute: string;
  readonly negate: boolean;
  /** The values or comparisons, as they read. */
  readonly items: readonly string[];
  /** How the items join: any value of a group, every comparison of a range. */
  readonly join: 'or' | 'and';
}

/**
 * Screen 8, the variant picker: which variants a variant block's content is shown for. The
 * attributes and their values come from `GET /variants` (nothing is known by name); each is a
 * group, "is" or "is not" one of its values (an enum attribute) or within a version range (a
 * version attribute), and the groups combine with all or any. The rule reads as a sentence, and
 * its text form (the AsciiDoc condition) stays in view and in sync, so it can be typed: a typed
 * condition the groups can show updates them; one they can't is kept as text only. The builds a
 * condition appears in come from `GET /variants/matches`, asked once changes pause; its 400 and
 * 422 answers are shown at the text. Apply hands the condition to the block; Remove condition
 * takes the block's frame away and keeps its content. The dialog stands at a fixed place from the
 * top and the builds keep one height, loading or not, so nothing jumps while they load (#793).
 */
@Component({
  selector: 'of-variant-picker-dialog',
  imports: [
    TranslocoPipe,
    NgIcon,
    FormsModule,
    ZardDialogImports,
    ZardButtonComponent,
    ZardCheckboxComponent,
    ZardInputComponent,
    ZardInputGroupImports,
    ZardSelectImports,
    ZardSkeletonComponent,
    ZardTextareaComponent,
    ZardBadgeComponent,
    SegmentedComponent,
    ListFrameComponent,
    ListRowDirective,
    EmptyStateComponent,
    ErrorStateComponent,
    NoAccessStateComponent,
    FadeInDirective,
    RefreshingDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCircleAlert,
      lucideLayers,
      lucidePlus,
      lucideSearch,
      lucideX,
    }),
  ],
  template: `
    <z-dialog
      [zVisible]="open()"
      (zVisibleChange)="visibleChange($event)"
      class="top-4 flex max-h-[calc(100dvh-2rem)] translate-y-0 flex-col gap-0 p-0 sm:top-[8dvh] sm:max-h-[84dvh] sm:max-w-[56rem]"
    >
      <z-dialog-header class="border-border border-b px-6 py-5">
        @if (request()?.labels; as labels) {
          <z-dialog-title class="text-lg break-words">{{
            labels.title
          }}</z-dialog-title>
          <z-dialog-description class="break-words">{{
            labels.subtitle
          }}</z-dialog-description>
        } @else {
          <z-dialog-title class="text-lg">{{
            'editor.variantPicker.title' | transloco
          }}</z-dialog-title>
          <z-dialog-description class="break-words">{{
            'editor.variantPicker.subtitle'
              | transloco: { title: request()?.moduleTitle ?? '' }
          }}</z-dialog-description>
        }
      </z-dialog-header>

      @if (request()) {
        <div class="flex min-h-0 flex-col gap-5 overflow-y-auto p-4 sm:p-6">
          <z-input-group class="w-full">
            <z-input-group-addon>
              <ng-icon name="lucideSearch" aria-hidden="true" />
            </z-input-group-addon>
            <input
              z-input
              type="search"
              autocomplete="off"
              [attr.aria-label]="'editor.variantPicker.find' | transloco"
              [placeholder]="'editor.variantPicker.find' | transloco"
              [value]="find()"
              (input)="find.set($any($event.target).value)"
            />
          </z-input-group>

          <!-- The groups: one per variant attribute. -->
          @switch (attributes.status()) {
            @case ('error') {
              @let err = attributesError();
              <div class="border-border rounded-lg border p-4">
                @if (err?.kind === 'unauthorized') {
                  <of-no-access
                    [heading]="'editor.variantPicker.noAccess' | transloco"
                  />
                } @else {
                  <of-error-state
                    [kind]="err?.kind ?? 'unknown'"
                    [heading]="'editor.variantPicker.loadFailed' | transloco"
                    [message]="attributesErrorText()"
                    (retry)="attributes.reload()"
                  />
                }
              </div>
            }
            @case ('resolved') {
              @if (attributeList().length === 0) {
                <div class="border-border rounded-lg border p-4">
                  <of-empty-state
                    [title]="'editor.variantPicker.noAttributes' | transloco"
                    [description]="
                      'editor.variantPicker.noAttributesHint' | transloco
                    "
                  />
                </div>
              } @else {
                @let b = builder();
                <div
                  ofFadeIn
                  class="flex flex-col gap-3 transition-opacity duration-300 motion-reduce:transition-none"
                  [class.opacity-60]="!b"
                  [attr.inert]="b ? null : ''"
                >
                  @if (shownAttributes().length === 0) {
                    <p class="text-muted-foreground m-0 text-sm break-words">
                      {{
                        'editor.variantPicker.nothingFound'
                          | transloco: { term: find().trim() }
                      }}
                    </p>
                  }
                  <div class="grid gap-3 md:grid-cols-3">
                    @for (a of shownAttributes(); track a.id) {
                      @let g = groupFor(a.id);
                      <fieldset
                        class="border-border m-0 flex min-w-0 flex-col gap-3 rounded-lg border p-4"
                        [attr.data-attribute]="a.id"
                      >
                        <legend class="px-1 text-sm font-medium break-words">
                          {{ a.label }}
                        </legend>
                        <of-segmented
                          class="self-start"
                          [label]="
                            'editor.variantPicker.negateLabel'
                              | transloco: { attribute: a.label }
                          "
                          [options]="negateOptions()"
                          [value]="g.negate ? 'not' : 'is'"
                          (valueChange)="negate(a.id, $event === 'not')"
                        />
                        @if (a.kind === 'enum') {
                          <div
                            class="flex max-h-64 flex-col gap-2.5 overflow-y-auto"
                          >
                            @for (v of shownValues(a); track v.id) {
                              <z-checkbox
                                class="min-w-0 break-words"
                                [ngModel]="g.values.includes(v.id)"
                                (checkChange)="toggle(a.id, v.id, $event)"
                                >{{ v.label }}</z-checkbox
                              >
                            }
                          </div>
                        } @else {
                          <div class="flex flex-col gap-2">
                            @for (
                              c of g.comparisons;
                              track $index;
                              let i = $index
                            ) {
                              <div class="flex items-center gap-2">
                                <z-select
                                  class="w-32 shrink-0"
                                  zPosition="popper"
                                  [zAriaLabel]="
                                    'editor.variantPicker.compareLabel'
                                      | transloco: { attribute: a.label }
                                  "
                                  [zValue]="c.cmp"
                                  (zSelectionChange)="
                                    compare(a.id, i, {
                                      cmp: asOp($event),
                                      value: c.value,
                                    })
                                  "
                                >
                                  @for (op of ops; track op) {
                                    <z-select-item [zValue]="op">{{
                                      opLabel(op) | transloco
                                    }}</z-select-item>
                                  }
                                </z-select>
                                <input
                                  z-input
                                  class="min-w-0 flex-1 font-mono"
                                  inputmode="decimal"
                                  autocomplete="off"
                                  [attr.aria-label]="
                                    'editor.variantPicker.versionLabel'
                                      | transloco: { attribute: a.label }
                                  "
                                  [attr.aria-invalid]="
                                    c.value.trim() !== '' && !isVersion(c.value)
                                      ? 'true'
                                      : null
                                  "
                                  [placeholder]="
                                    'editor.variantPicker.versionPlaceholder'
                                      | transloco
                                  "
                                  [value]="c.value"
                                  (input)="
                                    compare(a.id, i, {
                                      cmp: c.cmp,
                                      value: $any($event.target).value,
                                    })
                                  "
                                />
                                <button
                                  z-button
                                  zType="ghost"
                                  zSize="icon"
                                  type="button"
                                  class="shrink-0"
                                  [attr.aria-label]="
                                    'editor.variantPicker.removeComparison'
                                      | transloco
                                  "
                                  (click)="uncompare(a.id, i)"
                                >
                                  <ng-icon name="lucideX" aria-hidden="true" />
                                </button>
                              </div>
                            }
                            @if (g.comparisons.length === 0) {
                              <p class="text-muted-foreground m-0 text-sm">
                                {{
                                  'editor.variantPicker.anyVersion' | transloco
                                }}
                              </p>
                            }
                            <button
                              z-button
                              zType="outline"
                              zSize="sm"
                              type="button"
                              class="self-start"
                              (click)="addCompare(a.id)"
                            >
                              <ng-icon name="lucidePlus" aria-hidden="true" />
                              {{
                                (g.comparisons.length === 0
                                  ? 'editor.variantPicker.addComparison'
                                  : 'editor.variantPicker.addRangeEnd'
                                ) | transloco
                              }}
                            </button>
                          </div>
                        }
                      </fieldset>
                    }
                  </div>
                </div>
              }
            }
            @default {
              <div
                ofFadeIn="delayed"
                class="grid gap-3 md:grid-cols-3"
                aria-hidden="true"
              >
                @for (i of [0, 1, 2]; track i) {
                  <div
                    class="border-border flex flex-col gap-3 rounded-lg border p-4"
                  >
                    <z-skeleton class="h-4 w-24" />
                    <z-skeleton class="h-7 w-28" />
                    <z-skeleton class="h-4 w-32" />
                    <z-skeleton class="h-4 w-28" />
                    <z-skeleton class="h-4 w-36" />
                  </div>
                }
              </div>
            }
          }

          <!-- The rule: as a sentence, how groups combine, and as text. -->
          <section
            class="bg-muted flex flex-col gap-3 rounded-lg p-4"
            [attr.aria-label]="'editor.variantPicker.rule' | transloco"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h3 class="m-0 text-sm font-medium">
                {{ 'editor.variantPicker.rule' | transloco }}
              </h3>
              <of-segmented
                [class.opacity-60]="!builder()"
                [attr.inert]="builder() ? null : ''"
                [label]="'editor.variantPicker.combineLabel' | transloco"
                [options]="combineOptions()"
                [value]="shownCombine()"
                (valueChange)="setCombine($event)"
              />
            </div>
            @let parts = ruleParts();
            <p class="m-0 text-sm leading-7 break-words" data-rule>
              @if (attributes.isLoading()) {
                <z-skeleton
                  ofFadeIn="delayed"
                  class="inline-block h-4 w-64 align-middle"
                  aria-hidden="true"
                />
              } @else if (parts === null) {
                <span class="text-muted-foreground">{{
                  'editor.variantPicker.ruleTextOnly' | transloco
                }}</span>
              } @else if (parts.length === 0) {
                <span class="text-muted-foreground">{{
                  'editor.variantPicker.ruleEmpty' | transloco
                }}</span>
              } @else {
                <span>{{ 'editor.variantPicker.showIf' | transloco }}</span>
                @for (p of parts; track $index; let first = $first) {
                  @if (!first) {
                    <span>
                      {{
                        (shownCombine() === 'any'
                          ? 'editor.variantPicker.or'
                          : 'editor.variantPicker.and'
                        ) | transloco
                      }}
                    </span>
                  }
                  <span class="font-medium"> {{ p.attribute }} </span>
                  <span>
                    {{
                      (p.negate
                        ? 'editor.variantPicker.isNot'
                        : 'editor.variantPicker.is'
                      ) | transloco
                    }}
                  </span>
                  @for (item of p.items; track $index; let firstItem = $first) {
                    @if (!firstItem) {
                      <span>
                        {{
                          (p.join === 'or'
                            ? 'editor.variantPicker.or'
                            : 'editor.variantPicker.and'
                          ) | transloco
                        }}
                      </span>
                    }
                    <z-badge zType="secondary" class="mx-0.5 align-middle">{{
                      item
                    }}</z-badge>
                  }
                }
              }
            </p>
            <p class="text-muted-foreground m-0 text-xs break-words">
              {{
                (shownCombine() === 'any'
                  ? 'editor.variantPicker.hintAny'
                  : 'editor.variantPicker.hintAll'
                ) | transloco
              }}
            </p>
            <div class="flex flex-col gap-1.5">
              <label
                for="variant-picker-text"
                class="text-muted-foreground text-xs"
                >{{ 'editor.variantPicker.textLabel' | transloco }}</label
              >
              <textarea
                z-textarea
                id="variant-picker-text"
                rows="2"
                spellcheck="false"
                autocomplete="off"
                class="bg-background min-h-0 resize-y font-mono text-sm break-all"
                [attr.maxlength]="maxLength"
                [attr.aria-invalid]="textProblems().length > 0 ? 'true' : null"
                [attr.aria-describedby]="
                  textProblems().length > 0 ? 'variant-picker-problems' : null
                "
                [placeholder]="
                  'editor.variantPicker.textPlaceholder' | transloco
                "
                [value]="text()"
                (input)="typeText($any($event.target).value)"
              ></textarea>
              <div id="variant-picker-problems" role="alert">
                @for (problem of textProblems(); track $index) {
                  <p
                    ofFadeIn
                    class="text-destructive m-0 flex items-start gap-1.5 text-sm break-words"
                  >
                    <ng-icon
                      name="lucideCircleAlert"
                      class="mt-0.5 shrink-0"
                      aria-hidden="true"
                    />
                    <span>{{ problem }}</span>
                  </p>
                }
              </div>
              @if (textOnly() && textProblems().length === 0) {
                <p class="text-muted-foreground m-0 text-xs break-words">
                  {{ 'editor.variantPicker.textOnly' | transloco }}
                </p>
              }
            </div>
          </section>

          <!-- The builds the condition appears in. -->
          <section
            class="flex flex-col gap-2"
            [attr.aria-label]="'editor.variantPicker.builds' | transloco"
          >
            <p class="m-0 min-h-5 text-sm" aria-live="polite" data-appears-in>
              @switch (matchSummary()) {
                @case ('none') {
                  <span class="text-muted-foreground">{{
                    'editor.variantPicker.appearsNone' | transloco
                  }}</span>
                }
                @case ('refused') {
                  <span class="text-muted-foreground">{{
                    'editor.variantPicker.appearsRefused' | transloco
                  }}</span>
                }
                @case ('error') {
                  <span class="text-muted-foreground">{{
                    'editor.variantPicker.appearsFailed' | transloco
                  }}</span>
                }
                @case ('count') {
                  <span class="font-medium" [ofRefreshing]="matchLoading()">{{
                    'editor.variantPicker.appearsIn'
                      | transloco: { count: matchPage()?.meta?.total ?? 0 }
                  }}</span>
                }
                @default {
                  <z-skeleton
                    ofFadeIn="delayed"
                    class="inline-block h-4 w-40 align-middle"
                    aria-hidden="true"
                  />
                }
              }
            </p>
            <!-- One height whatever it shows, so the dialog never grows or moves. -->
            <div class="flex h-56 min-h-0 flex-col" data-builds-area>
              @if (matchSummary() === 'none' || matchSummary() === 'refused') {
                <div
                  ofFadeIn
                  class="border-border text-muted-foreground/60 flex flex-1 items-center justify-center rounded-lg border border-dashed"
                  aria-hidden="true"
                  data-builds-placeholder
                >
                  <ng-icon name="lucideLayers" size="28" strokeWidth="1.25" />
                </div>
              } @else {
                <of-list-frame
                  class="h-full min-h-0 flex-1"
                  offset="12rem"
                  [label]="'editor.variantPicker.builds' | transloco"
                  [items]="builds()"
                  [page]="matchPage()?.meta ?? null"
                  [loading]="matchLoading()"
                  [error]="matchError()"
                  [skeletonRows]="3"
                  [emptyTitle]="'editor.variantPicker.noBuilds' | transloco"
                  [emptyDescription]="
                    'editor.variantPicker.noBuildsHint' | transloco
                  "
                  (pageChange)="page.set($event)"
                  (retry)="attempt.set(attempt() + 1)"
                >
                  <ng-template ofListRow let-item>
                    @let build = asBuild(item);
                    <div class="flex min-w-0 flex-col gap-0.5" data-build>
                      <span class="text-sm font-medium break-words">{{
                        build.meta.manualTitle
                      }}</span>
                      <span class="text-muted-foreground text-xs break-words">{{
                        build.meta.label
                      }}</span>
                    </div>
                  </ng-template>
                </of-list-frame>
              }
            </div>
          </section>
        </div>
      }

      <z-dialog-footer
        class="border-border m-0 flex-wrap items-center gap-2 border-t px-6 py-4 sm:justify-between"
      >
        @if (request()?.current) {
          <button
            z-button
            zType="ghost"
            type="button"
            class="text-destructive hover:text-destructive"
            (click)="remove()"
          >
            {{ 'editor.variantPicker.remove' | transloco }}
          </button>
        }
        <p
          id="variant-picker-blocked"
          class="text-muted-foreground m-0 min-w-0 flex-1 text-xs break-words sm:text-end"
          aria-live="polite"
        >
          {{ blockedReason() }}
        </p>
        <div class="flex flex-col-reverse gap-2 sm:flex-row">
          <button z-button zType="ghost" type="button" (click)="cancel()">
            {{ 'editor.variantPicker.cancel' | transloco }}
          </button>
          <button
            z-button
            type="button"
            [zDisabled]="!!blockedReason()"
            [attr.aria-describedby]="
              blockedReason() ? 'variant-picker-blocked' : null
            "
            (click)="apply()"
          >
            {{ 'editor.variantPicker.apply' | transloco }}
          </button>
        </div>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class VariantPickerDialogComponent {
  private readonly api = inject(ApiClient);
  private readonly readRef = inject(ReadRef);
  private readonly me = inject(MeService);
  private readonly language = inject(LanguageService);
  private readonly texts = inject(UiTexts);
  private readonly t = injectTranslate();

  /** What the picker is open for; null: closed. */
  readonly request = input<VariantPickRequest | null>(null);
  /** The new condition, `remove`, or null when the person cancelled. Emitted once per request. */
  readonly done = output<VariantPick | null>();

  protected readonly ops = COMPARE_OPS;
  protected readonly maxLength = MAX_CONDITION_LENGTH;
  protected readonly isVersion = isVersion;

  protected readonly open = computed(() => this.request() !== null);
  /** The condition as text: what is applied. */
  protected readonly text = signal('');
  /** The builder's own state since its last edit (rows not filled yet); null: read from the text. */
  private readonly draft = signal<Builder | null>(null);
  /** How groups combine, kept when one group or none says nothing about it. */
  protected readonly combine = signal<'all' | 'any'>('all');
  protected readonly find = signal('');
  protected readonly page = signal(1);
  protected readonly attempt = signal(0);
  /** The request a choice was already handed on for. */
  private answered: VariantPickRequest | null = null;

  /** The variant attributes, every page of `GET /variants` at the chosen change set. */
  protected readonly attributes = resource({
    params: () =>
      this.open()
        ? { ref: this.readRef.ref(), user: this.me.me().id }
        : undefined,
    loader: () => this.readAttributes(),
  });

  /** The attributes with their labels in the interface language (#731). */
  protected readonly attributeList = computed(
    (): readonly VariantAttributeInfo[] =>
      this.attributes.hasValue()
        ? this.attributes.value().map((a) => ({
            ...a,
            label: this.texts.text(a.label),
            values: a.values.map((v) => ({
              ...v,
              label: this.texts.text(v.label),
            })),
          }))
        : [],
  );

  protected readonly attributesError = computed(() => {
    const error = this.attributes.error();
    return error ? toApiError(error) : null;
  });

  protected readonly attributesErrorText = computed(() => {
    const error = this.attributesError();
    if (!error) return '';
    const text = apiErrorText(error);
    return this.t(text.key, text.params);
  });

  /** What the text is. */
  private readonly parsed = computed(() => parseText(this.text()));

  /** The groups as shown: the builder's own state, else read from the text; null: text only. */
  protected readonly builder = computed((): Builder | null => {
    const draft = this.draft();
    if (draft) return draft;
    const parsed = this.parsed();
    const attributes = this.attributeList();
    if (parsed.kind === 'empty') return { combine: this.combine(), groups: {} };
    if (parsed.kind === 'unreadable') return null;
    return fromCondition(parsed.condition, attributes, this.combine());
  });

  /** Whether the text says what the groups can't (once the attributes are there to tell). */
  protected readonly textOnly = computed(
    () =>
      this.attributes.hasValue() &&
      this.attributeList().length > 0 &&
      this.builder() === null,
  );

  protected readonly negateOptions = computed((): SegmentedOption[] => [
    { value: 'is', label: this.t('editor.variantPicker.is') },
    { value: 'not', label: this.t('editor.variantPicker.isNot') },
  ]);

  protected readonly combineOptions = computed((): SegmentedOption[] => [
    { value: 'all', label: this.t('editor.variantPicker.combineAll') },
    { value: 'any', label: this.t('editor.variantPicker.combineAny') },
  ]);

  /** How groups combine as shown: as the text says when it has several groups. */
  protected readonly shownCombine = computed(
    () => this.builder()?.combine ?? this.combine(),
  );

  /** The attributes the search box leaves: by their label or one of their values' labels. */
  protected readonly shownAttributes = computed(() => {
    const term = this.term();
    return this.attributeList().filter(
      (a) =>
        !term || this.matches(a.label, term) || this.shownValues(a).length > 0,
    );
  });

  private readonly term = computed(() =>
    this.find().trim().toLocaleLowerCase(this.language.locale()),
  );

  /** The rule as a sentence, group by group; null when the groups can't show it. */
  protected readonly ruleParts = computed((): RulePart[] | null => {
    const builder = this.builder();
    if (!builder) return null;
    const parts: RulePart[] = [];
    for (const a of this.attributeList()) {
      const g = groupOf(builder, a.id);
      if (a.kind === 'enum') {
        const items = a.values
          .filter((v) => g.values.includes(v.id))
          .map((v) => v.label);
        if (items.length > 0)
          parts.push({
            attribute: a.label,
            negate: g.negate,
            items,
            join: 'or',
          });
      } else {
        const items = g.comparisons
          .filter((c) => c.value.trim() !== '')
          .map((c) =>
            this.t('editor.variantPicker.compare', {
              op: OP_NAMES[c.cmp],
              value: c.value.trim(),
            }),
          );
        if (items.length > 0)
          parts.push({
            attribute: a.label,
            negate: g.negate,
            items,
            join: 'and',
          });
      }
    }
    return parts;
  });

  /** What is sent for the builds: the text once changes pause. */
  private readonly settledText = toSignal(
    toObservable(this.text).pipe(
      debounceTime(MATCH_DEBOUNCE),
      distinctUntilChanged(),
    ),
    { initialValue: '' },
  );

  private readonly matchKey = computed<MatchKey>(
    () => ({
      open: this.open(),
      // An emptied text asks for nothing at once.
      text: this.text().trim() === '' ? '' : this.settledText().trim(),
      page: this.page(),
      ref: this.readRef.ref(),
      user: this.me.me().id,
      attempt: this.attempt(),
    }),
    { equal: sameKey },
  );

  private readonly matchState = toSignal(
    toObservable(this.matchKey).pipe(
      switchMap((key): Observable<MatchState> => {
        // Too long for the API (the groups can write that much): nothing to ask.
        if (
          !key.open ||
          key.text === '' ||
          key.text.length > MAX_CONDITION_LENGTH
        )
          return of({ status: 'idle' });
        const shown = untracked(this.matchState);
        const previous =
          shown?.status === 'ready'
            ? shown.page
            : shown?.status === 'loading'
              ? shown.previous
              : null;
        return concat(
          of<MatchState>({ status: 'loading', previous }),
          this.fetchMatches(key),
        );
      }),
    ),
    { initialValue: { status: 'idle' } as MatchState },
  );

  protected readonly matchPage = computed((): MatchPage | null => {
    const state = this.matchState();
    if (state.status === 'ready') return state.page;
    if (state.status === 'loading') return state.previous;
    return null;
  });

  protected readonly builds = computed(() => this.matchPage()?.builds ?? []);

  protected readonly matchLoading = computed(
    () => this.matchState().status === 'loading' || this.pending(),
  );

  /** Typed or clicked, and not asked for yet. */
  private readonly pending = computed(
    () =>
      this.text().trim() !== '' &&
      this.text().trim() !== this.settledText().trim(),
  );

  protected readonly matchError = computed(() => {
    const state = this.matchState();
    if (state.status !== 'error') return null;
    const text = apiErrorText(state.error);
    return { kind: state.error.kind, message: this.t(text.key, text.params) };
  });

  /** What the line above the builds says. */
  protected readonly matchSummary = computed(
    (): 'none' | 'refused' | 'error' | 'count' | 'loading' => {
      if (this.text().trim() === '') return 'none';
      if (this.text().trim().length > MAX_CONDITION_LENGTH) return 'refused';
      const state = this.matchState();
      if (state.status === 'refused' && !this.pending()) return 'refused';
      if (state.status === 'error') return 'error';
      return this.matchPage() ? 'count' : 'loading';
    },
  );

  /** The API's refusal of the text shown now; null when it took it (or has not answered). */
  private readonly refusal = computed(() => {
    const state = this.matchState();
    return state.status === 'refused' &&
      state.text === this.text().trim() &&
      !this.pending()
      ? state.error
      : null;
  });

  /** What is wrong with the text, as sentences under it. */
  protected readonly textProblems = computed((): string[] => {
    const parsed = this.parsed();
    const refusal = this.refusal();
    const attributes = this.attributeList();
    if (refusal?.code === 'unknown-variant') {
      const names =
        parsed.kind === 'condition' || parsed.kind === 'invalid'
          ? unknownNames(parsed.condition, attributes)
          : [];
      const texts = refusal.errors.map((e) => {
        const issue = e.meta?.['issue'];
        const at = names.findIndex((n) => n.issue === issue);
        const name = at === -1 ? undefined : names.splice(at, 1)[0];
        return name
          ? this.t(ISSUE_TEXTS[name.issue], {
              attribute: name.attribute,
              value: name.value,
            })
          : this.t('editor.variantPicker.issues.other');
      });
      return [...new Set(texts)];
    }
    if (refusal) return [this.t('editor.variantPicker.unreadable')];
    // A version that is not one: the API does not say so yet, the content model would refuse it.
    if (parsed.kind === 'invalid')
      return unknownNames(parsed.condition, attributes)
        .filter((n) => n.issue === 'invalid-version-value')
        .map((n) =>
          this.t(ISSUE_TEXTS[n.issue], {
            attribute: n.attribute,
            value: n.value,
          }),
        );
    return [];
  });

  /** Why Apply can't be used now; empty when it can. */
  protected readonly blockedReason = computed(() => {
    if (!this.request()) return '';
    const parsed = this.parsed();
    switch (parsed.kind) {
      case 'empty':
        return this.t('editor.variantPicker.chooseFirst');
      case 'unreadable':
        return this.t('editor.variantPicker.blockedUnreadable');
      case 'invalid':
        return this.t('editor.variantPicker.blockedVersion');
    }
    // Known before the API answers: what the attributes of GET /variants do not hold.
    if (
      this.refusal() ||
      (this.attributes.hasValue() &&
        unknownNames(parsed.condition, this.attributeList()).length > 0)
    )
      return this.t('editor.variantPicker.blockedUnknown');
    return '';
  });

  constructor() {
    // A new request starts afresh: the block's condition as text, nothing searched for.
    effect(() => {
      const req = this.request();
      untracked(() => {
        if (!req) return;
        this.text.set(req.current ? formatCondition(req.current) : '');
        this.draft.set(null);
        this.combine.set(req.current?.op === 'any' ? 'any' : 'all');
        this.find.set('');
        this.page.set(1);
      });
    });
  }

  protected groupFor(attr: string) {
    return groupOf(this.builder() ?? { combine: 'all', groups: {} }, attr);
  }

  /**
   * The values offered: an archived one only while the condition names it (so it can be taken
   * out), and of those the ones the search box leaves (all when the attribute's label matches).
   */
  protected shownValues(attribute: VariantAttributeInfo) {
    const chosen = this.groupFor(attribute.id).values;
    const offered = attribute.values.filter(
      (v) => !v.archived || chosen.includes(v.id),
    );
    const term = this.term();
    if (!term || this.matches(attribute.label, term)) return offered;
    return offered.filter((v) => this.matches(v.label, term));
  }

  protected toggle(attr: string, value: string, on: boolean): void {
    this.edit((b) => toggleValue(b, attr, value, on));
  }

  protected negate(attr: string, negate: boolean): void {
    this.edit((b) => setNegate(b, attr, negate));
  }

  protected compare(
    attr: string,
    index: number,
    comparison: { cmp: CompareOp; value: string },
  ): void {
    this.edit((b) => setComparison(b, attr, index, comparison));
  }

  protected addCompare(attr: string): void {
    this.edit((b) => addComparison(b, attr));
  }

  protected uncompare(attr: string, index: number): void {
    this.edit((b) => removeComparison(b, attr, index));
  }

  protected setCombine(value: string): void {
    const combine = value === 'any' ? 'any' : 'all';
    this.combine.set(combine);
    this.edit((b) => ({ ...b, combine }));
  }

  protected typeText(text: string): void {
    this.text.set(text);
    this.draft.set(null);
    this.page.set(1);
  }

  protected asOp(value: string | string[]): CompareOp {
    const op = Array.isArray(value) ? value[0] : value;
    return COMPARE_OPS.find((o) => o === op) ?? '>=';
  }

  protected opLabel(op: CompareOp): string {
    return OP_LABELS[op];
  }

  protected asBuild(item: unknown): Build {
    return item as Build;
  }

  protected apply(): void {
    const req = this.request();
    const parsed = this.parsed();
    if (!req || this.blockedReason() || parsed.kind !== 'condition') return;
    this.answer(req, parsed.condition);
  }

  protected remove(): void {
    const req = this.request();
    if (req) this.answer(req, 'remove');
  }

  protected cancel(): void {
    const req = this.request();
    if (req) this.answer(req, null);
  }

  /** Escape, the close button or a click outside closes the dialog: a cancel. */
  protected visibleChange(visible: boolean): void {
    if (!visible) this.cancel();
  }

  /** A change in the groups: the text follows. */
  private edit(change: (builder: Builder) => Builder): void {
    const current = this.builder();
    if (!current) return;
    const next = change(current);
    this.combine.set(next.combine);
    this.draft.set(next);
    this.text.set(toText(next, this.attributeList()));
    this.page.set(1);
  }

  private matches(label: string, term: string): boolean {
    return label.toLocaleLowerCase(this.language.locale()).includes(term);
  }

  private answer(req: VariantPickRequest, pick: VariantPick | null): void {
    if (this.answered === req) return;
    this.answered = req;
    this.done.emit(pick);
  }

  private async readAttributes(): Promise<StoredAttributeInfo[]> {
    const all: StoredAttributeInfo[] = [];
    for (let number = 1; number <= ATTRIBUTE_PAGES; number++) {
      const doc = await firstValueFrom(
        this.api.get('/variants', {
          query: pageQuery({ number, size: ATTRIBUTE_PAGE }),
        }),
      );
      for (const r of doc.data)
        all.push({
          id: r.id,
          label: r.attributes.label,
          kind: r.attributes.kind,
          values: r.attributes.kind === 'enum' ? r.attributes.values : [],
        });
      if (number >= doc.meta.page.lastPage) break;
    }
    return all;
  }

  private fetchMatches(key: MatchKey): Observable<MatchState> {
    return this.api
      .get('/variants/matches', {
        query: {
          when: key.text,
          ...pageQuery({ number: key.page, size: PAGE_SIZE }),
        },
      })
      .pipe(
        map((doc): MatchState => ({
          status: 'ready',
          page: { text: key.text, builds: doc.data, meta: doc.meta.page },
        })),
        catchError((error: unknown) => {
          const e = toApiError(error);
          const refused =
            (e.status === 400 &&
              e.code === 'invalid-parameter' &&
              e.parameter === 'when') ||
            (e.status === 422 && e.code === 'unknown-variant');
          return of<MatchState>(
            refused
              ? { status: 'refused', text: key.text, error: e }
              : { status: 'error', error: e },
          );
        }),
      );
  }
}
