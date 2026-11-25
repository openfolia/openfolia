import { HttpClient, HttpParams } from '@angular/common/http';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { LocalizedText } from '@openfolia/content-model/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideChevronDown,
  lucideCopy,
  lucideEllipsis,
  lucideEye,
  lucideEyeOff,
  lucideFileText,
  lucideKeyboard,
  lucideListChecks,
  lucideFilter,
  lucideFilterX,
  lucideFolderPlus,
  lucidePencil,
  lucidePlus,
  lucideTrash2,
  lucideArchive,
  lucideArchiveRestore,
  lucideHistory,
  lucideRotateCw,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { StatusBadgeComponent } from '@openfolia/ui/badges';
import { ZardButtonComponent } from '@openfolia/ui/button';
import {
  ZardCommandComponent,
  ZardCommandImports,
} from '@openfolia/ui/command';
import { ZardDropdownImports } from '@openfolia/ui/dropdown-menu';
import {
  injectTranslate,
  LanguageService,
  translated,
  DatePipe,
} from '@openfolia/ui/i18n';
import { KbdComponent } from '@openfolia/ui/kbd';
import {
  ModuleTreeComponent,
  ModuleTreeTrailingDirective,
  type ModuleTreeItem,
} from '@openfolia/ui/module-tree';
import {
  ZardPopoverImports,
  type ZardPopoverDirective,
} from '@openfolia/ui/popover';
import { ZardSheetImports } from '@openfolia/ui/sheet';
import { PageHeaderComponent } from '@openfolia/ui/shell';
import { FadeInDirective, RefreshingDirective } from '@openfolia/ui/smooth';
import {
  EmptyStateComponent,
  ErrorStateComponent,
  NoAccessStateComponent,
  SaveStatusComponent,
  SkeletonRowsComponent,
} from '@openfolia/ui/states';
import { ZardSwitchComponent } from '@openfolia/ui/switch';
import { ToastService } from '@openfolia/ui/toast';

import {
  API_BASE_URL,
  ApiClient,
  pageQuery,
  ReadRef,
  toApiError,
  type ApiError,
} from '../api';
import {
  languageName,
  languagesOf,
  statusOf,
  type ChangeSetState,
  type ModuleSummary,
  type StoredConfig,
} from '../content/browser-model';
import { ModuleCreation, type NewModule } from '../content/module-creation';
import { NewModuleDialogComponent } from '../content/new-module-dialog.component';
import { NewModuleRequest } from '../content/new-module-request';
import { apiErrorText, labelsInUi, UiTexts } from '../i18n';
import { GuardDirective } from '../permissions/guard.directive';
import { MeService } from '../permissions/me';
import { PermissionService } from '../permissions/permission.service';
import { type PermissionState } from '../permissions/permissions';
import { ChangeSetSession } from '../session/change-set-session';
import { ChangeSetUrl } from '../session/change-set-url';
import { Generation } from '../shared/generation';
import { injectQueryState } from '../view-state';
import { injectFailureText } from '../session/failure-text';
import {
  conditionChips,
  type VariantPick,
} from '../doc-editor/blocks/doc-blocks-context';
import {
  VariantPickerDialogComponent,
  type VariantPickRequest,
} from '../module-editor/variant-picker-dialog.component';
import { undoneOf, VersionRestore } from '../history/version-restore';
import { BUILDER_VIEW } from './builder-view';
import { ChapterDialogComponent } from './chapter-dialog.component';
import {
  DerivedRuleCardComponent,
  type SourceOption,
} from './derived-rule-card.component';
import { exclude, inVariant, originOf } from './derived-rule';
import {
  DeprecateDialogComponent,
  type Deprecation,
  type DeprecateTarget,
} from '../content/deprecate-dialog.component';
import {
  CoverPreviewComponent,
  type ThumbnailRequest,
} from './cover-preview.component';
import { ManualCreation, type NewManual } from './manual-creation';
import { ManualDraft, type DraftChangeSet } from './manual-draft';
import { ManualRemoval, type RemovedManual } from './manual-removal';
import { ManualTitleComponent } from './manual-title.component';
import {
  ManualSettingsPanelComponent,
  type PickCondition,
} from './manual-settings-panel.component';
import { rowIssues, setRowCondition, type Condition } from './manual-settings';
import { SettingsCardComponent } from './settings-card.component';
import { summarizeVariants } from './manual-variants';
import {
  NewManualDialogComponent,
  type NewManualPrefill,
} from './new-manual-dialog.component';
import { NewManualRequest } from './new-manual-request';
import {
  putStep,
  removeStep,
  restoreStep,
  type UpdateGuide,
} from './update-guide';
import { UpdateGuidePreviewComponent } from './update-guide-preview.component';
import { UpdateGuideStepsComponent } from './update-guide-steps.component';
import {
  UpdateStepDialogComponent,
  type StepRequest,
} from './update-step-dialog.component';
import { ModuleChoices } from './module-choices';
import { summaryOf } from './new-module-summary';
import { OutlineSummaries } from './outline-summaries';
import {
  addModule,
  headingText,
  moduleCount,
  removeRow,
  renameChapter,
  restoreRows,
  wrapInChapter,
  type OutlineRow,
} from './manual-outline';
import {
  OutputsCardComponent,
  type OutputLanguage,
} from './outputs-card.component';
import { StableAddressesCardComponent } from '../addresses/stable-addresses-card.component';

/** The switcher's "New manual" entry: a value no manual ID can take. */
const NEW_MANUAL = ':new';
/** A deleted manual's entry in the switcher (#321): its history, `:history:<id>`. */
const HISTORY_OF = ':history:';

/** The add-module list's "New module" entry: a value no module ID can take. */
const NEW_MODULE = ':new';
/** The add list's "Try again" after a failed search. */
const RETRY = ':retry';
/** The add list's "Show more modules": the next page of what was found. */
const MORE = ':more';

/**
 * The outline's keys as the keyboard popover lists them: keycaps and what they do. The shortcut
 * catalogue (`shortcuts/shortcuts.ts`, area `manuals`) lists the same keys; its spec holds them
 * together.
 */
export const OUTLINE_KEYS: readonly {
  readonly keys: readonly string[];
  readonly action: string;
  /** Whether it works in a read-only outline too. */
  readonly readOnly?: boolean;
  /** Whether it works in a derived manual's outline (#669), which its rule makes. */
  readonly derived?: boolean;
}[] = [
  {
    keys: ['editor.manuals.keys.cap.drag'],
    action: 'editor.manuals.keys.reorder',
  },
  {
    keys: [
      'editor.manuals.keys.cap.alt',
      'editor.manuals.keys.cap.up',
      'editor.manuals.keys.cap.down',
    ],
    action: 'editor.manuals.keys.move',
  },
  {
    keys: ['editor.manuals.keys.cap.tab'],
    action: 'editor.manuals.keys.indent',
  },
  {
    keys: ['editor.manuals.keys.cap.shift', 'editor.manuals.keys.cap.tab'],
    action: 'editor.manuals.keys.outdent',
  },
  {
    keys: ['editor.manuals.keys.cap.up', 'editor.manuals.keys.cap.down'],
    action: 'editor.manuals.keys.select',
    readOnly: true,
  },
  {
    keys: ['editor.manuals.keys.cap.enter'],
    action: 'editor.manuals.keys.open',
    readOnly: true,
  },
  {
    keys: ['editor.manuals.keys.cap.f2'],
    action: 'editor.manuals.keys.rename',
  },
  {
    keys: ['editor.manuals.keys.cap.delete'],
    action: 'editor.manuals.keys.remove',
  },
  {
    keys: ['editor.manuals.keys.cap.delete'],
    action: 'editor.manuals.keys.exclude',
    derived: true,
  },
  {
    keys: ['editor.manuals.keys.cap.shift', 'editor.manuals.keys.cap.f10'],
    action: 'editor.manuals.keys.actions',
  },
];

/** Where the settings are a side panel rather than a sheet from below (Tailwind's `sm`). */
const WIDE = '(min-width: 640px)';

/** Lists read whole (manuals, a change set's changes and locks): pages of this size, at most `MAX_PAGES`. */
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

/**
 * How many manuals only in a working copy (new, nothing committed yet), and titles of deleted
 * ones, are looked up at most.
 */
const MAX_UNCOMMITTED = 20;

/** A manual the chooser lists; `state` marks one created or deleted in the change set. */
interface ManualOption {
  readonly id: string;
  /** One text, or one per language (#731): `ShownManual` has it in the interface language. */
  readonly title: LocalizedText;
  readonly state?: 'new' | 'deleted' | undefined;
  /** Deprecated (#266): as committed, or as the open manual's working copy holds it. */
  readonly deprecated?: boolean;
  /** A derived manual (#451) or an update guide (#906), as committed: never a source of another. */
  readonly kind?: 'derived' | 'update-guide' | undefined;
  /** Its audience as committed (a derived manual gathers only from one for its own or a wider one). */
  readonly audience?: string | undefined;
}

/** A manual as the chooser shows it: its title in the interface language (#731). */
type ShownManual = Omit<ManualOption, 'title'> & { readonly title: string };

/** A manual deleted on the branch (#321): the switcher opens its history. */
interface DeletedManualOption {
  readonly id: string;
  readonly title: LocalizedText;
  readonly deletedAt: string;
}

/** What the change set did to manuals, as last read: created, and deleted (with titles). */
interface ManualChanges {
  readonly added: ReadonlySet<string>;
  readonly removed: readonly ManualOption[];
  /** New manuals with nothing committed yet: only in the person's working copy. */
  readonly uncommitted: readonly ManualOption[];
}

const NO_CHANGES: ManualChanges = {
  added: new Set(),
  removed: [],
  uncommitted: [],
};

/** A manual this page created or removed since the change set's changes were last read. */
interface LocalChange {
  readonly title: LocalizedText;
  /**
   * `gone`: removed, with nothing of it on the base (it is not listed at all); `restored`: a
   * deletion undone (listed as it is).
   */
  readonly state: 'new' | 'deleted' | 'gone' | 'restored';
  /** The read of the changes it is newer than. */
  readonly after: number;
}

/**
 * Screen 3, the manual builder (`/manuals`): one manual's outline as a module tree (drag to
 * reorder, Tab and Shift+Tab to change the level, Alt+Up/Down to move, Delete to remove with an
 * undo), modules added from the change set, modules put into chapters; beside it the outputs
 * per language and the PDF cover. Changes save eagerly into the current change set's working
 * copy (locked like a module; `ManualDraft`). The view (manual, row, language, variant, change
 * set) is in the address (`builder-view.ts`). The header is calm: the title is the manual
 * switcher (the manuals, marked new or deleted in the change set, then "New manual"), one primary
 * action ("Preview", the web preview; its split menu adds the PDF) and a ⋯ menu with Run checks
 * (`/checks?manual=`, screen 14), Rename (in place, on the title), Duplicate and Delete (with an
 * undo toast). With `content.edit` only, manuals are created (also from the search palette),
 * duplicated, renamed and deleted in the change set.
 */
@Component({
  selector: 'of-manual-builder',
  imports: [
    TranslocoPipe,
    NgIcon,
    PageHeaderComponent,
    ModuleTreeComponent,
    ModuleTreeTrailingDirective,
    SaveStatusComponent,
    SkeletonRowsComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    NoAccessStateComponent,
    StatusBadgeComponent,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardCommandImports,
    ZardDropdownImports,
    ZardPopoverImports,
    KbdComponent,
    GuardDirective,
    RouterLink,
    FadeInDirective,
    RefreshingDirective,
    OutputsCardComponent,
    StableAddressesCardComponent,
    CoverPreviewComponent,
    ChapterDialogComponent,
    DeprecateDialogComponent,
    NewManualDialogComponent,
    NewModuleDialogComponent,
    ManualTitleComponent,
    ManualSettingsPanelComponent,
    SettingsCardComponent,
    DerivedRuleCardComponent,
    UpdateGuidePreviewComponent,
    UpdateGuideStepsComponent,
    UpdateStepDialogComponent,
    VariantPickerDialogComponent,
    ZardSheetImports,
    ZardSwitchComponent,
    DatePipe,
  ],
  providers: [ManualDraft, OutlineSummaries, ModuleChoices],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideChevronDown,
      lucideCopy,
      lucideEllipsis,
      lucideEye,
      lucideEyeOff,
      lucideFileText,
      lucideKeyboard,
      lucideListChecks,
      lucideFilter,
      lucideFilterX,
      lucideFolderPlus,
      lucidePencil,
      lucidePlus,
      lucideTrash2,
      lucideArchive,
      lucideArchiveRestore,
      lucideHistory,
      lucideRotateCw,
    }),
  ],
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <of-page-header [title]="title()">
      <!-- Always projected: a projected title replaces the header's text for good. -->
      <of-manual-title
        ofTitle
        #titleField
        [title]="sourceTitle()"
        (rename)="draft.rename($event)"
      >
        @if (options(); as list) {
          <!-- The title is the manual switcher: the manuals, then "New manual". -->
          <button
            type="button"
            data-testid="manual-switcher"
            class="relative -start-1 inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-left break-words hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none aria-expanded:bg-muted"
            zPopover
            #switcher="zPopover"
            [zContent]="manualList"
            zPlacement="bottom"
            zAlign="start"
            aria-haspopup="dialog"
            (zVisibleChange)="switcherToggled($event)"
          >
            <span class="min-w-0 break-words">{{ title() }}</span>
            <span class="sr-only">{{
              'editor.manuals.switcher.hint' | transloco
            }}</span>
            <ng-icon
              name="lucideChevronDown"
              class="size-5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none"
              [class.rotate-180]="switcherOpen()"
              aria-hidden="true"
            />
          </button>
          <ng-template #manualList>
            <z-popover class="w-80 max-w-[calc(100vw-2rem)] p-0">
              <z-command
                class="rounded-lg border-0 shadow-none"
                #manualCommand="zCommand"
                (zCommandSelected)="pickManual($any($event).value, switcher)"
              >
                <z-command-input
                  [label]="'editor.manuals.switcher.search' | transloco"
                  [placeholder]="'editor.manuals.switcher.search' | transloco"
                />
                <z-command-list>
                  @for (m of list; track m.id) {
                    <z-command-option [zValue]="m.id" [zLabel]="m.title">
                      <span
                        data-slot="command-option-trailing"
                        class="flex shrink-0 items-center gap-1.5"
                      >
                        @if (m.state === 'new') {
                          <z-badge
                            zType="success"
                            class="font-normal"
                            data-state="new"
                            >{{
                              'editor.manuals.badge.new' | transloco
                            }}</z-badge
                          >
                        } @else if (m.state === 'deleted') {
                          <z-badge
                            zType="destructive"
                            class="font-normal"
                            data-state="deleted"
                            >{{
                              'editor.manuals.badge.deleted' | transloco
                            }}</z-badge
                          >
                        }
                        @if (m.deprecated) {
                          <of-status-badge
                            status="deprecated"
                            data-state="deprecated"
                          />
                        }
                        @if (m.id === manualId()) {
                          <ng-icon name="lucideCheck" aria-hidden="true" />
                          <span class="sr-only">{{
                            'editor.manuals.switcher.current' | transloco
                          }}</span>
                        }
                      </span>
                    </z-command-option>
                  }
                  @if (deletedShown()) {
                    @if (removedOptions(); as removed) {
                      @if (removed.length > 0) {
                        <z-command-option-group
                          [zLabel]="
                            'editor.manuals.switcher.deleted' | transloco
                          "
                        >
                          @for (m of removed; track m.id) {
                            <z-command-option
                              [zValue]="historyValue(m.id)"
                              [zLabel]="m.title"
                              zIcon="lucideHistory"
                              data-testid="manual-removed"
                            >
                              <span data-slot="command-option-label">
                                <span class="text-muted-foreground">{{
                                  m.title
                                }}</span>
                                <span
                                  class="block text-xs text-muted-foreground"
                                  >{{
                                    'editor.manuals.switcher.deletedOn'
                                      | transloco
                                        : { date: (m.deletedAt | ofDate) }
                                  }}</span
                                >
                              </span>
                            </z-command-option>
                          }
                        </z-command-option-group>
                      }
                    }
                  }
                  @if (newState(); as state) {
                    @if (state.kind !== 'hidden') {
                      @if (list.length > 0) {
                        <z-command-divider />
                      }
                      <z-command-option
                        [zValue]="newAction"
                        [zLabel]="'editor.manuals.new.open' | transloco"
                        zIcon="lucidePlus"
                        [zDisabled]="state.kind === 'disabled'"
                        data-testid="manual-new"
                      >
                        <span data-slot="command-option-label">
                          {{ 'editor.manuals.new.open' | transloco }}
                          @if (state.kind === 'disabled') {
                            <span class="block text-xs text-muted-foreground">{{
                              state.reason | transloco
                            }}</span>
                          }
                        </span>
                      </z-command-option>
                    }
                  }
                </z-command-list>
              </z-command>
              <div class="border-t border-border px-3 py-2">
                <!-- A deleted manual's last manifest is mostly a draft, so only drafts readers list them (issue 410). -->
                <z-switch
                  class="text-sm"
                  data-testid="manual-show-deleted"
                  [zChecked]="deletedShown()"
                  [zDisabled]="!readsDrafts()"
                  [attr.aria-describedby]="
                    readsDrafts() ? null : 'manual-show-deleted-reason'
                  "
                  (zCheckedChange)="showDeleted($event)"
                  >{{
                    'editor.manuals.switcher.showDeleted' | transloco
                  }}</z-switch
                >
                @if (!readsDrafts()) {
                  <p
                    id="manual-show-deleted-reason"
                    class="m-0 mt-1 text-xs text-muted-foreground"
                    data-testid="manual-show-deleted-reason"
                  >
                    {{
                      'editor.manuals.switcher.deletedNeedsDrafts' | transloco
                    }}
                  </p>
                }
                @if (deletedShown() && removedFailed()) {
                  <p class="m-0 mt-1 text-xs text-destructive" role="alert">
                    {{ 'editor.manuals.switcher.deletedFailed' | transloco }}
                  </p>
                }
              </div>
            </z-popover>
          </ng-template>
        } @else {
          {{ title() }}
        }
      </of-manual-title>
      @if (draft.manual()?.deprecated; as d) {
        <of-status-badge
          ofTitleAside
          ofFadeIn
          status="deprecated"
          data-testid="manual-deprecated"
          [attr.title]="d.reason"
        />
      }
      @if (draft.saveState(); as state) {
        <of-save-status ofTitleAside [status]="state" />
      }
      @if (shownId(); as id) {
        <!-- One primary action: the web preview; the PDF beside it in the split button's menu. -->
        <div
          class="inline-flex"
          role="group"
          [attr.aria-label]="'editor.manuals.openPreview' | transloco"
        >
          <a
            z-button
            class="rounded-e-none"
            routerLink="/preview"
            [queryParams]="previewParams(id)"
            data-testid="manual-preview"
          >
            <ng-icon
              name="lucideEye"
              data-icon="inline-start"
              aria-hidden="true"
            />
            {{ 'editor.manuals.openPreview' | transloco }}</a
          >
          <button
            z-button
            zSize="icon"
            type="button"
            class="rounded-s-none border-s-primary-foreground/25"
            data-testid="manual-preview-menu"
            z-dropdown
            [zDropdownMenu]="previewMenu"
            [zLoading]="building()"
            [attr.aria-label]="'editor.manuals.previewMenu.label' | transloco"
          >
            @if (!building()) {
              <ng-icon name="lucideChevronDown" aria-hidden="true" />
            }
          </button>
        </div>
        <button
          z-button
          zType="outline"
          zSize="icon"
          type="button"
          data-testid="manual-menu"
          z-dropdown
          [zDropdownMenu]="manualMenu"
          [attr.aria-label]="
            'editor.manuals.menu.label' | transloco: { title: title() }
          "
        >
          <ng-icon name="lucideEllipsis" aria-hidden="true" />
        </button>
      }
    </of-page-header>

    <div class="flex flex-wrap items-start gap-4">
      <section
        class="flex min-w-0 flex-[999_1_560px] flex-col gap-0.5 rounded-xl border border-border p-2"
        [attr.aria-label]="'editor.manuals.structure' | transloco"
      >
        <div
          class="flex flex-wrap items-center justify-between gap-2 px-2 pt-1.5 pb-2.5"
        >
          <div class="flex items-center gap-1">
            <span
              class="text-xs text-muted-foreground"
              data-testid="module-count"
            >
              @if (gatheredFrom(); as source) {
                {{
                  gatheredCountKey()
                    | transloco: { count: count(), source: source }
                }}
              } @else if (draft.guide(); as guide) {
                {{
                  'editor.manuals.guide.count'
                    | transloco: { count: guide.steps.length }
                }}
              } @else {
                {{ 'editor.manuals.count' | transloco: { count: count() } }}
              }
            </span>
            @if (shownRows().length > 0 && !draft.updateGuide()) {
              <button
                z-button
                zType="ghost"
                zSize="icon-xs"
                type="button"
                class="text-muted-foreground"
                data-testid="outline-keys"
                zPopover
                [zContent]="keysPanel"
                zPlacement="bottom"
                zAlign="start"
                [attr.aria-label]="'editor.manuals.keys.label' | transloco"
              >
                <ng-icon name="lucideKeyboard" aria-hidden="true" />
              </button>
            }
          </div>
          <!-- A derived manual's outline is gathered by its rule: nothing is added to it (issue 669). -->
          <!-- An update guide's outline is its steps (issue 908): a module chosen here becomes a step. -->
          @if (!draft.derived() && (!draft.updateGuide() || editable())) {
            <button
              z-button
              zType="outline"
              zSize="sm"
              type="button"
              data-testid="manual-add"
              zPopover
              [zContent]="addPanel"
              zPlacement="bottom"
              zAlign="end"
              [zVisible]="adding()"
              (zVisibleChange)="adding.set($event)"
              [ofGuard]="{
                permission: 'content.edit',
                blockedReason: blocked(),
              }"
            >
              <ng-icon
                name="lucidePlus"
                data-icon="inline-start"
                aria-hidden="true"
              />
              {{
                (draft.updateGuide()
                  ? 'editor.manuals.guide.add'
                  : 'editor.manuals.add.open'
                ) | transloco
              }}
            </button>
          }
        </div>
        @if (draft.gatherError(); as failure) {
          <div
            class="mx-2 mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive-muted px-3 py-2 text-sm text-destructive"
            role="alert"
            data-testid="gather-failed"
          >
            <span class="min-w-0 break-words">{{
              'editor.manuals.rule.gatherFailed' | transloco
            }}</span>
            <button
              z-button
              zType="outline"
              zSize="sm"
              type="button"
              (click)="draft.retryGather()"
            >
              <ng-icon
                name="lucideRotateCw"
                data-icon="inline-start"
                aria-hidden="true"
              />
              {{ 'editor.session.retry' | transloco }}
            </button>
          </div>
        }

        @if (pageError(); as err) {
          @if (err.kind === 'unauthorized') {
            <of-no-access [message]="errorText(err)" />
          } @else {
            <of-error-state
              [kind]="err.kind"
              [message]="errorText(err)"
              (retry)="retry()"
            />
          }
        } @else if (selectedDeleted()) {
          <of-empty-state
            [title]="'editor.manuals.deleted.title' | transloco"
            [description]="'editor.manuals.deleted.description' | transloco"
          />
        } @else if (manualId() === null && options() !== null) {
          <of-empty-state
            [title]="'editor.manuals.none.title' | transloco"
            [description]="
              (canCreate()
                ? 'editor.manuals.none.create'
                : 'editor.manuals.none.description'
              ) | transloco
            "
          >
            <!-- The first manual: "New manual" here too, not only in the title's list. -->
            <button
              z-button
              type="button"
              data-testid="manual-new-empty"
              [ofGuard]="{
                permission: 'content.edit',
                blockedReason: newBlocked(),
              }"
              (click)="openNew(null)"
            >
              <ng-icon
                name="lucidePlus"
                data-icon="inline-start"
                aria-hidden="true"
              />
              {{ 'editor.manuals.new.open' | transloco }}
            </button>
          </of-empty-state>
        } @else if (firstLoad()) {
          <!-- First load: placeholders (they fade in after a moment, so a quick answer never flashes them). -->
          <of-skeleton-rows
            [count]="10"
            [label]="'editor.manuals.loading' | transloco"
          />
        } @else if (draft.guide(); as guide) {
          <!-- An update guide (issue 908): its steps by version and phase, in place of the outline. -->
          @if (config(); as c) {
            @if (guide.steps.length === 0) {
              <of-empty-state
                ofFadeIn
                data-testid="guide-empty"
                [title]="'editor.manuals.guide.emptyTitle' | transloco"
                [description]="
                  (editable()
                    ? 'editor.manuals.guide.emptyDescription'
                    : 'editor.manuals.guide.emptyReadOnly'
                  ) | transloco
                "
              />
            } @else {
              <of-update-guide-steps
                ofFadeIn
                class="px-1 pb-1"
                [ofRefreshing]="reloading()"
                [guide]="guide"
                [config]="c"
                [issues]="draft.issues()"
                [editable]="editable()"
                [titleOf]="titleOf"
                [conditionText]="whenText"
                (guideChange)="draft.changeGuide($event)"
                (edit)="editStep($event)"
                (remove)="removeGuideStep($event)"
              />
            }
          }
        } @else if (shownRows().length === 0) {
          <div [ofRefreshing]="draft.gathering()">
            <of-empty-state
              [title]="
                (draft.derived()
                  ? 'editor.manuals.rule.emptyTitle'
                  : 'editor.manuals.empty.title'
                ) | transloco
              "
              [description]="
                (draft.derived()
                  ? draft.rule()?.notices
                    ? 'editor.manuals.rule.emptyNoticesDescription'
                    : 'editor.manuals.rule.emptyDescription'
                  : editable()
                    ? 'editor.manuals.empty.description'
                    : 'editor.manuals.empty.readOnly'
                ) | transloco
              "
            />
          </div>
        } @else {
          <!-- A reload keeps the outline on screen, dimmed and inert, until the new one arrives
               (a derived manual's too, while what its changed rule gathers is read). -->
          <div
            ofFadeIn
            [ofRefreshing]="reloading() || draft.gathering()"
            [attr.aria-busy]="draft.gathering() || null"
            data-testid="manual-outline"
          >
            <of-module-tree
              [items]="shownRows()"
              [readonly]="!editable() || draft.derived() || draft.updateGuide()"
              [label]="'editor.manuals.structure' | transloco"
              [selected]="selectedNode()"
              (selectedChange)="selectNode($event)"
              (itemsChange)="changed($event)"
              (activate)="open($event)"
              (keydown)="rowKeys($event)"
            >
              <ng-template ofModuleTreeTrailing let-item>
                @let row = asRow(item);
                @if (row.when) {
                  @let faulty = rowIssues(draft.issues(), row).length > 0;
                  <z-badge
                    [zType]="faulty ? 'destructive' : 'outline'"
                    class="max-w-48 min-w-0 truncate font-normal"
                    data-testid="row-condition"
                    [attr.title]="conditionText(row.when)"
                  >
                    @if (faulty) {
                      <span class="sr-only">{{
                        'editor.manuals.settings.issueError' | transloco
                      }}</span>
                    }
                    {{ conditionText(row.when) }}</z-badge
                  >
                }
                @if (draft.rule(); as rule) {
                  @let origin = originOf(rule, row.ref);
                  @if (origin !== 'gathered') {
                    <z-badge
                      zType="outline"
                      class="font-normal"
                      [attr.data-origin]="origin"
                      >{{
                        (origin === 'front'
                          ? 'editor.manuals.rule.frontBadge'
                          : 'editor.manuals.rule.backBadge'
                        ) | transloco
                      }}</z-badge
                    >
                  }
                  @if (!rowInVariant(row)) {
                    <z-badge
                      zType="secondary"
                      class="font-normal"
                      data-testid="row-not-in-variant"
                      >{{
                        'editor.manuals.rule.notInVariant'
                          | transloco: { variant: variant()?.label ?? '' }
                      }}</z-badge
                    >
                  }
                }
                @if (row.kind === 'module') {
                  @if (outline.absent().has(row.ref)) {
                    <z-badge zType="destructive" class="font-normal">{{
                      'editor.manuals.missing' | transloco
                    }}</z-badge>
                  } @else if (statusOfRow(row); as status) {
                    <of-status-badge [status]="status" />
                  }
                  @if (summaries()?.get(row.ref)?.attributes?.deprecated) {
                    <of-status-badge
                      status="deprecated"
                      data-testid="row-deprecated"
                    />
                  }
                }
                @if (editable() && draft.rule(); as rule) {
                  @if (originOf(rule, row.ref) === 'gathered') {
                    <button
                      z-button
                      zType="ghost"
                      zSize="icon-xs"
                      type="button"
                      tabindex="-1"
                      data-action="row-exclude"
                      class="shrink-0 text-muted-foreground"
                      [attr.aria-label]="
                        'editor.manuals.rule.excludeOf'
                          | transloco: { title: row.title }
                      "
                      [attr.title]="
                        'editor.manuals.rule.excludeOf'
                          | transloco: { title: row.title }
                      "
                      (click)="excludeRow(row)"
                    >
                      <ng-icon name="lucideEyeOff" aria-hidden="true" />
                    </button>
                  }
                } @else if (
                  editable() && !draft.derived() && !draft.updateGuide()
                ) {
                  <button
                    z-button
                    zType="ghost"
                    zSize="icon-xs"
                    type="button"
                    tabindex="-1"
                    data-row-menu
                    class="shrink-0 text-muted-foreground"
                    z-dropdown
                    [zDropdownMenu]="rowMenu"
                    [attr.aria-label]="
                      'editor.manuals.row.actions'
                        | transloco: { title: row.title }
                    "
                    (click)="menuRow.set(row.id)"
                  >
                    <ng-icon name="lucideEllipsis" aria-hidden="true" />
                  </button>
                }
              </ng-template>
            </of-module-tree>
          </div>
        }
      </section>

      <aside
        class="flex min-w-0 flex-[1_1_320px] flex-col gap-4 lg:max-w-[400px]"
      >
        @if (config(); as c) {
          @if (draft.rule(); as rule) {
            @if (!selectedDeleted()) {
              <of-derived-rule-card
                ofFadeIn
                [rule]="rule"
                [config]="c"
                [manual]="ruleManual()"
                [manuals]="sourceOptions()"
                [issues]="draft.issues()"
                [editable]="editable()"
                [titleOf]="titleOf"
                [inOutline]="outlineModules()"
                (ruleChange)="draft.changeRule($event)"
              />
            }
          }
        }
        @if (config(); as c) {
          @if (draft.guide(); as guide) {
            @if (!selectedDeleted()) {
              <of-update-guide-preview
                ofFadeIn
                [guide]="guide"
                [config]="c"
                [levels]="guideLevels()"
                [titleOf]="titleOf"
              />
            }
          }
        }
        @if (outputs().length > 0) {
          <of-outputs-card
            [languages]="outputs()"
            [selected]="lang()"
            [sourceLabel]="sourceLabel()"
            [variants]="variantLabels()"
            (choose)="chooseLang($event)"
          />
        }
        @if (manualId(); as id) {
          @if (lang(); as l) {
            <of-stable-addresses-card
              [manualId]="id"
              [lang]="l"
              [title]="manualTitle() || id"
              [variantLabel]="variantLabelOf"
              [productLabel]="productLabelOf"
            />
          }
        }
        @if (config(); as c) {
          @if (draft.manual() && !selectedDeleted()) {
            <of-settings-card
              [settings]="draft.settings()"
              [config]="c"
              [issues]="draft.issues()"
              [editable]="editable()"
              (open)="settingsOpen.set(true)"
            />
          }
        }
        @if (draft.manual(); as m) {
          <of-cover-preview
            [title]="manualTitle()"
            [variants]="coverVariants()"
            [variant]="variant()"
            [request]="thumbnails()"
            [revision]="draft.revision()"
            [previewParams]="previewParams(m.id)"
            (variantChange)="chooseVariant($event)"
          />
        }
      </aside>
    </div>

    <ng-template #addPanel>
      <z-popover class="w-80 max-w-[calc(100vw-2rem)] p-0">
        <!-- Searched on the server: the command shows what the search found. -->
        <z-command
          class="rounded-md"
          #addCommand="zCommand"
          zShouldFilter="false"
          (zCommandSelected)="add($any($event).value, addCommand.searchTerm())"
        >
          <z-command-input
            [label]="'editor.manuals.add.search' | transloco"
            [placeholder]="'editor.manuals.add.search' | transloco"
            (valueChange)="choices.query.set($event)"
          />
          @let found = choices.state();
          <z-command-list
            class="max-h-72"
            data-testid="manual-add-list"
            [attr.aria-busy]="found.status === 'loading' || null"
          >
            @if (found.status === 'loading' && found.items.length === 0) {
              <of-skeleton-rows
                class="px-2 py-1"
                [count]="3"
                [label]="'editor.manuals.add.searching' | transloco"
              />
            } @else if (found.status === 'error') {
              <p
                class="px-2 py-1.5 text-sm text-destructive"
                role="alert"
                data-testid="manual-add-failed"
              >
                {{ 'editor.manuals.add.failed' | transloco }}
              </p>
              <z-command-option
                [zValue]="retryAction"
                [zLabel]="'editor.manuals.add.retry' | transloco"
                zIcon="lucideRotateCw"
              />
            }
            <!-- Refining: the last results stay, dimmed, until the new ones arrive. -->
            <div [ofRefreshing]="found.status === 'loading'">
              @for (s of addable(); track s.id) {
                <z-command-option
                  [zValue]="s.id"
                  [zLabel]="s.attributes.title"
                />
              }
            </div>
            @if (found.moreFailed) {
              <p
                class="px-2 py-1.5 text-sm text-destructive"
                role="alert"
                data-testid="manual-add-more-failed"
              >
                {{ 'editor.manuals.add.moreFailed' | transloco }}
              </p>
              <!-- In "Show more"'s place: the keyboard's highlight stays on it. -->
              <z-command-option
                [zValue]="moreAction"
                [zLabel]="'editor.manuals.add.retry' | transloco"
                zIcon="lucideRotateCw"
                data-testid="manual-add-more-retry"
              />
            } @else if (moreChoices()) {
              <p
                class="px-2 py-1.5 text-xs text-muted-foreground"
                data-testid="manual-add-more"
              >
                {{ 'editor.manuals.add.more' | transloco }}
              </p>
              <z-command-option
                [zValue]="moreAction"
                [zLabel]="'editor.manuals.add.showMore' | transloco"
                zIcon="lucideChevronDown"
                data-testid="manual-add-show-more"
              />
            }
            <!-- Last, "New module…": the search text as its title. Its label holds that text, so the search always keeps it. -->
            @let query = addCommand.searchTerm().trim();
            @let state = newModuleState();
            @let newLabel =
              query
                ? ('editor.manuals.add.newNamed' | transloco: { query: query })
                : ('editor.manuals.add.new' | transloco);
            @if (addable().length > 0) {
              <z-command-divider />
            }
            <z-command-option
              [zValue]="newModuleAction"
              [zLabel]="newLabel"
              zIcon="lucidePlus"
              [zDisabled]="state.kind === 'disabled'"
              data-testid="module-new"
            >
              <span
                data-slot="command-option-label"
                class="break-words [overflow-wrap:anywhere]"
              >
                {{ newLabel }}
                @if (state.kind === 'disabled') {
                  <span class="block text-xs text-muted-foreground">{{
                    state.reason | transloco
                  }}</span>
                }
              </span>
            </z-command-option>
          </z-command-list>
        </z-command>
      </z-popover>
    </ng-template>

    <z-dropdown-menu-content #rowMenu class="w-56">
      @if (menuTarget(); as row) {
        @if (row.kind === 'chapter') {
          <z-dropdown-menu-item (click)="startRename(row)">
            <ng-icon name="lucidePencil" aria-hidden="true" />
            {{ 'editor.manuals.row.rename' | transloco }}
          </z-dropdown-menu-item>
        }
        <z-dropdown-menu-item (click)="pickRowCondition(row)">
          <ng-icon name="lucideFilter" aria-hidden="true" />
          {{ 'editor.manuals.row.someVariants' | transloco }}
        </z-dropdown-menu-item>
        @if (row.when) {
          <z-dropdown-menu-item (click)="clearRowCondition(row.id)">
            <ng-icon name="lucideFilterX" aria-hidden="true" />
            {{ 'editor.manuals.row.everyVariant' | transloco }}
          </z-dropdown-menu-item>
        }
        <z-dropdown-menu-item (click)="startWrap(row)">
          <ng-icon name="lucideFolderPlus" aria-hidden="true" />
          {{ 'editor.manuals.row.wrap' | transloco }}
        </z-dropdown-menu-item>
        <z-dropdown-menu-item zType="destructive" (click)="remove(row.id)">
          <ng-icon name="lucideTrash2" aria-hidden="true" />
          {{ 'editor.manuals.row.remove' | transloco }}
        </z-dropdown-menu-item>
      }
    </z-dropdown-menu-content>

    <ng-template #keysPanel>
      <z-popover class="w-72">
        <div z-popover-header>
          <h3 z-popover-title>{{ 'editor.manuals.keys.title' | transloco }}</h3>
        </div>
        <dl class="m-0 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
          @for (key of outlineKeys(); track key.action) {
            <dt class="flex gap-1">
              @for (cap of key.keys; track $index) {
                <kbd of-kbd>{{ cap | transloco }}</kbd>
              }
            </dt>
            <dd class="m-0 text-muted-foreground">
              {{ key.action | transloco }}
            </dd>
          }
        </dl>
      </z-popover>
    </ng-template>

    <z-dropdown-menu-content #previewMenu class="w-64" zAlign="end">
      @if (shownId(); as id) {
        <z-dropdown-menu-item (click)="openPreview(id)">
          <ng-icon name="lucideEye" aria-hidden="true" />
          {{ 'editor.manuals.previewMenu.page' | transloco }}
        </z-dropdown-menu-item>
      }
      <z-dropdown-menu-item
        data-testid="manual-build-pdf"
        [ofGuard]="{
          permission: 'content.read',
          blockedReason: previewBlocked(),
        }"
        (click)="buildPreview()"
      >
        <ng-icon name="lucideFileText" aria-hidden="true" />
        {{ pdfLabel() }}
      </z-dropdown-menu-item>
    </z-dropdown-menu-content>

    <z-dropdown-menu-content #manualMenu class="w-56" zAlign="end">
      @if (shownId(); as id) {
        <z-dropdown-menu-item
          data-testid="manual-run-checks"
          (click)="runChecks(id)"
        >
          <ng-icon name="lucideListChecks" aria-hidden="true" />
          {{ 'editor.manuals.runChecks' | transloco }}
        </z-dropdown-menu-item>
        <z-dropdown-menu-item
          data-testid="manual-history"
          (click)="openHistory(id)"
        >
          <ng-icon name="lucideHistory" aria-hidden="true" />
          {{ 'editor.manuals.menu.history' | transloco }}
        </z-dropdown-menu-item>
      }
      @if (newState().kind !== 'hidden') {
        <z-dropdown-menu-separator />
        <z-dropdown-menu-item
          data-testid="manual-rename"
          [ofGuard]="{
            permission: 'content.edit',
            blockedReason: titleEditable()
              ? null
              : (blocked() ?? 'editor.manuals.loading'),
          }"
          (click)="renameManual()"
        >
          <ng-icon name="lucidePencil" aria-hidden="true" />
          {{ 'editor.manuals.menu.rename' | transloco }}
        </z-dropdown-menu-item>
        <z-dropdown-menu-item
          data-testid="manual-duplicate"
          [ofGuard]="{
            permission: 'content.edit',
            blockedReason: draft.manual()
              ? newBlocked()
              : 'editor.manuals.loading',
          }"
          (click)="duplicate()"
        >
          <ng-icon name="lucideCopy" aria-hidden="true" />
          {{ 'editor.manuals.menu.duplicate' | transloco }}
        </z-dropdown-menu-item>
        @if (draft.manual()?.deprecated) {
          <z-dropdown-menu-item
            data-testid="manual-undeprecate"
            [ofGuard]="{
              permission: 'content.edit',
              blockedReason: deprecateBlocked(),
            }"
            (click)="setDeprecation(undefined)"
          >
            <ng-icon name="lucideArchiveRestore" aria-hidden="true" />
            {{ 'editor.deprecation.undo' | transloco }}
          </z-dropdown-menu-item>
        } @else {
          <z-dropdown-menu-item
            data-testid="manual-deprecate"
            [ofGuard]="{
              permission: 'content.edit',
              blockedReason: deprecateBlocked(),
            }"
            (click)="askDeprecate()"
          >
            <ng-icon name="lucideArchive" aria-hidden="true" />
            {{ 'editor.deprecation.action' | transloco }}
          </z-dropdown-menu-item>
        }
        <z-dropdown-menu-item
          zType="destructive"
          data-testid="manual-delete"
          [ofGuard]="{
            permission: 'content.edit',
            blockedReason:
              draft.manual() && !deleting()
                ? blocked()
                : 'editor.manuals.loading',
          }"
          (click)="deleteManual()"
        >
          <ng-icon name="lucideTrash2" aria-hidden="true" />
          {{ 'editor.manuals.menu.delete' | transloco }}
        </z-dropdown-menu-item>
      }
    </z-dropdown-menu-content>

    @if (config(); as c) {
      <of-new-module-dialog
        [(open)]="newModuleOpen"
        [config]="c"
        [changeSetTitle]="changeSets.selected()?.title ?? ''"
        [manualTitle]="title()"
        [initialTitle]="newModuleTitle()"
        [initialLang]="lang()"
        (create)="createModule($event)"
      />
      <of-new-manual-dialog
        [(open)]="newOpen"
        [config]="c"
        [manuals]="options() ?? []"
        [changeSetTitle]="changeSets.selected()?.title ?? ''"
        [blocked]="newRequest.blocked()"
        [prefill]="prefill()"
        (create)="create($event)"
      />
    }

    <z-sheet
      [zSide]="wide() ? 'right' : 'bottom'"
      [zSize]="wide() ? 'lg' : 'custom'"
      [zHeight]="wide() ? undefined : '90dvh'"
      class="overflow-y-auto"
      [zVisible]="settingsOpen() && !!draft.settings()"
      (zVisibleChange)="settingsOpen.set($event)"
    >
      <z-sheet-header>
        <z-sheet-title>{{
          'editor.manuals.settings.title' | transloco: { title: title() }
        }}</z-sheet-title>
        <z-sheet-description>{{
          (editable()
            ? 'editor.manuals.settings.description'
            : 'editor.manuals.settings.descriptionReadOnly'
          ) | transloco
        }}</z-sheet-description>
      </z-sheet-header>
      @if (config(); as c) {
        @if (draft.settings()) {
          <of-manual-settings-panel
            class="px-4 pb-6"
            [config]="c"
            [blockedReason]="blocked()"
            [pickCondition]="pickCondition"
            [changeSetId]="draftChangeSet()?.id ?? null"
          />
        }
      }
    </z-sheet>

    @if (config(); as c) {
      @if (draft.guide(); as guide) {
        <of-update-step-dialog
          [(open)]="stepOpen"
          [request]="stepRequest()"
          [guide]="guide"
          [config]="c"
          [levels]="guideLevels()"
          [pickCondition]="pickCondition"
          [conditionText]="whenText"
          (save)="saveStep($event)"
        />
      }
    }

    <of-variant-picker-dialog
      [request]="variantRequest()?.request ?? null"
      (done)="variantPicked($event)"
    />

    <of-deprecate-dialog
      [target]="deprecateTarget()"
      (confirm)="deprecateTarget.set(null); setDeprecation($event)"
      (closed)="deprecateTarget.set(null)"
    />
    <of-chapter-dialog
      [(open)]="chapterOpen"
      [mode]="chapterMode()"
      [initial]="chapterInitial()"
      [languages]="config()?.languages ?? null"
      (save)="chapterSaved($event)"
    />
  `,
})
export class ManualBuilderPage {
  private readonly api = inject(ApiClient);
  private readonly texts = inject(UiTexts);
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);
  private readonly readRef = inject(ReadRef);
  private readonly me = inject(MeService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly language = inject(LanguageService);
  private readonly failureText = injectFailureText();
  private readonly t = injectTranslate();
  protected readonly changeSets = inject(ChangeSetSession);
  protected readonly draft = inject(ManualDraft);
  private readonly creation = inject(ManualCreation);
  private readonly removal = inject(ManualRemoval);
  protected readonly newRequest = inject(NewManualRequest);
  private readonly permissions = inject(PermissionService);
  private readonly restorer = inject(VersionRestore);
  private readonly moduleCreation = inject(ModuleCreation);
  private readonly moduleRequest = inject(NewModuleRequest);

  /** The view as the address names it (each value of its form; looked up below). */
  private readonly view = injectQueryState(BUILDER_VIEW);
  private readonly csLink = inject(ChangeSetUrl);

  protected readonly manuals = signal<readonly ManualOption[] | null>(null);
  private readonly manualsError = signal<ApiError | null>(null);
  /** The configuration as read (`GET /config`). */
  private readonly storedConfig = signal<StoredConfig | null>(null);
  /** The configuration with its labels in the interface language (#731). */
  protected readonly config = labelsInUi(this.storedConfig);
  /** What the change set did to manuals; null while it is read. */
  private readonly changes = signal<ManualChanges | null>(null);
  /** This page's creations and removals the changes read last do not know yet, by manual ID. */
  private readonly local = signal<ReadonlyMap<string, LocalChange>>(new Map());
  private changesRuns = 0;
  /**
   * The changes last read in this change set: what stays when a read fails (null: none read yet,
   * so the address's manual stands).
   */
  private lastChanges: ManualChanges | null = null;
  private changesKey = '';
  protected readonly newOpen = signal(false);
  protected readonly prefill = signal<NewManualPrefill | null>(null);
  protected readonly deleting = signal(false);
  private destroyed = false;
  /** The summaries of the outline's modules, read by ID (#481); null until the first answer. */
  protected readonly outline = inject(OutlineSummaries);
  protected readonly summaries = this.outline.summaries;
  /** The modules the add list offers, searched on the server while it is open (#481). */
  protected readonly choices = inject(ModuleChoices);
  protected readonly building = signal(false);
  protected readonly adding = signal(false);
  protected readonly menuRow = signal<string | null>(null);
  protected readonly chapterOpen = signal(false);
  protected readonly chapterMode = signal<'wrap' | 'rename'>('wrap');
  protected readonly chapterInitial = signal<LocalizedText>('');
  private chapterTarget: string | null = null;
  private readonly listReads = new Generation();
  protected readonly settingsOpen = signal(false);
  /** Wide enough for the settings as a side panel (Tailwind's `sm`); else a sheet from below. */
  protected readonly wide = signal(
    typeof matchMedia === 'function' ? matchMedia(WIDE).matches : true,
  );
  protected readonly rowIssues = rowIssues;

  /** The variant picker's request and who waits for its answer; null while it is closed. */
  protected readonly variantRequest = signal<{
    readonly request: VariantPickRequest;
    readonly resolve: (pick: VariantPick | null) => void;
  } | null>(null);

  /** Opens the variant picker (a picker still open is cancelled first). */
  protected readonly pickCondition: PickCondition = (current, labels) => {
    this.variantPicked(null);
    return new Promise((resolve) =>
      this.variantRequest.set({
        request: { current, moduleTitle: '', labels },
        resolve,
      }),
    );
  };

  protected variantPicked(pick: VariantPick | null): void {
    const open = this.variantRequest();
    if (!open) return;
    this.variantRequest.set(null);
    open.resolve(pick);
  }

  /**
   * The chooser's manuals: those on the branch read (marked new when the change set added them),
   * then new ones only in a working copy, then those it deleted; null while they are read.
   */
  protected readonly options = computed((): readonly ShownManual[] | null => {
    const languages = this.storedConfig()?.languages;
    return (
      this.storedOptions()?.map((m) => ({
        ...m,
        title: this.texts.text(m.title, languages),
      })) ?? null
    );
  });

  /** The chooser's manuals with their titles as stored (`options` shows them). */
  private readonly storedOptions = computed(
    (): readonly ManualOption[] | null => {
      const list = this.manuals();
      if (!list) return null;
      const changes = this.changes() ?? NO_CHANGES;
      const local = this.local();
      const listed = new Set(list.map((m) => m.id));
      const stateOf = (m: ManualOption): ManualOption | null => {
        const mine = local.get(m.id);
        if (mine?.state === 'gone') return null;
        if (mine?.state === 'restored') return { id: m.id, title: m.title };
        return mine ? { ...m, state: mine.state } : m;
      };
      const extra = (all: readonly ManualOption[]) =>
        all.filter((m) => !listed.has(m.id) && listed.add(m.id));
      const created = [...local]
        .filter(([, c]) => c.state === 'new' || c.state === 'restored')
        .map(([id, c]) => ({ id, title: c.title, state: 'new' as const }));
      const removed = [...local]
        .filter(([, c]) => c.state === 'deleted')
        .map(([id, c]) => ({ id, title: c.title, state: 'deleted' as const }));
      const shown = this.draft.manual();
      const titled = (m: ManualOption): ManualOption =>
        shown && m.id === shown.id
          ? { ...m, title: shown.title, deprecated: !!shown.deprecated }
          : m;
      return [
        ...list.map((m) =>
          titled(changes.added.has(m.id) ? { ...m, state: 'new' as const } : m),
        ),
        ...extra(changes.uncommitted.map(titled)),
        ...extra(created),
        ...extra(changes.removed),
        ...extra(removed),
      ].flatMap((m) => stateOf(m) ?? []);
    },
  );

  /** The manual opened when the address names none: the first one not deleted. */
  private readonly firstId = computed(
    () => this.options()?.find((m) => m.state !== 'deleted')?.id,
  );

  /**
   * The manual shown: the address's when it is listed, else the first. While the change set's
   * changes are read, the address's stands (it may be a new manual only in a working copy).
   */
  protected readonly manualId = computed((): string | null => {
    const list = this.options();
    const asked = this.view.values().manual;
    if (!list) return asked ?? null;
    if (asked && this.changes() === null && this.draftChangeSet()) return asked;
    return list.find((m) => m.id === asked)?.id ?? this.firstId() ?? null;
  });

  protected readonly newAction = NEW_MANUAL;
  protected readonly newModuleAction = NEW_MODULE;
  protected readonly retryAction = RETRY;
  protected readonly moreAction = MORE;
  protected readonly newModuleOpen = signal(false);
  /** The new-module dialog's title: the add list's search text when it was opened. */
  protected readonly newModuleTitle = signal('');
  /** The row the new module goes after (the selected one when the dialog was opened). */
  private newModuleAfter: string | null = null;
  private readonly tree = viewChild(ModuleTreeComponent);
  protected readonly switcherOpen = signal(false);
  private readonly titleField = viewChild(ManualTitleComponent);
  private readonly manualCommand = viewChild<string, ZardCommandComponent>(
    'manualCommand',
    { read: ZardCommandComponent },
  );
  private readonly addCommand = viewChild<string, ZardCommandComponent>(
    'addCommand',
    { read: ZardCommandComponent },
  );
  /**
   * "Show more" was chosen and its page is on its way: the highlight stays on it once read (or
   * goes to the first module that page added, `followFrom` on).
   */
  private followMore = false;
  private followFrom = 0;
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** "New manual" in the switcher: hidden without `content.edit`, blocked with the reason. */
  protected readonly newState = computed(() =>
    this.permissions.state({
      permission: 'content.edit',
      blockedReason: this.newBlocked() ?? undefined,
    }),
  );

  /** The PDF entry of the preview menu names what it builds: the variant and language shown. */
  protected readonly pdfLabel = computed(() => {
    const variant = this.variant()?.label;
    const lang = this.lang();
    return variant && lang
      ? this.t('editor.manuals.previewMenu.pdf', {
          variant,
          language: languageName(this.language.locale(), lang),
        })
      : this.t('editor.manuals.previewMenu.pdfPlain');
  });

  /** The outline's keys, for the keyboard popover (translation keys); read-only, the moves go. */
  protected readonly outlineKeys = computed(() =>
    this.editable()
      ? OUTLINE_KEYS.filter((k) =>
          this.draft.derived() ? k.readOnly || k.derived : !k.derived,
        )
      : OUTLINE_KEYS.filter((k) => k.readOnly),
  );

  protected readonly originOf = originOf;
  private readonly ruleCard = viewChild(DerivedRuleCardComponent);

  /** A derived manual's source, as the outline's count names it (its ID until it is listed). */
  protected readonly gatheredFrom = computed((): string | null => {
    const rule = this.draft.rule();
    if (!rule) return null;
    const source = this.manuals()?.find((m) => m.id === rule.source);
    return source
      ? this.texts.text(source.title, this.storedConfig()?.languages)
      : rule.source;
  });

  /**
   * What the outline's count says of a derived manual: the modules gathered, or for a notice
   * gathering (#676) the modules holding the notices it gathers and how they are grouped (the
   * level groups' headings are the resolved manual's, not rows of the outline).
   */
  protected readonly gatheredCountKey = computed((): string => {
    const notices = this.draft.rule()?.notices;
    if (!notices) return 'editor.manuals.rule.gatheredCount';
    return notices.groupBy === 'level'
      ? 'editor.manuals.rule.noticeCountByLevel'
      : 'editor.manuals.rule.noticeCountByModule';
  });

  /** The derived manual itself, for its rule card: which sources it may gather from. */
  protected readonly ruleManual = computed(() => ({
    id: this.manualId() ?? '',
    audience: this.draft.settings()?.audience,
  }));

  /** The manuals on the branch, as the rule card's source picker knows them. */
  protected readonly sourceOptions = computed((): readonly SourceOption[] =>
    (this.manuals() ?? []).map((m) => ({
      id: m.id,
      title: this.texts.text(m.title, this.storedConfig()?.languages),
      kind: m.kind,
      audience: m.audience,
    })),
  );

  /** The modules the outline holds (the rule card's front and back matter search skips them). */
  protected readonly outlineModules = computed(
    () => new Set(this.moduleRefs()),
  );

  /** A module's title, as the summaries read it (its ID until then). */
  protected readonly titleOf = (id: string): string =>
    this.summaries()?.get(id)?.attributes.title ?? id;

  /** Whether a derived manual's row is in the chosen variant (its condition holds there). */
  protected rowInVariant(row: OutlineRow): boolean {
    return inVariant(row, this.variant()?.values, this.config());
  }

  /** Leaves a gathered module out of the derived manual: its rule excludes it (#669). */
  protected excludeRow(row: OutlineRow): void {
    const rule = this.draft.rule();
    if (!rule || !this.editable() || row.kind !== 'module') return;
    this.draft.changeRule(exclude(rule, row.ref));
  }

  protected readonly selectedDeleted = computed(
    () =>
      this.options()?.find((m) => m.id === this.manualId())?.state ===
      'deleted',
  );

  /** The manual whose checks and preview the header links to: not a deleted one. */
  protected readonly shownId = computed(() =>
    this.selectedDeleted() ? null : this.manualId(),
  );

  /** Whether the header's title can be edited in place: a manual read to edit, not being deleted. */
  protected readonly titleEditable = computed(
    () =>
      this.editable() &&
      !!this.draft.manual() &&
      !this.selectedDeleted() &&
      !this.deleting(),
  );

  /**
   * The cover's variants, labelled from the configuration as the API labels them (a manual read
   * from a working copy has no labels of the API's).
   */
  protected readonly coverVariants = computed(() => {
    const m = this.draft.manual();
    const config = this.config();
    if (!m) return [];
    return config
      ? summarizeVariants(
          m.variants.map((v) => v.values),
          config,
        )
      : m.variants;
  });

  /** A variant's label by its slug, for the stable addresses (#450). */
  protected readonly variantLabelOf = (slug: string): string =>
    this.coverVariants().find((v) => v.slug === slug)?.label ?? slug;

  /** A product's label (a value of a facet), for the stable addresses. */
  protected readonly productLabelOf = (id: string): string =>
    this.config()
      ?.facets.flatMap((f) => f.values)
      .find((v) => v.id === id)?.label ?? id;

  /** The variant builds' labels, for Outputs. */
  protected readonly variantLabels = computed(() =>
    this.coverVariants().map((v) => v.label),
  );

  protected readonly canCreate = computed(
    () =>
      this.permissions.state({ permission: 'content.edit' }).kind === 'enabled',
  );

  /**
   * "New module…" in the add list: blocked with the reason while the manual cannot be changed
   * or no draft revision is open; for someone who may not create modules, disabled with that
   * reason rather than hidden, as the list itself is open to them.
   */
  protected readonly newModuleState = computed((): PermissionState => {
    const state = this.permissions.state({
      permission: 'content.edit',
      blockedReason:
        this.blocked() ??
        this.moduleRequest.blocked() ??
        (this.config() ? null : 'editor.content.new.loading'),
    });
    return state.kind === 'hidden'
      ? { kind: 'disabled', reason: 'editor.manuals.add.newNotAllowed' }
      : state;
  });

  /** Why "New manual" is blocked now (a key), or null. */
  protected readonly newBlocked = computed(
    (): string | null =>
      this.newRequest.blocked() ??
      (this.config() ? null : 'editor.manuals.new.loading'),
  );

  /** The manual's preview (screen 11), on the chosen change set, language and variant. */
  protected previewParams(id: string): Record<string, string> {
    const lang = this.lang();
    const variant = this.variant()?.slug;
    return {
      ...this.csLink.params(),
      manual: id,
      ...(lang ? { lang } : {}),
      ...(variant ? { variant } : {}),
    };
  }

  /** The PDF pages the preview card shows: with the unsaved edits when the person edits. */
  protected readonly thumbnails = computed((): ThumbnailRequest | null => {
    const id = this.manualId();
    const variant = this.variant()?.slug;
    const lang = this.lang();
    // An empty manual has no PDF to show (it cannot be built until a module is added).
    if (
      !id ||
      !variant ||
      !lang ||
      this.draft.status() !== 'ready' ||
      this.draft.rows().length === 0
    ) {
      return null;
    }
    const ref = this.readRef.ref() ?? null;
    return { manualId: id, variant, lang, ref, live: this.editable() };
  });

  /** The manual's checks (screen 14), on the chosen change set. */
  protected checksParams(id: string): Record<string, string> {
    return { ...this.csLink.params(), manual: id };
  }

  private readonly languages = computed(() => {
    const c = this.config();
    return c ? languagesOf(c) : [];
  });
  /** The output language: the address's when configured, else the source language. */
  protected readonly lang = computed((): string | null => {
    const all = this.languages();
    const asked = this.view.values().lang;
    return all.find((l) => l === asked) ?? all[0] ?? null;
  });
  protected readonly variant = computed(() => {
    const variants = this.draft.manual()?.variants ?? [];
    const asked = this.view.values().variant;
    return variants.find((v) => v.slug === asked) ?? variants[0] ?? null;
  });

  protected readonly title = computed(() => {
    const option = this.options()?.find((m) => m.id === this.manualId());
    if (option?.state === 'deleted') return option.title;
    return (
      this.manualTitle() || option?.title || this.t('editor.manuals.title')
    );
  });

  /** The open manual's title in the interface language (#731); '' until read. */
  protected readonly manualTitle = computed(() =>
    this.texts.text(this.draft.manual()?.title, this.storedConfig()?.languages),
  );

  /** The open manual's title in the source language: what a rename in place changes (#731). */
  protected readonly sourceTitle = computed(() => {
    const title = this.draft.manual()?.title;
    return title === undefined
      ? this.title()
      : headingText(title, this.storedConfig()?.languages.source);
  });

  /**
   * The outline with each module's title (its ID until the summaries are read), and each
   * chapter's in the interface language (#731).
   */
  protected readonly shownRows = computed((): readonly OutlineRow[] => {
    const summaries = this.summaries();
    const languages = this.storedConfig()?.languages;
    return this.draft.rows().map((row) =>
      row.kind === 'module'
        ? {
            ...row,
            title: summaries?.get(row.ref)?.attributes.title ?? row.ref,
          }
        : {
            ...row,
            title:
              this.texts.text(row.heading ?? row.ref, languages) || row.ref,
          },
    );
  });
  protected readonly count = computed(() => moduleCount(this.draft.rows()));
  protected readonly selectedNode = computed(() => {
    const node = this.view.values().node;
    return this.draft.rows().some((row) => row.id === node)
      ? (node ?? null)
      : null;
  });
  protected readonly menuTarget = computed(
    () => this.draft.rows().find((row) => row.id === this.menuRow()) ?? null,
  );

  protected readonly editable = computed(
    () => this.draft.mode().kind === 'edit',
  );
  /** Why adding and changing is blocked now (a key), or null. */
  protected readonly blocked = computed((): string | null => {
    if (this.changeSets.switching()) return 'editor.changeSet.switchingReason';
    const mode = this.draft.mode();
    if (mode.kind === 'read') {
      return mode.reason ?? 'editor.manuals.blocked.needsChangeSet';
    }
    return this.draft.status() === 'ready' ? null : 'editor.manuals.loading';
  });
  protected readonly previewBlocked = computed((): string | null => {
    if (this.selectedDeleted()) return 'editor.manuals.deleted.title';
    if (this.draft.status() !== 'ready') return 'editor.manuals.loading';
    if (!this.variant()) return 'editor.manuals.preview.noVariants';
    if (this.draft.rows().length === 0) return 'editor.manuals.preview.empty';
    return null;
  });

  protected readonly firstLoad = computed(
    () =>
      this.options() === null ||
      (this.draft.status() !== 'error' && this.draft.manual() === null),
  );
  protected readonly reloading = computed(
    () => this.draft.status() === 'loading' && this.draft.manual() !== null,
  );
  protected readonly pageError = computed(
    () =>
      this.manualsError() ??
      (this.draft.status() === 'error' ? this.draft.error() : null),
  );

  /** The modules found for the add list that are not in the manual yet, by title (the API's order). */
  protected readonly addable = computed((): readonly ModuleSummary[] => {
    const used = new Set(
      this.draft
        .rows()
        .filter((r) => r.kind === 'module')
        .map((r) => r.ref),
    );
    return this.choices.state().items.filter((s) => !used.has(s.id));
  });
  /** A page more matches than the add list has read: typing narrows them, "Show more" reads on. */
  protected readonly moreChoices = computed(() => {
    const state = this.choices.state();
    return state.status !== 'error' && state.more && !state.moreFailed;
  });

  protected readonly sourceLabel = computed(() => {
    const source = this.languages()[0];
    return source ? languageName(this.language.locale(), source) : '';
  });

  protected readonly outputs = computed((): readonly OutputLanguage[] => {
    const summaries = this.summaries();
    const locale = this.language.locale();
    const modules = this.draft
      .rows()
      .filter((r) => r.kind === 'module')
      .map((r) => summaries?.get(r.ref))
      .filter((s): s is ModuleSummary => s !== undefined);
    return this.languages().map((lang, i) => {
      const present = modules.filter((s) =>
        s.attributes.languages.includes(lang),
      ).length;
      return {
        lang,
        label: languageName(locale, lang),
        present,
        missing: i === 0 ? 0 : modules.length - present,
      };
    });
  });

  /** The chosen change set's state; undefined for the released content. */
  private readonly changeSetState = computed((): ChangeSetState | undefined => {
    const id = this.changeSets.selected()?.id;
    return id === undefined
      ? undefined
      : this.changeSets.options().find((o) => o.id === id)?.state;
  });

  /** Lists are read for the branch read and the person acting. */
  private readonly readKey = computed(
    () => `${this.readRef.ref() ?? ''}\n${this.me.me().id}`,
  );

  /** The change set the draft is read in, as far as the session knows it. */
  protected readonly draftChangeSet = computed((): DraftChangeSet | null => {
    const chosen = this.changeSets.selected();
    if (!chosen?.branch) return null;
    const option = this.changeSets.options().find((o) => o.id === chosen.id);
    return {
      id: chosen.id,
      branch: chosen.branch,
      state: option?.state ?? 'draft',
      authorId: option?.authorId ?? '',
    };
  });
  private readonly draftKey = computed(() => {
    const cs = this.draftChangeSet();
    return `${this.manualId() ?? ''}\n${cs?.id ?? ''}\n${cs?.state ?? ''}\n${cs?.authorId ?? ''}\n${this.me.me().id}`;
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    // Another branch or person: read anew. A new head of the same branch (an update from main,
    // #466): read again, keeping what is shown meanwhile.
    let listsKey: string | undefined;
    effect(() => {
      const key = this.readKey();
      this.readRef.moves();
      // A switch unanswered: what was asked for the person before lands for nobody (#716).
      if (this.changeSets.switching()) {
        this.listReads.end();
        return;
      }
      untracked(() => {
        const keep = key === listsKey;
        listsKey = key;
        void this.loadLists(keep);
      });
    });
    // The summaries of the modules the outline names, as it gains them (#481).
    effect(() => {
      this.draft.rows();
      const rule = this.draft.rule();
      untracked(
        () =>
          void this.outline.want([
            ...this.moduleRefs(),
            ...(rule ? [...rule.exclude, ...rule.front, ...rule.back] : []),
          ]),
      );
    });
    // A check's link to a derived manual's rule (`?section=rule`, #669): once it shows, the
    // rule card comes into view with the focus, and the address forgets it.
    effect(() => {
      const asked = this.view.values().section;
      const card = this.ruleCard();
      if (asked !== 'rule' || this.draft.status() !== 'ready') return;
      untracked(() => {
        if (card) {
          afterNextRender(() => card.reveal(), { injector: this.injector });
        }
        this.view.set({ section: undefined }, { replace: true });
      });
    });
    // After "Show more", the keyboard's highlight stays on it (its options move down as the
    // next page goes in above it), or, on the last page, goes to the first module that page
    // added: Enter pressed again reads on, never adds a module by surprise. A page that failed
    // leaves it where it was, on the retry in "Show more"'s place (#561).
    effect(() => {
      const state = this.choices.state();
      untracked(() => {
        if (!this.followMore || state.status === 'loading') return;
        this.followMore = false;
        if (state.status !== 'ready' || state.moreFailed) return;
        const added = this.followFrom;
        afterNextRender(
          () => {
            const command = this.addCommand();
            if (!command) return;
            const options = command.filteredOptions();
            const more = options.findIndex((o) => o.zValue() === MORE);
            const fresh = new Set(state.items.slice(added).map((s) => s.id));
            const newest = this.addable().find((s) => fresh.has(s.id))?.id;
            const first = options.findIndex(
              (o) => o.zValue() === (newest ?? this.addable().at(-1)?.id),
            );
            command.setActiveByIndex(more >= 0 ? more : Math.max(0, first));
          },
          { injector: this.injector },
        );
      });
    });
    // The add list's modules, read only while it is open.
    effect(() => {
      const open = this.adding();
      untracked(() => (open ? this.choices.open() : this.choices.close()));
    });
    // The manuals deleted on the branch, while the switcher shows them (#321).
    effect(() => {
      this.readKey();
      this.readRef.moves();
      const shown = this.deletedShown();
      if (this.changeSets.switching()) {
        this.removedReads.end();
        return;
      }
      untracked(() => void this.loadRemoved(shown));
    });
    // A new head of the branch read (an update from main, #466): the open manual is read again,
    // once the saves on their way are made, its outline shown meanwhile.
    let movesSeen = this.readRef.moves();
    effect(() => {
      const moves = this.readRef.moves();
      if (moves === movesSeen) return;
      movesSeen = moves;
      untracked(() => {
        const id = this.manualId();
        if (id === null || this.selectedDeleted()) return;
        const scope = this.draft.scope();
        void this.draft.settled().then(() => {
          // Another manual or change set meanwhile: that one was read for itself.
          if (this.manualId() !== id || this.draft.scope() !== scope) return;
          void this.draft.load(id, this.draftChangeSet());
        });
      });
    });
    // A restore undone (#321) on the manual shown: its working copy changed under the builder,
    // which reads it again.
    let undoneSeen = this.restorer.undone()?.count ?? 0;
    effect(() => {
      const undone = this.restorer.undone();
      if (!undone || undone.count === undoneSeen) return;
      undoneSeen = undone.count;
      untracked(() => {
        const id = this.manualId();
        if (
          id !== null &&
          undoneOf(
            undone,
            { type: 'manual', manualId: id },
            this.changeSets.selected()?.id,
          )
        ) {
          void this.draft.load(id, this.draftChangeSet());
        }
      });
    });
    effect(() => {
      this.draftKey();
      const id = this.manualId();
      if (this.changeSets.switching() || id === null) return;
      // A manual deleted in the change set is not read: the page says so.
      if (this.selectedDeleted()) {
        untracked(() => this.draft.reset());
        return;
      }
      // A change set being started has no branch yet: the manual is read once it has one.
      if (this.changeSets.selected()?.branch === null) return;
      untracked(() => void this.draft.load(id, this.draftChangeSet()));
    });
    // Values the page does not know are dropped from the address, defaults left out.
    effect(() => {
      const view = this.view.values();
      const list = this.options();
      const ready = this.draft.status() === 'ready';
      const languages = this.languages();
      untracked(() => {
        this.view.set(
          {
            manual:
              list && (this.changes() !== null || !this.draftChangeSet())
                ? this.nonDefault(this.manualId(), this.firstId())
                : view.manual,
            lang:
              languages.length > 0
                ? this.nonDefault(this.lang(), languages[0])
                : view.lang,
            variant: ready
              ? this.nonDefault(
                  this.variant()?.slug ?? null,
                  this.draft.manual()?.variants[0]?.slug,
                )
              : view.variant,
            node: ready ? (this.selectedNode() ?? undefined) : view.node,
          },
          { replace: true },
        );
      });
    });
    // "New manual" asked for elsewhere (the search palette): opened once it can be.
    effect(() => {
      if (!this.newRequest.pending()) return;
      const blocked = this.newBlocked();
      // It waits for the configuration and for a change-set switch to finish.
      if (
        blocked === 'editor.manuals.new.loading' ||
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
        else this.openNew(null);
      });
    });
    const media = typeof matchMedia === 'function' ? matchMedia(WIDE) : null;
    const onMedia = () => this.wide.set(media?.matches ?? true);
    media?.addEventListener('change', onMedia);
    // The settings went (the manual deleted, read again after a failure): the panel closes, and
    // does not open again by itself when they come back.
    effect(() => {
      if (this.draft.settings() === null || this.selectedDeleted()) {
        untracked(() => this.settingsOpen.set(false));
      }
    });
    // Another manual or change set: its own settings, so the panel closes.
    effect(() => {
      this.draftKey();
      untracked(() => {
        this.settingsOpen.set(false);
        this.variantPicked(null);
      });
    });
    destroyRef.onDestroy(() => {
      media?.removeEventListener('change', onMedia);
      this.variantPicked(null);
      this.destroyed = true;
      this.listReads.end();
      this.changesRuns++;
      // A request this page did not take never opens a later visit's dialog.
      this.newRequest.take();
    });
  }

  private nonDefault(
    value: string | null,
    fallback: string | undefined,
  ): string | undefined {
    return value === null || value === fallback ? undefined : value;
  }

  /** A discrete choice: a history entry (`push` false: replaces it). */
  private choose(
    patch: Partial<{
      manual: string | undefined;
      node: string | undefined;
      lang: string | undefined;
      variant: string | undefined;
    }>,
    push = true,
  ): void {
    this.view.set(patch, { replace: !push });
  }

  protected chooseManual(value: string | string[]): void {
    const id = Array.isArray(value) ? value[0] : value;
    if (!id || id === this.manualId()) return;
    this.choose({
      manual: this.nonDefault(id, this.firstId()),
      node: undefined,
      variant: undefined,
    });
  }

  /** Opened, the switcher's search field takes the focus (arrows and Enter pick from there). */
  protected switcherToggled(open: boolean): void {
    this.switcherOpen.set(open);
    if (!open) return;
    afterNextRender(() => this.manualCommand()?.focus(), {
      injector: this.injector,
    });
  }

  /** A manual's history (#321): its versions, compared, restored as a draft. */
  protected openHistory(id: string): void {
    void this.router.navigate(['/manuals', id, 'history'], {
      queryParams: this.csLink.params(),
    });
  }

  /** "Show deleted" in the switcher (#321): in the address, as the rest of the view. */
  protected showDeleted(on: boolean): void {
    this.view.set({ deleted: on ? 'shown' : undefined }, { replace: true });
  }

  protected historyValue(id: string): string {
    return `${HISTORY_OF}${id}`;
  }

  /** A switcher entry: another manual, a deleted one's history, or "New manual". */
  protected pickManual(value: string, popover: ZardPopoverDirective): void {
    if (value.startsWith(HISTORY_OF)) {
      popover.hide();
      this.openHistory(value.slice(HISTORY_OF.length));
      return;
    }
    if (value === NEW_MANUAL) {
      if (this.newState().kind !== 'enabled') return;
      popover.hide();
      this.openNew(null);
      return;
    }
    popover.hide();
    this.chooseManual(value);
  }

  /** The web preview (screen 11) of the manual, as the split button's main part opens it. */
  protected openPreview(id: string): void {
    void this.router.navigate(['/preview'], {
      queryParams: this.previewParams(id),
    });
  }

  protected runChecks(id: string): void {
    void this.router.navigate(['/checks'], {
      queryParams: this.checksParams(id),
    });
  }

  /** The deprecate dialog's manual; null while it is closed. */
  protected readonly deprecateTarget = signal<DeprecateTarget | null>(null);

  /** Why Deprecate (or its undoing) is blocked now (a key), or null. */
  protected readonly deprecateBlocked = computed((): string | null =>
    this.titleEditable() ? null : (this.blocked() ?? 'editor.manuals.loading'),
  );

  protected askDeprecate(): void {
    const manual = this.draft.manual();
    if (!manual || this.deprecateBlocked()) return;
    this.deprecateTarget.set({
      kind: 'manual',
      id: manual.id,
      title: this.manualTitle() || manual.id,
    });
  }

  /**
   * Deprecates the manual (#266), or takes it back (`undefined`), in its working copy, saved like
   * the outline; the toast's Undo puts back what it was.
   */
  protected setDeprecation(deprecated: Deprecation | undefined): void {
    const manual = this.draft.manual();
    if (!manual || this.deprecateBlocked()) return;
    const before = manual.deprecated;
    this.draft.deprecate(deprecated);
    // Only in the manual and revision it was made in, while it can still be changed there.
    const generation = this.draftKey();
    const id = manual.id;
    this.toast.success(
      translated(
        deprecated ? 'editor.deprecation.done' : 'editor.deprecation.undone',
      ),
      {
        actionLabel: translated('ui.toast.undo'),
        onAction: () => {
          if (
            generation === this.draftKey() &&
            this.editable() &&
            this.draft.manual()?.id === id
          ) {
            this.draft.deprecate(before);
          }
        },
      },
    );
  }

  /** "Rename" in the menu: the title turns into a field once the menu has closed. */
  protected renameManual(): void {
    if (!this.titleEditable()) return;
    setTimeout(() => this.titleField()?.start(), 50);
  }

  protected chooseLang(lang: string): void {
    this.choose({ lang: this.nonDefault(lang, this.languages()[0]) });
  }

  protected chooseVariant(slug: string): void {
    this.choose({
      variant: this.nonDefault(slug, this.draft.manual()?.variants[0]?.slug),
    });
  }

  /** Moving through the rows replaces the entry: Back goes to the previous view, not row. */
  protected selectNode(id: string | null): void {
    this.choose({ node: id ?? undefined }, false);
  }

  /**
   * Reads the manuals (for the picker), the configuration and the summaries of the outline's
   * modules (by ID, #481), at the branch read; `keep`: what is shown stays until answered.
   */
  private async loadLists(keep = false): Promise<void> {
    const live = this.listReads.start();
    this.manualsError.set(null);
    // Read once the manuals are: until then the address's manual stands.
    this.changesRuns++;
    if (!keep) this.changes.set(null);
    this.outline.reset(keep);
    void this.outline.want(this.moduleRefs());
    // The add list's modules follow the person, the branch and its head by themselves.
    try {
      const [manuals, config] = await Promise.all([
        this.readAll((number) =>
          firstValueFrom(
            this.api.get('/manuals', {
              query: pageQuery({ number, size: PAGE_SIZE }),
            }),
          ),
        ),
        firstValueFrom(this.api.get('/config')),
      ]);
      if (!live()) return;
      this.storedConfig.set(config.data.attributes);
      // A rename in place and the chapters' rows name the title in the source language (#731).
      this.draft.source = config.data.attributes.languages.source;
      this.manuals.set(
        manuals.flatMap((m) =>
          'attributes' in m
            ? [
                {
                  id: m.id,
                  title: m.attributes.title,
                  deprecated: !!m.attributes.deprecated,
                  kind: m.attributes.kind,
                  audience: m.attributes.audience,
                },
              ]
            : [],
        ),
      );
      void this.loadChanges();
    } catch (error) {
      if (!live()) return;
      this.manualsError.set(toApiError(error));
      return;
    }
  }

  /** The modules the outline names. */
  private moduleRefs(): string[] {
    return this.draft
      .rows()
      .flatMap((r) => (r.kind === 'module' ? [r.ref] : []));
  }

  /**
   * What the chosen change set did to manuals: added and removed (from its changes), and new
   * manuals only in a working copy (a manual lock of the change set with nothing on the branch).
   * None without a change set; a list that cannot be read counts as empty.
   */
  private async loadChanges(): Promise<void> {
    const run = ++this.changesRuns;
    const cs = this.draftChangeSet();
    const key = `${cs?.id ?? ''}\n${this.me.me().id}`;
    if (key !== this.changesKey) {
      // Another change set or person: nothing known of it yet.
      this.changesKey = key;
      this.lastChanges = null;
      this.local.set(new Map());
    }
    if (!cs) {
      this.changes.set(NO_CHANGES);
      return;
    }
    this.changes.set(null);
    let base = '';
    const [changes, locks] = await Promise.all([
      this.readAll(async (number) => {
        const doc = await firstValueFrom(
          this.api.get('/change-sets/{changeSetId}/changes', {
            path: { changeSetId: cs.id },
            query: pageQuery({ number, size: PAGE_SIZE }),
          }),
        );
        base = doc.meta.base;
        return doc;
      }).catch(() => null),
      this.readAll((number) =>
        firstValueFrom(
          this.api.get('/locks', {
            query: {
              'filter[changeSet]': cs.id,
              ...pageQuery({ number, size: PAGE_SIZE }),
            },
          }),
        ),
      ).catch(() => null),
    ]);
    if (run !== this.changesRuns) return;
    if (!changes || !locks) {
      // Not known now: what was known stays, this page's own marks included, and the address's
      // manual with them.
      this.changes.set(this.lastChanges);
      return;
    }
    const manualChanges = changes.flatMap((c) =>
      c.attributes.subject.type === 'manual'
        ? [{ id: c.attributes.subject.manualId, change: c.meta.change }]
        : [],
    );
    const added = new Set(
      manualChanges.filter((c) => c.change === 'added').map((c) => c.id),
    );
    const removedIds = manualChanges
      .filter((c) => c.change === 'removed')
      .map((c) => c.id);
    const onBranch = new Set((this.manuals() ?? []).map((m) => m.id));
    const lockedNew = locks
      .flatMap((l) =>
        l.attributes.subject.type === 'manual'
          ? [l.attributes.subject.manualId]
          : [],
      )
      .filter(
        (id) => !onBranch.has(id) && !added.has(id) && !removedIds.includes(id),
      )
      .slice(0, MAX_UNCOMMITTED);
    const [removed, uncommitted] = await Promise.all([
      Promise.all(
        removedIds.map(async (id, i): Promise<ManualOption> => {
          // Titles of the first few only: the rest show their IDs.
          if (i >= MAX_UNCOMMITTED) {
            return {
              id,
              title: this.local().get(id)?.title ?? id,
              state: 'deleted',
            };
          }
          const title = await firstValueFrom(
            this.api.get('/manuals/{id}', {
              path: { id },
              query: { ref: base },
            }),
          )
            .then((doc) => doc.data.attributes.title)
            .catch(() => this.local().get(id)?.title ?? id);
          return { id, title, state: 'deleted' };
        }),
      ),
      Promise.all(
        lockedNew.map((id) =>
          firstValueFrom(
            this.api.get(
              '/change-sets/{changeSetId}/manuals/{manualId}/working-copy',
              { path: { changeSetId: cs.id, manualId: id } },
            ),
          )
            .then((doc): ManualOption[] =>
              doc.data.meta.saved
                ? [
                    {
                      id,
                      title: doc.data.attributes.content.title,
                      state: 'new',
                    },
                  ]
                : [],
            )
            .catch((): ManualOption[] => []),
        ),
      ),
    ]);
    if (run !== this.changesRuns) return;
    this.lastChanges = { added, removed, uncommitted: uncommitted.flat() };
    this.changes.set(this.lastChanges);
    // What this page did before this read began is in it now.
    this.local.update(
      (all) => new Map([...all].filter(([, c]) => c.after > run)),
    );
  }

  private markLocal(id: string, change: Omit<LocalChange, 'after'>): void {
    this.local.update((all) =>
      new Map(all).set(id, { ...change, after: this.changesRuns + 1 }),
    );
  }

  /** Opens the new-manual dialog: empty, or as a copy (`prefill`). */
  protected openNew(prefill: NewManualPrefill | null): void {
    this.prefill.set(prefill);
    this.newOpen.set(true);
  }

  /** "Duplicate": the dialog with "Copy of <title>" and the manual to copy chosen. */
  protected duplicate(): void {
    const m = this.draft.manual();
    if (!m) return;
    this.openNew({
      title: this.t('editor.manuals.duplicate.title', {
        title: this.sourceTitle(),
      }),
      copyFrom: m.id,
    });
  }

  /** Creates the manual in the change set and opens it. */
  protected async create(manual: NewManual): Promise<void> {
    const cs = this.draftChangeSet();
    const config = this.config();
    if (!cs || !config) return;
    await this.creation.create(manual, cs, config, () =>
      this.opened(manual, cs.id),
    );
  }

  /** A manual created (now, or by the failure toast's retry): listed and opened. */
  private opened(manual: NewManual, changeSetId: string): void {
    if (this.destroyed || changeSetId !== this.draftChangeSet()?.id) return;
    this.markLocal(manual.id, { title: manual.title, state: 'new' });
    this.choose({
      manual: this.nonDefault(manual.id, this.firstId()),
      node: undefined,
      variant: undefined,
    });
    void this.loadLists();
  }

  /**
   * Deletes the manual shown in the change set (no question asked): the builder moves on to the
   * next manual, and a toast offers to undo it while the change set is still a draft.
   */
  protected async deleteManual(): Promise<void> {
    const m = this.draft.manual();
    const cs = this.draftChangeSet();
    if (!m || !cs || !this.editable() || this.deleting()) return;
    this.deleting.set(true);
    try {
      const content = await this.draft.settled();
      if (!content || this.draft.manual()?.id !== m.id) return;
      // Nothing of it is saved any more.
      this.draft.reset();
      const removed = await this.removal.remove(
        {
          manualId: m.id,
          title: this.manualTitle() || m.id,
          content,
        },
        cs,
      );
      if (!removed) {
        void this.draft.load(m.id, this.draftChangeSet());
        return;
      }
      this.markLocal(m.id, {
        title: content.title,
        state: removed.committed ? 'deleted' : 'gone',
      });
      this.choose({ manual: undefined, node: undefined, variant: undefined });
      void this.loadLists();
      this.toast.show(
        translated('editor.manuals.delete.done', {
          title: this.texts.text(content.title, this.storedConfig()?.languages),
        }),
        {
          actionLabel: translated('editor.manuals.row.undo'),
          onAction: () => void this.undoDelete(removed),
        },
      );
    } finally {
      this.deleting.set(false);
    }
  }

  private async undoDelete(removed: RemovedManual): Promise<void> {
    // Only in the change set it was deleted in, as the person who deleted it.
    if (removed.changeSet.id !== this.draftChangeSet()?.id) return;
    if (!(await this.removal.restore(removed))) return;
    if (removed.changeSet.id !== this.draftChangeSet()?.id) return;
    this.markLocal(removed.manualId, {
      title: removed.title,
      state: removed.committed ? 'restored' : 'new',
    });
    this.choose({
      manual: this.nonDefault(removed.manualId, this.firstId()),
      node: undefined,
      variant: undefined,
    });
    void this.loadLists();
  }

  /** Every page of a list (at most `MAX_PAGES`). */
  /**
   * Whether the person reads drafts (`content.read.draft`): only then are deleted manuals listed
   * (#410), as their last manifests are mostly drafts.
   */
  protected readonly readsDrafts = computed(() =>
    this.me.me().permissions.has('content.read.draft'),
  );
  /** Whether the switcher lists the deleted manuals too (`?deleted=shown`, for drafts readers). */
  protected readonly deletedShown = computed(
    () => this.readsDrafts() && this.view.get('deleted')() === 'shown',
  );
  /** The manuals deleted on the branch (#321); null until read (or while not shown). */
  private readonly removed = signal<readonly DeletedManualOption[] | null>(
    null,
  );
  protected readonly removedFailed = signal(false);
  private readonly removedReads = new Generation();
  /** The deleted manuals the switcher does not list already (one deleted in the change set). */
  protected readonly removedOptions = computed(
    ():
      | readonly (Omit<DeletedManualOption, 'title'> & { title: string })[]
      | null => {
      const removed = this.removed();
      if (!removed) return null;
      const listed = new Set((this.options() ?? []).map((m) => m.id));
      const languages = this.storedConfig()?.languages;
      return removed
        .filter((m) => !listed.has(m.id))
        .map((m) => ({ ...m, title: this.texts.text(m.title, languages) }));
    },
  );

  private async loadRemoved(shown: boolean): Promise<void> {
    const live = this.removedReads.start();
    this.removedFailed.set(false);
    if (!shown) {
      this.removed.set(null);
      return;
    }
    try {
      const found = await this.readAll((number) =>
        firstValueFrom(
          this.api.get('/manuals', {
            query: {
              ...pageQuery({ number, size: PAGE_SIZE }),
              'filter[status]': 'deleted',
            },
          }),
        ),
      );
      if (!live()) return;
      this.removed.set(
        found.flatMap((m) =>
          'attributes' in m && m.meta.deleted
            ? [
                {
                  id: m.id,
                  title: m.attributes.title,
                  deletedAt: m.meta.deleted.committedAt,
                },
              ]
            : [],
        ),
      );
    } catch {
      if (!live()) return;
      this.removed.set(null);
      this.removedFailed.set(true);
    }
  }

  private async readAll<T>(
    page: (number: number) => Promise<{
      data: T[];
      meta: { page: { lastPage: number } };
    }>,
  ): Promise<T[]> {
    const all: T[] = [];
    for (let number = 1; number <= MAX_PAGES; number++) {
      const doc = await page(number);
      all.push(...doc.data);
      if (number >= doc.meta.page.lastPage) break;
    }
    return all;
  }

  protected retry(): void {
    if (this.manualsError()) {
      void this.loadLists();
      return;
    }
    const id = this.manualId();
    if (id !== null) void this.draft.load(id, this.draftChangeSet());
  }

  protected errorText(error: ApiError): string {
    const text = apiErrorText(error);
    return this.t(text.key, text.params);
  }

  protected asRow(item: ModuleTreeItem): OutlineRow {
    return item as OutlineRow;
  }

  /** A module's status in the change set (only a changed one shows one). */
  protected statusOfRow(row: OutlineRow) {
    const summary = this.summaries()?.get(row.ref);
    if (!summary) return null;
    const status = statusOf(summary.meta.changed, this.changeSetState());
    return status === 'released' ? null : status;
  }

  protected changed(items: readonly ModuleTreeItem[]): void {
    this.draft.change(items as readonly OutlineRow[]);
  }

  /** Delete (or Backspace) removes the focused row, F2 renames a chapter. */
  protected rowKeys(event: KeyboardEvent): void {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      '[role=treeitem]',
    );
    if (!row || row !== event.target || !this.editable()) return;
    const id = row.dataset['id'];
    const target = this.draft.rows().find((r) => r.id === id);
    if (!target) return;
    // A derived manual's outline is its rule's: no row is removed or renamed; Delete leaves a
    // gathered module out by the rule, as the row's button does (#669).
    if (this.draft.derived()) {
      const rule = this.draft.rule();
      if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        target.kind === 'module' &&
        rule &&
        originOf(rule, target.ref) === 'gathered'
      ) {
        event.preventDefault();
        this.excludeRow(target);
      }
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      this.remove(target.id);
    } else if (event.key === 'F2' && target.kind === 'chapter') {
      event.preventDefault();
      this.startRename(target);
    } else if (
      event.key === 'ContextMenu' ||
      (event.key === 'F10' && event.shiftKey)
    ) {
      // The row's actions (rename, put into a new chapter, remove) from the keyboard.
      event.preventDefault();
      row.querySelector<HTMLElement>('[data-row-menu]')?.click();
    }
  }

  /** Opens a module in the module editor, in the output language when it is written in it. */
  protected open(id: string): void {
    const row = this.draft.rows().find((r) => r.id === id);
    if (!row) return;
    if (row.kind === 'chapter') {
      if (this.editable()) this.startRename(row);
      return;
    }
    const summary = this.summaries()?.get(row.ref);
    const lang = this.lang();
    const inLang =
      lang && summary?.attributes.languages.includes(lang)
        ? lang
        : (summary?.attributes.titleLang ?? lang);
    if (!inLang) return;
    void this.router.navigate(['/content', inLang, row.ref], {
      queryParams: this.csLink.params(),
    });
  }

  protected add(moduleId: string | undefined, query = ''): void {
    if (moduleId === RETRY) {
      this.choices.reload();
      return;
    }
    if (moduleId === MORE) {
      // Only when a page is read: else a later answer would move the highlight (#561). Chosen
      // again while its page is on its way, it keeps following that page.
      const from = this.choices.state().items.length;
      if (this.choices.more()) {
        this.followMore = true;
        this.followFrom = from;
      }
      return;
    }
    if (moduleId === NEW_MODULE) {
      if (this.newModuleState().kind !== 'enabled') return;
      this.adding.set(false);
      this.newModuleTitle.set(query.trim());
      this.newModuleAfter = this.selectedNode();
      this.newModuleOpen.set(true);
      return;
    }
    this.adding.set(false);
    const summary = moduleId
      ? (this.choices.state().items.find((s) => s.id === moduleId) ??
        this.summaries()?.get(moduleId))
      : undefined;
    if (!summary || !this.editable()) return;
    // Its row shows its title and status at once.
    this.outline.put(summary);
    // An update guide's module becomes a step once its version and phase are set (#908).
    if (this.draft.updateGuide()) {
      this.openStep(null, { module: summary.id }, summary.attributes.title);
      return;
    }
    const { rows, id } = addModule(
      this.draft.rows(),
      { id: summary.id, title: summary.attributes.title },
      this.selectedNode(),
    );
    this.draft.change(rows);
    this.selectNode(id);
  }

  /**
   * Creates the module from the dialog in the revision and, once it is there, puts it into the
   * outline where the add list was opened, with an undo that takes it out of the outline again
   * (the module itself stays). Another manual or revision by then: only created.
   */
  protected createModule(module: NewModule): void {
    const cs = this.draftChangeSet();
    const blocked = this.newModuleState();
    if (!cs || blocked.kind !== 'enabled') {
      // Blocked since the dialog was sent (a switch began): say so rather than drop it.
      this.toast.error(
        translated(
          blocked.kind === 'disabled'
            ? blocked.reason
            : 'editor.content.new.needsChangeSet',
        ),
      );
      return;
    }
    const generation = this.draftKey();
    const after = this.newModuleAfter;
    void this.moduleCreation.create(
      module,
      { id: cs.id, branch: cs.branch },
      {
        doneText: null,
        onCreated: () => this.placeNewModule(module, generation, after),
      },
    );
  }

  private placeNewModule(
    module: NewModule,
    generation: string,
    after: string | null,
  ): void {
    if (this.destroyed || generation !== this.draftKey() || !this.editable()) {
      if (!this.destroyed) {
        this.toast.success(
          translated('editor.content.create.done', { title: module.title }),
        );
      }
      return;
    }
    // Listed at once with its title (the next read of the lists replaces it).
    this.outline.put(summaryOf(module));
    if (this.draft.updateGuide()) {
      this.toast.success(
        translated('editor.content.create.done', { title: module.title }),
      );
      this.openStep(null, { module: module.id }, module.title);
      return;
    }
    const { rows, id } = addModule(this.draft.rows(), module, after);
    this.draft.change(rows);
    this.selectNode(id);
    if (this.focusIsFree()) {
      afterNextRender(() => this.tree()?.focusItem(id), {
        injector: this.injector,
      });
    }
    this.toast.success(
      translated('editor.manuals.add.created', { title: module.title }),
      {
        actionLabel: translated('editor.manuals.row.undo'),
        onAction: () => {
          if (generation !== this.draftKey() || !this.editable()) return;
          const result = removeRow(this.draft.rows(), id);
          if (result) this.draft.change(result.rows);
        },
      },
    );
  }

  /** Whether the focus may move to a new row: nobody is typing or in a dialog meanwhile. */
  private focusIsFree(): boolean {
    const active = document.activeElement;
    if (!active || active === document.body) return true;
    return (
      this.host.nativeElement.contains(active) &&
      !active.closest(
        'input, textarea, select, [contenteditable], [role=dialog]',
      )
    );
  }

  protected remove(id: string): void {
    // An update guide's rows are its steps (#906): removed on its own screen, never here.
    if (this.draft.updateGuide()) return;
    const result = removeRow(this.draft.rows(), id);
    if (!result) return;
    const title = this.shownRows().find((r) => r.id === id)?.title ?? id;
    this.draft.change(result.rows);
    const generation = this.draftKey();
    this.toast.show(translated('editor.manuals.row.removed', { title }), {
      actionLabel: translated('editor.manuals.row.undo'),
      onAction: () => {
        if (generation !== this.draftKey() || !this.editable()) return;
        this.draft.change(restoreRows(this.draft.rows(), result.removed));
      },
    });
  }

  /** The step dialog (#908): open, and what it edits. */
  protected readonly stepOpen = signal(false);
  protected readonly stepRequest = signal<StepRequest | null>(null);
  /** The draft the step dialog was opened for: its answer applies to that one only. */
  private stepKey = '';

  /** The levels an update guide's step is for: the configured ones up to the guide's audience. */
  protected readonly guideLevels = computed(() => {
    const audiences = this.config()?.audiences ?? [];
    const audience = this.draft.settings()?.audience;
    const rank = audiences.findIndex((a) => a.id === audience);
    return (rank < 0 ? audiences : audiences.slice(0, rank + 1)).map((a) => ({
      id: a.id,
      label: a.label,
    }));
  });

  /** A condition in words, for an update guide's steps (any value: a step's `when`). */
  protected readonly whenText = (when: unknown): string =>
    this.conditionText(when as Condition);

  private openStep(
    index: number | null,
    step: StepRequest['step'],
    title: string,
  ): void {
    if (!this.editable() || !this.draft.guide()) return;
    this.stepKey = this.draftKey();
    this.stepRequest.set({ index, step, title });
    this.stepOpen.set(true);
  }

  /** Edits the update guide's step at `index`. */
  protected editStep(index: number): void {
    const step = this.draft.guide()?.steps[index];
    if (step) this.openStep(index, step, this.titleOf(step.module));
  }

  protected saveStep(saved: {
    index: number | null;
    step: UpdateGuide['steps'][number];
  }): void {
    const guide = this.draft.guide();
    if (!guide || this.stepKey !== this.draftKey() || !this.editable()) return;
    this.draft.changeGuide(putStep(guide, saved.index, saved.step));
  }

  /** Removes the update guide's step at `index`, with an undo while the same draft is shown. */
  protected removeGuideStep(index: number): void {
    const guide = this.draft.guide();
    const step = guide?.steps[index];
    if (!guide || !step || !this.editable()) return;
    this.draft.changeGuide(removeStep(guide, index));
    const generation = this.draftKey();
    this.toast.show(
      translated('editor.manuals.guide.removed', {
        title: this.titleOf(step.module),
      }),
      {
        actionLabel: translated('editor.manuals.row.undo'),
        onAction: () => {
          const now = this.draft.guide();
          if (generation !== this.draftKey() || !this.editable() || !now)
            return;
          this.draft.changeGuide(restoreStep(now, index, step));
        },
      },
    );
  }

  /** The condition in words, as the chips read ("Market: EU; Software: ≥ 2.3"). */
  protected conditionText(when: Condition): string {
    return (
      conditionChips(
        when,
        this.config(),
        this.t('editor.manuals.settings.rule'),
      ) ?? []
    )
      .map((chip) => `${chip.attribute}: ${chip.values.join(', ')}`)
      .join('; ');
  }

  /** "Only for some variants…": the row's condition, chosen in the variant picker. */
  protected async pickRowCondition(row: OutlineRow): Promise<void> {
    if (!this.editable()) return;
    const key = this.draftKey();
    const title =
      this.shownRows().find((r) => r.id === row.id)?.title ?? row.ref;
    const pick = await this.pickCondition(row.when ?? null, {
      title: this.t('editor.manuals.row.pickTitle'),
      subtitle: this.t(
        row.kind === 'chapter'
          ? 'editor.manuals.row.pickChapter'
          : 'editor.manuals.row.pickModule',
        { title },
      ),
    });
    if (!pick || key !== this.draftKey() || !this.editable()) return;
    if (!this.draft.rows().some((r) => r.id === row.id)) return;
    this.draft.change(
      setRowCondition(
        this.draft.rows(),
        row.id,
        pick === 'remove' ? null : pick,
      ),
    );
  }

  /** "Applies to every variant": the row's condition goes. */
  protected clearRowCondition(id: string): void {
    if (!this.editable()) return;
    this.draft.change(setRowCondition(this.draft.rows(), id, null));
  }

  protected startRename(row: OutlineRow): void {
    this.chapterTarget = row.id;
    this.chapterMode.set('rename');
    this.chapterInitial.set(row.heading ?? row.ref);
    this.chapterOpen.set(true);
  }

  protected startWrap(row: OutlineRow): void {
    this.chapterTarget = row.id;
    this.chapterMode.set('wrap');
    this.chapterInitial.set('');
    this.chapterOpen.set(true);
  }

  protected chapterSaved(title: LocalizedText): void {
    const id = this.chapterTarget;
    if (!id || !this.editable()) return;
    const source = this.storedConfig()?.languages.source;
    if (this.chapterMode() === 'rename') {
      this.draft.change(renameChapter(this.draft.rows(), id, title, source));
      return;
    }
    const result = wrapInChapter(this.draft.rows(), id, title, source);
    if (!result) return;
    this.draft.change(result.rows);
    this.selectNode(result.id);
  }

  /**
   * Builds the PDF of the chosen variant and language (after a save point, so it shows the
   * outline as it is now) and opens it in a new tab. The tab is opened at once, while the click
   * still counts as the person's, and shown the PDF when it arrives.
   */
  protected async buildPreview(): Promise<void> {
    const id = this.manualId();
    const variant = this.variant();
    const lang = this.lang();
    if (!id || !variant || !lang || this.building()) return;
    const tab = window.open('', '_blank');
    // The tab needs no way back to this page.
    if (tab) tab.opener = null;
    this.building.set(true);
    try {
      if (this.editable()) await this.draft.savePoint();
      const ref = this.readRef.ref();
      const blob = await firstValueFrom(
        this.http.get(
          `${this.base}/manuals/${encodeURIComponent(id)}/variants/${encodeURIComponent(variant.slug)}/${encodeURIComponent(lang)}/pdf`,
          {
            params: ref ? new HttpParams().set('ref', ref) : undefined,
            headers: { Accept: 'application/pdf' },
            responseType: 'blob',
          },
        ),
      );
      // Shown as a PDF whatever type the answer named: never as a page of this origin.
      const url = URL.createObjectURL(
        new Blob([blob], { type: 'application/pdf' }),
      );
      if (tab) tab.location.href = url;
      else window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      tab?.close();
      this.toast.error(
        this.failureText(
          translated('editor.manuals.preview.failed', { title: this.title() }),
          toApiError(error),
        ),
        {
          actionLabel: translated('editor.session.retry'),
          onAction: () => void this.buildPreview(),
        },
      );
    } finally {
      this.building.set(false);
    }
  }

  /** Leaving the builder (the route guard): what is saved becomes a save point first. */
  async leave(): Promise<boolean> {
    if (this.editable()) await this.draft.savePoint();
    return true;
  }
}
