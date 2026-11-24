import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowLeft,
  lucideFileCode,
  lucideFileImage,
  lucideFilePlus,
  lucideFileText,
  lucideInfo,
  lucideLock,
  lucideTrash2,
  lucideTriangleAlert,
  lucideCircleCheck,
} from '@ng-icons/lucide';
import { firstValueFrom, map } from 'rxjs';

import { ZardAlertDialogService } from '@openfolia/ui/alert-dialog';
import { ZardButtonComponent } from '@openfolia/ui/button';
import {
  CodeEditorComponent,
  languageOf,
  type CodeCaret,
  type CodeMarker,
} from '@openfolia/ui/code-editor';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { injectTranslate, translated } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import {
  ListFrameComponent,
  ListRowDirective,
  type ListFramePage,
} from '@openfolia/ui/list-frame';
import { ZardSelectImports } from '@openfolia/ui/select';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { FadeInDirective } from '@openfolia/ui/smooth';
import {
  EmptyStateComponent,
  ErrorStateComponent,
  SaveStatusComponent,
} from '@openfolia/ui/states';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, toApiError } from '../../api';
import { apiErrorText } from '../../i18n';
import { MeService } from '../../permissions/me';
import { ChangeSetSession } from '../../session/change-set-session';
import { ChangeSetUrl } from '../../session/change-set-url';
import type { DesignChangeSet } from './design-draft';
import type { TemplateProblem } from './design-preview.component';
import {
  TEMPLATE_ENTRY,
  TEMPLATE_FILE_MAX_BYTES,
  TemplateDraft,
  utf8Bytes,
  type TemplateFileRow,
} from './template-draft';
import { LANGUAGE_NAMES, templateFileProblem } from './template-files';
import {
  TemplatePreviewComponent,
  type TemplatePreviewOutcome,
  type TemplatePreviewRequest,
} from './template-preview.component';

/** Files per page of the list, paged in the screen (a folder holds at most 200). */
const PAGE_SIZE = 50;
/** The select's value for the built-in design: no design ID (a slug) looks like it. */
const BUILTIN = ':builtin';

/** A problem of the preview, placed in the template's folder. */
interface PlacedProblem extends TemplateProblem {
  /** Its path in the folder; null: outside it (the generated document). */
  readonly path: string | null;
}

interface DesignChoice {
  readonly id: string;
  readonly name: string;
  readonly template: string | null;
}

/**
 * One own page design template (#396), Admin › Page design › a template: its files on the left
 * (paged, in their own scroller; the drafts of the chosen revision marked), the file open in a
 * code editor in the middle (Typst highlighted, line numbers, the lines the compiler names
 * marked), and the live preview on the right: a page of a small manual that uses every function
 * of the template contract, laid out with the template as saved in the revision, with a page
 * design's settings of the person's choosing. Every change is saved into the file's working copy
 * shortly after the last keystroke (`TemplateDraft`) and the preview renders again; where the
 * template does not compile, its problems are listed under the code, each opening its file at
 * its line. A file is made or deleted here too; read-only, with the reason, wherever the person
 * cannot change the template.
 */
@Component({
  selector: 'of-template-editor',
  imports: [
    TranslocoPipe,
    NgIcon,
    RouterLink,
    ZardButtonComponent,
    ZardDialogImports,
    ZardInputComponent,
    ZardSelectImports,
    ZardSkeletonComponent,
    CodeEditorComponent,
    ListFrameComponent,
    ListRowDirective,
    EmptyStateComponent,
    ErrorStateComponent,
    SaveStatusComponent,
    FadeInDirective,
    TemplatePreviewComponent,
  ],
  providers: [TemplateDraft],
  viewProviders: [
    provideIcons({
      lucideArrowLeft,
      lucideCircleCheck,
      lucideFileCode,
      lucideFileImage,
      lucideFilePlus,
      lucideFileText,
      lucideInfo,
      lucideLock,
      lucideTrash2,
      lucideTriangleAlert,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <a
        z-button
        zType="ghost"
        zSize="sm"
        routerLink="../.."
        [queryParams]="linkQuery()"
        data-slot="templates-back"
      >
        <ng-icon
          name="lucideArrowLeft"
          data-icon="inline-start"
          aria-hidden="true"
        />
        {{ 'editor.admin.pageDesigns.back' | transloco }}
      </a>
      <p
        class="text-muted-foreground m-0 flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm"
        data-slot="template-status"
      >
        @if (draft.mode().kind === 'edit') {
          <span class="min-w-0 break-words">{{
            'editor.admin.pageDesigns.savedIn'
              | transloco: { changeSet: changeSets.selected()?.title ?? '' }
          }}</span>
          <span aria-hidden="true">·</span>
          <a
            class="text-foreground focus-visible:ring-ring/50 rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2"
            routerLink="/review"
            [queryParams]="{ cs: changeSets.selected()?.id }"
            >{{ 'editor.admin.pageDesigns.openReview' | transloco }}</a
          >
        } @else if (draft.status() === 'ready') {
          <ng-icon
            name="lucideLock"
            class="shrink-0"
            size="16"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 break-words" data-slot="read-reason">{{
            readReason() | transloco
          }}</span>
        }
      </p>
      <span class="ms-auto flex shrink-0 items-center gap-2">
        @if (draft.saveState(); as s) {
          <of-save-status [status]="s" />
        }
      </span>
    </div>

    <header
      class="flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-2"
    >
      <div class="flex min-w-0 flex-col gap-1">
        <h2
          class="m-0 flex min-w-0 flex-wrap items-baseline gap-x-2 text-lg font-semibold"
        >
          <span>{{
            'editor.admin.pageDesigns.templates.title' | transloco
          }}</span>
          <span
            class="font-mono text-base font-medium break-all"
            data-slot="template-id"
            >{{ templateId() }}</span
          >
        </h2>
        <p class="text-muted-foreground m-0 max-w-3xl text-xs break-words">
          {{
            'editor.admin.pageDesigns.templates.hint'
              | transloco: { folder: folder() }
          }}
        </p>
      </div>
      @if (draft.mode().kind === 'edit' && draft.status() === 'ready') {
        <button
          ofFadeIn
          z-button
          zType="outline"
          zSize="sm"
          type="button"
          data-slot="template-new-file"
          (click)="openNewFile()"
        >
          <ng-icon
            name="lucideFilePlus"
            data-icon="inline-start"
            aria-hidden="true"
          />
          {{ 'editor.admin.pageDesigns.templates.newFile.action' | transloco }}
        </button>
      }
    </header>

    @switch (draft.status()) {
      @case ('error') {
        <of-error-state
          [kind]="draft.error()?.kind ?? 'unknown'"
          [message]="draft.error()?.message ?? ''"
          (retry)="reload()"
        />
      }
      @case ('missing') {
        <of-error-state
          kind="not-found"
          data-slot="template-missing"
          [heading]="
            'editor.admin.pageDesigns.templates.missing.title' | transloco
          "
          [message]="
            'editor.admin.pageDesigns.templates.missing.text' | transloco
          "
        />
      }
      @case ('ready') {
        <div
          ofFadeIn
          class="grid min-w-0 items-start gap-4 lg:grid-cols-[13rem_minmax(0,1fr)] xl:grid-cols-[12rem_minmax(0,1fr)_minmax(17rem,22rem)] 2xl:grid-cols-[14rem_minmax(0,1fr)_minmax(20rem,26rem)]"
        >
          <of-list-frame
            class="min-h-40 min-w-0"
            offset="calc(16rem + var(--of-sandbox-h, 0px))"
            data-slot="template-files"
            [label]="
              'editor.admin.pageDesigns.templates.files.label' | transloco
            "
            [items]="fileRows()"
            [trackBy]="pathOf"
            [page]="filePage()"
            [loading]="false"
            [skeletonRows]="4"
            [emptyTitle]="
              'editor.admin.pageDesigns.templates.files.empty' | transloco
            "
            (pageChange)="filePageNumber.set($event)"
          >
            <ng-template ofListRow let-item>
              @let f = asFile(item);
              @if (f.text) {
                <button
                  type="button"
                  class="hover:bg-muted/60 focus-visible:ring-ring/50 aria-[current=true]:bg-accent flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-start outline-none focus-visible:ring-2"
                  [attr.aria-current]="f.path === draft.path() ? 'true' : null"
                  [attr.data-file]="f.path"
                  (click)="pick(f.path)"
                >
                  <ng-icon
                    [name]="
                      f.path.endsWith('.typ')
                        ? 'lucideFileCode'
                        : 'lucideFileText'
                    "
                    class="text-muted-foreground shrink-0"
                    size="15"
                    aria-hidden="true"
                  />
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span
                      class="font-mono text-[13px] [overflow-wrap:anywhere]"
                      [class.font-semibold]="f.path === draft.path()"
                      >{{ f.path }}</span
                    >
                    <span
                      class="text-muted-foreground text-[11px] tabular-nums"
                      >{{ sizeText(f.size) }}</span
                    >
                  </span>
                  @if (f.draft) {
                    <span
                      class="bg-primary size-1.5 shrink-0 rounded-full"
                      data-slot="file-draft"
                      [attr.title]="
                        'editor.admin.pageDesigns.templates.files.draft'
                          | transloco
                      "
                    ></span>
                    <span class="sr-only">{{
                      'editor.admin.pageDesigns.templates.files.draft'
                        | transloco
                    }}</span>
                  }
                  @if (problemFiles().has(f.path)) {
                    <ng-icon
                      name="lucideTriangleAlert"
                      class="text-destructive shrink-0"
                      size="14"
                      [attr.aria-label]="
                        'editor.admin.pageDesigns.templates.files.hasProblems'
                          | transloco
                      "
                    />
                  }
                </button>
              } @else {
                <div
                  class="text-muted-foreground flex min-w-0 items-center gap-2 px-2.5 py-2"
                  [attr.data-file]="f.path"
                >
                  <ng-icon
                    name="lucideFileImage"
                    class="shrink-0"
                    size="15"
                    aria-hidden="true"
                  />
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span
                      class="font-mono text-[13px] [overflow-wrap:anywhere]"
                      >{{ f.path }}</span
                    >
                    <span class="text-[11px]">{{
                      'editor.admin.pageDesigns.templates.files.binary'
                        | transloco: { size: sizeText(f.size) }
                    }}</span>
                  </span>
                </div>
              }
            </ng-template>
          </of-list-frame>

          <section
            class="flex min-w-0 flex-col gap-3"
            aria-labelledby="template-file-heading"
            data-slot="template-file"
          >
            <div
              class="flex min-h-8 min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
            >
              <h3
                id="template-file-heading"
                class="m-0 min-w-0 flex-1 font-mono text-sm font-medium [overflow-wrap:anywhere]"
              >
                {{ draft.path() ?? '' }}
              </h3>
              @if (draft.fileLocked()) {
                <span
                  class="text-muted-foreground flex items-center gap-1.5 text-xs"
                  data-slot="file-locked"
                >
                  <ng-icon name="lucideLock" size="13" aria-hidden="true" />
                  {{
                    'editor.admin.pageDesigns.templates.file.locked' | transloco
                  }}
                </span>
              }
              @if (canDelete()) {
                <button
                  z-button
                  zType="ghost"
                  zSize="sm"
                  type="button"
                  class="text-muted-foreground hover:text-destructive"
                  data-slot="template-delete-file"
                  (click)="confirmDelete()"
                >
                  <ng-icon
                    name="lucideTrash2"
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                  {{
                    'editor.admin.pageDesigns.templates.delete.action'
                      | transloco
                  }}
                </button>
              }
            </div>

            @switch (draft.fileStatus()) {
              @case ('error') {
                <of-error-state
                  class="min-h-80"
                  [kind]="draft.fileError()?.kind ?? 'unknown'"
                  [message]="draft.fileError()?.message ?? ''"
                  (retry)="reopen()"
                />
              }
              @case ('idle') {
                <of-empty-state
                  class="bg-card min-h-80 rounded-lg border"
                  data-slot="no-file"
                  [title]="
                    'editor.admin.pageDesigns.templates.file.none' | transloco
                  "
                  [description]="
                    'editor.admin.pageDesigns.templates.file.noneHint'
                      | transloco
                  "
                />
              }
              @default {
                <div class="relative min-w-0">
                  <of-code-editor
                    #code
                    class="h-[max(20rem,calc(100dvh_-_29rem_-_var(--of-sandbox-h,0px)))]"
                    describedBy="template-code-hint template-code-problems"
                    [class.opacity-60]="draft.fileStatus() === 'loading'"
                    [path]="draft.path() ?? ''"
                    [value]="draft.text()"
                    [readonly]="!draft.editable()"
                    [label]="
                      'editor.admin.pageDesigns.templates.file.label'
                        | transloco: { file: draft.path() ?? '' }
                    "
                    [markers]="markers()"
                    (valueChange)="draft.change($event)"
                    (caretChange)="caret.set($event)"
                    (saveRequest)="saveNow()"
                  />
                  @if (draft.fileStatus() === 'loading') {
                    <z-skeleton
                      class="pointer-events-none absolute inset-x-14 top-4 h-4 w-1/3"
                      aria-hidden="true"
                    />
                  }
                </div>
                <div
                  class="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                  data-slot="template-file-bar"
                >
                  <span class="tabular-nums" data-slot="caret">{{
                    'editor.admin.pageDesigns.templates.file.caret'
                      | transloco
                        : { line: caret().line, column: caret().column }
                  }}</span>
                  <span aria-hidden="true">·</span>
                  <span>{{ languageName() | transloco }}</span>
                  <span aria-hidden="true">·</span>
                  <span
                    class="tabular-nums"
                    [class.text-destructive]="draft.tooLarge()"
                    data-slot="file-size"
                    >{{
                      'editor.admin.pageDesigns.templates.file.size'
                        | transloco
                          : {
                              size: sizeText(textBytes()),
                              max: sizeText(maxBytes),
                            }
                    }}</span
                  >
                  <span id="template-code-hint" class="ms-auto">{{
                    (draft.editable()
                      ? 'editor.admin.pageDesigns.templates.file.keys'
                      : 'editor.admin.pageDesigns.templates.file.readOnly'
                    ) | transloco
                  }}</span>
                </div>
                @if (draft.tooLarge()) {
                  <p
                    class="text-destructive m-0 text-xs break-words"
                    role="alert"
                    data-slot="file-too-large"
                  >
                    {{
                      'editor.admin.pageDesigns.templates.file.tooLarge'
                        | transloco: { max: sizeText(maxBytes) }
                    }}
                  </p>
                }
              }
            }

            <section
              id="template-code-problems"
              class="flex min-w-0 flex-col gap-2 rounded-lg border p-3 transition-colors duration-200 motion-reduce:transition-none"
              [class.border-destructive/40]="placed().length > 0"
              [class.bg-destructive-muted]="placed().length > 0"
              aria-live="polite"
              data-slot="template-problems"
            >
              @switch (outcome().kind) {
                @case ('problems') {
                  <h4
                    class="text-destructive m-0 flex items-center gap-1.5 text-sm font-medium"
                  >
                    <ng-icon
                      name="lucideTriangleAlert"
                      size="15"
                      aria-hidden="true"
                    />
                    {{
                      'editor.admin.pageDesigns.templates.problems.title'
                        | transloco: { count: placed().length }
                    }}
                  </h4>
                  <ul
                    class="m-0 flex max-h-32 list-none flex-col gap-1 overflow-y-auto overscroll-contain p-0"
                  >
                    @for (p of placed(); track $index) {
                      <li class="min-w-0">
                        @if (p.path !== null && p.line > 0) {
                          <button
                            type="button"
                            class="hover:bg-background/70 focus-visible:ring-ring/50 flex w-full min-w-0 items-baseline gap-2 rounded-md px-2 py-1.5 text-start text-xs outline-none focus-visible:ring-2"
                            data-slot="template-problem"
                            [attr.data-at]="p.path + ':' + p.line"
                            (click)="goTo(p)"
                          >
                            <span
                              class="text-destructive shrink-0 font-mono font-medium"
                              >{{ p.path }}:{{ p.line }}:{{ p.column }}</span
                            >
                            <span class="min-w-0 [overflow-wrap:anywhere]">{{
                              p.message
                            }}</span>
                          </button>
                        } @else {
                          <p
                            class="m-0 flex min-w-0 items-baseline gap-2 px-2 py-1.5 text-xs"
                            data-slot="template-problem"
                          >
                            @if (p.file) {
                              <span
                                class="text-destructive shrink-0 font-mono font-medium break-all"
                                >{{ p.file }}</span
                              >
                            }
                            <span class="min-w-0 [overflow-wrap:anywhere]">{{
                              p.message
                            }}</span>
                          </p>
                        }
                      </li>
                    }
                  </ul>
                }
                @case ('ok') {
                  <p
                    class="text-muted-foreground m-0 flex items-center gap-1.5 text-xs"
                    data-slot="template-compiles"
                  >
                    <ng-icon
                      name="lucideCircleCheck"
                      class="text-success"
                      size="14"
                      aria-hidden="true"
                    />
                    {{
                      'editor.admin.pageDesigns.templates.problems.none'
                        | transloco
                    }}
                  </p>
                }
                @default {
                  <p class="text-muted-foreground m-0 text-xs">
                    {{
                      (outcome().kind === 'failed'
                        ? 'editor.admin.pageDesigns.templates.problems.unknown'
                        : 'editor.admin.pageDesigns.templates.problems.checking'
                      ) | transloco
                    }}
                  </p>
                }
              }
            </section>
          </section>

          <aside
            class="bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4 lg:col-span-2 xl:sticky xl:top-4 xl:col-span-1"
            aria-labelledby="template-preview-heading"
            data-slot="template-preview"
          >
            <div class="flex min-w-0 flex-col gap-1">
              <h3
                id="template-preview-heading"
                class="m-0 text-base font-semibold"
              >
                {{ 'editor.admin.pageDesigns.preview.title' | transloco }}
              </h3>
              <p class="text-muted-foreground m-0 text-xs break-words">
                {{
                  'editor.admin.pageDesigns.templates.preview.hint' | transloco
                }}
              </p>
            </div>
            @if (designs(); as list) {
              <z-select
                class="w-full min-w-0"
                zPosition="popper"
                data-slot="template-preview-design"
                [zPrefix]="
                  'editor.admin.pageDesigns.templates.preview.with' | transloco
                "
                [zAriaLabel]="
                  'editor.admin.pageDesigns.templates.preview.design'
                    | transloco
                "
                [zValue]="designChoice()"
                (zSelectionChange)="designPicked.set($any($event))"
              >
                <z-select-item [zValue]="builtin">{{
                  'editor.admin.pageDesigns.default.builtin' | transloco
                }}</z-select-item>
                @for (d of list; track d.id) {
                  <z-select-item [zValue]="d.id">{{ d.name }}</z-select-item>
                }
              </z-select>
            } @else {
              <z-skeleton class="h-9 w-full" />
            }
            <of-template-preview
              [request]="previewRequest()"
              [revision]="draft.saves()"
              (outcome)="outcome.set($event)"
            />
          </aside>
        </div>
      }
      @default {
        <div
          ofFadeIn="delayed"
          class="grid gap-4 lg:grid-cols-[13rem_minmax(0,1fr)] xl:grid-cols-[12rem_minmax(0,1fr)_minmax(17rem,22rem)] 2xl:grid-cols-[14rem_minmax(0,1fr)_minmax(20rem,26rem)]"
          aria-hidden="true"
        >
          <z-skeleton class="h-64 w-full rounded-xl" />
          <z-skeleton class="h-[28rem] w-full rounded-xl" />
          <z-skeleton class="hidden h-[28rem] w-full rounded-xl xl:block" />
        </div>
      }
    }

    <z-dialog
      class="sm:max-w-md"
      [zVisible]="creating()"
      (zVisibleChange)="$event || closeNewFile()"
    >
      <z-dialog-header>
        <z-dialog-title>{{
          'editor.admin.pageDesigns.templates.newFile.title' | transloco
        }}</z-dialog-title>
        <z-dialog-description>{{
          'editor.admin.pageDesigns.templates.newFile.hint' | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      <form
        id="new-template-file-form"
        class="flex min-w-0 flex-col gap-1.5"
        novalidate
        (submit)="createFile($event)"
      >
        <label class="text-sm" for="new-template-file-path">{{
          'editor.admin.pageDesigns.templates.newFile.path' | transloco
        }}</label>
        <input
          id="new-template-file-path"
          z-input
          type="text"
          autocomplete="off"
          spellcheck="false"
          class="font-mono"
          maxlength="150"
          cdkFocusInitial
          [placeholder]="
            'editor.admin.pageDesigns.templates.newFile.placeholder' | transloco
          "
          aria-describedby="new-template-file-hint"
          [value]="newPath()"
          [attr.aria-invalid]="newPathProblem() && newPath() ? 'true' : null"
          (input)="newPath.set($any($event.target).value.trim())"
        />
        <p
          id="new-template-file-hint"
          class="m-0 text-xs break-words"
          [class.text-destructive]="!!newPathProblem() && !!newPath()"
          [class.text-muted-foreground]="!newPathProblem() || !newPath()"
        >
          {{
            (newPathProblem() && newPath()
              ? newPathProblem()!
              : 'editor.admin.pageDesigns.templates.newFile.pathHint'
            ) | transloco
          }}
        </p>
      </form>
      <z-dialog-footer>
        <button z-button zType="ghost" type="button" (click)="closeNewFile()">
          {{ 'editor.admin.cancel' | transloco }}
        </button>
        <button
          z-button
          type="submit"
          form="new-template-file-form"
          data-slot="new-template-file-create"
          [zLoading]="savingFile()"
          [zDisabled]="!!newPathProblem()"
        >
          {{ 'editor.admin.pageDesigns.templates.newFile.create' | transloco }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class TemplateEditorPage {
  protected readonly draft = inject(TemplateDraft);
  protected readonly changeSets = inject(ChangeSetSession);
  private readonly me = inject(MeService);
  private readonly csLink = inject(ChangeSetUrl);
  private readonly api = inject(ApiClient);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly dialogs = inject(ZardAlertDialogService);
  private readonly injector = inject(Injector);
  private readonly t = injectTranslate();
  private readonly code = viewChild<CodeEditorComponent>('code');

  protected readonly builtin = BUILTIN;
  protected readonly maxBytes = TEMPLATE_FILE_MAX_BYTES;

  /** The template's ID, from the address. */
  protected readonly templateId = toSignal(
    this.route.paramMap.pipe(map((p) => p.get('templateId') ?? '')),
    { initialValue: this.route.snapshot.paramMap.get('templateId') ?? '' },
  );
  /** The file asked for in the address (`?file=`). */
  private readonly fileParam = toSignal(
    this.route.queryParamMap.pipe(map((p) => p.get('file'))),
    { initialValue: this.route.snapshot.queryParamMap.get('file') },
  );

  protected readonly linkQuery = computed(() => this.csLink.params());
  protected readonly caret = signal<CodeCaret>({ line: 1, column: 1 });
  protected readonly outcome = signal<TemplatePreviewOutcome>({
    kind: 'rendering',
  });
  protected readonly filePageNumber = signal(1);
  protected readonly designs = signal<readonly DesignChoice[] | null>(null);
  protected readonly designPicked = signal<string | null>(null);
  protected readonly creating = signal(false);
  protected readonly savingFile = signal(false);
  protected readonly newPath = signal('');
  /** A problem to reveal once its file is open. */
  private readonly reveal = signal<PlacedProblem | null>(null);

  protected readonly readReason = computed(() => {
    const m = this.draft.mode();
    return m.kind === 'read' && m.reason
      ? m.reason
      : 'editor.admin.pageDesigns.templates.readOnly';
  });

  private readonly changeSet = computed((): DesignChangeSet | null => {
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
  /** The template's folder in the content repository, as the hint names it. */
  protected readonly folder = computed(() => `templates/${this.templateId()}/`);
  private readonly loadKey = computed(() => {
    const cs = this.changeSet();
    return `${this.templateId()}\n${cs?.id ?? ''}\n${cs?.state ?? ''}\n${cs?.authorId ?? ''}\n${this.draft.mayEdit()}`;
  });

  private readonly lastFilePage = computed(() =>
    Math.max(1, Math.ceil(this.draft.files().length / PAGE_SIZE)),
  );
  protected readonly fileRows = computed(() => {
    const page = Math.min(this.filePageNumber(), this.lastFilePage());
    const start = (page - 1) * PAGE_SIZE;
    return this.draft.files().slice(start, start + PAGE_SIZE);
  });
  protected readonly filePage = computed((): ListFramePage => ({
    currentPage: Math.min(this.filePageNumber(), this.lastFilePage()),
    lastPage: this.lastFilePage(),
    perPage: PAGE_SIZE,
    total: this.draft.files().length,
  }));
  protected readonly pathOf = (item: unknown) => (item as TemplateFileRow).path;

  /** The problems the preview found, each in its file of the folder where it is one. */
  protected readonly placed = computed((): readonly PlacedProblem[] => {
    const outcome = this.outcome();
    if (outcome.kind !== 'problems') return [];
    const folder = `templates/${this.templateId()}/`;
    return outcome.problems.map((p) => ({
      ...p,
      path: p.file.startsWith(folder) ? p.file.slice(folder.length) : null,
    }));
  });
  protected readonly problemFiles = computed(
    () => new Set(this.placed().flatMap((p) => (p.path ? [p.path] : []))),
  );
  protected readonly markers = computed((): readonly CodeMarker[] => {
    const path = this.draft.path();
    return this.placed()
      .filter((p) => p.path === path && p.line > 0)
      .map((p) => ({ line: p.line, message: p.message }));
  });

  protected readonly languageName = computed(() => {
    return LANGUAGE_NAMES[languageOf(this.draft.path() ?? '')];
  });
  protected readonly textBytes = computed(() => utf8Bytes(this.draft.text()));
  protected readonly canDelete = computed(() => {
    const path = this.draft.path();
    return (
      !!path &&
      path !== TEMPLATE_ENTRY &&
      this.draft.editable() &&
      this.draft.fileStatus() === 'ready'
    );
  });

  /** The design the preview lays the template out with: the one picked, else the first naming it. */
  protected readonly designChoice = computed(() => {
    const picked = this.designPicked();
    if (picked) return picked;
    const naming = this.designs()?.find(
      (d) => d.template === this.templateId(),
    );
    return naming?.id ?? BUILTIN;
  });
  protected readonly previewRequest = computed(
    (): TemplatePreviewRequest | null => {
      if (this.draft.status() !== 'ready') return null;
      const cs = this.changeSet();
      const design = this.designChoice();
      return {
        templateId: this.templateId(),
        ref: cs?.branch ?? null,
        live: this.draft.live(),
        designId: design === BUILTIN ? null : design,
      };
    },
  );

  protected readonly newPathProblem = computed(() =>
    templateFileProblem(
      this.newPath(),
      this.draft.files().map((f) => f.path),
      this.templateId(),
    ),
  );

  constructor() {
    effect(() => {
      this.loadKey();
      // Who acts decides whether drafts are read: not before it is known (a new template is
      // only in the drafts, and its released listing is a 404).
      if (this.me.status() !== 'ready') return;
      if (this.changeSets.switching()) {
        untracked(() => this.draft.forget());
        return;
      }
      if (this.changeSets.selected()?.branch === null) return;
      untracked(() => {
        this.outcome.set({ kind: 'rendering' });
        void this.draft.load(this.changeSet(), this.templateId());
        void this.readDesigns();
      });
    });
    // The file the address names, once the listing is read; else the entry file.
    effect(() => {
      if (this.draft.status() !== 'ready') return;
      const wanted = this.fileParam();
      const files = this.draft.files();
      untracked(() => {
        const text = files.filter((f) => f.text).map((f) => f.path);
        const path =
          wanted && text.includes(wanted)
            ? wanted
            : text.includes(TEMPLATE_ENTRY)
              ? TEMPLATE_ENTRY
              : (text[0] ?? null);
        if (path && path !== this.draft.path()) {
          this.caret.set({ line: 1, column: 1 });
          void this.draft.open(path);
          // The page of the list that holds it.
          const index = files.findIndex((f) => f.path === path);
          if (index >= 0)
            this.filePageNumber.set(Math.floor(index / PAGE_SIZE) + 1);
        }
      });
    });
    // A problem picked in another file: revealed once that file is open.
    effect(() => {
      const problem = this.reveal();
      if (!problem || this.draft.fileStatus() !== 'ready') return;
      if (problem.path !== this.draft.path()) return;
      untracked(() => {
        this.reveal.set(null);
        afterNextRender(
          () => this.code()?.revealLine(problem.line, problem.column),
          { injector: this.injector },
        );
      });
    });
  }

  /** Leaving the screen (the route guard): what is saved becomes a save point first. */
  async leave(): Promise<boolean> {
    await this.draft.savePoint();
    return true;
  }

  protected reload(): void {
    void this.draft.load(this.changeSet(), this.templateId());
  }

  protected reopen(): void {
    const path = this.draft.path();
    if (path) void this.draft.open(path);
  }

  protected asFile(item: unknown): TemplateFileRow {
    return item as TemplateFileRow;
  }

  protected sizeText(bytes: number): string {
    if (bytes < 1024)
      return this.t('editor.admin.pageDesigns.templates.bytes', { n: bytes });
    return this.t('editor.admin.pageDesigns.templates.kib', {
      n: Math.round((bytes / 1024) * 10) / 10,
    });
  }

  protected pick(path: string): void {
    if (path === this.draft.path()) {
      this.code()?.focus();
      return;
    }
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { file: path },
      queryParamsHandling: 'merge',
    });
  }

  protected goTo(problem: PlacedProblem): void {
    if (problem.path === null) return;
    if (problem.path === this.draft.path()) {
      this.code()?.revealLine(problem.line, problem.column);
      return;
    }
    this.reveal.set(problem);
    this.pick(problem.path);
  }

  protected saveNow(): void {
    void this.draft.savePoint();
  }

  protected openNewFile(): void {
    this.newPath.set('');
    this.creating.set(true);
  }

  protected closeNewFile(): void {
    if (this.savingFile()) return;
    this.creating.set(false);
  }

  protected async createFile(event: Event): Promise<void> {
    event.preventDefault();
    const path = this.newPath();
    if (this.newPathProblem() || this.savingFile()) return;
    this.savingFile.set(true);
    try {
      await this.draft.createFile(path);
      this.creating.set(false);
      this.pick(path);
    } catch (error) {
      const why = apiErrorText(toApiError(error));
      this.toast.error(
        translated('editor.admin.pageDesigns.templates.newFile.failed', {
          why: this.t(why.key, why.params),
        }),
      );
    } finally {
      this.savingFile.set(false);
    }
  }

  protected confirmDelete(): void {
    const path = this.draft.path();
    if (!path || !this.canDelete()) return;
    // A file the revision only holds as a working copy: dropping it is all.
    const committed =
      this.draft.files().find((f) => f.path === path)?.committed ?? true;
    this.dialogs.confirm({
      zTitle: this.t('editor.admin.pageDesigns.templates.delete.title', {
        file: path,
      }),
      zDescription: this.t(
        'editor.admin.pageDesigns.templates.delete.description',
        {
          file: path,
          changeSet: this.changeSets.selected()?.title ?? '',
        },
      ),
      zOkText: this.t('editor.admin.pageDesigns.templates.delete.confirm'),
      zCancelText: this.t('editor.admin.cancel'),
      zOkDestructive: true,
      zOnOk: () => void this.runDelete(path, committed),
    });
  }

  private async runDelete(path: string, committed: boolean): Promise<void> {
    try {
      await this.draft.deleteFile(path, committed);
      this.toast.show(
        translated('editor.admin.pageDesigns.templates.delete.done', {
          file: path,
        }),
        { kind: 'success' },
      );
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { file: TEMPLATE_ENTRY },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    } catch (error) {
      const why = apiErrorText(toApiError(error));
      this.toast.error(
        translated('editor.admin.pageDesigns.templates.delete.failed', {
          file: path,
          why: this.t(why.key, why.params),
        }),
      );
    }
  }

  /** The page designs at the revision, for the preview's choice (one page holds every one there is). */
  private designReads = 0;
  private async readDesigns(): Promise<void> {
    const mine = ++this.designReads;
    const cs = this.changeSet();
    const ref = cs ? { ref: cs.branch } : {};
    this.designs.set(null);
    this.designPicked.set(null);
    const designs = await firstValueFrom(
      this.api.get('/page-designs', {
        query: { 'page[size]': 200, ...ref } as never,
      }),
    ).catch(() => null);
    if (mine !== this.designReads) return;
    this.designs.set(
      (designs?.data ?? []).map((d) => {
        const a = d.attributes as { name?: string; template?: string };
        return { id: d.id, name: a.name ?? d.id, template: a.template ?? null };
      }),
    );
  }
}
