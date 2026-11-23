import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  linkedSignal,
  resource,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  ActivatedRoute,
  Router,
  RouterLink,
  RouterLinkActive,
} from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideEllipsis,
  lucideEye,
  lucideHistory,
  lucideLanguages,
  lucideLock,
  lucideLockOpen,
  lucidePencilLine,
  lucideTrash2,
  lucideArchive,
  lucideArchiveRestore,
} from '@ng-icons/lucide';
import type { JSONContent } from '@tiptap/core';
import { toEditor } from '@openfolia/content-editor-model';
import {
  MAX_TABLE_CELLS,
  MAX_TABLE_COLUMNS,
  snippetTypes,
  type Block,
  type Condition,
} from '@openfolia/content-model/core';
import { firstValueFrom, map } from 'rxjs';

import { ZardAlertDialogService } from '@openfolia/ui/alert-dialog';
import { StatusBadgeComponent, type ContentStatus } from '@openfolia/ui/badges';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDropdownImports } from '@openfolia/ui/dropdown-menu';
import {
  injectTranslate,
  LanguageService,
  relativeTime,
  translated,
} from '@openfolia/ui/i18n';
import { SegmentedComponent } from '@openfolia/ui/segmented';
import { PageHelpComponent } from '@openfolia/ui/shell';
import { ZardSheetImports } from '@openfolia/ui/sheet';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import {
  FadeInDirective,
  RefreshingDirective,
  CollapseWidthDirective,
  SidePanelComponent,
  SidePanelContentDirective,
} from '@openfolia/ui/smooth';
import {
  ErrorStateComponent,
  NoAccessStateComponent,
  SaveStatusComponent,
  type SaveStatus,
} from '@openfolia/ui/states';
import { ZardTabNavComponent, ZardTabLinkComponent } from '@openfolia/ui/tabs';
import { ToastService } from '@openfolia/ui/toast';

import { auditLogLink, READ_AUDIT_LOG } from '../admin/audit/audit-model';
import { ApiClient, ApiError, ReadRef, toApiError } from '../api';
import {
  languageName,
  languagesOf,
  statusOf,
  type StoredConfig,
} from '../content/browser-model';
import { BlockEditorComponent } from '../doc-editor/block-editor.component';
import type {
  DocBlockSettings,
  AttachmentChoice,
  ImageChoice,
  ModuleContent as ReferencedModule,
  ModulePick,
  ModulePickOptions,
  SnippetSaver,
  VariantPick,
} from '../doc-editor/blocks/doc-blocks-context';
import type { SnippetSaveRequest } from '../doc-editor/snippets/save-snippet';
import { ModuleCreation } from '../content/module-creation';
import { SaveSnippetDialogComponent } from './save-snippet-dialog.component';
import type { BlockIssue } from '../doc-editor/plugins/block-issues';
import { apiErrorText, labelsInUi } from '../i18n';
import { AttachFileDialogComponent } from '../attachments/attach-file-dialog.component';
import { AttachmentFiles } from '../attachments/attachment-files';
import { ImageSources } from '../images/image-sources';
import { SymbolSources } from '../images/symbol-sources';
import { InsertImageDialogComponent } from '../images/insert-image-dialog.component';
import { GuardDirective } from '../permissions/guard.directive';
import { MeService } from '../permissions/me';
import { PermissionService } from '../permissions/permission.service';
import {
  DeleteModuleDialogComponent,
  type DeleteTarget,
} from '../content/delete-module-dialog.component';
import {
  DeprecateDialogComponent,
  type Deprecation,
  type DeprecateTarget,
} from '../content/deprecate-dialog.component';
import { injectDraftBlocked } from '../content/module-actions';
import { ModuleDeletion, type DeleteRequest } from '../content/module-deletion';
import { ModuleTranslation } from './module-translation';
import { ModuleRename } from './module-rename';
import { HistoryPanelComponent } from '../history/history-panel.component';
import { undoneOf, VersionRestore } from '../history/version-restore';
import { loadSnippets } from './snippet-list';
import { ChangeSetSession } from '../session/change-set-session';
import { LineBadgeComponent } from '../session/line-badge.component';
import { MaintenanceLines } from '../session/maintenance-lines';
import { ChangeSetUpdate } from '../session/change-set-update';
import { ChangeSetUrl } from '../session/change-set-url';
import { injectFailureText } from '../session/failure-text';
import { SuggestionPanelComponent } from './suggestion-panel.component';
import { SuggestionsPanelComponent } from './suggestions-panel.component';
import type { SuggestionItem } from './suggestion-items';
import { StyleReview } from './style-review';
import {
  TermPickerDialogComponent,
  type TermPickRequest,
} from './term-picker-dialog.component';
import { type LoadedWritingAids, loadWritingAids } from './writing-aids-source';
import { writingItems } from './suggestion-items';
import type { PlacedFinding } from '../doc-editor/writing/writing-checks';
import type { TermChoice } from '../doc-editor/writing/writing-aids';
import { idParam, injectQueryState, intParam, oneOfParam } from '../view-state';
import { LivePreviewComponent } from '../preview/live-preview.component';
import { clearDraft, type DraftSubject } from './local-drafts';
import {
  ModuleDetailsComponent,
  type TranslationRow,
  type UsedInRow,
} from './module-details.component';
import { ModuleDraft, type ContentIssue, type SavedCopy } from './module-draft';
import {
  ModulePickerDialogComponent,
  type ModulePickRequest,
} from './module-picker-dialog.component';
import {
  VariantPickerDialogComponent,
  type VariantPickRequest,
} from './variant-picker-dialog.component';
import {
  contentOf,
  includesModule,
  metaOf,
  outlineOf,
  patchMeta,
  variantsOf,
  type ModuleContent,
  type ModuleMeta,
} from './module-model';
import {
  ModuleOutlineComponent,
  type OutlineProblem,
} from './module-outline.component';
import { heldLockOf, isOwnLock, type HeldLock } from './module-lock';
import { ModuleLockedDialogComponent } from './module-locked-dialog.component';
import { injectPersonName } from '../history/history-model';

/** Why the module opens read-only (a translation key and its parameters), or null: editable. */
interface ReadOnly {
  readonly key: string;
  readonly params?: Record<string, unknown>;
  /** The lock another change set holds (screen 12), when that is why. */
  readonly lock?: HeldLock;
  /** The holder as people read them (empty: not told). */
  readonly holderName?: string;
  /**
   * The lock went while this page edited (taken over): the dialog does not open by itself, a
   * toast says so instead.
   */
  readonly lost?: boolean;
}

/** The module, loaded. */
interface Loaded {
  /** Counts loads: a new editor instance for each. */
  readonly key: number;
  readonly subject: DraftSubject | null;
  readonly content: ModuleContent;
  /** What the editor opens with. */
  readonly doc: JSONContent;
  readonly readOnly: ReadOnly | null;
  /** The lock this change set holds on it. */
  readonly lockedByMe: boolean;
  readonly status: ContentStatus;
  /** The module's deprecation where it was read (its source-language file's, #266); null: none. */
  readonly deprecation: Deprecation | null;
  /** The languages it exists in. */
  readonly languages: readonly string[];
}

type View =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: ApiError }
  | { readonly kind: 'ready'; readonly loaded: Loaded };

/** The module issue codes with a text of their own; others read by severity. */
const ISSUE_TEXTS: Readonly<Record<string, string>> = {
  'unknown-audience': 'editor.moduleEditor.issues.unknown-audience',
  'unknown-variant-attribute':
    'editor.moduleEditor.issues.unknown-variant-attribute',
  'unknown-variant-value': 'editor.moduleEditor.issues.unknown-variant-value',
  'invalid-version-value': 'editor.moduleEditor.issues.invalid-version-value',
  'empty-table': 'editor.moduleEditor.issues.empty-table',
  'snippet-too-large': 'editor.moduleEditor.issues.snippet-too-large',
  'inconsistent-variants': 'editor.moduleEditor.issues.inconsistent-variants',
  'unknown-text-attribute': 'editor.moduleEditor.issues.unknown-text-attribute',
  'unknown-replacement': 'editor.moduleEditor.issues.unknown-replacement',
  'unknown-callout': 'editor.moduleEditor.issues.unknown-callout',
  'unknown-callout-style': 'editor.moduleEditor.issues.unknown-callout-style',
  passthrough: 'editor.moduleEditor.issues.passthrough',
};

/** Block IDs as the content model writes them (`[#id]` in AsciiDoc). */
const BLOCK_ID = /^[a-z_][a-z0-9_-]{0,63}$/;

const SUMMARY_PAGE_SIZE = 100;
/** Wide enough for the live preview beside the document: Tailwind's `lg`. */
const WIDE = '(min-width: 64rem)';
/** How many titles of referenced modules are looked up at once. */
const TITLE_LOOKUPS = 4;
const MANUAL_PAGE_SIZE = 100;
/** At most this many pages of manuals are read for "Used in". */
const MANUAL_PAGES = 10;

/**
 * Screen 2, the module editor at `/content/:lang/:moduleId`. In a draft change set, for a person
 * with `content.edit`, it takes the module's lock and edits its working copy: every edit shows at
 * once and is saved in the background (`ModuleDraft`); leaving the module (and every few
 * minutes) makes a save point. Elsewhere (the published content, a change set in review, a lock
 * another holds) it opens read-only and says why. The outline goes to a block; the side panel
 * edits the metadata (title, type, facets, audience, keywords) in the same document, so it is
 * saved and undone with the text. Problems show at their blocks.
 */
@Component({
  selector: 'of-module-editor-page',
  imports: [
    LineBadgeComponent,
    RouterLink,
    PageHelpComponent,
    RouterLinkActive,
    TranslocoPipe,
    NgIcon,
    BlockEditorComponent,
    ModuleOutlineComponent,
    ModuleDetailsComponent,
    StatusBadgeComponent,
    SaveStatusComponent,
    ErrorStateComponent,
    NoAccessStateComponent,
    ZardSkeletonComponent,
    ZardTabNavComponent,
    ZardTabLinkComponent,
    FadeInDirective,
    RefreshingDirective,
    CollapseWidthDirective,
    SidePanelComponent,
    SidePanelContentDirective,
    ZardButtonComponent,
    InsertImageDialogComponent,
    AttachFileDialogComponent,
    ModulePickerDialogComponent,
    TermPickerDialogComponent,
    VariantPickerDialogComponent,
    SaveSnippetDialogComponent,
    LivePreviewComponent,
    ZardSheetImports,
    ZardDropdownImports,
    GuardDirective,
    DeleteModuleDialogComponent,
    DeprecateDialogComponent,
    ModuleLockedDialogComponent,
    SegmentedComponent,
    HistoryPanelComponent,
    SuggestionPanelComponent,
    SuggestionsPanelComponent,
  ],
  providers: [
    ModuleDraft,
    ImageSources,
    SymbolSources,
    AttachmentFiles,
    StyleReview,
  ],
  viewProviders: [
    provideIcons({
      lucideEllipsis,
      lucideEye,
      lucideHistory,
      lucideLanguages,
      lucideLock,
      lucideLockOpen,
      lucidePencilLine,
      lucideTrash2,
      lucideArchive,
      lucideArchiveRestore,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    // From lg up the page is as tall as the shell's content area and never scrolls as a whole:
    // only the document scrolls (the editor's own scroller), and the outline and the details
    // panel each scroll on their own when taller (positioned, so what is placed absolutely inside
    // them, such as screen-reader-only text, scrolls with them instead of stretching the page).
    // On a phone the page scrolls as before.
    class: 'block lg:flex lg:min-h-0 lg:flex-1 lg:flex-col',
    '(window:beforeunload)': 'beforeUnload($event)',
    '(window:online)': 'draft.online()',
    '(document:visibilitychange)': 'hidden()',
  },
  styles: `
    /* The toolbar stays in view while the document scrolls with the page (below lg). */
    of-module-editor-page of-editor-toolbar {
      position: sticky;
      top: 0;
      z-index: 10;
      background: var(--card);
      border-start-start-radius: inherit;
      border-start-end-radius: inherit;
    }
  `,
  template: `
    @let v = view();
    @let ready = v.kind === 'ready' ? v.loaded : null;
    <header
      class="mb-3 flex shrink-0 flex-wrap items-end justify-between gap-3"
    >
      <div
        class="flex min-h-8 min-w-0 flex-1 items-center gap-2.5"
        [ofRefreshing]="refreshing()"
      >
        @if (ready) {
          <h1
            ofFadeIn
            class="m-0 min-w-0 truncate text-2xl/8 font-medium"
            [attr.title]="title()"
            [attr.dir]="title() ? 'auto' : null"
          >
            {{ title() || ('editor.moduleEditor.untitled' | transloco) }}
          </h1>
          <of-status-badge class="shrink-0" [status]="status()" />
          <!-- The product version this revision fixes, when on a maintenance line. -->
          <of-line-badge
            [baseRef]="changeSets.selectedOption()?.baseRef ?? null"
          />
          @if (deprecation()) {
            <of-status-badge
              ofFadeIn
              class="shrink-0"
              status="deprecated"
              data-slot="module-deprecated"
            />
          }
          <!-- The editor's page of the user guide (issue 221). -->
          <of-page-help />
          <span
            class="text-muted-foreground flex min-w-0 items-center gap-x-1.5 overflow-hidden text-xs whitespace-nowrap"
          >
            @if (ready.readOnly; as ro) {
              <ng-icon
                class="shrink-0"
                name="lucideLock"
                size="14"
                aria-hidden="true"
              />
              <span class="truncate">{{ ro.key | transloco: ro.params }}</span>
            } @else {
              <ng-icon
                class="shrink-0"
                name="lucideLockOpen"
                size="14"
                aria-hidden="true"
              />
              <span class="shrink-0">{{
                'editor.moduleEditor.lockedByYou' | transloco
              }}</span>
              <span class="shrink-0" aria-hidden="true">·</span>
              <of-save-status
                class="min-w-0 truncate text-xs"
                [status]="saveStatus()"
                [detail]="saveDetail()"
              />
            }
          </span>
        } @else if (v.kind === 'error') {
          <h1 class="m-0 min-w-0 truncate font-mono text-2xl/8 font-medium">
            {{ moduleId() }}
          </h1>
        } @else {
          <div
            ofFadeIn="delayed"
            class="flex items-center gap-2.5"
            aria-hidden="true"
          >
            <z-skeleton class="h-7 w-56" />
            <z-skeleton class="h-5 w-14" />
            <z-skeleton class="h-3.5 w-36" />
          </div>
        }
      </div>
      @if (ready && ready.languages.length > 0) {
        <nav
          z-tab-nav
          ofFadeIn
          [attr.aria-label]="'editor.moduleEditor.language' | transloco"
        >
          @for (l of ready.languages; track l) {
            <a
              z-tab-link
              [routerLink]="['/content', l, moduleId()]"
              queryParamsHandling="preserve"
              routerLinkActive
              ariaCurrentWhenActive="page"
              [attr.lang]="l"
              >{{ l.toUpperCase() }}</a
            >
          }
        </nav>
      } @else if (v.kind === 'loading') {
        <z-skeleton ofFadeIn="delayed" class="h-8 w-24" aria-hidden="true" />
      }
      <div class="flex shrink-0 items-center gap-2">
        @if (sourceLang(); as source) {
          <button
            ofFadeIn
            z-button
            [zType]="panel() === 'source' ? 'secondary' : 'outline'"
            zSize="sm"
            type="button"
            data-slot="source-toggle"
            [attr.aria-pressed]="panel() === 'source'"
            [attr.aria-controls]="
              panel() === 'source' && wide() ? 'of-live-preview' : null
            "
            (click)="toggleSource()"
          >
            <ng-icon
              name="lucideLanguages"
              data-icon="inline-start"
              aria-hidden="true"
            />
            {{ 'editor.moduleEditor.source.toggle' | transloco }}
          </button>
        }
        @if (ready && heldLock()) {
          <button
            ofFadeIn
            z-button
            zType="outline"
            zSize="sm"
            type="button"
            data-slot="lock-take-over-header"
            [ofGuard]="{
              permission: 'admin.roles',
              blockedReason: heldLock()?.lock?.id
                ? null
                : 'editor.moduleLock.unknownLock',
            }"
            (click)="askTakeOver()"
          >
            <ng-icon
              name="lucideLockOpen"
              data-icon="inline-start"
              aria-hidden="true"
            />
            {{ 'editor.moduleLock.takeOver.action' | transloco }}
          </button>
        }
        <button
          z-button
          [zType]="panel() === 'open' ? 'secondary' : 'outline'"
          zSize="sm"
          type="button"
          data-tip="module-editor.preview"
          [attr.aria-pressed]="panel() === 'open'"
          [attr.aria-controls]="
            panel() === 'open' && wide() ? 'of-live-preview' : null
          "
          (click)="togglePreview()"
        >
          <ng-icon
            name="lucideEye"
            data-icon="inline-start"
            aria-hidden="true"
          />
          {{ 'editor.moduleEditor.preview' | transloco }}
        </button>
        @if (ready && canSuggest()) {
          <button
            ofFadeIn
            z-button
            zSize="sm"
            type="button"
            data-slot="suggest-change"
            [zLoading]="suggesting()"
            [zDisabled]="suggesting()"
            (click)="suggest()"
          >
            @if (!suggesting()) {
              <ng-icon
                name="lucidePencilLine"
                data-icon="inline-start"
                aria-hidden="true"
              />
            }
            {{ 'editor.suggestion.start' | transloco }}
          </button>
        }
        @if (ready && ((canEdit() && !focused()) || canReadAudit())) {
          <button
            z-button
            zType="ghost"
            zSize="icon-sm"
            type="button"
            data-slot="module-actions"
            z-dropdown
            [zDropdownMenu]="moduleMenu"
            [attr.aria-label]="'editor.moduleEditor.actions.label' | transloco"
            [attr.title]="'editor.moduleEditor.actions.label' | transloco"
          >
            <ng-icon name="lucideEllipsis" aria-hidden="true" />
          </button>
        }
      </div>
    </header>
    <z-dropdown-menu-content #moduleMenu class="w-56">
      @if (canReadAudit()) {
        <z-dropdown-menu-item
          data-slot="module-audit"
          (click)="showInAuditLog()"
        >
          <ng-icon name="lucideHistory" aria-hidden="true" />
          {{ 'editor.admin.audit.showIn' | transloco }}
        </z-dropdown-menu-item>
      }
      @if (canEdit() && !focused()) {
        @if (deprecation()) {
          <z-dropdown-menu-item
            data-slot="module-undeprecate"
            [ofGuard]="{
              permission: 'content.edit',
              blockedReason: deprecateBlocked(),
            }"
            (click)="undoDeprecation()"
          >
            <ng-icon name="lucideArchiveRestore" aria-hidden="true" />
            {{ 'editor.deprecation.undo' | transloco }}
          </z-dropdown-menu-item>
        } @else {
          <z-dropdown-menu-item
            data-slot="module-deprecate"
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
          data-slot="module-delete"
          [ofGuard]="{
            permission: 'content.edit',
            blockedReason: deleteBlocked(),
          }"
          (click)="askDelete()"
        >
          <ng-icon name="lucideTrash2" aria-hidden="true" />
          {{ 'editor.moduleEditor.actions.delete' | transloco }}
        </z-dropdown-menu-item>
      }
    </z-dropdown-menu-content>

    <!-- A size container: the preview is 45 % of this row wide (45cqw), also while it grows. -->
    <div
      class="flex flex-col gap-4 lg:@container lg:min-h-0 lg:flex-1 lg:flex-row lg:items-start"
      data-slot="module-editor-columns"
      [ofRefreshing]="refreshing()"
    >
      <of-module-outline
        class="order-2 shrink-0 lg:relative lg:order-none lg:max-h-full lg:w-56 lg:overflow-y-auto"
        [loading]="v.kind === 'loading'"
        [entries]="outline()"
        [problems]="problems()"
        (go)="editor()?.focusBlock($event)"
      />
      <div
        class="order-1 flex min-w-0 flex-1 flex-col lg:order-none lg:max-h-full lg:self-stretch"
      >
        @if (ready) {
          @for (l of [ready]; track l.key) {
            <of-block-editor
              ofFadeIn
              class="min-h-96 lg:min-h-0 lg:flex-1"
              [label]="
                'editor.moduleEditor.documentLabel'
                  | transloco: { title: title() }
              "
              [value]="l.doc"
              [editable]="!l.readOnly"
              [attr.inert]="submitting() || null"
              [focused]="focused()"
              [issues]="blockIssues()"
              [blocks]="blockSettings()"
              [suggestionMarks]="styleMarks()"
              (findings)="writingFindings.set($event)"
              (suggestionAction)="markedSuggestion($event)"
              (changed)="edited($event)"
              (blurred)="draft.flush()"
            />
          }
        } @else if (v.kind === 'error') {
          <div
            ofFadeIn
            class="border-border flex min-h-96 flex-col justify-center rounded-xl border p-6"
          >
            @if (v.error.kind === 'unauthorized') {
              <of-no-access
                [heading]="'editor.moduleEditor.noAccess' | transloco"
              />
            } @else {
              <of-error-state
                [kind]="v.error.kind"
                [heading]="
                  (v.error.kind === 'not-found'
                    ? 'editor.moduleEditor.notFound'
                    : 'editor.moduleEditor.loadFailed'
                  ) | transloco
                "
                [message]="errorText()"
                (retry)="reload()"
              />
            }
          </div>
        } @else {
          <!-- The editor's shape: its toolbar, a heading and blocks of text. -->
          <div
            ofFadeIn="delayed"
            class="border-border flex min-h-96 flex-col rounded-xl border"
            role="status"
            aria-busy="true"
          >
            <span class="sr-only">{{ 'ui.states.loading' | transloco }}</span>
            <div
              class="border-border flex items-center gap-0.5 border-b px-2 py-1.5"
              aria-hidden="true"
            >
              @for (b of [1, 2, 3]; track b) {
                <z-skeleton class="size-7" />
              }
              <z-skeleton class="mx-1 h-7 w-24" />
              @for (b of [1, 2, 3, 4, 5]; track b) {
                <z-skeleton class="size-7" />
              }
            </div>
            <div
              class="flex flex-col gap-3 ps-12 pe-10 pt-8 pb-12"
              aria-hidden="true"
            >
              <z-skeleton class="h-5 w-11/12" />
              <z-skeleton class="h-5 w-3/4" />
              <z-skeleton class="mt-3 h-24 w-full" />
              <z-skeleton class="mt-3 h-5 w-full" />
              <z-skeleton class="h-5 w-2/3" />
            </div>
          </div>
        }
      </div>
      <!--
        The preview opens in the details' place: it grows while the details column shrinks, in
        the same frames, so the editor's width changes once; closing is the reverse. The
        details stay rendered (their tab and scroll kept). Focus stays on the toggle.
      -->
      <of-side-panel
        #previewPanel
        class="lg:max-h-full lg:self-stretch [--of-side-panel-gap:1rem] [--of-side-panel-width:45cqw]"
        fill
        [takeFocus]="false"
      >
        <ng-template
          [ofSidePanelContent]="
            previewOpen() && wide() && panelReady() ? 'preview' : null
          "
        >
          <of-live-preview
            id="of-live-preview"
            class="h-full"
            [moduleId]="moduleId()"
            [title]="title() || moduleId()"
            [editorLang]="panelLang()"
            [lang]="
              panel() === 'source' ? undefined : query.get('previewLang')()
            "
            [languages]="panel() === 'source' ? [] : (ready?.languages ?? [])"
            [variant]="query.get('previewVariant')()"
            [live]="!!editingChangeSet()"
            [unsaved]="panel() !== 'source' && draft.unsaved()"
            [revision]="panel() === 'source' ? null : draft.savedAt()"
            [heading]="panelHeading()"
            [config]="config()"
            (langChange)="query.set({ previewLang: $event })"
            (variantChange)="query.set({ previewVariant: $event })"
            (shownVariant)="shownVariant.set($event)"
            (closed)="closePreview()"
            (blockClick)="goToBlock($event)"
          />
        </ng-template>
      </of-side-panel>
      <div
        class="order-3 shrink-0 [--of-collapse-gap:1rem] lg:order-none lg:flex lg:max-h-full lg:w-80 lg:flex-col"
        data-slot="module-details-column"
        [ofCollapseWidth]="previewPanel.opened() && !suggestionShown()"
        [ofCollapseWidthInstant]="!previewPanel.animates()"
      >
        <aside
          class="lg:relative lg:min-h-0 lg:w-80 lg:overflow-y-auto"
          [attr.aria-label]="'editor.moduleEditor.details.label' | transloco"
        >
          @if (ready && suggestionShown()) {
            <of-suggestion-panel
              ofFadeIn
              class="mb-3"
              [note]="note()"
              [missing]="noteMissing()"
              [submitting]="submitting()"
              [blocked]="submitBlocked()"
              (noteChange)="typedNote($event)"
              (noteDone)="keepNote()"
              (submitted)="submitSuggestion()"
            />
          }
          @if (v.kind !== 'error') {
            <!-- History is read-only here (and, for a contributor, on its page too). -->
            <of-segmented
              class="mb-3"
              data-slot="side-tabs"
              [label]="'editor.moduleEditor.side.label' | transloco"
              [options]="sideOptions()"
              [value]="side()"
              (valueChange)="chooseSide($event)"
            />
          }
          @if (side() === 'suggestions' && ready && editingChangeSet()) {
            <of-suggestions-panel
              ofFadeIn
              [checks]="checkItems()"
              [checksState]="writingState()"
              [state]="styleReview.state()"
              [items]="styleReview.items()"
              [error]="styleReview.error()"
              [announcement]="styleReview.announcement()"
              [blocked]="styleReviewBlocked()"
              (review)="reviewStyle()"
              (apply)="applySuggestion($event)"
              (show)="showSuggestion($event)"
              (dismiss)="dismissSuggestion($event)"
            />
          } @else if (side() === 'history' && v.kind !== 'error') {
            <of-history-panel
              ofFadeIn
              [lang]="lang()"
              [moduleId]="moduleId()"
              [page]="query.get('historyPage')()"
              (pageChange)="
                query.set({ historyPage: $event }, { replace: true })
              "
            />
          } @else if (ready && config() && meta(); as m) {
            <of-module-details
              ofFadeIn
              [meta]="m"
              [moduleId]="moduleId()"
              [config]="config()!"
              [editable]="!ready.readOnly && !focused()"
              [canTranslate]="!focused()"
              [variants]="variants()"
              [translations]="translations()"
              [usedIn]="usedIn()"
              [usedInFailed]="usedInFailed()"
              [deprecation]="deprecation()"
              [translateBlocked]="translateBlocked()"
              [translating]="translating()"
              (metaChange)="changeMeta($event)"
              (translate)="translate($event)"
              [canRename]="canEdit() && !focused()"
              [renameChangeSetId]="renameChangeSetId()"
              [renameOpen]="renameOpen()"
              [renameBlocked]="renameBlocked()"
              [renaming]="renaming()"
              (renameOpenChange)="
                query.set({ rename: $event ? 'open' : undefined })
              "
              (rename)="renameModule($event)"
            />
          } @else if (v.kind === 'loading') {
            <!-- The side panel's shape: details, translations, used in. -->
            <div
              ofFadeIn="delayed"
              class="flex flex-col gap-3"
              aria-hidden="true"
            >
              <div
                class="border-border flex flex-col gap-4 rounded-2xl border p-3.5"
              >
                @for (row of [1, 2, 3, 4, 5]; track row) {
                  <div class="flex flex-col gap-1.5">
                    <z-skeleton class="h-3 w-16" />
                    <z-skeleton class="h-8 w-full" />
                  </div>
                }
              </div>
              <div
                class="border-border flex flex-col gap-3 rounded-2xl border p-3.5"
              >
                <z-skeleton class="h-4 w-24" />
                @for (row of [1, 2]; track row) {
                  <z-skeleton class="h-4 w-full" />
                }
              </div>
              <div
                class="border-border flex flex-col gap-3 rounded-2xl border p-3.5"
              >
                <z-skeleton class="h-4 w-16" />
                <z-skeleton class="h-4 w-3/4" />
              </div>
            </div>
          }
        </aside>
      </div>
    </div>
    <!-- The address opens and closes it, Back and Forward included. -->
    <z-sheet
      zSide="bottom"
      zSize="custom"
      zHeight="100dvh"
      [zClosable]="false"
      class="p-3"
      [zCloseOnNavigation]="false"
      [zVisible]="previewOpen() && !wide() && panelReady()"
      (zVisibleChange)="$event || closePreview()"
    >
      @if (previewOpen() && !wide() && panelReady()) {
        <of-live-preview
          class="h-full"
          [moduleId]="moduleId()"
          [title]="title() || moduleId()"
          [editorLang]="panelLang()"
          [lang]="panel() === 'source' ? undefined : query.get('previewLang')()"
          [languages]="panel() === 'source' ? [] : (ready?.languages ?? [])"
          [variant]="query.get('previewVariant')()"
          [live]="!!editingChangeSet()"
          [unsaved]="panel() !== 'source' && draft.unsaved()"
          [revision]="panel() === 'source' ? null : draft.savedAt()"
          [heading]="panelHeading()"
          [config]="config()"
          (langChange)="query.set({ previewLang: $event })"
          (variantChange)="query.set({ previewVariant: $event })"
          (shownVariant)="shownVariant.set($event)"
          (closed)="closePreview()"
          (blockClick)="closePreview(); goToBlock($event)"
        />
      }
    </z-sheet>
    <of-module-picker-dialog
      [request]="pickRequest()?.request ?? null"
      (done)="picked($event)"
    />
    <of-term-picker-dialog
      [request]="termRequest()?.request ?? null"
      (done)="termPicked($event)"
    />
    <of-variant-picker-dialog
      [request]="variantRequest()?.request ?? null"
      (done)="variantPicked($event)"
    />
    <of-save-snippet-dialog />
    <of-insert-image-dialog
      [changeSetId]="editingChangeSet()"
      [lang]="lang()"
    />
    <of-attach-file-dialog [changeSetId]="editingChangeSet()" [lang]="lang()" />
    <of-deprecate-dialog
      [target]="deprecateTarget()"
      (confirm)="deprecate($event)"
      (closed)="deprecateTarget.set(null)"
    />
    <of-delete-module-dialog
      [target]="deleteTarget()"
      (confirm)="deleteModule($event)"
      (closed)="deleteTarget.set(null)"
    />
    <of-module-locked-dialog
      [open]="lockDialogOpen()"
      [step]="lockStep()"
      [lock]="heldLock()?.lock ?? null"
      [holderName]="heldLock()?.holderName ?? ''"
      [own]="ownLock()"
      [busy]="takingOver()"
      [releasing]="releasing()"
      [error]="takeOverError()"
      (readOnly)="openReadOnly()"
      (back)="backToContent()"
      (startTakeOver)="askTakeOver()"
      (cancelTakeOver)="query.set({ lock: undefined }, { replace: true })"
      (takeOver)="takeOver($event)"
      (openThere)="openThere()"
      (releaseThere)="releaseThere()"
    />
  `,
})
export class ModuleEditorPage {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);
  private readonly permissions = inject(PermissionService);
  protected readonly changeSets = inject(ChangeSetSession);
  private readonly lines = inject(MaintenanceLines);
  private readonly toast = inject(ToastService);
  private readonly dialogs = inject(ZardAlertDialogService);
  private readonly language = inject(LanguageService);
  private readonly t = injectTranslate();
  private readonly injector = inject(Injector);
  protected readonly draft = inject(ModuleDraft);
  private readonly deletion = inject(ModuleDeletion);
  private readonly translation = inject(ModuleTranslation);
  private readonly renames = inject(ModuleRename);
  private readonly restorer = inject(VersionRestore);
  private readonly updates = inject(ChangeSetUpdate);
  private readonly draftBlocked = injectDraftBlocked();
  private readonly changeSetUrl = inject(ChangeSetUrl);

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly params = toSignal(
    this.route.paramMap.pipe(
      map((p) => ({
        lang: p.get('lang') ?? '',
        moduleId: p.get('moduleId') ?? '',
      })),
    ),
    { initialValue: { lang: '', moduleId: '' } },
  );
  protected readonly lang = computed(() => this.params().lang);
  protected readonly moduleId = computed(() => this.params().moduleId);
  /** Wide enough for the preview beside the document (Tailwind's `lg`); else it is a sheet. */
  protected readonly wide = signal(
    typeof matchMedia === 'function' ? matchMedia(WIDE).matches : true,
  );
  /**
   * The panel beside the document (a sheet on a phone): the live preview (`?preview=open`) or
   * the source language, read-only, while translating (`?preview=source`).
   */
  protected readonly panel = computed(() => {
    const asked = this.query.get('preview')();
    // The source asked for where there is none to show (the source language itself): the preview.
    return asked === 'source' &&
      this.view().kind === 'ready' &&
      !this.sourceLang()
      ? 'open'
      : asked;
  });
  protected readonly previewOpen = computed(() => this.panel() !== undefined);

  protected readonly view = signal<View>({ kind: 'loading' });
  /** Another module (or the same again) is being read while the last one stays on screen. */
  protected readonly refreshing = signal(false);
  /** The configuration as read (`GET /config`). */
  private readonly storedConfig = signal<StoredConfig | null>(null);
  /** The configuration with its labels in the interface language (#731). */
  protected readonly config = labelsInUi(this.storedConfig);
  /** The editor's document as last handed on (or as loaded). */
  private readonly doc = signal<JSONContent | null>(null);
  protected readonly usedIn = signal<readonly UsedInRow[] | null>(null);
  protected readonly usedInFailed = signal(false);
  private readonly now = signal(new Date());
  private runs = 0;
  private keys = 0;

  protected readonly editor = viewChild(BlockEditorComponent);
  /**
   * `?block=<id>`: the block to put the caret in once the module is open (a check's link).
   * `?preview=open` with `?previewLang=` and `?previewVariant=`: the live preview (#237).
   * `?replace=image` with `?block=`: the image dialog opens on that image block once the module
   * can be edited (the media library's "Replace in <language>"), once.
   * `?rename=open`: the Details card's "Change ID" panel is open (#265).
   */
  protected readonly query = injectQueryState({
    block: idParam(BLOCK_ID),
    replace: oneOfParam(['image'] as const),
    preview: oneOfParam(['open', 'source'] as const),
    rename: oneOfParam(['open'] as const),
    /**
     * Screen 12, while someone else holds the lock: the dialog opens by itself (left out),
     * `read` once the person chose to read it, `takeOver` while they write why they take it over.
     */
    lock: oneOfParam(['read', 'takeOver'] as const),
    previewLang: idParam(/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,3}$/),
    previewVariant: idParam(/^[A-Za-z0-9._~=,:+-]{1,400}$/),
    /**
     * The side panel's tab: the details (left out), the history (#88) or, while the module is
     * edited, the suggestions (#247, #573).
     */
    side: oneOfParam(['history', 'suggestions'] as const),
    historyPage: intParam(1, { min: 1 }),
  });
  protected readonly side = computed(
    (): 'details' | 'history' | 'suggestions' => {
      const side = this.query.get('side')() ?? 'details';
      // Suggestions are made and applied only while the module is edited.
      return side === 'suggestions' && !this.editingChangeSet()
        ? 'details'
        : side;
    },
  );
  protected readonly sideOptions = computed(() => [
    { value: 'details', label: this.t('editor.moduleEditor.side.details') },
    ...(this.editingChangeSet()
      ? [
          {
            value: 'suggestions',
            label: this.t('editor.moduleEditor.side.suggestions'),
          },
        ]
      : []),
    { value: 'history', label: this.t('editor.moduleEditor.side.history') },
  ]);
  protected chooseSide(value: string): void {
    this.query.set({
      side: value === 'history' || value === 'suggestions' ? value : undefined,
      historyPage: 1,
    });
  }

  /** The style review's suggestions for the module edited (#573), kept while it stays open. */
  protected readonly styleReview = inject(StyleReview);
  private readonly styleSubject = computed(() => {
    const changeSetId = this.editingChangeSet();
    return changeSetId
      ? { changeSetId, lang: this.lang(), moduleId: this.moduleId() }
      : null;
  });
  /** Why "Review style" cannot run now: the text cannot be saved as it is. */
  protected readonly styleReviewBlocked = computed(() => {
    const state = this.draft.state();
    return state === 'conflict' || state === 'failed' || state === 'incomplete'
      ? 'editor.suggestions.unsavedBlocked'
      : null;
  });

  protected reviewStyle(): void {
    const subject = this.styleSubject();
    const editor = this.editor();
    if (!subject || !editor || this.styleReviewBlocked()) return;
    void this.styleReview.review(
      subject,
      () => this.draft.flush(),
      editor,
      () => this.unsavedReason(),
    );
  }

  protected applySuggestion(item: SuggestionItem): void {
    const editor = this.editor();
    if (!editor || !this.editingChangeSet()) return;
    if (item.kind === 'writing') {
      if (!editor.replaceFinding(item.id))
        this.toast.error(translated('editor.suggestions.changed'));
      return;
    }
    this.styleReview.apply(item, editor);
  }

  protected showSuggestion(item: SuggestionItem): void {
    const editor = this.editor();
    if (!editor) return;
    if (item.kind === 'writing') editor.showFinding(item.id);
    else this.styleReview.show(item, editor);
  }

  protected dismissSuggestion(item: SuggestionItem): void {
    if (item.kind === 'writing') this.editor()?.ignoreFinding(item.id);
    else this.styleReview.dismiss(item);
  }

  /** A style suggestion's Apply or Dismiss from its popover in the text. */
  protected markedSuggestion(event: {
    readonly id: string;
    readonly action: 'apply' | 'dismiss';
  }): void {
    const item = this.styleReview.items().find((i) => i.id === event.id);
    if (!item) return;
    if (event.action === 'apply') this.applySuggestion(item);
    else this.styleReview.dismiss(item);
  }

  /** The style review's suggestions marked in the text, where they still fit it (#247). */
  protected readonly styleMarks = computed(() =>
    this.styleReview
      .items()
      .filter((i) => i.expected !== null)
      .map((i) => ({
        id: i.id,
        blockId: i.blockId,
        field: i.field,
        start: i.range.start,
        end: i.range.end,
        expected: i.expected ?? '',
        message: i.message,
        original: i.original,
        replacement: i.replacement,
      })),
  );

  /** The writing checks' findings in the editor, as the block editor last handed them on. */
  protected readonly writingFindings = signal<readonly PlacedFinding[]>([]);
  protected readonly checkItems = computed(() =>
    writingItems(this.writingFindings(), this.t),
  );

  /**
   * The writing aids of the module edited (#247): its language's terms and the configured style
   * rules, compiled into the API's checks. Only while the module is edited; read again for
   * another language, branch head, person or save point.
   */
  private readonly writingAids = resource({
    params: () => {
      const config = this.config();
      if (!config || !this.editingChangeSet()) return undefined;
      return {
        config,
        lang: this.lang(),
        ref: this.readRef.ref(),
        moves: this.readRef.moves(),
        commits: this.draft.commits(),
        user: this.me.me().id,
      };
    },
    loader: ({ params, abortSignal }) =>
      loadWritingAids(this.api, params.config, params.lang, abortSignal),
  });
  /**
   * The aids handed to the editor: the last ones read for this language, kept while they are
   * read again (a save point, a new branch head), so nothing flickers; none for another language.
   */
  private readonly shownAids = linkedSignal<
    LoadedWritingAids | null | undefined,
    LoadedWritingAids | null
  >({
    source: () =>
      this.writingAids.hasValue() ? this.writingAids.value() : undefined,
    computation: (now, previous) =>
      now ??
      (previous?.value && previous.value.rules?.lang === this.lang()
        ? previous.value
        : null),
  });
  /** What the Suggestions tab says of the checks: being read, could not be read, or running. */
  protected readonly writingState = computed(
    (): 'loading' | 'failed' | 'ready' | 'off' => {
      if (this.writingAids.status() === 'error') return 'failed';
      if (!this.writingAids.hasValue()) return 'loading';
      const aids = this.writingAids.value();
      return aids.rules && !aids.rules.empty ? 'ready' : 'off';
    },
  );

  /** The term picker's request and who waits for its answer; null while it is closed. */
  protected readonly termRequest = signal<{
    readonly request: TermPickRequest;
    readonly resolve: (choice: TermChoice | null) => void;
  } | null>(null);

  private readonly pickTerm = (): Promise<TermChoice | null> => {
    this.termPicked(null);
    return new Promise((resolve) =>
      this.termRequest.set({ request: { lang: this.lang() }, resolve }),
    );
  };

  protected termPicked(choice: TermChoice | null): void {
    const open = this.termRequest();
    if (!open) return;
    this.termRequest.set(null);
    open.resolve(choice);
  }
  /** The module, language and block last focused from the address: once each. */
  private focusedFromAddress = '';

  /** Referenced modules (their titles and blocks), looked up once per page. */
  private readonly modules = new Map<
    string,
    Promise<ReferencedModule | null>
  >();
  /** The titles of the referenced modules read so far, for the outline (#793). */
  private readonly refTitles = signal<ReadonlyMap<string, string>>(new Map());
  private readonly readRef = inject(ReadRef);

  /**
   * The snippets to suggest while writing (#136): only while the module is edited and the
   * configuration has a snippet type; those the person may read, in the document's language, at
   * the chosen change set's branch, read again when any of these changes or the branch gets a new
   * head (an update from its base, #491).
   */
  private readonly snippetList = resource({
    params: () => {
      const config = this.config();
      if (!config || snippetTypes(config).length === 0) return undefined;
      if (!this.editingChangeSet()) return undefined;
      return {
        lang: this.lang(),
        ref: this.readRef.ref(),
        moves: this.readRef.moves(),
        user: this.me.me().id,
      };
    },
    loader: ({ params }) => loadSnippets(this.api, params.lang),
  });

  /** The snippets suggested: none while they load or could not be read, never this module. */
  private readonly snippets = computed(() => {
    const list = this.snippetList.hasValue() ? this.snippetList.value() : [];
    const self = this.moduleId();
    return list.filter((s) => s.id !== self);
  });

  /** Title lookups under way, and those waiting for one to end (at most `TITLE_LOOKUPS` at once). */
  private titleLookups = 0;
  private readonly titleQueue: (() => void)[] = [];

  /**
   * What the documentation blocks need: the configuration, the module's language, the titles of
   * referenced modules, opening one, the module picker (screen 9) and the variant picker
   * (screen 8).
   */
  protected readonly blockSettings = computed((): DocBlockSettings => ({
    config: this.config(),
    lang: this.lang(),
    moduleTitle: this.moduleTitle,
    moduleContent: this.moduleContent,
    openModule: this.openModule,
    imageSource: this.imageSource,
    symbolSource: this.symbolSource,
    // Images are chosen (and uploaded) only into the draft change set the module is edited in.
    ...(this.editingChangeSet() ? { pickImage: this.pickImage } : {}),
    downloadAttachment: this.downloadAttachment,
    // Files are attached (and uploaded) only into the draft change set the module is edited in.
    ...(this.editingChangeSet() ? { pickAttachment: this.pickAttachment } : {}),
    ...(this.config() && { pickModule: this.pickModule }),
    pickVariant: this.pickVariant,
    // Image callouts are numbered as in the variant the live preview shows (#547).
    variant: this.previewOpen() ? this.shownVariant() : null,
    snippets: this.snippets(),
    // The writing aids and the term picker only while the module is edited (#247). The aids
    // read before stay while they are read again (a save point), so nothing flickers.
    ...(this.editingChangeSet()
      ? {
          writing: this.shownAids(),
          pickTerm: this.pickTerm,
        }
      : {}),
    // A contributor's focused editor holds no module references (#137).
    ...(this.config() && !this.focused()
      ? { saveSnippet: this.snippetSaver() }
      : {}),
  }));

  /** The variant the live preview shows; null while it shows none. */
  protected readonly shownVariant = signal<{
    readonly values: Readonly<Record<string, string>>;
    readonly label: string;
  } | null>(null);

  private readonly creation = inject(ModuleCreation);
  private readonly snippetDialog = viewChild(SaveSnippetDialogComponent);

  /** "Save as snippet" (#309): refused without a snippet type or a draft revision. */
  private readonly snippetSaver = computed((): SnippetSaver => ({
    blocked: !snippetTypes(this.config() ?? { moduleTypes: [] }).length
      ? 'editor.moduleEditor.saveSnippet.noType'
      : this.editingChangeSet() === null
        ? 'editor.moduleEditor.saveSnippet.needsDraft'
        : null,
    save: this.saveSnippet,
  }));

  /**
   * Asks for the snippet's title, type and ID, then creates it in the revision the module is
   * edited in, with the selected blocks, the module's language, facets and audience (so a scoped
   * editor may make it); once it is there (now or by the failure toast's Retry) the reference
   * takes the blocks' place. Cancelled, or the page moved on meanwhile: nothing happens.
   */
  private readonly saveSnippet = async (
    request: SnippetSaveRequest,
  ): Promise<void> => {
    const config = this.config();
    const dialog = this.snippetDialog();
    const changeSetId = this.editingChangeSet();
    const moduleId = this.moduleId();
    const lang = this.lang();
    if (!config || !dialog || changeSetId === null) return;
    const details = await dialog.open({
      types: config.moduleTypes.filter((t) => t.snippet),
      moduleId,
    });
    const editor = this.editor()?.editor;
    if (!details) {
      if (editor && !editor.isDestroyed) editor.commands.focus();
      return;
    }
    const branch = this.changeSets.selected()?.branch;
    if (
      this.editingChangeSet() !== changeSetId ||
      this.moduleId() !== moduleId ||
      this.lang() !== lang ||
      !branch
    )
      return;
    const meta = this.meta();
    const title = details.title;
    void this.creation.create(
      {
        id: details.id,
        title,
        lang,
        type: details.type,
        audience: meta?.audience,
        facets: meta?.facets ?? {},
        blocks: request.blocks,
      },
      { id: changeSetId, branch },
      {
        // The toast says what became of the blocks, once that is known (below).
        doneText: null,
        // A taken ID or a refusal (scope): nothing to retry, the blocks stay as they are.
        onRefused: () => undefined,
        onCreated: () => {
          // Only into the same module and revision it was saved from: the snippet is in that
          // revision, and a reference elsewhere would name a module that is not there.
          const same =
            this.editingChangeSet() === changeSetId &&
            this.moduleId() === moduleId &&
            this.lang() === lang;
          const placed = same ? request.place(details.id) : 'gone';
          if (placed === 'placed') {
            this.toast.success(
              translated('editor.moduleEditor.saveSnippet.done', { title }),
            );
          } else {
            this.toast.show(
              translated(
                placed === 'changed'
                  ? 'editor.moduleEditor.saveSnippet.notPlaced'
                  : 'editor.moduleEditor.saveSnippet.savedOnly',
                { title },
              ),
            );
          }
        },
      },
    );
  };

  /** The variant picker's request and who waits for its answer; null while it is closed. */
  protected readonly variantRequest = signal<{
    readonly request: VariantPickRequest;
    readonly resolve: (pick: VariantPick | null) => void;
  } | null>(null);

  /** Opens the variant picker for a variant block; a picker still open is cancelled first. */
  private readonly pickVariant = (
    current: Condition | null,
  ): Promise<VariantPick | null> => {
    this.variantPicked(null);
    return new Promise((resolve) =>
      this.variantRequest.set({
        request: { current, moduleTitle: this.title() || this.moduleId() },
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

  /** The module picker's request and who waits for its answer; null while it is closed. */
  protected readonly pickRequest = signal<{
    readonly request: ModulePickRequest;
    readonly resolve: (pick: ModulePick | null) => void;
  } | null>(null);

  /** Opens the module picker for this module; a picker still open is cancelled first. */
  private readonly pickModule = (
    _current: string | null,
    options?: ModulePickOptions,
  ): Promise<ModulePick | null> => {
    const config = this.config();
    if (!config) return Promise.resolve(null);
    this.picked(null);
    return new Promise((resolve) =>
      this.pickRequest.set({
        request: {
          moduleId: this.moduleId(),
          lang: this.lang(),
          facets: this.meta()?.facets ?? {},
          config,
          ...(options?.linkOnly ? { linkOnly: true } : {}),
          ...(options?.snippet ? { snippet: true } : {}),
        },
        resolve,
      }),
    );
  };

  protected picked(pick: ModulePick | null): void {
    const open = this.pickRequest();
    if (!open) return;
    this.pickRequest.set(null);
    open.resolve(pick);
  }

  private readonly images = inject(ImageSources);
  private readonly imageDialog = viewChild(InsertImageDialogComponent);

  /** The change set the module is edited in: null while it is read-only. */
  protected readonly editingChangeSet = computed(() => {
    const v = this.view();
    return v.kind === 'ready' && !v.loaded.readOnly
      ? (v.loaded.subject?.changeSetId ?? null)
      : null;
  });

  /** An image to show: at the change set's branch, else as a fresh upload into it. */
  private readonly imageSource = (asset: string): Promise<string | null> =>
    this.images.source(asset, this.changeSets.startedId());

  private readonly symbolSources = inject(SymbolSources);
  /** A safety symbol's artwork, at the change set's branch (#208). */
  private readonly symbolSource = (id: string): Promise<string | null> =>
    this.symbolSources.source(id);

  private readonly files = inject(AttachmentFiles);
  private readonly attachDialog = viewChild(AttachFileDialogComponent);

  /** Saves an attached file: at the change set's branch, else as a fresh upload into it. */
  private readonly downloadAttachment = (
    asset: string,
    fileName: string,
  ): Promise<boolean> =>
    this.files.save(asset, fileName, this.changeSets.startedId());

  /** A file chosen in a dialog was uploaded into the change set: no longer refused there. */
  private readonly chosen = <T extends { readonly asset: string }>(
    choice: T | null,
  ): T | null => {
    if (choice) this.draft.accepted(choice.asset);
    return choice;
  };

  private readonly pickAttachment = (
    current: AttachmentChoice | null,
  ): Promise<AttachmentChoice | null> =>
    (this.attachDialog()?.open(current) ?? Promise.resolve(null)).then(
      this.chosen,
    );

  private readonly pickImage = (
    current: ImageChoice | null,
    file?: File,
  ): Promise<ImageChoice | null> =>
    (this.imageDialog()?.open(current, file) ?? Promise.resolve(null)).then(
      this.chosen,
    );

  private readonly moduleTitle = (id: string): Promise<string | null> =>
    this.moduleContent(id).then((found) => found?.title ?? null);

  private readonly moduleContent = (
    id: string,
  ): Promise<ReferencedModule | null> => {
    let found = this.modules.get(id);
    if (!found) {
      // A module with many references asks a few at a time, never all at once.
      const turn = new Promise<void>((resolve) => {
        if (this.titleLookups < TITLE_LOOKUPS) {
          this.titleLookups += 1;
          resolve();
        } else this.titleQueue.push(resolve);
      });
      const done = () => {
        const next = this.titleQueue.shift();
        if (next) next();
        else this.titleLookups -= 1;
      };
      // Without the configuration the source language is not known yet: "not found" then may
      // be wrong, and is not kept.
      const sure = !!this.config();
      found = turn.then(() => this.readModule(id)).finally(done);
      // A failed lookup is tried again next time (Retry).
      found.then(
        (title) => {
          if (title === null && !sure) this.modules.delete(id);
          // The outline follows what the card says: the title, or none once it is not found;
          // never an answer a newer lookup (after the branch moved) has replaced.
          const known = this.refTitles().get(id);
          if (this.modules.get(id) !== found && this.modules.has(id)) return;
          if (title ? known !== title.title : known !== undefined)
            this.refTitles.update((titles) => {
              const next = new Map(titles);
              if (title) next.set(id, title.title);
              else next.delete(id);
              return next;
            });
        },
        () => this.modules.delete(id),
      );
      this.modules.set(id, found);
    }
    return found;
  };

  /**
   * A module's title, read exactly: in the module's language, else in the source language; null
   * when it is in neither (or the person may not see it).
   */
  private async readModule(id: string): Promise<ReferencedModule | null> {
    const languages = [
      ...new Set([this.lang(), this.config()?.languages.source ?? this.lang()]),
    ];
    for (const lang of languages) {
      const found = await firstValueFrom(
        this.api.get('/modules/{lang}/{id}', { path: { lang, id } }),
      ).catch((error: unknown) => {
        // Not there, or not for this person: both read as "not found or not visible".
        if ([403, 404].includes(toApiError(error).status)) return null;
        throw error;
      });
      if (found)
        return {
          title: found.data.attributes.title,
          type: found.data.attributes.moduleType,
          blocks: found.data.attributes.blocks as readonly Block[],
        };
    }
    return null;
  }

  private readonly openModule = (id: string, block?: string): void => {
    void this.router.navigate(['/content', this.lang(), id], {
      // This page's own `?block=` never goes along to the other module (#223).
      queryParams: { block: block ?? null },
      queryParamsHandling: 'merge' as const,
    });
  };

  protected readonly meta = computed((): ModuleMeta | null => {
    const doc = this.doc();
    return doc ? metaOf(doc) : null;
  });
  protected readonly title = computed(() => this.meta()?.title ?? '');
  protected readonly outline = computed(() => {
    const doc = this.doc();
    const titles = this.refTitles();
    return doc ? outlineOf(doc, (id) => titles.get(id)) : [];
  });
  protected readonly variants = computed(() => {
    const doc = this.doc();
    return doc ? variantsOf(doc) : [];
  });

  /** The server's issues and the editor's own problem, as people read them. */
  protected readonly problems = computed((): OutlineProblem[] => {
    const issues =
      this.view().kind === 'ready' ? this.draftOrLoadedIssues() : [];
    const out: OutlineProblem[] = issues.map((issue) => ({
      at: issue.at ?? null,
      severity: issue.severity,
      text: this.t(
        ISSUE_TEXTS[issue.code] ??
          (issue.severity === 'error'
            ? 'editor.moduleEditor.issues.otherError'
            : 'editor.moduleEditor.issues.otherWarning'),
        { code: issue.code },
      ),
    }));
    // A file the server refused, at the block naming it.
    for (const file of [...this.draft.refused()].reverse()) {
      out.unshift({
        at: file.blockId,
        severity: 'error',
        text: this.t(
          file.kind === 'image'
            ? 'editor.moduleEditor.problems.unknownImage'
            : 'editor.moduleEditor.problems.unknownAttachment',
        ),
      });
    }
    const problem = this.draft.problem();
    if (problem) {
      // A block not finished yet (no text, a variant block without its variants) is a normal
      // step of writing: shown calmly, as the save status's draft (#793, #796). Red is for
      // what is really wrong.
      const unfinishedVariant =
        problem.kind === 'incomplete' &&
        problem.blockId !== null &&
        typeOfBlock(this.doc(), problem.blockId) === 'variant';
      out.unshift({
        at: problem.blockId,
        severity: problem.kind === 'incomplete' ? 'draft' : 'error',
        text: unfinishedVariant
          ? this.t('editor.moduleEditor.problems.incompleteVariant')
          : problem.kind === 'tableTooLarge'
            ? this.t('editor.moduleEditor.problems.tableTooLarge', {
                columns: MAX_TABLE_COLUMNS,
                cells: MAX_TABLE_CELLS,
              })
            : this.t(
                problem.kind === 'tooLarge'
                  ? 'editor.moduleEditor.problems.tooLarge'
                  : problem.blockId
                    ? 'editor.moduleEditor.problems.incompleteBlock'
                    : 'editor.moduleEditor.problems.incompleteModule',
              ),
      });
    }
    return out;
  });

  protected readonly blockIssues = computed((): BlockIssue[] =>
    this.problems()
      .filter((p): p is OutlineProblem & { at: string } => p.at !== null)
      .map((p) => ({ at: p.at, severity: p.severity, text: p.text })),
  );

  private readonly loadedIssues = signal<readonly ContentIssue[]>([]);
  private draftOrLoadedIssues(): readonly ContentIssue[] {
    const v = this.view();
    return v.kind === 'ready' && !v.loaded.readOnly
      ? this.draft.issues()
      : this.loadedIssues();
  }

  protected readonly translations = computed((): TranslationRow[] => {
    const v = this.view();
    const config = this.config();
    if (v.kind !== 'ready' || !config) return [];
    const has = new Set(v.loaded.languages);
    const configured = languagesOf(config);
    const all = [
      ...configured,
      ...v.loaded.languages.filter((l) => !configured.includes(l)),
    ];
    return all.map((lang) => ({
      lang,
      exists: has.has(lang),
      source: lang === config.languages.source,
      current: lang === this.lang(),
    }));
  });

  /** Released until this page saved something into the change set: then a draft. */
  protected readonly status = computed((): ContentStatus => {
    const v = this.view();
    if (v.kind !== 'ready') return 'released';
    return v.loaded.status === 'released' && this.draft.savedAt()
      ? 'draft'
      : v.loaded.status;
  });

  protected readonly saveStatus = computed((): SaveStatus => {
    switch (this.draft.state()) {
      case 'saved':
        return 'saved';
      case 'pending':
      case 'saving':
        return 'saving';
      // A new block not finished yet: a normal step of writing, shown calmly (#793).
      case 'incomplete':
        return 'draft';
      default:
        return 'not-saved';
    }
  });

  protected readonly saveDetail = computed((): string => {
    const state = this.draft.state();
    const kept = this.draft.kept();
    switch (state) {
      case 'saved': {
        const at = this.draft.savedAt();
        return at
          ? relativeTime(
              at,
              new Date(Math.max(at.getTime(), this.now().getTime())),
              this.language.locale(),
            )
          : '';
      }
      case 'pending':
      case 'saving':
        return '';
      case 'incomplete':
        return this.t(
          kept
            ? 'editor.moduleEditor.save.incomplete'
            : 'editor.moduleEditor.save.incompleteNotKept',
        );
      case 'offline':
        return this.t(
          kept
            ? 'editor.moduleEditor.save.offlineDetail'
            : 'editor.moduleEditor.save.notKept',
        );
      case 'conflict':
        return this.t('editor.moduleEditor.save.conflictDetail');
      case 'failed':
        return this.t(
          !kept
            ? 'editor.moduleEditor.save.notKept'
            : this.draft.failedOnFiles()
              ? 'editor.moduleEditor.save.refused.detail'
              : 'editor.moduleEditor.save.failedDetail',
        );
    }
  });

  protected readonly errorText = computed(() => {
    const v = this.view();
    if (v.kind !== 'error') return '';
    const text = apiErrorText(v.error);
    return this.t(text.key, text.params);
  });

  /** Why a delete or translate waits for the draft: it may save on its own, or it needs the person. */
  private unsavedReason(): string {
    const state = this.draft.state();
    return state === 'conflict' || state === 'failed' || state === 'incomplete'
      ? 'editor.moduleActions.unsavedBlocked'
      : 'editor.moduleActions.unsaved';
  }

  /** Whether the person may change content at all: the actions menu and Translate show. */
  protected readonly canEdit = computed(
    () =>
      this.permissions.state({ permission: 'content.edit' }).kind !== 'hidden',
  );

  /** An admin reads the audit log: the menu's "Show in audit log" shows. */
  protected readonly canReadAudit = computed(() =>
    this.me.me().permissions.has(READ_AUDIT_LOG),
  );

  /** The audit log with only this module's events. */
  protected showInAuditLog(): void {
    const { commands, queryParams } = auditLogLink({
      type: 'module',
      id: `${this.lang()}/${this.moduleId()}`,
    });
    void this.router.navigate(commands, { queryParams });
  }

  /**
   * A contributor (#137, `suggestsOnly`): the focused editor (text, lists, links, images and
   * attachments), no change-set picker, the metadata read-only, and each module's suggestion in a
   * change set of its own, the one holding its lock (`suggestionOf`), made by "Suggest a change".
   */
  protected readonly focused = this.permissions.suggestsOnly;

  /**
   * "Suggest a change" on a module open read-only from the published content: a contributor's
   * only way in, and an editor's short cut (a change set named after the module, chosen).
   */
  protected readonly canSuggest = computed(() => {
    const v = this.view();
    if (v.kind !== 'ready' || !this.canEdit()) return false;
    const key = v.loaded.readOnly?.key;
    return (
      key === 'editor.moduleEditor.readOnly.published' ||
      key === 'editor.moduleEditor.readOnly.suggest'
    );
  });
  /** A suggestion's change set is being started. */
  protected readonly suggesting = signal(false);
  /**
   * The suggestion started here: its module (`lang/id`) and, once created, its change set. It
   * holds no lock yet, so while it is the one chosen the load keeps it rather than looking for
   * the lock (`suggestionOf`); a lock it is refused gives it up (`giveUp`).
   */
  private suggestingFor: { key: string; id: string | null } | null = null;
  /** The page is gone: a suggestion finishing now is given up, an Undo leaves its draft alone. */
  private destroyed = false;

  /** The change set being edited, as the session lists it (its title and description). */
  private readonly editingOption = computed(() => {
    const id = this.editingChangeSet();
    return id === null
      ? null
      : (this.changeSets.options().find((o) => o.id === id) ?? null);
  });
  /**
   * "What did you change?": the suggestion's change set's description, kept as typed until
   * another change set is edited (a list read again leaves what is typed alone).
   */
  protected readonly note = linkedSignal<
    { id: string | null; description: string },
    string
  >({
    source: () => ({
      id: this.editingChangeSet(),
      description: this.editingOption()?.description ?? '',
    }),
    // What the person typed stays (a list read again leaves it alone); untouched, it follows
    // the description as it arrives (the list read after a reload).
    computation: (source, previous) =>
      previous &&
      previous.source.id === source.id &&
      this.noteTouchedFor === source.id
        ? previous.value
        : source.description,
  });
  /** The change set whose note the person typed in: only that note is ever kept. */
  private noteTouchedFor: string | null = null;
  /** The suggestion's panel (note and Submit) is beside the module. */
  protected readonly suggestionShown = computed(
    () => this.focused() && this.editingChangeSet() !== null,
  );
  /** The toast of the last refused submit, until the next try. */
  private submitFailure: number | null = null;
  /** Submit was asked without a note. */
  protected readonly noteMissing = signal(false);
  /** The save point and the submit are on their way. */
  protected readonly submitting = signal(false);
  private readonly suggestionPanel = viewChild(SuggestionPanelComponent);
  private readonly failureText = injectFailureText();

  /** Why Submit cannot go now (a translation key), or null. */
  protected readonly submitBlocked = computed((): string | null => {
    const state = this.draft.state();
    return state === 'conflict' || state === 'failed' || state === 'incomplete'
      ? 'editor.suggestion.unsaved'
      : null;
  });

  /**
   * The source language to show beside a translation ("Source"): the configured source
   * language, when the module is in it and another language is open.
   */
  protected readonly sourceLang = computed((): string | null => {
    const v = this.view();
    const source = this.config()?.languages.source;
    if (v.kind !== 'ready' || !source || source === this.lang()) return null;
    return v.loaded.languages.includes(source) ? source : null;
  });

  /**
   * Whether the panel knows what to show: the source is known once the module is there (until
   * then it would show this language for a moment).
   */
  protected readonly panelReady = computed(
    () =>
      this.query.get('preview')() !== 'source' || this.view().kind === 'ready',
  );

  /** The language the panel shows first: the source beside a translation, else this one. */
  protected readonly panelLang = computed(() =>
    this.panel() === 'source'
      ? (this.sourceLang() ?? this.lang())
      : this.lang(),
  );

  protected readonly panelHeading = computed(() => {
    const source = this.sourceLang();
    return this.panel() === 'source' && source
      ? this.t('editor.moduleEditor.source.heading', {
          language: languageName(this.language.locale(), source),
        })
      : '';
  });

  /** Why Delete is blocked now (a translation key), or null. */
  protected readonly deleteBlocked = computed((): string | null => {
    const blocked = this.draftBlocked();
    if (blocked) return blocked;
    const v = this.view();
    if (v.kind !== 'ready') return 'editor.moduleActions.loading';
    if (this.deleting()) return 'editor.moduleActions.deleting';
    switch (v.loaded.readOnly?.key) {
      case undefined:
        return null;
      case 'editor.moduleEditor.readOnly.lockedBy':
      case 'editor.moduleEditor.readOnly.locked':
        return 'editor.moduleActions.locked';
      case 'editor.moduleEditor.readOnly.lockedByYou':
        return 'editor.moduleActions.lockedByYou';
      case 'editor.moduleEditor.readOnly.refused':
        return 'editor.moduleActions.refused';
      default:
        return 'editor.moduleActions.notDraft';
    }
  });

  /**
   * The module's deprecation (#266): in its source language, what the document holds now (so a
   * deprecation made here shows at once); in a translation, the source-language file's as read.
   */
  protected readonly deprecation = computed((): Deprecation | null => {
    const v = this.view();
    if (v.kind !== 'ready') return null;
    const source = this.config()?.languages.source;
    if (source === undefined || this.lang() === source) {
      return this.meta()?.deprecated ?? null;
    }
    return v.loaded.deprecation;
  });

  /** Why Deprecate (or its undoing) is blocked now (a translation key), or null. */
  protected readonly deprecateBlocked = computed((): string | null => {
    const blocked = this.deleteBlocked();
    if (blocked) return blocked;
    const source = this.config()?.languages.source;
    return source !== undefined && this.lang() !== source
      ? 'editor.deprecation.notSource'
      : null;
  });

  /** The deprecate dialog's module; null while it is closed. */
  protected readonly deprecateTarget = signal<DeprecateTarget | null>(null);

  /** Why Translate is blocked now (a translation key), or null. */
  protected readonly translateBlocked = computed(
    (): string | null =>
      this.draftBlocked() ??
      (this.deleting()
        ? 'editor.moduleActions.deleting'
        : this.translating()
          ? 'editor.moduleActions.translating'
          : null),
  );

  /** Why "Change ID" is blocked now (a translation key), or null. */
  protected readonly renameBlocked = computed(
    (): string | null =>
      this.deleteBlocked() ??
      (this.translating() ? 'editor.moduleActions.translating' : null),
  );
  /** The change set a rename goes into: the chosen one, once it has a branch. */
  protected readonly renameChangeSetId = computed(() => {
    const chosen = this.changeSets.selected();
    return chosen?.branch ? chosen.id : null;
  });
  /** The rename panel is open, and may be: blocked, it is closed whatever the address says. */
  protected readonly renameOpen = computed(
    () =>
      this.query.get('rename')() === 'open' &&
      this.renameChangeSetId() !== null &&
      (this.renaming() || this.renameBlocked() === null),
  );
  /** A rename of this module is under way. */
  protected readonly renaming = signal(false);

  /** The language a version is being started in. */
  protected readonly translating = signal<string | null>(null);
  /** A delete of this module is under way. */
  private readonly deleting = signal(false);
  /** The delete dialog's module; null while it is closed. */
  protected readonly deleteTarget = signal<DeleteTarget | null>(null);

  private readonly nameOf = injectPersonName();
  /** The lock another change set holds on the module shown (screen 12); null when none does. */
  protected readonly heldLock = computed(() => {
    const v = this.view();
    const readOnly = v.kind === 'ready' ? v.loaded.readOnly : null;
    return readOnly?.lock
      ? {
          lock: readOnly.lock,
          holderName: readOnly.holderName ?? '',
          lost: !!readOnly.lost,
        }
      : null;
  });
  /** The lock is the reader's own, held by another of their change sets (#472). */
  protected readonly ownLock = computed(() => {
    const held = this.heldLock();
    return !!held && isOwnLock(held.lock, this.me.me());
  });
  /** "Release it there" is under way. */
  protected readonly releasing = signal(false);
  /** Taking over is offered: `admin.roles` (#76, the open UI questions' answer). */
  private readonly mayTakeOver = computed(
    () =>
      this.permissions.state({ permission: 'admin.roles' }).kind !== 'hidden',
  );
  protected readonly lockStep = computed(() =>
    this.query.get('lock')() === 'takeOver' && this.mayTakeOver()
      ? ('takeOver' as const)
      : ('ask' as const),
  );
  /**
   * The dialog opens by itself on a module someone else holds, until the person chose to read
   * it; on a lock lost while editing only when they ask to take it over again.
   */
  protected readonly lockDialogOpen = computed(() => {
    const held = this.heldLock();
    if (!held) return false;
    if (this.lockStep() === 'takeOver') return true;
    return this.query.get('lock')() === undefined && !held.lost;
  });
  protected readonly takingOver = signal(false);
  /** The module `?lock=` was last read for (null: none loaded yet, the address's own stands). */
  private lockStepFor: string | null = null;
  protected readonly takeOverError = signal('');

  /** What is read and by whom: the module is loaded again when any of it changes. */
  private readonly loadKey = computed(
    () =>
      `${this.lang()}\n${this.moduleId()}\n${this.changeSets.selected()?.id ?? ''}\n${this.changeSets.selected()?.branch ?? ''}\n${this.changeSetState() ?? ''}\n${this.me.me().id}`,
  );

  private readonly changeSetState = computed(() => {
    const id = this.changeSets.selected()?.id;
    return id === undefined
      ? undefined
      : this.changeSets.options().find((o) => o.id === id)?.state;
  });

  constructor() {
    // Another module, language or change set: its suggestions start empty (#573).
    effect(() => {
      const subject = this.styleSubject();
      untracked(() => {
        this.styleReview.reset(subject);
        // Whether the server has a style review at all, asked once the module is edited (#247).
        if (subject) void this.styleReview.checkConfigured();
      });
    });
    // A module created (a snippet saved here, #309): the snippets are read again, the list
    // shown meanwhile.
    effect(() => {
      if (this.creation.created() > 0)
        untracked(() => this.snippetList.reload());
    });
    const destroyRef = inject(DestroyRef);
    // A restore undone (#88) on the module shown: its working copy changed under the editor,
    // which opens it again (nothing was edited since: Undo applies only then).
    let undoneSeen = this.restorer.undone()?.count ?? 0;
    effect(() => {
      const undone = this.restorer.undone();
      if (!undone || undone.count === undoneSeen) return;
      undoneSeen = undone.count;
      untracked(() => {
        if (
          undoneOf(
            undone,
            { type: 'module', lang: this.lang(), moduleId: this.moduleId() },
            this.changeSets.selected()?.id,
          )
        ) {
          this.reload();
        }
      });
    });
    // A new head of the branch read (an update from its base, #491): the module is read again
    // there, unless it has unsaved changes (`headMoved`).
    let movesSeen = this.readRef.moves();
    effect(() => {
      const moves = this.readRef.moves();
      if (moves === movesSeen) return;
      movesSeen = moves;
      untracked(() => this.headMoved());
    });
    // Unsaved changes kept over a new head: once saved, reading the module again is offered.
    // Stopped meanwhile (the lock lost, another load: `stop` says saved too) or in conflict (its
    // own toast offers the reload), the notice goes, since nothing of it holds any more.
    effect(() => {
      const kept = this.movedUnsaved();
      const state = this.draft.state();
      if (kept === null) return;
      untracked(() => {
        if (
          kept.run !== this.runs ||
          !this.draft.isCurrent(kept.draft) ||
          state === 'conflict'
        ) {
          this.forgetMoved();
        } else if (state === 'saved') {
          this.offerReadAgain(kept.run);
        }
      });
    });
    // A link to a block (`?block=`): the caret goes there once the editor holds the module, once
    // per module, language and block, so editing afterwards is never pulled back.
    afterRenderEffect(() => {
      const block = this.query.get('block')();
      const v = this.view();
      const editor = this.editor();
      if (!block || v.kind !== 'ready' || !editor) return;
      // The module, language and block: a reload (a conflict, another change set) of the same
      // module keeps the caret where the person put it.
      const { meta, id } = v.loaded.content;
      const key = `${meta.lang}/${id}/${block}`;
      if (this.focusedFromAddress === key) return;
      if (editor.focusBlock(block)) this.focusedFromAddress = key;
    });
    // "Replace in <language>" (`?replace=image`): the image dialog on the block, once the module
    // is open; the parameter goes, so a reload or Back does not open it again.
    afterRenderEffect(() => {
      const replace = this.query.get('replace')();
      const block = this.query.get('block')();
      const v = this.view();
      const editor = this.editor();
      if (replace !== 'image' || !block || v.kind !== 'ready' || !editor)
        return;
      const editing = !v.loaded.readOnly && !!this.editingChangeSet();
      // Editing: wait until the editor holds the module, is editable and has the picker (they
      // arrive over a few renders); this runs again as they do.
      const state = editing ? editor.replaceImageState(block) : null;
      if (state === 'waiting') return;
      untracked(() => {
        this.query.set({ replace: undefined }, { replace: true });
        if (state === 'ready') void editor.replaceImage(block);
        else
          this.toast.show(
            translated(
              state === 'missing'
                ? 'editor.moduleEditor.replaceMissing'
                : 'editor.moduleEditor.replaceReadOnly',
            ),
          );
      });
    });
    effect(() => {
      this.loadKey();
      // A picker opened for the module shown so far answers nothing for the next.
      untracked(() => {
        this.picked(null);
        this.variantPicked(null);
      });
      if (this.changeSets.switching() || !this.moduleId()) return;
      untracked(() => void this.load());
    });
    const tick = setInterval(() => this.now.set(new Date()), 30_000);
    const media = typeof matchMedia === 'function' ? matchMedia(WIDE) : null;
    const onMedia = () => this.wide.set(media?.matches ?? true);
    media?.addEventListener('change', onMedia);
    destroyRef.onDestroy(() => {
      media?.removeEventListener('change', onMedia);
      clearInterval(tick);
      this.picked(null);
      this.variantPicked(null);
      // A load under way ends here: nothing it read is started any more.
      this.runs++;
      this.dismissToasts();
      // Leaving without the guard (the app closing): what is pending stays in the browser.
      this.draft.stop();
      this.destroyed = true;
      this.dropSuggestion();
      // A contributor's suggestion is chosen only while its module is open: elsewhere they read
      // the published content (they have no picker to go back to it, #137).
      if (this.focused() && this.changeSets.selected()?.branch) {
        this.changeSets.choose(null, 'session');
      }
    });
  }

  /**
   * Loads the module again from the server: the error's Retry, or (`discard`) the person chose
   * the server's version over the text this browser keeps, which goes once the load succeeds.
   */
  protected reload(discard = false): void {
    // An identity switch under way: the page loads again once it ends.
    if (this.changeSets.switching()) return;
    // Loaded anew: a notice about unsaved changes over a new head is over (#491).
    this.forgetMoved();
    this.draft.stop(discard);
    void this.load(discard);
  }

  /**
   * The load whose unsaved changes were kept when the branch got a new head (#491), until they
   * are saved (then reading again is offered) or the module is loaded again; null when none.
   */
  private readonly movedUnsaved = signal<{
    readonly run: number;
    /** The draft they are in (`ModuleDraft.editing()`). */
    readonly draft: number;
  } | null>(null);
  /** The toast saying the branch got a new head under unsaved changes, or offering to read again. */
  private movedToast: number | null = null;

  /**
   * The branch read got a new head (an update from its base, #491). Nothing unsaved here: the
   * module is read again there (the working copy, else the file committed at the new head).
   * Unsaved changes (pending, offline, refused, in conflict, incomplete): never read over. They
   * stay as they are, saved as before (a conflict takes the existing conflict path), and the page
   * says the branch moved; once they are saved, reading the module again is offered.
   */
  private headMoved(): void {
    // The referenced modules' titles and blocks are read again at the new head too.
    this.modules.clear();
    if (!this.moduleId()) return;
    if (!this.draft.dirty()) {
      this.reload();
      return;
    }
    // In conflict already: its toast offers the reload, and says the text stays here.
    if (this.draft.state() === 'conflict') return;
    this.keepOverMove(this.runs);
  }

  /** Says the branch moved under unsaved changes, kept until saved (`movedUnsaved`). */
  private keepOverMove(run: number): void {
    this.movedUnsaved.set({ run, draft: this.draft.editing() });
    this.showMovedToast(
      this.toast.show(
        translated('editor.moduleEditor.headMoved.unsaved', {
          ref: this.movedFrom(),
        }),
        { kind: 'warning', duration: 0 },
      ),
    );
  }

  /** The changes kept over the new head are saved: reading the module again is offered. */
  private offerReadAgain(run: number): void {
    this.movedUnsaved.set(null);
    // Loaded again meanwhile: read at the new head already.
    if (run !== this.runs) return;
    this.showMovedToast(
      this.toast.show(
        translated('editor.moduleEditor.headMoved.saved', {
          ref: this.movedFrom(),
        }),
        {
          kind: 'info',
          duration: 0,
          actionLabel: translated('editor.moduleEditor.save.reload'),
          onAction: this.forRun(run, () => void this.readAgainSaved(run)),
        },
      ),
    );
  }

  /**
   * "Reload" once the kept changes were saved: what was typed since is saved first; when it
   * cannot be, nothing is read over it, and the offer comes back once it is saved.
   */
  private async readAgainSaved(run: number): Promise<void> {
    this.movedToast = null;
    const saved = await this.draft.flush();
    if (run !== this.runs) return;
    if (saved) {
      this.reload();
      return;
    }
    this.keepOverMove(run);
  }

  /** The notice about a new head under unsaved changes is over. */
  private forgetMoved(): void {
    this.movedUnsaved.set(null);
    if (this.movedToast !== null) this.toast.dismiss(this.movedToast);
    this.movedToast = null;
  }

  private showMovedToast(id: number): void {
    if (this.movedToast !== null) this.toast.dismiss(this.movedToast);
    this.movedToast = id;
    // It goes with the module it is about (`dismissToasts` on the next load).
    this.toasts.push(id);
  }

  /** The branch the change set was updated from, as the update said (its base, `main` unsaid). */
  private movedFrom(): string {
    const id = this.changeSets.selected()?.id;
    // A maintenance line by its product version, never its branch (#250).
    return this.lines.label((id && this.updates.baseRef(id)) || 'main');
  }

  /** Opens or closes the live preview; the address keeps it. */
  protected togglePreview(): void {
    this.query.set({ preview: this.panel() === 'open' ? undefined : 'open' });
  }

  /** Shows or hides the source language beside the translation. */
  protected toggleSource(): void {
    this.query.set({
      preview: this.panel() === 'source' ? undefined : 'source',
    });
  }

  protected closePreview(): void {
    if (this.previewOpen()) this.query.set({ preview: undefined });
  }

  /** A block clicked in the preview: the editor goes there (one of this module's own blocks). */
  protected goToBlock(id: string): void {
    if (BLOCK_ID.test(id)) this.editor()?.focusBlock(id);
  }

  /** Opens the deprecate dialog for this module. */
  protected askDeprecate(): void {
    if (this.view().kind !== 'ready' || this.deprecateBlocked()) return;
    this.deprecateTarget.set({
      kind: 'module',
      id: this.moduleId(),
      title: this.title() || this.moduleId(),
    });
  }

  /**
   * Deprecates the module (#266): the deprecation goes into the document's metadata, so it is
   * saved into the revision and undone with the text; the toast's Undo takes it back.
   */
  protected deprecate(deprecated: Deprecation): void {
    this.deprecateTarget.set(null);
    if (this.deprecateBlocked()) return;
    this.setDeprecation(deprecated, 'editor.deprecation.done');
  }

  /** "Undo deprecation" on a deprecated module, in the same way. */
  protected undoDeprecation(): void {
    if (this.deprecateBlocked()) return;
    this.setDeprecation(undefined, 'editor.deprecation.undone');
  }

  private setDeprecation(
    deprecated: Deprecation | undefined,
    message: string,
  ): void {
    const before = this.meta()?.deprecated;
    this.changeMeta({ deprecated });
    const key = `${this.lang()}/${this.moduleId()}`;
    this.toasts.push(
      this.toast.success(translated(message), {
        actionLabel: translated('ui.toast.undo'),
        onAction: () => {
          // Only on the module it was made on.
          if (`${this.lang()}/${this.moduleId()}` === key) {
            this.changeMeta({ deprecated: before });
          }
        },
      }),
    );
  }

  /** Opens the delete dialog for this module. */
  protected askDelete(): void {
    const v = this.view();
    const config = this.config();
    const chosen = this.changeSets.selected();
    if (v.kind !== 'ready' || !config || !chosen || this.deleteBlocked()) {
      return;
    }
    this.deleteTarget.set({
      moduleId: this.moduleId(),
      title: this.title() || this.moduleId(),
      languages: v.loaded.languages,
      lang: this.lang(),
      source: config.languages.source,
      configured: languagesOf(config),
      changeSetId: chosen.id,
      changeSetTitle: chosen.title,
    });
  }

  /**
   * Deletes what the dialog chose. The text being edited is saved first, so the delete (and its
   * Undo) holds the latest, and nothing is saved into it afterwards. Then the page goes to a
   * language that is left, or back to the content browser; Undo brings the person back.
   */
  protected async deleteModule(request: DeleteRequest): Promise<void> {
    this.deleteTarget.set(null);
    const v = this.view();
    const chosen = this.changeSets.selected();
    if (v.kind !== 'ready' || !chosen || this.deleteBlocked()) return;
    const moduleId = this.moduleId();
    const lang = this.lang();
    const here = request.langs.includes(lang);
    const editing = !v.loaded.readOnly && v.loaded.subject;
    const person = this.me.me().id;
    this.deleting.set(true);
    // What is typed must be on the server first, so the delete (and its Undo) holds it: if it
    // cannot be saved now, nothing is deleted and the text stays where it is.
    if (here && editing && !(await this.draft.flush())) {
      this.deleting.set(false);
      this.toast.error(translated(this.unsavedReason()));
      return;
    }
    if (here) {
      this.refreshing.set(true);
      // Nothing more is saved into the module being deleted.
      this.draft.stop();
    }
    const source = this.config()?.languages.source;
    let away = '';
    const deleted = await this.deletion.delete(
      request,
      chosen.id,
      () => {
        // Undo: back to the module, if the person is still where the delete took them.
        if (here && this.router.url === away) {
          void this.router.navigate(['/content', lang, moduleId], {
            queryParams: this.changeSetUrl.params(),
          });
        } else if (!here && this.moduleId() === moduleId) {
          void this.refreshLanguages();
        }
      },
      person,
    );
    this.deleting.set(false);
    if (!deleted || (here && !deleted.includes(lang))) {
      // Not deleted (or this language stayed): editing goes on where it stopped.
      if (here) this.reload();
      if (deleted) void this.refreshLanguages();
      return;
    }
    if (!here) {
      void this.refreshLanguages();
      return;
    }
    if (editing) clearDraft(person, editing);
    const left = v.loaded.languages.filter((l) => !deleted.includes(l));
    const next = left.includes(source ?? '') ? source : left[0];
    const target = next
      ? this.router.createUrlTree(['/content', next, moduleId], {
          queryParams: this.changeSetUrl.params(),
        })
      : this.router.createUrlTree(['/content'], {
          queryParams: this.changeSetUrl.params(),
        });
    away = this.router.serializeUrl(target);
    await this.router.navigateByUrl(target);
  }

  /**
   * "Change ID" (#265): the text being edited is saved first and nothing more is saved under the
   * old ID; the rename takes the locks, commits the working copies in its way and renames, then
   * the page opens the new address. Undo (the toast's) renames back and opens the old one, if
   * the person is still where the rename took them.
   */
  protected async renameModule(to: string): Promise<void> {
    const v = this.view();
    const chosen = this.changeSets.selected();
    if (v.kind !== 'ready' || !chosen || this.renameBlocked()) return;
    if (this.renaming()) return;
    const from = this.moduleId();
    const lang = this.lang();
    const title = this.title() || from;
    const editing = !v.loaded.readOnly && v.loaded.subject;
    const person = this.me.me().id;
    this.renaming.set(true);
    if (editing && !(await this.draft.flush())) {
      this.renaming.set(false);
      this.toast.error(translated(this.unsavedReason()));
      return;
    }
    this.refreshing.set(true);
    // Nothing more is saved under the old ID.
    this.draft.stop();
    const at = (id: string) =>
      this.router.createUrlTree(['/content', lang, id], {
        queryParams: this.changeSetUrl.params(),
      });
    // Whether module `id` in this language is open now: the router's path decides, never the
    // query (the preview, a block, a panel may change) nor this page's route signals (they keep
    // their last value once the page is gone, while the Undo toast outlives it).
    const pathNow = () =>
      this.router
        .parseUrl(this.router.url)
        .root.children['primary']?.segments.map((segment) => segment.path)
        .join('/');
    const onModule = (id: string) =>
      pathNow() === ['content', lang, id].join('/');
    // The module's history page (#88): after an Undo it shows the old ID's history instead.
    const onHistory = (id: string) =>
      pathNow() === ['content', lang, id, 'history'].join('/');
    let reopen = false;
    const renamed = await this.renames.rename(
      { from, to, title },
      chosen.id,
      {
        // Undo while the renamed module is open here: saved and stopped first, as above.
        beforeUndo: async () => {
          if (!onModule(to)) return true;
          if (this.destroyed) {
            // Another page holds the module now (the person left and came back): leaving it
            // makes its save point and stops it, as its route guard does for any leave.
            reopen = await this.router.navigate(['/content'], {
              queryParams: this.changeSetUrl.params(),
            });
            return reopen;
          }
          const now = this.view();
          const open = now.kind === 'ready' && !now.loaded.readOnly;
          if (open && !(await this.draft.flush())) {
            this.toast.error(translated(this.unsavedReason()));
            return false;
          }
          if (open) this.draft.stop();
          return true;
        },
        undone: () => {
          if (reopen || onModule(to)) {
            void this.router.navigateByUrl(at(from));
          } else if (onHistory(to)) {
            void this.router.navigate(['/content', lang, from, 'history'], {
              queryParams: this.changeSetUrl.params(),
            });
          }
        },
      },
      person,
    );
    this.renaming.set(false);
    if (!renamed) {
      // Not renamed: editing goes on where it stopped.
      this.reload();
      return;
    }
    if (editing) clearDraft(person, editing);
    // Gone elsewhere meanwhile: the rename stands, the page stays where it is.
    if (onModule(from)) await this.router.navigateByUrl(at(to));
  }

  /** The module's languages read again (one of them deleted, or brought back). */
  private async refreshLanguages(): Promise<void> {
    const moduleId = this.moduleId();
    const lang = this.lang();
    const langs = await this.languagesOf(moduleId, lang);
    const v = this.view();
    if (v.kind !== 'ready' || this.moduleId() !== moduleId) return;
    this.view.set({ kind: 'ready', loaded: { ...v.loaded, languages: langs } });
  }

  /**
   * "Translate": starts the module's version in `to`, copied from the source language (else the
   * language open now), and opens it with the source beside it.
   */
  protected async translate(to: string): Promise<void> {
    const v = this.view();
    const config = this.config();
    const chosen = this.changeSets.selected();
    if (
      v.kind !== 'ready' ||
      !config ||
      !chosen ||
      this.translateBlocked() ||
      this.translating()
    ) {
      return;
    }
    const moduleId = this.moduleId();
    const source = config.languages.source;
    const from = v.loaded.languages.includes(source) ? source : this.lang();
    const person = this.me.me().id;
    this.translating.set(to);
    try {
      // What is typed but not saved yet goes into the copy too.
      if (
        !v.loaded.readOnly &&
        from === this.lang() &&
        !(await this.draft.flush())
      ) {
        this.toast.error(translated(this.unsavedReason()));
        return;
      }
      const started = await this.translation.start(
        { moduleId, from, to, title: this.title() || moduleId },
        chosen.id,
        person,
      );
      if (started && this.moduleId() === moduleId) {
        await this.router.navigate(['/content', to, moduleId], {
          queryParams: {
            preview: 'source',
            previewLang: undefined,
            block: undefined,
          },
          queryParamsHandling: 'merge',
        });
      }
    } finally {
      this.translating.set(null);
    }
  }

  /** The page's own toasts (a restored draft): they go with the module they were about. */
  private toasts: number[] = [];

  private dismissToasts(): void {
    for (const id of this.toasts.splice(0)) this.toast.dismiss(id);
  }

  /** A toast action for this load only: after another, it does nothing. */
  private forRun(run: number, action: () => void): () => void {
    return () => {
      if (run === this.runs) action();
    };
  }

  protected edited(doc: JSONContent): void {
    this.doc.set(doc);
    const v = this.view();
    if (v.kind === 'ready' && !v.loaded.readOnly) this.draft.edit(doc);
  }

  /** A change of the metadata goes into the document: saved and undone with the text. */
  protected changeMeta(patch: Partial<ModuleMeta>): void {
    const editor = this.editor()?.editor;
    const meta = this.meta();
    if (!editor || !meta) return;
    const next = patchMeta(meta, patch);
    editor.view.dispatch(editor.state.tr.setDocAttribute('meta', next));
  }

  /**
   * Leaving the module (the route guard): a save point first. When the text could not be saved,
   * the person chooses: it stays in this browser either way.
   */
  async leave(): Promise<boolean> {
    const v = this.view();
    if (v.kind !== 'ready' || v.loaded.readOnly) return true;
    await this.draft.savePoint();
    if (!this.draft.dirty()) return true;
    return new Promise<boolean>((resolve) => {
      let answered = false;
      const answer = (leave: boolean) => {
        if (answered) return;
        answered = true;
        resolve(leave);
      };
      const ref = this.dialogs.confirm({
        zTitle: this.t('editor.moduleEditor.leave.title'),
        zDescription: this.t(
          this.draft.kept()
            ? 'editor.moduleEditor.leave.kept'
            : 'editor.moduleEditor.leave.lost',
        ),
        zOkText: this.t('editor.moduleEditor.leave.leave'),
        zCancelText: this.t('editor.moduleEditor.leave.stay'),
        zOkDestructive: !this.draft.kept(),
        zOnOk: () => answer(true),
        zOnCancel: () => answer(false),
      });
      // Closed another way (Escape): the person stays.
      const closing = effect(
        () => {
          if (ref.isClosing()) {
            closing.destroy();
            queueMicrotask(() => answer(false));
          }
        },
        { injector: this.injector },
      );
    });
  }

  protected beforeUnload(event: BeforeUnloadEvent): void {
    if (!this.draft.dirty()) return;
    void this.draft.flush();
    event.preventDefault();
    // Older browsers show the warning only for a return value.
    event.returnValue = '';
  }

  /** The tab is hidden (switched, closed on a phone): save what is pending now. */
  protected hidden(): void {
    if (document.visibilityState === 'hidden') void this.draft.flush();
  }

  private async load(discard = false): Promise<void> {
    // An identity switch under way: the effect loads again once it ends.
    if (this.changeSets.switching()) return;
    // A change set being started (no branch yet): what is shown stays until it is there, and the
    // page loads again in it (a suggestion's, #137, never flashes "in review" meanwhile).
    const pending = this.changeSets.selected();
    if (pending && pending.branch === null) return;
    const run = ++this.runs;
    const { lang, moduleId } = this.params();
    // `?lock=` is about the module it was chosen on: another one (a language, a reference)
    // starts without it.
    const shown = `${lang}/${moduleId}`;
    if (this.lockStepFor !== null && this.lockStepFor !== shown) {
      if (this.query.get('lock')() !== undefined) {
        this.query.set({ lock: undefined }, { replace: true });
      }
    }
    this.lockStepFor = shown;
    // A suggestion started for another module whose own load never took its lock: nothing is
    // in it (its first load is the only one that may give it up).
    if (
      this.suggestingFor &&
      this.suggestingFor.key !== `${lang}/${moduleId}`
    ) {
      this.dropSuggestion();
    }
    const previous = this.view();
    this.dismissToasts();
    // Read again: what a new head of the branch kept unsaved is read with it now (#491).
    this.movedUnsaved.set(null);
    this.movedToast = null;
    // Another module (a language switch reuses the page): the last one gets its save point.
    if (previous.kind === 'ready' && !previous.loaded.readOnly) {
      await this.draft.savePoint(true);
    }
    this.draft.stop();
    if (run !== this.runs) return;
    // Shown content stays, dimmed and inert, until the new one is there: never a skeleton again.
    if (previous.kind === 'ready') {
      this.refreshing.set(true);
    } else {
      this.view.set({ kind: 'loading' });
    }
    try {
      // `.` and `..` would leave the API path they go into.
      if ([lang, moduleId].some((p) => p === '.' || p === '..')) {
        throw new ApiError('not-found', 404, 'not-found', 'Not found.');
      }
      const config =
        this.storedConfig() ??
        (await firstValueFrom(this.api.get('/config'))).data.attributes;
      this.storedConfig.set(config);
      const focused = this.focused();
      if (focused && !(await this.followSuggestion(run, lang, moduleId))) {
        return;
      }
      const chosen = this.changeSets.selected();
      const state = this.changeSetState();
      const canEdit =
        this.permissions.state({ permission: 'content.edit' }).kind !==
        'hidden';
      const draftSet =
        chosen?.branch && (state === undefined || state === 'draft')
          ? { id: chosen.id }
          : null;

      const read = firstValueFrom(
        this.api.get('/modules/{lang}/{id}', { path: { lang, id: moduleId } }),
      ).catch((error: unknown) => {
        if (toApiError(error).status === 404) return null;
        throw error;
      });
      const languages = this.languagesOf(moduleId, lang);

      let loaded: Omit<Loaded, 'key' | 'doc' | 'languages'> & {
        copy?: SavedCopy;
        issues: readonly ContentIssue[];
      };
      const module = await read;
      if (canEdit && draftSet) {
        const subject: DraftSubject = {
          changeSetId: draftSet.id,
          lang,
          moduleId,
        };
        const copy = await firstValueFrom(
          this.api.get(
            '/change-sets/{changeSetId}/modules/{lang}/{moduleId}/working-copy',
            { path: subject },
          ),
        );
        // Overtaken by another load: no lock taken for a module no longer shown.
        if (run !== this.runs) return;
        const lock = await this.takeLock(subject);
        if (run !== this.runs) return;
        const changed =
          copy.data.meta.saved ||
          !!module?.data.meta.status.changeSets?.some(
            (c) => c.id === draftSet.id,
          );
        const fresh = this.suggestingFor;
        const startedHere =
          fresh?.id === draftSet.id && fresh.key === `${lang}/${moduleId}`;
        // A suggestion just started for this module, refused its lock with nothing in it yet:
        // given up, not left empty. Once the lock is taken, it is an ordinary change set.
        if (lock && startedHere && !changed) {
          void this.giveUp(draftSet.id, lock);
          return;
        }
        if (!lock && startedHere) this.suggestingFor = null;
        loaded = {
          subject,
          content: copy.data.attributes.content,
          readOnly: lock,
          lockedByMe: lock === null,
          status: statusOf(changed, state ?? 'draft'),
          deprecation: module?.data.meta.status.deprecated ?? null,
          copy: {
            content: copy.data.attributes.content,
            version: copy.data.attributes.version,
            baseCommit: copy.data.attributes.baseCommit,
          },
          issues: copy.data.meta.issues,
        };
      } else {
        if (!module) {
          throw new ApiError('not-found', 404, 'not-found', 'Not found.');
        }
        const changed = !!(
          chosen &&
          module.data.meta.status.changeSets?.some((c) => c.id === chosen.id)
        );
        loaded = {
          subject: null,
          content: contentOf(module.data.attributes),
          readOnly: !canEdit
            ? { key: 'editor.moduleEditor.readOnly.noEdit' }
            : !chosen
              ? {
                  key: focused
                    ? 'editor.moduleEditor.readOnly.suggest'
                    : 'editor.moduleEditor.readOnly.published',
                }
              : {
                  key: !focused
                    ? 'editor.moduleEditor.readOnly.notDraft'
                    : state === 'approved'
                      ? 'editor.moduleEditor.readOnly.suggestionApproved'
                      : 'editor.moduleEditor.readOnly.suggestionInReview',
                },
          lockedByMe: false,
          status: statusOf(changed, state),
          deprecation: module.data.meta.status.deprecated ?? null,
          issues: module.data.meta.issues,
        };
      }
      const langs = await languages;
      if (run !== this.runs) return;

      const serverDoc = toEditor(loaded.content as never) as JSONContent;
      let doc = serverDoc;
      if (loaded.subject && loaded.copy && !loaded.readOnly) {
        const started = this.draft.start(
          loaded.subject,
          this.me.me().id,
          loaded.copy,
          loaded.issues,
          serverDoc,
          {
            reload: this.forRun(run, () => this.reload(true)),
            // Lost (taken over, released elsewhere): taken again, or the page turns read-only.
            relock: async () => {
              if (!loaded.subject) return false;
              const why = await this.takeLock(loaded.subject);
              if (why === null) return true;
              this.forRun(run, () => this.lockTaken(why))();
              return false;
            },
            // The image dialog on the block, by the address (`?block=&replace=image`).
            replaceImage: (block) =>
              this.forRun(run, () =>
                this.query.set({ block, replace: 'image' }),
              )(),
            showBlock: (block) =>
              this.forRun(run, () => {
                this.query.set({ block });
                this.editor()?.focusBlock(block);
              })(),
          },
          discard,
        );
        doc = started.doc;
        if (started.restored) {
          this.toasts.push(
            this.toast.show(translated('editor.moduleEditor.restored'), {
              kind: 'info',
              actionLabel: translated('editor.moduleEditor.restoredUndo'),
              onAction: this.forRun(run, () => this.reload(true)),
            }),
          );
        } else if (started.older) {
          const older = started.older;
          this.toasts.push(
            this.toast.show(translated('editor.moduleEditor.olderDraft'), {
              kind: 'warning',
              duration: 0,
              actionLabel: translated('editor.moduleEditor.olderDraftRestore'),
              onAction: this.forRun(run, () => this.restoreOlder(older.doc)),
            }),
          );
        }
      }
      this.loadedIssues.set(loaded.issues);
      this.doc.set(doc);
      this.usedIn.set(null);
      this.usedInFailed.set(false);
      this.refreshing.set(false);
      this.view.set({
        kind: 'ready',
        loaded: {
          key: ++this.keys,
          subject: loaded.subject,
          content: loaded.content,
          doc,
          readOnly: loaded.readOnly,
          lockedByMe: loaded.lockedByMe,
          status: loaded.status,
          deprecation: loaded.deprecation,
          languages: langs,
        },
      });
      void this.loadUsedIn(run, moduleId);
    } catch (error) {
      if (run !== this.runs) return;
      // Its first load failed: from now on it is an ordinary change set, never given up.
      if (this.suggestingFor?.key === `${lang}/${moduleId}`) {
        this.suggestingFor = null;
      }
      this.refreshing.set(false);
      this.doc.set(null);
      this.view.set({ kind: 'error', error: toApiError(error) });
    }
  }

  /**
   * A contributor's module opens in its own suggestion (#137): the change set of theirs holding
   * the module's lock, chosen when another is (or none, the published content, when no change
   * set of theirs holds it). A suggestion just started here holds no lock yet and stays chosen.
   * Resolves false when this load no longer applies: another one runs (the choice changed).
   */
  private async followSuggestion(
    run: number,
    lang: string,
    moduleId: string,
  ): Promise<boolean> {
    const key = `${lang}/${moduleId}`;
    const started = this.suggestingFor;
    if (
      started?.key === key &&
      (started.id === null || started.id === this.changeSets.selected()?.id)
    ) {
      return true;
    }
    // Another module while a suggestion is being started: its answer chooses it, then this
    // loads again (and `suggest` gives that one up, as it was asked for another module).
    if (this.changeSets.starting() !== null) return false;
    this.dropSuggestion();
    const mine = await this.suggestionOf(lang, moduleId);
    if (run !== this.runs) return false;
    const chosen = this.changeSets.selected()?.id ?? null;
    if (mine === chosen) return true;
    // Not listed yet (the list still loading): read it, so it can be chosen.
    if (
      mine !== null &&
      !this.changeSets.options().some((o) => o.id === mine)
    ) {
      await this.changeSets.refresh();
      if (run !== this.runs) return false;
    }
    this.changeSets.choose(mine, 'session');
    // Chosen: the page loads again for it. Not chosen (it is not listed): as it was.
    return (this.changeSets.selected()?.id ?? null) === chosen;
  }

  /**
   * The person's change set holding the module's lock: a contributor sees only their own locks
   * (`GET /locks`, without `content.read.draft`). Null when none does, or the locks cannot be
   * read (the module then opens as published, with "Suggest a change").
   */
  private async suggestionOf(
    lang: string,
    moduleId: string,
  ): Promise<string | null> {
    try {
      const doc = await firstValueFrom(
        this.api.get('/locks', {
          query: {
            'filter[subject]': `module/${lang}/${moduleId}`,
            'filter[holder]': this.me.me().id,
            'page[number]': 1,
            'page[size]': 1,
          },
        }),
      );
      return doc.data[0]?.relationships.changeSet.data.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * "Suggest a change": starts a change set named after the module and chooses it; the page then
   * opens the module in it, taking its lock (for a contributor in the focused editor). A refusal
   * is the session's toast with a retry.
   */
  protected async suggest(): Promise<void> {
    if (this.suggesting() || !this.canSuggest()) return;
    const key = `${this.lang()}/${this.moduleId()}`;
    this.suggesting.set(true);
    const asked = { key, id: null as string | null };
    this.suggestingFor = asked;
    try {
      const id = await this.changeSets.start(this.title() || this.moduleId());
      if (!id) {
        if (this.suggestingFor === asked) this.suggestingFor = null;
        return;
      }
      if (
        this.destroyed ||
        this.suggestingFor !== asked ||
        `${this.lang()}/${this.moduleId()}` !== key ||
        this.changeSets.selected()?.id !== id
      ) {
        // The person went on (another module, another change set, away): an empty suggestion
        // is not left behind.
        if (this.suggestingFor === asked) this.suggestingFor = null;
        void this.giveUp(id, null);
        return;
      }
      asked.id = id;
    } finally {
      this.suggesting.set(false);
    }
  }

  /**
   * Forgets the suggestion started here. A contributor's, created but whose lock was never
   * taken (nothing can be in it), is given up rather than left behind empty: each suggestion is
   * one module's. An editor's stays: an ordinary change set they chose, to go on with elsewhere.
   */
  private dropSuggestion(): void {
    const started = this.suggestingFor;
    this.suggestingFor = null;
    if (started?.id && this.focused()) void this.giveUp(started.id, null);
  }

  /**
   * Gives up a suggestion just started here that cannot go on (its module's lock refused, or
   * the person went on to another module): it is abandoned, as nothing is in it yet, and the
   * published content chosen again. `why` (the lock's refusal) is said in a toast.
   */
  private async giveUp(id: string, why: ReadOnly | null): Promise<void> {
    if (this.suggestingFor?.id === id) this.suggestingFor = null;
    if (this.changeSets.selected()?.id === id) {
      this.changeSets.choose(null, 'session');
    }
    if (why) {
      const title = this.title() || this.moduleId();
      this.toast.error(
        why.key === 'editor.moduleEditor.readOnly.refused'
          ? translated('editor.suggestion.notAllowed', { title })
          : translated('editor.suggestion.lockedElsewhere', { title }),
      );
    }
    try {
      await firstValueFrom(
        this.api.act('/change-sets/{changeSetId}/abandon', {
          path: { changeSetId: id },
        }),
      );
    } catch {
      // Left as an empty draft of theirs: nothing is lost, and the list shows it to an editor.
    }
    void this.changeSets.refresh();
  }

  protected typedNote(value: string): void {
    this.noteTouchedFor = this.editingChangeSet();
    this.note.set(value);
    this.noteMissing.set(false);
  }

  /** The note is kept as the suggestion's description once the field is left (eagerly). */
  protected keepNote(): void {
    const option = this.editingOption();
    if (!option || this.noteTouchedFor !== option.id) return;
    const note = this.note().trim();
    if (note === (option.description ?? '').trim()) return;
    void this.changeSets.rename(option.id, {
      title: option.title,
      description: note || null,
    });
  }

  /**
   * "Submit for review" in one step: what is typed is saved and committed (a save point), then
   * the change set is submitted with the note as its comment. The page then shows the module
   * read-only, in review. A refusal says why, with a retry.
   */
  protected async submitSuggestion(): Promise<void> {
    const option = this.editingOption();
    if (!option || this.submitting() || this.submitBlocked()) return;
    const note = this.note().trim();
    if (!note) {
      this.noteMissing.set(true);
      this.suggestionPanel()?.focusNote();
      return;
    }
    this.noteMissing.set(false);
    this.submitting.set(true);
    // A refusal said before is no longer what happens now.
    if (this.submitFailure !== null) this.toast.dismiss(this.submitFailure);
    this.submitFailure = null;
    try {
      if ((await this.draft.savePoint()) === 'failed') {
        // The draft says why when it shows the failure; a quiet save point under way does not.
        if (!this.submitBlocked()) {
          this.toast.error(translated('editor.suggestion.notSaved'));
        }
        return;
      }
      this.keepNote();
      await firstValueFrom(
        this.api.act(
          '/change-sets/{changeSetId}/submit',
          { path: { changeSetId: option.id } },
          { meta: { comment: note } },
        ),
      );
      this.toast.success(
        translated('editor.suggestion.submitted', { title: option.title }),
      );
      // Its state, read again, opens the module read-only: in review.
      await this.changeSets.refresh();
    } catch (error) {
      const id = this.toast.error(
        this.failureText(
          translated('editor.suggestion.submitFailed', {
            title: option.title,
          }),
          toApiError(error),
        ),
        {
          actionLabel: translated('editor.session.retry'),
          // Only for this suggestion: not another module's, opened since.
          onAction: () => {
            if (this.editingChangeSet() === option.id) {
              void this.submitSuggestion();
            }
          },
        },
      );
      this.submitFailure = id;
      // Gone with the module (another one opened, the page left).
      this.toasts.push(id);
    } finally {
      this.submitting.set(false);
    }
  }

  /** Opens an older draft from this browser over the server's copy (the person chose it). */
  private restoreOlder(doc: JSONContent): void {
    const v = this.view();
    if (v.kind !== 'ready' || v.loaded.readOnly) return;
    this.doc.set(doc);
    this.view.set({
      kind: 'ready',
      loaded: { ...v.loaded, key: ++this.keys, doc },
    });
    this.draft.edit(doc);
  }

  /**
   * The lock went while the person edited (#76: someone took it over): the editor turns
   * read-only where it stands, what is not saved yet stays in this browser (the draft keeps it
   * and restores it once the module is theirs again), and a toast says who holds it now.
   */
  private lockTaken(why: ReadOnly): void {
    const v = this.view();
    if (v.kind !== 'ready' || v.loaded.readOnly) return;
    this.draft.stop();
    this.view.set({
      kind: 'ready',
      loaded: {
        ...v.loaded,
        readOnly: { ...why, lost: true },
        lockedByMe: false,
      },
    });
    const holder = why.holderName;
    this.toasts.push(
      this.toast.show(
        !why.lock
          ? translated(why.key, why.params)
          : holder
            ? translated('editor.moduleLock.lost', { holder })
            : translated('editor.moduleLock.lostSomeone'),
        { kind: 'warning', duration: 0 },
      ),
    );
  }

  /** "Open read-only" (or the dialog closed): the module stays read-only, the address says so. */
  protected openReadOnly(): void {
    this.takeOverError.set('');
    if (this.query.get('lock')() !== 'read') {
      this.query.set({ lock: 'read' }, { replace: true });
    }
  }

  /** "Back": to the content, in the same change set. */
  protected backToContent(): void {
    void this.router.navigate(['/content'], {
      queryParams: this.changeSetUrl.params(),
    });
  }

  protected askTakeOver(): void {
    if (!this.heldLock() || !this.mayTakeOver()) return;
    this.takeOverError.set('');
    this.query.set({ lock: 'takeOver' });
  }

  /**
   * Takes over editing (#76, for `admin.roles`): the other change set's lock is broken with the
   * comment (audited, and its holder told), then the module opens again, taking the lock for
   * this change set. Their editor turns read-only on its next save. A lock gone meanwhile (404)
   * opens it as well; it may be someone else's by then, which the dialog then says.
   */
  protected async takeOver(comment: string): Promise<void> {
    const held = this.heldLock();
    if (this.takingOver() || !held) return;
    const lockId = held.lock.id;
    if (!lockId) {
      this.takeOverError.set(this.t('editor.moduleLock.unknownLock'));
      return;
    }
    const run = this.runs;
    this.takingOver.set(true);
    this.takeOverError.set('');
    try {
      try {
        await firstValueFrom(
          this.api.act(
            '/locks/{lockId}/break',
            { path: { lockId } },
            { meta: { comment } },
          ),
        );
      } catch (error) {
        const failure = toApiError(error);
        if (failure.status !== 404) {
          if (run === this.runs) {
            const text = this.failureText(
              translated('editor.moduleLock.takeOver.failed'),
              failure,
            );
            // Closed meanwhile (Escape): said in a toast instead.
            if (this.lockDialogOpen()) this.takeOverError.set(text);
            else this.toasts.push(this.toast.error(text));
          }
          return;
        }
      }
      if (run !== this.runs) return;
      // Taken at once, before the holder's editor (which takes a lost lock back by itself on its
      // next save) can; the load below finds it held by this change set.
      const v0 = this.view();
      const subject = v0.kind === 'ready' ? v0.loaded.subject : null;
      if (subject) await this.takeLock(subject).catch(() => null);
      if (run !== this.runs) return;
      // Opened again: the lock is taken for this change set, or someone else's by now. The
      // dialog stays, busy, until that is known.
      this.draft.stop();
      await this.load();
      if (this.destroyed || run + 1 !== this.runs) return;
      const v = this.view();
      if (v.kind === 'ready' && !v.loaded.readOnly) {
        const holder = held.holderName;
        this.toast.success(
          holder
            ? translated('editor.moduleLock.takeOver.done', { holder })
            : translated('editor.moduleLock.takeOver.doneSomeone'),
        );
      }
      this.query.set({ lock: undefined }, { replace: true });
    } finally {
      this.takingOver.set(false);
    }
  }

  /**
   * "Open that revision" (#472): the change set of the reader's own that holds the lock becomes
   * the session's (a choice the person made, so Back returns here), and the page opens the module
   * in it, where it is theirs to edit.
   */
  protected async openThere(): Promise<void> {
    const there = this.heldLock()?.lock.changeSetId;
    if (!there || !this.ownLock() || this.takingOver()) return;
    const listed = () => this.changeSets.options().some((o) => o.id === there);
    // Not listed yet (the list still loading): read it, so it can be chosen.
    if (!listed()) await this.changeSets.refresh();
    if (!listed()) {
      this.takeOverError.set(this.t('editor.moduleLock.own.gone'));
      return;
    }
    this.takeOverError.set('');
    this.query.set({ lock: undefined }, { replace: true });
    this.changeSets.choose(there, 'person');
  }

  /**
   * "Release it there" (#472): the reader's own lock, in another change set of theirs with no
   * changes to the module, is released (only while that holds: the API checks it again,
   * `ifUnchanged`), taken here at once, and the module opens for editing. The toast's Undo gives
   * it back, rather than a confirmation first.
   */
  protected async releaseThere(): Promise<void> {
    const held = this.heldLock();
    const lockId = held?.lock.id;
    const there = held?.lock.changeSetId;
    const v0 = this.view();
    const subject = v0.kind === 'ready' ? v0.loaded.subject : null;
    if (
      this.takingOver() ||
      !held ||
      !lockId ||
      !there ||
      !subject ||
      !this.ownLock() ||
      held.lock.hasChanges !== false
    ) {
      return;
    }
    const run = this.runs;
    this.takingOver.set(true);
    this.releasing.set(true);
    this.takeOverError.set('');
    try {
      try {
        await firstValueFrom(
          this.api.delete('/locks/{lockId}', {
            path: { lockId },
            query: { ifUnchanged: 'true' },
          }),
        );
      } catch (error) {
        const failure = toApiError(error);
        // Gone meanwhile: the load below finds out who holds it now.
        if (failure.status !== 404) {
          if (run === this.runs) {
            const text =
              failure.code === 'has-changes'
                ? this.t('editor.moduleLock.own.changedMeanwhile')
                : this.failureText(
                    translated('editor.moduleLock.own.releaseFailed'),
                    failure,
                  );
            if (this.lockDialogOpen()) this.takeOverError.set(text);
            else this.toasts.push(this.toast.error(text));
            // Changed there meanwhile: read again, so "Release it there" is no longer offered.
            if (failure.code === 'has-changes') {
              this.draft.stop();
              await this.load();
            }
          }
          return;
        }
      }
      if (run !== this.runs) return;
      await this.takeLock(subject).catch(() => null);
      if (run !== this.runs) return;
      this.draft.stop();
      await this.load();
      if (this.destroyed || run + 1 !== this.runs) return;
      this.query.set({ lock: undefined }, { replace: true });
      const v = this.view();
      if (v.kind === 'ready' && !v.loaded.readOnly) {
        const title =
          held.lock.changeSetTitle ?? this.t('editor.moduleLock.own.untitled');
        this.toasts.push(
          this.toast.success(
            translated('editor.moduleLock.own.released', { title }),
            {
              actionLabel: translated('ui.toast.undo'),
              onAction: this.forRun(
                this.runs,
                () => void this.undoRelease(there, subject),
              ),
            },
          ),
        );
      }
    } finally {
      this.takingOver.set(false);
      this.releasing.set(false);
    }
  }

  /**
   * Undoes "Release it there": the lock taken here is released (only while nothing was saved
   * here meanwhile: the API checks it, `ifUnchanged`) and taken again by the change set it came
   * from; the module opens here read-only again, with the dialog.
   */
  private async undoRelease(
    there: string,
    subject: DraftSubject,
  ): Promise<void> {
    const run = this.runs;
    // What was typed since is saved first: then the API sees it, and keeps the lock here. Not
    // saved (offline, refused): nothing is released, the text stays with the editor here.
    if (!(await this.draft.flush())) {
      if (run === this.runs) {
        this.toasts.push(
          this.toast.error(translated('editor.moduleLock.own.undoUnsaved')),
        );
      }
      return;
    }
    if (run !== this.runs) return;
    // Nothing more is typed here while it is given back.
    this.draft.stop();
    try {
      const found = await firstValueFrom(
        this.api.get('/locks', {
          query: {
            'filter[subject]': `module/${subject.lang}/${subject.moduleId}`,
            'filter[changeSet]': subject.changeSetId,
            'page[number]': 1,
            'page[size]': 1,
          },
        }),
      );
      const here = found.data[0]?.id;
      // The page moved on meanwhile: its own load decides; nothing is released.
      if (run !== this.runs) return;
      if (here) {
        await firstValueFrom(
          this.api.delete('/locks/{lockId}', {
            path: { lockId: here },
            query: { ifUnchanged: 'true' },
          }),
        );
      }
      await firstValueFrom(
        this.api.post(
          '/change-sets/{changeSetId}/locks',
          {
            data: {
              type: 'Lock',
              attributes: {
                subject: {
                  type: 'module',
                  lang: subject.lang,
                  moduleId: subject.moduleId,
                },
              },
            },
          },
          { path: { changeSetId: there } },
        ),
      );
    } catch (error) {
      if (run !== this.runs) return;
      const failure = toApiError(error);
      this.toasts.push(
        this.toast.error(
          failure.code === 'has-changes'
            ? translated('editor.moduleLock.own.undoChanged')
            : this.failureText(
                translated('editor.moduleLock.own.undoFailed'),
                failure,
              ),
        ),
      );
    }
    if (run !== this.runs) return;
    this.reload();
  }

  /**
   * Takes the module's lock for the change set: null when this change set holds it, else why
   * the module opens read-only (another holds it, or the person may not change it).
   */
  private async takeLock(subject: DraftSubject): Promise<ReadOnly | null> {
    try {
      await firstValueFrom(
        this.api.post(
          '/change-sets/{changeSetId}/locks',
          {
            data: {
              type: 'Lock',
              attributes: {
                subject: {
                  type: 'module',
                  lang: subject.lang,
                  moduleId: subject.moduleId,
                },
              },
            },
          },
          { path: { changeSetId: subject.changeSetId } },
        ),
      );
      return null;
    } catch (error) {
      const failure = toApiError(error);
      if (failure.code === 'locked') {
        const lock = heldLockOf(failure);
        const holderName = lock.holder
          ? this.nameOf(lock.holder.kind, lock.holder.id)
          : '';
        // The reader's own lock, in another change set of theirs (#472).
        if (isOwnLock(lock, this.me.me())) {
          return {
            key: 'editor.moduleEditor.readOnly.lockedByYou',
            lock,
            holderName,
          };
        }
        return holderName
          ? {
              key: 'editor.moduleEditor.readOnly.lockedBy',
              params: { holder: holderName },
              lock,
              holderName,
            }
          : { key: 'editor.moduleEditor.readOnly.locked', lock };
      }
      if (failure.status === 403 || failure.status === 404) {
        return { key: 'editor.moduleEditor.readOnly.refused' };
      }
      if (failure.code === 'invalid-state') {
        return { key: 'editor.moduleEditor.readOnly.notDraft' };
      }
      throw failure;
    }
  }

  /** The languages the module exists in (the summary's list), else just this one. */
  private async languagesOf(moduleId: string, lang: string): Promise<string[]> {
    try {
      const found = await firstValueFrom(
        this.api.get('/module-summaries', {
          query: {
            'filter[q]': moduleId,
            'page[number]': 1,
            'page[size]': SUMMARY_PAGE_SIZE,
          },
        }),
      );
      const summary = found.data.find((s) => s.id === moduleId);
      const languages = summary?.attributes.languages ?? [];
      return languages.includes(lang) ? languages : [lang, ...languages];
    } catch {
      return [lang];
    }
  }

  /** The manuals that include the module: read page by page, in the background. */
  private async loadUsedIn(run: number, moduleId: string): Promise<void> {
    const found: UsedInRow[] = [];
    try {
      for (let page = 1; page <= MANUAL_PAGES; page++) {
        const doc = await firstValueFrom(
          this.api.get('/manuals', {
            query: {
              'page[number]': page,
              'page[size]': MANUAL_PAGE_SIZE,
            },
          }),
        );
        for (const manual of doc.data) {
          if (
            'attributes' in manual &&
            includesModule(manual.attributes.entries, moduleId)
          ) {
            found.push({
              id: manual.id,
              title: manual.attributes.title,
              deprecated: !!manual.attributes.deprecated,
            });
          }
        }
        if (!doc.links.next) break;
      }
      if (run === this.runs) this.usedIn.set(found);
    } catch {
      if (run === this.runs) this.usedInFailed.set(true);
    }
  }
}

/** The type of the block (or item) with this ID in an editor document, or null: none. */
function typeOfBlock(doc: JSONContent | null, id: string): string | null {
  for (const child of doc?.content ?? []) {
    if (child.attrs?.['id'] === id) return child.type ?? null;
    const inner = typeOfBlock(child, id);
    if (inner) return inner;
  }
  return null;
}
