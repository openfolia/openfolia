import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DOCUMENT,
  effect,
  inject,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleCheck,
  lucideCircleX,
  lucideFileText,
  lucidePackage,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardCheckboxComponent } from '@openfolia/ui/checkbox';
import { CollapseComponent } from '@openfolia/ui/collapse';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import {
  injectTranslate,
  LanguageService,
  translated,
} from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardSelectImports } from '@openfolia/ui/select';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { ZardTextareaComponent } from '@openfolia/ui/textarea';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, pageQuery, toApiError } from '../api';
import { CHECK_TITLES, detailOf, fixLinkOf } from '../checks/checks-model';
import { languageName } from '../content/browser-model';
import { apiErrorText, UiTextPipe, UiTexts } from '../i18n';
import { GuardDirective } from '../permissions/guard.directive';
import { MeService } from '../permissions/me';
import type { ManualItem } from '../preview/preview-model';
import {
  byUrgency,
  createBlocked,
  firstChecks,
  readinessOf,
  STEP_TEXT,
  STEPS,
  type CheckItem,
  type MaintenanceLine,
  type ManualReadiness,
  type Step,
} from './create-release-model';
import { MAIN, ReleaseSource } from './release-source';
import {
  notesByLanguageOf,
  notesProblem,
  NOTES_MAX,
  revisionProblem,
  shortCommit,
  type ReleaseItem,
} from './releases-model';

/** Checks shown per manual; "View all checks" opens the rest. */
const CHECKS_SHOWN = 3;
/** Manuals whose checks are read at once. */
const AT_ONCE = 4;

/** How a language's translations stand at the ref, for step 3; null when it could not be read. */
interface LanguageState {
  readonly missing: number;
  readonly outdated: number;
}

/**
 * Screen 15, "New release" (`release.publish`): a dialog of four steps, each reachable by
 * keyboard (the step list, Back and Next).
 *
 * 1. **Product and version:** cut from `main` (or an open maintenance line), the product (a value
 *    of the product facet), the product version, and the commit it will tag.
 * 2. **Checks:** every manual's checks at that commit (`GET /manuals/:id/checks`), blocking first,
 *    each linking to its fix. While any blocking check is open, "Create release" is disabled with
 *    the reason; warnings need a confirmation that names their count (#241).
 * 3. **Outputs:** what the release renders: every manual in each of its variants and every
 *    configured language as PDF (the API renders them all; a manual it did not change reuses the
 *    last release's file), with how each language's translations stand.
 * 4. **Notes:** the summary, optional summaries per language, and "Major change".
 *
 * Then `POST /releases`; the new release opens (`created`).
 */
@Component({
  selector: 'of-create-release-dialog',
  imports: [
    UiTextPipe,
    FormsModule,
    RouterLink,
    TranslocoPipe,
    NgIcon,
    CollapseComponent,
    ZardDialogImports,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardCheckboxComponent,
    ZardInputComponent,
    ZardSelectImports,
    ZardSkeletonComponent,
    ZardTextareaComponent,
    GuardDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCircleCheck,
      lucideCircleX,
      lucideFileText,
      lucidePackage,
      lucideTriangleAlert,
    }),
  ],
  template: `
    <z-dialog [(zVisible)]="open" class="sm:max-w-[42rem]">
      <z-dialog-header>
        <z-dialog-title>{{
          'editor.releases.create.title' | transloco
        }}</z-dialog-title>
        <z-dialog-description class="break-words">{{
          'editor.releases.create.description' | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      @if (open()) {
        <nav
          [attr.aria-label]="'editor.releases.create.steps.label' | transloco"
        >
          <ol class="m-0 flex list-none flex-wrap gap-1 p-0">
            @for (s of steps; track s; let i = $index) {
              <li>
                <button
                  type="button"
                  class="focus-visible:ring-ring/50 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs outline-none focus-visible:ring-[3px]"
                  [class.bg-muted]="step() === s"
                  [class.font-medium]="step() === s"
                  [class.text-muted-foreground]="step() !== s"
                  [attr.aria-current]="step() === s ? 'step' : null"
                  [attr.data-step]="s"
                  (click)="go(s)"
                >
                  <span
                    class="border-border flex size-5 items-center justify-center rounded-full border text-[0.7rem] tabular-nums"
                    aria-hidden="true"
                    >{{ i + 1 }}</span
                  >
                  {{ stepText[s] | transloco }}
                </button>
              </li>
            }
          </ol>
        </nav>

        <form
          id="create-release-form"
          class="flex min-h-72 flex-col gap-4"
          novalidate
          (submit)="submit($event)"
        >
          <div
            class="flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm"
            data-slot="readiness"
            role="status"
            [class]="bannerClass()"
          >
            @switch (readiness().kind) {
              @case ('loading') {
                <z-skeleton
                  class="mt-0.5 size-4 rounded-full"
                  aria-hidden="true"
                />
                <span class="flex-1">{{
                  'editor.releases.create.checks.reading' | transloco
                }}</span>
              }
              @case ('failed') {
                <ng-icon
                  name="lucideCircleX"
                  class="mt-0.5 shrink-0"
                  aria-hidden="true"
                />
                <span class="flex-1 break-words">{{
                  'editor.releases.create.checks.failed' | transloco
                }}</span>
                <button
                  z-button
                  zType="link"
                  zSize="sm"
                  type="button"
                  class="h-auto p-0"
                  (click)="readChecks()"
                >
                  {{ 'editor.releases.retry' | transloco }}
                </button>
              }
              @default {
                <ng-icon
                  [name]="bannerIcon()"
                  class="mt-0.5 shrink-0"
                  aria-hidden="true"
                />
                <span class="flex-1 break-words">{{ bannerText() }}</span>
                @if (step() !== 'checks') {
                  <button
                    z-button
                    zType="link"
                    zSize="sm"
                    type="button"
                    class="h-auto p-0 text-current underline"
                    (click)="go('checks')"
                  >
                    {{ 'editor.releases.create.checks.view' | transloco }}
                  </button>
                }
              }
            }
          </div>

          @switch (step()) {
            @case ('product') {
              <div class="flex flex-col gap-4" data-step-body="product">
                @if (lines().length > 0) {
                  <div class="flex flex-col gap-1.5">
                    <span class="text-sm" id="release-from">{{
                      'editor.releases.create.from.label' | transloco
                    }}</span>
                    <z-select
                      zPosition="popper"
                      [zAriaLabel]="
                        'editor.releases.create.from.label' | transloco
                      "
                      [zValue]="from()"
                      (zSelectionChange)="setFrom($event)"
                    >
                      <z-select-item zValue="">{{
                        'editor.releases.create.from.main' | transloco
                      }}</z-select-item>
                      @for (l of lines(); track l.id) {
                        <z-select-item [zValue]="l.id">{{
                          'editor.releases.create.from.line'
                            | transloco
                              : {
                                  product: source.productLabel(
                                    l.attributes.product
                                  ),
                                  version: l.attributes.revision,
                                }
                        }}</z-select-item>
                      }
                    </z-select>
                  </div>
                }
                <div class="grid gap-4 sm:grid-cols-2">
                  <div class="flex flex-col gap-1.5">
                    <span class="text-sm">{{
                      'editor.releases.create.product.label' | transloco
                    }}</span>
                    <z-select
                      zPosition="popper"
                      data-slot="product"
                      [zDisabled]="!!line()"
                      [zInvalid]="!!shownProblems().product"
                      [zAriaLabel]="
                        'editor.releases.create.product.label' | transloco
                      "
                      [zPlaceholder]="
                        'editor.releases.create.product.placeholder' | transloco
                      "
                      [zValue]="product()"
                      (zSelectionChange)="setProduct($event)"
                    >
                      @for (p of source.products(); track p.id) {
                        <z-select-item [zValue]="p.id">{{
                          p.label
                        }}</z-select-item>
                      }
                    </z-select>
                    @if (shownProblems().product; as problem) {
                      <p class="text-destructive m-0 text-xs">
                        {{ problem | transloco }}
                      </p>
                    }
                  </div>
                  <div class="flex flex-col gap-1.5">
                    <label class="text-sm" for="release-version">{{
                      'editor.releases.create.revision.label' | transloco
                    }}</label>
                    <input
                      id="release-version"
                      z-input
                      autocomplete="off"
                      spellcheck="false"
                      maxlength="100"
                      aria-describedby="release-version-hint"
                      [attr.aria-invalid]="
                        shownProblems().revision ? 'true' : null
                      "
                      [value]="revision()"
                      (input)="revision.set($any($event.target).value)"
                    />
                    <p
                      id="release-version-hint"
                      class="text-muted-foreground m-0 text-xs break-words"
                      [class.text-destructive]="!!shownProblems().revision"
                    >
                      {{
                        shownProblems().revision ??
                          'editor.releases.create.revision.hint' | transloco
                      }}
                    </p>
                  </div>
                </div>
                <p
                  class="text-muted-foreground m-0 text-sm break-words"
                  data-slot="commit"
                >
                  @if (commit(); as c) {
                    @if (line(); as l) {
                      <!-- A line by its product and version, never its branch. -->
                      {{
                        'editor.releases.create.commit.line'
                          | transloco
                            : {
                                commit: short(c),
                                product: source.productLabel(
                                  l.attributes.product
                                ),
                                version: l.attributes.revision,
                              }
                      }}
                    } @else {
                      {{
                        'editor.releases.create.commit.main'
                          | transloco: { commit: short(c), branch: ref() }
                      }}
                    }
                  } @else {
                    {{ 'editor.releases.create.commit.unknown' | transloco }}
                  }
                </p>
              </div>
            }
            @case ('checks') {
              <div class="flex flex-col gap-3" data-step-body="checks">
                @if (manualChecks(); as list) {
                  @if (list.length === 0) {
                    <p class="text-muted-foreground m-0 text-sm">
                      {{
                        'editor.releases.create.checks.noManuals' | transloco
                      }}
                    </p>
                  }
                  <ul
                    class="m-0 flex max-h-80 list-none flex-col gap-2 overflow-y-auto p-0"
                  >
                    @for (m of list; track m.id) {
                      <li
                        class="border-border flex flex-col gap-1.5 rounded-lg border p-3"
                        data-slot="manual-checks"
                      >
                        <div class="flex flex-wrap items-center gap-2">
                          <span
                            class="me-auto min-w-0 font-medium break-words"
                            >{{ m.title }}</span
                          >
                          @if (m.failed) {
                            <z-badge zType="destructive">{{
                              'editor.releases.create.checks.manualFailed'
                                | transloco
                            }}</z-badge>
                          } @else {
                            @if (m.blocking > 0) {
                              <z-badge zType="destructive" class="gap-1">
                                <ng-icon
                                  name="lucideCircleX"
                                  aria-hidden="true"
                                />
                                {{
                                  'editor.releases.create.checks.blocking'
                                    | transloco: { count: m.blocking }
                                }}
                              </z-badge>
                            }
                            @if (m.warning > 0) {
                              <z-badge zType="warning" class="gap-1">
                                <ng-icon
                                  name="lucideTriangleAlert"
                                  aria-hidden="true"
                                />
                                {{
                                  'editor.releases.create.checks.warnings'
                                    | transloco: { count: m.warning }
                                }}
                              </z-badge>
                            }
                            @if (m.blocking === 0 && m.warning === 0) {
                              <z-badge zType="success" class="gap-1">
                                <ng-icon
                                  name="lucideCircleCheck"
                                  aria-hidden="true"
                                />
                                {{
                                  'editor.releases.create.checks.passed'
                                    | transloco
                                }}
                              </z-badge>
                            }
                          }
                        </div>
                        @for (c of m.checks; track c.id) {
                          <div
                            class="flex flex-wrap items-baseline gap-x-2 text-sm"
                          >
                            <span class="sr-only"
                              >{{
                                (c.attributes.severity === 'blocking'
                                  ? 'editor.releases.create.checks.blockingOne'
                                  : 'editor.releases.create.checks.warningOne'
                                ) | transloco
                              }}:</span
                            >
                            <ng-icon
                              aria-hidden="true"
                              class="shrink-0 translate-y-0.5"
                              [class.text-destructive]="
                                c.attributes.severity === 'blocking'
                              "
                              [class.text-warning]="
                                c.attributes.severity !== 'blocking'
                              "
                              [name]="
                                c.attributes.severity === 'blocking'
                                  ? 'lucideCircleX'
                                  : 'lucideTriangleAlert'
                              "
                            />
                            <span class="min-w-0 flex-1 break-words">
                              {{ checkTitle(c) | transloco }}:
                              {{ checkDetail(c) }}
                            </span>
                            <a
                              class="text-foreground focus-visible:ring-ring/50 rounded-sm text-xs underline underline-offset-4 outline-none focus-visible:ring-[3px]"
                              [routerLink]="fix(c).commands"
                              [queryParams]="fix(c).query"
                              (click)="open.set(false)"
                              >{{
                                'editor.releases.create.checks.fix' | transloco
                              }}</a
                            >
                          </div>
                        }
                        @if (m.blocking + m.warning > m.checks.length) {
                          <a
                            class="text-muted-foreground focus-visible:ring-ring/50 self-start rounded-sm text-xs underline underline-offset-4 outline-none focus-visible:ring-[3px]"
                            [routerLink]="['/checks']"
                            [queryParams]="{ manual: m.id }"
                            (click)="open.set(false)"
                            >{{
                              'editor.releases.create.checks.all'
                                | transloco: { count: m.blocking + m.warning }
                            }}</a
                          >
                        }
                      </li>
                    }
                  </ul>
                } @else {
                  <div class="flex flex-col gap-2" aria-hidden="true">
                    <z-skeleton class="h-14 w-full" />
                    <z-skeleton class="h-14 w-full" />
                  </div>
                }
                @if (readiness(); as r) {
                  @if (r.kind === 'read' && r.blocking === 0 && r.warning > 0) {
                    <z-checkbox
                      data-field="confirm-warnings"
                      [ngModel]="warningsConfirmed()"
                      [ngModelOptions]="{ standalone: true }"
                      (checkChange)="warningsConfirmed.set($event)"
                      >{{
                        'editor.releases.create.checks.confirm'
                          | transloco: { count: r.warning }
                      }}</z-checkbox
                    >
                  }
                }
              </div>
            }
            @case ('outputs') {
              <div class="flex flex-col gap-4" data-step-body="outputs">
                <p class="text-muted-foreground m-0 text-sm break-words">
                  {{ 'editor.releases.create.outputs.intro' | transloco }}
                </p>
                <div class="flex flex-col gap-1.5">
                  <span class="text-sm">{{
                    'editor.releases.create.outputs.languages' | transloco
                  }}</span>
                  <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
                    @for (l of languages(); track l) {
                      <li
                        class="flex items-center gap-2 text-sm"
                        data-slot="language"
                      >
                        <ng-icon
                          name="lucideCircleCheck"
                          class="text-muted-foreground shrink-0"
                          aria-hidden="true"
                        />
                        <span class="me-auto break-words">{{
                          languageLabel(l)
                        }}</span>
                        @if (l === sourceLanguage()) {
                          <z-badge zType="outline" class="font-normal">{{
                            'editor.releases.create.outputs.source' | transloco
                          }}</z-badge>
                        } @else if (languageStates()[l]; as st) {
                          @if (st.missing + st.outdated === 0) {
                            <z-badge zType="success" class="font-normal">{{
                              'editor.releases.create.outputs.complete'
                                | transloco
                            }}</z-badge>
                          } @else {
                            <z-badge
                              zType="warning"
                              class="h-auto font-normal whitespace-normal"
                              >{{ languageStateText(st) }}</z-badge
                            >
                          }
                        }
                      </li>
                    }
                  </ul>
                </div>
                <div class="flex flex-col gap-1.5">
                  <span class="text-sm">{{
                    'editor.releases.create.outputs.manuals' | transloco
                  }}</span>
                  @if (manuals(); as list) {
                    <ul
                      class="m-0 flex max-h-48 list-none flex-col gap-1 overflow-y-auto p-0"
                    >
                      @for (m of list; track m.id) {
                        <li class="flex items-center gap-2 text-sm">
                          <ng-icon
                            name="lucideFileText"
                            class="text-muted-foreground shrink-0"
                            aria-hidden="true"
                          />
                          <span class="me-auto min-w-0 break-words">{{
                            m.attributes.title | uiText
                          }}</span>
                          <span
                            class="text-muted-foreground shrink-0 text-xs"
                            >{{
                              'editor.releases.create.outputs.files'
                                | transloco
                                  : {
                                      variants: m.meta.variants.length,
                                      files:
                                        m.meta.variants.length *
                                        languages().length,
                                    }
                            }}</span
                          >
                        </li>
                      } @empty {
                        <li class="text-muted-foreground text-sm">
                          {{
                            'editor.releases.create.checks.noManuals'
                              | transloco
                          }}
                        </li>
                      }
                    </ul>
                  } @else {
                    <z-skeleton class="h-14 w-full" aria-hidden="true" />
                  }
                </div>
              </div>
            }
            @case ('notes') {
              <div class="flex flex-col gap-4" data-step-body="notes">
                <div class="flex flex-col gap-1.5">
                  <label class="text-sm" for="release-notes">{{
                    'editor.releases.create.notes.label' | transloco
                  }}</label>
                  <textarea
                    id="release-notes"
                    z-textarea
                    rows="4"
                    aria-describedby="release-notes-hint"
                    [attr.maxlength]="notesMax"
                    [attr.aria-invalid]="
                      notesProblemOf(notes()) ? 'true' : null
                    "
                    [value]="notes()"
                    (input)="notes.set($any($event.target).value)"
                  ></textarea>
                  <p
                    id="release-notes-hint"
                    class="text-muted-foreground m-0 text-xs break-words"
                    [class.text-destructive]="!!notesProblemOf(notes())"
                  >
                    {{
                      notesProblemOf(notes()) ??
                        'editor.releases.create.notes.hint' | transloco
                    }}
                  </p>
                </div>
                <div class="flex flex-col gap-2">
                  <button
                    z-button
                    zType="outline"
                    zSize="sm"
                    type="button"
                    class="self-start"
                    aria-controls="release-language-notes"
                    [attr.aria-expanded]="perLanguage()"
                    (click)="perLanguage.set(!perLanguage())"
                  >
                    {{ 'editor.releases.create.notes.perLanguage' | transloco }}
                  </button>
                  <of-collapse
                    id="release-language-notes"
                    [open]="perLanguage()"
                  >
                    <div class="flex flex-col gap-3 pt-1">
                      @for (l of languages(); track l) {
                        <div class="flex flex-col gap-1.5">
                          <label
                            class="text-sm"
                            [attr.for]="'release-notes-' + l"
                            >{{
                              'editor.releases.create.notes.inLanguage'
                                | transloco: { language: languageLabel(l) }
                            }}</label
                          >
                          <textarea
                            z-textarea
                            rows="2"
                            [id]="'release-notes-' + l"
                            [attr.maxlength]="notesMax"
                            [attr.aria-invalid]="
                              notesProblemOf(languageNotes()[l] ?? '')
                                ? 'true'
                                : null
                            "
                            [value]="languageNotes()[l] ?? ''"
                            (input)="
                              setLanguageNotes(l, $any($event.target).value)
                            "
                          ></textarea>
                          @if (
                            notesProblemOf(languageNotes()[l] ?? '');
                            as problem
                          ) {
                            <p class="text-destructive m-0 text-xs">
                              {{ problem | transloco }}
                            </p>
                          }
                        </div>
                      }
                    </div>
                  </of-collapse>
                </div>
                <div class="flex flex-col gap-1">
                  <z-checkbox
                    data-field="major"
                    aria-describedby="release-major-hint"
                    [ngModel]="major()"
                    [ngModelOptions]="{ standalone: true }"
                    (checkChange)="major.set($event)"
                    >{{
                      'editor.releases.create.major.label' | transloco
                    }}</z-checkbox
                  >
                  <p
                    id="release-major-hint"
                    class="text-muted-foreground m-0 ps-6 text-xs break-words"
                  >
                    {{ 'editor.releases.create.major.hint' | transloco }}
                  </p>
                </div>
              </div>
            }
          }

          <p class="text-muted-foreground m-0 text-xs break-words">
            {{ 'editor.releases.create.final' | transloco }}
          </p>
          @if (blocked(); as reason) {
            @if (step() === 'notes') {
              <p
                class="text-muted-foreground m-0 text-sm break-words"
                data-slot="blocked"
              >
                {{ reason | transloco }}
              </p>
            }
          }
          @if (error(); as message) {
            <p
              class="text-destructive m-0 text-sm break-words"
              role="alert"
              aria-live="assertive"
            >
              {{ message }}
            </p>
          }
        </form>
      }
      <z-dialog-footer>
        <button z-button zType="ghost" type="button" z-dialog-close>
          {{ 'editor.releases.cancel' | transloco }}
        </button>
        @if (index() > 0) {
          <button z-button zType="outline" type="button" (click)="back()">
            {{ 'editor.releases.create.back' | transloco }}
          </button>
        }
        @if (step() !== 'notes') {
          <button z-button type="button" data-slot="next" (click)="next()">
            {{ 'editor.releases.create.next' | transloco }}
          </button>
        } @else {
          <button
            z-button
            type="submit"
            form="create-release-form"
            data-slot="create"
            [zLoading]="busy()"
            [ofGuard]="{
              permission: 'release.publish',
              blockedReason: blocked(),
            }"
          >
            <ng-icon
              name="lucidePackage"
              data-icon="inline-start"
              aria-hidden="true"
            />
            {{ 'editor.releases.create.submit' | transloco }}
          </button>
        }
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class CreateReleaseDialogComponent {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);
  private readonly toast = inject(ToastService);
  private readonly language = inject(LanguageService);
  private readonly texts = inject(UiTexts);
  private readonly t = injectTranslate();
  private readonly document = inject(DOCUMENT);
  protected readonly source = inject(ReleaseSource);

  readonly open = model(false);
  readonly created = output<ReleaseItem>();

  protected readonly steps = STEPS;
  protected readonly stepText = STEP_TEXT;
  protected readonly notesMax = NOTES_MAX;

  protected readonly step = signal<Step>('product');
  protected readonly from = signal('');
  protected readonly product = signal('');
  protected readonly revision = signal('');
  protected readonly notes = signal('');
  protected readonly languageNotes = signal<Readonly<Record<string, string>>>(
    {},
  );
  protected readonly perLanguage = signal(false);
  protected readonly major = signal(false);
  protected readonly warningsConfirmed = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  private readonly triedDetails = signal(false);

  protected readonly lines = signal<readonly MaintenanceLine[]>([]);
  protected readonly manuals = signal<readonly ManualItem[] | null>(null);
  protected readonly manualChecks = signal<readonly ManualReadiness[] | null>(
    null,
  );
  protected readonly languageStates = signal<
    Readonly<Record<string, LanguageState>>
  >({});
  private readonly mainCommit = signal<string | null>(null);
  /** Each opening; a read for an earlier one is dropped. */
  private openings = 0;
  /** Each read at a ref; a read at an earlier one is dropped. */
  private reads = 0;

  protected readonly index = computed(() => STEPS.indexOf(this.step()));
  protected readonly line = computed(
    () => this.lines().find((l) => l.id === this.from()) ?? null,
  );
  /** Where the release is cut from: `main`, or the line's branch. */
  protected readonly ref = computed(
    () => this.line()?.attributes.branch ?? MAIN,
  );
  protected readonly commit = computed(() =>
    this.line() ? this.line()?.meta.head : this.mainCommit(),
  );

  protected readonly sourceLanguage = computed(
    () => this.source.config()?.languages.source ?? '',
  );
  protected readonly languages = computed(() => {
    const config = this.source.config();
    return config ? [config.languages.source, ...config.languages.targets] : [];
  });

  private readonly problems = computed(() => ({
    product: this.product() ? null : 'editor.releases.create.product.required',
    revision: revisionProblem(this.revision()),
  }));
  protected readonly shownProblems = computed(() =>
    this.triedDetails() ? this.problems() : { product: null, revision: null },
  );

  protected readonly readiness = computed(() =>
    readinessOf(this.manualChecks()),
  );

  protected readonly blocked = computed(() =>
    createBlocked({
      readiness: this.readiness(),
      warningsConfirmed: this.warningsConfirmed(),
      detailsProblem: !!this.problems().product || !!this.problems().revision,
      notesProblem:
        !!notesProblem(this.notes()) ||
        Object.values(this.languageNotes()).some((n) => !!notesProblem(n)),
      busy: this.busy(),
    }),
  );

  protected readonly bannerClass = computed(() => {
    const r = this.readiness();
    if (r.kind === 'loading') return 'border-border';
    if (r.kind === 'failed' || r.blocking > 0)
      return 'border-destructive/40 bg-destructive-muted text-destructive';
    if (r.warning > 0) return 'border-warning/40 bg-warning-muted text-warning';
    return 'border-success/40 bg-success-muted text-success';
  });
  protected readonly bannerIcon = computed(() => {
    const r = this.readiness();
    if (r.kind !== 'read' || r.blocking > 0) return 'lucideCircleX';
    return r.warning > 0 ? 'lucideTriangleAlert' : 'lucideCircleCheck';
  });
  protected readonly bannerText = computed(() => {
    const r = this.readiness();
    if (r.kind !== 'read') return '';
    if (r.blocking > 0)
      return this.t('editor.releases.create.checks.bannerBlocking', {
        count: r.blocking,
      });
    if (r.warning > 0)
      return this.t('editor.releases.create.checks.bannerWarnings', {
        count: r.warning,
      });
    return this.t('editor.releases.create.checks.bannerPassed');
  });

  constructor() {
    // Every opening starts afresh and reads what the dialog shows.
    effect(() => {
      if (!this.open()) return;
      this.me.me();
      untracked(() => {
        this.reset();
        void this.start();
      });
    });
  }

  protected go(step: Step): void {
    if (step !== 'product' && this.step() === 'product')
      this.triedDetails.set(true);
    this.step.set(step);
  }

  protected next(): void {
    const next = STEPS[this.index() + 1];
    if (!next) return;
    if (this.step() === 'product') {
      this.triedDetails.set(true);
      const { product, revision } = this.problems();
      if (product || revision) {
        if (revision) this.document.getElementById('release-version')?.focus();
        return;
      }
    }
    this.step.set(next);
  }

  protected back(): void {
    const previous = STEPS[this.index() - 1];
    if (previous) this.step.set(previous);
  }

  protected setFrom(value: string | string[]): void {
    const id = Array.isArray(value) ? (value[0] ?? '') : value;
    if (id === this.from()) return;
    this.from.set(id);
    const line = this.line();
    if (line) this.product.set(line.attributes.product);
    this.warningsConfirmed.set(false);
    void this.readAtRef();
  }

  protected setProduct(value: string | string[]): void {
    this.product.set(Array.isArray(value) ? (value[0] ?? '') : value);
  }

  protected setLanguageNotes(lang: string, text: string): void {
    this.languageNotes.update((n) => ({ ...n, [lang]: text }));
  }

  protected languageLabel(lang: string): string {
    return languageName(this.language.locale(), lang);
  }

  protected languageStateText(state: LanguageState): string {
    const parts: string[] = [];
    if (state.missing > 0)
      parts.push(
        this.t('editor.releases.create.outputs.fallsBack', {
          count: state.missing,
          language: this.languageLabel(this.sourceLanguage()),
        }),
      );
    if (state.outdated > 0)
      parts.push(
        this.t('editor.releases.create.outputs.outdated', {
          count: state.outdated,
        }),
      );
    return parts.join(' · ');
  }

  protected notesProblemOf(text: string): string | null {
    return notesProblem(text);
  }

  protected short(commit: string): string {
    return shortCommit(commit);
  }

  protected checkTitle(check: CheckItem): string {
    return CHECK_TITLES[check.attributes.code];
  }

  protected checkDetail(check: CheckItem): string {
    const text = detailOf(check, (lang) => this.languageLabel(lang));
    return this.t(text.key, text.params);
  }

  protected fix(check: CheckItem) {
    return fixLinkOf(check);
  }

  protected readChecks(): void {
    void this.readAtRef();
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    // Enter in a field before the last step goes on to the next one.
    if (this.step() !== 'notes') {
      this.next();
      return;
    }
    if (this.blocked()) return;
    this.busy.set(true);
    this.error.set('');
    const notes = this.notes().trim();
    const byLanguage = notesByLanguageOf(this.languageNotes());
    const line = this.line();
    try {
      const doc = await firstValueFrom(
        this.api.post('/releases', {
          data: {
            type: 'Release',
            attributes: {
              product: this.product(),
              revision: this.revision().trim(),
              ...(notes ? { notes } : {}),
              ...(Object.keys(byLanguage).length > 0
                ? { notesByLanguage: byLanguage }
                : {}),
              major: this.major(),
              ...(line ? { maintenanceLine: line.id } : {}),
            },
          },
        }),
      );
      this.toast.success(
        translated('editor.releases.create.done', {
          name: this.t('editor.releases.name', {
            product: this.source.productLabel(doc.data.attributes.product),
            version: doc.data.attributes.revision,
          }),
        }),
      );
      this.open.set(false);
      this.created.emit(doc.data);
    } catch (error) {
      const text = apiErrorText(toApiError(error));
      this.error.set(this.t(text.key, text.params));
    } finally {
      this.busy.set(false);
    }
  }

  private reset(): void {
    this.openings++;
    this.reads++;
    this.step.set('product');
    this.from.set('');
    this.product.set('');
    this.revision.set('');
    this.notes.set('');
    this.languageNotes.set({});
    this.perLanguage.set(false);
    this.major.set(false);
    this.warningsConfirmed.set(false);
    this.busy.set(false);
    this.error.set('');
    this.triedDetails.set(false);
    this.lines.set([]);
    this.mainCommit.set(null);
  }

  private async start(): Promise<void> {
    const opening = this.openings;
    await this.source.readConfig();
    if (opening !== this.openings) return;
    // One product only: chosen already.
    const products = this.source.products();
    if (products.length === 1 && !this.product())
      this.product.set(products[0]?.id ?? '');
    void this.readLines(opening);
    void this.readMainCommit(opening);
    // The checks need no configuration: a failed read of it still shows them (or their Retry).
    void this.readAtRef();
  }

  /** The open maintenance lines (`content.read.draft`); none for whoever may not read them. */
  private async readLines(opening: number): Promise<void> {
    try {
      const doc = await firstValueFrom(
        this.api.get('/maintenance-lines', {
          query: {
            'filter[state]': 'open',
            ...pageQuery({ number: 1, size: 100 }),
          },
        }),
      );
      if (opening === this.openings) this.lines.set(doc.data);
    } catch {
      // Lines need `content.read.draft`: without it, releases are cut from `main` only.
    }
  }

  private async readMainCommit(opening: number): Promise<void> {
    try {
      const doc = await firstValueFrom(
        this.api.get('/refs', { query: pageQuery({ number: 1, size: 200 }) }),
      );
      const main = doc.data.find(
        (r) => r.attributes.kind === 'branch' && r.attributes.name === MAIN,
      );
      if (opening === this.openings && main)
        this.mainCommit.set(main.attributes.commit);
    } catch {
      // The checks name the commit they read, too.
    }
  }

  /** The manuals, their checks and the languages' translations at the ref released. */
  private async readAtRef(): Promise<void> {
    const read = ++this.reads;
    const ref = this.ref();
    this.manuals.set(null);
    this.manualChecks.set(null);
    this.languageStates.set({});
    void this.readLanguageStates(read, ref);
    let manuals: ManualItem[];
    try {
      manuals = await this.source.manuals(ref);
    } catch {
      if (read !== this.reads) return;
      this.manuals.set([]);
      this.manualChecks.set([
        {
          id: '',
          title: '',
          blocking: 0,
          warning: 0,
          checks: [],
          failed: true,
        },
      ]);
      return;
    }
    if (read !== this.reads) return;
    this.manuals.set(manuals);
    const results: ManualReadiness[] = [];
    const queue = [...manuals];
    const work = async () => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        results.push(await this.readChecksOf(m, ref));
      }
    };
    await Promise.all(Array.from({ length: AT_ONCE }, work));
    if (read !== this.reads) return;
    this.manualChecks.set(byUrgency(results));
  }

  private async readChecksOf(
    manual: ManualItem,
    ref: string,
  ): Promise<ManualReadiness> {
    const base = {
      id: manual.id,
      title: this.texts.text(manual.attributes.title),
    };
    try {
      const doc = await firstValueFrom(
        this.api.get('/manuals/{id}/checks', {
          path: { id: manual.id },
          query: { ref, ...pageQuery({ number: 1, size: 50 }) },
        }),
      );
      if (ref === MAIN && !this.mainCommit())
        this.mainCommit.set(doc.meta.commit);
      return {
        ...base,
        blocking: doc.meta.counts.blocking,
        warning: doc.meta.counts.warning,
        checks: firstChecks(doc.data, CHECKS_SHOWN),
        failed: false,
      };
    } catch {
      return { ...base, blocking: 0, warning: 0, checks: [], failed: true };
    }
  }

  /** How each target language's translations stand (missing, outdated); left out when unreadable. */
  private async readLanguageStates(read: number, ref: string): Promise<void> {
    const config = await this.source.readConfig();
    if (!config || read !== this.reads) return;
    const count = (lang: string, state: 'missing' | 'outdated') =>
      firstValueFrom(
        this.api.get('/translations/status', {
          query: {
            ref,
            'filter[lang]': lang,
            'filter[state]': state,
            // Modules only: a page design's region text (#568) is not what these count.
            'filter[kind]': 'module',
            ...pageQuery({ number: 1, size: 1 }),
          },
        }),
      ).then((doc) => doc.meta.page.total);
    for (const lang of config.languages.targets) {
      try {
        const [missing, outdated] = await Promise.all([
          count(lang, 'missing'),
          count(lang, 'outdated'),
        ]);
        if (read !== this.reads) return;
        this.languageStates.update((s) => ({
          ...s,
          [lang]: { missing, outdated },
        }));
      } catch {
        // Needs `translation.manage` or `content.read.draft`: the language is listed without it.
      }
    }
  }
}
