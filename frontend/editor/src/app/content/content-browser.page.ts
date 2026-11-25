import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideEllipsis,
  lucideFolder,
  lucidePlus,
  lucideSearch,
  lucideTrash2,
  lucideX,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import {
  LanguageBadgeComponent,
  StatusBadgeComponent,
  type TranslationState,
} from '@openfolia/ui/badges';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import { ZardDropdownImports } from '@openfolia/ui/dropdown-menu';
import {
  DatePipe,
  injectTranslate,
  LanguageService,
  translated,
} from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardInputGroupImports } from '@openfolia/ui/input-group';
import { KbdComponent } from '@openfolia/ui/kbd';
import {
  ListFrameComponent,
  ListItemDirective,
  ListTableDirective,
} from '@openfolia/ui/list-frame';
import { SearchShortcutDirective } from '@openfolia/ui/search-shortcut';
import { PageHeaderComponent } from '@openfolia/ui/shell';
import { ReservedSlotDirective } from '@openfolia/ui/smooth';
import { ZardSwitchComponent } from '@openfolia/ui/switch';
import { ZardTableImports } from '@openfolia/ui/table';
import { ToastService } from '@openfolia/ui/toast';

import {
  ApiClient,
  pageQuery,
  ReadRef,
  toApiError,
  type ApiError,
  type Response,
} from '../api';
import { apiErrorText, labelsInUi } from '../i18n';
import { GuardDirective } from '../permissions/guard.directive';
import { MeService } from '../permissions/me';
import { PermissionService } from '../permissions/permission.service';
import { LineBadgeComponent } from '../session/line-badge.component';
import { ChangeSetSession } from '../session/change-set-session';
import { ChangeSetUrl } from '../session/change-set-url';
import { Generation } from '../shared/generation';
import { injectQueryState } from '../view-state';
import { NewModuleRequest } from './new-module-request';
import {
  BROWSER_PARAMS,
  filtersOf,
  groupTree,
  labelOf,
  languageName,
  languagesOf,
  PAGE_SIZES,
  statesOf,
  statusOf,
  summaryQuery,
  translationsOf,
  unknownFilters,
  valuesOf,
  variantLabels,
  type BrowserFilters,
  type GroupNode,
  type ModuleSummary,
  type StoredConfig,
  type Shown,
  type TranslationStates,
  unsetAudienceLevel,
} from './browser-model';
import {
  FilterChipComponent,
  type FilterOption,
} from './filter-chip.component';
import {
  ModuleCreation,
  type NewModule,
  type PendingModule,
} from './module-creation';
import { KeywordFilterChipComponent } from './keyword-filter-chip.component';
import {
  DeleteModuleDialogComponent,
  type DeleteTarget,
} from './delete-module-dialog.component';
import { loadDeletedModules, type DeletedRow } from './deleted-modules';
import { injectDraftBlocked } from './module-actions';
import { ModuleDeletion, type DeleteRequest } from './module-deletion';
import { NewModuleDialogComponent } from './new-module-dialog.component';

type Row =
  | { readonly kind: 'pending'; readonly pending: PendingModule }
  | { readonly kind: 'deleted'; readonly deleted: DeletedRow }
  /** A module deleted on the branch shown (#320, "Show deleted"): it opens its history. */
  | { readonly kind: 'removed'; readonly summary: ModuleSummary }
  | { readonly kind: 'module'; readonly summary: ModuleSummary };

/** Space kept below the frame: the legend and the page's bottom padding. */
const BELOW_FRAME_PX = 64;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Screen 1, the content browser: modules grouped by type (and the first facet's values) on the
 * left, filters for the facets, language, status, audience, type and keywords, a search over titles and
 * IDs, and the module table: paged on the server, scrolling inside its frame with the
 * pagination outside, each row opening the module. "New module" (screen 7) creates one in the
 * current change set; it is hidden without `content.edit` and blocked, with the reason, while no
 * draft change set is chosen.
 */
@Component({
  selector: 'of-content-browser',
  imports: [
    RouterLink,
    CollapseComponent,
    DatePipe,
    TranslocoPipe,
    NgIcon,
    PageHeaderComponent,
    ListFrameComponent,
    ListItemDirective,
    ListTableDirective,
    ReservedSlotDirective,
    StatusBadgeComponent,
    LanguageBadgeComponent,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardInputComponent,
    ZardInputGroupImports,
    ZardTableImports,
    ZardSwitchComponent,
    KbdComponent,
    SearchShortcutDirective,
    GuardDirective,
    FilterChipComponent,
    KeywordFilterChipComponent,
    NewModuleDialogComponent,
    LineBadgeComponent,
    DeleteModuleDialogComponent,
    ZardDropdownImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideEllipsis,
      lucideFolder,
      lucidePlus,
      lucideSearch,
      lucideTrash2,
      lucideX,
    }),
  ],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <of-page-header [title]="'editor.content.title' | transloco">
      <!-- The product version the chosen revision fixes, when on a maintenance line. -->
      <span ofTitleAside class="flex min-w-0">
        <of-line-badge
          [baseRef]="changeSets.selectedOption()?.baseRef ?? null"
        />
      </span>
      <button
        z-button
        type="button"
        data-tip="content.new-module"
        [ofGuard]="{
          permission: 'content.edit',
          blockedReason: newBlocked(),
        }"
        (click)="dialogOpen.set(true)"
      >
        <ng-icon
          name="lucidePlus"
          data-icon="inline-start"
          strokeWidth="1.5"
          aria-hidden="true"
        />
        {{
          (suggestsOnly()
            ? 'editor.content.new.suggest'
            : 'editor.content.new.open'
          ) | transloco
        }}
      </button>
    </of-page-header>

    <!-- The search has a column of its own and Reset filters a place kept for it, so turning a
         filter on or off never wraps the bar or moves the list -->
    <div
      class="flex flex-col gap-2 sm:flex-row sm:items-start"
      role="group"
      [attr.aria-label]="'editor.content.filters.label' | transloco"
    >
      <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        @if (config(); as c) {
          @for (facet of c.facets; track facet.id) {
            <of-filter-chip
              [label]="facet.label"
              [allLabel]="'editor.content.filters.all' | transloco"
              [options]="facetOptions(facet.values)"
              [value]="
                filters().facet?.id === facet.id
                  ? (filters().facet?.value ?? '')
                  : ''
              "
              (changed)="setFacet(facet.id, $event)"
            />
          }
          <of-filter-chip
            [label]="'editor.content.filters.language' | transloco"
            [allLabel]="'editor.content.filters.all' | transloco"
            [options]="languageOptions()"
            [value]="filters().lang ?? ''"
            (changed)="patch({ lang: $event || undefined })"
          />
          <of-filter-chip
            [label]="'editor.content.filters.status' | transloco"
            [allLabel]="'editor.content.filters.all' | transloco"
            [options]="statusOptions()"
            [value]="filters().status ?? ''"
            (changed)="setStatus($event)"
          />
          <of-filter-chip
            [label]="'editor.content.filters.audience' | transloco"
            [allLabel]="'editor.content.filters.all' | transloco"
            [options]="audienceOptions(c.audiences)"
            [value]="filters().audience ?? ''"
            (changed)="patch({ audience: $event || undefined })"
          />
          <of-filter-chip
            [label]="'editor.content.filters.type' | transloco"
            [allLabel]="'editor.content.filters.all' | transloco"
            [options]="facetOptions(c.moduleTypes)"
            [value]="filters().type ?? ''"
            (changed)="patch({ type: $event || undefined })"
          />
          <of-keyword-filter-chip
            [label]="'editor.content.filters.keyword' | transloco"
            [allLabel]="'editor.content.filters.all' | transloco"
            [value]="filters().keywords ?? []"
            (changed)="setKeywords($event)"
          />
          <z-switch
            class="shrink-0 text-sm"
            data-slot="show-deprecated"
            [zChecked]="shows('deprecated')"
            (zCheckedChange)="setShown('deprecated', $event)"
            >{{ 'editor.deprecation.filter' | transloco }}</z-switch
          >
          <!-- A deleted module's last versions are mostly drafts, so only drafts readers list
               them (issue 418, as the manual builder's switch after issue 410). -->
          <span class="flex shrink-0 flex-col">
            <z-switch
              class="text-sm"
              data-slot="show-deleted"
              [zChecked]="shows('deleted')"
              [zDisabled]="!readsDrafts()"
              [attr.aria-describedby]="
                readsDrafts() ? null : 'content-show-deleted-reason'
              "
              (zCheckedChange)="setShown('deleted', $event)"
              >{{ 'editor.content.filters.showDeleted' | transloco }}</z-switch
            >
            @if (!readsDrafts()) {
              <span
                id="content-show-deleted-reason"
                class="text-muted-foreground mt-1 text-xs"
                data-slot="show-deleted-reason"
              >
                {{ 'editor.content.filters.deletedNeedsDrafts' | transloco }}
              </span>
            }
          </span>
        }
        <button
          z-button
          zType="ghost"
          zSize="sm"
          type="button"
          class="text-muted-foreground"
          data-slot="filters-reset"
          [ofReservedSlot]="hasFilters()"
          (click)="resetFilters()"
        >
          <ng-icon name="lucideX" aria-hidden="true" />
          {{ 'editor.content.filters.reset' | transloco }}
        </button>
      </div>
      <z-input-group class="w-full shrink-0 sm:w-72">
        <z-input-group-addon>
          <ng-icon name="lucideSearch" aria-hidden="true" />
        </z-input-group-addon>
        <input
          z-input
          ofSearchShortcut
          #searchInput
          type="search"
          autocomplete="off"
          maxlength="200"
          [attr.aria-label]="'editor.content.filters.search' | transloco"
          [placeholder]="'editor.content.filters.search' | transloco"
          [value]="search()"
          (input)="typed($any($event.target).value)"
        />
        <!-- The "/" shortcut, for the mouse user; gone while the box is in use. -->
        <z-input-group-addon zAlign="inline-end">
          <kbd
            of-kbd
            aria-hidden="true"
            class="transition-opacity duration-150 group-focus-within/input-group:opacity-0 motion-reduce:transition-none"
            [class.opacity-0]="search() !== ''"
            >/</kbd
          >
        </z-input-group-addon>
      </z-input-group>
    </div>

    <div class="flex min-h-0 min-w-0 items-start gap-4">
      @if (config(); as c) {
        <nav
          class="bg-muted/60 hidden w-56 shrink-0 rounded-xl p-2 lg:block"
          [attr.aria-label]="'editor.content.groups.label' | transloco"
        >
          <p
            class="text-muted-foreground m-0 px-2 pt-1 pb-2 text-xs font-medium"
            aria-hidden="true"
          >
            {{ 'editor.content.groups.label' | transloco }}
          </p>
          <ul class="m-0 flex list-none flex-col gap-0.5 p-0">
            <li>
              <button
                type="button"
                [class]="groupClass(!filters().type)"
                [attr.aria-current]="!filters().type ? 'true' : null"
                (click)="chooseGroup(null)"
              >
                <ng-icon name="lucideFolder" aria-hidden="true" />
                <span class="min-w-0 break-words">{{
                  'editor.content.groups.all' | transloco
                }}</span>
              </button>
            </li>
            @for (node of groups(); track node.key) {
              <li>
                <button
                  type="button"
                  [class]="groupClass(isGroup(node))"
                  [attr.aria-current]="isGroup(node) ? 'true' : null"
                  [attr.aria-expanded]="
                    node.children.length > 0
                      ? filters().type === node.type
                      : null
                  "
                  (click)="chooseGroup(node)"
                >
                  <ng-icon name="lucideFolder" aria-hidden="true" />
                  <span class="min-w-0 break-words">{{ node.label }}</span>
                </button>
                @if (node.children.length > 0) {
                  <of-collapse [open]="filters().type === node.type">
                    <ul
                      class="m-0 flex list-none flex-col gap-0.5 p-0 pt-0.5 ps-5"
                    >
                      @for (child of node.children; track child.key) {
                        <li>
                          <button
                            type="button"
                            [class]="groupClass(isGroup(child))"
                            [attr.aria-current]="isGroup(child) ? 'true' : null"
                            (click)="chooseGroup(child)"
                          >
                            <ng-icon name="lucideFolder" aria-hidden="true" />
                            <span class="min-w-0 break-words">{{
                              child.label
                            }}</span>
                          </button>
                        </li>
                      }
                    </ul>
                  </of-collapse>
                }
              </li>
            }
          </ul>
        </nav>
      }

      <div class="flex min-w-0 flex-1 flex-col gap-3">
        <of-list-frame
          #frame
          class="min-w-0"
          [label]="'editor.content.table.label' | transloco"
          [items]="rows()"
          [trackBy]="rowKey"
          [page]="doc()?.meta?.page ?? null"
          [loading]="loading()"
          [error]="frameError()"
          [offset]="offset()"
          [pageSizes]="pageSizes"
          [emptyTitle]="'editor.content.table.emptyTitle' | transloco"
          [emptyDescription]="emptyDescription()"
          (pageChange)="setPage($event)"
          (pageSizeChange)="setPageSize($event)"
          (retry)="reload()"
        >
          @if (hasFilters()) {
            <button
              ofListEmpty
              z-button
              zType="outline"
              zSize="sm"
              type="button"
              (click)="resetFilters()"
            >
              <ng-icon name="lucideX" aria-hidden="true" />
              {{ 'editor.content.filters.reset' | transloco }}
            </button>
          }
          <ng-template ofListTable let-items>
            <table z-table class="min-w-[56rem] table-fixed">
              <thead z-table-header class="bg-background sticky top-0 z-10">
                <tr z-table-row>
                  <th z-table-head class="w-[28%]">
                    {{ 'editor.content.table.module' | transloco }}
                  </th>
                  <th z-table-head class="w-[12%]">
                    {{ 'editor.content.table.type' | transloco }}
                  </th>
                  <th z-table-head class="w-[12%]">
                    {{ 'editor.content.table.status' | transloco }}
                  </th>
                  <th z-table-head class="w-[17%]">
                    {{ 'editor.content.table.languages' | transloco }}
                  </th>
                  <th z-table-head class="w-[14%]">
                    {{ 'editor.content.table.variants' | transloco }}
                  </th>
                  <th z-table-head class="w-[13%]">
                    {{ 'editor.content.table.audience' | transloco }}
                  </th>
                  @if (canEdit()) {
                    <th z-table-head class="w-14">
                      <span class="sr-only">{{
                        'editor.content.table.actions' | transloco
                      }}</span>
                    </th>
                  }
                </tr>
              </thead>
              <tbody z-table-body>
                @for (row of asRows(items); track rowKey(row)) {
                  @if (row.kind === 'pending') {
                    <tr
                      z-table-row
                      [ofListItem]="row"
                      class="text-muted-foreground"
                      aria-busy="true"
                    >
                      <td
                        z-table-cell
                        class="align-top break-words whitespace-normal"
                      >
                        <span class="text-foreground font-medium">{{
                          row.pending.module.title
                        }}</span>
                        <span class="block text-xs">{{
                          'editor.content.table.creating' | transloco
                        }}</span>
                      </td>
                      <td z-table-cell class="align-top whitespace-normal">
                        {{ typeLabel(row.pending.module.type) }}
                      </td>
                      <td z-table-cell class="align-top">
                        <of-status-badge status="draft" />
                      </td>
                      <td z-table-cell class="align-top">
                        <span class="flex flex-wrap gap-1">
                          <of-language-badge
                            display="chip"
                            state="up-to-date"
                            [language]="row.pending.module.lang"
                          />
                        </span>
                      </td>
                      <td z-table-cell class="align-top">
                        {{ 'editor.content.table.allVariants' | transloco }}
                      </td>
                      <td z-table-cell class="align-top whitespace-normal">
                        {{ audienceLabel(row.pending.module.audience) }}
                      </td>
                      @if (canEdit()) {
                        <td z-table-cell></td>
                      }
                    </tr>
                  } @else if (row.kind === 'deleted') {
                    @let d = row.deleted;
                    <tr
                      z-table-row
                      [ofListItem]="row"
                      class="text-muted-foreground"
                      data-slot="deleted-row"
                    >
                      <td
                        z-table-cell
                        class="align-top break-words whitespace-normal"
                      >
                        <span class="font-medium">{{ d.title }}</span>
                        <span class="block text-xs [overflow-wrap:anywhere]">{{
                          d.moduleId
                        }}</span>
                      </td>
                      <td z-table-cell class="align-top whitespace-normal">
                        {{ d.type ? typeLabel(d.type) : '' }}
                      </td>
                      <td z-table-cell class="align-top">
                        <z-badge
                          zType="outline"
                          class="border-dashed font-normal"
                          >{{
                            'editor.content.table.deleted' | transloco
                          }}</z-badge
                        >
                      </td>
                      <td z-table-cell class="align-top whitespace-normal">
                        <span class="sr-only">{{
                          'editor.content.table.deletedIn' | transloco
                        }}</span>
                        <span class="text-xs uppercase line-through">{{
                          d.langs.join(' ')
                        }}</span>
                      </td>
                      <td z-table-cell class="align-top"></td>
                      <td z-table-cell class="align-top whitespace-normal">
                        {{ d.type ? audienceLabel(d.audience) : '' }}
                      </td>
                      @if (canEdit()) {
                        <td z-table-cell></td>
                      }
                    </tr>
                  } @else if (row.kind === 'removed') {
                    @let r = row.summary;
                    <tr
                      z-table-row
                      [ofListItem]="row"
                      class="text-muted-foreground hover:bg-muted/50 cursor-pointer"
                      data-slot="removed-row"
                      (click)="openHistory(r)"
                    >
                      <td
                        z-table-cell
                        class="align-top break-words whitespace-normal"
                      >
                        <a
                          class="focus-visible:ring-ring rounded-sm font-medium outline-none hover:underline focus-visible:ring-2"
                          data-slot="removed-history"
                          [routerLink]="[
                            '/content',
                            r.attributes.titleLang,
                            r.id,
                            'history',
                          ]"
                          [queryParams]="csLink.params()"
                          [attr.aria-label]="
                            'editor.content.table.openHistory'
                              | transloco: { title: r.attributes.title }
                          "
                          (click)="$event.stopPropagation()"
                          >{{ r.attributes.title }}</a
                        >
                        <span class="block text-xs [overflow-wrap:anywhere]">{{
                          r.id
                        }}</span>
                      </td>
                      <td z-table-cell class="align-top whitespace-normal">
                        {{ typeLabel(r.attributes.moduleType) }}
                      </td>
                      <td z-table-cell class="align-top">
                        <span class="flex flex-col items-start gap-1">
                          <z-badge
                            zType="outline"
                            class="border-dashed font-normal"
                            >{{
                              'editor.content.table.deleted' | transloco
                            }}</z-badge
                          >
                          @if (r.meta.deleted; as d) {
                            <span class="text-xs">{{
                              'editor.content.table.deletedOn'
                                | transloco: { date: (d.committedAt | ofDate) }
                            }}</span>
                          }
                        </span>
                      </td>
                      <td z-table-cell class="align-top whitespace-normal">
                        <span class="sr-only">{{
                          'editor.content.table.deletedIn' | transloco
                        }}</span>
                        <span class="text-xs uppercase line-through">{{
                          r.attributes.languages.join(' ')
                        }}</span>
                      </td>
                      <td
                        z-table-cell
                        class="align-top break-words whitespace-normal"
                      >
                        {{ variants(r) }}
                      </td>
                      <td z-table-cell class="align-top whitespace-normal">
                        {{ audienceLabel(r.attributes.audience) }}
                      </td>
                      @if (canEdit()) {
                        <td z-table-cell></td>
                      }
                    </tr>
                  } @else {
                    @let s = row.summary;
                    <!-- The tour's "Open a module" step lights up the first row (issue 869). -->
                    <tr
                      z-table-row
                      [ofListItem]="row"
                      class="hover:bg-muted/50 cursor-pointer"
                      data-tip="content.module"
                      (click)="open(s)"
                    >
                      <td
                        z-table-cell
                        class="align-top break-words whitespace-normal"
                      >
                        <a
                          class="text-foreground focus-visible:ring-ring rounded-sm font-medium outline-none hover:underline focus-visible:ring-2"
                          [routerLink]="[
                            '/content',
                            s.attributes.titleLang,
                            s.id,
                          ]"
                          [queryParams]="csLink.params()"
                          (click)="$event.stopPropagation()"
                          >{{ s.attributes.title }}</a
                        >
                        @if (fallback(s)) {
                          <span
                            class="text-muted-foreground ms-1 text-xs uppercase"
                            [attr.title]="
                              'editor.content.table.titleIn'
                                | transloco
                                  : {
                                      language: languageLabel(
                                        s.attributes.titleLang
                                      ),
                                    }
                            "
                            >({{ s.attributes.titleLang }})</span
                          >
                        }
                        <span
                          class="text-muted-foreground block text-xs [overflow-wrap:anywhere]"
                          >{{ s.id }}</span
                        >
                        @if (s.attributes.keywords.length > 0) {
                          <span
                            class="mt-1 flex flex-wrap gap-1"
                            [attr.aria-label]="
                              'editor.keywords.label' | transloco
                            "
                          >
                            @for (k of s.attributes.keywords; track k) {
                              <z-badge
                                zType="outline"
                                class="h-auto max-w-full font-normal whitespace-normal [overflow-wrap:anywhere]"
                                >{{ k }}</z-badge
                              >
                            }
                          </span>
                        }
                      </td>
                      <td z-table-cell class="align-top whitespace-normal">
                        {{ typeLabel(s.attributes.moduleType) }}
                      </td>
                      <td z-table-cell class="align-top">
                        <span class="flex flex-wrap gap-1">
                          <of-status-badge [status]="status(s)" />
                          @if (s.attributes.deprecated) {
                            <of-status-badge
                              status="deprecated"
                              data-slot="row-deprecated"
                              [attr.title]="s.attributes.deprecated.reason"
                            />
                          }
                        </span>
                      </td>
                      <td z-table-cell class="align-top">
                        <span class="flex flex-wrap gap-1">
                          @for (tr of translations(s); track tr.lang) {
                            <of-language-badge
                              display="chip"
                              [state]="tr.state"
                              [language]="tr.lang"
                            />
                          }
                        </span>
                      </td>
                      <td
                        z-table-cell
                        class="align-top break-words whitespace-normal"
                      >
                        {{ variants(s) }}
                      </td>
                      <td z-table-cell class="align-top whitespace-normal">
                        {{ audienceLabel(s.attributes.audience) }}
                      </td>
                      @if (canEdit()) {
                        <td
                          z-table-cell
                          class="align-top"
                          (click)="$event.stopPropagation()"
                        >
                          <button
                            z-button
                            zType="ghost"
                            zSize="icon-xs"
                            type="button"
                            data-slot="row-actions"
                            class="text-muted-foreground"
                            z-dropdown
                            [zDropdownMenu]="rowMenu"
                            [attr.aria-label]="
                              'editor.content.table.rowActions'
                                | transloco: { title: s.attributes.title }
                            "
                            (click)="menuRow.set(s)"
                            (focus)="menuRow.set(s)"
                            (keydown)="menuRow.set(s)"
                          >
                            <ng-icon name="lucideEllipsis" aria-hidden="true" />
                          </button>
                        </td>
                      }
                    </tr>
                  }
                }
              </tbody>
            </table>
          </ng-template>
        </of-list-frame>
        <p
          class="text-muted-foreground m-0 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs"
        >
          <span class="sr-only">{{
            'editor.content.table.legend' | transloco
          }}</span>
          @for (state of legendStates(); track state) {
            <of-language-badge [state]="state" display="legend" />
          }
        </p>
      </div>
    </div>

    <z-dropdown-menu-content #rowMenu class="w-56">
      <z-dropdown-menu-item
        zType="destructive"
        data-slot="row-delete"
        [ofGuard]="{
          permission: 'content.edit',
          blockedReason: deleteBlocked(),
        }"
        (click)="askDelete()"
      >
        <ng-icon name="lucideTrash2" aria-hidden="true" />
        {{ 'editor.content.table.delete' | transloco }}
      </z-dropdown-menu-item>
    </z-dropdown-menu-content>
    <of-delete-module-dialog
      [target]="deleteTarget()"
      (confirm)="deleteModule($event)"
      (closed)="deleteTarget.set(null)"
    />

    @if (config(); as c) {
      <of-new-module-dialog
        [(open)]="dialogOpen"
        [config]="c"
        [changeSetTitle]="changeSets.selected()?.title ?? ''"
        [suggest]="suggestsOnly()"
        (create)="create($event)"
      />
    }
  `,
})
export class ContentBrowserPage {
  private readonly api = inject(ApiClient);
  private readonly readRef = inject(ReadRef);
  private readonly me = inject(MeService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly language = inject(LanguageService);
  private readonly creation = inject(ModuleCreation);
  private readonly deletion = inject(ModuleDeletion);
  private readonly draftBlocked = injectDraftBlocked();
  private readonly newRequest = inject(NewModuleRequest);
  private readonly permissions = inject(PermissionService);
  protected readonly changeSets = inject(ChangeSetSession);
  /** A contributor (#137): "Suggest a new module", in a change set made for it. */
  protected readonly suggestsOnly = this.permissions.suggestsOnly;
  /** App links keep the change set (`?cs=`). */
  protected readonly csLink = inject(ChangeSetUrl);
  private readonly t = injectTranslate();

  protected readonly pageSizes = PAGE_SIZES;
  /** Filters, search, page and page size live in the address: a reload or a link shows the same. */
  private readonly view = injectQueryState(BROWSER_PARAMS);
  /**
   * Whether the person reads drafts (`content.read.draft`): only then are deleted modules listed
   * (#418), as their last versions are mostly drafts.
   */
  protected readonly readsDrafts = computed(() =>
    this.me.me().permissions.has('content.read.draft'),
  );
  /**
   * Whether the person may read the translation status (`translation.manage` or
   * `content.read.draft`, as the API asks): only then do the rows say a translation's state (#694).
   */
  private readonly readsStatus = computed(() => {
    const permissions = this.me.me().permissions;
    return (
      permissions.has('translation.manage') ||
      permissions.has('content.read.draft')
    );
  });
  /** The legend names the states the rows can show. */
  protected readonly legendStates = computed((): readonly TranslationState[] =>
    this.readsStatus()
      ? ['up-to-date', 'outdated', 'at-agency', 'not-translated']
      : ['up-to-date', 'translated', 'not-translated'],
  );
  /** "Show deleted" in the address counts only for a drafts reader (#418). */
  protected readonly filters = computed((): BrowserFilters => {
    const filters = filtersOf(this.view.values());
    if (this.readsDrafts() || !filters.show?.includes('deleted')) {
      return filters;
    }
    const show = filters.show.filter((kind) => kind !== 'deleted');
    return { ...filters, show: show.length > 0 ? show : undefined };
  });
  /** The search box's text; the address has it once typing pauses. */
  protected readonly search = signal(this.view.get('q')());
  protected readonly pageNumber = this.view.get('page');
  private readonly pageSize = this.view.get('size');
  protected readonly dialogOpen = signal(false);
  /** The row whose actions menu is open. */
  protected readonly menuRow = signal<ModuleSummary | null>(null);
  /** The delete dialog's module; null while it is closed. */
  protected readonly deleteTarget = signal<DeleteTarget | null>(null);
  /** The modules the chosen change set deleted in every language (page 1, no filters). */
  protected readonly deletedRows = signal<readonly DeletedRow[]>([]);
  private readonly deletedReads = new Generation();

  /** The configuration as read (`GET /config`). */
  private readonly storedConfig = signal<StoredConfig | null>(null);
  /** The configuration with its labels in the interface language (#731). */
  protected readonly config = labelsInUi(this.storedConfig);
  protected readonly doc = signal<Response<'/module-summaries'> | null>(null);
  /** The translation states of the page's modules (#694); undefined: not read for this reader. */
  private readonly states = signal<TranslationStates | undefined>(undefined);
  protected readonly loading = signal(true);
  private readonly failure = signal<ApiError | null>(null);
  private readonly reloads = signal(0);
  private readonly listReads = new Generation();
  private readonly configReads = new Generation();
  private errorToast: number | null = null;

  private readonly frame = viewChild('frame', { read: ElementRef });
  protected readonly offset = signal('14rem');

  protected readonly groups = computed((): GroupNode[] => {
    const c = this.config();
    return c ? groupTree(c) : [];
  });

  /** What is read and by whom: a list read again when either changes. */
  private readonly readKey = computed(
    () => `${this.readRef.ref() ?? ''}\n${this.me.me().id}`,
  );

  /** The chosen change set's state; undefined for the released content. */
  private readonly changeSetState = this.newRequest.changeSetState;

  /**
   * Whether the person may change content: the row actions show. Not for a contributor (#137),
   * who suggests changes from the module itself.
   */
  protected readonly canEdit = computed(
    () =>
      this.permissions.state({ permission: 'content.edit' }).kind !==
        'hidden' && !this.permissions.suggestsOnly(),
  );

  /** Why Delete is blocked right now (a key), or null. */
  protected readonly deleteBlocked = computed(
    (): string | null =>
      this.draftBlocked() ??
      (this.config() ? null : 'editor.moduleActions.loading'),
  );

  /** Why "New module" is blocked right now (a key), or null. */
  protected readonly newBlocked = computed(
    (): string | null =>
      this.newRequest.blocked() ??
      (this.config() ? null : 'editor.content.new.loading'),
  );

  protected readonly languageOptions = computed((): FilterOption[] => {
    const c = this.config();
    const locale = this.language.locale();
    return c
      ? languagesOf(c).map((l) => ({
          value: l,
          label: languageName(locale, l),
        }))
      : [];
  });

  protected readonly statusOptions = computed((): FilterOption[] => {
    const state = this.changeSetState();
    const released = {
      value: 'released',
      label: this.t('ui.badges.status.released'),
    };
    if (state === undefined) return [released];
    const changed = statusOf(true, state);
    const keys = {
      draft: 'ui.badges.status.draft',
      'in-review': 'ui.badges.status.inReview',
      approved: 'ui.badges.status.approved',
      released: 'ui.badges.status.released',
      deprecated: 'ui.badges.status.deprecated',
    } as const;
    return [released, { value: 'changed', label: this.t(keys[changed]) }];
  });

  protected readonly rows = computed((): Row[] => {
    const chosen = this.changeSets.selected()?.id;
    const pending =
      this.pageNumber() === 1
        ? this.creation
            .pending()
            .filter((p) => p.changeSetId === chosen)
            .map((p): Row => ({ kind: 'pending', pending: p }))
        : [];
    const pendingIds = new Set(
      pending.map((r) => (r.kind === 'pending' ? r.pending.module.id : '')),
    );
    const deleted = this.showsDeleted()
      ? this.deletedRows().map((d): Row => ({ kind: 'deleted', deleted: d }))
      : [];
    return [
      ...pending,
      ...deleted,
      ...(this.doc()?.data ?? [])
        .filter((s) => !pendingIds.has(s.id))
        .map((s): Row =>
          s.meta.deleted
            ? { kind: 'removed', summary: s }
            : { kind: 'module', summary: s },
        ),
    ];
  });

  /**
   * The change set's deleted modules are listed on page 1 while nothing narrows the list but
   * "Changed": they have no metadata left to filter by. Not with "Show deleted" (#320), whose
   * list holds them already, read from the branch with their last versions.
   */
  private readonly showsDeleted = computed(() => {
    // Whether deprecated modules show does not matter: a deleted one has no metadata left.
    const { status, show, ...others } = this.filters();
    return (
      this.pageNumber() === 1 &&
      !show?.includes('deleted') &&
      !!this.changeSets.selected() &&
      (status === undefined || status === 'changed') &&
      Object.values(others).every((v) => v === undefined)
    );
  });

  protected readonly frameError = computed(() => {
    const f = this.failure();
    if (!f) return null;
    const text = apiErrorText(f);
    return { kind: f.kind, message: this.t(text.key, text.params) };
  });

  /** Any filter set, or search text typed (even before it applies). */
  protected readonly hasFilters = computed(
    () =>
      Object.values(this.filters()).some((v) => v !== undefined) ||
      this.search().trim() !== '',
  );

  private readonly searchInput = viewChild('searchInput', {
    read: ElementRef<HTMLInputElement>,
  });

  protected readonly emptyDescription = computed(() =>
    this.t(
      Object.values(this.filters()).some((v) => v !== undefined)
        ? 'editor.content.table.emptyFiltered'
        : 'editor.content.table.emptyNone',
    ),
  );

  constructor() {
    const destroyRef = inject(DestroyRef);
    // The configuration follows the branch read, and whoever is acting. A new head of the same
    // branch (an update from main, #466) keeps the one shown while it is read again.
    let configKey: string | undefined;
    effect(() => {
      const key = this.readKey();
      this.readRef.moves();
      // A switch unanswered: what was asked for the person before lands for nobody (#716).
      if (this.changeSets.switching()) {
        this.configReads.end();
        return;
      }
      untracked(() => {
        if (key !== configKey) this.storedConfig.set(null);
        configKey = key;
        void this.loadConfig();
      });
    });
    // "New module" asked for elsewhere (the search palette): opened once it can be.
    effect(() => {
      if (!this.newRequest.pending()) return;
      const blocked = this.newBlocked();
      // It waits for the configuration and for a change-set switch to finish.
      if (
        blocked === 'editor.content.new.loading' ||
        blocked === 'editor.changeSet.switchingReason'
      ) {
        return;
      }
      const allowed =
        this.permissions.state({ permission: 'content.edit' }).kind !==
        'hidden';
      untracked(() => {
        this.newRequest.take();
        if (!allowed) return; // the person changed meanwhile, to one who cannot create
        if (blocked) this.toast.error(translated(blocked));
        else this.dialogOpen.set(true);
      });
    });
    // A request this page did not take (it was left first) never opens a later visit's dialog.
    destroyRef.onDestroy(() => this.newRequest.take());
    // Back, Forward or a link changed the search: the box shows it. Not while the person types
    // (the box is ahead of the address until the debounce writes it).
    effect(() => {
      const q = this.view.get('q')();
      untracked(() => {
        if (!this.typing && this.search().trim() !== q) this.search.set(q);
      });
    });
    // A filter the configuration does not know (a stale or edited link) is dropped.
    effect(() => {
      const c = this.config();
      // Judged by the branch the link names: not while its change set is still looked up.
      if (!c || this.changeSets.resolving() || this.changeSets.switching()) {
        return;
      }
      const unknown = unknownFilters(this.filters(), c);
      if (Object.keys(unknown).length > 0) {
        untracked(() => this.view.set(valuesOf(unknown), { replace: true }));
      }
    });
    // "Changed" exists only while a change set is read: without one it would empty the list. Not
    // decided while the address's change set is still being looked up.
    effect(() => {
      if (this.changeSets.resolving()) return;
      const options = this.statusOptions();
      const status = untracked(() => this.filters().status);
      if (status && !options.some((o) => o.value === status)) {
        untracked(() =>
          this.view.set({ status: undefined, page: 1 }, { replace: true }),
        );
      }
    });
    effect(() => {
      const query = summaryQuery(this.filters(), {
        number: this.pageNumber(),
        size: this.pageSize(),
      });
      this.readKey();
      // A new head of the same branch (#466): the rows stay while the list is read again.
      this.readRef.moves();
      this.creation.created();
      this.deletion.changed();
      this.reloads();
      if (this.changeSets.switching()) {
        this.listReads.end();
        return;
      }
      untracked(() => void this.load(query));
    });
    // The deleted modules of the chosen change set, read again after each delete and undo.
    effect(() => {
      this.readKey();
      this.readRef.moves();
      this.deletion.changed();
      this.reloads();
      const show = this.showsDeleted();
      // Not while it is being started: its placeholder has no changes to read (#467).
      const id = this.changeSets.startedId() ?? undefined;
      if (this.changeSets.switching()) {
        this.deletedReads.end();
        return;
      }
      untracked(() => void this.loadDeleted(show ? id : undefined));
    });
    // The frame takes the height left under it, so the page itself never scrolls.
    const measure = () => {
      const el = this.frame()?.nativeElement as HTMLElement | undefined;
      if (!el) return;
      const top = Math.round(el.getBoundingClientRect().top);
      this.offset.set(`${Math.max(0, top) + BELOW_FRAME_PX}px`);
    };
    afterRenderEffect(() => {
      this.frame();
      this.config();
      measure();
    });
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.cancelDebounce = () => {
      clearTimeout(timer);
      this.typing = false;
    };
    this.debounce = (value: string) => {
      clearTimeout(timer);
      this.typing = true;
      timer = setTimeout(() => {
        this.typing = false;
        this.patch({ q: value.trim() || undefined });
      }, SEARCH_DEBOUNCE_MS);
    };
    destroyRef.onDestroy(() => {
      window.removeEventListener('resize', onResize);
      clearTimeout(timer);
      if (this.errorToast !== null) this.toast.dismiss(this.errorToast);
    });
  }

  private debounce: (value: string) => void = () => undefined;
  /** Text typed is waiting for the debounce: the box is ahead of the address. */
  private typing = false;
  private cancelDebounce: () => void = () => undefined;

  private async loadConfig(): Promise<void> {
    const live = this.configReads.start();
    try {
      const doc = await firstValueFrom(this.api.get('/config'));
      if (!live()) return; // an older read, for another branch or person
      this.storedConfig.set(doc.data.attributes);
    } catch {
      // The list's own failure (the same server) says it; the filters wait for a reload.
    }
  }

  private async load(query: ReturnType<typeof summaryQuery>): Promise<void> {
    const live = this.listReads.start();
    this.loading.set(true);
    this.failure.set(null);
    if (this.errorToast !== null) {
      this.toast.dismiss(this.errorToast);
      this.errorToast = null;
    }
    try {
      const doc = await firstValueFrom(
        this.api.get('/module-summaries', { query }),
      );
      if (!live()) return;
      // A page past the end (the list shrank): the last one there is.
      const last = Math.max(1, doc.meta.page.lastPage);
      if (doc.data.length === 0 && this.pageNumber() > last) {
        this.view.set({ page: last }, { replace: true });
        return;
      }
      // The rows and their translations' states show together: no row changes its badges after.
      const states = await this.readStates(doc.data);
      if (!live()) return;
      this.doc.set(doc);
      this.states.set(states);
      this.loading.set(false);
    } catch (error) {
      if (!live()) return;
      const failure = toApiError(error);
      this.doc.set(null);
      this.failure.set(failure);
      this.loading.set(false);
      if (failure.kind !== 'unauthorized') {
        this.errorToast = this.toast.error(
          translated('editor.content.table.failed'),
          {
            actionLabel: translated('editor.session.retry'),
            onAction: () => this.reload(),
          },
        );
      }
      void this.loadConfig();
    }
  }

  /**
   * The translation states of a page's modules (#694), from the translation status as the person
   * reads it (`filter[module]`, a row per module); undefined when they may not read it, or it
   * could not be read: the rows then say only which translations are there.
   */
  private async readStates(
    rows: readonly ModuleSummary[],
  ): Promise<TranslationStates | undefined> {
    const ids = rows.filter((s) => !s.meta.deleted).map((s) => s.id);
    if (!this.readsStatus() || ids.length === 0) return undefined;
    try {
      const doc = await firstValueFrom(
        this.api.get('/translations/status', {
          query: {
            'filter[module]': ids.join(','),
            'page[by]': 'row',
            ...pageQuery({ number: 1, size: ids.length }),
          },
        }),
      );
      return statesOf(doc.data);
    } catch {
      // Only an addition to the list: without it, the rows are still right about what is there.
      return undefined;
    }
  }

  private async loadDeleted(changeSetId: string | undefined): Promise<void> {
    const live = this.deletedReads.start();
    const person = this.me.me().id;
    if (!changeSetId) {
      this.deletedRows.set([]);
      return;
    }
    try {
      const rows = await loadDeletedModules(
        this.api,
        changeSetId,
        this.deletion.deleted(),
        person,
      );
      // Only for whoever asked: another person signed in meanwhile reads their own.
      if (live() && this.me.me().id === person) {
        this.deletedRows.set(rows);
      }
    } catch {
      // Only an addition to the list: without it the list is still right about what is there.
      if (live()) this.deletedRows.set([]);
    }
  }

  protected reload(): void {
    if (!this.config()) void this.loadConfig();
    this.reloads.update((n) => n + 1);
  }

  /** A filter changed: a history entry of its own, from page 1. */
  protected patch(change: Partial<BrowserFilters>): void {
    this.view.set({ ...valuesOf(change), page: 1 });
  }

  protected setPage(page: number): void {
    this.view.set({ page });
  }

  /** Back to everything: no filters, no search text, page 1. Focus goes to the search box, as the button that had it disappears. */
  protected resetFilters(): void {
    this.cancelDebounce();
    this.search.set('');
    this.view.set({
      q: '',
      type: undefined,
      facet: undefined,
      lang: undefined,
      audience: undefined,
      status: undefined,
      keyword: [],
      show: [],
      page: 1,
    });
    this.searchInput()?.nativeElement.focus();
  }

  protected typed(value: string): void {
    this.search.set(value);
    this.debounce(value);
  }

  protected setFacet(id: string, value: string): void {
    this.patch({ facet: value ? { id, value } : undefined });
  }

  protected setKeywords(keywords: readonly string[]): void {
    this.patch({ keywords: keywords.length > 0 ? keywords : undefined });
  }

  protected shows(kind: Shown): boolean {
    return this.filters().show?.includes(kind) ?? false;
  }

  /** "Show deprecated" (#266) and "Show deleted" (#320): in the address, as every filter. */
  protected setShown(kind: Shown, on: boolean): void {
    const others = (this.filters().show ?? []).filter((k) => k !== kind);
    const show = on ? [...others, kind] : others;
    this.patch({ show: show.length > 0 ? show : undefined });
  }

  protected setStatus(value: string): void {
    this.patch({
      status: value === 'released' || value === 'changed' ? value : undefined,
    });
  }

  protected setPageSize(size: number): void {
    this.view.set({ size, page: 1 });
  }

  protected chooseGroup(node: GroupNode | null): void {
    this.patch({ type: node?.type, facet: node?.facet });
  }

  protected isGroup(node: GroupNode): boolean {
    const f = this.filters();
    return (
      f.type === node.type &&
      f.facet?.id === node.facet?.id &&
      f.facet?.value === node.facet?.value
    );
  }

  /** Active: a grey background, no edge bar. */
  protected groupClass(active: boolean): string {
    return (
      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm outline-none ' +
      'focus-visible:ring-ring focus-visible:ring-2 [&_ng-icon]:size-4 [&_ng-icon]:shrink-0 ' +
      (active
        ? 'bg-background font-medium shadow-xs'
        : 'hover:bg-background/60 text-foreground')
    );
  }

  protected facetOptions(
    options: readonly { id: string; label: string }[],
  ): FilterOption[] {
    return options.map((o) => ({ value: o.id, label: o.label }));
  }

  /**
   * The audience levels to filter by: the last one also finds the modules naming none, since they
   * count as it (#699), and says so.
   */
  protected audienceOptions(
    levels: readonly { id: string; label: string }[],
  ): FilterOption[] {
    return levels.map((o, i) => ({
      value: o.id,
      label:
        i === levels.length - 1
          ? this.t('editor.content.filters.audienceWithUnset', {
              level: o.label,
            })
          : o.label,
    }));
  }

  protected asRows(items: readonly unknown[]): readonly Row[] {
    return items as readonly Row[];
  }

  /** A row's key: the table tracks its rows by it, and the list frame moves them by it. */
  protected readonly rowKey = (row: Row): string => {
    switch (row.kind) {
      case 'pending':
        return `pending:${row.pending.key}`;
      case 'deleted':
        return `deleted:${row.deleted.moduleId}`;
      case 'removed':
        return `removed:${row.summary.id}`;
      default:
        return `module:${row.summary.id}`;
    }
  };

  /** Opens the delete dialog for the row whose menu was used. */
  protected askDelete(): void {
    const s = this.menuRow();
    const c = this.config();
    const chosen = this.changeSets.selected();
    if (!s || !c || !chosen || this.deleteBlocked()) return;
    this.deleteTarget.set({
      moduleId: s.id,
      title: s.attributes.title,
      languages: s.attributes.languages,
      source: c.languages.source,
      configured: languagesOf(c),
      changeSetId: chosen.id,
      changeSetTitle: chosen.title,
    });
  }

  protected deleteModule(request: DeleteRequest): void {
    const target = this.deleteTarget();
    this.deleteTarget.set(null);
    const chosen = this.changeSets.selected();
    const blocked = this.deleteBlocked();
    if (!target || !chosen || chosen.id !== target.changeSetId || blocked) {
      this.toast.error(
        translated(blocked ?? 'editor.moduleActions.needsChangeSet'),
      );
      return;
    }
    void this.deletion.delete(request, chosen.id);
  }

  protected status(s: ModuleSummary) {
    return statusOf(s.meta.changed, this.changeSetState());
  }

  protected translations(s: ModuleSummary) {
    const c = this.config();
    return c
      ? translationsOf(s, c, this.states())
      : s.attributes.languages.map((lang) => ({
          lang,
          state: 'translated' as const,
        }));
  }

  protected variants(s: ModuleSummary): string {
    const c = this.config();
    const labels = c
      ? variantLabels(s.attributes.variants, c)
      : s.attributes.variants;
    return labels.length > 0
      ? labels.join(', ')
      : this.t('editor.content.table.allVariants');
  }

  protected typeLabel(id: string): string {
    return labelOf(this.config()?.moduleTypes ?? [], id);
  }

  protected audienceLabel(id: string | undefined): string {
    return id === undefined
      ? this.t('editor.content.table.noAudience', {
          level: unsetAudienceLevel(this.config()),
        })
      : labelOf(this.config()?.audiences ?? [], id);
  }

  protected languageLabel(lang: string): string {
    return languageName(this.language.locale(), lang);
  }

  /** The title is not in the language asked for (or, for All, not in the source language). */
  protected fallback(s: ModuleSummary): boolean {
    const wanted =
      this.filters().lang ?? this.config()?.languages.source ?? undefined;
    return wanted !== undefined && s.attributes.titleLang !== wanted;
  }

  /** A deleted module's history (#88), where a version of it can be restored. */
  protected openHistory(s: ModuleSummary): void {
    void this.router.navigate(
      ['/content', s.attributes.titleLang, s.id, 'history'],
      { queryParams: this.csLink.params() },
    );
  }

  protected open(s: ModuleSummary): void {
    void this.router.navigate(['/content', s.attributes.titleLang, s.id], {
      queryParams: this.csLink.params(),
    });
  }

  protected create(module: NewModule): void {
    if (this.suggestsOnly()) {
      void this.suggestModule(module);
      return;
    }
    const chosen = this.changeSets.selected();
    const blocked = this.newBlocked();
    if (!chosen?.branch || blocked) {
      // Blocked since the dialog was sent (a switch began): say so rather than drop it.
      this.toast.error(
        translated(blocked ?? 'editor.content.new.needsChangeSet'),
      );
      return;
    }
    const from = this.router.url;
    void this.creation
      .create(module, { id: chosen.id, branch: chosen.branch })
      .then((created) => {
        // "Create and open": only if the person is still where they started it.
        if (created && this.router.url === from) {
          void this.router.navigate(['/content', module.lang, module.id], {
            queryParams: this.csLink.params(),
          });
        }
      });
  }

  /**
   * A contributor's new module (#137): a change set named after it is started and chosen, then
   * the module is created in it and opened, in the focused editor. A refusal on the way is the
   * session's or the creation's toast, with a retry.
   */
  private async suggestModule(module: NewModule): Promise<void> {
    if (this.newBlocked()) return;
    // Still on this page (its path) when done: choosing the change set changes only `?cs=`.
    const path = () => this.router.url.split(/[?#]/)[0];
    const from = path();
    const id = await this.changeSets.start(module.title);
    const chosen = this.changeSets.selected();
    if (!id || chosen?.id !== id || !chosen.branch) return;
    const created = await this.creation.create(
      module,
      { id, branch: chosen.branch },
      { onRefused: () => void this.giveUp(id) },
    );
    if (created && path() === from) {
      void this.router.navigate(['/content', module.lang, module.id], {
        queryParams: this.csLink.params(),
      });
    }
  }

  /** A change set started for a new module that can never be created: abandoned, none chosen. */
  private async giveUp(id: string): Promise<void> {
    if (this.changeSets.selected()?.id === id) {
      this.changeSets.choose(null, 'session');
    }
    try {
      await firstValueFrom(
        this.api.act('/change-sets/{changeSetId}/abandon', {
          path: { changeSetId: id },
        }),
      );
    } catch {
      // Left as an empty draft of theirs: nothing is lost.
    }
    void this.changeSets.refresh();
  }
}
