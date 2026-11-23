import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  linkedSignal,
  output,
  resource,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideRepeat,
  lucideSearch,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
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

import type { Block as ModelBlock } from '@openfolia/content-model/core';
import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { StatusBadgeComponent, type ContentStatus } from '@openfolia/ui/badges';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { injectTranslate, LanguageService } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardInputGroupImports } from '@openfolia/ui/input-group';
import { ListFrameComponent, ListRowDirective } from '@openfolia/ui/list-frame';
import { ZardRadioGroupImports } from '@openfolia/ui/radio-group';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { FadeInDirective } from '@openfolia/ui/smooth';

import {
  ApiClient,
  pageQuery,
  ReadRef,
  toApiError,
  type ApiError,
  type Response,
} from '../api';
import { languageName, type ProjectConfig } from '../content/browser-model';
import { FilterChipComponent } from '../content/filter-chip.component';
import {
  BLOCK_TYPE_NAMES,
  blockChoices,
  type BlockChoice,
} from '../doc-editor/blocks/block-choices';
import type { ModulePick } from '../doc-editor/blocks/doc-blocks-context';
import { apiErrorText } from '../i18n';
import { MeService } from '../permissions/me';
import { unitsOf, type Unit } from '../review/review-diff';
import { Generation } from '../shared/generation';
import {
  cyclePath,
  includedBy,
  loadModuleGraph,
  readModuleRefs,
  reachingModules,
  toGraphModule,
  type GraphModule,
  type ModuleGraph,
} from './module-graph';

/** What the module picker is opened for. */
export interface ModulePickRequest {
  /** The module being edited: it may not include itself, directly or through others. */
  readonly moduleId: string;
  /** The document's language: modules are listed, previewed and checked in it. */
  readonly lang: string;
  /** The module's facet values ("Same …" narrows the list to modules with all of them). */
  readonly facets: Readonly<Record<string, readonly string[]>>;
  readonly config: ProjectConfig;
  /**
   * For a cross-reference: the module is linked to, never included ("Whole module" is shown
   * disabled with the reason, and the cycle check does not apply).
   */
  readonly linkOnly?: boolean;
  /**
   * For a snippet: only snippets are listed (`filter[snippet]=true`), inserted as a reference
   * (kept in sync) or as a copy (its blocks, new IDs).
   */
  readonly snippet?: boolean;
}

/** The longest search the API takes (after trimming). */
const QUERY_MAX = 200;
/** How long typing pauses before a search is sent, in ms. */
const SEARCH_DEBOUNCE = 200;
const PAGE_SIZE = 20;
/** The API takes at most this many facet filters. */
const MAX_FACETS = 32;
/** Blocks shown in the preview. */
const PREVIEW_UNITS = 8;
/** Modules named under "Also used in"; the rest are counted. */
const USED_IN_SHOWN = 5;

/** A module of the list. */
interface Row {
  readonly id: string;
  readonly title: string;
}

interface ListKey {
  readonly open: boolean;
  readonly snippet: boolean;
  readonly term: string;
  readonly type: string;
  readonly facets: readonly string[];
  readonly page: number;
  readonly lang: string;
  readonly ref: string | undefined;
  readonly user: string;
  readonly attempt: number;
}

type ListState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly previous: ListPage | null }
  | { readonly status: 'ready'; readonly page: ListPage }
  | { readonly status: 'error'; readonly error: ApiError };

interface ListPage {
  readonly rows: readonly Row[];
  readonly meta: Response<'/search'>['meta']['page'];
}

type GraphState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly graph: ModuleGraph }
  | { readonly status: 'error'; readonly error: ApiError };

const sameKey = (a: ListKey, b: ListKey): boolean =>
  a.open === b.open &&
  a.snippet === b.snippet &&
  a.term === b.term &&
  a.type === b.type &&
  a.facets.join('\n') === b.facets.join('\n') &&
  a.page === b.page &&
  a.lang === b.lang &&
  a.ref === b.ref &&
  a.user === b.user &&
  a.attempt === b.attempt;

/**
 * A module's status as the picker shows it: changed against `main` (or not there) is a draft,
 * one under review in an open change set is in review, the rest is released.
 */
export function pickerStatus(module: GraphModule): ContentStatus {
  const { status } = module;
  if (status.changeSets?.some((c) => c.state === 'in-review'))
    return 'in-review';
  if (status.main?.same !== true) return 'draft';
  return 'released';
}

/**
 * Screen 9, the module reference picker: a search over `GET /search` (nothing typed: the
 * filtered list of `GET /module-summaries`), narrowed by type and by the module's own facet
 * values, a preview of the chosen module and how to insert it: whole (a module reference, kept
 * in sync), one block from it (#223: the preview turns into a chooser of its blocks; a module
 * reference naming that block, kept in sync) or as a link (a cross-reference).
 *
 * **No cycles.** The reference graph (`module-graph.ts`, every module from `GET /modules`) marks
 * the modules that include this one, directly or through others, and the chosen one's way back
 * here is named; inserting such a module whole, or a block of it, is disabled with the reason
 * (the content model counts cycles by module; a link is no inclusion, so it stays possible). The
 * module itself can neither be included nor linked.
 */
@Component({
  selector: 'of-module-picker-dialog',
  imports: [
    TranslocoPipe,
    NgIcon,
    ZardDialogImports,
    ZardButtonComponent,
    ZardInputComponent,
    ZardInputGroupImports,
    ZardRadioGroupImports,
    ZardSkeletonComponent,
    ZardBadgeComponent,
    StatusBadgeComponent,
    ListFrameComponent,
    ListRowDirective,
    FadeInDirective,
    FilterChipComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideRepeat,
      lucideSearch,
      lucideTriangleAlert,
    }),
  ],
  template: `
    <z-dialog
      [zVisible]="open()"
      (zVisibleChange)="visibleChange($event)"
      class="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-[60rem]"
    >
      <z-dialog-header class="border-border border-b px-6 py-5">
        <z-dialog-title class="text-lg">{{
          (snippetMode()
            ? 'editor.modulePicker.snippetTitle'
            : 'editor.modulePicker.title'
          ) | transloco
        }}</z-dialog-title>
        <z-dialog-description class="sr-only">{{
          (snippetMode()
            ? 'editor.modulePicker.snippetDescription'
            : 'editor.modulePicker.description'
          ) | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      @if (shown(); as req) {
        <div
          class="grid min-h-0 overflow-y-auto md:h-[36rem] md:grid-cols-2 md:overflow-hidden"
        >
          <!-- The search, the filters and the list. -->
          <div class="flex min-h-0 min-w-0 flex-col gap-3 p-4 md:p-5">
            <z-input-group class="w-full">
              <z-input-group-addon>
                <ng-icon name="lucideSearch" aria-hidden="true" />
              </z-input-group-addon>
              <input
                #search
                z-input
                cdkFocusInitial
                type="search"
                autocomplete="off"
                [attr.maxlength]="queryMax"
                [attr.aria-label]="searchLabel() | transloco"
                [placeholder]="searchLabel() | transloco"
                [value]="typed()"
                (input)="type($any($event.target).value)"
                (keydown.arrowdown)="focusRow(0, $event)"
              />
            </z-input-group>
            <div
              class="flex flex-wrap items-center gap-2"
              role="group"
              [attr.aria-label]="'editor.modulePicker.filters' | transloco"
            >
              @if (facetFilter().length > 0) {
                <button
                  z-button
                  zType="outline"
                  type="button"
                  class="h-8 max-w-full rounded-full px-3"
                  [class.bg-accent]="sameFacets()"
                  [attr.aria-pressed]="sameFacets()"
                  (click)="toggleSameFacets()"
                >
                  @if (sameFacets()) {
                    <ng-icon
                      name="lucideCheck"
                      class="size-4"
                      aria-hidden="true"
                    />
                  }
                  <span class="min-w-0 truncate">{{
                    'editor.modulePicker.sameFacets'
                      | transloco: { facets: facetNames() }
                  }}</span>
                </button>
              }
              <of-filter-chip
                [label]="'editor.modulePicker.type' | transloco"
                [allLabel]="'editor.content.filters.all' | transloco"
                [options]="typeOptions()"
                [value]="typeFilter()"
                (changed)="setType($event)"
              />
            </div>
            <of-list-frame
              class="min-h-0 flex-1"
              cards
              offset="18rem"
              [label]="'editor.modulePicker.list' | transloco"
              [items]="rows()"
              [page]="listPage()?.meta ?? null"
              [loading]="listLoading()"
              [error]="listError()"
              [skeletonRows]="5"
              [emptyTitle]="'editor.modulePicker.emptyTitle' | transloco"
              [emptyDescription]="
                'editor.modulePicker.emptyDescription' | transloco
              "
              (pageChange)="page.set($event)"
              (retry)="attempt.set(attempt() + 1)"
            >
              <ng-template ofListRow let-item>
                @let row = asRow(item);
                @let m = moduleOf(row.id);
                @let loops = includesThis(row.id);
                <button
                  type="button"
                  data-picker-row
                  class="hover:bg-muted focus-visible:ring-ring flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-start outline-none focus-visible:ring-2"
                  [class.bg-muted]="selected() === row.id"
                  [attr.aria-pressed]="selected() === row.id"
                  (click)="choose(row.id)"
                  (keydown.arrowdown)="moveRow($event, 1)"
                  (keydown.arrowup)="moveRow($event, -1)"
                >
                  <!-- The chosen row: a check, not only its background. -->
                  <ng-icon
                    name="lucideCheck"
                    class="mt-0.5 size-4 shrink-0"
                    [class.invisible]="selected() !== row.id"
                    aria-hidden="true"
                  />
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="text-sm font-medium break-words">{{
                      row.title
                    }}</span>
                    <span class="text-muted-foreground text-xs break-words">{{
                      m ? pathOf(m) : row.id
                    }}</span>
                  </span>
                  <span class="flex shrink-0 flex-col items-end gap-1">
                    @if (row.id === req.moduleId) {
                      <z-badge zType="outline">{{
                        'editor.modulePicker.thisModule' | transloco
                      }}</z-badge>
                    } @else if (loops) {
                      <z-badge zType="outline" class="gap-1">
                        <ng-icon
                          name="lucideRepeat"
                          class="size-3"
                          aria-hidden="true"
                        />
                        {{ 'editor.modulePicker.includesThis' | transloco }}
                      </z-badge>
                    }
                    @if (m) {
                      <of-status-badge ofFadeIn [status]="statusOf(m)" />
                    }
                  </span>
                </button>
              </ng-template>
            </of-list-frame>
          </div>

          <!-- The chosen module: its preview and how to insert it. -->
          <section
            class="bg-muted/60 border-border flex min-h-0 min-w-0 flex-col gap-5 border-t md:overflow-y-auto p-4 md:border-t-0 md:border-s md:p-6"
            [attr.aria-label]="'editor.modulePicker.previewRegion' | transloco"
          >
            @let id = selected();
            @if (!id) {
              <p class="text-muted-foreground m-0 text-sm">
                {{ 'editor.modulePicker.chooseHint' | transloco }}
              </p>
            } @else {
              <div class="flex flex-col gap-3" aria-live="polite">
                <p class="text-muted-foreground m-0 text-xs">
                  {{
                    'editor.modulePicker.previewOf'
                      | transloco: { lang: previewLanguage() }
                  }}
                </p>
                @switch (preview.status()) {
                  @case ('error') {
                    <div
                      class="flex flex-col items-start gap-2 text-sm"
                      role="alert"
                    >
                      <p class="m-0 flex items-center gap-2">
                        <ng-icon
                          name="lucideTriangleAlert"
                          aria-hidden="true"
                        />
                        {{ 'editor.modulePicker.previewFailed' | transloco }}
                      </p>
                      <button
                        z-button
                        zType="outline"
                        zSize="sm"
                        type="button"
                        (click)="preview.reload()"
                      >
                        {{ 'editor.modulePicker.retry' | transloco }}
                      </button>
                    </div>
                  }
                  @case ('resolved') {
                    @if (preview.value(); as p) {
                      <div ofFadeIn class="flex flex-col gap-3">
                        <h3
                          class="m-0 text-xl font-medium break-words"
                          [attr.lang]="p.lang"
                        >
                          {{ p.title }}
                        </h3>
                        @if (mode() === 'block') {
                          @let choices = blockChoicesOf(p);
                          @if (choices.length === 0) {
                            <p class="text-muted-foreground m-0 text-sm">
                              {{ 'editor.modulePicker.noBlocks' | transloco }}
                            </p>
                          } @else {
                            <p
                              id="module-picker-blocks-label"
                              class="text-muted-foreground m-0 text-xs"
                            >
                              {{
                                'editor.modulePicker.chooseBlock' | transloco
                              }}
                            </p>
                            <z-radio-group
                              ofFadeIn
                              data-block-chooser
                              class="border-border bg-background flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-md border p-1"
                              aria-labelledby="module-picker-blocks-label"
                              [value]="chosenBlock()"
                              (valueChange)="chooseBlock($event)"
                            >
                              @for (c of choices; track c.id) {
                                <label
                                  class="hover:bg-muted flex cursor-pointer items-start gap-2 rounded-md py-1.5 pe-2"
                                  [class.bg-muted]="chosenBlock() === c.id"
                                  [style.padding-inline-start.rem]="
                                    0.5 + c.depth * 0.75
                                  "
                                >
                                  <z-radio
                                    class="mt-0.5"
                                    [value]="c.id"
                                    [zId]="'module-picker-block-' + c.id"
                                  />
                                  <span class="flex min-w-0 flex-col gap-0.5">
                                    <span
                                      class="text-muted-foreground text-xs"
                                      >{{ typeName(c) | transloco }}</span
                                    >
                                    <span
                                      class="line-clamp-2 text-sm break-words"
                                      [attr.lang]="p.lang"
                                      >{{ c.text || c.id }}</span
                                    >
                                  </span>
                                </label>
                              }
                            </z-radio-group>
                          }
                        } @else {
                          @let units = previewUnits(p);
                          @if (units.length === 0) {
                            <p class="text-muted-foreground m-0 text-sm">
                              {{ 'editor.modulePicker.noText' | transloco }}
                            </p>
                          } @else {
                            <div
                              class="text-muted-foreground flex flex-col gap-1.5 text-sm break-words"
                              [attr.lang]="p.lang"
                            >
                              @for (u of units; track u.id) {
                                <p
                                  class="m-0 line-clamp-3"
                                  [class.text-foreground]="u.kind === 'heading'"
                                  [class.font-medium]="u.kind === 'heading'"
                                  [style.padding-inline-start.rem]="
                                    u.depth * 0.75
                                  "
                                >
                                  {{ u.text }}
                                </p>
                              }
                            </div>
                          }
                        }
                      </div>
                    } @else {
                      <p class="text-muted-foreground m-0 text-sm">
                        {{ 'editor.modulePicker.previewMissing' | transloco }}
                      </p>
                    }
                  }
                  @default {
                    <div
                      ofFadeIn="delayed"
                      class="flex flex-col gap-3"
                      aria-hidden="true"
                    >
                      <z-skeleton class="h-6 w-48" />
                      <z-skeleton class="h-2.5 w-11/12" />
                      <z-skeleton class="h-2.5 w-4/5" />
                      <z-skeleton class="h-2.5 w-2/3" />
                    </div>
                  }
                }
              </div>

              <fieldset class="m-0 flex flex-col gap-3 border-0 p-0">
                <legend class="text-muted-foreground mb-3 p-0 text-xs">
                  {{ 'editor.modulePicker.insertAs' | transloco }}
                </legend>
                <z-radio-group
                  class="flex flex-col gap-3"
                  [attr.aria-label]="'editor.modulePicker.insertAs' | transloco"
                  [value]="mode()"
                  (valueChange)="setMode($event)"
                >
                  @if (snippetMode()) {
                    <label class="flex cursor-pointer items-start gap-3">
                      <z-radio value="whole" zId="module-picker-reference" />
                      <span class="flex min-w-0 flex-col gap-0.5">
                        <span class="text-sm font-medium">{{
                          'editor.modulePicker.asReference' | transloco
                        }}</span>
                        <span
                          class="text-muted-foreground text-xs break-words"
                          >{{
                            'editor.modulePicker.asReferenceHint' | transloco
                          }}</span
                        >
                      </span>
                    </label>
                    <label class="flex cursor-pointer items-start gap-3">
                      <z-radio value="copy" zId="module-picker-copy" />
                      <span class="flex min-w-0 flex-col gap-0.5">
                        <span class="text-sm font-medium">{{
                          'editor.modulePicker.asCopy' | transloco
                        }}</span>
                        <span
                          class="text-muted-foreground text-xs break-words"
                          >{{
                            'editor.modulePicker.asCopyHint' | transloco
                          }}</span
                        >
                      </span>
                    </label>
                  } @else if (linkOnly()) {
                    <label
                      class="flex cursor-not-allowed items-start gap-3"
                      aria-disabled="true"
                    >
                      <z-radio
                        value="whole"
                        zDisabled
                        zId="module-picker-whole"
                      />
                      <span class="flex min-w-0 flex-col gap-0.5">
                        <span
                          class="text-muted-foreground text-sm font-medium"
                          >{{ 'editor.modulePicker.whole' | transloco }}</span
                        >
                        <span
                          class="text-muted-foreground text-xs break-words"
                          >{{
                            'editor.modulePicker.wholeUnavailable' | transloco
                          }}</span
                        >
                      </span>
                    </label>
                  } @else {
                    <label class="flex cursor-pointer items-start gap-3">
                      <z-radio value="whole" zId="module-picker-whole" />
                      <span class="flex min-w-0 flex-col gap-0.5">
                        <span class="text-sm font-medium">{{
                          'editor.modulePicker.whole' | transloco
                        }}</span>
                        <span
                          class="text-muted-foreground text-xs break-words"
                          >{{
                            'editor.modulePicker.wholeHint'
                              | transloco: { title: chosenTitle() }
                          }}</span
                        >
                      </span>
                    </label>
                  }
                  @if (linkOnly()) {
                    <label
                      class="flex cursor-not-allowed items-start gap-3"
                      aria-disabled="true"
                    >
                      <z-radio
                        value="block"
                        zDisabled
                        zId="module-picker-block"
                      />
                      <span class="flex min-w-0 flex-col gap-0.5">
                        <span
                          class="text-muted-foreground text-sm font-medium"
                          >{{ 'editor.modulePicker.block' | transloco }}</span
                        >
                        <span
                          class="text-muted-foreground text-xs break-words"
                          >{{
                            'editor.modulePicker.wholeUnavailable' | transloco
                          }}</span
                        >
                      </span>
                    </label>
                  } @else if (!snippetMode()) {
                    <label class="flex cursor-pointer items-start gap-3">
                      <z-radio value="block" zId="module-picker-block" />
                      <span class="flex min-w-0 flex-col gap-0.5">
                        <span class="text-sm font-medium">{{
                          'editor.modulePicker.block' | transloco
                        }}</span>
                        <span
                          class="text-muted-foreground text-xs break-words"
                          >{{
                            'editor.modulePicker.blockHint' | transloco
                          }}</span
                        >
                      </span>
                    </label>
                  }
                  @if (!snippetMode()) {
                    <label class="flex cursor-pointer items-start gap-3">
                      <z-radio value="link" zId="module-picker-link" />
                      <span class="flex min-w-0 flex-col gap-0.5">
                        <span class="text-sm font-medium">{{
                          'editor.modulePicker.link' | transloco
                        }}</span>
                        <span
                          class="text-muted-foreground text-xs break-words"
                          >{{
                            'editor.modulePicker.linkHint' | transloco
                          }}</span
                        >
                      </span>
                    </label>
                  }
                </z-radio-group>
              </fieldset>

              @if (cycleText(); as text) {
                <p
                  ofFadeIn
                  class="border-border bg-background m-0 flex items-start gap-2 rounded-md border p-3 text-sm break-words"
                  role="status"
                >
                  <ng-icon
                    name="lucideRepeat"
                    class="mt-0.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span>{{ text }}</span>
                </p>
              }
              @if (checkFailed() && mode() !== 'link') {
                <div class="flex flex-col items-start gap-2 text-sm">
                  <p class="m-0">
                    {{ 'editor.modulePicker.checkFailed' | transloco }}
                  </p>
                  <button
                    z-button
                    zType="outline"
                    zSize="sm"
                    type="button"
                    (click)="retryCheck()"
                  >
                    {{ 'editor.modulePicker.checkAgain' | transloco }}
                  </button>
                </div>
              }

              <div class="flex flex-col gap-1.5">
                <p class="text-muted-foreground m-0 text-xs">
                  {{ 'editor.modulePicker.usedIn' | transloco }}
                </p>
                @let used = usedIn();
                @if (used === null) {
                  <z-skeleton
                    ofFadeIn="delayed"
                    class="h-3 w-40"
                    aria-hidden="true"
                  />
                } @else if (used.length === 0) {
                  <p class="m-0 text-sm">
                    {{ 'editor.modulePicker.usedInNone' | transloco }}
                  </p>
                } @else {
                  <ul
                    ofFadeIn
                    class="m-0 flex list-none flex-col gap-1 p-0 text-sm"
                  >
                    @for (m of used.slice(0, usedInShown); track m.id) {
                      <li class="break-words">{{ m.title }}</li>
                    }
                    @if (used.length > usedInShown) {
                      <li class="text-muted-foreground">
                        {{
                          'editor.modulePicker.usedInMore'
                            | transloco: { count: used.length - usedInShown }
                        }}
                      </li>
                    }
                  </ul>
                }
              </div>
            }
          </section>
        </div>
      }
      <z-dialog-footer class="m-0 items-center px-6 py-4 sm:justify-between">
        <p
          id="module-picker-blocked"
          class="text-muted-foreground m-0 text-xs break-words sm:me-auto"
          aria-live="polite"
        >
          {{ blockedReason() }}
        </p>
        <div class="flex flex-col-reverse gap-2 sm:flex-row">
          <button z-button zType="ghost" type="button" (click)="cancel()">
            {{ 'editor.modulePicker.cancel' | transloco }}
          </button>
          <button
            z-button
            type="button"
            [zDisabled]="!!blockedReason()"
            [attr.aria-describedby]="
              blockedReason() ? 'module-picker-blocked' : null
            "
            (click)="insert()"
          >
            {{ 'editor.modulePicker.insert' | transloco }}
          </button>
        </div>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class ModulePickerDialogComponent {
  private readonly api = inject(ApiClient);
  private readonly readRef = inject(ReadRef);
  private readonly me = inject(MeService);
  private readonly language = inject(LanguageService);
  private readonly t = injectTranslate();

  /** What the picker is open for; null: closed. A new object each time it opens. */
  readonly request = input<ModulePickRequest | null>(null);
  /**
   * The request the dialog shows: the one open, else the last one while the dialog plays its
   * leave transition, so it closes as it was (its title, its list, its size) and never as an
   * empty module picker for a frame or two (#796). A new request replaces it at once.
   */
  protected readonly shown = linkedSignal<
    ModulePickRequest | null,
    ModulePickRequest | null
  >({
    source: this.request,
    computation: (next, previous) => next ?? previous?.value ?? null,
  });
  /** The choice, or null when the person cancelled. Emitted once per request. */
  readonly done = output<ModulePick | null>();

  protected readonly queryMax = QUERY_MAX;
  protected readonly usedInShown = USED_IN_SHOWN;

  protected readonly open = computed(() => this.request() !== null);
  protected readonly typed = signal('');
  protected readonly typeFilter = signal('');
  protected readonly sameFacets = signal(false);
  protected readonly page = signal(1);
  protected readonly attempt = signal(0);
  protected readonly selected = signal<string | null>(null);
  protected readonly mode = signal<'whole' | 'block' | 'link' | 'copy'>(
    'whole',
  );
  /** The block chosen for "One block from it" (#223); null: none yet. */
  protected readonly chosenBlock = signal<string | null>(null);
  private readonly graphState = signal<GraphState>({ status: 'loading' });
  private readonly searchInput =
    viewChild<ElementRef<HTMLInputElement>>('search');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** The request a choice was already handed on for. */
  private answered: ModulePickRequest | null = null;
  private readonly graphReads = new Generation();
  /** Who reads, and at which ref: what the graph was read for (`graphFor`). */
  private readonly graphScope = computed(
    () => `${this.me.me().id}\n${this.readRef.ref() ?? ''}`,
  );
  private graphFor = '';
  /** The key of the list last asked for: rows read for another person are not kept. */
  private listFor: ListKey | null = null;

  /** What is searched for: trimmed, capped, once typing pauses. */
  private readonly term = toSignal(
    toObservable(this.typed).pipe(
      debounceTime(SEARCH_DEBOUNCE),
      map((text) =>
        Array.from(text.trim()).slice(0, QUERY_MAX).join('').trim(),
      ),
      distinctUntilChanged(),
    ),
    { initialValue: '' },
  );

  /** The module's facet values as filters (`<facet>:<value>`), at most the API's maximum. */
  protected readonly facetFilter = computed(() => {
    const facets = this.shown()?.facets ?? {};
    return Object.entries(facets)
      .flatMap(([facet, values]) => values.map((v) => `${facet}:${v}`))
      .slice(0, MAX_FACETS);
  });

  /** The facets the module has values in, by their configured names. */
  protected readonly facetNames = computed(() => {
    const req = this.shown();
    if (!req) return '';
    return Object.entries(req.facets)
      .filter(([, values]) => values.length > 0)
      .map(
        ([facet]) =>
          req.config.facets.find((f) => f.id === facet)?.label ?? facet,
      )
      .join(', ');
  });

  /** Opened for a snippet: only snippets listed, as a reference or as a copy. */
  protected readonly snippetMode = computed(() => !!this.shown()?.snippet);

  protected readonly searchLabel = computed(() =>
    this.snippetMode()
      ? 'editor.modulePicker.searchSnippets'
      : 'editor.modulePicker.search',
  );

  /** The module types to filter by: for a snippet, only the snippet types. */
  protected readonly typeOptions = computed(() =>
    (this.shown()?.config.moduleTypes ?? [])
      .filter((t) => !this.snippetMode() || t.snippet)
      .map((t) => ({
        value: t.id,
        label: t.label,
      })),
  );

  private readonly listKey = computed<ListKey>(
    () => ({
      open: this.open(),
      snippet: this.snippetMode(),
      // Clearing the box shows the list at once; typing waits for a pause.
      // A term left from before the box was cleared is not searched for again.
      term:
        this.typed().trim() === '' ||
        !this.typed().trim().startsWith(this.term())
          ? ''
          : this.term(),
      type: this.typeFilter(),
      facets: this.sameFacets() ? this.facetFilter() : [],
      page: this.page(),
      lang: this.shown()?.lang ?? '',
      ref: this.readRef.ref(),
      user: this.me.me().id,
      attempt: this.attempt(),
    }),
    { equal: sameKey },
  );

  private readonly listState = toSignal(
    toObservable(this.listKey).pipe(
      switchMap((key): Observable<ListState> => {
        const before = this.listFor;
        this.listFor = key;
        const shown = untracked(this.listState);
        // Closing: the rows stay while the dialog leaves (#796); nothing is read.
        if (!key.open) return of(shown);
        // Only the same person's rows at the same ref stay (dimmed) while the new ones load:
        // another person's are never shown, even briefly (#716). Opened again: none of the
        // last time's.
        const sameScope =
          before !== null &&
          before.open &&
          before.user === key.user &&
          before.ref === key.ref;
        const previous = !sameScope
          ? null
          : shown?.status === 'ready'
            ? shown.page
            : shown?.status === 'loading'
              ? shown.previous
              : null;
        return concat(
          of<ListState>({ status: 'loading', previous }),
          this.fetchList(key),
        );
      }),
    ),
    { initialValue: { status: 'idle' } as ListState },
  );

  protected readonly listPage = computed((): ListPage | null => {
    const state = this.listState();
    if (state.status === 'ready') return state.page;
    if (state.status === 'loading') return state.previous;
    return null;
  });
  protected readonly rows = computed(() => this.listPage()?.rows ?? []);
  protected readonly listLoading = computed(
    () => this.listState().status === 'loading',
  );
  protected readonly listError = computed(() => {
    const state = this.listState();
    return state.status === 'error'
      ? (() => {
          const text = apiErrorText(state.error);
          return {
            kind: state.error.kind,
            message: this.t(text.key, text.params),
          };
        })()
      : null;
  });

  private readonly graph = computed(() => {
    const state = this.graphState();
    return state.status === 'ready' ? state.graph : null;
  });

  /** The modules that include the edited one, directly or through others (itself included). */
  private readonly reaching = computed((): ReadonlySet<string> => {
    const req = this.shown();
    const graph = this.graph();
    if (!req) return new Set();
    if (!graph || !graph.complete) return new Set([req.moduleId]);
    return reachingModules(graph, req.moduleId);
  });

  /** The chosen module as the preview shows it: from the graph, else read on its own. */
  protected readonly preview = resource({
    params: () => {
      const req = this.shown();
      const id = this.selected();
      const state = this.graphState();
      if (!req || !id || state.status === 'loading') return undefined;
      return { req, id, graph: state.status === 'ready' ? state.graph : null };
    },
    loader: async ({ params: { req, id, graph } }) =>
      graph?.modules.get(id) ?? (await this.readModule(req, id)),
  });

  /**
   * The way from the chosen module back to the edited one ([edited] for itself), or null: none.
   * Read from the graph; when the graph is incomplete, the modules it lacks are read on their own.
   */
  protected readonly cycle = resource({
    params: () => {
      const req = this.shown();
      const id = this.selected();
      const graph = this.graph();
      if (!req || !id) return undefined;
      if (id === req.moduleId) return { req, id, graph: null };
      return graph ? { req, id, graph } : undefined;
    },
    loader: ({ params: { req, id, graph }, abortSignal }) =>
      cyclePath(
        id,
        req.moduleId,
        (at) => {
          const known = graph?.modules.get(at);
          if (known) return known.refs;
          if (graph?.complete) return null;
          return readModuleRefs(this.api, at, req.lang, this.source(req));
        },
        undefined,
        abortSignal,
      ),
  });

  /** Modules that include the chosen one directly; null while not known. */
  protected readonly usedIn = computed(() => {
    const id = this.selected();
    const graph = this.graph();
    if (!id) return [];
    if (this.graphState().status === 'error') return [];
    return graph ? includedBy(graph, id) : null;
  });

  protected readonly chosenTitle = computed(() => {
    const id = this.selected();
    if (!id) return '';
    return (
      this.preview.value()?.title ??
      this.rows().find((r) => r.id === id)?.title ??
      id
    );
  });

  protected readonly previewLanguage = computed(() => {
    const lang = this.preview.value()?.lang ?? this.shown()?.lang ?? '';
    return languageName(this.language.locale(), lang);
  });

  /** Why the cycle check stops the chosen module from being included, as a sentence. */
  protected readonly cycleText = computed(() => {
    const req = this.shown();
    const id = this.selected();
    if (!req || !id || this.mode() === 'link') return '';
    if (id === req.moduleId) return this.t('editor.modulePicker.cycleSelf');
    if (this.cycle.status() !== 'resolved') return '';
    const path = this.cycle.value();
    if (!path) return '';
    const graph = this.graph();
    const title = (m: string) => graph?.modules.get(m)?.title ?? m;
    return this.t('editor.modulePicker.cycle', {
      title: title(id),
      path: path.map(title).join(' → '),
    });
  });

  /** Why Insert can't be used now; empty when it can. */
  protected readonly blockedReason = computed(() => {
    const req = this.shown();
    const id = this.selected();
    if (!req) return '';
    if (!id) return this.t('editor.modulePicker.chooseFirst');
    if (this.mode() === 'link')
      return id === req.moduleId ? this.t('editor.modulePicker.selfLink') : '';
    if (id === req.moduleId) return this.t('editor.modulePicker.cycleBlocked');
    if (this.mode() === 'block' && !this.blockChosen())
      return this.t('editor.modulePicker.chooseBlockFirst');
    if (this.checkFailed()) return this.t('editor.modulePicker.checkFailed');
    switch (this.cycle.status()) {
      case 'resolved':
      case 'local':
        return this.cycle.value()
          ? this.t('editor.modulePicker.cycleBlocked')
          : '';
      default:
        return this.t('editor.modulePicker.checking');
    }
  });

  /** Whether the block chosen is one of the chosen module's, as the preview shows it. */
  private readonly blockChosen = computed(() => {
    const block = this.chosenBlock();
    const module = this.preview.value();
    if (!block || !module || this.selected() !== module.id) return false;
    return this.blockChoicesOf(module).some((c) => c.id === block);
  });

  /** Whether the chosen module could not be checked for a way back here (the graph or a read failed). */
  protected readonly checkFailed = computed(() => {
    const req = this.shown();
    const id = this.selected();
    if (!req || !id || id === req.moduleId) return false;
    return (
      this.graphState().status === 'error' || this.cycle.status() === 'error'
    );
  });

  constructor() {
    // A new request starts afresh: nothing typed, no filters, nothing chosen, the graph read.
    effect(() => {
      const req = this.shown();
      untracked(() => {
        if (!req) return;
        this.typed.set('');
        this.typeFilter.set('');
        this.sameFacets.set(false);
        this.page.set(1);
        this.selected.set(null);
        this.mode.set(req.linkOnly ? 'link' : 'whole');
        this.loadGraph(req);
      });
    });
    // Another person, or another ref, while it is open: the modules (their references, the
    // preview) are read again for them; nothing read for the one before is used (#716).
    effect(() => {
      const scope = this.graphScope();
      untracked(() => {
        const req = this.request();
        if (!req || this.graphFor === scope) return;
        this.selected.set(null);
        this.loadGraph(req);
      });
    });
    // Another module chosen: its block is still to be chosen.
    effect(() => {
      this.selected();
      untracked(() => this.chosenBlock.set(null));
    });
    // Nothing chosen yet: the first module of the list.
    effect(() => {
      const first = this.rows()[0];
      if (first && untracked(this.selected) === null)
        this.selected.set(first.id);
    });
  }

  protected type(text: string): void {
    this.typed.set(text);
    this.page.set(1);
  }

  protected setType(type: string): void {
    this.typeFilter.set(type);
    this.page.set(1);
  }

  protected toggleSameFacets(): void {
    this.sameFacets.update((on) => !on);
    this.page.set(1);
  }

  /** Opened for a cross-reference: only a link can be chosen. */
  protected readonly linkOnly = computed(() => !!this.shown()?.linkOnly);

  protected setMode(value: unknown): void {
    if ((value === 'whole' || value === 'block') && this.linkOnly()) return;
    if (this.snippetMode()) {
      if (value === 'whole' || value === 'copy') this.mode.set(value);
      return;
    }
    if (value === 'whole' || value === 'block' || value === 'link')
      this.mode.set(value);
  }

  protected chooseBlock(value: unknown): void {
    if (typeof value === 'string') this.chosenBlock.set(value);
  }

  protected choose(id: string): void {
    this.selected.set(id);
  }

  protected retryCheck(): void {
    const req = this.shown();
    if (this.graphState().status === 'error' && req) this.loadGraph(req);
    else this.cycle.reload();
  }

  protected insert(): void {
    const req = this.shown();
    const id = this.selected();
    if (!req || !id || this.blockedReason()) return;
    const mode = this.mode();
    const block = this.chosenBlock();
    if (mode === 'block') {
      if (block) this.answer(req, { module: id, mode, block });
      return;
    }
    this.answer(req, { module: id, mode });
  }

  protected cancel(): void {
    const req = this.shown();
    if (req) this.answer(req, null);
  }

  /** Escape, the close button or a click outside closes the dialog: a cancel. */
  protected visibleChange(visible: boolean): void {
    if (!visible) this.cancel();
  }

  /** From the search box: the first row. */
  protected focusRow(index: number, event: Event): void {
    const rows = this.rowButtons();
    if (rows.length === 0) return;
    event.preventDefault();
    rows[Math.min(index, rows.length - 1)]?.focus();
  }

  /** Arrow keys move between the rows; up from the first goes back to the search box. */
  protected moveRow(event: Event, step: number): void {
    const rows = this.rowButtons();
    const at = rows.indexOf(event.target as HTMLButtonElement);
    if (at === -1) return;
    event.preventDefault();
    const next = at + step;
    if (next < 0) this.searchInput()?.nativeElement.focus();
    else rows[Math.min(next, rows.length - 1)]?.focus();
  }

  protected asRow(item: unknown): Row {
    return item as Row;
  }

  protected moduleOf(id: string): GraphModule | undefined {
    return this.graph()?.modules.get(id);
  }

  protected includesThis(id: string): boolean {
    return this.reaching().has(id);
  }

  protected statusOf(module: GraphModule): ContentStatus {
    return pickerStatus(module);
  }

  /** The row's second line: its type and facet values, by their configured names. */
  protected pathOf(module: GraphModule): string {
    const config = this.shown()?.config;
    const type =
      config?.moduleTypes.find((t) => t.id === module.type)?.label ??
      module.type;
    const values = Object.entries(module.facets).flatMap(([facet, ids]) => {
      const known = config?.facets.find((f) => f.id === facet);
      return ids.map((v) => known?.values.find((o) => o.id === v)?.label ?? v);
    });
    return [type, ...values].join(' / ');
  }

  protected previewUnits(module: GraphModule): Unit[] {
    return unitsOf(module.blocks)
      .filter((u) => u.text.trim() !== '' && u.kind !== 'moduleRef')
      .slice(0, PREVIEW_UNITS);
  }

  /** The chosen module's blocks one can refer to alone (#223), worked out once per module read. */
  protected blockChoicesOf(module: GraphModule): readonly BlockChoice[] {
    let found = this.choices.get(module);
    if (!found) {
      found = blockChoices(module.blocks as readonly ModelBlock[]);
      this.choices.set(module, found);
    }
    return found;
  }

  private readonly choices = new WeakMap<GraphModule, readonly BlockChoice[]>();

  protected typeName(choice: BlockChoice): string {
    return (
      BLOCK_TYPE_NAMES[choice.type] ?? 'editor.moduleEditor.outline.types.other'
    );
  }

  private rowButtons(): HTMLButtonElement[] {
    return Array.from(
      this.host.nativeElement.ownerDocument.querySelectorAll<HTMLButtonElement>(
        'button[data-picker-row]',
      ),
    );
  }

  private answer(req: ModulePickRequest, pick: ModulePick | null): void {
    if (this.answered === req) return;
    this.answered = req;
    this.done.emit(pick);
  }

  private source(req: ModulePickRequest): string {
    return req.config.languages.source;
  }

  private loadGraph(req: ModulePickRequest): void {
    const live = this.graphReads.start();
    this.graphFor = untracked(this.graphScope);
    this.graphState.set({ status: 'loading' });
    loadModuleGraph(this.api, req.lang, this.source(req)).then(
      (graph) => {
        if (live()) this.graphState.set({ status: 'ready', graph });
      },
      (error: unknown) => {
        if (live())
          this.graphState.set({ status: 'error', error: toApiError(error) });
      },
    );
  }

  /** A module the graph does not hold, read on its own; null when there is none to see. */
  private async readModule(
    req: ModulePickRequest,
    id: string,
  ): Promise<GraphModule | null> {
    for (const lang of new Set([req.lang, this.source(req)])) {
      try {
        const found = await firstValueFrom(
          this.api.get('/modules/{lang}/{id}', { path: { lang, id } }),
        );
        return toGraphModule(found.data);
      } catch (error) {
        if (![403, 404].includes(toApiError(error).status)) throw error;
      }
    }
    return null;
  }

  private fetchList(key: ListKey): Observable<ListState> {
    const filters = {
      'filter[lang]': key.lang,
      ...(key.type ? { 'filter[type]': key.type } : {}),
      ...(key.facets.length > 0 ? { 'filter[facet]': [...key.facets] } : {}),
      ...pageQuery({ number: key.page, size: PAGE_SIZE }),
    };
    // Snippets: the summaries filtered on the server (by title or ID when something is typed),
    // so only snippets the person may read are ever listed.
    const page: Observable<ListPage> = key.snippet
      ? this.api
          .get('/module-summaries', {
            query: {
              ...filters,
              'filter[snippet]': 'true',
              ...(key.term ? { 'filter[q]': key.term } : {}),
            },
          })
          .pipe(
            map((doc) => ({
              rows: doc.data.map((s) => ({
                id: s.attributes.moduleId,
                title: s.attributes.title,
              })),
              meta: doc.meta.page,
            })),
          )
      : key.term
        ? this.api
            .get('/search', {
              query: {
                ...filters,
                'filter[q]': key.term,
                'filter[resourceType]': 'module',
              },
            })
            .pipe(
              map((doc) => ({
                rows: doc.data.flatMap((r): Row[] => {
                  const slash = r.attributes.resourceId.indexOf('/');
                  return r.attributes.resourceType === 'Module' && slash > 0
                    ? [
                        {
                          id: r.attributes.resourceId.slice(slash + 1),
                          title: r.attributes.title,
                        },
                      ]
                    : [];
                }),
                meta: doc.meta.page,
              })),
            )
        : this.api.get('/module-summaries', { query: filters }).pipe(
            map((doc) => ({
              rows: doc.data.map((s) => ({
                id: s.attributes.moduleId,
                title: s.attributes.title,
              })),
              meta: doc.meta.page,
            })),
          );
    return page.pipe(
      map((p): ListState => ({ status: 'ready', page: p })),
      catchError((error: unknown) =>
        of<ListState>({ status: 'error', error: toApiError(error) }),
      ),
    );
  }
}
